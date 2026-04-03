# discover-brands.js Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build `scripts/discover-brands.js` — a weekly script that scrapes 8 microbrand watch sites to discover new brand candidates and refresh activity dates on existing brands.

**Architecture:** Single script with hardcoded site configs. Chronoscout (directory) uses pure HTML parsing; blog sites use manual HTTP fetch + Claude Haiku brand-name extraction. Matches found names against all 4 regional JSON files, updates `lastActivityDate` for matches, and appends unknowns to `data/candidates.json`.

**Tech Stack:** Node.js, `@anthropic-ai/sdk` (Haiku), `dotenv`, native `fetch` — no new dependencies.

---

## Reference

- Design doc: `docs/plans/2026-04-03-discover-brands-design.md`
- Pattern to follow: `scripts/re-enrich.js` — reuse `fetchPage`, `stripHtml`, load/save helpers verbatim
- Model: `claude-haiku-4-5` (same as re-enrich.js)
- Data files: `data/microbrands-europe.json`, `data/microbrands-americas.json`, `data/microbrands-asia-pacific.json`, `data/microbrands-other.json`

---

## Task 1: Scaffold the script — CLI flags, constants, site configs, file I/O helpers

**Files:**
- Create: `scripts/discover-brands.js`

**Step 1: Create the file with header comment, requires, constants, and site config array**

```js
// scripts/discover-brands.js
//
// Weekly discovery script — two jobs:
//   1. Find brand names NOT in the DB → append to data/candidates.json
//   2. Find brand names IN the DB → update lastActivityDate (flag Dormant/Defunct for review)
//
// Site types:
//   directory — HTML list parse, zero AI calls (e.g. Chronoscout)
//   blog      — fetch recent articles, Haiku extracts brand names (~$0.01/article)
//
// Flags:
//   --dry-run   print what would change, no writes
//   --limit N   cap total articles fetched across all blog sites
//
// Run:       node scripts/discover-brands.js
// Dry test:  node scripts/discover-brands.js --dry-run --limit 5

'use strict';
require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');

const DATA_DIR       = path.join(__dirname, '..', 'data');
const MODEL          = 'claude-haiku-4-5';
const FETCH_TIMEOUT  = 10_000;
const MAX_PAGE_CHARS = 6_000;
const MAX_ARTICLES_PER_SITE = 5;

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT   = process.argv.includes('--limit')
  ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10)
  : Infinity;

const SITES = [
  {
    name: 'Chronoscout',
    url:  'https://chronoscout.co/en/brands/',
    type: 'directory',
  },
  {
    name: 'Mainspring Watch Magazine',
    url:  'https://www.mainspring.watch/',
    type: 'blog',
  },
  {
    name: 'The Timebum',
    url:  'https://www.thetimebum.com/',
    type: 'blog',
  },
  {
    name: 'Balance & Bridge',
    url:  'https://www.balanceandbridge.com/',
    type: 'blog',
  },
  {
    name: 'Hype & Style',
    url:  'https://www.hypeandstyle.fr/en/',
    type: 'blog',
  },
  {
    name: 'Kaminsky',
    url:  'https://kaminskyblog.com/',
    type: 'blog',
  },
  {
    name: 'Le Petit Poussoir',
    url:  'https://lepetitpoussoir.fr/',
    type: 'blog',
  },
  {
    name: 'Chrononautix',
    url:  'https://chrononautix.com/',
    type: 'blog',
  },
];

const ALL_REGION_FILES = [
  'microbrands-europe.json',
  'microbrands-americas.json',
  'microbrands-asia-pacific.json',
  'microbrands-other.json',
];

const CANDIDATES_FILE = path.join(DATA_DIR, 'candidates.json');
```

**Step 2: Add load/save helpers (copy pattern from re-enrich.js)**

```js
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

function loadCandidates() {
  if (!fs.existsSync(CANDIDATES_FILE)) return [];
  return JSON.parse(fs.readFileSync(CANDIDATES_FILE, 'utf8'));
}

function saveCandidates(candidates) {
  fs.writeFileSync(CANDIDATES_FILE, JSON.stringify(candidates, null, 2), 'utf8');
}
```

