// scripts/find-websites-brave.js
//
// Uses Brave Search API to find official website URLs for brands in other.json
// that still have no website after the Sonnet knowledge pass.
//
// Approach:
//   1. Search Brave for "BrandName watches official site"
//   2. Take the top result that looks like an official brand site
//   3. Skip retailers, aggregators, social media, marketplaces
//   4. Store the URL — re-enrich.js then fetches and extracts data
//
// Free tier: 2,000 queries/month — sufficient for ~600 remaining brands.
//
// Run:             node scripts/find-websites-brave.js
// One region:      node scripts/find-websites-brave.js --region other
// Limit (test):    node scripts/find-websites-brave.js --region other --limit 5

'use strict';
require('dotenv').config({ override: true });
const fs   = require('fs');
const path = require('path');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const CONCURRENCY = 3;   // stay well within Brave rate limits
const DELAY_MS    = 350; // ms between requests

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
  'other':        'microbrands-other.json',
};

if (REGION_ARG && !REGION_FILES[REGION_ARG]) {
  console.error(`Unknown region: "${REGION_ARG}". Valid: ${Object.keys(REGION_FILES).join(', ')}`);
  process.exit(1);
}

// Domains that are never official brand sites
const BLOCKLIST = [
  // Marketplaces & retailers
  'amazon.', 'ebay.', 'etsy.', 'chrono24.', 'watchrecon.', 'jomashop.',
  'creationwatches.', 'worldoftimepieces.', 'watchswiss.', 'bensontrade.',
  'timepiecetrading', 'watchpatrol.', 'watchadvisor.',
  'watchobsession.', 'watches2u.', 'watchshop.', 'watchfinds.',
  // Social media
  'instagram.', 'facebook.', 'twitter.', 'x.com', 'youtube.', 'pinterest.',
  'tiktok.', 'linkedin.',
  // Forums & press
  'reddit.', 'watchuseek.', 'hodinkee.', 'watchtime.', 'fratello',
  'ablogtowatch', 'deployant.', 'watchonista.', 'europastar.', 'quillandpad.',
  'watchpro.', 'watchjournal.', 'revolution.watch', 'timezonewatch.',
  'monochrome-watches.', 'wornandwound.', 'watchesbysjx.',
  // Reference & crowdfunding
  'wikipedia.', 'wikidata.', 'kickstarter.', 'indiegogo.',
];

function isLikelyOfficialSite(url, brandName) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (BLOCKLIST.some(b => hostname.includes(b))) return false;
    // Prefer URLs that contain a meaningful part of the brand name
    const slug = brandName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const hostSlug = hostname.replace(/[^a-z0-9]/g, '');
    return hostSlug.includes(slug.slice(0, 4)); // at least first 4 chars match
  } catch {
    return false;
  }
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

async function searchBrave(brandName) {
  const query = encodeURIComponent(`${brandName} watches official site`);
  const url = `https://api.search.brave.com/res/v1/web/search?q=${query}&count=5&search_lang=en`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': process.env.BRAVE_API_KEY,
    },
  });
  if (!res.ok) {
    if (res.status === 429) throw new Error('Rate limited by Brave API');
    throw new Error(`Brave API error: ${res.status}`);
  }
  const data = await res.json();
  const results = data?.web?.results || [];
  for (const result of results) {
    const resultUrl = result.url;
    if (isLikelyOfficialSite(resultUrl, brandName)) return resultUrl;
  }
  // Fallback: return first non-blocked result
  for (const result of results) {
    const resultUrl = result.url;
    try {
      const hostname = new URL(resultUrl).hostname.toLowerCase();
      if (!BLOCKLIST.some(b => hostname.includes(b))) return resultUrl;
    } catch { /* skip */ }
  }
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runPool(tasks, concurrency) {
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const task = tasks[idx++];
      await task();
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

  const regions = REGION_ARG ? { [REGION_ARG]: REGION_FILES[REGION_ARG] } : REGION_FILES;

  let totalFound = 0;

  for (const [region, filename] of Object.entries(regions)) {
    const data = load(filename);
    const toProcess = data.filter(b => !b.website).slice(0, LIMIT);

    if (toProcess.length === 0) {
      console.log(`\n${region}: no brands missing website — skipping`);
      continue;
    }

    console.log(`\n${region}: searching Brave for ${toProcess.length} brands...`);

    let done = 0;
    const tasks = toProcess.map(brand => async () => {
      let found = false;
      try {
        const url = await searchBrave(brand.brandName);
        if (url) {
          brand.website = url;
          found = true;
          totalFound++;
          save(filename, data);
        }
      } catch (err) {
        if (err.message.includes('Rate limited')) {
          console.error('\nRate limited — waiting 10s...');
          await sleep(10_000);
        }
      }
      done++;
      process.stdout.write(
        `\r  ${String(done).padStart(4)}/${toProcess.length} — ${brand.brandName.slice(0, 30).padEnd(30)} [${found ? 'found' : 'not found'}]`
      );
    });

    await runPool(tasks, CONCURRENCY);
    console.log('');
  }

  console.log(`\nDone. Websites found: ${totalFound}`);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
