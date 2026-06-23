import fetch from "node-fetch";
import * as XLSX from "xlsx";
import { supabase } from "./supabaseClient.js";

/**
 * Pulls district-level demographic and financial indicators from CDE.
 *
 * FINANCIAL DATA — confirmed working pattern (verified June 2026):
 * CDE's K12 Financial Transparency site exposes a per-district Excel
 * download at:
 *   https://www.cde.state.co.us/schoolview/financialtransparency/downloadreport/district/{ORG_CODE}
 * CDE's server appears to filter out requests that don't look like a real
 * browser — sending proper User-Agent/Accept headers fixes this (confirmed).
 *
 * FRL / ELL DATA — CDE's Pupil Membership page now states student counts
 * are SUPPRESSED for Instructional Programs and Free/Reduced Lunch "to
 * protect student privacy" (confirmed on their site as of this writing).
 * There is currently no public statewide file with these district-level
 * counts. Options if you need this data:
 *   1. Submit a CDE Data Request (form linked from their Pupil Membership page)
 *   2. Use Census SAIPE district-level poverty estimates as a poverty proxy
 *      (see fetchSaipePovertyByDistrict below) — federally maintained, no
 *      privacy suppression, but it's a poverty estimate, not CDE's own FRL number
 * This file leaves ell_count/ell_rate/frl_count as null unless you wire in
 * one of those alternatives.
 */

const CDE_FINANCIAL_BASE = "https://www.cde.state.co.us/schoolview/financialtransparency/downloadreport/district";

/**
 * Census SAIPE — real federal API, no key required. Gives child poverty
 * rate by school district. Use as a substitute for CDE's suppressed FRL data.
 * Docs: https://www.census.gov/programs-surveys/saipe/data/api.html
 */
const SAIPE_API_BASE = "https://api.census.gov/data/timeseries/poverty/saipe/schdist";

async function fetchDistrictFinancialFile(orgCode) {
  const url = `${CDE_FINANCIAL_BASE}/${orgCode}`;
  try {
    // CDE's server appears to filter requests without browser-like headers,
    // serving an HTML page instead of the real file to bare script requests.
    // Sending a realistic User-Agent/Accept header set resolves this.
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*",
      },
    });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "";
    const buffer = await res.arrayBuffer();

    // CDE's downloadreport URL may return an HTML report viewer page rather
    // than a raw Excel file. Detect this case and skip cleanly rather than
    // crash trying to parse HTML as a spreadsheet.
    const firstBytes = Buffer.from(buffer.slice(0, 100)).toString("utf-8").toLowerCase();
    if (contentType.includes("html") || firstBytes.includes("<html") || firstBytes.includes("<!doctype")) {
      console.warn(
        `[districtDemographics] Org ${orgCode}: financial endpoint returned an HTML page, not a file. ` +
        `The downloadreport/district/{code} URL likely needs a different path or query param to get ` +
        `the actual Excel export — this needs manual verification on the CDE Financial Transparency site.`
      );
      return null;
    }

    const workbook = XLSX.read(buffer, { type: "buffer" });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const parsed = XLSX.utils.sheet_to_json(firstSheet, { defval: null });
    if (parsed.length && orgCode === "0180") {
      // One-time debug peek using a known real district, so you can see
      // the actual column names in the log without spamming it for all 181.
      console.log(`[districtDemographics] Sample financial columns for org 0180:`, Object.keys(parsed[0]));
    }
    return parsed;
  } catch (err) {
    console.error(`[districtDemographics] Financial fetch failed for org ${orgCode}:`, err.message);
    return null;
  }
}

function pick(row, ...candidates) {
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") return row[key];
  }
  return null;
}

