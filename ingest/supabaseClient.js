import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config();

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

/**
 * Stable dedupe key for a grant, independent of source.
 * Two scrapers finding "the same" grant under slightly different
 * descriptions should still collapse to one row.
 */
export function makeGrantSourceKey({ title, funding_source, source_url }) {
  const normalized = `${(title || "").trim().toLowerCase()}|${(funding_source || "").trim().toLowerCase()}`;
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32) + (source_url ? "" : "");
}

/**
 * Upsert a batch of normalized grant rows.
 * Relies on the unique constraint on grants.source_key.
 */
export async function upsertGrants(grantRows) {
  if (!grantRows.length) return { inserted: 0, updated: 0, failed: 0 };

  const rows = grantRows.map((g) => ({
    ...g,
    source_key: g.source_key || makeGrantSourceKey(g),
    last_seen_at: new Date().toISOString(),
  }));

  // Postgres's ON CONFLICT DO UPDATE can't touch the same row twice within
  // a single upsert command. Multiple search terms can surface the same
  // underlying grant, producing duplicate source_keys in one batch — collapse
  // those down to one row per key before sending to Supabase.
  const dedupedByKey = new Map();
  for (const row of rows) {
    dedupedByKey.set(row.source_key, row); // last one wins, fine since they're near-identical
  }
  const dedupedRows = Array.from(dedupedByKey.values());

  const { data, error } = await supabase
    .from("grants")
    .upsert(dedupedRows, { onConflict: "source_key", ignoreDuplicates: false })
    .select("id");

  if (error) {
    console.error("upsertGrants error:", error);
    return { inserted: 0, updated: 0, failed: dedupedRows.length, error };
  }
  return { inserted: data.length, updated: 0, failed: 0 };
}

/**
 * Upsert a batch of district rows, deduped on cde_org_code.
 * (Switched from nces_district_id since CDE's directory — our primary
 * district source — doesn't always carry an NCES ID; cde_org_code is
 * reliably present on every row from that source.)
 */
export async function upsertDistricts(districtRows) {
  if (!districtRows.length) return { inserted: 0, failed: 0 };

  const { data, error } = await supabase
    .from("districts")
    .upsert(districtRows, { onConflict: "cde_org_code", ignoreDuplicates: false })
    .select("id");

  if (error) {
    console.error("upsertDistricts error:", error);
    return { inserted: 0, failed: districtRows.length, error };
  }
  return { inserted: data.length, failed: 0 };
}

/**
 * Log the start of an ingestion run. Returns the run id to close out later.
 */
export async function startRun(sourceName) {
  const { data, error } = await supabase
    .from("ingestion_runs")
    .insert({ source_name: sourceName, started_at: new Date().toISOString(), status: "running" })
    .select("id")
    .single();
  if (error) {
    console.error("startRun error:", error);
    return null;
  }
  return data.id;
}

/**
 * Close out an ingestion run with final stats.
 */
export async function finishRun(runId, stats) {
  if (!runId) return;
  const { error } = await supabase
    .from("ingestion_runs")
    .update({
      finished_at: new Date().toISOString(),
      records_found: stats.found ?? null,
      records_inserted: stats.inserted ?? null,
      records_updated: stats.updated ?? null,
      records_failed: stats.failed ?? null,
      status: stats.status ?? "success",
      error_log: stats.errorLog ?? null,
    })
    .eq("id", runId);
  if (error) console.error("finishRun error:", error);
}
