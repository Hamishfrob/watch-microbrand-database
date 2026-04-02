// scripts/re-enrich.js
//
// Enriches brand data using Claude with built-in web search and web fetch.
// Claude searches for / verifies the official website, fetches homepage and
// shop/collection pages, then extracts all fields and assesses brand status.
//
// No external search API needed — Anthropic handles all web access server-side.
//
// Flags:
//   --region europe|americas|asia-pacific  (default: all three)
//   --limit N                              (default: unlimited)
//   --force                                (overwrite fields that already have data)
//
// Run:              node scripts/re-enrich.js
// One region:       node scripts/re-enrich.js --region europe
// Test (10 brands): node scripts/re-enrich.js --region europe --limit 10
// Monthly refresh:  node scripts/re-enrich.js --force

require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');
const fs   = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const DATA_DIR    = path.join(__dirname, '..', 'data');
const CONCURRENCY = 3;

// Web search + fetch require Sonnet 4.6 or Opus 4.6 for the dynamic-filtering
// versions. Switch to 'claude-haiku-4-5' only if you've confirmed web search
// is available on Haiku in your API tier.
const MODEL = 'claude-sonnet-4-6';

// Anthropic-hosted tools — no API key or backend required
const TOOLS = [
  { type: 'web_search_20260209', name: 'web_search' },
  { type: 'web_fetch_20260209',  name: 'web_fetch'  },
];

const LIMIT = process.argv.includes('--limit')
  ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10)
  : Infinity;

const REGION_ARG = process.argv.includes('--region')
  ? process.argv[process.argv.indexOf('--region') + 1]
  : null;

const FORCE = process.argv.includes('--force');

const REGION_FILES = {
  'europe':       'microbrands-europe.json',
  'americas':     'microbrands-americas.json',
  'asia-pacific': 'microbrands-asia-pacific.json',
};

// ─── File I/O ─────────────────────────────────────────────────────────────────

function load(filename) {
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) return [];
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

let _saving = false;
let _savePending = null;

function save(filename, data) {
  if (_saving) { _savePending = { filename, data: [...data] }; return; }
  _saving = true;
  const sorted = [...data].sort((a, b) =>
    (a.brandName || '').localeCompare(b.brandName || '', 'en', { sensitivity: 'base' })
  );
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(sorted, null, 2), 'utf8');
  _saving = false;
  if (_savePending) {
    const { filename: pf, data: pd } = _savePending;
    _savePending = null;
    save(pf, pd);
  }
}

// ─── Skip logic ───────────────────────────────────────────────────────────────

function needsWork(brand) {
  if (FORCE) return true;
  return !brand.website
    || brand.instagramHandle  == null
    || brand.priceRangeLow    == null
    || brand.foundedYear      == null
    || brand.latestModel      == null
    || !brand.status
    || brand.lastActivityDate == null
    || !brand.notes;
}

// ─── Claude enrichment ────────────────────────────────────────────────────────

const EXTRACT_SCHEMA = `{
  "website": "https://...",          // correct official URL, or null
  "instagramHandle": "...",          // username without @, or null
  "priceRangeLow": 350,              // lowest current USD price (integer), or null
  "priceRangeHigh": 650,             // highest current USD price (integer), or null
  "foundedYear": 2017,               // year brand was founded (integer), or null
  "latestModel": "...",              // most recent or currently featured model name, or null
  "status": "Active",                // "Active" = selling now, "Dormant" = no activity 12+ months, "Defunct" = closed
  "lastActivityDate": "2024-10-01",  // ISO YYYY-MM-DD date of most recent confirmed activity, or null
  "notes": "..."                     // 1-3 factual sentences: founding story, style, movements, location
}`;

