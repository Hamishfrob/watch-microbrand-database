# find-locations-brave.js Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build `scripts/find-locations-brave.js` — uses Brave Search snippets + Claude Haiku to find and correct country/city data across all four region files, while also enriching any other schema fields revealed by the snippets.

**Architecture:** For each brand missing a country (or all brands with `--force-location`), search Brave for `"{BrandName} watches"`, pass the top 5 result snippets to Haiku for full-schema extraction, fall back to `"{BrandName} watches review"` if country is still null, then write results back to the JSON file. No extra page fetches — snippets come free in the Brave JSON response.

**Tech Stack:** Node.js, Brave Search API (BRAVE_API_KEY in .env), @anthropic-ai/sdk (claude-haiku-4-5), dotenv

---

### Task 1: Scaffold the script with CLI flags and file I/O

**Files:**
- Create: `scripts/find-locations-brave.js`

**Step 1: Create the file with header comment, imports, CLI flag parsing, and load/save helpers**

```js
// scripts/find-locations-brave.js
//
// Uses Brave Search snippets + Claude Haiku to find/correct country and city
// data across all four region files, and enriches any other fields the
// snippets reveal.
//
// Approach:
//   1. Search Brave for "{BrandName} watches" — take top 5 result snippets
//   2. Pass snippets to Haiku — extract all schema fields
//   3. If country still null: fallback search "{BrandName} watches review"
//   4. Write non-null extracted fields back to JSON
//
// ⚠️  Run with --limit 3 first. Check console.anthropic.com after. Get
//     cost sign-off before a full run. Brave free tier = 2,000 queries/month.
//
// Flags:
//   --region europe|americas|asia-pacific|other  (default: all four)
//   --limit N                                    (default: unlimited)
//   --force-location                             (overwrite country/townCity even if set)
//   --force                                      (overwrite all fields)

'use strict';
require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const MODEL       = 'claude-haiku-4-5';
const CONCURRENCY = 3;   // stay within Brave rate limits
const DELAY_MS    = 400; // ms between Brave requests

const LIMIT = process.argv.includes('--limit')
  ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10)
  : Infinity;

const REGION_ARG = process.argv.includes('--region')
  ? process.argv[process.argv.indexOf('--region') + 1]
  : null;

const FORCE          = process.argv.includes('--force');
const FORCE_LOCATION = process.argv.includes('--force-location');

const REGION_FILES = {
  'europe':       'microbrands-europe.json',
  'americas':     'microbrands-americas.json',
  'asia-pacific': 'microbrands-asia-pacific.json',
  'other':        'microbrands-other.json',
};

if (REGION_ARG && !REGION_FILES[REGION_ARG]) {
  console.error(`Unknown region: "${REGION_ARG}". Valid: ${Object.keys(REGION_FILES).join(', ')}`);
  process.exit(1);
}

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
```

**Step 2: Verify the file parses without errors**

```bash
node -e "require('./scripts/find-locations-brave.js')" 2>&1 | head -5
```

Expected: process exits (no `run()` yet) with no syntax errors.

**Step 3: Commit**

```bash
git add scripts/find-locations-brave.js
git commit -m "feat: scaffold find-locations-brave.js with CLI flags and I/O helpers"
```

---

### Task 2: Add Brave search helper

**Files:**
- Modify: `scripts/find-locations-brave.js`

**Step 1: Add the Brave search function after the save() helper**

```js
let braveQueryCount = 0;

async function searchBrave(query) {
  braveQueryCount++;
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&search_lang=en`;
  const res = await fetch(url, {
    headers: {
      'Accept':               'application/json',
      'Accept-Encoding':      'gzip',
      'X-Subscription-Token': process.env.BRAVE_API_KEY,
    },
  });
  if (!res.ok) {
    if (res.status === 429) throw new Error('Rate limited by Brave API');
    throw new Error(`Brave API error: ${res.status}`);
  }
  const data = await res.json();
  // Return array of { title, description, url } from top results
  return (data?.web?.results || []).slice(0, 5).map(r => ({
    title:       r.title       || '',
    description: r.description || '',
    url:         r.url         || '',
  }));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

**Step 2: Manually verify Brave is reachable (will fail if key missing)**

```bash
node -e "
require('dotenv').config();
const {searchBrave} = require('./scripts/find-locations-brave.js');
" 2>&1 | head -3
```

