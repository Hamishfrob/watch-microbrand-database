# Enrichment Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deduplicate the database, auto-exclude non-microbrands, assign countries/regions, and enrich brand data via a two-pass Claude API pipeline.

**Architecture:** Three scripts run in sequence. `dedupe.js` cleans duplicates first. `enrich-pass1.js` sends brand names in batches to Claude (no web fetching) to classify, assign country, and write notes from training knowledge. `enrich-pass2.js` fetches websites for brands still without a country and uses Claude to extract remaining fields. After each pass, brands are moved from `microbrands-other.json` into the correct regional file.

**Tech Stack:** Node.js, `@anthropic-ai/sdk` (to install), `claude-haiku-4-5` model, built-in `https`/`http`. Requires `ANTHROPIC_API_KEY` environment variable.

**Project root:** `C:/Users/hamis/OneDrive/Coding/watch-microbrand-database/`

---

## Region/Country Reference

Use this mapping throughout all scripts:

```javascript
const COUNTRY_TO_REGION = {
  // Europe
  'United Kingdom': 'europe', 'France': 'europe', 'Germany': 'europe',
  'Switzerland': 'europe', 'Italy': 'europe', 'Spain': 'europe',
  'Netherlands': 'europe', 'Belgium': 'europe', 'Sweden': 'europe',
  'Denmark': 'europe', 'Norway': 'europe', 'Finland': 'europe',
  'Austria': 'europe', 'Czech Republic': 'europe', 'Hungary': 'europe',
  'Ireland': 'europe', 'Poland': 'europe', 'Portugal': 'europe',
  'Greece': 'europe', 'Romania': 'europe', 'Croatia': 'europe',
  'Slovakia': 'europe', 'Slovenia': 'europe', 'Estonia': 'europe',
  'Latvia': 'europe', 'Lithuania': 'europe', 'Luxembourg': 'europe',
  'Iceland': 'europe', 'Malta': 'europe', 'Serbia': 'europe',
  // Americas
  'USA': 'americas', 'United States': 'americas', 'Canada': 'americas',
  'Brazil': 'americas', 'Argentina': 'americas', 'Mexico': 'americas',
  'Colombia': 'americas', 'Chile': 'americas', 'Peru': 'americas',
  'Uruguay': 'americas',
  // Asia-Pacific
  'Japan': 'asia-pacific', 'China': 'asia-pacific', 'Singapore': 'asia-pacific',
  'Australia': 'asia-pacific', 'Hong Kong': 'asia-pacific', 'South Korea': 'asia-pacific',
  'Taiwan': 'asia-pacific', 'Malaysia': 'asia-pacific', 'New Zealand': 'asia-pacific',
  'India': 'asia-pacific', 'Thailand': 'asia-pacific', 'Indonesia': 'asia-pacific',
  'Vietnam': 'asia-pacific', 'Philippines': 'asia-pacific',
};

const REGION_FILES = {
  'europe':       'microbrands-europe.json',
  'americas':     'microbrands-americas.json',
  'asia-pacific': 'microbrands-asia-pacific.json',
  'other':        'microbrands-other.json',
};
```

---

## Task 1: Install @anthropic-ai/sdk

**Files:**
- Modify: `package.json`

**Step 1: Install the SDK**

```bash
cd "C:/Users/hamis/OneDrive/Coding/watch-microbrand-database"
npm install @anthropic-ai/sdk
```

Expected: `node_modules/@anthropic-ai/` created, `package-lock.json` updated.

**Step 2: Verify it loads**

```bash
node -e "const Anthropic = require('@anthropic-ai/sdk'); console.log('SDK ok:', typeof Anthropic);"
```

Expected: `SDK ok: function`

**Step 3: Check API key is available**

```bash
node -e "console.log('Key set:', !!process.env.ANTHROPIC_API_KEY);"
```

Expected: `Key set: true`

