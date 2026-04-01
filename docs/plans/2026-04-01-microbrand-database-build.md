# Microbrand Database — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the watch-microbrand-database project: JSON source files, build script generating a multi-tab Excel spreadsheet, a seeder that pulls microbrand candidates from the existing 438-brand DB, an MBWDB import script, a website health checker, and a README.

**Architecture:** Four regional JSON files (`data/microbrands-*.json`) are the source of truth. `scripts/build-spreadsheet.js` reads them and writes `watch-microbrand-database.xlsx` with five tabs (Europe, Americas, Asia-Pacific, Other, Summary). One-shot seeder scripts populate the JSON files.

**Tech Stack:** Node.js, `xlsx` npm package (^0.18.5), `https`/`http` built-ins, no other dependencies.

**Project root:** `C:/Users/hamis/OneDrive/Coding/watch-microbrand-database/`

**Existing DB path:** `C:/Users/hamis/OneDrive/Coding/watch-brand-location-database/data/`

---

## Schema Reference

Every entry in every regional JSON file must conform to:

```json
{
  "brandName": "Studio Underd0g",
  "country": "United Kingdom",
  "townCity": "Brighton",
  "foundedYear": 2020,
  "priceRangeLow": 250,
  "priceRangeHigh": 350,
  "status": "Active",
  "latestModel": "Go-Anywhere",
  "lastActivityDate": "2026-01-01",
  "website": "https://www.studiounderd0g.com",
  "instagramHandle": "studiounderd0g",
  "source": "existing-db",
  "notes": ""
}
```

Nullable fields (`townCity`, `foundedYear`, `priceRangeLow`, `priceRangeHigh`, `latestModel`, `lastActivityDate`, `instagramHandle`, `notes`) should use `null` when unknown.

**Status values:** `Active` / `Dormant` / `Defunct`
**Source values:** `MBWDB` / `existing-db` / `manual`

---

## Task 1: package.json and xlsx dependency

**Files:**
- Create: `package.json`

**Step 1: Create package.json**

```json
{
  "dependencies": {
    "xlsx": "^0.18.5"
  }
}
```

**Step 2: Install dependencies**

```bash
cd "C:/Users/hamis/OneDrive/Coding/watch-microbrand-database"
npm install
```

Expected: `node_modules/` created, `package-lock.json` created.

**Step 3: Verify xlsx loads**

```bash
node -e "const X = require('./node_modules/xlsx'); console.log('xlsx ok:', X.version);"
```

Expected: prints `xlsx ok: 0.18.x`

**Step 4: Create .gitignore**

```
node_modules/
*.xlsx
```

**Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "build: add package.json and xlsx dependency"
```

---

## Task 2: build-spreadsheet.js

**Files:**
- Create: `scripts/build-spreadsheet.js`

**Step 1: Write the script**

```javascript
// scripts/build-spreadsheet.js
// Generates watch-microbrand-database.xlsx from all data/*.json files

const XLSX = require('../node_modules/xlsx');
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT   = path.join(__dirname, '..', 'watch-microbrand-database.xlsx');

const REGIONS = [
  { file: 'microbrands-europe',       tab: 'Europe'       },
  { file: 'microbrands-americas',     tab: 'Americas'     },
  { file: 'microbrands-asia-pacific', tab: 'Asia-Pacific' },
  { file: 'microbrands-other',        tab: 'Other'        },
];

const HEADERS = [
  'Brand Name', 'Country', 'Town/City', 'Founded', 'Price Low (USD)',
  'Price High (USD)', 'Status', 'Latest Model', 'Last Activity',
  'Website', 'Instagram', 'Source', 'Notes'
];

const COL_WIDTHS = [30, 18, 18, 10, 15, 15, 10, 25, 14, 35, 22, 12, 50];

