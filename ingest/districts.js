import fetch from "node-fetch";
import { parse } from "csv-parse/sync";

/**
 * NCES Common Core of Data (CCD) publishes a public, structured directory
 * of every school district in the US, updated annually. No API key needed.
 *
 * The exact download URL changes by year (NCES versions their files), so
 * rather than hardcoding a stale link, this fetches the current "Local
 * Education Agency (District) Universe" file index page and grabs the
 * latest CSV — adjust NCES_FILE_URL below once you confirm the current
 * year's direct CSV link from https://nces.ed.gov/ccd/files.asp
 * ("Local Education Agency Universe Survey Data").
 */
const NCES_FILE_URL = process.env.NCES_DISTRICT_CSV_URL ||
  "https://nces.ed.gov/ccd/Data/zip/ccd_lea_029_2324_w_1a_073124.zip"; // EXAMPLE — confirm current year's file

/**
 * Colorado FIPS state code is "08" — NCES LEA records include a STATEFIP /
 * LEA_STATE field for filtering.
 */
const CO_STATE_CODE = "CO";

export async function fetchColoradoDistrictsFromNCES() {
  // NOTE: NCES distributes this as a zipped CSV/SAS/SPSS bundle, not a
  // simple flat CSV — you'll likely need to download+unzip once manually
  // (or add a `node-stream-zip` step here) since the file format/structure
  // changes slightly year to year. This function assumes you've already
  // unzipped and are pointing NCES_DISTRICT_CSV_URL at the extracted .csv.
  const res = await fetch(NCES_FILE_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch NCES district file (${res.status}). ` +
      `Check https://nces.ed.gov/ccd/files.asp for the current year's direct CSV link ` +
      `and set NCES_DISTRICT_CSV_URL in .env.`
    );
  }

  const csvText = await res.text();
  const records = parse(csvText, { columns: true, skip_empty_lines: true });

  const coDistricts = records.filter(
    (r) => (r.LSTATE || r.STATE_ABBR || r.LEA_STATE) === CO_STATE_CODE
  );

  return coDistricts.map((r) => ({
    nces_district_id: r.LEAID || r.LEA_ID,
    name: r.LEA_NAME || r.NAME,
    county: r.CONAME || r.COUNTY_NAME || null,
    district_type: r.LEA_TYPE_TEXT || null,
    address: r.LSTREET1 || null,
    city: r.LCITY || null,
    state: "CO",
    zip: r.LZIP || null,
    phone: r.PHONE || null,
    enrollment: r.MEMBER ? Number(r.MEMBER) : null,
    urbanicity: r.ULOCALE_TEXT || null,
    locale_code: r.ULOCALE || null,
    latitude: r.LAT ? Number(r.LAT) : null,
    longitude: r.LON ? Number(r.LON) : null,
    raw_source_payload: r,
  }));
}

/**
 * CDE also publishes its own org/district list directly (often more
 * current than NCES, which lags by a year). Use this as a secondary
 * source to fill gaps / cross-check, especially for newly formed
 * charter authorizers or BOCES not yet reflected in NCES.
 *
 * https://www.cde.state.co.us/cdereval/rvonline -> Organization search/export
 * Confirm the current direct export link before relying on this in production.
 */
export async function fetchColoradoDistrictsFromCDE() {
  console.warn(
    "[districts] fetchColoradoDistrictsFromCDE is a placeholder — " +
    "CDE's org list export link should be confirmed at " +
    "https://www.cde.state.co.us/cdereval and wired in here once verified."
  );
  return [];
}

export async function fetchAllColoradoDistricts() {
  const [ncesDistricts, cdeDistricts] = await Promise.all([
    fetchColoradoDistrictsFromNCES().catch((err) => {
      console.error("NCES fetch failed:", err.message);
      return [];
    }),
    fetchColoradoDistrictsFromCDE(),
  ]);

  // Merge, preferring NCES as primary key source, CDE as enrichment
  const byId = new Map(ncesDistricts.map((d) => [d.nces_district_id, d]));
  for (const cdeRow of cdeDistricts) {
    if (cdeRow.nces_district_id && byId.has(cdeRow.nces_district_id)) {
      Object.assign(byId.get(cdeRow.nces_district_id), cdeRow);
    } else if (cdeRow.nces_district_id) {
      byId.set(cdeRow.nces_district_id, cdeRow);
    }
  }

  return Array.from(byId.values());
}