If false, the user must set `ANTHROPIC_API_KEY` in their environment before continuing.

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add @anthropic-ai/sdk dependency"
```

---

## Task 2: dedupe.js

**Files:**
- Create: `scripts/dedupe.js`

**Step 1: Write the script**

```javascript
// scripts/dedupe.js
// Removes duplicate brandName entries across all regional files.
// When a brand appears in multiple files, keeps the entry with the most non-null fields.
// Run: node scripts/dedupe.js

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

const REGION_FILES = {
  'europe':       'microbrands-europe.json',
  'americas':     'microbrands-americas.json',
  'asia-pacific': 'microbrands-asia-pacific.json',
  'other':        'microbrands-other.json',
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

function richness(entry) {
  return Object.values(entry).filter(v => v !== null && v !== '' && v !== undefined).length;
}

// Load all files
const files = {};
for (const [region, filename] of Object.entries(REGION_FILES)) {
  files[region] = load(filename);
}

// Build a map: normalised brandName → { region, entry, richness }
const seen = new Map();
let removed = 0;

for (const [region, entries] of Object.entries(files)) {
  for (const entry of entries) {
    const key = (entry.brandName || '').toLowerCase().trim();
    if (!key) continue;
    const r = richness(entry);
    if (seen.has(key)) {
      const existing = seen.get(key);
      if (r > existing.richness) {
        // Current entry is richer — replace
        console.log(`  DUPE: "${entry.brandName}" — keeping ${region} entry (richer), removing ${existing.region}`);
        seen.set(key, { region, entry, richness: r });
      } else {
        // Existing entry is richer — drop current
        console.log(`  DUPE: "${entry.brandName}" — keeping ${existing.region} entry (richer), removing ${region}`);
      }
      removed++;
    } else {
      seen.set(key, { region, entry, richness: r });
    }
  }
}

// Rebuild files from deduplicated map
const rebuilt = { europe: [], americas: [], 'asia-pacific': [], other: [] };
for (const { region, entry } of seen.values()) {
  rebuilt[region].push(entry);
}

for (const [region, filename] of Object.entries(REGION_FILES)) {
  save(filename, rebuilt[region]);
}

console.log(`\nDone. Removed ${removed} duplicates.`);
for (const [region, entries] of Object.entries(rebuilt)) {
  console.log(`  ${region}: ${entries.length} brands`);
}
```

**Step 2: Run it**

```bash
node scripts/dedupe.js
```

Expected: ~64 dupes reported, counts across files reduced accordingly.

**Step 3: Verify no dupes remain**

```bash
node -e "
const fs = require('fs');
const files = ['microbrands-europe','microbrands-americas','microbrands-asia-pacific','microbrands-other'];
const seen = {};
let dupes = 0;
files.forEach(f => {
  JSON.parse(fs.readFileSync('data/'+f+'.json')).forEach(b => {
    const k = b.brandName.toLowerCase().trim();
    if (seen[k]) { console.log('STILL DUPE:', b.brandName); dupes++; }
    seen[k] = true;
  });
});
console.log('Remaining dupes:', dupes);
"
```

Expected: `Remaining dupes: 0`

**Step 4: Commit**

```bash
git add scripts/dedupe.js data/
git commit -m "feat: add dedupe script — remove 64 duplicate entries"
```

---

## Task 3: enrich-pass1.js

**Files:**
- Create: `scripts/enrich-pass1.js`

**Step 1: Write the script**

```javascript
// scripts/enrich-pass1.js
// Pass 1: Send brand names in batches to Claude API (no web fetching).
// Claude classifies each brand (keep/exclude), assigns country from training knowledge,
// and writes a short notes field for brands it recognises.
// Brands with unknown country are left in other.json for Pass 2.
// Run: node scripts/enrich-pass1.js
// Run with limit: node scripts/enrich-pass1.js --limit 100

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LIMIT    = process.argv.includes('--limit')
  ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10)
  : Infinity;

