// scripts/enrich-pass2.js
// Pass 2: Enriches brands remaining in other.json with null country.
// Mode A: fetches website HTML for brands that have a URL.
// Mode B: asks Claude (knowledge only) for country/website/notes for brands without a URL.
// Run: node scripts/enrich-pass2.js
// Run with limit: node scripts/enrich-pass2.js --limit 50

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

// ─── Mode A: Website fetch ────────────────────────────────────────────────────

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
        try { fetchPage(new URL(res.headers.location, url).href).then(finish); } catch { finish(null); }
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

async function enrichFromWebsite(client, brand, html) {
  const instagram = extractInstagram(html);
  const text = stripHtml(html);
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{ role: 'user', content: `You are analysing the website of a watch brand called "${brand.brandName}".

Website content (truncated):
---
${text}
---

Return ONLY valid JSON, no markdown:
{"country":"country where brand is based (standard English name)","townCity":"city or null","foundedYear":year or null,"priceRangeLow":USD integer or null,"priceRangeHigh":USD integer or null,"notes":"1-3 sentences: brand style, movement type, anything distinctive."}

Use null for anything you cannot confidently determine. Infer country from address, About page, domain (.de=Germany, .co.uk=UK etc.).` }],
  });
  const raw = message.content[0].text.trim().replace(/^```json?\s*/i,'').replace(/\s*```$/i,'').trim();
  const result = JSON.parse(raw);
  if (instagram && !result.instagramHandle) result.instagramHandle = instagram;
  return result;
}

// ─── Mode B: Knowledge lookup (no website) ───────────────────────────────────

const MODE_B_SYSTEM = `You are a watch industry expert. For each brand name, return what you know about it.

Return a JSON array. For each brand:
- If you recognise it as a microbrand or independent watch brand: {"brandName":"...","country":"country (standard English name)","website":"https://... or null","notes":"1-3 factual sentences about the brand."}
- If you do not recognise it or are unsure: {"brandName":"...","country":null,"website":null,"notes":null}

Do NOT guess or fabricate. Return ONLY a valid JSON array, no markdown.`;

async function enrichFromKnowledge(client, brands) {
  const names = brands.map(b => b.brandName);
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8192,
    messages: [{ role: 'user', content: `Look up these watch brands:\n${JSON.stringify(names)}` }],
    system: MODE_B_SYSTEM,
  });
  const text = message.content[0].text.trim().replace(/^```json?\s*/i,'').replace(/\s*```$/i,'').trim();
  return JSON.parse(text);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const regionData = {};
  for (const [region, filename] of Object.entries(REGION_FILES)) {
    regionData[region] = load(filename);
  }

  const nullCountry = regionData['other'].filter(b => !b.country);
  const withUrl     = nullCountry.filter(b => b.website && b.website.startsWith('http')).slice(0, LIMIT);
  const withoutUrl  = nullCountry.filter(b => !b.website || !b.website.startsWith('http')).slice(0, Math.max(0, LIMIT - withUrl.length));

  console.log(`Pass 2:`);
  console.log(`  Mode A (website fetch):     ${withUrl.length} brands`);
  console.log(`  Mode B (knowledge lookup):  ${withoutUrl.length} brands`);

  let enriched = 0, moved = 0, failed = 0, unknownCount = 0;
  const processedNames = new Set([...withUrl, ...withoutUrl].map(b => b.brandName.toLowerCase()));

  // ── Mode A ──
  if (withUrl.length > 0) {
    console.log('\nMode A: fetching websites...');
    for (let i = 0; i < withUrl.length; i += CONCURRENCY) {
      const batch = withUrl.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (brand) => {
        try {
          const html = await fetchPage(brand.website);
          if (!html) { brand.notes = brand.notes || 'Website unreachable'; failed++; return; }
          const result = await enrichFromWebsite(client, brand, html);
          if (result.country)         brand.country         = result.country;
          if (result.townCity)        brand.townCity        = result.townCity;
          if (result.foundedYear)     brand.foundedYear     = result.foundedYear;
          if (result.priceRangeLow)   brand.priceRangeLow   = result.priceRangeLow;
          if (result.priceRangeHigh)  brand.priceRangeHigh  = result.priceRangeHigh;
          if (result.notes)           brand.notes           = result.notes;
          if (result.instagramHandle) brand.instagramHandle = result.instagramHandle;
          enriched++;
          if (brand.country) {
            const region = COUNTRY_TO_REGION[brand.country] || 'other';
            if (region !== 'other') { regionData[region].push(brand); moved++; }
          }
        } catch (err) { brand.notes = brand.notes || `Error: ${err.message}`; failed++; }
        process.stdout.write(`\r  [${withUrl.indexOf(brand)+1}/${withUrl.length}] ${brand.brandName.slice(0,40).padEnd(42)}`);
      }));
    }
    process.stdout.write('\n');
  }

  // ── Mode B ──
  if (withoutUrl.length > 0) {
    console.log('\nMode B: knowledge lookup...');
    const BATCH_SIZE = 50;
    for (let i = 0; i < withoutUrl.length; i += BATCH_SIZE) {
      const batch = withoutUrl.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(withoutUrl.length / BATCH_SIZE);
      process.stdout.write(`\r  Batch ${batchNum}/${totalBatches}...`);
      let results;
      try {
        results = await enrichFromKnowledge(client, batch);
      } catch (err) {
        console.error(`\n  ERROR batch ${batchNum}: ${err.message}`);
        continue;
      }
      for (const result of results) {
        const entry = withoutUrl.find(b => b.brandName.toLowerCase() === result.brandName.toLowerCase());
        if (!entry) continue;
        if (result.country)  entry.country  = result.country;
        if (result.website)  entry.website  = result.website;
        if (result.notes)    entry.notes    = result.notes;
        else { entry.notes = 'Unknown brand — manual review needed'; unknownCount++; }
        enriched++;
        if (entry.country) {
          const region = COUNTRY_TO_REGION[entry.country] || 'other';
          if (region !== 'other') {
            regionData[region].push(entry);
            moved++;
            console.log(`\n  MOVED [${region}]: ${entry.brandName} (${entry.country})`);
          }
        }
      }
    }
    process.stdout.write('\n');
  }

  // Rebuild other.json — remove moved brands
  regionData['other'] = regionData['other'].filter(b => {
    const key = b.brandName.toLowerCase();
    if (!processedNames.has(key)) return true;
    if (b.country && COUNTRY_TO_REGION[b.country] && COUNTRY_TO_REGION[b.country] !== 'other') return false;
    return true;
  });

  for (const [region, filename] of Object.entries(REGION_FILES)) {
    save(filename, regionData[region]);
  }

  console.log('\n--- Pass 2 Results ---');
  console.log(`  Enriched:           ${enriched}`);
  console.log(`  Moved to region:    ${moved}`);
  console.log(`  Failed (Mode A):    ${failed}`);
  console.log(`  Unknown (Mode B):   ${unknownCount}`);
  for (const [region, filename] of Object.entries(REGION_FILES)) {
    console.log(`  ${region}: ${regionData[region].length} brands`);
  }
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