Expected: no crash (searchBrave not exported yet — this just confirms syntax).

**Step 3: Commit**

```bash
git add scripts/find-locations-brave.js
git commit -m "feat: add Brave search helper with query counter"
```

---

### Task 3: Add Haiku extraction

**Files:**
- Modify: `scripts/find-locations-brave.js`

**Step 1: Add the extraction schema constant and extractFromSnippets() function**

```js
const EXTRACT_SCHEMA = `{
  "country": "Germany",              // full country name in English, or null
  "townCity": "Hamburg",             // city/town the brand is based in, or null
  "instagramHandle": "...",          // username without @, or null
  "priceRangeLow": 350,              // lowest current USD price as integer, or null
  "priceRangeHigh": 650,             // highest current USD price as integer, or null
  "foundedYear": 2017,               // year brand was founded as integer, or null
  "latestModel": "...",              // most recent or featured model name, or null
  "status": "Active",                // "Active" | "Dormant" | "Defunct" | null
  "lastActivityDate": "2024-10-01",  // ISO YYYY-MM-DD of last confirmed activity, or null
  "notes": "..."                     // 1-3 factual sentences: founding, style, movements, location. null if uncertain.
}`;

async function extractFromSnippets(client, brandName, snippets) {
  if (!snippets.length) return null;

  const snippetText = snippets
    .map((s, i) => `Result ${i + 1}: ${s.title}\n${s.description}\n${s.url}`)
    .join('\n\n');

  const userMessage = `Extract data for the watch brand "${brandName}" from these search result snippets.

${snippetText}

Return ONLY valid JSON — no markdown, no explanation:
${EXTRACT_SCHEMA}

Rules:
- Only return values you are confident about from the snippets — never guess
- Prices must be USD integers — convert if needed
- If the snippets don't clearly indicate a field, return null for it
- Notes: "German microbrand founded in 2014. Known for field watches. Based in Hamburg."`;

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
```

**Step 2: Syntax check**

```bash
node --check scripts/find-locations-brave.js
```

Expected: no output (clean parse).

**Step 3: Commit**

```bash
git add scripts/find-locations-brave.js
git commit -m "feat: add Haiku snippet extraction with full schema"
```

---

### Task 4: Add per-brand processor and field merge logic

**Files:**
- Modify: `scripts/find-locations-brave.js`

**Step 1: Add needsWork() and processBrand()**

```js
function needsWork(brand) {
  if (FORCE) return true;
  if (FORCE_LOCATION) return true; // re-check all brands for location correction
  return !brand.country;           // default: only brands missing country
}

async function processBrand(client, brand, filename, data) {
  // Primary search
  let snippets = [];
  try {
    snippets = await searchBrave(`"${brand.brandName}" watches`);
  } catch (err) {
    if (err.message.includes('Rate limited')) {
      console.error('\nRate limited — waiting 15s...');
      await sleep(15_000);
    }
    return 'error';
  }

  let extracted = await extractFromSnippets(client, brand.brandName, snippets);

  // Fallback search if no country found
  if (!extracted?.country) {
    await sleep(DELAY_MS);
    try {
      const fallbackSnippets = await searchBrave(`"${brand.brandName}" watches review`);
      const fallbackExtracted = await extractFromSnippets(client, brand.brandName, fallbackSnippets);
      // Merge: prefer fallback values only where primary had null
      if (fallbackExtracted) {
        extracted = extracted || {};
        for (const [k, v] of Object.entries(fallbackExtracted)) {
          if (v != null && extracted[k] == null) extracted[k] = v;
        }
      }
    } catch { /* fallback failure is non-fatal */ }
  }

  if (!extracted) return 'no-data';

  const FIELDS = [
    'country', 'townCity', 'instagramHandle',
    'priceRangeLow', 'priceRangeHigh',
    'foundedYear', 'latestModel',
    'status', 'lastActivityDate', 'notes',
  ];

  const locationFields = new Set(['country', 'townCity']);
  const isUnknownNotes = brand.notes === 'Unknown brand — manual review needed';
  let changed = false;

  for (const f of FIELDS) {
    const forceThis = FORCE
      || (FORCE_LOCATION && locationFields.has(f))
      || (isUnknownNotes && f === 'notes');
    if (extracted[f] != null && (brand[f] == null || forceThis)) {
      brand[f] = extracted[f];
      changed = true;
    }
  }

  if (changed) save(filename, data);
  return extracted.country ? 'done' : 'no-location';
}
```

