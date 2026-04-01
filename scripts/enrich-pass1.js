// scripts/enrich-pass1.js
require('dotenv').config();
// Pass 1: Send brand names in batches to Claude API (no web fetching).
// Claude classifies each brand (keep/exclude), assigns country from training knowledge,
// and writes a short notes field for brands it recognises.
// Brands with unknown country are left in other.json for Pass 2.
// Run: node scripts/enrich-pass1.js
// Run with limit: node scripts/enrich-pass1.js --limit 100

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LIMIT    = process.argv.includes('--limit')
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

const SYSTEM_PROMPT = `You are a watch industry expert helping curate a database of microbrand and independent watch brands.

For each brand name provided, you must classify it and return a JSON array.

EXCLUDE (action: "exclude") any brand that is:
- Owned by a major watch group: Rolex Group (Rolex, Tudor), Swatch Group (Omega, Longines, Tissot, Rado, Hamilton, Certina, Mido, Swatch, Breguet, Blancpain, Glashutte Original, Jaquet Droz, Leon Hatot), Richemont (Cartier, IWC, Jaeger-LeCoultre, Panerai, Piaget, Vacheron Constantin, Baume & Mercier, Roger Dubuis, Lange & Sohne, Officine Panerai), LVMH (TAG Heuer, Hublot, Zenith, Bulgari), Kering (Ulysse Nardin, Girard-Perregaux), Citizen Group (Citizen, Bulova, Frederique Constant, Alpina), Seiko Group (Seiko, Grand Seiko, Credor, Orient, Lorus, Pulsar)
- A fashion/luxury house: Gucci, Versace, Michael Kors, Armani, DKNY, Boss, Diesel, Dolce & Gabbana, Ralph Lauren, Tory Burch, Salvatore Ferragamo, Maserati, Jaguar, Porsche Design
- A smart watch or tech brand: Apple, Samsung, Garmin, Fitbit, Fossil (parent company), any Android wearable
- Clearly priced above $5,000 USD (ultra-high-end independents like Greubel Forsey, MB&F, FP Journe, Richard Mille, De Bethune, Philippe Dufour, Kari Voutilainen, Romain Gauthier, Patek Philippe, Audemars Piguet)
- Not a watch brand at all (e.g. "Promotional watches for businesses", "Moded Seikos", "All watches offered on Alibaba & DH Gate", "Test", "Android Wearables")
- A generic/white-label manufacturer (e.g. Parnis, Pagani Design, San Martin when sold purely as homages)

For brands you recognise as legitimate microbrands or independent brands under $5,000, return action: "keep" with:
- country: the country where the brand is based (use standard English country names, e.g. "United Kingdom" not "UK" or "England")
- notes: 1-3 sentences about the brand — founding story, what they are known for, movement type, atelier location, price range if known. Style: factual, concise. Example: "French microbrand founded in 2017. Known for vintage-inspired dive and dress watches with in-house designed dials. Swiss-assembled using ETA and Sellita movements."

For brands you do not recognise or are unsure about, return action: "keep", country: null, notes: null. Do NOT guess or fabricate.

Return ONLY a valid JSON array. No markdown, no explanation. Example:
[
  {"brandName": "Baltic", "action": "keep", "country": "France", "notes": "French microbrand..."},
  {"brandName": "Rolex", "action": "exclude", "reason": "Rolex Group"},
  {"brandName": "UnknownBrand", "action": "keep", "country": null, "notes": null}
]`;

async function processBatch(client, brands) {
  const names = brands.map(b => b.brandName);
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `Classify these watch brands:\n${JSON.stringify(names)}`
    }],
    system: SYSTEM_PROMPT,
  });

  const text = message.content[0].text.trim();
  const json = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(json);
}

async function run() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const regionData = {};
  for (const [region, filename] of Object.entries(REGION_FILES)) {
    regionData[region] = load(filename);
  }

  const toProcess = regionData['other']
    .filter(b => !b.country)
    .slice(0, LIMIT);

  console.log(`Processing ${toProcess.length} brands in Pass 1...`);

  const BATCH_SIZE = 50;
  let kept = 0, excluded = 0, assignedCountry = 0, stillUnknown = 0;
  const excludedNames = new Set();

  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    const batch = toProcess.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(toProcess.length / BATCH_SIZE);
    process.stdout.write(`\r  Batch ${batchNum}/${totalBatches}...`);

    let results;
    try {
      results = await processBatch(client, batch);
    } catch (err) {
      console.error(`\n  ERROR in batch ${batchNum}: ${err.message}`);
      continue;
    }

    for (const result of results) {
      const entry = regionData['other'].find(
        b => b.brandName.toLowerCase() === result.brandName.toLowerCase()
      );
      if (!entry) continue;

      if (result.action === 'exclude') {
        excludedNames.add(result.brandName.toLowerCase());
        excluded++;
        console.log(`\n  EXCLUDE: ${result.brandName} (${result.reason || 'flagged'})`);
        continue;
      }

      if (result.notes) entry.notes = result.notes;

      if (result.country) {
        entry.country = result.country;
        const region = COUNTRY_TO_REGION[result.country] || 'other';
        if (region !== 'other') {
          regionData[region].push(entry);
          assignedCountry++;
          console.log(`\n  MOVED [${region}]: ${entry.brandName} (${result.country})`);
        }
      } else {
        stillUnknown++;
      }
      kept++;
    }
  }

  // Remove excluded and moved entries from other.json
  regionData['other'] = regionData['other'].filter(b => {
    if (excludedNames.has(b.brandName.toLowerCase())) return false;
    if (b.country && COUNTRY_TO_REGION[b.country] && COUNTRY_TO_REGION[b.country] !== 'other') return false;
    return true;
  });

  // Save all files
  for (const [region, filename] of Object.entries(REGION_FILES)) {
    save(filename, regionData[region]);
  }

  process.stdout.write('\n');
  console.log('\n--- Pass 1 Results ---');
  console.log(`  Kept:             ${kept}`);
  console.log(`  Excluded:         ${excluded}`);
  console.log(`  Assigned country: ${assignedCountry}`);
  console.log(`  Still unknown:    ${stillUnknown}`);
  for (const [region, filename] of Object.entries(REGION_FILES)) {
    console.log(`  ${region}: ${regionData[region].length} brands`);
  }
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
