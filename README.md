# Watch Microbrand Database

A monitoring database of microbrand and startup watch brands from around the world.

Companion to the [watch-brand-location-database](../watch-brand-location-database) (luxury/independent ateliers for tour visits).

---

## Purpose

- Outreach for The Watch Collectors' Club watch shows (UK)
- Monitor brand activity and status over time
- Track the global microbrand landscape

---

## File

`watch-microbrand-database.xlsx`

---

## Spreadsheet Structure

### Regional Tabs

One tab per region. Each row is one brand.

| Column | Meaning |
|--------|---------|
| Brand Name | Official brand name |
| Country | Country of origin |
| Town/City | Workshop/studio city |
| Founded | Year established |
| Price Low (USD) | Lowest current model price |
| Price High (USD) | Highest current model price |
| Status | Active / Dormant / Defunct |
| Latest Model | Most recent watch name/ref |
| Last Activity | Date of last confirmed activity |
| Website | Official website |
| Instagram | Handle (without @) |
| Source | MBWDB / existing-db / manual |
| Notes | Anything relevant |

**Regions:** Europe · Americas · Asia-Pacific · Other

### Summary Tab

Counts by region, country, and status. Last updated date.

---

## Status Definitions

| Status | Meaning |
|--------|---------|
| Active | Confirmed selling watches in the last 12 months |
| Dormant | No activity for 12+ months, not confirmed closed |
| Defunct | Website down, socials dead, no activity for 2+ years |

---

## Constraints

- Price ceiling: under $5,000 USD
- Kickstarter delivery must be complete before inclusion
- Watches must be actively for sale or have been sold
- No group-owned / conglomerate brands

---

## How to Update

1. Edit JSON files in `data/`
2. Sort entries alphabetically by `brandName`
3. Run `node scripts/build-spreadsheet.js` to rebuild the Excel file
4. Commit both JSON changes and rebuilt spreadsheet

**To check for defunct websites:**
```
node scripts/check-websites.js               # full report
node scripts/check-websites.js --errors-only  # problems only
```

---

## Enrichment Pipeline

Data quality comes from a three-step pipeline. Run these in order when building or refreshing the database.

### Step 1 — Find websites (Claude knowledge)
```
node scripts/find-websites.js
node scripts/find-websites.js --region europe
```
Uses Claude's training knowledge to populate missing website URLs in batches of 50. Fast and cheap. Gets ~80% of missing URLs. Run once when adding new brands.

### Step 2 — Scrape and extract (first pass)
```
node scripts/scrape-brands.js
node scripts/scrape-brands.js --region europe
```
Fetches each brand homepage. Extracts Instagram handles via regex. Sends page text to Claude Haiku for prices, founded year, latest model, and notes. Fills nulls only — never overwrites existing data.

### Step 3 — Re-enrich (quality pass / monthly refresh)
```
node scripts/re-enrich.js
node scripts/re-enrich.js --region europe
node scripts/re-enrich.js --force            # overwrite all existing data (monthly refresh)
node scripts/re-enrich.js --force-location   # overwrite country/townCity only
```
The highest-quality enrichment pass. Fetches brand homepages + shop pages manually (no Anthropic web tools — too expensive), sends stripped page text to Claude Haiku for extraction:
- **Fetches homepage + shop/collection pages** for accurate price extraction
- **Assesses brand status** (Active / Dormant / Defunct) from current page content
- **Updates lastActivityDate** from live page signals

### Step 3b — Location enrichment via Brave Search
```
node scripts/find-locations-brave.js
node scripts/find-locations-brave.js --region other
node scripts/find-locations-brave.js --force-location   # re-check/correct existing countries
```
Uses Brave Search snippets + Claude Haiku to find and correct country/city data when homepage content alone isn't enough. Extracts all schema fields from search snippets — no extra page fetches. Run after `re-enrich.js` for brands still missing a country, or with `--force-location` to fix known incorrect locations.
- **Primary search:** `"{BrandName} watches"` — broad, surfaces reviews and community posts naming the country
- **Fallback search:** `"{BrandName} watches review"` — if primary yields no country
- Brave free tier: 2,000 queries/month (sufficient for the full database)
- Cost: ~$0.002/brand Haiku cost; Brave queries are free tier

### Step 4 — Weekly discovery (new brands + activity refresh)
```
node scripts/discover-brands.js            # full run
node scripts/discover-brands.js --dry-run  # preview only, no writes
node scripts/discover-brands.js --limit 5  # cap AI calls for testing
```
Scrapes 8 microbrand watch sites weekly to:
- **Discover new brands** not yet in the DB → written to `data/candidates.json` for review
- **Refresh activity signals** for existing brands → updates `lastActivityDate`
- **Flag Dormant/Defunct** brands that appear in reviews (for manual status review)

Sites covered: Chronoscout (directory, zero AI), Mainspring, The Timebum, Balance & Bridge, Hype & Style, Kaminsky, Le Petit Poussoir, Chrononautix.

Cost: ~$0.25/week. Candidates require manual review before promotion to regional files.

### API keys required

| Key | Used by | Where to get |
|-----|---------|--------------|
| `ANTHROPIC_API_KEY` | All enrichment + discovery scripts | [console.anthropic.com](https://console.anthropic.com) |
| `BRAVE_API_KEY` | `re-enrich.js` (URL verification) | [brave.com/search/api](https://brave.com/search/api) — free tier |

Add to your `.env` file.

### Known limitations

- Some sites behind aggressive bot-protection may not be fetchable (~10–15% of brands)
- Prices are only found when displayed on accessible shop/collection pages
- `discover-brands.js` candidates include false positives — always review before adding to DB
- Run `re-enrich.js --force` monthly to refresh status, prices, and latest models

---

## Scripts

| Script | Purpose |
|--------|---------|
| `build-spreadsheet.js` | Regenerate Excel from JSON files |
| `discover-brands.js` | Weekly discovery: scrape 8 sites, find new brands + refresh activity dates |
| `re-enrich.js` | Quality enrichment: URL verification via Brave Search, shop page following, status assessment |
| `check-websites.js` | Health-check all website URLs |
| `find-websites.js` | Populate missing website URLs via Claude knowledge |
| `find-websites-brave.js` | Populate missing website URLs via Brave Search |
| `find-locations-brave.js` | Find/correct country + city via Brave Search snippets + Haiku |
| `scrape-brands.js` | First-pass enrichment: homepage scrape + Claude extraction |
| `dedupe.js` | Remove duplicate brand entries across regional files |
| `seed-from-existing-db.js` | One-shot: seed from 438-brand location DB |
| `import-mbwdb.js` | One-shot: import from mbwdb.com |

---

## Version History

| Version | Date | Notes |
|---------|------|-------|
| 1.0 | 2026-04-01 | Initial build. Seeded from existing location DB (Independent tier) + MBWDB import. |
| 1.1 | 2026-04-02 | Enrichment pipeline added. 451 brands enriched across Europe / Americas / Asia-Pacific. |
| 1.2 | 2026-04-04 | Weekly discovery script added (`discover-brands.js`). 1,241 brands. First discovery run: 229 activity dates refreshed, 125 candidates queued. |
| 1.3 | 2026-04-09 | Location enrichment pipeline added (`find-locations-brave.js`). Deduplication pass. Full re-enrich + Brave location run on other.json: 179/318 brands now have country data. 1,237 brands total. |
