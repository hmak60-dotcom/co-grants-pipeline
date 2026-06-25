import { supabase } from "./supabaseClient.js";

/**
 * Computes a fit score between every district and every active grant, then
 * stores the results in district_grant_matches. The frontend can then just
 * query that table directly instead of recomputing this logic in the browser.
 *
 * NEED DIMENSIONS — each tied to a real column on `districts` and a set of
 * real `focus_area` tags used on `grants`. A district's need level (1=Low,
 * 2=Medium, 3=High) is estimated from public CDE/Census data, not self-reported.
 */
const NEED_DIMENSIONS = [
  {
    key: "equity",
    label: "Equity & economic need",
    tags: ["equity", "community_support"],
    level(d) {
      const v = d.frl_rate;
      if (v == null) return null;
      return v > 55 ? 3 : v > 30 ? 2 : 1;
    },
  },
  {
    key: "ell",
    label: "English language learners",
    tags: ["ell"],
    level(d) {
      const v = d.ell_rate;
      if (v == null) return null;
      return v > 25 ? 3 : v > 10 ? 2 : 1;
    },
  },
  {
    key: "sped",
    label: "Special education",
    tags: ["special_education"],
    level(d) {
      const v = d.special_education_rate;
      if (v == null) return null;
      return v > 15 ? 3 : v > 10 ? 2 : 1;
    },
  },
  {
    key: "gifted",
    label: "Gifted & talented capacity",
    tags: ["equity", "research"],
    level(d) {
      const v = d.gifted_rate;
      if (v == null) return null;
      return v < 5 ? 3 : v < 10 ? 2 : 1;
    },
  },
  {
    key: "operating",
    label: "Operating capacity",
    tags: ["school_improvement", "community_support"],
    level(d, benchmark) {
      const v = d.per_pupil_revenue;
      if (v == null || !benchmark) return null;
      const ratio = v / benchmark;
      return ratio < 0.85 ? 3 : ratio < 1.0 ? 2 : 1;
    },
  },
  {
    key: "rural",
    label: "Rural & workforce access",
    tags: ["workforce", "career_readiness"],
    level(d) {
      const setting = (d.districtSetting || "").toLowerCase();
      if (!setting) return null;
      if (setting.includes("rural")) return 3;
      if (setting.includes("town")) return 2;
      return 1;
    },
  },
  {
    key: "small",
    label: "District capacity",
    tags: ["workforce", "community_support"],
    level(d) {
      const v = d.total_enrollment;
      if (v == null) return null;
      return v < 1000 ? 3 : v < 10000 ? 2 : 1;
    },
  },
];

const NEED_WEIGHT = 0.7;
const AMOUNT_WEIGHT = 0.3;
const MAX_MATCHES_PER_DISTRICT = 30; // store the top N, not all ~600 grants x 181 districts

/**
 * Checks whether a grant's eligibility text actually allows school districts
 * to apply, independent of whether its category/focus_area tags look like a
 * good topical fit. A grant can be perfectly on-topic (e.g. tagged "stem")
 * while being restricted to universities, individuals, or nonprofits only —
 * tag overlap alone can't catch that, so we read the real eligibility text.
 *
 * Returns a multiplier (0-1) applied to the final match score:
 *   1.0  = clearly open to districts, or no eligibility text to judge from
 *   0.1  = eligibility text clearly excludes districts (heavily down-ranked,
 *          not fully removed, in case the wording is ambiguous in practice)
 */
const DISTRICT_POSITIVE_SIGNALS = [
  "school district", "local education agency", " lea ", "k-12", "k12",
  "public school", "boces", "charter school", "school board",
  "public school district", "education agency",
];
const NON_DISTRICT_EXCLUSIVE_SIGNALS = [
  "institutions of higher education", "higher education institution",
  "college or university", "university only", "universities only",
  "nonprofit organizations only", "501(c)(3) organizations only",
  "individual applicants only", "individuals only", "state agencies only",
  "tribal governments only", "research institutions only",
];

function eligibilityFitMultiplier(grant) {
  const text = (grant.eligibility_requirements || "").toLowerCase();
  if (!text) return 1; // no eligibility text to judge from — stay neutral, don't penalize missing data

  const hasPositive = DISTRICT_POSITIVE_SIGNALS.some((s) => text.includes(s));
  if (hasPositive) return 1;

  const hasExclusiveNegative = NON_DISTRICT_EXCLUSIVE_SIGNALS.some((s) => text.includes(s));
  if (hasExclusiveNegative) return 0.1;

  return 1; // ambiguous wording — don't penalize on uncertain signal alone
}

function computeNeedLevels(district, benchmark) {
  return NEED_DIMENSIONS.map((dim) => ({ ...dim, score: dim.level(district, benchmark) }));
}

