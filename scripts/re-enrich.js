// scripts/re-enrich.js
//
// Enriches brand data using manual HTTP fetch + Claude Haiku extraction.
//
// ⚠️  DO NOT use Anthropic web_search / web_fetch tools here.
//     Those tools fetch full pages server-side and pass them through the model
//     at 20,000–50,000 tokens per page — roughly 150× more expensive than
//     fetching pages ourselves and stripping them to plain text first.
//     Lesson learned: web_search_20260209 cost ~$0.70/brand vs ~$0.004/brand here.
//
// Approach:
//   1. Fetch homepage ourselves (free HTTP) — strip HTML → plain text
//   2. Follow one shop/collection link for prices (free HTTP)
//   3. Extract Instagram handle from raw HTML with a regex (free, no API call)
//   4. Pass stripped text (~4,000 tokens) to Claude Haiku for extraction
//   5. For brands with no website: ask Haiku from knowledge only
//
// Flags:
//   --region europe|americas|asia-pacific|other  (default: all four)
//   --limit N                                    (default: unlimited)
//   --force                                      (overwrite all fields that already have data)
//   --force-location                             (overwrite country/townCity only — for fixing wrong locations)
//   --brands "Name1,Name2"                       (only enrich these specific brands, any region)
//
// Run:              node scripts/re-enrich.js
// One region:       node scripts/re-enrich.js --region europe
// Specific brands:  node scripts/re-enrich.js --brands "Wren,Nezumi,Pionier"
// Dry test:         node scripts/re-enrich.js --region europe --limit 5
// Monthly refresh:  node scripts/re-enrich.js --force

'use strict';
require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const DATA_DIR        = path.join(__dirname, '..', 'data');
const MODEL           = 'claude-haiku-4-5';   // cheap extraction model — no web tools
const CONCURRENCY     = 5;                    // parallel brands
const FETCH_TIMEOUT   = 10_000;               // ms per HTTP request
const MAX_PAGE_CHARS  = 6_000;                // strip pages to this length before sending

const LIMIT = process.argv.includes('--limit')
  ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10)
  : Infinity;

const REGION_ARG = process.argv.includes('--region')
  ? process.argv[process.argv.indexOf('--region') + 1]
  : null;

const FORCE          = process.argv.includes('--force');
const FORCE_LOCATION = process.argv.includes('--force-location'); // overwrite country/townCity even if set

// --brands "Name1,Name2" — target only these specific brands (matched case-insensitively)
const BRANDS_ARG = process.argv.includes('--brands')
  ? new Set(process.argv[process.argv.indexOf('--brands') + 1].split(',').map(s => s.trim().toLowerCase()))
  : null;

const REGION_FILES = {
  'europe':       'microbrands-europe.json',
  'americas':     'microbrands-americas.json',
  'asia-pacific': 'microbrands-asia-pacific.json',
  'other':        'microbrands-other.json',
};

// ─── File I/O ─────────────────────────────────────────────────────────────────

function load(filename) {
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) return [];
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function save(filename, data) {
  const sorted = [...data].sort((a, b) =>
    (a.brandName || '').localeCompare(b.brandName || '', 'en', { sensitivity: 'base' })
  );
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(sorted, null, 2), 'utf8');
}

// ─── Skip logic ───────────────────────────────────────────────────────────────

function needsWork(brand) {
  if (FORCE) return true;
  return !brand.website
    || !brand.country
    || !brand.townCity
    || brand.instagramHandle  == null
    || brand.priceRangeLow    == null
    || brand.foundedYear      == null
    || brand.latestModel      == null
    || !brand.notes;
}

// ─── HTTP fetch (manual — no Anthropic tools) ─────────────────────────────────

async function fetchPage(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    const res = await fetch(url, {
      signal:   controller.signal,
      redirect: 'follow',
      headers:  { 'User-Agent': 'Mozilla/5.0 (compatible; WatchResearchBot/1.0)' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    return { html, finalUrl: res.url };
  } catch {
    return null;
  }
}

// ─── HTML processing ──────────────────────────────────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi,   '')
    .replace(/<svg[\s\S]*?<\/svg>/gi,        '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g,  ' ')
    .replace(/&amp;/g,   '&')
    .replace(/&lt;/g,    '<')
    .replace(/&gt;/g,    '>')
    .replace(/&quot;/g,  '"')
    .replace(/\s+/g,     ' ')
    .trim()
    .slice(0, MAX_PAGE_CHARS);
}

// Extract Instagram handle directly from raw HTML — no API call needed
function extractInstagram(html) {
  const match = html.match(/instagram\.com\/([a-zA-Z0-9_.]{2,30})/);
  if (!match) return null;
  const handle = match[1];
  const generic = ['p', 'reel', 'explore', 'accounts', 'direct', 'stories', 'tv', 'shoppingredirect'];
  return generic.includes(handle) ? null : handle;
}

// Find a shop or collection page link within the same domain
function findShopLink(html, baseUrl) {
  const base = new URL(baseUrl);
  const hrefs = [...html.matchAll(/href=["']([^"'#?]{4,})["']/gi)].map(m => m[1]);
  for (const href of hrefs) {
    try {
      const url = new URL(href, baseUrl);
      if (url.hostname !== base.hostname) continue;
      const p = url.pathname.toLowerCase();
      if (/\/(shop|collection|collections|watches|buy|store|products|catalogue|catalog|boutique|order)\b/.test(p)) {
        return url.href;
      }
    } catch { /* invalid href */ }
  }
  return null;
}

// ─── Claude extraction ────────────────────────────────────────────────────────

const EXTRACT_SCHEMA = `{
  "website": "https://...",          // correct official URL, or null
  "country": "Germany",              // full country name in English, or null
  "townCity": "Hamburg",             // city or town the brand is based in, or null
  "instagramHandle": "...",          // username without @, or null
  "priceRangeLow": 350,              // lowest current USD price as integer, or null
  "priceRangeHigh": 650,             // highest current USD price as integer, or null
  "foundedYear": 2017,               // year brand was founded as integer, or null
  "latestModel": "...",              // most recent or featured model name, or null
  "status": "Active",                // "Active" | "Dormant" | "Defunct"
  "lastActivityDate": "2024-10-01",  // ISO YYYY-MM-DD of last confirmed activity, or null
  "notes": "..."                     // 1-3 factual sentences: founding, style, movements, location
}`;

async function enrichBrand(client, brand, homeText, shopText) {
  const context = homeText
    ? `Homepage content:\n${homeText}${shopText ? `\n\nShop/collection page:\n${shopText}` : ''}`
    : `No website content available. Use your training knowledge only.`;

  const userMessage = `Extract data for the watch brand "${brand.brandName}" (${brand.country || 'unknown country'}).

${context}

Return ONLY valid JSON with no markdown or explanation:
${EXTRACT_SCHEMA}

Rules:
- Only return values you are confident about — never guess or fabricate
- Prices must be in USD integers — convert from other currencies if needed
- Notes format: "German microbrand founded in 2014. Known for field watches with in-house movements. Based in Hamburg."
- Status: Active = selling now; Dormant = no activity 12+ months; Defunct = site down or closed notice`;

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: 512,
    messages:   [{ role: 'user', content: userMessage }],
  });

  for (const block of response.content) {
    if (block.type !== 'text') continue;
    const text = block.text.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
    try { return JSON.parse(text); } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) try { return JSON.parse(m[0]); } catch { /* fall through */ }
    }
  }
  return null;
}