const REGION_FILES = {
  'europe':       'microbrands-europe.json',
  'americas':     'microbrands-americas.json',
  'asia-pacific': 'microbrands-asia-pacific.json',
  'other':        'microbrands-other.json',
};

const COUNTRY_TO_REGION = {
  'United Kingdom': 'europe', 'France': 'europe', 'Germany': 'europe',
  'Switzerland': 'europe', 'Italy': 'europe', 'Spain': 'europe',
  'Netherlands': 'europe', 'Belgium': 'europe', 'Sweden': 'europe',
  'Denmark': 'europe', 'Norway': 'europe', 'Finland': 'europe',
  'Austria': 'europe', 'Czech Republic': 'europe', 'Hungary': 'europe',
  'Ireland': 'europe', 'Poland': 'europe', 'Portugal': 'europe',
  'Greece': 'europe', 'Romania': 'europe', 'Croatia': 'europe',
  'Slovakia': 'europe', 'Slovenia': 'europe', 'Estonia': 'europe',
  'Latvia': 'europe', 'Lithuania': 'europe', 'Luxembourg': 'europe',
  'Iceland': 'europe', 'Malta': 'europe', 'Serbia': 'europe',
  'USA': 'americas', 'United States': 'americas', 'Canada': 'americas',
  'Brazil': 'americas', 'Argentina': 'americas', 'Mexico': 'americas',
  'Colombia': 'americas', 'Chile': 'americas', 'Peru': 'americas',
  'Uruguay': 'americas',
  'Japan': 'asia-pacific', 'China': 'asia-pacific', 'Singapore': 'asia-pacific',
  'Australia': 'asia-pacific', 'Hong Kong': 'asia-pacific', 'South Korea': 'asia-pacific',
  'Taiwan': 'asia-pacific', 'Malaysia': 'asia-pacific', 'New Zealand': 'asia-pacific',
  'India': 'asia-pacific', 'Thailand': 'asia-pacific', 'Indonesia': 'asia-pacific',
  'Vietnam': 'asia-pacific', 'Philippines': 'asia-pacific',
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

const SYSTEM_PROMPT = `You are a watch industry expert helping curate a database of microbrand and independent watch brands.

For each brand name provided, you must classify it and return a JSON array.

EXCLUDE (action: "exclude") any brand that is:
- Owned by a major watch group: Rolex Group (Rolex, Tudor), Swatch Group (Omega, Longines, Tissot, Rado, Hamilton, Certina, Mido, Swatch, Breguet, Blancpain, Glashutte Original, Jaquet Droz, Leon Hatot), Richemont (Cartier, IWC, Jaeger-LeCoultre, Panerai, Piaget, Vacheron Constantin, Baume & Mercier, Roger Dubuis, Lange & Sohne, Officine Panerai), LVMH (TAG Heuer, Hublot, Zenith, Bulgari), Kering (Ulysse Nardin, Girard-Perregaux), Citizen Group (Citizen, Bulova, Frederique Constant, Alpina), Seiko Group (Seiko, Grand Seiko, Credor, Orient, Lorus, Pulsar)
- A fashion/luxury house: Gucci, Versace, Michael Kors, Armani, DKNY, Boss, Diesel, Dolce & Gabbana, Ralph Lauren, Tory Burch, Salvatore Ferragamo, Maserati, Jaguar, Porsche Design
- A smart watch or tech brand: Apple, Samsung, Garmin, Fitbit, Fossil (parent company), any Android wearable
- Clearly priced above $5,000 USD (ultra-high-end independents like Greubel Forsey, MB&F, FP Journe, Richard Mille, De Bethune, Philippe Dufour, Kari Voutilainen, Romain Gauthier, Patek Philippe, Audemars Piguet)
- Not a watch brand at all (e.g. "Promotional watches for businesses", "Moded Seikos", "All watches offered on Alibaba & DH Gate", "Test", "Android Wearables")
- A generic/white-label manufacturer (e.g. Parnis, Pagani Design, San Martin when sold purely as homages)

For brands you recognise as legitimate microbrands or independent brands under $5,000, return action: "keep" with:
- country: the country where the brand is based (use standard English country names, e.g. "United Kingdom" not "UK" or "England")
- notes: 1-3 sentences about the brand — founding story, what they are known for, movement type, atelier location, price range if known. Style: factual, concise. Example: "French microbrand founded in 2017. Known for vintage-inspired dive and dress watches with in-house designed dials. Swiss-assembled using ETA and Sellita movements."

For brands you do not recognise or are unsure about, return action: "keep", country: null, notes: null. Do NOT guess or fabricate.

Return ONLY a valid JSON array. No markdown, no explanation. Example:
[
  {"brandName": "Baltic", "action": "keep", "country": "France", "notes": "French microbrand..."},
  {"brandName": "Rolex", "action": "exclude", "reason": "Rolex Group"},
  {"brandName": "UnknownBrand", "action": "keep", "country": null, "notes": null}
]`;

async function processBatch(client, brands) {
  const names = brands.map(b => b.brandName);
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `Classify these watch brands:\n${JSON.stringify(names)}`
    }],
    system: SYSTEM_PROMPT,
  });

  const text = message.content[0].text.trim();
  // Strip markdown code fences if present
  const json = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(json);
}

