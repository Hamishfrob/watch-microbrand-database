// scripts/build-spreadsheet.js
// Generates watch-microbrand-database.xlsx from all data/*.json files

const XLSX = require('../node_modules/xlsx');
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT   = path.join(__dirname, '..', 'watch-microbrand-database.xlsx');

const REGIONS = [
  { file: 'microbrands-europe',       tab: 'Europe'       },
  { file: 'microbrands-americas',     tab: 'Americas'     },
  { file: 'microbrands-asia-pacific', tab: 'Asia-Pacific' },
  { file: 'microbrands-other',        tab: 'Other'        },
];

const HEADERS = [
  'Brand Name', 'Country', 'Town/City', 'Founded', 'Price Low (USD)',
  'Price High (USD)', 'Status', 'Latest Model', 'Last Activity',
  'Website', 'Instagram', 'Source', 'Notes'
];

const COL_WIDTHS = [30, 18, 18, 10, 15, 15, 10, 25, 14, 35, 22, 12, 50];

function loadJSON(filename) {
  const filepath = path.join(DATA_DIR, filename + '.json');
  if (!fs.existsSync(filepath)) return [];
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

function toRow(b) {
  return [
    b.brandName        || '',
    b.country          || '',
    b.townCity         || '',
    b.foundedYear      ?? '',
    b.priceRangeLow    ?? '',
    b.priceRangeHigh   ?? '',
    b.status           || '',
    b.latestModel      || '',
    b.lastActivityDate || '',
    b.website          || '',
    b.instagramHandle  || '',
    b.source           || '',
    b.notes            || '',
  ];
}

function makeSheet(data) {
  const sorted = [...data].sort((a, b) =>
    a.brandName.localeCompare(b.brandName, 'en', { sensitivity: 'base' })
  );
  const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...sorted.map(toRow)]);
  ws['!cols'] = COL_WIDTHS.map(w => ({ wch: w }));
  return ws;
}

const wb = XLSX.utils.book_new();
const allBrands = [];

for (const { file, tab } of REGIONS) {
  const data = loadJSON(file);
  allBrands.push(...data);
  XLSX.utils.book_append_sheet(wb, makeSheet(data), tab);
  console.log(`  ${tab.padEnd(15)} ${data.length} brands`);
}

// --- Summary tab ---
const byCountry = {};
for (const b of allBrands) {
  byCountry[b.country] = (byCountry[b.country] || 0) + 1;
}
const countryRows = Object.entries(byCountry)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([c, n]) => [c, n]);

const statusCounts = ['Active', 'Dormant', 'Defunct'].map(s => [
  s, allBrands.filter(b => b.status === s).length
]);

const summaryData = [
  ['Watch Microbrand Database', ''],
  ['Last Updated', new Date().toISOString().split('T')[0]],
  ['', ''],
  ['Region', 'Total Brands'],
  ...REGIONS.map(r => [r.tab, loadJSON(r.file).length]),
  ['TOTAL', allBrands.length],
  ['', ''],
  ['Country', 'Count'],
  ...countryRows,
  ['', ''],
  ['Status', 'Count'],
  ...statusCounts,
];

const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
summarySheet['!cols'] = [{ wch: 25 }, { wch: 15 }];
XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');

XLSX.writeFile(wb, OUTPUT);
console.log('\nBuilt: ' + OUTPUT);
console.log('Total brands: ' + allBrands.length);
