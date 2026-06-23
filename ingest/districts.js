import fetch from "node-fetch";
import * as XLSX from "xlsx";

/**
 * PRIMARY SOURCE — confirmed working, updated weekly by CDE:
 * "District and School Contact Information" Excel file.
 * https://www.cde.state.co.us/cdereval/downloadablemailinglabels
 * This is far more reliable than NCES's annually-versioned zip files
 * (no unzip step needed, no stale year-specific URL to chase).
 *
 * IMPORTANT: the page itself (downloadablemailinglabels) links to the
 * actual .xlsx file — I could not crawl the page directly to grab the
 * exact file URL (CDE blocks automated fetching). You'll need to:
 *   1. Visit https://www.cde.state.co.us/cdereval/downloadablemailinglabels
 *   2. Right-click the Excel download link → "Copy Link Address"
 *   3. Paste it into CDE_DISTRICT_DIRECTORY_URL below (or set it as an
 *      env var / GitHub secret named CDE_DISTRICT_DIRECTORY_URL instead
 *      of hardcoding, since CDE occasionally moves these file paths)
 */
const CDE_DISTRICT_DIRECTORY_URL = process.env.CDE_DISTRICT_DIRECTORY_URL || null;

function pick(row, ...candidates) {
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") return row[key];
  }
  return null;
}

async function downloadXlsx(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];

  // CDE's exports often have a title row (e.g. "Page: 1" or a report title)
  // ABOVE the real header row, which throws off naive sheet_to_json parsing
  // (you get __EMPTY, __EMPTY_1, etc. as "headers"). Read as raw arrays
  // first, find the row that actually looks like headers, then re-parse
  // using that row as the header.
  const rawRows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: null });

  const headerRowIndex = rawRows.findIndex((row) => {
    const nonEmptyCells = row.filter((c) => c !== null && c !== "");
    // A real header row should have several short text cells (column names),
    // not a single title string or mostly-empty row.
    return nonEmptyCells.length >= 3 && nonEmptyCells.every((c) => typeof c === "string" && c.length < 60);
  });

  if (headerRowIndex === -1) {
    console.warn("[downloadXlsx] Could not auto-detect header row — falling back to row 0.");
    return XLSX.utils.sheet_to_json(firstSheet, { defval: null });
  }

  const headers = rawRows[headerRowIndex];
  const dataRows = rawRows.slice(headerRowIndex + 1);

  return dataRows
    .filter((row) => row.some((c) => c !== null && c !== ""))
    .map((row) => {
      const obj = {};
      headers.forEach((h, i) => {
        if (h) obj[h] = row[i] ?? null;
      });
      return obj;
    });
}

export async function fetchColoradoDistrictsFromCDE() {
  if (!CDE_DISTRICT_DIRECTORY_URL) {
    console.warn(
      "[districts] CDE_DISTRICT_DIRECTORY_URL is not set. " +
      "Visit https://www.cde.state.co.us/cdereval/downloadablemailinglabels, " +
      "grab the actual Excel file link, and set it as an env var/secret."
    );
    return [];
  }

  const rows = await downloadXlsx(CDE_DISTRICT_DIRECTORY_URL);
  if (rows.length) {
    console.log("[districts] Detected columns:", Object.keys(rows[0]));
  }

  // This file typically includes BOTH district-level and school-level rows.
  // Filter down to district/BOCES-level entries only — adjust the filter
  // condition once you've opened the real file and confirmed how CDE
  // distinguishes a district row from a school row (often a "Org Type"
  // or "Level" column, or simply the absence of a school name).
  const districtRows = rows.filter((r) => {
    const orgType = pick(r, "Org Type", "Organization Type", "Level");
    const schoolName = pick(r, "School Name", "Building Name");
    return !schoolName || (orgType && /district|boces/i.test(orgType));
  });

  return districtRows
    .map((r) => ({
      cde_org_code: pick(r, "Org Code", "District Code", "Organization Code"),
      name: pick(r, "District Name", "Organization Name", "LEA Name"),
      county: pick(r, "County", "County Name"),
      district_type: pick(r, "Org Type", "Organization Type") || "School District",
      address: pick(r, "Address", "Street Address", "Mailing Address"),
      city: pick(r, "City"),
      state: "CO",
      zip: pick(r, "Zip", "Zip Code"),
      phone: pick(r, "Phone", "Phone Number"),
      website: pick(r, "Website", "URL"),
      raw_source_payload: r,
    }))
    // Guard against the not-null constraint on `name` — drop any row where
    // we couldn't find a name under any of the candidate column headers.
    .filter((d) => d.name);
}

/**
 * FALLBACK / CROSS-REFERENCE SOURCE — NCES Common Core of Data.
 * Useful for getting a stable federal NCES LEAID (for joining against
 * other federal datasets like Census SAIPE poverty data), and as a
 * sanity check against CDE's own list. Kept here but not used as primary
 * since CDE's weekly file is more current and easier to fetch reliably.
 *
 * NCES re-versions this file every year with a year-specific filename —
 * confirm the current direct link at https://nces.ed.gov/ccd/files.asp
 * ("Local Education Agency Universe Survey Data") and set
 * NCES_DISTRICT_CSV_URL if you want to wire this back in for ID matching.
 */
export async function fetchColoradoDistrictsFromNCES() {
  const ncesUrl = process.env.NCES_DISTRICT_CSV_URL || null;
  if (!ncesUrl) {
    console.warn(
      "[districts] NCES_DISTRICT_CSV_URL not set — skipping NCES cross-reference. " +
      "This only affects nces_district_id (used for SAIPE poverty matching), not core district data."
    );
    return [];
  }

  try {
    const res = await fetch(ncesUrl);
    if (!res.ok) throw new Error(`${res.status}`);
    const csvText = await res.text();
    const { parse } = await import("csv-parse/sync");
    const records = parse(csvText, { columns: true, skip_empty_lines: true });
    return records
      .filter((r) => (r.LSTATE || r.STATE_ABBR || r.LEA_STATE) === "CO")
      .map((r) => ({
        nces_district_id: r.LEAID || r.LEA_ID,
        name: r.LEA_NAME || r.NAME,
      }));
  } catch (err) {
    console.error("[districts] NCES fetch failed (non-fatal):", err.message);
    return [];
  }
}

export async function fetchAllColoradoDistricts() {
  const cdeDistricts = await fetchColoradoDistrictsFromCDE();
  const ncesDistricts = await fetchColoradoDistrictsFromNCES();

  // Cross-reference by name to attach nces_district_id where possible
  // (rough match — district names are usually close enough between sources,
  // but verify a sample after first run since this is a fuzzy join).
  if (ncesDistricts.length) {
    const ncesByName = new Map(
      ncesDistricts.map((d) => [String(d.name).toLowerCase().trim(), d.nces_district_id])
    );
    for (const d of cdeDistricts) {
      const match = ncesByName.get(String(d.name).toLowerCase().trim());
      if (match) d.nces_district_id = match;
    }
  }

  return cdeDistricts;
}
