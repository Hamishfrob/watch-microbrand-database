# Design: discover-brands.js

**Date:** 2026-04-03
**Status:** Approved

## Purpose

Weekly script to scrape microbrand watch sites for two goals:
1. **Discovery** — find brand names not yet in the database, add to a candidates queue
2. **Status refresh** — find mentions of existing brands, update `lastActivityDate` as an Active signal

## Script

`scripts/discover-brands.js`

Follows existing script conventions: `--limit N`, `--dry-run` flags, saves after each site, prints cost estimate at end.

## Site Configs (hardcoded)

| Site | Type | Notes |
|------|------|-------|
| Chronoscout | `directory` | 270+ brand list, HTML parse only — no AI |
| Mainspring Watch Magazine | `blog` | English |
| The Timebum | `blog` | English |
| Balance & Bridge | `blog` | English |
| Hype & Style | `blog` | English (French site) |
| Kaminsky | `blog` | English |
| Le Petit Poussoir | `blog` | French — Haiku handles multilingual |
| Chrononautix | `blog` | German — Haiku handles multilingual |

## Data Flow

### Directory sites (Chronoscout)
1. Fetch the brands page
2. Parse brand names from HTML list/link elements
3. No AI calls — zero cost

### Blog sites
1. Fetch homepage
2. Extract article links from main content area (newest first — homepage always shows recent posts)
3. Cap at 5 articles per site per run
4. Fetch each article, send text to Claude Haiku
5. Haiku returns JSON array of watch brand names mentioned
6. ~$0.01/article → ~$0.25–0.40/week across all blog sites

### Matching
- Load all 4 regional JSON files into memory
- Build normalised lookup set (lowercase, trimmed)
- For each brand name found, check against lookup set

## DB Update Rules

| Existing status | Action |
|----------------|--------|
| `Active` | Update `lastActivityDate` to today |
| `Dormant` | Update `lastActivityDate`, flag for manual review in report |
| `Defunct` | Update `lastActivityDate`, flag for manual review in report |
| Not in DB | Append to `data/candidates.json` |

No automated status changes — all status decisions remain manual.

## Output Files

### `data/candidates.json`
Accumulates across runs. New entries appended, no duplicates.
```json
[
  {
    "brandName": "Example Watch Co",
    "sourceSite": "The Timebum",
    "sourceUrl": "https://...",
    "discoveredDate": "2026-04-03"
  }
]
```

### Console report (printed each run)
```
Run: 2026-04-03
──────────────────────────────
Sites checked:     8
Articles fetched:  31
Brands found:      87  unique names

DB matches updated: 14
Dormant flags:       2  → review: Brand A, Brand B
Defunct flags:       1  → review: Brand C

New candidates:     11  → written to data/candidates.json
──────────────────────────────
Estimated cost: ~$0.31
```

## Cost Profile

- Chronoscout: $0.00 (HTML parse)
- Blogs: ~$0.25–0.40/week (5 articles × 7 blog sites × ~$0.01)
- Monthly: ~$1–2

## Integration with Existing Pipeline

Candidates in `data/candidates.json` feed into the existing enrichment pipeline:
1. Review candidates manually
2. Move approved entries to the correct regional JSON file
3. Run `node scripts/re-enrich.js` to fill in price, founded year, latest model, etc.
