import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

/**
 * STUB — not functional without a paid subscription key.
 *
 * Why this file exists: the only legitimate way to get from ~50-80
 * verified grants (Grants.gov + CDE) up to several hundred is a licensed
 * aggregator that has already done the work of cataloging thousands of
 * private foundation grants with structured fields. Two real options:
 *
 * 1. Candid (candid.org) — Foundation Directory API. Paid, but has a
 *    real REST API with filters for geography (Colorado), subject
 *    (education), and recipient type (school district / nonprofit).
 *    https://developer.candid.org/
 *
 * 2. GrantWatch — offers data feeds/API access to organizations (not
 *    just end-user search). Contact their team directly:
 *    https://www.grantwatch.com/
 *
 * Once you have a key, fill in CANDID_API_KEY in .env and this function
 * will work as written (adjust the endpoint/params to match whichever
 * vendor's actual API contract once you have their docs in hand —
 * the shape below is illustrative of how Candid's API is structured,
 * not a guaranteed-accurate spec).
 */

const CANDID_API_BASE = "https://api.candid.org/v1"; // confirm against actual docs once you have a key

export async function fetchCandidEducationGrants({ state = "CO" } = {}) {
  const apiKey = process.env.CANDID_API_KEY;
  if (!apiKey) {
    console.warn(
      "[candidClient] No CANDID_API_KEY set — skipping. " +
      "This is the main lever for growing grant volume beyond Grants.gov + CDE. " +
      "See comments in this file for how to get access."
    );
    return [];
  }

  const res = await fetch(`${CANDID_API_BASE}/grants/search`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
    // params would go in query string per Candid's actual API contract
  });

  if (!res.ok) {
    console.error(`Candid API error: ${res.status}`);
    return [];
  }

  const json = await res.json();
  return json?.results || [];
}
