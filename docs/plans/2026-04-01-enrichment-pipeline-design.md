# Enrichment Pipeline — Design

**Date:** 2026-04-01
**Goal:** Deduplicate the database, exclude non-microbrands, assign countries/regions, and enrich brand data using a two-pass Claude API pipeline.

---

## Problem

After seeding from the location DB (171 brands, fully assigned) and importing from MBWDB (1278 brands, all in `microbrands-other.json` with `country: null`):

- 64 duplicate entries across files
- 1278 brands with no country, region, price, Instagram, founded year, or notes
- ~200–400 obvious non-microbrands (Rolex, Omega, fashion houses, smart watches etc.) mixed in

---

## Solution: Three-script pipeline

### Script 1: `scripts/dedupe.js`

Runs first. Scans all four regional JSON files for duplicate `brandName` values (case-insensitive). Keeps the entry with the most non-null fields (the seeded entry always wins over the MBWDB null entry). Removes the duplicate from `microbrands-other.json`. Saves all files and reports how many were removed.

### Script 2: `scripts/enrich-pass1.js` — Batch classification (Claude knowledge)

Reads all brands from `microbrands-other.json` where `country` is null. Sends batches of 50 brand names to `claude-haiku-4-5` (no web fetching, pure training knowledge). For each brand, Claude returns:

```json
{
  "brandName": "Baltic",
  "action": "keep",
  "country": "France",
  "region": "europe",
  "notes": "French microbrand founded in 2017, known for vintage-inspired dress watches..."
}
```

or:

```json
{
  "brandName": "Rolex",
  "action": "exclude",
  "reason": "luxury conglomerate"
}
```

**Exclusion criteria given to Claude:**
- Major watch groups: Rolex, Swatch Group brands, Richemont brands, LVMH brands, Kering brands
- High Horology / independent ateliers already in the companion location DB (Patek Philippe, AP, Vacheron, etc.)
- Fashion houses making watches (Gucci, Versace, Michael Kors, DKNY, Armani, etc.)
- Smart watch / tech brands (Apple, Samsung, Garmin, Fitbit, etc.)
- Price ceiling violations (known to be >$5,000 USD)
- Non-brand entries (e.g. "Promotional watches for businesses", "Android Wearables", "Moded Seikos")

**After Pass 1:**
- `action: exclude` → removed entirely
- `action: keep` with country → entry enriched, moved to correct regional file
- `action: keep` with `country: null` → stays in `other.json` for Pass 2

**Notes field:** Claude writes 1–3 factual sentences for brands it recognises: founding story, what the brand is known for, movement type, atelier location, anything distinctive. Style: _"Revived independent brand. Atelier in Geneva. Movement production partially in-house and via partners."_

### Script 3: `scripts/enrich-pass2.js` — Website enrichment (Claude + web fetch)

For brands still in `other.json` with `country: null` that have a website URL, fetches the homepage (and About page if linked). Sends HTML to `claude-haiku-4-5` asking for:

- `country` — country of origin
- `townCity` — city/town if found
- `foundedYear` — year founded
- `priceRangeLow` / `priceRangeHigh` — USD price range from shop/product pages
- `instagramHandle` — from footer social links
- `notes` — 1–3 sentence brand description from About content

Concurrency: 5 simultaneous requests (polite crawl). Timeout: 10s per page. Brands with no website, or where fetch fails, stay in `other.json` with `notes: "No website — manual review needed"`.

**After Pass 2:**
- Enriched brands with country → moved to correct regional file
- Still-unknown brands → remain in `other.json` for manual curation

---

## Region Mapping

Country → region assignment uses an extended lookup table:

| Region | Countries |
|--------|-----------|
| `europe` | UK, France, Germany, Switzerland, Italy, Spain, Netherlands, Belgium, Sweden, Denmark, Norway, Finland, Austria, Czech Republic, Hungary, Ireland, Poland, Portugal, and others |
| `americas` | USA, Canada, Brazil, Argentina, Mexico, Colombia, and others |
| `asia-pacific` | Japan, China, Singapore, Australia, Hong Kong, South Korea, Taiwan, Malaysia, New Zealand, India, and others |
| `other` | Middle East, Africa, Russia, Israel, unknown |

---

## Tech Stack

- Node.js, `@anthropic-ai/sdk` (npm install required)
- `claude-haiku-4-5` model for cost efficiency
- Built-in `https`/`http` for web fetching (no new deps)
- `ANTHROPIC_API_KEY` environment variable

---

## Estimated Cost

| Pass | Brands | Est. tokens | Est. cost |
|------|--------|-------------|-----------|
| Pass 1 | ~1200 in batches of 50 | ~300k | ~$0.10 |
| Pass 2 | ~200–400 website fetches | ~500k | ~$0.50 |
| **Total** | | | **~$0.60–1.00** |

---

## Success Criteria

- Zero duplicate brand names across all files
- Non-microbrands removed
- `microbrands-other.json` reduced to only genuinely unresolvable entries
- All resolvable brands in correct regional file with country assigned
- Notes field populated for all enriched brands
