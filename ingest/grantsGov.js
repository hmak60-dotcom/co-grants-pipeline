import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const BASE = process.env.GRANTS_GOV_API_BASE || "https://api.grants.gov/v1/api";

/**
 * Grants.gov has a real public search API (search2) — no key required.
 * Docs: https://www.grants.gov/api
 *
 * We search by keyword + eligible-applicant categories relevant to K-12,
 * then filter to opportunities that mention Colorado or are nationally
 * open (most federal ED/SAMHSA/NSF grants are open to all states, with
 * CO districts/agencies as eligible applicants).
 */
const SEARCH_TERMS = [
  "school district",
  "K-12 education",
  "literacy",
  "STEM education",
  "English language learner",
  "special education",
  "career and technical education",
  "school mental health",
  "after school program",
  "teacher professional development",
  "early childhood education",
  "rural education",
  "gifted education",
  "school safety",
  "computer science education",
  "arts education",
  "school nutrition",
  "homeless education",
  "foster youth education",
  "dual enrollment",
  "school counseling",
  "bullying prevention",
  "school library",
  "Title I",
  "IDEA special education",
  "workforce development youth",
  "summer learning",
  "school improvement",
  "education technology",
  "civics education",
];

export async function fetchGrantsGovOpportunities() {
  const allResults = [];

  for (const term of SEARCH_TERMS) {
    try {
      const res = await fetch(`${BASE}/search2`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keyword: term,
          rows: 100,
          oppStatuses: "forecasted|posted",
        }),
      });

      if (!res.ok) {
        console.error(`Grants.gov search failed for "${term}": ${res.status}`);
        continue;
      }

      const json = await res.json();
      const hits = json?.data?.oppHits || json?.oppHits || [];
      allResults.push(...hits.map((h) => ({ ...h, _matchedTerm: term })));
    } catch (err) {
      console.error(`Grants.gov fetch error for "${term}":`, err.message);
    }
  }

  const seen = new Set();
  const deduped = allResults.filter((r) => {
    const key = r.opportunityNumber || r.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped;
}

export async function fetchGrantsGovDetail(opportunityId) {
  try {
    const res = await fetch(`${BASE}/fetchOpportunity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opportunityId }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data || null;
  } catch (err) {
    console.error(`Grants.gov detail fetch failed for ${opportunityId}:`, err.message);
    return null;
  }
}

export async function fetchGrantsGovFull() {
  const summaries = await fetchGrantsGovOpportunities();
  const full = [];

  for (const s of summaries) {
    const detail = await fetchGrantsGovDetail(s.id || s.opportunityId);
    full.push({ summary: s, detail });
    await new Promise((r) => setTimeout(r, 250));
  }

  return full;
}
