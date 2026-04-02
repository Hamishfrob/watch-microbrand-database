// scripts/redistribute.js
//
// Moves brands from microbrands-other.json into the correct regional file
// based on their country field. Brands with no country stay in other.json.
//
// Run: node scripts/redistribute.js
// Dry run (no changes): node scripts/redistribute.js --dry-run

'use strict';
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DRY_RUN  = process.argv.includes('--dry-run');

// ─── Country → region mapping ─────────────────────────────────────────────────

const EUROPE = new Set([
  'Albania', 'Andorra', 'Austria', 'Belarus', 'Belgium', 'Bosnia and Herzegovina',
  'Bulgaria', 'Croatia', 'Cyprus', 'Czech Republic', 'Czechia', 'Denmark', 'Estonia',
  'Finland', 'France', 'Germany', 'Gibraltar', 'Greece', 'Hungary', 'Iceland',
  'Ireland', 'Italy', 'Kosovo', 'Latvia', 'Liechtenstein', 'Lithuania', 'Luxembourg',
  'Malta', 'Moldova', 'Monaco', 'Montenegro', 'Netherlands', 'North Macedonia',
  'Norway', 'Poland', 'Portugal', 'Romania', 'Russia', 'San Marino', 'Serbia',
  'Slovakia', 'Slovenia', 'Spain', 'Sweden', 'Switzerland', 'Ukraine',
  'United Kingdom', 'UK', 'England', 'Scotland', 'Wales', 'Vatican',
]);

const AMERICAS = new Set([
  'Antigua and Barbuda', 'Argentina', 'Bahamas', 'Barbados', 'Belize', 'Bolivia',
  'Brazil', 'Canada', 'Chile', 'Colombia', 'Costa Rica', 'Cuba', 'Dominica',
  'Dominican Republic', 'Ecuador', 'El Salvador', 'Grenada', 'Guatemala', 'Guyana',
  'Haiti', 'Honduras', 'Jamaica', 'Mexico', 'Nicaragua', 'Panama', 'Paraguay',
  'Peru', 'Puerto Rico', 'Saint Kitts and Nevis', 'Saint Lucia',
  'Saint Vincent and the Grenadines', 'Suriname', 'Trinidad and Tobago',
  'United States', 'USA', 'US', 'Uruguay', 'Venezuela',
]);

const ASIA_PACIFIC = new Set([
  'Afghanistan', 'Australia', 'Bangladesh', 'Bhutan', 'Brunei', 'Cambodia', 'China',
  'Fiji', 'Hong Kong', 'India', 'Indonesia', 'Japan', 'Kazakhstan', 'Kiribati',
  'Kyrgyzstan', 'Laos', 'Macau', 'Malaysia', 'Maldives', 'Marshall Islands',
  'Micronesia', 'Mongolia', 'Myanmar', 'Nauru', 'Nepal', 'New Zealand',
  'North Korea', 'Pakistan', 'Palau', 'Papua New Guinea', 'Philippines',
  'Samoa', 'Singapore', 'Solomon Islands', 'South Korea', 'Korea', 'Sri Lanka',
  'Taiwan', 'Tajikistan', 'Thailand', 'Timor-Leste', 'Tonga', 'Turkmenistan',
  'Tuvalu', 'Uzbekistan', 'Vanuatu', 'Vietnam',
]);

function getRegion(country) {
  if (!country) return null;
  const c = country.trim();
  if (EUROPE.has(c))       return 'europe';
  if (AMERICAS.has(c))     return 'americas';
  if (ASIA_PACIFIC.has(c)) return 'asia-pacific';
  return null; // Middle East, Africa, unknown — stays in other
}

// ─── File I/O ─────────────────────────────────────────────────────────────────

function load(filename) {
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) return [];
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function save(filename, data) {
  const sorted = [...data].sort((a, b) =>
    (a.brandName || '').localeCompare(b.brandName || '', 'en', { sensitivity: 'base' })
  );
  if (!DRY_RUN) {
    fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(sorted, null, 2), 'utf8');
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const REGION_FILES = {
  'europe':       'microbrands-europe.json',
  'americas':     'microbrands-americas.json',
  'asia-pacific': 'microbrands-asia-pacific.json',
};

const other    = load('microbrands-other.json');
const regional = {
  'europe':       load('microbrands-europe.json'),
  'americas':     load('microbrands-americas.json'),
  'asia-pacific': load('microbrands-asia-pacific.json'),
};

const counts   = { europe: 0, americas: 0, 'asia-pacific': 0, staying: 0, noCountry: 0 };
const staying  = [];

for (const brand of other) {
  const region = getRegion(brand.country);
  if (region) {
    // Check for duplicate by brandName
    const existing = regional[region].find(
      b => b.brandName.toLowerCase() === brand.brandName.toLowerCase()
    );
    if (existing) {
      console.log(`  SKIP (duplicate): ${brand.brandName} already in ${region}`);
      continue;
    }
    regional[region].push(brand);
    counts[region]++;
    if (DRY_RUN) console.log(`  → ${region.padEnd(12)} ${brand.brandName} (${brand.country})`);
  } else {
    staying.push(brand);
    if (!brand.country) counts.noCountry++;
    else counts.staying++;
  }
}

// Save all files
for (const [region, filename] of Object.entries(REGION_FILES)) {
  save(filename, regional[region]);
}
save('microbrands-other.json', staying);

console.log('\n--- Redistribute Results ---');
console.log(`  → Europe:        ${counts.europe}`);
console.log(`  → Americas:      ${counts.americas}`);
console.log(`  → Asia-Pacific:  ${counts['asia-pacific']}`);
console.log(`  Staying (no region match): ${counts.staying} (Middle East, Africa, etc.)`);
console.log(`  Staying (no country):      ${counts.noCountry}`);
console.log(`  Remaining in other.json:   ${staying.length}`);
if (DRY_RUN) console.log('\n  (dry run — no files written)');
