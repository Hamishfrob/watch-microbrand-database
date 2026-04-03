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

// ─── Config ───────────────────────────────────────────────────────────────────

const DATA_DIR       = path.join(__dirname, '..', 'data');
const MODEL          = 'claude-haiku-4-5';
const FETCH_TIMEOUT  = 10_000;
const MAX_PAGE_CHARS = 6_000;
const MAX_ARTICLES_PER_SITE = 5; // hard cap per blog site regardless of --limit

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  if (idx === -1) return Infinity;
  const n = parseInt(process.argv[idx + 1], 10);
  if (isNaN(n) || n < 1) {
    console.error('Error: --limit requires a positive integer');
    process.exit(1);
  }
  return n;
})();

// ─── Sites ────────────────────────────────────────────────────────────────────

const SITES = [
  {
    name: 'Chronoscout',
    url:  'https://chronoscout.co/sitemap.xml',
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

// ─── File I/O ─────────────────────────────────────────────────────────────────

function load(filename) {
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) return [];
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function save(filename, data) {
  if (DRY_RUN) return;
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
  if (DRY_RUN) return;
  const sorted = [...candidates].sort((a, b) =>
    (a.brandName || '').localeCompare(b.brandName || '', 'en', { sensitivity: 'base' })
  );
  fs.writeFileSync(CANDIDATES_FILE, JSON.stringify(sorted, null, 2), 'utf8');
}

// ─── HTTP + HTML ──────────────────────────────────────────────────────────────

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

// ─── DB lookup ───────────────────────────────────────────────────────────────

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

// ─── Directory parser ────────────────────────────────────────────────────────

function parseDirectory(html, siteUrl) {
  const brandNames = [];
  // Chronoscout is a SPA — brand links don't appear in the initial HTML.
  // Instead, parse brand name slugs from sitemap URLs:
  //   https://chronoscout.co/en/brand/<id>/<name-slug>/
  // Primary pattern: /en/brand/<id>/<slug>/ or /de/brand/<id>/<slug>/
  const re = /\/(?:en|de)\/brand\/[A-Za-z0-9_-]+\/([a-z0-9][a-z0-9-]{1,60})\//g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const slug = m[1];
    // Convert kebab-case slug → Title Case brand name
    const name = slug
      .split('-')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    if (name && !brandNames.includes(name)) brandNames.push(name);
  }
  return brandNames;
}

// ─── Claude extraction ───────────────────────────────────────────────────────

async function extractBrandsFromArticle(text) {
  const client = new Anthropic();
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

// ─── Matching ────────────────────────────────────────────────────────────────

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
      match.brand.lastActivityDate = TODAY;  // update date for all matches, including Dormant/Defunct
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

// ─── Candidates ──────────────────────────────────────────────────────────────

function mergeCandidates(existing, newFound) {
  const existingNames = new Set(existing.map(c => normaliseName(c.brandName)));
  const toAdd = newFound.filter(c => !existingNames.has(normaliseName(c.brandName)));
  return [...existing, ...toAdd];
}

// ─── Report ──────────────────────────────────────────────────────────────────

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

// ─── Main ────────────────────────────────────────────────────────────────────

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

    const deduped = [...new Set(brandNames)];
    allBrandsFound += deduped.length;

    const { updates, flags, newFound } = processBrands(
      deduped,
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

  // Dedupe new candidates across sites (same brand may appear on multiple sites)
  const seenNew = new Set();
  allNewFound = allNewFound.filter(c => {
    const key = normaliseName(c.brandName);
    if (seenNew.has(key)) return false;
    seenNew.add(key);
    return true;
  });

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
