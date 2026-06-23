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
 * We loop over every district already in Supabase and hit this endpoint
 * once per district.
 *
 * FRL / ELL / SPED / GIFTED DATA — CDE publishes these as statewide files,
 * but small counts are suppressed for privacy. See
 * fetchInstructionalProgramCounts() below — needs a manually-found URL.
 */

const CDE_FINANCIAL_BASE = "https://www.cde.state.co.us/schoolview/financialtransparency/downloadreport/district";
const SAIPE_API_BASE = "https://api.census.gov/data/timeseries/poverty/saipe/schdist";

async function fetchDistrictFinancialFile(orgCode) {
  const url = `${CDE_FINANCIAL_BASE}/${orgCode}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*",
      },
    });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "";
    const buffer = await res.arrayBuffer();

    const firstBytes = Buffer.from(buffer.slice(0, 100)).toString("utf-8").toLowerCase();
    if (contentType.includes("html") || firstBytes.includes("<html") || firstBytes.includes("<!doctype")) {
      console.warn(`[districtDemographics] Org ${orgCode}: financial endpoint returned an HTML page, not a file.`);
      return null;
    }

    const workbook = XLSX.read(buffer, { type: "buffer" });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json(firstSheet, { defval: null });
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

function parseXlsxWithHeaderDetection(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: null });

  const headerRowIndex = rawRows.findIndex((row) => {
    const nonEmptyCells = row.filter((c) => c !== null && c !== "");
    return nonEmptyCells.length >= 3 && nonEmptyCells.every((c) => typeof c === "string" && c.length < 80);
  });

  if (headerRowIndex === -1) return XLSX.utils.sheet_to_json(firstSheet, { defval: null });

  const headers = rawRows[headerRowIndex];
  return rawRows
    .slice(headerRowIndex + 1)
    .filter((row) => row.some((c) => c !== null && c !== ""))
    .map((row) => {
      const obj = {};
      headers.forEach((h, i) => { if (h) obj[h] = row[i] ?? null; });
      return obj;
    });
}

const CDE_INSTRUCTIONAL_PROGRAMS_URL = process.env.CDE_INSTRUCTIONAL_PROGRAMS_URL || null;

export async function fetchInstructionalProgramCounts() {
  if (!CDE_INSTRUCTIONAL_PROGRAMS_URL) {
    console.warn(
      "[districtDemographics] CDE_INSTRUCTIONAL_PROGRAMS_URL not set — FRL/ELL/SPED/Gifted " +
      "counts will stay null. Find the current file link at " +
      "https://www.cde.state.co.us/cdereval/pupilcurrent and set it as a GitHub secret."
    );
    return new Map();
  }

  try {
    const res = await fetch(CDE_INSTRUCTIONAL_PROGRAMS_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*",
      },
    });
    if (!res.ok) {
      console.error(`[districtDemographics] Instructional programs fetch failed: ${res.status}`);
      return new Map();
    }
    const buffer = await res.arrayBuffer();
    const rows = parseXlsxWithHeaderDetection(buffer);
    if (rows.length) console.log("[districtDemographics] Instructional programs columns:", Object.keys(rows[0]));

    const map = new Map();
    for (const row of rows) {
      const orgCode = pick(row, "Org Code", "District Code", "Organization Code");
      if (!orgCode) continue;
      map.set(String(orgCode).trim(), {
        ell_count: toNumber(pick(row, "EL Count", "English Learner Count", "ELL Count")),
        special_education_count: toNumber(pick(row, "Special Education", "SPED Count", "IEP Count")),
        gifted_count: toNumber(pick(row, "Gifted", "GT Count", "Gifted and Talented")),
        frl_count: toNumber(pick(row, "FRL Count", "Free and Reduced Count")),
      });
    }
    return map;
  } catch (err) {
    console.error("[districtDemographics] Instructional programs fetch error:", err.message);
    return new Map();
  }
}

export async function fetchSaipePovertyByDistrict(year = 2023) {
  const apiKey = process.env.CENSUS_API_KEY || "";
  const keyParam = apiKey ? `&key=${apiKey}` : "";
  if (!apiKey) {
    console.warn(
      "[districtDemographics] No CENSUS_API_KEY set. Sign up free at " +
      "https://api.census.gov/data/key_signup.html and add as GitHub secret CENSUS_API_KEY."
    );
  }
  const url = `${SAIPE_API_BASE}?get=SD_NAME,SAEPOVRT5_17R_PT&for=school%20district%20(unified):*&in=state:08&YEAR=${year}${keyParam}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[districtDemographics] SAIPE fetch failed: ${res.status}`);
      return new Map();
    }
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
      console.warn("[districtDemographics] SAIPE poverty data unavailable this run (non-JSON response).");
      return new Map();
    }
    const json = await res.json();
    const [header, ...rows] = json;
    const nameIdx = header.indexOf("SD_NAME");
    const povertyIdx = header.indexOf("SAEPOVRT5_17R_PT");
    const distIdx = header.indexOf("school district (unified)");

    const map = new Map();
    for (const row of rows) {
      const ncesId = `08${row[distIdx]}`;
      map.set(ncesId, { name: row[nameIdx], povertyRate: toNumber(row[povertyIdx]) });
    }
    return map;
  } catch (err) {
    console.error("[districtDemographics] SAIPE fetch error:", err.message);
    return new Map();
  }
}

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
  const instructionalMap = await fetchInstructionalProgramCounts();
  const results = [];

  for (const district of districts) {
    const rec = { cde_org_code: district.cde_org_code };

    if (district.cde_org_code) {
      const financialRows = await fetchDistrictFinancialFile(district.cde_org_code);
      if (financialRows && financialRows.length) {
        let local = 0, state = 0, federal = 0;
        let matchedAnyRow = false;
        for (const row of financialRows) {
          const spendingOrFunding = pick(row, "SPENDING_FUNDING");
          if (spendingOrFunding !== "Funding") continue;

          const amount = toNumber(pick(row, "AMOUNT", "Amount", "Total"));
          if (amount == null) continue;

          const searchableText = [row.SUB_ROLLUP, row.ROLLUP, row.FUND_DESC, row.CATEGORY, row.ORG_ROLLUP]
            .filter(Boolean).join(" ");

          if (/local/i.test(searchableText)) { local += amount; matchedAnyRow = true; }
          else if (/\bstate\b/i.test(searchableText)) { state += amount; matchedAnyRow = true; }
          else if (/federal/i.test(searchableText)) { federal += amount; matchedAnyRow = true; }
        }
        if (matchedAnyRow) {
          rec.local_revenue = local;
          rec.state_revenue = state;
          rec.federal_revenue = federal;
          rec.total_revenue = local + state + federal;
        }

        const demoRow = financialRows.find((r) => r.FILE === "Org_Demo_Counts" || r.TOTAL_STUDENTS != null);
        if (demoRow) {
          const totalStudents = toNumber(demoRow.TOTAL_STUDENTS);
          if (totalStudents != null) {
            rec.total_enrollment = totalStudents;
            if (rec.total_revenue != null) {
              rec.per_pupil_revenue = Math.round((rec.total_revenue / totalStudents) * 100) / 100;
            }
          }
        }

        rec.demographics_source_url = `${CDE_FINANCIAL_BASE}/${district.cde_org_code}`;
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    if (district.nces_district_id && saipeMap.has(district.nces_district_id)) {
      rec.poverty_rate_saipe = saipeMap.get(district.nces_district_id).povertyRate;
    }

    if (district.cde_org_code && instructionalMap.has(district.cde_org_code)) {
      const inst = instructionalMap.get(district.cde_org_code);
      Object.assign(rec, inst);
      const enrollment = rec.total_enrollment;
      if (enrollment) {
        if (rec.ell_count != null) rec.ell_rate = Math.round((rec.ell_count / enrollment) * 1000) / 10;
        if (rec.special_education_count != null) rec.special_education_rate = Math.round((rec.special_education_count / enrollment) * 1000) / 10;
        if (rec.gifted_count != null) rec.gifted_rate = Math.round((rec.gifted_count / enrollment) * 1000) / 10;
        if (rec.frl_count != null) rec.frl_rate = Math.round((rec.frl_count / enrollment) * 1000) / 10;
      }
    }

    results.push(rec);
  }

  return results;
}

export async function upsertDistrictDemographics(demographicRows) {
  let updated = 0;
  let failed = 0;

  for (const row of demographicRows) {
    if (!row.cde_org_code) continue;

    const { error } = await supabase
      .from("districts")
      .update({ ...row, demographics_updated_at: new Date().toISOString() })
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
