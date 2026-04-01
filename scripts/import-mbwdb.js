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

function decodeEntities(str) {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// Extract brand details from an individual brand page
function extractBrandDetails(html, url) {
  const raw  = (html.match(/<h1[^>]*>([^<]+)<\/h1>/) || [])[1]?.trim() || '';
  const name = decodeEntities(raw);
  const website = (html.match(/href="(https?:\/\/(?!mbwdb\.com)[^"]+)"[^>]*>[Ww]ebsite/) ||
                   html.match(/Website[^<]*<\/[^>]+>[^<]*<a href="(https?:\/\/(?!mbwdb\.com)[^"]+)"/) ||
                   [])[1] || '';
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