function loadJSON(filename) {
  const filepath = path.join(DATA_DIR, filename + '.json');
  if (!fs.existsSync(filepath)) return [];
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

function toRow(b) {
  return [
    b.brandName        || '',
    b.country          || '',
    b.townCity         || '',
    b.foundedYear      ?? '',
    b.priceRangeLow    ?? '',
    b.priceRangeHigh   ?? '',
    b.status           || '',
    b.latestModel      || '',
    b.lastActivityDate || '',
    b.website          || '',
    b.instagramHandle  || '',
    b.source           || '',
    b.notes            || '',
  ];
}

function makeSheet(data) {
  const sorted = [...data].sort((a, b) =>
    a.brandName.localeCompare(b.brandName, 'en', { sensitivity: 'base' })
  );
  const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...sorted.map(toRow)]);
  ws['!cols'] = COL_WIDTHS.map(w => ({ wch: w }));
  return ws;
}

const wb = XLSX.utils.book_new();
const allBrands = [];

for (const { file, tab } of REGIONS) {
  const data = loadJSON(file);
  allBrands.push(...data);
  XLSX.utils.book_append_sheet(wb, makeSheet(data), tab);
  console.log(`  ${tab.padEnd(15)} ${data.length} brands`);
}

// --- Summary tab ---
const byCountry = {};
for (const b of allBrands) {
  byCountry[b.country] = (byCountry[b.country] || 0) + 1;
}
const countryRows = Object.entries(byCountry)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([c, n]) => [c, n]);

const statusCounts = ['Active', 'Dormant', 'Defunct'].map(s => [
  s, allBrands.filter(b => b.status === s).length
]);

const summaryData = [
  ['Watch Microbrand Database', ''],
  ['Last Updated', new Date().toISOString().split('T')[0]],
  ['', ''],
  ['Region', 'Total Brands'],
  ...REGIONS.map(r => [r.tab, loadJSON(r.file).length]),
  ['TOTAL', allBrands.length],
  ['', ''],
  ['Country', 'Count'],
  ...countryRows,
  ['', ''],
  ['Status', 'Count'],
  ...statusCounts,
];

const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
summarySheet['!cols'] = [{ wch: 25 }, { wch: 15 }];
XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');

XLSX.writeFile(wb, OUTPUT);
console.log('\nBuilt: ' + OUTPUT);
console.log('Total brands: ' + allBrands.length);
```

**Step 2: Run the build script against the empty data files**

```bash
cd "C:/Users/hamis/OneDrive/Coding/watch-microbrand-database"
node scripts/build-spreadsheet.js
```

Expected output:
```
  Europe          0 brands
  Americas        0 brands
  Asia-Pacific    0 brands
  Other           0 brands

Built: ...watch-microbrand-database.xlsx
Total brands: 0
```

The xlsx file is created (even if empty). Check it opens in Excel with the correct tabs.

**Step 3: Commit**

```bash
git add scripts/build-spreadsheet.js
git commit -m "feat: add build-spreadsheet.js — JSON to Excel build script"
```

---

## Task 3: seed-from-existing-db.js

This one-shot script reads the 438-brand location database, identifies microbrand candidates, and writes them into the correct regional JSON files.

**Microbrand candidates from the existing DB are brands where:**
- `tier` is `"Independent"` (not High Horology, Luxury, Mass Luxury, or Clockmaker)
- No group ownership noted in the brand name or notes

**Files:**
- Create: `scripts/seed-from-existing-db.js`

**Step 1: Write the script**

```javascript
// scripts/seed-from-existing-db.js
// One-shot: extracts Independent-tier brands from the 438-brand location DB
// and seeds them into the microbrand database regional files.
// Run once: node scripts/seed-from-existing-db.js

const fs   = require('fs');
const path = require('path');

const SRC_DIR  = 'C:/Users/hamis/OneDrive/Coding/watch-brand-location-database/data';
const DEST_DIR = path.join(__dirname, '..', 'data');

// Source files and country mapping
const SOURCES = [
  { file: 'uk.json',          country: 'United Kingdom', region: 'europe'       },
  { file: 'france.json',      country: 'France',         region: 'europe'       },
  { file: 'germany.json',     country: 'Germany',        region: 'europe'       },
  { file: 'switzerland.json', country: 'Switzerland',    region: 'europe'       },
  { file: 'usa.json',         country: 'USA',            region: 'americas'     },
  { file: 'japan.json',       country: 'Japan',          region: 'asia-pacific' },
  { file: 'other.json',       country: null,             region: null           }, // mixed
];

