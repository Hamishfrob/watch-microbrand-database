// scripts/dedupe.js
// Removes duplicate brandName entries across all regional files.
// When a brand appears in multiple files, keeps the entry with the most non-null fields.
// Run: node scripts/dedupe.js

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

const REGION_FILES = {
  'europe':       'microbrands-europe.json',
  'americas':     'microbrands-americas.json',
  'asia-pacific': 'microbrands-asia-pacific.json',
  'other':        'microbrands-other.json',
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

function richness(entry) {
  return Object.values(entry).filter(v => v !== null && v !== '' && v !== undefined).length;
}

// Load all files
const files = {};
for (const [region, filename] of Object.entries(REGION_FILES)) {
  files[region] = load(filename);
}

// Build a map: normalised brandName → { region, entry, richness }
const seen = new Map();
let removed = 0;

for (const [region, entries] of Object.entries(files)) {
  for (const entry of entries) {
    const key = (entry.brandName || '').toLowerCase().trim();
    if (!key) continue;
    const r = richness(entry);
    if (seen.has(key)) {
      const existing = seen.get(key);
      if (r > existing.richness) {
        console.log(`  DUPE: "${entry.brandName}" — keeping ${region} entry (richer), removing ${existing.region}`);
        seen.set(key, { region, entry, richness: r });
      } else {
        const reason = r === existing.richness ? 'equal richness, keeping first-seen' : 'richer';
        console.log(`  DUPE: "${entry.brandName}" — keeping ${existing.region} entry (${reason}), removing ${region}`);
      }
      removed++;
    } else {
      seen.set(key, { region, entry, richness: r });
    }
  }
}

// Rebuild files from deduplicated map
const rebuilt = Object.fromEntries(Object.keys(REGION_FILES).map(r => [r, []]));
for (const { region, entry } of seen.values()) {
  rebuilt[region].push(entry);
}

for (const [region, filename] of Object.entries(REGION_FILES)) {
  save(filename, rebuilt[region]);
}

console.log(`\nDone. Removed ${removed} duplicates.`);
for (const [region, entries] of Object.entries(rebuilt)) {
  console.log(`  ${region}: ${entries.length} brands`);
}