function computeMatchScore(district, grant, benchmark, maxGrantAmount) {
  const levels = computeNeedLevels(district, benchmark);
  const neededTagWeight = {};
  for (const dim of levels) {
    if (dim.score == null) continue;
    const w = dim.score === 3 ? 1 : dim.score === 2 ? 0.5 : 0.15;
    for (const tag of dim.tags) {
      neededTagWeight[tag] = Math.max(neededTagWeight[tag] || 0, w);
    }
  }

  const focusAreas = Array.isArray(grant.focus_area) ? grant.focus_area : [];
  let needComponent = 0.2; // default if no tag overlap data at all
  if (focusAreas.length) {
    const weights = focusAreas.map((tag) => neededTagWeight[tag] || 0);
    needComponent = Math.max(...weights, weights.reduce((s, w) => s + w, 0) / weights.length);
  }

  const amount = grant.possible_funding_amount || 0;
  const amountComponent = Math.log10(amount + 1) / Math.log10(maxGrantAmount + 1);

  const rawScore = NEED_WEIGHT * needComponent + AMOUNT_WEIGHT * amountComponent;
  const eligMultiplier = eligibilityFitMultiplier(grant);
  const matchScore = rawScore * eligMultiplier;

  // Build a short, human-readable reason string for transparency
  const matchedDims = levels.filter((dim) => dim.score != null && dim.score >= 2 && dim.tags.some((t) => focusAreas.includes(t)));
  const reasonParts = matchedDims.map((dim) => `${dim.label.toLowerCase()} (${dim.score === 3 ? "high" : "medium"} need)`);
  let matchReason = reasonParts.length
    ? `Matches on: ${reasonParts.join(", ")}`
    : "General fit based on grant size; no specific need-area overlap found";
  if (eligMultiplier < 1) {
    matchReason += " — CAUTION: eligibility text suggests this may not be open to school districts, verify before applying";
  }

  return { matchScore: Math.round(matchScore * 1000) / 1000, matchReason };
}

export async function computeAllMatches() {
  const { data: districts, error: dError } = await supabase.from("districts").select("*");
  if (dError) throw new Error(`Failed to load districts: ${dError.message}`);

  const { data: grants, error: gError } = await supabase.from("grants").select("*").eq("status", "active");
  if (gError) throw new Error(`Failed to load grants: ${gError.message}`);

  const districtsWithSetting = (districts || []).map((d) => ({
    ...d,
    districtSetting: d.raw_source_payload && d.raw_source_payload["District Setting"] ? d.raw_source_payload["District Setting"] : null,
  }));

  const withPerPupil = districtsWithSetting.filter((d) => d.per_pupil_revenue != null);
  const benchmark = withPerPupil.length
    ? withPerPupil.reduce((s, d) => s + d.per_pupil_revenue, 0) / withPerPupil.length
    : null;

  const maxGrantAmount = Math.max(1, ...(grants || []).map((g) => g.possible_funding_amount || 0));

  console.log(`[matchGrants] Computing matches for ${districtsWithSetting.length} districts x ${grants.length} grants...`);

  const allMatchRows = [];
  for (const district of districtsWithSetting) {
    const scored = grants.map((grant) => {
      const { matchScore, matchReason } = computeMatchScore(district, grant, benchmark, maxGrantAmount);
      return { district_id: district.id, grant_id: grant.id, match_score: matchScore, match_reason: matchReason };
    });

    scored.sort((a, b) => b.match_score - a.match_score);
    allMatchRows.push(...scored.slice(0, MAX_MATCHES_PER_DISTRICT));
  }

  console.log(`[matchGrants] Computed ${allMatchRows.length} total match rows (top ${MAX_MATCHES_PER_DISTRICT} per district).`);
  return allMatchRows;
}

export async function upsertMatches(matchRows) {
  if (!matchRows.length) return { inserted: 0, failed: 0 };

  // Clear old matches first — this is a full recompute each run, not an
  // incremental update, since match scores can shift if district/grant data changes.
  const { error: deleteError } = await supabase.from("district_grant_matches").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  if (deleteError) {
    console.error("[matchGrants] Failed to clear old matches:", deleteError.message);
  }

  // Insert in batches to avoid one giant request
  const BATCH_SIZE = 500;
  let inserted = 0;
  let failed = 0;

  for (let i = 0; i < matchRows.length; i += BATCH_SIZE) {
    const batch = matchRows.slice(i, i + BATCH_SIZE);
    const { data, error } = await supabase.from("district_grant_matches").insert(batch).select("id");
    if (error) {
      console.error(`[matchGrants] Batch insert failed (rows ${i}-${i + batch.length}):`, error.message);
      failed += batch.length;
    } else {
      inserted += data.length;
    }
  }

  return { inserted, failed };
}
