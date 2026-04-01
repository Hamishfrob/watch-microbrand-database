// scripts/enrich-pass2.js
// Pass 2: For brands in other.json still missing country, fetches their website
// and uses Claude to extract country, city, price range, Instagram, founded year, notes.
// Run: node scripts/enrich-pass2.js
// Run with limit: node scripts/enrich-pass2.js --limit 20

require('dotenv').config({ override: true });

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
    let done = false;
    function finish(val) { if (!done) { done = true; resolve(val); } }

    let urlObj;
    try { urlObj = new URL(url); } catch { return finish(null); }
    const lib = urlObj.protocol === 'https:' ? https : http;

    const req = lib.get(url, {
      timeout: TIMEOUT_MS,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WatchDBEnricher/1.0)' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          const redirect = new URL(res.headers.location, url).href;
          fetchPage(redirect).then(finish);
        } catch { finish(null); }
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 400) return finish(null);
      let body = '';
      res.on('data', c => { if (body.length < 60000) body += c; });
      res.on('end', () => finish(body));
    });
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  });
}

function extractInstagram(html) {
  const m = html.match(/instagram\.com\/([a-zA-Z0-9_.]{2,30})/);
  return (m && !['p', 'reel', 'explore', 'accounts'].includes(m[1])) ? m[1] : null;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{3,}/g, '\n')
    .slice(0, 8000);
}

async function enrichBrand(client, brand, html) {
  const instagram = extractInstagram(html);
  const text = stripHtml(html);

  const prompt = `You are analysing the website of a watch brand called "${brand.brandName}".

Website content (truncated):
---
${text}
---

Extract the following. Return ONLY valid JSON, no markdown, no explanation.

{
  "country": "country where brand is based (standard English name e.g. United States, United Kingdom, Germany)",
  "townCity": "city or town name only, or null",
  "foundedYear": year as integer or null,
  "priceRangeLow": lowest watch price in USD as integer or null,
  "priceRangeHigh": highest watch price in USD as integer or null,
  "notes": "1-3 sentences: what the brand makes, their style, movement type, anything distinctive. Factual, concise."
}

Rules:
- Use null for any value you cannot confidently determine from the content
- Infer country from address, About page, contact details, or domain (.de=Germany, .co.uk=UK, .fr=France etc.)
- Convert non-USD prices to USD if needed (approximate is fine)
- notes style: "British microbrand founded in 2018. Known for field watches with Swiss movements. Prices from $350."`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = message.content[0].text.trim()
    .replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
  const result = JSON.parse(raw);
  if (instagram && !result.instagramHandle) result.instagramHandle = instagram;
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

  const noWebsite = regionData['other'].filter(
    b => !b.country && (!b.website || !b.website.startsWith('http'))
  );

  console.log(`Pass 2: ${toProcess.length} brands to enrich via website fetch`);
  console.log(`        ${noWebsite.length} brands have no website (flagging for manual review)`);

  // Flag no-website brands
  for (const b of noWebsite) {
    if (!b.notes) b.notes = 'No website — manual review needed';
  }

  let enriched = 0, failed = 0, moved = 0;
  const processedNames = new Set(toProcess.map(b => b.brandName.toLowerCase()));

  // Process in batches of CONCURRENCY
  for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
    const batch = toProcess.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (brand) => {
      const idx = toProcess.indexOf(brand) + 1;
      try {
        const html = await fetchPage(brand.website);
        if (!html) {
          brand.notes = brand.notes || 'Website unreachable — manual review needed';
          failed++;
          process.stdout.write(`\r  [${idx}/${toProcess.length}] FAIL: ${brand.brandName.slice(0,30).padEnd(32)}`);
          return;
        }

        const result = await enrichBrand(client, brand, html);

        if (result.country)          brand.country          = result.country;
        if (result.townCity)         brand.townCity         = result.townCity;
        if (result.foundedYear)      brand.foundedYear      = result.foundedYear;
        if (result.priceRangeLow)    brand.priceRangeLow    = result.priceRangeLow;
        if (result.priceRangeHigh)   brand.priceRangeHigh   = result.priceRangeHigh;
        if (result.notes)            brand.notes            = result.notes;
        if (result.instagramHandle)  brand.instagramHandle  = result.instagramHandle;

        enriched++;

        if (brand.country) {
          const region = COUNTRY_TO_REGION[brand.country] || 'other';
          if (region !== 'other') {
            regionData[region].push(brand);
            moved++;
            process.stdout.write(`\r  [${idx}/${toProcess.length}] MOVED [${region}]: ${brand.brandName.slice(0,25).padEnd(27)}`);
            return;
          }
        }
        process.stdout.write(`\r  [${idx}/${toProcess.length}] OK: ${brand.brandName.slice(0,33).padEnd(35)}`);
      } catch (err) {
        brand.notes = brand.notes || `Enrichment error: ${err.message}`;
        failed++;
        process.stdout.write(`\r  [${idx}/${toProcess.length}] ERR: ${brand.brandName.slice(0,31).padEnd(33)}`);
      }
    }));
  }

  // Rebuild other.json — remove brands that were moved to regional files
  regionData['other'] = regionData['other'].filter(b => {
    const key = b.brandName.toLowerCase();
    if (!processedNames.has(key)) return true;
    if (b.country && COUNTRY_TO_REGION[b.country] && COUNTRY_TO_REGION[b.country] !== 'other') return false;
    return true;
  });

  for (const [region, filename] of Object.entries(REGION_FILES)) {
    save(filename, regionData[region]);
  }

  process.stdout.write('\n');
  console.log('\n--- Pass 2 Results ---');
  console.log(`  Website fetched & enriched: ${enriched}`);
  console.log(`  Moved to regional file:     ${moved}`);
  console.log(`  Failed/unreachable:         ${failed}`);
  console.log(`  No website (flagged):       ${noWebsite.length}`);
  for (const [region, filename] of Object.entries(REGION_FILES)) {
    console.log(`  ${region}: ${regionData[region].length} brands`);
  }
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
