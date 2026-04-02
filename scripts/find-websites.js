// scripts/find-websites.js
// Uses Claude Sonnet (knowledge only, no HTTP) to find official website URLs
// and country of origin for brands missing that data.
// Sonnet is used over Haiku for its broader knowledge of obscure microbrands.
//
// Run: node scripts/find-websites.js
// Run with limit: node scripts/find-websites.js --limit 50
// Run one region: node scripts/find-websites.js --region other

require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');
const fs   = require('fs');
const path = require('path');

const DATA_DIR   = path.join(__dirname, '..', 'data');
const BATCH_SIZE = 50;
const MODEL      = 'claude-sonnet-4-6';

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
  console.error(`Unknown region: "${REGION_ARG}". Valid options: ${Object.keys(REGION_FILES).join(', ')}`);
  process.exit(1);
}

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

function needsWork(brand) {
  return !brand.website || !brand.country;
}

const SYSTEM_PROMPT = `You are a watch industry expert with deep knowledge of microbrands and independent watchmakers worldwide.

For each watch brand name provided, return:
- "website": the official website URL if you know it with confidence, otherwise null
- "country": the country the brand is based in if you know it, otherwise null

Rules:
- Only return values you are confident about — never guess or fabricate
- website must be the official brand site with https:// prefix — not a retailer, social media page, or redirect
- country must be the full country name in English (e.g. "United States", "Germany", "United Kingdom")
- Return ONLY a valid JSON array. No markdown, no explanation.

Example output:
[
  {"brandName": "Baltic", "website": "https://www.baltic-watches.com", "country": "France"},
  {"brandName": "UnknownBrand", "website": null, "country": null}
]`;

async function processBatch(client, brands) {
  const names = brands.map(b => b.brandName);
  const message = await client.messages.create({
    model:      MODEL,
    max_tokens: 8192,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: `Find website and country for these watch brands:\n${JSON.stringify(names)}` }],
  });
  const text = message.content[0].text.trim();
  const json = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(json);
  } catch (err) {
    console.error(`\n  JSON parse error: ${err.message}\n  Raw response: ${text.slice(0, 200)}`);
    return [];
  }
}

async function run() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set. Add it to your .env file.');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const regions = REGION_ARG
    ? { [REGION_ARG]: REGION_FILES[REGION_ARG] }
    : REGION_FILES;

  let totalWebsites = 0;
  let totalCountries = 0;

  for (const [region, filename] of Object.entries(regions)) {
    const data = load(filename);
    const toProcess = data.filter(needsWork).slice(0, LIMIT);
    if (toProcess.length === 0) {
      console.log(`${region}: all brands have website and country — skipping`);
      continue;
    }
    console.log(`\n${region}: processing ${toProcess.length} brands missing website or country...`);

    for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
      const batch = toProcess.slice(i, i + BATCH_SIZE);
      const batchNum    = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(toProcess.length / BATCH_SIZE);
      process.stdout.write(`  Batch ${batchNum}/${totalBatches}...`);

      let results;
      try {
        results = await processBatch(client, batch);
      } catch (err) {
        console.error(`\n  ERROR in batch ${batchNum}: ${err.message}`);
        continue;
      }

      let batchWebsites = 0, batchCountries = 0;
      for (const result of results) {
        const entry = data.find(b => b.brandName.toLowerCase() === result.brandName.toLowerCase());
        if (!entry) continue;

        if (result.website && typeof result.website === 'string' && /^https?:\/\/.+\..+/.test(result.website)) {
          if (!entry.website) {
            entry.website = result.website;
            batchWebsites++;
            totalWebsites++;
          }
        }
        if (result.country && typeof result.country === 'string' && result.country.length > 1) {
          if (!entry.country) {
            entry.country = result.country;
            batchCountries++;
            totalCountries++;
          }
        }
      }
      console.log(` websites: ${batchWebsites}/${batch.length}  countries: ${batchCountries}/${batch.length}`);
      save(filename, data);
    }
  }

  console.log(`\nDone. Websites found: ${totalWebsites}  Countries found: ${totalCountries}`);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
