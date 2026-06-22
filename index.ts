// Supabase Edge Function — alternative to GitHub Actions for scheduling.
// Deploy with: supabase functions deploy run-ingest
// Schedule with pg_cron (run this SQL once in the Supabase SQL editor):
//
//   select cron.schedule(
//     'daily-grants-ingest',
//     '0 9 * * *',
//     $$
//     select net.http_post(
//       url := 'https://<your-project>.supabase.co/functions/v1/run-ingest',
//       headers := '{"Authorization": "Bearer <your-service-role-key>", "Content-Type": "application/json"}'::jsonb
//     );
//     $$
//   );
//
// NOTE: Deno (the Edge Function runtime) can't launch Playwright/Chromium —
// browser automation doesn't run in this environment. So this function is
// only suitable for the Grants.gov API source, not the CDE scraper.
// For CDE scraping, stick with the GitHub Actions workflow (ingest.yml),
// which runs on a full Ubuntu runner that CAN launch a real browser.
//
// In other words: this Edge Function is a partial alternative, not a full
// replacement for Option A. Most people should just use GitHub Actions.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const GRANTS_GOV_BASE = "https://api.grants.gov/v1/api";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

async function fetchGrantsGov(term) {
  const res = await fetch(`${GRANTS_GOV_BASE}/search2`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyword: term, rows: 25, oppStatuses: "forecasted|posted" }),
  });
  if (!res.ok) return [];
  const json = await res.json();
  return json?.data?.oppHits || [];
}

async function normalizeWithClaude(rawText) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system:
        "Convert this raw grant opportunity into JSON with fields: title, funding_source, description, eligibility_requirements, funding_amount_text, possible_funding_amount, deadline_text, is_recurring, category, focus_area, is_education_relevant. Use null where unstated. Output only JSON.",
      messages: [{ role: "user", content: rawText }],
    }),
  });
  const data = await res.json();
  const text = data?.content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return null;
  }
}

async function upsertGrant(row) {
  await fetch(`${SUPABASE_URL}/rest/v1/grants`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify(row),
  });
}

serve(async (_req) => {
  const terms = ["school district STEM", "K-12 literacy", "school mental health"];
  let count = 0;

  for (const term of terms) {
    const hits = await fetchGrantsGov(term);
    for (const hit of hits.slice(0, 10)) {
      const normalized = await normalizeWithClaude(JSON.stringify(hit));
      if (normalized?.is_education_relevant) {
        await upsertGrant({ ...normalized, source_name: "grants.gov" });
        count++;
      }
    }
  }

  return new Response(JSON.stringify({ ingested: count }), {
    headers: { "Content-Type": "application/json" },
  });
});
