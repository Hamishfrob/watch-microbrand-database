# Website Enrichment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enrich the 451 brands in Europe/Americas/Asia-Pacific regional files with websites (for those missing one), then scrape each brand's website for Instagram handle, price range, founded year, latest model and notes.

**Architecture:** Two scripts. `find-websites.js` batches brands with no website to Claude Haiku (knowledge-only, no HTTP). `scrape-brands.js` fetches each brand's homepage, regex-extracts Instagram handle, then sends stripped page text to Claude Haiku to extract price range, founded year, latest model and notes. Both scripts save after every batch/brand so a mid-run crash loses minimal work. Both support `--limit N` and `--region europe|americas|asia-pacific` flags.

**Tech Stack:** Node.js, `@anthropic-ai/sdk` (already installed), `dotenv` (already installed), built-in `https`/`http` modules. No new npm packages required.

---

## Context

| File | Brands | No website | No IG | No price |
|------|--------|-----------|-------|---------|
| microbrands-europe.json | 309 | 152 | 309 | 309 |
| microbrands-americas.json | 102 | 58 | 102 | 102 |
| microbrands-asia-pacific.json | 40 | 21 | 40 | 40 |
| **TOTAL** | **451** | **231** | **451** | **451** |

Existing utilities to reuse from `scripts/enrich-pass1.js` and `scripts/enrich-pass2.js`:
- `load(filename)` / `save(filename, data)` helpers
- `REGION_FILES` constant
- `dotenv` config pattern
- `fetchPage()` pattern from `enrich-pass2.js`

---

## Task 1: Write `scripts/find-websites.js`

**Files:**
- Create: `scripts/find-websites.js`

**Step 1: Write the script**

```js
// scripts/find-websites.js
// Uses Claude Haiku (knowledge only, no HTTP) to find official website URLs
// for brands in the three regional files that have website: null.
// Run: node scripts/find-websites.js
// Run with limit: node scripts/find-websites.js --limit 50
// Run one region: node scripts/find-websites.js --region europe

require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BATCH_SIZE = 50;

const LIMIT = process.argv.includes('--limit')
  ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10)
  : Infinity;

const REGION_ARG = process.argv.includes('--region')
  ? process.argv[process.argv.indexOf('--region') + 1]
  : null;

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

const SYSTEM_PROMPT = `You are a watch industry expert. For each watch brand name provided, return its official website URL if you know it with confidence.

Rules:
- Only return URLs you are confident are correct official brand websites
- Return null if you are not sure — do NOT guess or fabricate
- Return the bare URL with https:// prefix (e.g. "https://www.baltic-watches.com")
- Do not return social media pages, retailer pages, or redirects
- Return ONLY a valid JSON array. No markdown, no explanation.

Example output:
[
  {"brandName": "Baltic", "website": "https://www.baltic-watches.com"},
  {"brandName": "UnknownBrand", "website": null}
]`;

async function processBatch(client, brands) {
  const names = brands.map(b => b.brandName);
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [{ role: 'user', content: `Find websites for these watch brands:\n${JSON.stringify(names)}` }],
    system: SYSTEM_PROMPT,
  });
  const text = message.content[0].text.trim();
  const json = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(json);
}

async function run() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const regions = REGION_ARG
    ? { [REGION_ARG]: REGION_FILES[REGION_ARG] }
    : REGION_FILES;

  let totalFound = 0;

  for (const [region, filename] of Object.entries(regions)) {
    const data = load(filename);
    const toProcess = data.filter(b => !b.website).slice(0, LIMIT);
    if (toProcess.length === 0) {
      console.log(`${region}: no brands missing website — skipping`);
      continue;
    }
    console.log(`\n${region}: finding websites for ${toProcess.length} brands...`);

    for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
      const batch = toProcess.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(toProcess.length / BATCH_SIZE);
      process.stdout.write(`  Batch ${batchNum}/${totalBatches}...`);

      let results;
      try {
        results = await processBatch(client, batch);
      } catch (err) {
        console.error(`\n  ERROR in batch ${batchNum}: ${err.message}`);
        continue;
      }

      let batchFound = 0;
      for (const result of results) {
        if (!result.website) continue;
        const entry = data.find(b => b.brandName.toLowerCase() === result.brandName.toLowerCase());
        if (!entry) continue;
        entry.website = result.website;
        batchFound++;
        totalFound++;
      }
      console.log(` found ${batchFound}/${batch.length}`);
      save(filename, data);
    }
  }

  console.log(`\nDone. Total websites found: ${totalFound}`);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
```

**Step 2: Quick smoke-test (limit 3, no API cost concern)**

```bash
node scripts/find-websites.js --limit 3 --region europe
```

