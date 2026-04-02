// scripts/re-enrich.js
//
// Smarter enrichment pass for the three regional JSON files.
// For each brand:
//   1. VERIFY URL  — fetch existing website; if dead or wrong brand, use Brave Search
//                    to find the correct URL (query: "[brand] watches")
//   2. FETCH CONTENT — get homepage; find and follow a shop/collection link for prices
//   3. EXTRACT — Claude Haiku extracts all fields + status assessment
//
// Flags:
//   --region europe|americas|asia-pacific  (default: all three)
//   --limit N                              (default: unlimited)
//   --force                                (re-enrich brands that already have data)
//
// Run: node scripts/re-enrich.js
// Run one region: node scripts/re-enrich.js --region europe
// Force full refresh: node scripts/re-enrich.js --force

require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');
const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

// ─── Config ───────────────────────────────────────────────────────────────────

const DATA_DIR    = path.join(__dirname, '..', 'data');
const CONCURRENCY = 3;   // Lower than scrape-brands — each brand makes multiple fetches
const TIMEOUT_MS  = 12000;
const MAX_PAGE_CHARS = 4000;

const LIMIT = process.argv.includes('--limit')
  ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10)
  : Infinity;

const REGION_ARG = process.argv.includes('--region')
  ? process.argv[process.argv.indexOf('--region') + 1]
  : null;

const FORCE = process.argv.includes('--force');

const REGION_FILES = {
  'europe':       'microbrands-europe.json',
  'americas':     'microbrands-americas.json',
  'asia-pacific': 'microbrands-asia-pacific.json',
};

// ─── File I/O ─────────────────────────────────────────────────────────────────

function load(filename) {
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) return [];
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

let _saving = false;
let _savePending = null;

function save(filename, data) {
  if (_saving) { _savePending = { filename, data: [...data] }; return; }
  _saving = true;
  const sorted = [...data].sort((a, b) =>
    (a.brandName || '').localeCompare(b.brandName || '', 'en', { sensitivity: 'base' })
  );
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(sorted, null, 2), 'utf8');
  _saving = false;
  if (_savePending) {
    const { filename: pf, data: pd } = _savePending;
    _savePending = null;
    save(pf, pd);
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function fetchPage(url, depth = 0) {
  if (depth > 5) return Promise.resolve(null);
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    try {
      const req = mod.get(url, {
        timeout: TIMEOUT_MS,
        headers: { 'User-Agent': 'WatchBrandBot/1.0 (+https://github.com/watchcollectorsclub)' }
      }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, url).href;
          return fetchPage(next, depth + 1).then(resolve);
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, html: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', () => resolve(null));
      });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
    } catch { resolve(null); }
  });
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PAGE_CHARS);
}

// Extract absolute same-domain links matching shop/collection patterns
function findShopLinks(html, baseUrl) {
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  const shopPatterns = /shop|collection|watches|buy|store|products|catalog/i;
  const links = [];
  const re = /href=["']([^"'#?][^"']*?)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const href = m[1];
      if (!shopPatterns.test(href)) continue;
      const abs = href.startsWith('http')
        ? new URL(href)
        : new URL(href, baseUrl);
      if (abs.hostname === base.hostname && abs.href !== baseUrl) {
        links.push(abs.href);
      }
    } catch { /* skip malformed */ }
  }
  return [...new Set(links)].slice(0, 3);
}