// Region file names
const REGION_FILES = {
  'europe':       'microbrands-europe.json',
  'americas':     'microbrands-americas.json',
  'asia-pacific': 'microbrands-asia-pacific.json',
  'other':        'microbrands-other.json',
};

// "Other" country → region mapping
const COUNTRY_TO_REGION = {
  'Netherlands':    'europe',
  'Belgium':        'europe',
  'Sweden':         'europe',
  'Denmark':        'europe',
  'Ireland':        'europe',
  'Spain':          'europe',
  'Italy':          'europe',
  'Czech Republic': 'europe',
  'Hungary':        'europe',
  'Austria':        'europe',
  'Malaysia':       'asia-pacific',
  'China':          'asia-pacific',
  'Singapore':      'asia-pacific',
  'Australia':      'asia-pacific',
};

function load(filepath) {
  if (!fs.existsSync(filepath)) return [];
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

function save(filename, data) {
  data.sort((a, b) =>
    a.brandName.localeCompare(b.brandName, 'en', { sensitivity: 'base' })
  );
  fs.writeFileSync(
    path.join(DEST_DIR, filename),
    JSON.stringify(data, null, 2),
    'utf8'
  );
}

function makeEntry(brand, country) {
  return {
    brandName:        brand.brandName,
    country:          country,
    townCity:         brand.townCity || null,
    foundedYear:      null,
    priceRangeLow:    null,
    priceRangeHigh:   null,
    status:           'Active',
    latestModel:      null,
    lastActivityDate: null,
    website:          brand.website  || null,
    instagramHandle:  null,
    source:           'existing-db',
    notes:            brand.notes    || null,
  };
}

// Load destination files
const dest = {};
for (const [key, filename] of Object.entries(REGION_FILES)) {
  dest[key] = load(path.join(DEST_DIR, filename));
}

function alreadyExists(region, brandName) {
  return dest[region].some(
    b => b.brandName.toLowerCase() === brandName.toLowerCase()
  );
}

let added = 0;
let skipped = 0;

for (const { file, country, region } of SOURCES) {
  const brands = load(path.join(SRC_DIR, file));

  for (const brand of brands) {
    if (brand.tier !== 'Independent') continue;

    let resolvedCountry = country;
    let resolvedRegion  = region;

    // For other.json: parse country from townCity ("City, Country" format)
    if (!country) {
      const parts = (brand.townCity || '').split(',');
      resolvedCountry = parts.length > 1 ? parts[parts.length - 1].trim() : 'Unknown';
      resolvedRegion  = COUNTRY_TO_REGION[resolvedCountry] || 'other';
    }

    if (alreadyExists(resolvedRegion, brand.brandName)) {
      console.log(`  SKIP (exists): ${brand.brandName}`);
      skipped++;
      continue;
    }

    dest[resolvedRegion].push(makeEntry(brand, resolvedCountry));
    console.log(`  ADDED [${resolvedRegion}]: ${brand.brandName} (${resolvedCountry})`);
    added++;
  }
}

// Save all
for (const [key, filename] of Object.entries(REGION_FILES)) {
  save(filename, dest[key]);
}

console.log(`\nDone. Added: ${added}, Skipped: ${skipped}`);
```

**Step 2: Run the seeder**

```bash
node scripts/seed-from-existing-db.js
```

Expected: brands like Studio Underd0g, Baltic, Serica, Ming, Ressence, Czapek, Formex printed as ADDED.

**Step 3: Verify counts**

```bash
node -e "
const fs = require('fs');
['microbrands-europe','microbrands-americas','microbrands-asia-pacific','microbrands-other']
  .forEach(f => {
    const d = JSON.parse(fs.readFileSync('data/'+f+'.json'));
    console.log(f + ': ' + d.length);
  });"
```

**Step 4: Rebuild the spreadsheet**

```bash
node scripts/build-spreadsheet.js
```

**Step 5: Commit**

```bash
git add data/ scripts/seed-from-existing-db.js
git commit -m "feat: seed microbrand DB from existing 438-brand location database"
```

---

## Task 4: import-mbwdb.js

Fetches brand listings from mbwdb.com and adds brands not already present.

**Note:** MBWDB does not provide country, price, or city data — those fields will be `null` after import. The script fetches individual brand pages to get the website URL and status.

**Files:**
- Create: `scripts/import-mbwdb.js`

**Step 1: Write the script**

```javascript
// scripts/import-mbwdb.js
// Fetches the MBWDB brand list and adds new microbrand entries.
// Only imports categories: Microbrand, Microbrand (Legacy)
// Run: node scripts/import-mbwdb.js
// Run with limit: node scripts/import-mbwdb.js --limit 50

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LIMIT    = process.argv.includes('--limit')
  ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10)
  : Infinity;

