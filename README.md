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

### Step 3 — Re-enrich with live web search (quality pass / monthly refresh)
```
node scripts/re-enrich.js
node scripts/re-enrich.js --region europe
node scripts/re-enrich.js --force          # overwrite all existing data (monthly refresh)
```
The highest-quality enrichment pass. Uses Claude with Anthropic's built-in web search and web fetch tools — no extra API keys needed:
- **Finds and verifies the official website** via live web search (fixes wrong URLs like Dufa → deutsche-uhrenfabrik.de)
- **Fetches homepage + shop/collection pages** for accurate price extraction
- **Assesses brand status** (Active / Dormant / Defunct) from current page content
- **Updates lastActivityDate** from live page signals (blog posts, new models, etc.)

### API keys required

| Key | Used by | Where to get |
|-----|---------|--------------|
| `ANTHROPIC_API_KEY` | All enrichment scripts | [console.anthropic.com](https://console.anthropic.com) |

Add to your `.env` file (see `.env.example`). No other API keys needed.

### Known limitations

- Some sites behind aggressive bot-protection may not be fetchable (~10–15% of brands)
- Prices are only found when displayed on accessible shop/collection pages
- Run `re-enrich.js --force` monthly to refresh status, prices, and latest models

---

## Scripts

| Script | Purpose |
|--------|---------|
| `build-spreadsheet.js` | Regenerate Excel from JSON files |
| `seed-from-existing-db.js` | One-shot: seed from 438-brand location DB |
| `import-mbwdb.js` | One-shot: import from mbwdb.com |
| `check-websites.js` | Health-check all website URLs |
| `find-websites.js` | Populate missing website URLs via Claude knowledge |
| `scrape-brands.js` | First-pass enrichment: homepage scrape + Claude extraction |
| `re-enrich.js` | Quality enrichment: URL verification via Brave Search, shop page following, status assessment |
| `dedupe.js` | Remove duplicate brand entries across regional files |

---

## Version History

| Version | Date | Notes |
|---------|------|-------|
| 1.0 | 2026-04-01 | Initial build. Seeded from existing location DB (Independent tier) + MBWDB import. |
| 1.1 | 2026-04-02 | Enrichment pipeline added. 451 brands enriched across Europe / Americas / Asia-Pacific. |