async function enrichBrand(client, brand) {
  const websiteContext = brand.website
    ? `Existing website on file: ${brand.website} — verify this is the correct official site for the brand.`
    : `No website on file — find the official website.`;

  const userMessage = `You are a watch industry researcher. Research the watch brand "${brand.brandName}" (country: ${brand.country || 'unknown'}).

${websiteContext}

Instructions:
1. Search for "${brand.brandName} watches" to find or verify the official website
2. Fetch the homepage of the official site
3. Find and fetch a shop, collection, or buy page to get price information
4. Extract all fields and return ONLY a single valid JSON object — no markdown, no explanation

JSON schema to return:
${EXTRACT_SCHEMA}

Rules:
- Only return values you are confident about — do not guess or fabricate
- Prices must be in USD — convert from other currencies using approximate rates
- Notes style: "French microbrand founded in 2017. Known for vintage-inspired dive watches. Swiss-assembled using Sellita movements."
- If the brand appears to be defunct (site down, no products, closed notice), set status to "Defunct"`;

  const messages = [{ role: 'user', content: userMessage }];
  let response;
  let continuations = 0;
  const MAX_CONTINUATIONS = 5;

  // Server-side tool loops can hit an iteration limit and return pause_turn.
  // When that happens, append the assistant turn and re-send — the API resumes.
  do {
    response = await client.messages.create({
      model:      MODEL,
      max_tokens: 1024,
      tools:      TOOLS,
      messages,
    });

    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continuations++;
    }
  } while (response.stop_reason === 'pause_turn' && continuations < MAX_CONTINUATIONS);

  // The final response should contain a text block with the JSON
  for (const block of response.content) {
    if (block.type === 'text') {
      const text = block.text.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
      try {
        return JSON.parse(text);
      } catch {
        // Claude occasionally wraps JSON in prose — try to extract it
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try { return JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
        }
      }
    }
  }
  return null;
}

// ─── Per-brand processor ──────────────────────────────────────────────────────

async function processBrand(client, brand, filename, data) {
  if (!needsWork(brand)) return 'skip';

  let extracted;
  try {
    extracted = await enrichBrand(client, brand);
  } catch (err) {
    return 'error';
  }

  if (!extracted) return 'no-data';

  // Apply extracted values — only overwrite nulls unless --force
  const fields = [
    'website', 'instagramHandle',
    'priceRangeLow', 'priceRangeHigh',
    'foundedYear', 'latestModel',
    'status', 'lastActivityDate', 'notes',
  ];
  for (const f of fields) {
    if (extracted[f] != null && (brand[f] == null || FORCE)) {
      brand[f] = extracted[f];
    }
  }

  save(filename, data);
  return 'done';
}

// ─── Concurrency pool ─────────────────────────────────────────────────────────

async function runPool(tasks, concurrency) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function run() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  if (REGION_ARG && !REGION_FILES[REGION_ARG]) {
    console.error(`Unknown region: "${REGION_ARG}". Valid: ${Object.keys(REGION_FILES).join(', ')}`);
    process.exit(1);
  }

  const regions = REGION_ARG
    ? { [REGION_ARG]: REGION_FILES[REGION_ARG] }
    : REGION_FILES;

  let totalDone = 0, totalSkipped = 0, totalErrors = 0, totalNoData = 0;

  for (const [region, filename] of Object.entries(regions)) {
    const data = load(filename);
    const toProcess = data.filter(needsWork).slice(0, LIMIT);
    if (toProcess.length === 0) {
      console.log(`\n${region}: nothing to re-enrich (use --force to refresh existing data)`);
      continue;
    }
    console.log(`\n${region}: re-enriching ${toProcess.length} brands (concurrency ${CONCURRENCY}, model ${MODEL})...`);
    if (FORCE) console.log('  --force: overwriting existing data');

    let done = 0;
    const tasks = toProcess.map(brand => async () => {
      const result = await processBrand(client, brand, filename, data);
      done++;
      process.stdout.write(
        `\r  ${String(done).padStart(3)}/${toProcess.length} — ${brand.brandName.slice(0, 30).padEnd(30)} [${result}]`
      );
      if      (result === 'done')    totalDone++;
      else if (result === 'skip')    totalSkipped++;
      else if (result === 'no-data') totalNoData++;
      else                           totalErrors++;
    });

    await runPool(tasks, CONCURRENCY);
    console.log('');
  }

  console.log('\n--- Re-Enrich Results ---');
  console.log(`  Enriched:  ${totalDone}`);
  console.log(`  Skipped:   ${totalSkipped}`);
  console.log(`  No data:   ${totalNoData}`);
  console.log(`  Errors:    ${totalErrors}`);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