**Step 2: Syntax check**

```bash
node --check scripts/find-locations-brave.js
```

Expected: no output.

**Step 3: Commit**

```bash
git add scripts/find-locations-brave.js
git commit -m "feat: add per-brand processor with primary+fallback search and field merge"
```

---

### Task 5: Add concurrency pool and main entry point

**Files:**
- Modify: `scripts/find-locations-brave.js`

**Step 1: Add runPool() and the run() entry point**

```js
async function runPool(tasks, concurrency) {
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      await tasks[idx++]();
      await sleep(DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

async function run() {
  if (!process.env.BRAVE_API_KEY) {
    console.error('Error: BRAVE_API_KEY not set in .env');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const regions = REGION_ARG ? { [REGION_ARG]: REGION_FILES[REGION_ARG] } : REGION_FILES;

  let totalDone = 0, totalNoLocation = 0, totalNoData = 0, totalErrors = 0;
  const fieldCounts = {};

  for (const [region, filename] of Object.entries(regions)) {
    const data      = load(filename);
    const toProcess = data.filter(needsWork).slice(0, LIMIT);

    if (toProcess.length === 0) {
      console.log(`\n${region}: nothing to process`);
      continue;
    }

    console.log(`\n${region}: processing ${toProcess.length} brands...`);
    let done = 0;

    const tasks = toProcess.map(brand => async () => {
      const result = await processBrand(client, brand, filename, data);
      done++;
      process.stdout.write(
        `\r  ${String(done).padStart(4)}/${toProcess.length} — ${brand.brandName.slice(0, 30).padEnd(30)} [${result}]`
      );
      if      (result === 'done')        totalDone++;
      else if (result === 'no-location') totalNoLocation++;
      else if (result === 'no-data')     totalNoData++;
      else                               totalErrors++;
    });

    await runPool(tasks, CONCURRENCY);
    console.log('');
  }

  console.log('\n--- find-locations-brave Results ---');
  console.log(`  Located:      ${totalDone}`);
  console.log(`  No location:  ${totalNoLocation}`);
  console.log(`  No data:      ${totalNoData}`);
  console.log(`  Errors:       ${totalErrors}`);
  console.log(`  Brave queries used: ${braveQueryCount}`);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
```

**Step 2: Full syntax check**

```bash
node --check scripts/find-locations-brave.js
```

Expected: no output.

**Step 3: Commit**

```bash
git add scripts/find-locations-brave.js
git commit -m "feat: add runPool and run() entry point — script complete"
```

---

### Task 6: Cost-controlled test run

**Step 1: Run 3-brand test on other.json**

```bash
node scripts/find-locations-brave.js --region other --force-location --limit 3
```

Expected: 3 brands processed, Brave queries used: 3–6, results show `[done]` or `[no-location]`.

**Step 2: Check Anthropic usage dashboard**

Go to console.anthropic.com → Usage. Note the cost for this run. Calculate per-brand cost.

**Step 3: Get sign-off**

Report cost to user. Get explicit confirmation before proceeding to full run.

**Step 4: If approved — run full other.json pass**

```bash
node scripts/find-locations-brave.js --region other --force-location
```

**Step 5: Rebuild spreadsheet and commit**

```bash
node scripts/build-spreadsheet.js
git add data/microbrands-other.json watch-microbrand-database.xlsx
git commit -m "feat: run find-locations-brave on other.json — location enrichment"
```

---

### Task 7: Run across remaining regions

After confirming cost and quality from Task 6:

**Step 1: Europe**

```bash
node scripts/find-locations-brave.js --region europe --force-location
```

**Step 2: Americas**

```bash
node scripts/find-locations-brave.js --region americas --force-location
```

**Step 3: Asia-Pacific**

```bash
node scripts/find-locations-brave.js --region asia-pacific --force-location
```

**Step 4: Rebuild spreadsheet and commit all**

```bash
node scripts/build-spreadsheet.js
git add data/ watch-microbrand-database.xlsx
git commit -m "feat: run find-locations-brave across all regions — location correction pass"
```
