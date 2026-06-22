# Colorado Education Grants Pipeline

Automated pipeline that:
1. Loads **every Colorado school district** into Supabase (from NCES + CDE data)
2. Pulls **grants from multiple sources** (Grants.gov API, CDE scraper, Candid/GrantWatch API)
3. Uses **Claude** to normalize messy text into clean structured fields
4. Upserts everything into Supabase, deduped
5. Runs on a **schedule** (cron) so data stays fresh without manual CSV pasting

```
                ┌─────────────────┐
                │   Scheduler      │  (GitHub Actions cron, OR Supabase Edge Function + pg_cron)
                └─────────┬────────┘
                          │ triggers
                          ▼
        ┌──────────────────────────────────┐
        │         ingest/index.js          │   orchestrator
        └───────────────┬───────────────────┘
         ┌───────────────┼───────────────────┐
         ▼               ▼                   ▼
  districts.js     grantsGov.js        cdeScraper.js / candidClient.js
  (NCES + CDE)     (Grants.gov API)    (scrape / aggregator API)
         │               │                   │
         └───────────────┴─────────┬─────────┘
                                    ▼
                          normalizeWithClaude.js
                          (cleans + structures raw records)
                                    ▼
                            supabaseClient.js
                          (upsert, dedupe, log run)
                                    ▼
                              Supabase DB
                                    ▼
                     Your frontend (StackBlitz/Next.js/etc.)
                         just SELECTs from Supabase
```

## Setup

```bash
npm install
cp .env.example .env   # fill in your keys
```

Required env vars (`.env`):
```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=     # service role, not anon — needed for writes from a backend job
ANTHROPIC_API_KEY=
GRANTS_GOV_API_BASE=https://api.grants.gov/v1/api
# Optional, if/when you get one:
CANDID_API_KEY=
```

## Run it once manually

```bash
node ingest/index.js --source=districts
node ingest/index.js --source=grants-gov
node ingest/index.js --source=cde
node ingest/index.js --source=all
```

## Run it on a schedule

Two options — pick one, don't need both:

**Option A — GitHub Actions (simplest, free, recommended to start)**
See `.github/workflows/ingest.yml`. Runs `node ingest/index.js --source=all` daily.

**Option B — Supabase Edge Function + pg_cron**
See `supabase/functions/run-ingest/`. Good if you want everything inside Supabase's
infra instead of GitHub. Slightly more setup (Deno runtime, function deploy).

## Files

- `sql/schema.sql` — run this once in the Supabase SQL editor to create tables
- `ingest/districts.js` — pulls all CO districts from NCES CCD + CDE org list
- `ingest/grantsGov.js` — pulls grants from the real Grants.gov search API
- `ingest/cdeScraper.js` — scrapes CDE's Competitive Grants Forecast page (no API exists)
- `ingest/candidClient.js` — stub for Candid/GrantWatch API (needs a paid key — see notes inside)
- `ingest/normalizeWithClaude.js` — sends raw scraped/API text to Claude, gets back clean structured JSON matching your schema
- `ingest/supabaseClient.js` — upsert + dedupe + run-logging helpers
- `ingest/index.js` — orchestrator, run with `--source=`
- `.github/workflows/ingest.yml` — scheduled job definition

## Notes on realistic grant volume

Grants.gov + CDE alone will get you 40-80 real, verifiable rows. To meaningfully
grow beyond that without fabricating data, you need a licensed aggregator
(Candid Foundation Directory API or GrantWatch's data feed) — both have actual
APIs/exports meant for exactly this kind of integration. `candidClient.js` is
stubbed out and ready for when you have a key.
