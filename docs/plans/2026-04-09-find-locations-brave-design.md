# Design: find-locations-brave.js

**Date:** 2026-04-09
**Status:** Approved

## Problem

After running `re-enrich.js`, 296 brands in `other.json` still have no country — the
homepage fetch couldn't infer location from page content alone. Additionally, some
brands across all four region files have incorrect country assignments (e.g. Diatom
Watches listed as United States when it is a British brand).

## Goal

A dedicated script that uses Brave Search snippets + Claude Haiku to find and correct
country/city data across the entire database, while also enriching any other fields
(prices, founded year, latest model, Instagram, notes) that the snippets reveal —
maximising value from each Brave API call.

## Approach

New standalone script: `scripts/find-locations-brave.js`

Rationale for a new script (vs modifying re-enrich.js or find-websites-brave.js):
- Clean separation of concerns
- Can be run in isolation with `--limit` for cost-controlled testing
- Doesn't complicate scripts that are already working well

## Search Strategy

For each brand, two searches in sequence:

1. **Primary:** `"{BrandName} watches"` — broad, returns homepage + reviews +
   community posts that frequently name the country ("UK-based brand", "founded in Germany")
2. **Fallback** (only if primary yields no country): `"{BrandName} watches review"` —
   watch reviews reliably mention brand origin

Top 5 result snippets from each Brave response are passed to Haiku. No additional
page fetches — snippets come free in the Brave JSON response.

## Extraction

Each Brave call feeds a single Haiku extraction of **all schema fields**:

```
country, townCity, priceRangeLow, priceRangeHigh, foundedYear,
latestModel, status, lastActivityDate, instagramHandle, notes
```

Same schema and rules as `re-enrich.js`. Fields already populated in the JSON are
not overwritten unless `--force-location` (for country/townCity) or `--force` (all
fields) is passed.

## Flags

| Flag | Behaviour |
|------|-----------|
| `--region europe\|americas\|asia-pacific\|other` | Limit to one region (default: all four) |
| `--limit N` | Process at most N brands (for cost-controlled tests) |
| `--force-location` | Overwrite country/townCity even if already set |
| `--force` | Overwrite all fields |

Default target: brands where `country` is null. With `--force-location`: all brands.

## Cost Model

- **Brave API:** free tier = 2,000 queries/month. Each brand uses 1–2 queries.
  ~500 brands across all regions = 500–1,000 queries. Well within free tier.
- **Haiku:** snippets ~500–1,000 chars per brand. Estimated ~$0.002/brand.
  Full run across all regions: ~$1.

## Cost Control Rules

Per standing project rule — always run `--limit 3` first, check
console.anthropic.com usage dashboard, confirm per-brand cost, get explicit
sign-off before full run.

End-of-run summary reports: brands updated, fields filled per type, total Brave
queries used.

## Output

- Updates JSON files in `data/` in place (sorted alphabetically, same as other scripts)
- Console progress: `brand name [done|not-found|error]`
- Summary: enriched count, skipped, not-found, Brave queries used, fields populated