function extractInstagram(html) {
  const match = html.match(/instagram\.com\/([A-Za-z0-9_\.]{1,30})\/?["'\s>]/);
  if (!match) return null;
  const skip = ['p','reel','reels','stories','explore','accounts','shoppingbag','share','tv'];
  if (skip.includes(match[1].toLowerCase())) return null;
  return match[1];
}

// ─── Brave Search ─────────────────────────────────────────────────────────────

async function braveSearch(query) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return [];
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&search_lang=en`;
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': key,
      },
      timeout: TIMEOUT_MS,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve((data.web && data.web.results) ? data.web.results : []);
        } catch { resolve([]); }
      });
      res.on('error', () => resolve([]));
    });
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.on('error', () => resolve([]));
  });
}

// ─── Claude helpers ───────────────────────────────────────────────────────────

const VERIFY_PROMPT = `You are a watch industry expert. Answer with a single JSON object: {"correct": true} or {"correct": false}.
Is the fetched page the official website for the watch brand named below?
- true  = this is clearly the brand's own website selling their watches
- false = wrong brand, parked domain, retailer, dead page, or unrelated site
Return ONLY the JSON. No explanation.`;

async function claudeVerifyUrl(client, brandName, url, pageSnippet) {
  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 64,
      system: VERIFY_PROMPT,
      messages: [{ role: 'user', content: `Brand: ${brandName}\nURL: ${url}\nPage snippet: ${pageSnippet.slice(0, 500)}` }],
    });
    const text = msg.content[0].text.trim().replace(/^```json?\s*/i,'').replace(/\s*```$/i,'');
    return JSON.parse(text).correct === true;
  } catch { return true; } // On error, assume correct to avoid unnecessary search
}

async function claudePickBestUrl(client, brandName, searchResults) {
  if (!searchResults.length) return null;
  const candidates = searchResults.map((r, i) => `${i+1}. ${r.url} — ${r.title || ''}`).join('\n');
  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 128,
      system: 'You are a watch industry expert. Return ONLY valid JSON: {"url": "https://..."} or {"url": null}. No explanation.',
      messages: [{ role: 'user', content: `Which is most likely the OFFICIAL website of the watch brand "${brandName}"?\n\n${candidates}\n\nReturn the URL of the official brand site, or null if none look right.` }],
    });
    const text = msg.content[0].text.trim().replace(/^```json?\s*/i,'').replace(/\s*```$/i,'');
    return JSON.parse(text).url || null;
  } catch { return null; }
}

const EXTRACT_PROMPT = `You are a watch industry expert extracting data from a watch brand's website content.

Extract these fields:
- priceRangeLow: lowest watch price in USD, integer (null if unknown)
- priceRangeHigh: highest watch price in USD, integer (null if unknown)
- foundedYear: year brand was founded, integer (null if unknown)
- latestModel: name/ref of most recent or featured model, string (null if unknown)
- instagramHandle: Instagram username without @, string (null if unknown)
- status: "Active" if actively selling now, "Dormant" if no recent activity (12+ months), "Defunct" if site is dead/closed
- lastActivityDate: ISO date string YYYY-MM-DD of most recent confirmed activity, null if unknown
- notes: 1-3 sentences. Brand character, location, movement type, price range, what they are known for. Factual, concise. Example: "French microbrand founded in 2017. Known for vintage-inspired dive watches. Swiss-assembled using Sellita movements." Return null if you cannot write an accurate note.

Rules:
- Only return values you are confident about — do NOT guess or fabricate
- Prices in USD — convert from other currencies using approximate rates
- Return ONLY valid JSON. No markdown. No explanation.`;

async function claudeExtract(client, brand, combinedText) {
  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: EXTRACT_PROMPT,
      messages: [{ role: 'user', content: `Brand: ${brand.brandName}\nCountry: ${brand.country || 'unknown'}\n\nWebsite content:\n${combinedText}` }],
    });
    const text = msg.content[0].text.trim().replace(/^```json?\s*/i,'').replace(/\s*```$/i,'');
    return JSON.parse(text);
  } catch { return {}; }
}

// ─── Core brand processing ────────────────────────────────────────────────────

function needsWork(brand) {
  if (FORCE) return true;
  return !brand.website
    || brand.instagramHandle == null
    || brand.priceRangeLow  == null
    || brand.foundedYear    == null
    || brand.latestModel    == null
    || brand.notes          == null
    || !brand.status
    || brand.lastActivityDate == null;
}

async function findVerifiedUrl(client, brand) {
  const name = brand.brandName;

  if (brand.website) {
    const fetched = await fetchPage(brand.website);
    if (fetched && fetched.status < 400 && fetched.html) {
      const snippet = stripHtml(fetched.html);
      const correct = await claudeVerifyUrl(client, name, brand.website, snippet);
      if (correct) return { url: brand.website, html: fetched.html };
      // URL fetched but Claude says wrong brand — fall through to search
    }
    // Fetch failed — fall through to search
  }

  // Search for the correct URL via Brave
  const results = await braveSearch(`${name} watches`);
  const bestUrl = await claudePickBestUrl(client, name, results);
  if (!bestUrl) return { url: null, html: null };

  const fetched = await fetchPage(bestUrl);
  if (fetched && fetched.status < 400 && fetched.html) {
    return { url: bestUrl, html: fetched.html };
  }
  return { url: bestUrl, html: null };
}

async function processBrand(client, brand, filename, data) {
  if (!needsWork(brand)) return 'skip';

  // Phase 1: Verify / find website
  const { url: verifiedUrl, html: homepageHtml } = await findVerifiedUrl(client, brand);

  if (!verifiedUrl) {
    if (brand.website && brand.status !== 'Defunct') {
      brand.status = 'Defunct';
      save(filename, data);
    }
    return 'no-website';
  }

  brand.website = verifiedUrl;

  if (!homepageHtml) {
    save(filename, data);
    return 'fetch-error';
  }

  // Phase 2: Instagram handle via regex (fast, free)
  if (brand.instagramHandle == null || FORCE) {
    const ig = extractInstagram(homepageHtml);
    if (ig) brand.instagramHandle = ig;
  }

  // Phase 2b: Find and fetch a shop/collection page for better price data
  let combinedText = stripHtml(homepageHtml);
  const shopLinks = findShopLinks(homepageHtml, verifiedUrl);
  if (shopLinks.length > 0) {
    const shopFetch = await fetchPage(shopLinks[0]);
    if (shopFetch && shopFetch.html) {
      combinedText += '\n\n--- SHOP PAGE ---\n' + stripHtml(shopFetch.html);
    }
  }

  // Phase 3: Claude extraction
  const extracted = await claudeExtract(client, brand, combinedText);

  // Apply extracted values
  const fields = ['priceRangeLow','priceRangeHigh','foundedYear','latestModel','notes','status','lastActivityDate'];
  for (const f of fields) {
    if (extracted[f] != null && (brand[f] == null || FORCE)) {
      brand[f] = extracted[f];
    }
  }
  if (extracted.instagramHandle && (brand.instagramHandle == null || FORCE)) {
    brand.instagramHandle = extracted.instagramHandle;
  }

  save(filename, data);
  return 'done';
}

// ─── Concurrency pool ─────────────────────────────────────────────────────────

async function runPool(tasks, concurrency) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function run() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }
  if (!process.env.BRAVE_API_KEY) {
    console.warn('Warning: BRAVE_API_KEY not set — URL verification disabled. Get a free key at https://brave.com/search/api/\n');
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  if (REGION_ARG && !REGION_FILES[REGION_ARG]) {
    console.error(`Unknown region: "${REGION_ARG}". Valid: ${Object.keys(REGION_FILES).join(', ')}`);
    process.exit(1);
  }

  const regions = REGION_ARG
    ? { [REGION_ARG]: REGION_FILES[REGION_ARG] }
    : REGION_FILES;

  let totalDone = 0, totalSkipped = 0, totalErrors = 0, totalNoWebsite = 0;

  for (const [region, filename] of Object.entries(regions)) {
    const data = load(filename);
    const toProcess = data.filter(needsWork).slice(0, LIMIT);
    if (toProcess.length === 0) {
      console.log(`\n${region}: nothing to re-enrich — all fields populated (use --force to refresh)`);
      continue;
    }
    console.log(`\n${region}: re-enriching ${toProcess.length} brands (concurrency ${CONCURRENCY})...`);
    if (FORCE) console.log('  (--force: overwriting existing data)');

    let done = 0;
    const tasks = toProcess.map(brand => async () => {
      const result = await processBrand(client, brand, filename, data);
      done++;
      process.stdout.write(`\r  ${String(done).padStart(3)}/${toProcess.length} — ${brand.brandName.slice(0,30).padEnd(30)} [${result}]`);
      if (result === 'done')            totalDone++;
      else if (result === 'skip')       totalSkipped++;
      else if (result === 'no-website') totalNoWebsite++;
      else                              totalErrors++;
    });

    await runPool(tasks, CONCURRENCY);
    console.log('');
  }

  console.log('\n--- Re-Enrich Results ---');
  console.log(`  Enriched:     ${totalDone}`);
  console.log(`  Skipped:      ${totalSkipped}`);
  console.log(`  No website:   ${totalNoWebsite}`);
  console.log(`  Fetch errors: ${totalErrors}`);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