// All region files — we'll add to 'other' by default since MBWDB has no country data
// Manual country assignment happens later via direct JSON edits
const DEST_FILE = path.join(DATA_DIR, 'microbrands-other.json');

function fetch(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WatchDBImporter/1.0)' }
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Extract brand links from a category page
function extractBrandLinks(html) {
  const links = [];
  const re = /href="(https:\/\/mbwdb\.com\/brands\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!links.includes(m[1])) links.push(m[1]);
  }
  return links;
}

// Extract brand details from an individual brand page
function extractBrandDetails(html, url) {
  const name    = (html.match(/<h1[^>]*>([^<]+)<\/h1>/) || [])[1]?.trim() || '';
  const website = (html.match(/href="(https?:\/\/(?!mbwdb\.com)[^"]+)"[^>]*>[Ww]ebsite/) ||
                   html.match(/Website[^<]*<\/[^>]+>[^<]*<a href="(https?:\/\/(?!mbwdb\.com)[^"]+)"/) ||
                   [])[1] || '';
  const isActive   = /Status[^<]*Active/i.test(html);
  const isInactive = /Status[^<]*Inactive/i.test(html);
  const status = isInactive ? 'Dormant' : 'Active';
  return { name, website, status };
}

async function run() {
  // Load destination
  let dest = [];
  if (fs.existsSync(DEST_FILE)) {
    dest = JSON.parse(fs.readFileSync(DEST_FILE, 'utf8'));
  }

  const existingNames = new Set(dest.map(b => b.brandName.toLowerCase()));

  // Fetch the microbrand category page (paginated)
  console.log('Fetching MBWDB brand list...');
  const { body: catPage } = await fetch('https://mbwdb.com/category/microbrand/');
  const brandLinks = extractBrandLinks(catPage);
  console.log(`Found ${brandLinks.length} brand links on page 1`);

  let processed = 0;
  let added     = 0;

  for (const link of brandLinks) {
    if (processed >= LIMIT) break;
    processed++;

    try {
      await sleep(300); // polite crawl delay
      const { body } = await fetch(link);
      const { name, website, status } = extractBrandDetails(body, link);

      if (!name) {
        console.log(`  SKIP (no name): ${link}`);
        continue;
      }

      if (existingNames.has(name.toLowerCase())) {
        process.stdout.write('.');
        continue;
      }

      const entry = {
        brandName:        name,
        country:          null,   // to be filled manually
        townCity:         null,
        foundedYear:      null,
        priceRangeLow:    null,
        priceRangeHigh:   null,
        status,
        latestModel:      null,
        lastActivityDate: null,
        website:          website || null,
        instagramHandle:  null,
        source:           'MBWDB',
        notes:            null,
      };

      dest.push(entry);
      existingNames.add(name.toLowerCase());
      added++;
      console.log(`\n  ADDED: ${name}`);
    } catch (err) {
      console.log(`\n  ERROR: ${link} — ${err.message}`);
    }
  }

  // Save
  dest.sort((a, b) => (a.brandName || '').localeCompare(b.brandName || '', 'en', { sensitivity: 'base' }));
  fs.writeFileSync(DEST_FILE, JSON.stringify(dest, null, 2), 'utf8');
  console.log(`\nDone. Added ${added} new brands. Total in other.json: ${dest.length}`);
  console.log('NOTE: Country field is null for all MBWDB imports — assign manually or via follow-up research.');
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
```

**Step 2: Test with a small batch first (--limit 10)**

```bash
node scripts/import-mbwdb.js --limit 10
```

Expected: up to 10 brands added to `data/microbrands-other.json` with `source: "MBWDB"` and `country: null`.

**Step 3: Inspect the output**

```bash
node -e "const d=require('./data/microbrands-other.json'); d.slice(0,5).forEach(b=>console.log(b.brandName, b.website, b.status, b.source));"
```

Verify brand names and websites look plausible.

**Step 4: Commit the script (not the data yet — run the full import in Task 5)**

```bash
git add scripts/import-mbwdb.js
git commit -m "feat: add MBWDB import script"
```

---

## Task 5: Run full MBWDB import and rebuild

**Step 1: Run the full import**

```bash
node scripts/import-mbwdb.js
```

This will take several minutes (300ms delay per brand, ~300-500 brands on the first page). Let it run.

**Step 2: Rebuild spreadsheet**

```bash
node scripts/build-spreadsheet.js
```

**Step 3: Check totals look sensible**

```bash
node -e "
const fs = require('fs');
['microbrands-europe','microbrands-americas','microbrands-asia-pacific','microbrands-other']
  .forEach(f => {
    const d = JSON.parse(fs.readFileSync('data/'+f+'.json'));
    const nullCountry = d.filter(b => !b.country).length;
    console.log(f + ': ' + d.length + ' entries, ' + nullCountry + ' with null country');
  });"
```

**Step 4: Commit seeded data**

```bash
git add data/
git commit -m "feat: seed microbrand DB from MBWDB import"
```

---

## Task 6: check-websites.js

Adapted from the location database. Identical logic, different data files.

**Files:**
- Create: `scripts/check-websites.js`

**Step 1: Write the script**

```javascript
// scripts/check-websites.js
// Checks every website URL in the microbrand database and reports status.
// Usage: node scripts/check-websites.js
//        node scripts/check-websites.js --errors-only

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const ERRORS_ONLY = process.argv.includes('--errors-only');
const TIMEOUT_MS  = 8000;
const CONCURRENCY = 10;

const DATA_FILES = [
  { file: 'microbrands-europe',       region: 'Europe'       },
  { file: 'microbrands-americas',     region: 'Americas'     },
  { file: 'microbrands-asia-pacific', region: 'Asia-Pacific' },
  { file: 'microbrands-other',        region: 'Other'        },
];

const C = {
  reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m',  grey: '\x1b[90m',  bold: '\x1b[1m', cyan: '\x1b[36m',
};

function colour(text, ...codes) { return codes.join('') + text + C.reset; }

function loadAllBrands() {
  const brands = [];
  for (const { file, region } of DATA_FILES) {
    const filepath = path.join(DATA_DIR, file + '.json');
    if (!fs.existsSync(filepath)) continue;
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    for (const brand of data) {
      brands.push({ ...brand, _region: region, _file: file });
    }
  }
  return brands;
}

function probe(url) {
  return new Promise((resolve) => {
    let timedOut = false;
    function attempt(method) {
      let urlObj;
      try { urlObj = new URL(url); } catch { return resolve({ status: 'INVALID_URL', code: null }); }
      const lib = urlObj.protocol === 'https:' ? https : http;
      const options = {
        hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search,
        method, timeout: TIMEOUT_MS,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WatchDBChecker/1.0)' },
      };
      const req = lib.request(options, (res) => {
        res.destroy();
        const code = res.statusCode;
        if (method === 'HEAD' && code === 405) return attempt('GET');
        if (code >= 200 && code < 300) return resolve({ status: 'OK', code });
        if (code >= 300 && code < 400) return resolve({ status: 'REDIRECT', code, location: res.headers.location });
        if (code >= 400 && code < 500) return resolve({ status: 'CLIENT_ERR', code });
        return resolve({ status: 'SERVER_ERR', code });
      });
      req.on('timeout', () => { timedOut = true; req.destroy(); resolve({ status: 'TIMEOUT', code: null }); });
      req.on('error', (err) => {
        if (timedOut) return;
        if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return resolve({ status: 'DOMAIN_NOT_FOUND', code: null });
        if (err.code === 'ECONNREFUSED') return resolve({ status: 'CONN_REFUSED', code: null });
        resolve({ status: 'ERROR', code: null, detail: err.code });
      });
      req.end();
    }
    attempt('HEAD');
  });
}

async function checkAll(brands) {
  const withUrls = brands.filter(b => b.website && b.website.trim() !== '');
  const noUrls   = brands.filter(b => !b.website || b.website.trim() === '');
  console.log(colour('\nWatch Microbrand Database — Website Health Check', C.bold));
  console.log(`Checking ${withUrls.length} URLs...`);
  if (noUrls.length > 0) console.log(colour(`${noUrls.length} entries have no URL (skipped)`, C.grey));
  console.log('');
  const results = [];
  let checked = 0;
  for (let i = 0; i < withUrls.length; i += CONCURRENCY) {
    const batch = withUrls.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(batch.map(async (brand) => {
      const result = await probe(brand.website);
      checked++;
      process.stdout.write(`\r  Checking: ${checked}/${withUrls.length}   `);
      return { brand, result };
    }));
    results.push(...settled);
  }
  process.stdout.write('\r' + ' '.repeat(40) + '\r');
  return { results, noUrls };
}

function statusLabel(r) {
  switch (r.status) {
    case 'OK':            return colour(`✓ ${r.code}`, C.green);
    case 'REDIRECT':      return colour(`→ ${r.code}${r.location ? ' → ' + r.location : ''}`, C.yellow);
    case 'CLIENT_ERR':    return colour(`✗ ${r.code} Client Error`, C.red);
    case 'SERVER_ERR':    return colour(`✗ ${r.code} Server Error`, C.red);
    case 'TIMEOUT':       return colour(`⏱ Timeout`, C.yellow);
    case 'DOMAIN_NOT_FOUND': return colour(`✗ Domain not found`, C.red);
    case 'CONN_REFUSED':  return colour(`✗ Connection refused`, C.red);
    case 'INVALID_URL':   return colour(`✗ Invalid URL`, C.red);
    default:              return colour(`✗ ${r.status}`, C.red);
  }
}

(async () => {
  const brands = loadAllBrands();
  const { results, noUrls } = await checkAll(brands);

  let ok = 0, problems = 0, redirects = 0;
  const problemList = [], redirectList = [];
  for (const { brand, result } of results) {
    if (result.status === 'OK') ok++;
    else if (result.status === 'REDIRECT') { redirects++; redirectList.push({ brand, result }); }
    else { problems++; problemList.push({ brand, result }); }
  }

  if (!ERRORS_ONLY) {
    const byRegion = {};
    for (const { brand, result } of results) {
      if (!byRegion[brand._region]) byRegion[brand._region] = [];
      byRegion[brand._region].push({ brand, result });
    }
    for (const [region, entries] of Object.entries(byRegion)) {
      console.log(colour(region, C.bold + C.cyan));
      for (const { brand, result } of entries) {
        console.log(`  ${brand.brandName.padEnd(35)} ${statusLabel(result)}`);
      }
      console.log('');
    }
  }

  console.log(colour('─'.repeat(60), C.grey));
  console.log(colour('Summary', C.bold));
  console.log(colour(`  ✓ OK:        ${ok}`, C.green));
  if (redirects > 0) console.log(colour(`  → Redirects: ${redirects}`, C.yellow));
  if (problems > 0)  console.log(colour(`  ✗ Problems:  ${problems}`, C.red));
  if (noUrls.length > 0) console.log(colour(`  — No URL:    ${noUrls.length}`, C.grey));
  console.log('');

  if (problemList.length > 0) {
    console.log(colour('Problems:', C.bold + C.red));
    for (const { brand, result } of problemList) {
      console.log(`  ${colour(brand.brandName, C.bold)} (${brand.country || 'unknown'})`);
      console.log(`    ${colour(brand.website, C.grey)}`);
      console.log(`    ${statusLabel(result)}`);
    }
  }
})();
```

**Step 2: Run against the seeded data**

```bash
node scripts/check-websites.js --errors-only
```

**Step 3: Commit**

```bash
git add scripts/check-websites.js
git commit -m "feat: add check-websites.js health checker"
```

---

## Task 7: README.md

**Files:**
- Create: `README.md`

**Step 1: Write the README**

```markdown
# Watch Microbrand Database

A monitoring database of microbrand and startup watch brands from around the world.

Companion to the [watch-brand-location-database](../watch-brand-location-database) (luxury/independent ateliers for tour visits).

---

## Purpose

- Outreach for The Watch Collectors' Club watch shows (UK)
- Monitor brand activity and status over time
- Track the global microbrand landscape

---

## File

`watch-microbrand-database.xlsx`

---

## Spreadsheet Structure

### Regional Tabs

One tab per region. Each row is one brand.

| Column | Meaning |
|--------|---------|
| Brand Name | Official brand name |
| Country | Country of origin |
| Town/City | Workshop/studio city |
| Founded | Year established |
| Price Low (USD) | Lowest current model price |
| Price High (USD) | Highest current model price |
| Status | Active / Dormant / Defunct |
| Latest Model | Most recent watch name/ref |
| Last Activity | Date of last confirmed activity |
| Website | Official website |
| Instagram | Handle (without @) |
| Source | MBWDB / existing-db / manual |
| Notes | Anything relevant |

**Regions:** Europe · Americas · Asia-Pacific · Other

### Summary Tab

Counts by region, country, and status. Last updated date.

---

## Status Definitions

| Status | Meaning |
|--------|---------|
| Active | Confirmed selling watches in the last 12 months |
| Dormant | No activity for 12+ months, not confirmed closed |
| Defunct | Website down, socials dead, no activity for 2+ years |

---

## Constraints

- Price ceiling: under $5,000 USD
- Kickstarter delivery must be complete before inclusion
- Watches must be actively for sale or have been sold
- No group-owned / conglomerate brands

---

## How to Update

1. Edit JSON files in `data/`
2. Sort entries alphabetically by `brandName`
3. Run `node scripts/build-spreadsheet.js` to rebuild the Excel file
4. Commit both JSON changes and rebuilt spreadsheet

**To check for defunct websites:**
```
node scripts/check-websites.js               # full report
node scripts/check-websites.js --errors-only  # problems only
```

---

## Scripts

| Script | Purpose |
|--------|---------|
| `build-spreadsheet.js` | Regenerate Excel from JSON files |
| `seed-from-existing-db.js` | One-shot: seed from 438-brand location DB |
| `import-mbwdb.js` | One-shot: import from mbwdb.com |
| `check-websites.js` | Health-check all website URLs |

---

## Version History

| Version | Date | Notes |
|---------|------|-------|
| 1.0 | 2026-04-01 | Initial build. Seeded from existing location DB (Independent tier) + MBWDB import. |
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README for microbrand database v1.0"
```

---

## Task 8: Final build and verify

**Step 1: Run full build from scratch**

```bash
cd "C:/Users/hamis/OneDrive/Coding/watch-microbrand-database"
node scripts/build-spreadsheet.js
```

**Step 2: Check git status is clean**

```bash
git status
```

Expected: only `watch-microbrand-database.xlsx` is untracked (it's in `.gitignore`).

**Step 3: Final commit of any remaining changes**

```bash
git add -A
git status  # verify nothing unexpected
git commit -m "build: final v1.0 build — microbrand database complete"
```