**Step 3: Verify the file parses cleanly**

```bash
node -e "require('./scripts/discover-brands.js')" 2>&1
```
Expected: no errors (script will error on missing `main()` call — that's fine for now, just check for syntax errors).

**Step 4: Commit**

```bash
git add scripts/discover-brands.js
git commit -m "feat: scaffold discover-brands.js — constants, site configs, file I/O"
```

---

## Task 2: HTTP fetch + HTML utilities

**Files:**
- Modify: `scripts/discover-brands.js`

These are identical to `re-enrich.js` — copy them verbatim.

**Step 1: Add fetchPage, stripHtml**

```js
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
```

**Step 2: Add extractArticleLinks — finds recent blog post URLs from a homepage**

```js
function extractArticleLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const hrefs = [...html.matchAll(/href=["']([^"'#]{5,})["']/gi)].map(m => m[1]);
  const seen  = new Set();
  const links = [];

  for (const href of hrefs) {
    try {
      const url = new URL(href, baseUrl);
      // same domain only
      if (url.hostname !== base.hostname) continue;
      // must be a deeper path (not just / or /en/)
      const parts = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
      if (parts.length < 1) continue;
      // skip obvious nav pages
      const skip = /^(about|contact|category|tag|author|page|search|feed|wp-|cdn-|#)/i;
      if (skip.test(url.pathname)) continue;
      // prefer paths that look like posts (contain year or slug)
      const looksLikePost = /\/(20\d\d|review|article|blog|post|test|avis|montre|uhren|watch)/i.test(url.pathname);
      if (!looksLikePost) continue;

      const key = url.pathname;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push(url.href);
      if (links.length >= MAX_ARTICLES_PER_SITE) break;
    } catch { /* invalid href */ }
  }
  return links;
}
```

**Step 3: Verify syntax**

```bash
node -e "require('./scripts/discover-brands.js')" 2>&1
```
Expected: no errors.

**Step 4: Commit**

```bash
git add scripts/discover-brands.js
git commit -m "feat: add fetchPage, stripHtml, extractArticleLinks helpers"
```

---

## Task 3: DB loading and normalised lookup

**Files:**
- Modify: `scripts/discover-brands.js`

**Step 1: Add buildLookup — loads all 4 regional files, returns Map from normalised name → { brand, filename }**

```js
function normaliseName(name) {
  return name
    .toLowerCase()
    .replace(/\s+(watch(es)?|co\.?|ltd\.?|srl\.?|gmbh\.?|s\.a\.?|inc\.?)$/i, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function buildLookup() {
  // Map: normalisedName → { brand, filename }
  const lookup = new Map();
  for (const filename of ALL_REGION_FILES) {
    const brands = load(filename);
    for (const brand of brands) {
      const key = normaliseName(brand.brandName);
      if (key) lookup.set(key, { brand, filename });
    }
  }
  return lookup;
}
```

**Step 2: Manually verify normalisation logic makes sense**

Run this one-liner to spot-check a few names:
```bash
node -e "
const norm = n => n.toLowerCase().replace(/\s+(watch(es)?|co\.?|ltd\.?)$/i,'').replace(/[^a-z0-9]/g,'').trim();
['Baltic', 'Baltic Watches', 'Lorier Watch Co.', 'Marloe Watch Company', 'H. Moser & Cie'].forEach(n => console.log(n, '->', norm(n)));
"
```
Expected output:
```
Baltic -> baltic
Baltic Watches -> baltic
Lorier Watch Co. -> lorierwatch
Marloe Watch Company -> marloewatch
H. Moser & Cie -> hmosercie
```
This confirms the normalisation strips common suffixes and punctuation for fuzzy matching.

**Step 3: Commit**

```bash
git add scripts/discover-brands.js
git commit -m "feat: add normaliseName + buildLookup for DB matching"
```

---

## Task 4: Chronoscout directory parser

**Files:**
- Modify: `scripts/discover-brands.js`

**Step 1: Add parseDirectory — extracts brand names from Chronoscout's brand list page**

Chronoscout's `/en/brands/` page lists brands as links. We extract the link text inside anchor tags that point to `/en/brands/<slug>/`.

```js
function parseDirectory(html, siteUrl) {
  const brandNames = [];
  // Match anchor tags pointing to brand sub-pages: /en/brands/something/
  const re = /href=["'][^"']*\/brands\/[a-z0-9-]+\/["'][^>]*>([^<]{2,60})<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const name = m[1].trim();
    if (name && !brandNames.includes(name)) brandNames.push(name);
  }
  return brandNames;
}
```

**Step 2: Dry-test against live Chronoscout page**

```bash
node -e "
require('dotenv').config();
async function test() {
  const res = await fetch('https://chronoscout.co/en/brands/', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WatchResearchBot/1.0)' }
  });
  const html = await res.text();
  // Quick check — count brand-looking links
  const matches = [...html.matchAll(/href=[\"'][^\"']*\/brands\/[a-z0-9-]+\/[\"']/gi)];
  console.log('Brand links found:', matches.length);
  // Print first 5 link texts
  const re = /href=[\"'][^\"']*\/brands\/[a-z0-9-]+\/[\"'][^>]*>([^<]{2,60})<\/a>/gi;
  let m; let i=0;
  while ((m = re.exec(html)) !== null && i < 5) { console.log(m[1].trim()); i++; }
}
test().catch(console.error);
" 2>&1
```
Expected: prints a count > 50 and 5 brand names like "Ancon Watch Co.", "Baltic", etc.

If the regex doesn't match (site structure differs), inspect the raw HTML:
```bash
node -e "
async function test() {
  const res = await fetch('https://chronoscout.co/en/brands/', { headers: { 'User-Agent': 'Mozilla/5.0' }});
  const html = await res.text();
  // Print a 2000-char slice around the word 'brands'
  const idx = html.toLowerCase().indexOf('/brands/');
  console.log(html.slice(Math.max(0,idx-200), idx+500));
}
test().catch(console.error);
" 2>&1
```
Adjust the regex in `parseDirectory` to match the actual structure if needed.

**Step 3: Commit**

```bash
git add scripts/discover-brands.js
git commit -m "feat: add Chronoscout directory parser"
```

---

## Task 5: Haiku brand-name extractor for blog articles

**Files:**
- Modify: `scripts/discover-brands.js`

**Step 1: Add Anthropic client init + extractBrandsFromArticle**

```js
const client = new Anthropic();

async function extractBrandsFromArticle(text) {
  const msg = await client.messages.create({
    model:      MODEL,
    max_tokens: 256,
    messages: [{
      role:    'user',
      content: `Extract all watch brand names mentioned in this article text. Return ONLY a JSON array of strings (brand names). Include microbrands and independent brands. Do not include model names, just brand names. If no brands are mentioned return [].

Article:
${text}`,
    }],
  });

  try {
    const raw = msg.content[0].text.trim();
    // Strip markdown code fences if present
    const json = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
```

**Step 2: Dry-test with one real article**

```bash
node -e "
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic();
async function test() {
  const res = await fetch('https://www.thetimebum.com/', { headers: { 'User-Agent': 'Mozilla/5.0' }});
  const html = await res.text();
  // Find first article-like link
  const m = html.match(/href=[\"'](https?:\/\/www\.thetimebum\.com\/[^\s\"']{10,})[\"']/i);
  if (!m) { console.log('No article link found'); return; }
  console.log('Fetching:', m[1]);
  const res2 = await fetch(m[1], { headers: { 'User-Agent': 'Mozilla/5.0' }});
  const html2 = await res2.text();
  const text = html2.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,6000);
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5', max_tokens: 256,
    messages: [{ role: 'user', content: 'Extract all watch brand names mentioned. Return ONLY a JSON array of strings.\n\n' + text }]
  });
  console.log('Brands found:', msg.content[0].text);
  console.log('Input tokens:', msg.usage.input_tokens, '| Output tokens:', msg.usage.output_tokens);
}
test().catch(console.error);
" 2>&1
```
Expected: a JSON array of brand names, token counts showing ~300–600 input tokens.

**Step 3: Commit**

```bash
git add scripts/discover-brands.js
git commit -m "feat: add Haiku brand extractor for blog articles"
```

---

## Task 6: Matching logic + DB update

**Files:**
- Modify: `scripts/discover-brands.js`

**Step 1: Add processBrands — matches found names against lookup, returns update/flag/candidate lists**

```js
const TODAY = new Date().toISOString().slice(0, 10);

function processBrands(foundNames, lookup, sourceSite, sourceUrl) {
  const updates  = [];   // { brand, filename } — update lastActivityDate
  const flags    = [];   // { brand, filename, reason } — Dormant/Defunct, flag for review
  const newFound = [];   // { brandName, sourceSite, sourceUrl } — not in DB

  for (const name of foundNames) {
    const key   = normaliseName(name);
    if (!key) continue;
    const match = lookup.get(key);

    if (match) {
      match.brand.lastActivityDate = TODAY;
      if (match.brand.status === 'Dormant' || match.brand.status === 'Defunct') {
        flags.push({ brand: match.brand, filename: match.filename, reason: match.brand.status });
      } else {
        updates.push({ brand: match.brand, filename: match.filename });
      }
    } else {
      newFound.push({ brandName: name, sourceSite, sourceUrl, discoveredDate: TODAY });
    }
  }

  return { updates, flags, newFound };
}
```

**Step 2: Commit**

```bash
git add scripts/discover-brands.js
git commit -m "feat: add processBrands matching + DB update logic"
```

---

## Task 7: Candidates file writer

**Files:**
- Modify: `scripts/discover-brands.js`

**Step 1: Add mergeCandidates — appends new entries, no duplicates**

```js
function mergeCandidates(existing, newFound) {
  const existingNames = new Set(existing.map(c => normaliseName(c.brandName)));
  const toAdd = newFound.filter(c => !existingNames.has(normaliseName(c.brandName)));
  return [...existing, ...toAdd];
}
```

**Step 2: Commit**

```bash
git add scripts/discover-brands.js
git commit -m "feat: add mergeCandidates — no-duplicate append to candidates.json"
```

---

## Task 8: Report printer

**Files:**
- Modify: `scripts/discover-brands.js`

**Step 1: Add printReport**

```js
function printReport({ sitesChecked, articlesTotal, brandsFound, dbUpdated, flagged, candidates, dryRun }) {
  const line = '─'.repeat(50);
  console.log(`\nRun: ${TODAY}${dryRun ? '  [DRY RUN — no writes]' : ''}`);
  console.log(line);
  console.log(`Sites checked:      ${sitesChecked}`);
  console.log(`Articles fetched:   ${articlesTotal}`);
  console.log(`Brand names found:  ${brandsFound}`);
  console.log('');
  console.log(`DB matches updated: ${dbUpdated}`);
  if (flagged.length) {
    console.log(`Flags for review:   ${flagged.length}`);
    for (const f of flagged) {
      console.log(`  [${f.reason}] ${f.brand.brandName}`);
    }
  } else {
    console.log(`Flags for review:   0`);
  }
  console.log('');
  console.log(`New candidates:     ${candidates}  → data/candidates.json`);
  console.log(line + '\n');
}
```

**Step 2: Commit**

```bash
git add scripts/discover-brands.js
git commit -m "feat: add printReport"
```

---

## Task 9: Wire main() together and end-to-end test

**Files:**
- Modify: `scripts/discover-brands.js`

**Step 1: Add main()**

```js
async function main() {
  const lookup     = buildLookup();
  const allRegions = {};                   // filename → brands array (for saving)
  for (const f of ALL_REGION_FILES) allRegions[f] = load(f);

  let articlesTotal   = 0;
  let allNewFound     = [];
  let allFlags        = [];
  let allDbUpdated    = 0;
  let allBrandsFound  = 0;
  let limitRemaining  = LIMIT;

  for (const site of SITES) {
    console.log(`\nChecking: ${site.name}`);
    const page = await fetchPage(site.url);
    if (!page) { console.log('  ✗ fetch failed'); continue; }

    let brandNames = [];

    if (site.type === 'directory') {
      brandNames = parseDirectory(page.html, site.url);
      console.log(`  parsed ${brandNames.length} brands (no AI)`);

    } else {
      // blog: extract article links, fetch each, extract brands
      const articleLinks = extractArticleLinks(page.html, site.url);
      const toFetch = articleLinks.slice(0, Math.min(MAX_ARTICLES_PER_SITE, limitRemaining));
      console.log(`  found ${articleLinks.length} article links, fetching ${toFetch.length}`);

      for (const link of toFetch) {
        if (limitRemaining <= 0) break;
        const ap = await fetchPage(link);
        if (!ap) continue;
        const text   = stripHtml(ap.html);
        const brands = await extractBrandsFromArticle(text);
        brandNames.push(...brands);
        articlesTotal++;
        limitRemaining--;
        console.log(`  ${link} → ${brands.length} brands`);
      }
    }

    allBrandsFound += brandNames.length;

    const { updates, flags, newFound } = processBrands(
      [...new Set(brandNames)],   // dedupe within site
      lookup,
      site.name,
      site.url
    );

    allDbUpdated += updates.length;
    allFlags.push(...flags);
    allNewFound.push(...newFound);

    // Apply updates to in-memory region data
    for (const u of [...updates, ...flags]) {
      const arr = allRegions[u.filename];
      const idx = arr.findIndex(b => b.brandName === u.brand.brandName);
      if (idx !== -1) arr[idx] = u.brand;
    }
  }

  // Write DB updates
  if (!DRY_RUN) {
    for (const [filename, brands] of Object.entries(allRegions)) {
      save(filename, brands);
    }
    const existing   = loadCandidates();
    const merged     = mergeCandidates(existing, allNewFound);
    saveCandidates(merged);
  }

  printReport({
    sitesChecked:  SITES.length,
    articlesTotal,
    brandsFound:   allBrandsFound,
    dbUpdated:     allDbUpdated,
    flagged:       allFlags,
    candidates:    allNewFound.length,
    dryRun:        DRY_RUN,
  });
}

main().catch(err => { console.error(err); process.exit(1); });
```

**Step 2: Dry-run test — 1 article, no writes**

```bash
node scripts/discover-brands.js --dry-run --limit 1 2>&1
```
Expected:
- Chronoscout: parsed N brands
- One blog site fetches 1 article → shows brand names found
- Report prints with `[DRY RUN — no writes]`
- No files modified

**Step 3: Real run with limit 5**

```bash
node scripts/discover-brands.js --limit 5 2>&1
```
Expected: report shows some DB updates, possibly some candidates. Check `data/candidates.json` was created/updated.

**Step 4: Verify candidates.json is valid JSON**

```bash
node -e "const c = require('./data/candidates.json'); console.log('candidates:', c.length)" 2>&1
```

**Step 5: Commit**

```bash
git add scripts/discover-brands.js data/candidates.json
git commit -m "feat: complete discover-brands.js — discovery + status refresh pipeline"
```

---

## Task 10: Create empty candidates.json if it doesn't exist

**Files:**
- Create: `data/candidates.json`

**Step 1: Create empty candidates file**

```bash
node -e "
const fs = require('fs'), path = require('path');
const fp = path.join('data','candidates.json');
if (!fs.existsSync(fp)) { fs.writeFileSync(fp, '[]', 'utf8'); console.log('created'); }
else console.log('already exists');
"
```

**Step 2: Commit**

```bash
git add data/candidates.json
git commit -m "chore: add empty candidates.json"
```
