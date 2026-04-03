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

// ─── Config ───────────────────────────────────────────────────────────────────

const DATA_DIR       = path.join(__dirname, '..', 'data');
const MODEL          = 'claude-haiku-4-5';
const FETCH_TIMEOUT  = 10_000;
const MAX_PAGE_CHARS = 6_000;
const MAX_ARTICLES_PER_SITE = 5; // hard cap per blog site regardless of --limit

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  if (idx === -1) return Infinity;
  const n = parseInt(process.argv[idx + 1], 10);
  if (isNaN(n) || n < 1) {
    console.error('Error: --limit requires a positive integer');
    process.exit(1);
  }
  return n;
})();

// ─── Sites ────────────────────────────────────────────────────────────────────

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

// ─── File I/O ─────────────────────────────────────────────────────────────────

function load(filename) {
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) return [];
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function save(filename, data) {
  if (DRY_RUN) return;
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
  if (DRY_RUN) return;
  const sorted = [...candidates].sort((a, b) =>
    (a.brandName || '').localeCompare(b.brandName || '', 'en', { sensitivity: 'base' })
  );
  fs.writeFileSync(CANDIDATES_FILE, JSON.stringify(sorted, null, 2), 'utf8');
}

// ─── HTTP + HTML ──────────────────────────────────────────────────────────────

async function fetchPage(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    const res = await fetch(url, {
      signal:   controller.signal,
      redirect: 'follow',
      headers:  { 'User-Agent': 'Mozilla/5.0 (compatible; WatchResearchBot/1.0)' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    return { html, finalUrl: res.url };
  } catch {
    return null;
  }
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi,   '')
    .replace(/<svg[\s\S]*?<\/svg>/gi,        '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g,  ' ')
    .replace(/&amp;/g,   '&')
    .replace(/&lt;/g,    '<')
    .replace(/&gt;/g,    '>')
    .replace(/&quot;/g,  '"')
    .replace(/\s+/g,     ' ')
    .trim()
    .slice(0, MAX_PAGE_CHARS);
}

function extractArticleLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const hrefs = [...html.matchAll(/href=["']([^"'#]{5,})["']/gi)].map(m => m[1]);
  const seen  = new Set();
  const links = [];

  for (const href of hrefs) {
    try {
      const url = new URL(href, baseUrl);
      // same domain only
      if (url.hostname !== base.hostname) continue;
      // must be a deeper path (not just / or /en/)
      const parts = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
      if (parts.length < 1) continue;
      // skip obvious nav pages
      const skip = /^(about|contact|category|tag|author|page|search|feed|wp-|cdn-|#)/i;
      if (skip.test(url.pathname)) continue;
      // prefer paths that look like posts (contain year or slug)
      const looksLikePost = /\/(20\d\d|review|article|blog|post|test|avis|montre|uhren|watch)/i.test(url.pathname);
      if (!looksLikePost) continue;

      const key = url.pathname;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push(url.href);
      if (links.length >= MAX_ARTICLES_PER_SITE) break;
    } catch { /* invalid href */ }
  }
  return links;
}
