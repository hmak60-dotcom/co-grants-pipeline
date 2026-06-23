import { fetchAllColoradoDistricts } from "./districts.js";
import { fetchDistrictDemographics, upsertDistrictDemographics } from "./districtDemographics.js";
import { fetchGrantsGovFull } from "./grantsGov.js";
import { scrapeCdeFull } from "./cdeScraper.js";
import { fetchCandidEducationGrants } from "./candidClient.js";
import { mapGrantsGovOpportunity, mapCdeForecastRow } from "./normalizeDirect.js";
import { upsertDistricts, upsertGrants, startRun, finishRun } from "./supabaseClient.js";

const args = process.argv.slice(2);
const sourceArg = args.find((a) => a.startsWith("--source="));
const source = sourceArg ? sourceArg.split("=")[1] : "all";

async function runDistricts() {
  const runId = await startRun("districts");
  try {
    console.log("Fetching Colorado districts from NCES/CDE...");
    const districts = await fetchAllColoradoDistricts();
    console.log(`Found ${districts.length} districts.`);
    const { inserted, failed } = await upsertDistricts(districts);
    await finishRun(runId, { found: districts.length, inserted, failed, status: failed ? "partial" : "success" });
    console.log(`Districts: inserted/updated ${inserted}, failed ${failed}.`);
  } catch (err) {
    console.error("Districts run failed:", err);
    await finishRun(runId, { status: "failed", errorLog: { message: err.message } });
  }
}

async function runDemographics() {
  const runId = await startRun("district-demographics");
  try {
    console.log("Fetching district demographic/financial data from CDE...");
    const rows = await fetchDistrictDemographics();
    console.log(`Found demographic data for ${rows.length} districts.`);
    const { updated, failed } = await upsertDistrictDemographics(rows);
    await finishRun(runId, { found: rows.length, updated, failed, status: failed ? "partial" : "success" });
    console.log(`Demographics: updated ${updated}, failed ${failed}.`);
  } catch (err) {
    console.error("Demographics run failed:", err);
    await finishRun(runId, { status: "failed", errorLog: { message: err.message } });
  }
}

async function runGrantsGov() {
  const runId = await startRun("grants-gov");
  try {
    console.log("Fetching opportunities from Grants.gov...");
    const opportunities = await fetchGrantsGovFull();
    console.log(`Found ${opportunities.length} raw opportunities. Mapping directly (no LLM)...`);
    const normalized = opportunities.map(mapGrantsGovOpportunity).filter(Boolean);
    console.log(`${normalized.length} passed as education-relevant.`);
    const { inserted, failed } = await upsertGrants(normalized);
    await finishRun(runId, { found: opportunities.length, inserted, failed, status: failed ? "partial" : "success" });
    console.log(`Grants.gov: inserted/updated ${inserted}, failed ${failed}.`);
  } catch (err) {
    console.error("Grants.gov run failed:", err);
    await finishRun(runId, { status: "failed", errorLog: { message: err.message } });
  }
}

async function runCde() {
  const runId = await startRun("cde");
  try {
    console.log("Scraping CDE Competitive Grants Forecast...");
    const rows = await scrapeCdeFull();
    console.log(`Found ${rows.length} raw forecast rows. Mapping directly (no LLM)...`);
    const normalized = rows.map(mapCdeForecastRow).filter(Boolean);
    console.log(`${normalized.length} mapped.`);
    const { inserted, failed } = await upsertGrants(normalized);
    await finishRun(runId, { found: rows.length, inserted, failed, status: failed ? "partial" : "success" });
    console.log(`CDE: inserted/updated ${inserted}, failed ${failed}.`);
  } catch (err) {
    console.error("CDE run failed:", err);
    await finishRun(runId, { status: "failed", errorLog: { message: err.message } });
  }
}

async function runCandid() {
  const runId = await startRun("candid");
  try {
    console.log("Fetching from Candid (requires CANDID_API_KEY)...");
    const records = await fetchCandidEducationGrants({ state: "CO" });
    console.log(`Found ${records.length} raw records.`);
    const { inserted, failed } = await upsertGrants([]);
    await finishRun(runId, { found: records.length, inserted, failed, status: "success" });
    console.log(`Candid: inserted/updated ${inserted}, failed ${failed}.`);
  } catch (err) {
    console.error("Candid run failed:", err);
    await finishRun(runId, { status: "failed", errorLog: { message: err.message } });
  }
}

async function main() {
  console.log(`Running ingestion pipeline — source: ${source}`);

  if (source === "districts" || source === "all") await runDistricts();
  if (source === "demographics" || source === "all") await runDemographics();
  if (source === "grants-gov" || source === "all") await runGrantsGov();
  if (source === "cde" || source === "all") await runCde();
  if (source === "candid" || source === "all") await runCandid();

  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal pipeline error:", err);
  process.exit(1);
});