async function run() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Load all region files
  const regionData = {};
  for (const [region, filename] of Object.entries(REGION_FILES)) {
    regionData[region] = load(filename);
  }

  // Get brands from other.json with null country (MBWDB imports)
  const toProcess = regionData['other']
    .filter(b => !b.country)
    .slice(0, LIMIT);

  console.log(`Processing ${toProcess.length} brands in Pass 1...`);

  const BATCH_SIZE = 50;
  let kept = 0, excluded = 0, assignedCountry = 0, stillUnknown = 0;
  const excludedNames = new Set();

  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    const batch = toProcess.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(toProcess.length / BATCH_SIZE);
    process.stdout.write(`\r  Batch ${batchNum}/${totalBatches}...`);

    let results;
    try {
      results = await processBatch(client, batch);
    } catch (err) {
      console.error(`\n  ERROR in batch ${batchNum}: ${err.message}`);
      continue;
    }

    for (const result of results) {
      const entry = regionData['other'].find(
        b => b.brandName.toLowerCase() === result.brandName.toLowerCase()
      );
      if (!entry) continue;

      if (result.action === 'exclude') {
        excludedNames.add(result.brandName.toLowerCase());
        excluded++;
        console.log(`\n  EXCLUDE: ${result.brandName} (${result.reason || 'flagged'})`);
        continue;
      }

      // Update entry with enriched data
      if (result.notes) entry.notes = result.notes;

      if (result.country) {
        entry.country = result.country;
        const region = COUNTRY_TO_REGION[result.country] || 'other';
        if (region !== 'other') {
          // Move to correct regional file
          regionData[region].push(entry);
          assignedCountry++;
          console.log(`\n  MOVED [${region}]: ${entry.brandName} (${result.country})`);
        }
      } else {
        stillUnknown++;
      }
      kept++;
    }
  }

  // Remove excluded and moved entries from other.json
  regionData['other'] = regionData['other'].filter(b => {
    if (excludedNames.has(b.brandName.toLowerCase())) return false;
    if (b.country && COUNTRY_TO_REGION[b.country] && COUNTRY_TO_REGION[b.country] !== 'other') return false;
    return true;
  });

  // Save all files
  for (const [region, filename] of Object.entries(REGION_FILES)) {
    save(filename, regionData[region]);
  }

  process.stdout.write('\n');
  console.log('\n--- Pass 1 Results ---');
  console.log(`  Kept:             ${kept}`);
  console.log(`  Excluded:         ${excluded}`);
  console.log(`  Assigned country: ${assignedCountry}`);
  console.log(`  Still unknown:    ${stillUnknown}`);
  for (const [region, filename] of Object.entries(REGION_FILES)) {
    console.log(`  ${region}: ${regionData[region].length} brands`);
  }
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
```

**Step 2: Test with a small batch**

```bash
node scripts/enrich-pass1.js --limit 50
```

Expected: brands like Rolex, Omega, Seiko printed as EXCLUDE. Known microbrands like Baltic, Sternglas printed as MOVED with country. A few unknowns remain.

**Step 3: Spot-check the output**

```bash
node -e "
const d = require('./data/microbrands-europe.json');
const recent = d.filter(b => b.source === 'MBWDB').slice(0, 5);
recent.forEach(b => console.log(b.brandName, '|', b.country, '|', (b.notes||'').slice(0,60)));
"
```

Expected: MBWDB-sourced brands now have country and a notes snippet.

**Step 4: Commit the script (not data yet)**

```bash
git add scripts/enrich-pass1.js
git commit -m "feat: add enrich-pass1.js — batch Claude classification"
```

---

## Task 4: Run full Pass 1

**Step 1: Run the full Pass 1**

```bash
node scripts/enrich-pass1.js
```

This will take ~2–3 minutes (batches of 50, ~25 batches for 1200+ brands).

**Step 2: Check counts**

```bash
node -e "
const fs = require('fs');
['microbrands-europe','microbrands-americas','microbrands-asia-pacific','microbrands-other']
  .forEach(f => {
    const d = JSON.parse(fs.readFileSync('data/'+f+'.json'));
    const nullC = d.filter(b => !b.country).length;
    console.log(f+': '+d.length+' total, '+nullC+' still null country');
  });"
