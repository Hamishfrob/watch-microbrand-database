// scripts/seed-from-existing-db.js
// One-shot: extracts Independent-tier brands from the 438-brand location DB
// and seeds them into the microbrand database regional files.
// Run once: node scripts/seed-from-existing-db.js

const fs   = require('fs');
const path = require('path');

const SRC_DIR  = 'C:/Users/hamis/OneDrive/Coding/watch-brand-location-database/data';
const DEST_DIR = path.join(__dirname, '..', 'data');

// Source files and country mapping
const SOURCES = [
  { file: 'uk.json',          country: 'United Kingdom', region: 'europe'       },
  { file: 'france.json',      country: 'France',         region: 'europe'       },
  { file: 'germany.json',     country: 'Germany',        region: 'europe'       },
  { file: 'switzerland.json', country: 'Switzerland',    region: 'europe'       },
  { file: 'usa.json',         country: 'USA',            region: 'americas'     },
  { file: 'japan.json',       country: 'Japan',          region: 'asia-pacific' },
  { file: 'other.json',       country: null,             region: null           }, // mixed
];

// Region file names
const REGION_FILES = {
  'europe':       'microbrands-europe.json',
  'americas':     'microbrands-americas.json',
  'asia-pacific': 'microbrands-asia-pacific.json',
  'other':        'microbrands-other.json',
};

// "Other" country → region mapping
const COUNTRY_TO_REGION = {
  'Netherlands':    'europe',
  'Belgium':        'europe',
  'Sweden':         'europe',
  'Denmark':        'europe',
  'Ireland':        'europe',
  'Spain':          'europe',
  'Italy':          'europe',
  'Czech Republic': 'europe',
  'Hungary':        'europe',
  'Austria':        'europe',
  'Malaysia':       'asia-pacific',
  'China':          'asia-pacific',
  'Singapore':      'asia-pacific',
  'Australia':      'asia-pacific',
};

function load(filepath) {
  if (!fs.existsSync(filepath)) return [];
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

function save(filename, data) {
  data.sort((a, b) =>
    a.brandName.localeCompare(b.brandName, 'en', { sensitivity: 'base' })
  );
  fs.writeFileSync(
    path.join(DEST_DIR, filename),
    JSON.stringify(data, null, 2),
    'utf8'
  );
}

function makeEntry(brand, country) {
  return {
    brandName:        brand.brandName,
    country:          country,
    townCity:         brand.townCity || null,
    foundedYear:      null,
    priceRangeLow:    null,
    priceRangeHigh:   null,
    status:           'Active',
    latestModel:      null,
    lastActivityDate: null,
    website:          brand.website  || null,
    instagramHandle:  null,
    source:           'existing-db',
    notes:            brand.notes    || null,
  };
}

// Load destination files
const dest = {};
for (const [key, filename] of Object.entries(REGION_FILES)) {
  dest[key] = load(path.join(DEST_DIR, filename));
}

function alreadyExists(region, brandName) {
  return dest[region].some(
    b => b.brandName.toLowerCase() === brandName.toLowerCase()
  );
}

let added = 0;
let skipped = 0;

for (const { file, country, region } of SOURCES) {
  const brands = load(path.join(SRC_DIR, file));

  for (const brand of brands) {
    if (brand.tier !== 'Independent') continue;

    let resolvedCountry = country;
    let resolvedRegion  = region;

    // For other.json: parse country from townCity ("City, Country" format)
    if (!country) {
      const parts = (brand.townCity || '').split(',');
      resolvedCountry = parts.length > 1 ? parts[parts.length - 1].trim() : 'Unknown';
      resolvedRegion  = COUNTRY_TO_REGION[resolvedCountry] || 'other';
    }

    if (alreadyExists(resolvedRegion, brand.brandName)) {
      console.log(`  SKIP (exists): ${brand.brandName}`);
      skipped++;
      continue;
    }

    dest[resolvedRegion].push(makeEntry(brand, resolvedCountry));
    console.log(`  ADDED [${resolvedRegion}]: ${brand.brandName} (${resolvedCountry})`);
    added++;
  }
}

// Save all
for (const [key, filename] of Object.entries(REGION_FILES)) {
  save(filename, dest[key]);
}

console.log(`\nDone. Added: ${added}, Skipped: ${skipped}`);