Expected: prints 1 batch, finds some websites, saves file. No crash.

**Step 3: Commit**

```bash
git add scripts/find-websites.js
git commit -m "feat: add find-websites script — Claude Haiku knowledge-only website lookup"
```

---

## Task 2: Run `find-websites.js` for all regions

**Step 1: Run across all regions**

```bash
node scripts/find-websites.js
```

This processes all 231 no-website brands in ~5 batches per region (~15 total). Takes 2–4 minutes.

Expected output: per-region batch progress, total count at end.

**Step 2: Check results**

```bash
node -e "
const fs = require('fs');
const files = ['data/microbrands-europe.json','data/microbrands-americas.json','data/microbrands-asia-pacific.json'];
let noWeb = 0;
files.forEach(f => {
  const d = JSON.parse(fs.readFileSync(f,'utf8'));
  const n = d.filter(b=>!b.website).length;
  noWeb += n;
  console.log(f.split('/')[1] + ': ' + n + ' still no website');
});
console.log('Total no website:', noWeb);
"
```

**Step 3: Commit updated JSON**

```bash
git add data/microbrands-europe.json data/microbrands-americas.json data/microbrands-asia-pacific.json
git commit -m "data: run find-websites — website URLs populated from Claude knowledge"
```

---

## Task 3: Write `scripts/scrape-brands.js`

**Files:**
- Create: `scripts/scrape-brands.js`

**Step 1: Write the script**

```js
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
  // Filter out generic paths
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
  return JSON.parse(json);
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
    let extracted;
    try {
      extracted = await enrichWithClaude(client, brand, pageText);
    } catch (err) {
      console.error(`\n  Claude error for ${brand.brandName}: ${err.message}`);
      extracted = {};
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
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const regions = REGION_ARG
    ? { [REGION_ARG]: REGION_FILES[REGION_ARG] }
    : REGION_FILES;

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
```

**Step 2: Quick smoke-test**

```bash
node scripts/scrape-brands.js --limit 5 --region europe
```

Expected: fetches 5 brand homepages, prints progress, saves. No crash. Check one brand in `data/microbrands-europe.json` to verify fields were populated.

**Step 3: Commit**

```bash
git add scripts/scrape-brands.js
git commit -m "feat: add scrape-brands script — Instagram regex + Claude Haiku enrichment from homepages"
```

---

## Task 4: Run `scrape-brands.js` for all regions

**Step 1: Run Europe (309 brands, ~220 with websites)**

```bash
node scripts/scrape-brands.js --region europe
```

Takes ~5–10 minutes at concurrency 5 with Claude calls. Watch for errors.

**Step 2: Run Americas + Asia-Pacific**

```bash
node scripts/scrape-brands.js --region americas
node scripts/scrape-brands.js --region asia-pacific
```

**Step 3: Check enrichment coverage**

```bash
node -e "
const fs = require('fs');
const files = ['data/microbrands-europe.json','data/microbrands-americas.json','data/microbrands-asia-pacific.json'];
files.forEach(f => {
  const d = JSON.parse(fs.readFileSync(f,'utf8'));
  console.log(f.split('/')[1]);
  console.log('  no IG:    ', d.filter(b=>!b.instagramHandle).length + '/' + d.length);
  console.log('  no price: ', d.filter(b=>!b.priceRangeLow).length + '/' + d.length);
  console.log('  no year:  ', d.filter(b=>!b.foundedYear).length + '/' + d.length);
  console.log('  no notes: ', d.filter(b=>!b.notes).length + '/' + d.length);
});
"
```

**Step 4: Commit enriched data**

```bash
git add data/microbrands-europe.json data/microbrands-americas.json data/microbrands-asia-pacific.json
git commit -m "data: run scrape-brands — Instagram handles, prices, founding years, notes from homepages"
```

---

## Task 5: Rebuild spreadsheet and push

**Step 1: Rebuild Excel**

```bash
node scripts/build-spreadsheet.js
```

Expected: `watch-microbrand-database.xlsx` regenerated. Check it opens correctly.

**Step 2: Final commit and push**

```bash
git add watch-microbrand-database.xlsx
git commit -m "build: regenerate spreadsheet after website enrichment run"
git push origin main
```

---

## Notes

- Both scripts are re-runnable — they skip brands that already have data
- `find-websites.js` only writes `website` field, never touches other fields
- `scrape-brands.js` only writes to null fields — never overwrites existing data
- If a brand's website returns a 404 or times out, it is marked `fetch-error` in progress output but the entry is left unchanged in the JSON
- Instagram handles from the regex are validated against a blocklist of generic paths (`p`, `reel`, `stories`, etc.)
