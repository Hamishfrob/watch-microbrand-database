// scripts/scrape-brands.js
// For each brand with a website, fetches the homepage and extracts:
//   - instagramHandle (regex on raw HTML)
//   - priceRangeLow, priceRangeHigh, foundedYear, latestModel, notes (Claude Haiku)
// Only fills fields that are currently null. Never overwrites existing data.
// Saves immediately after each brand so restarts lose minimal work.
// Run: node scripts/scrape-brands.js
// Run with limit: node scripts/scrape-brands.js --limit 20
// Run one region: node scripts/scrape-brands.js --region europe

require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');
const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const CONCURRENCY = 5;
const TIMEOUT_MS  = 12000;

const LIMIT = process.argv.includes('--limit')
  ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10)
  : Infinity;

const REGION_ARG = process.argv.includes('--region')
  ? process.argv[process.argv.indexOf('--region') + 1]
  : null;

// Note: microbrands-other.json is intentionally excluded — brands there
// haven't been assigned a country yet and are handled by enrich-pass2.js
const REGION_FILES = {
  'europe':       'microbrands-europe.json',
  'americas':     'microbrands-americas.json',
  'asia-pacific': 'microbrands-asia-pacific.json',
};

function load(filename) {
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) return [];
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function save(filename, data) {
  data.sort((a, b) =>
    (a.brandName || '').localeCompare(b.brandName || '', 'en', { sensitivity: 'base' })
  );
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2), 'utf8');
}

// Returns raw HTML string or null on error/timeout
function fetchPage(url) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    try {
      const req = mod.get(url, {
        timeout: TIMEOUT_MS,
        headers: { 'User-Agent': 'WatchBrandBot/1.0 (+https://github.com/watchcollectorsclub)' }
      }, res => {
        // Follow one redirect
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          return fetchPage(res.headers.location).then(resolve);
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(chunks.join('')));
        res.on('error', () => resolve(null));
      });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
    } catch { resolve(null); }
  });
}

// Extract Instagram handle from raw HTML
function extractInstagram(html) {
  const match = html.match(/instagram\.com\/([A-Za-z0-9_\.]{1,30})\/?["'\s>]/);
  if (!match) return null;
  const handle = match[1];
  // Filter out generic Instagram paths
  const skip = ['p', 'reel', 'stories', 'explore', 'accounts', 'shoppingbag', 'share', 'tv'];
  if (skip.includes(handle.toLowerCase())) return null;
  return handle;
}

// Strip HTML tags and collapse whitespace — keep max 3000 chars for Claude
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3000);
}

const SYSTEM_PROMPT = `You are a watch industry expert extracting data from a watch brand's website homepage text.

Extract the following fields:
- priceRangeLow: lowest price in USD of watches currently for sale (integer, null if unknown)
- priceRangeHigh: highest price in USD of watches currently for sale (integer, null if unknown)
- foundedYear: year the brand was founded (integer, null if unknown)
- latestModel: name of the most recently released or featured watch model (string, null if unknown)
- notes: 1-3 sentences about the brand — founding story, what they are known for, movement type, atelier location, price range if known. Style: factual, concise. Example: "French microbrand founded in 2017. Known for vintage-inspired dive and dress watches with in-house designed dials. Swiss-assembled using ETA and Sellita movements." Return null if you cannot write an accurate note.

Rules:
- Only return values you are confident about from the text — do NOT guess or fabricate
- Prices must be in USD — convert if shown in other currency using approximate rates
- Return ONLY valid JSON. No markdown. No explanation.

Example:
{"priceRangeLow": 350, "priceRangeHigh": 650, "foundedYear": 2017, "latestModel": "Aquascaphe", "notes": "French microbrand founded in 2017..."}`;

async function enrichWithClaude(client, brand, pageText) {
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `Brand: ${brand.brandName}\nCountry: ${brand.country || 'unknown'}\n\nHomepage text:\n${pageText}`
    }],
    system: SYSTEM_PROMPT,
  });
  const text = message.content[0].text.trim();
  const json = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(json);
  } catch (err) {
    console.error(`\n  JSON parse error for ${brand.brandName}: ${err.message}`);
    return {};
  }
}

// Returns true if brand needs any enrichment
function needsWork(brand) {
  return !brand.instagramHandle || !brand.priceRangeLow || !brand.foundedYear || !brand.latestModel || !brand.notes;
}

async function processBrand(client, brand, filename, data) {
  if (!brand.website) return 'no-website';
  if (!needsWork(brand)) return 'skip';

  let html;
  try {
    html = await fetchPage(brand.website);
  } catch { html = null; }

  if (!html) return 'fetch-error';

  // Instagram handle — regex only, no Claude needed
  if (!brand.instagramHandle) {
    brand.instagramHandle = extractInstagram(html) || null;
  }

  // Claude enrichment for remaining fields
  const needsClaude = !brand.priceRangeLow || !brand.foundedYear || !brand.latestModel || !brand.notes;
  if (needsClaude) {
    const pageText = stripHtml(html);
    let extracted = {};
    try {
      extracted = await enrichWithClaude(client, brand, pageText);
    } catch (err) {
      console.error(`\n  Claude error for ${brand.brandName}: ${err.message}`);
    }

    if (extracted.priceRangeLow  && !brand.priceRangeLow)  brand.priceRangeLow  = extracted.priceRangeLow;
    if (extracted.priceRangeHigh && !brand.priceRangeHigh) brand.priceRangeHigh = extracted.priceRangeHigh;
    if (extracted.foundedYear    && !brand.foundedYear)    brand.foundedYear    = extracted.foundedYear;
    if (extracted.latestModel    && !brand.latestModel)    brand.latestModel    = extracted.latestModel;
    if (extracted.notes          && !brand.notes)          brand.notes          = extracted.notes;
  }

  save(filename, data);
  return 'done';
}

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

async function run() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set. Add it to your .env file.');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const regions = REGION_ARG
    ? { [REGION_ARG]: REGION_FILES[REGION_ARG] }
    : REGION_FILES;

  if (REGION_ARG && !REGION_FILES[REGION_ARG]) {
    console.error(`Unknown region: "${REGION_ARG}". Valid options: ${Object.keys(REGION_FILES).join(', ')}`);
    process.exit(1);
  }

  let totalDone = 0, totalSkipped = 0, totalErrors = 0;

  for (const [region, filename] of Object.entries(regions)) {
    const data = load(filename);
    const toProcess = data.filter(b => b.website && needsWork(b)).slice(0, LIMIT);
    if (toProcess.length === 0) {
      console.log(`${region}: nothing to enrich — skipping`);
      continue;
    }
    console.log(`\n${region}: enriching ${toProcess.length} brands (concurrency ${CONCURRENCY})...`);

    let done = 0;
    const tasks = toProcess.map(brand => async () => {
      const result = await processBrand(client, brand, filename, data);
      done++;
      process.stdout.write(`\r  ${done}/${toProcess.length} — last: ${brand.brandName.slice(0,30).padEnd(30)} [${result}]`);
      if (result === 'done') totalDone++;
      else if (result === 'skip') totalSkipped++;
      else totalErrors++;
    });

    await runPool(tasks, CONCURRENCY);
    console.log('');
  }

  console.log('\n--- Scrape Results ---');
  console.log(`  Enriched:  ${totalDone}`);
  console.log(`  Skipped:   ${totalSkipped}`);
  console.log(`  Errors:    ${totalErrors}`);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
