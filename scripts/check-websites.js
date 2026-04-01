// scripts/check-websites.js
// Checks every website URL in the microbrand database and reports status.
// Usage: node scripts/check-websites.js
//        node scripts/check-websites.js --errors-only

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const ERRORS_ONLY = process.argv.includes('--errors-only');
const TIMEOUT_MS  = 8000;
const CONCURRENCY = 10;

const DATA_FILES = [
  { file: 'microbrands-europe',       region: 'Europe'       },
  { file: 'microbrands-americas',     region: 'Americas'     },
  { file: 'microbrands-asia-pacific', region: 'Asia-Pacific' },
  { file: 'microbrands-other',        region: 'Other'        },
];

const C = {
  reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m',  grey: '\x1b[90m',  bold: '\x1b[1m', cyan: '\x1b[36m',
};

function colour(text, ...codes) { return codes.join('') + text + C.reset; }

function loadAllBrands() {
  const brands = [];
  for (const { file, region } of DATA_FILES) {
    const filepath = path.join(DATA_DIR, file + '.json');
    if (!fs.existsSync(filepath)) continue;
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    for (const brand of data) {
      brands.push({ ...brand, _region: region, _file: file });
    }
  }
  return brands;
}

function probe(url) {
  return new Promise((resolve) => {
    let timedOut = false;
    function attempt(method) {
      let urlObj;
      try { urlObj = new URL(url); } catch { return resolve({ status: 'INVALID_URL', code: null }); }
      const lib = urlObj.protocol === 'https:' ? https : http;
      const options = {
        hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search,
        method, timeout: TIMEOUT_MS,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WatchDBChecker/1.0)' },
      };
      const req = lib.request(options, (res) => {
        res.destroy();
        const code = res.statusCode;
        if (method === 'HEAD' && code === 405) return attempt('GET');
        if (code >= 200 && code < 300) return resolve({ status: 'OK', code });
        if (code >= 300 && code < 400) return resolve({ status: 'REDIRECT', code, location: res.headers.location });
        if (code >= 400 && code < 500) return resolve({ status: 'CLIENT_ERR', code });
        return resolve({ status: 'SERVER_ERR', code });
      });
      req.on('timeout', () => { timedOut = true; req.destroy(); resolve({ status: 'TIMEOUT', code: null }); });
      req.on('error', (err) => {
        if (timedOut) return;
        if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return resolve({ status: 'DOMAIN_NOT_FOUND', code: null });
        if (err.code === 'ECONNREFUSED') return resolve({ status: 'CONN_REFUSED', code: null });
        resolve({ status: 'ERROR', code: null, detail: err.code });
      });
      req.end();
    }
    attempt('HEAD');
  });
}

async function checkAll(brands) {
  const withUrls = brands.filter(b => b.website && b.website.trim() !== '');
  const noUrls   = brands.filter(b => !b.website || b.website.trim() === '');
  console.log(colour('\nWatch Microbrand Database — Website Health Check', C.bold));
  console.log(`Checking ${withUrls.length} URLs...`);
  if (noUrls.length > 0) console.log(colour(`${noUrls.length} entries have no URL (skipped)`, C.grey));
  console.log('');
  const results = [];
  let checked = 0;
  for (let i = 0; i < withUrls.length; i += CONCURRENCY) {
    const batch = withUrls.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(batch.map(async (brand) => {
      const result = await probe(brand.website);
      checked++;
      process.stdout.write(`\r  Checking: ${checked}/${withUrls.length}   `);
      return { brand, result };
    }));
    results.push(...settled);
  }
  process.stdout.write('\r' + ' '.repeat(40) + '\r');
  return { results, noUrls };
}

function statusLabel(r) {
  switch (r.status) {
    case 'OK':            return colour(`✓ ${r.code}`, C.green);
    case 'REDIRECT':      return colour(`→ ${r.code}${r.location ? ' → ' + r.location : ''}`, C.yellow);
    case 'CLIENT_ERR':    return colour(`✗ ${r.code} Client Error`, C.red);
    case 'SERVER_ERR':    return colour(`✗ ${r.code} Server Error`, C.red);
    case 'TIMEOUT':       return colour(`⏱ Timeout`, C.yellow);
    case 'DOMAIN_NOT_FOUND': return colour(`✗ Domain not found`, C.red);
    case 'CONN_REFUSED':  return colour(`✗ Connection refused`, C.red);
    case 'INVALID_URL':   return colour(`✗ Invalid URL`, C.red);
    default:              return colour(`✗ ${r.status}`, C.red);
  }
}

(async () => {
  const brands = loadAllBrands();
  const { results, noUrls } = await checkAll(brands);

  let ok = 0, problems = 0, redirects = 0;
  const problemList = [], redirectList = [];
  for (const { brand, result } of results) {
    if (result.status === 'OK') ok++;
    else if (result.status === 'REDIRECT') { redirects++; redirectList.push({ brand, result }); }
    else { problems++; problemList.push({ brand, result }); }
  }

  if (!ERRORS_ONLY) {
    const byRegion = {};
    for (const { brand, result } of results) {
      if (!byRegion[brand._region]) byRegion[brand._region] = [];
      byRegion[brand._region].push({ brand, result });
    }
    for (const [region, entries] of Object.entries(byRegion)) {
      console.log(colour(region, C.bold + C.cyan));
      for (const { brand, result } of entries) {
        console.log(`  ${brand.brandName.padEnd(35)} ${statusLabel(result)}`);
      }
      console.log('');
    }
  }

  console.log(colour('─'.repeat(60), C.grey));
  console.log(colour('Summary', C.bold));
  console.log(colour(`  ✓ OK:        ${ok}`, C.green));
  if (redirects > 0) console.log(colour(`  → Redirects: ${redirects}`, C.yellow));
  if (problems > 0)  console.log(colour(`  ✗ Problems:  ${problems}`, C.red));
  if (noUrls.length > 0) console.log(colour(`  — No URL:    ${noUrls.length}`, C.grey));
  console.log('');

  if (problemList.length > 0) {
    console.log(colour('Problems:', C.bold + C.red));
    for (const { brand, result } of problemList) {
      console.log(`  ${colour(brand.brandName, C.bold)} (${brand.country || 'unknown'})`);
      console.log(`    ${colour(brand.website, C.grey)}`);
      console.log(`    ${statusLabel(result)}`);
    }
  }
})();
