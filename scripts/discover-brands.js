// scripts/discover-brands.js
//
// Weekly discovery script — two jobs:
//   1. Find brand names NOT in the DB → append to data/candidates.json
//   2. Find brand names IN the DB → update lastActivityDate (flag Dormant/Defunct for review)
//
// Site types:
//   directory — HTML list parse, zero AI calls (e.g. Chronoscout)
//   blog      — fetch recent articles, Haiku extracts brand names (~$0.01/article)
//
// Flags:
//   --dry-run   print what would change, no writes
//   --limit N   cap total articles fetched across all blog sites
//
// Run:       node scripts/discover-brands.js
// Dry test:  node scripts/discover-brands.js --dry-run --limit 5

'use strict';
require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');

const DATA_DIR       = path.join(__dirname, '..', 'data');
const MODEL          = 'claude-haiku-4-5';
const FETCH_TIMEOUT  = 10_000;
const MAX_PAGE_CHARS = 6_000;
const MAX_ARTICLES_PER_SITE = 5;

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT   = process.argv.includes('--limit')
  ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10)
  : Infinity;

const SITES = [
  {
    name: 'Chronoscout',
    url:  'https://chronoscout.co/en/brands/',
    type: 'directory',
  },
  {
    name: 'Mainspring Watch Magazine',
    url:  'https://www.mainspring.watch/',
    type: 'blog',
  },
  {
    name: 'The Timebum',
    url:  'https://www.thetimebum.com/',
    type: 'blog',
  },
  {
    name: 'Balance & Bridge',
    url:  'https://www.balanceandbridge.com/',
    type: 'blog',
  },
  {
    name: 'Hype & Style',
    url:  'https://www.hypeandstyle.fr/en/',
    type: 'blog',
  },
  {
    name: 'Kaminsky',
    url:  'https://kaminskyblog.com/',
    type: 'blog',
  },
  {
    name: 'Le Petit Poussoir',
    url:  'https://lepetitpoussoir.fr/',
    type: 'blog',
  },
  {
    name: 'Chrononautix',
    url:  'https://chrononautix.com/',
    type: 'blog',
  },
];

const ALL_REGION_FILES = [
  'microbrands-europe.json',
  'microbrands-americas.json',
  'microbrands-asia-pacific.json',
  'microbrands-other.json',
];

const CANDIDATES_FILE = path.join(DATA_DIR, 'candidates.json');

function load(filename) {
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) return [];
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function save(filename, data) {
  const sorted = [...data].sort((a, b) =>
    (a.brandName || '').localeCompare(b.brandName || '', 'en', { sensitivity: 'base' })
  );
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(sorted, null, 2), 'utf8');
}

function loadCandidates() {
  if (!fs.existsSync(CANDIDATES_FILE)) return [];
  return JSON.parse(fs.readFileSync(CANDIDATES_FILE, 'utf8'));
}

function saveCandidates(candidates) {
  fs.writeFileSync(CANDIDATES_FILE, JSON.stringify(candidates, null, 2), 'utf8');
}
