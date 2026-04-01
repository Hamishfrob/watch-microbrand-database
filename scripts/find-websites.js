// scripts/find-websites.js
// Uses Claude Haiku (knowledge only, no HTTP) to find official website URLs
// for brands in the three regional files that have website: null.
// Run: node scripts/find-websites.js
// Run with limit: node scripts/find-websites.js --limit 50
// Run one region: node scripts/find-websites.js --region europe

require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BATCH_SIZE = 50;

const LIMIT = process.argv.includes('--limit')
  ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10)
  : Infinity;

const REGION_ARG = process.argv.includes('--region')
  ? process.argv[process.argv.indexOf('--region') + 1]
  : null;

// Note: microbrands-other.json is intentionally excluded — brands there
// haven't been assigned a country yet and are handled by enrich-pass2.js
const REGION_FILES = {
  'europe':       'microbrands-europe.json',
  'americas':     'microbrands-americas.json',
  'asia-pacific': 'microbrands-asia-pacific.json',
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

const SYSTEM_PROMPT = `You are a watch industry expert. For each watch brand name provided, return its official website URL if you know it with confidence.

Rules:
- Only return URLs you are confident are correct official brand websites
- Return null if you are not sure — do NOT guess or fabricate
- Return the bare URL with https:// prefix (e.g. "https://www.baltic-watches.com")
- Do not return social media pages, retailer pages, or redirects
- Return ONLY a valid JSON array. No markdown, no explanation.

Example output:
[
  {"brandName": "Baltic", "website": "https://www.baltic-watches.com"},
  {"brandName": "UnknownBrand", "website": null}
]`;

async function processBatch(client, brands) {
  const names = brands.map(b => b.brandName);
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8192,
    messages: [{ role: 'user', content: `Find websites for these watch brands:\n${JSON.stringify(names)}` }],
    system: SYSTEM_PROMPT,
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

  let totalFound = 0;

  for (const [region, filename] of Object.entries(regions)) {
    const data = load(filename);
    const toProcess = data.filter(b => !b.website).slice(0, LIMIT);
    if (toProcess.length === 0) {
      console.log(`${region}: no brands missing website — skipping`);
      continue;
    }
    console.log(`\n${region}: finding websites for ${toProcess.length} brands...`);

    for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
      const batch = toProcess.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(toProcess.length / BATCH_SIZE);
      process.stdout.write(`  Batch ${batchNum}/${totalBatches}...`);

      let results;
      try {
        results = await processBatch(client, batch);
      } catch (err) {
        console.error(`\n  ERROR in batch ${batchNum}: ${err.message}`);
        continue;
      }

      let batchFound = 0;
      for (const result of results) {
        if (!result.website) continue;
        const entry = data.find(b => b.brandName.toLowerCase() === result.brandName.toLowerCase());
        if (!entry) continue;
        if (result.website && typeof result.website === 'string' && /^https?:\/\/.+\..+/.test(result.website)) {
          entry.website = result.website;
          batchFound++;
          totalFound++;
        }
      }
      console.log(` found ${batchFound}/${batch.length}`);
      save(filename, data);
    }
  }

  console.log(`\nDone. Total websites found: ${totalFound}`);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