// ─── Per-brand processor ──────────────────────────────────────────────────────

async function processBrand(client, brand, filename, data) {
  if (!BRANDS_ARG && !needsWork(brand)) return 'skip';

  let homeText = null, shopText = null;

  if (brand.website) {
    const home = await fetchPage(brand.website);
    if (home) {
      // Extract Instagram from raw HTML before stripping (regex on full source)
      const igFromHtml = extractInstagram(home.html);
      if (igFromHtml && brand.instagramHandle == null) {
        brand.instagramHandle = igFromHtml;
      }

      homeText = stripHtml(home.html);

      const shopUrl = findShopLink(home.html, home.finalUrl);
      if (shopUrl) {
        const shop = await fetchPage(shopUrl);
        if (shop) shopText = stripHtml(shop.html);
      }
    }
  }

  let extracted;
  try {
    extracted = await enrichBrand(client, brand, homeText, shopText);
  } catch {
    return 'error';
  }

  if (!extracted) return 'no-data';

  const fields = [
    'website', 'country', 'townCity', 'instagramHandle',
    'priceRangeLow', 'priceRangeHigh',
    'foundedYear', 'latestModel',
    'status', 'lastActivityDate', 'notes',
  ];
  const locationFields = new Set(['country', 'townCity']);
  const isUnknownNotes = brand.notes === 'Unknown brand — manual review needed';
  for (const f of fields) {
    const forceThis = FORCE
      || (FORCE_LOCATION && locationFields.has(f))
      || (isUnknownNotes && f === 'notes');
    if (extracted[f] != null && (brand[f] == null || forceThis)) {
      brand[f] = extracted[f];
    }
  }

  save(filename, data);
  return 'done';
}

// ─── Concurrency pool ─────────────────────────────────────────────────────────

async function runPool(tasks, concurrency) {
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) await tasks[idx++]();
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function run() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  if (REGION_ARG && !REGION_FILES[REGION_ARG]) {
    console.error(`Unknown region: "${REGION_ARG}". Valid: ${Object.keys(REGION_FILES).join(', ')}`);
    process.exit(1);
  }

  // --brands searches all regions; --region still narrows when used alone
  const regions = (BRANDS_ARG || !REGION_ARG) ? REGION_FILES : { [REGION_ARG]: REGION_FILES[REGION_ARG] };

  let totalDone = 0, totalSkipped = 0, totalErrors = 0, totalNoData = 0;

  for (const [region, filename] of Object.entries(regions)) {
    const data  = load(filename);
    const toProcess = data
      .filter(b => BRANDS_ARG ? BRANDS_ARG.has(b.brandName.toLowerCase()) : needsWork(b))
      .slice(0, LIMIT);

    if (toProcess.length === 0) {
      console.log(`\n${region}: nothing to re-enrich (use --force to refresh)`);
      continue;
    }

    console.log(`\n${region}: re-enriching ${toProcess.length} brands (concurrency ${CONCURRENCY}, model ${MODEL})...`);

    let done = 0;
    const tasks = toProcess.map(brand => async () => {
      const result = await processBrand(client, brand, filename, data);
      done++;
      process.stdout.write(
        `\r  ${String(done).padStart(3)}/${toProcess.length} — ${brand.brandName.slice(0, 30).padEnd(30)} [${result}]`
      );
      if      (result === 'done')    totalDone++;
      else if (result === 'skip')    totalSkipped++;
      else if (result === 'no-data') totalNoData++;
      else                           totalErrors++;
    });

    await runPool(tasks, CONCURRENCY);
    console.log('');
  }

  console.log('\n--- Re-Enrich Results ---');
  console.log(`  Enriched:  ${totalDone}`);
  console.log(`  Skipped:   ${totalSkipped}`);
  console.log(`  No data:   ${totalNoData}`);
  console.log(`  Errors:    ${totalErrors}`);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