```

Expected: europe/americas/asia-pacific counts up significantly, other.json shrunk from ~1220 to ~200–400.

**Step 3: Rebuild spreadsheet**

```bash
node scripts/build-spreadsheet.js
```

**Step 4: Commit**

```bash
git add data/
git commit -m "feat: run Pass 1 enrichment — classify and assign countries via Claude"
```

---

## Task 5: enrich-pass2.js

**Files:**
- Create: `scripts/enrich-pass2.js`

**Step 1: Write the script**

```javascript
// scripts/enrich-pass2.js
// Pass 2: For brands in other.json still missing country, fetches their website
// and uses Claude to extract country, city, price range, Instagram, founded year, notes.
// Run: node scripts/enrich-pass2.js
// Run with limit: node scripts/enrich-pass2.js --limit 20

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');
const http      = require('http');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const CONCURRENCY = 5;
const TIMEOUT_MS  = 10000;
const LIMIT       = process.argv.includes('--limit')
  ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10)
  : Infinity;

const REGION_FILES = {
  'europe':       'microbrands-europe.json',
  'americas':     'microbrands-americas.json',
  'asia-pacific': 'microbrands-asia-pacific.json',
  'other':        'microbrands-other.json',
};

const COUNTRY_TO_REGION = {
  'United Kingdom': 'europe', 'France': 'europe', 'Germany': 'europe',
  'Switzerland': 'europe', 'Italy': 'europe', 'Spain': 'europe',
  'Netherlands': 'europe', 'Belgium': 'europe', 'Sweden': 'europe',
  'Denmark': 'europe', 'Norway': 'europe', 'Finland': 'europe',
  'Austria': 'europe', 'Czech Republic': 'europe', 'Hungary': 'europe',
  'Ireland': 'europe', 'Poland': 'europe', 'Portugal': 'europe',
  'Greece': 'europe', 'Romania': 'europe', 'Croatia': 'europe',
  'Slovakia': 'europe', 'Slovenia': 'europe', 'Estonia': 'europe',
  'Latvia': 'europe', 'Lithuania': 'europe', 'Luxembourg': 'europe',
  'Iceland': 'europe', 'Malta': 'europe', 'Serbia': 'europe',
  'USA': 'americas', 'United States': 'americas', 'Canada': 'americas',
  'Brazil': 'americas', 'Argentina': 'americas', 'Mexico': 'americas',
  'Colombia': 'americas', 'Chile': 'americas', 'Peru': 'americas',
  'Uruguay': 'americas',
  'Japan': 'asia-pacific', 'China': 'asia-pacific', 'Singapore': 'asia-pacific',
  'Australia': 'asia-pacific', 'Hong Kong': 'asia-pacific', 'South Korea': 'asia-pacific',
  'Taiwan': 'asia-pacific', 'Malaysia': 'asia-pacific', 'New Zealand': 'asia-pacific',
  'India': 'asia-pacific', 'Thailand': 'asia-pacific', 'Indonesia': 'asia-pacific',
  'Vietnam': 'asia-pacific', 'Philippines': 'asia-pacific',
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

function fetchPage(url) {
  return new Promise((resolve) => {
    let timedOut = false;
    let urlObj;
    try { urlObj = new URL(url); } catch { return resolve(null); }
    const lib = urlObj.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      timeout: TIMEOUT_MS,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WatchDBEnricher/1.0)' }
    }, res => {
      // Follow one redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location).then(resolve);
      }
      let body = '';
      res.on('data', c => { if (body.length < 50000) body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => { timedOut = true; req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{3,}/g, '\n')
    .slice(0, 8000);
}

// Extract instagram handle from raw HTML before stripping
function extractInstagram(html) {
  const m = html.match(/instagram\.com\/([a-zA-Z0-9_.]+)/);
  return m ? m[1].replace(/\/$/, '') : null;
}

async function enrichBrand(client, brand, html) {
  const instagram = extractInstagram(html);
  const text = stripHtml(html);

  const prompt = `You are analysing the website of a watch brand called "${brand.brandName}".

Website content (truncated):
---
${text}
---

Extract the following information. Return ONLY valid JSON, no markdown.

{
  "country": "country where brand is based (standard English name, e.g. United States not USA)",
  "townCity": "city or town name only, or null",
  "foundedYear": number or null,
  "priceRangeLow": lowest watch price in USD as integer or null,
  "priceRangeHigh": highest watch price in USD as integer or null,
  "notes": "1-3 sentences: what the brand makes, their style, movement type, anything distinctive. Factual and concise."
}

Rules:
- If you cannot confidently determine a value, use null
- priceRange: look for prices in the shop/product sections, convert to USD if needed
- country: infer from address, About page, contact details, domain (.de = Germany etc.)
- Do NOT fabricate information`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = message.content[0].text.trim()
    .replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
  const result = JSON.parse(raw);
  if (instagram && !result.instagram) result.instagramHandle = instagram;
  return result;
}

async function run() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const regionData = {};
  for (const [region, filename] of Object.entries(REGION_FILES)) {
    regionData[region] = load(filename);
  }

  const toProcess = regionData['other']
    .filter(b => !b.country && b.website && b.website.startsWith('http'))
    .slice(0, LIMIT);

  const noWebsite = regionData['other'].filter(b => !b.country && (!b.website || !b.website.startsWith('http')));

  console.log(`Pass 2: ${toProcess.length} brands to enrich via website fetch`);
  console.log(`        ${noWebsite.length} brands have no website (will flag for manual review)`);

  // Flag no-website brands
  for (const b of noWebsite) {
    if (!b.notes) b.notes = 'No website — manual review needed';
  }

  let enriched = 0, failed = 0, moved = 0;

  // Process in batches of CONCURRENCY
  for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
    const batch = toProcess.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (brand) => {
      process.stdout.write(`\r  [${i + 1}/${toProcess.length}] ${brand.brandName.slice(0, 30).padEnd(30)}`);
      try {
        const html = await fetchPage(brand.website);
        if (!html) { failed++; return; }

        const result = await enrichBrand(client, brand, html);

        // Apply results back to entry
        if (result.country)        brand.country        = result.country;
        if (result.townCity)       brand.townCity       = result.townCity;
        if (result.foundedYear)    brand.foundedYear    = result.foundedYear;
        if (result.priceRangeLow)  brand.priceRangeLow  = result.priceRangeLow;
        if (result.priceRangeHigh) brand.priceRangeHigh = result.priceRangeHigh;
        if (result.notes)          brand.notes          = result.notes;
        if (result.instagramHandle) brand.instagramHandle = result.instagramHandle;

        enriched++;

        // Move to correct region if country resolved
        if (brand.country) {
          const region = COUNTRY_TO_REGION[brand.country] || 'other';
          if (region !== 'other') {
            regionData[region].push(brand);
            moved++;
          }
        }
      } catch (err) {
        failed++;
        console.log(`\n  ERROR: ${brand.brandName} — ${err.message}`);
      }
    }));
  }

  // Remove moved brands from other.json
  const movedNames = new Set();
  for (const region of ['europe', 'americas', 'asia-pacific']) {
    for (const b of regionData[region]) {
      if (b.source === 'MBWDB') movedNames.add(b.brandName.toLowerCase());
    }
  }
  regionData['other'] = regionData['other'].filter(b =>
    !movedNames.has(b.brandName.toLowerCase()) ||
    !b.country ||
    COUNTRY_TO_REGION[b.country] === 'other' ||
    !COUNTRY_TO_REGION[b.country]
  );

  // Save all
  for (const [region, filename] of Object.entries(REGION_FILES)) {
    save(filename, regionData[region]);
  }

  process.stdout.write('\n');
  console.log('\n--- Pass 2 Results ---');
  console.log(`  Enriched: ${enriched}`);
  console.log(`  Moved to regional file: ${moved}`);
  console.log(`  Failed/no HTML: ${failed}`);
  for (const [region, filename] of Object.entries(REGION_FILES)) {
    console.log(`  ${region}: ${regionData[region].length} brands`);
  }
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
```

**Step 2: Test with a small batch first**

```bash
node scripts/enrich-pass2.js --limit 10
```

Expected: 10 brands fetched, most get country assigned, some moved to regional files.

**Step 3: Spot-check output**

```bash
node -e "
const d = require('./data/microbrands-other.json');
const enriched = d.filter(b => b.country).slice(0,5);
enriched.forEach(b => console.log(b.brandName, '|', b.country, '|', b.priceRangeLow, '-', b.priceRangeHigh));
"
```

**Step 4: Commit the script**

```bash
git add scripts/enrich-pass2.js
git commit -m "feat: add enrich-pass2.js — website enrichment via Claude"
```

---

## Task 6: Run full Pass 2, rebuild, and final commit

**Step 1: Run the full Pass 2**

```bash
node scripts/enrich-pass2.js
```

This will take 5–15 minutes depending on website response times (~200–400 brands, concurrency 5).

**Step 2: Rebuild spreadsheet**

```bash
node scripts/build-spreadsheet.js
```

**Step 3: Check final counts**

```bash
node -e "
const fs = require('fs');
['microbrands-europe','microbrands-americas','microbrands-asia-pacific','microbrands-other']
  .forEach(f => {
    const d = JSON.parse(fs.readFileSync('data/'+f+'.json'));
    const nullC = d.filter(b => !b.country).length;
    const withNotes = d.filter(b => b.notes).length;
    console.log(f+': '+d.length+' brands, '+nullC+' null country, '+withNotes+' with notes');
  });"
```

**Step 4: Push to GitHub**

```bash
git add data/ scripts/enrich-pass2.js
git commit -m "feat: run Pass 2 enrichment — website fetch and Claude extraction"
git push
```
