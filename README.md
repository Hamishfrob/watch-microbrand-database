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

## Scripts

| Script | Purpose |
|--------|---------|
| `build-spreadsheet.js` | Regenerate Excel from JSON files |
| `seed-from-existing-db.js` | One-shot: seed from 438-brand location DB |
| `import-mbwdb.js` | One-shot: import from mbwdb.com |
| `check-websites.js` | Health-check all website URLs |

---

## Version History

| Version | Date | Notes |
|---------|------|-------|
| 1.0 | 2026-04-01 | Initial build. Seeded from existing location DB (Independent tier) + MBWDB import. |