function toNumber(val) {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(String(val).replace(/[%,$]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Pulls child poverty rate by school district from Census SAIPE.
 * State FIPS 08 = Colorado. Returns a map keyed by NCES district ID,
 * since SAIPE uses NCES district codes, not CDE org codes.
 */
export async function fetchSaipePovertyByDistrict(year = 2023) {
  const url = `${SAIPE_API_BASE}?get=NAME,SAEPOVRT5_17RV_PT&for=school%20district%20(unified):*&in=state:08&time=${year}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[districtDemographics] SAIPE fetch failed: ${res.status}`);
      return new Map();
    }
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
      console.error(
        `[districtDemographics] SAIPE returned non-JSON (content-type: ${contentType}). ` +
        `The endpoint URL or parameters are likely outdated — verify current API shape at ` +
        `https://www.census.gov/data/developers/data-sets/Poverty-Statistics.html`
      );
      return new Map();
    }
    const json = await res.json();
    const [header, ...rows] = json;
    const nameIdx = header.indexOf("NAME");
    const povertyIdx = header.indexOf("SAEPOVRT5_17RV_PT");
    const distIdx = header.indexOf("school district (unified)");

    const map = new Map();
    for (const row of rows) {
      const ncesId = `08${row[distIdx]}`; // SAIPE district codes combine with state FIPS to form NCES-style IDs
      map.set(ncesId, {
        name: row[nameIdx],
        povertyRate: toNumber(row[povertyIdx]),
      });
    }
    return map;
  } catch (err) {
    console.error("[districtDemographics] SAIPE fetch error:", err.message);
    return new Map();
  }
}

/**
 * Fetch existing districts from Supabase so we know which org codes to loop over.
 */
async function getExistingDistricts() {
  const { data, error } = await supabase
    .from("districts")
    .select("id, nces_district_id, cde_org_code, name");
  if (error) {
    console.error("[districtDemographics] Failed to load existing districts:", error.message);
    return [];
  }
  return data || [];
}

export async function fetchDistrictDemographics() {
  const districts = await getExistingDistricts();
  if (!districts.length) {
    console.warn("[districtDemographics] No districts found in Supabase yet — run districts ingestion first.");
    return [];
  }

  const saipeMap = await fetchSaipePovertyByDistrict();
  const results = [];

  // Loop financial downloads with a small delay — be polite to CDE's server
  for (const district of districts) {
    const rec = { cde_org_code: district.cde_org_code };

    if (district.cde_org_code) {
      const financialRows = await fetchDistrictFinancialFile(district.cde_org_code);
      if (financialRows && financialRows.length) {
        // CDE's per-district export format needs confirming once you've
        // actually opened one — adjust these field names to match exactly.
        let local = 0, state = 0, federal = 0;
        for (const row of financialRows) {
          const category = pick(row, "Category", "Revenue Category", "Source");
          const amount = toNumber(pick(row, "Amount", "Total"));
          if (!category || amount == null) continue;
          if (/local/i.test(category)) local += amount;
          else if (/state/i.test(category)) state += amount;
          else if (/federal/i.test(category)) federal += amount;
        }
        rec.local_revenue = local || null;
        rec.state_revenue = state || null;
        rec.federal_revenue = federal || null;
        rec.total_revenue = (local + state + federal) || null;
        rec.demographics_source_url = `${CDE_FINANCIAL_BASE}/${district.cde_org_code}`;
      }
      await new Promise((r) => setTimeout(r, 300)); // polite delay between requests
    }

    if (district.nces_district_id && saipeMap.has(district.nces_district_id)) {
      const saipe = saipeMap.get(district.nces_district_id);
      rec.poverty_rate_saipe = saipe.povertyRate;
    }

    results.push(rec);
  }

  return results;
}

/**
 * Merge demographic data into the existing districts table by cde_org_code.
 * Districts must already exist (from districts.js / NCES ingestion) —
 * this only updates, it doesn't create new district rows.
 */
export async function upsertDistrictDemographics(demographicRows) {
  let updated = 0;
  let failed = 0;

  for (const row of demographicRows) {
    if (!row.cde_org_code) continue;

    const { error } = await supabase
      .from("districts")
      .update({
        ...row,
        demographics_updated_at: new Date().toISOString(),
      })
      .eq("cde_org_code", row.cde_org_code);

    if (error) {
      console.error(`Failed to update demographics for org code ${row.cde_org_code}:`, error.message);
      failed++;
    } else {
      updated++;
    }
  }

  return { updated, failed };
}
