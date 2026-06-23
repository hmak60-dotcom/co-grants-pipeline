-- =========================================================
-- Colorado Education Grants Pipeline — Supabase Schema
-- =========================================================

-- ---------------------------------------------------------
-- DISTRICTS
-- One row per Colorado school district / BOCES.
-- Populated from NCES CCD + CDE Organization list (see ingest/districts.js)
-- ---------------------------------------------------------
create table if not exists districts (
  id                  uuid primary key default gen_random_uuid(),
  nces_district_id    text unique,           -- federal NCES LEAID, stable cross-reference key
  cde_org_code        text,                  -- Colorado Dept. of Education org code
  name                text not null,
  county              text,
  district_type       text,                  -- e.g. 'School District', 'BOCES', 'Charter Authorizer'
  address             text,
  city                text,
  state               text default 'CO',
  zip                 text,
  phone               text,
  website             text,
  enrollment          integer,
  urbanicity          text,                  -- 'Rural', 'Suburban', 'Urban', 'Town'
  locale_code         text,                  -- NCES locale code, e.g. '41' rural fringe
  latitude            double precision,
  longitude           double precision,
  raw_source_payload  jsonb,                 -- full original record for audit/debug
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

create index if not exists idx_districts_name on districts using gin (to_tsvector('english', name));
create index if not exists idx_districts_county on districts (county);

-- ---------------------------------------------------------
-- GRANTS
-- One row per distinct grant program. Refreshed on a schedule.
-- ---------------------------------------------------------
create table if not exists grants (
  id                          uuid primary key default gen_random_uuid(),
  source_key                 text unique,     -- stable dedupe key, e.g. hash(title+funder+source_url)
  title                       text not null,
  funding_source              text,
  description                 text,
  eligibility_requirements     text,
  funding_amount_text         text,
  possible_funding_amount      numeric,
  deadline_text               text,           -- human-readable deadline / cycle as published
  deadline_date                date,           -- parsed date, if determinable
  is_recurring                 boolean default false,
  category                     text,           -- one of your fixed category enum (see CHECK below)
  focus_area                   text[],         -- array of tags: stem, literacy, ell, etc.
  source_name                  text,           -- 'grants.gov', 'cde', 'candid', 'grantwatch', etc.
  source_url                   text,
  status                       text default 'active', -- active | expired | unknown
  first_seen_at                timestamptz default now(),
  last_seen_at                 timestamptz default now(),
  raw_payload                  jsonb,          -- original scraped/API record, for audit + re-normalization
  created_at                   timestamptz default now(),
  updated_at                   timestamptz default now(),
  constraint chk_category check (category in (
    'Education','STEM','Technology','Teacher Development','Mental Health','Literacy',
    'Career & Technical Education','English Language Learners','Special Education',
    'School Improvement','Arts','Workforce Development','Research','Other'
  ))
);

create index if not exists idx_grants_category on grants (category);
create index if not exists idx_grants_status on grants (status);
create index if not exists idx_grants_focus_area on grants using gin (focus_area);
create index if not exists idx_grants_title on grants using gin (to_tsvector('english', title || ' ' || coalesce(description,'')));

-- ---------------------------------------------------------
-- DISTRICT <-> GRANT ELIGIBILITY MATCH (optional, computed)
-- Lets you query "grants this district can apply for" without
-- re-running matching logic on every page load.
-- ---------------------------------------------------------
create table if not exists district_grant_matches (
  id            uuid primary key default gen_random_uuid(),
  district_id   uuid references districts(id) on delete cascade,
  grant_id      uuid references grants(id) on delete cascade,
  match_score   numeric,         -- 0-1 confidence from matching logic
  match_reason  text,            -- short explanation, e.g. 'rural eligibility + literacy focus'
  created_at    timestamptz default now(),
  unique (district_id, grant_id)
);

-- ---------------------------------------------------------
-- INGESTION RUN LOG
-- Track each pipeline run for observability/debugging.
-- ---------------------------------------------------------
create table if not exists ingestion_runs (
  id              uuid primary key default gen_random_uuid(),
  source_name     text not null,
  started_at      timestamptz default now(),
  finished_at     timestamptz,
  records_found   integer,
  records_inserted integer,
  records_updated integer,
  records_failed  integer,
  status          text,          -- 'success' | 'partial' | 'failed'
  error_log       jsonb,
  created_at      timestamptz default now()
);

-- ---------------------------------------------------------
-- Auto-update updated_at on row changes
-- ---------------------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_districts_updated_at on districts;
create trigger trg_districts_updated_at before update on districts
  for each row execute function set_updated_at();

drop trigger if exists trg_grants_updated_at on grants;
create trigger trg_grants_updated_at before update on grants
  for each row execute function set_updated_at();
