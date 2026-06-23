/**
 * Plain-code normalizer — replaces the Claude-based normalizeWithClaude.js
 * for people who don't want to pay for Anthropic API usage. Works well for
 * Grants.gov since its API already returns structured fields (no prose to
 * parse). Less effective for CDE's forecast page, which is mostly just
 * (title, office, status, due date) — also handled here with a simpler
 * direct mapping, just without rich description text.
 */

const CATEGORY_KEYWORDS = [
  { category: "STEM", keywords: ["stem", "science", "math", "computer science", "engineering"] },
  { category: "Literacy", keywords: ["literacy", "reading", "early literacy"] },
  { category: "Mental Health", keywords: ["mental health", "behavioral health", "counselor", "wellness", "social emotional"] },
  { category: "English Language Learners", keywords: ["english language learner", "ell", "english learner", "bilingual"] },
  { category: "Special Education", keywords: ["special education", "disabilit", "idea", "gifted"] },
  { category: "Career & Technical Education", keywords: ["career and technical", "cte", "perkins", "workforce readiness", "career pathway"] },
  { category: "Technology", keywords: ["technology", "computer", "broadband", "digital"] },
  { category: "Teacher Development", keywords: ["teacher", "educator", "professional development", "mentor"] },
  { category: "Arts", keywords: ["art", "music", "tiger music"] },
  { category: "Workforce Development", keywords: ["workforce", "apprenticeship", "job training"] },
  { category: "School Improvement", keywords: ["school improvement", "turnaround", "accountability", "charter"] },
];

const FOCUS_AREA_KEYWORDS = [
  { tag: "stem", keywords: ["stem", "science", "math", "engineering"] },
  { tag: "technology", keywords: ["technology", "computer", "digital", "broadband"] },
  { tag: "teacher", keywords: ["teacher", "educator", "mentor"] },
  { tag: "literacy", keywords: ["literacy", "reading"] },
  { tag: "mental_health", keywords: ["mental health", "behavioral health", "wellness", "counselor"] },
  { tag: "ell", keywords: ["english language learner", "ell", "bilingual"] },
  { tag: "special_education", keywords: ["special education", "disabilit", "idea"] },
  { tag: "career_readiness", keywords: ["career", "cte", "pathway"] },
  { tag: "workforce", keywords: ["workforce", "apprenticeship", "job training"] },
  { tag: "school_improvement", keywords: ["school improvement", "turnaround", "accountability"] },
  { tag: "equity", keywords: ["equity", "underserved", "disadvantaged", "at-risk", "at risk"] },
  { tag: "arts", keywords: ["art", "music"] },
  { tag: "after_school", keywords: ["after school", "after-school", "out-of-school", "21st century community learning"] },
  { tag: "college_readiness", keywords: ["college readiness", "concurrent enrollment", "postsecondary"] },
  { tag: "community_support", keywords: ["community", "family", "homeless", "foster"] },
];

function inferCategory(text) {
  const lower = (text || "").toLowerCase();
  for (const { category, keywords } of CATEGORY_KEYWORDS) {
    if (keywords.some((k) => lower.includes(k))) return category;
  }
  return "Education";
}

function inferFocusAreas(text) {
  const lower = (text || "").toLowerCase();
  const tags = FOCUS_AREA_KEYWORDS.filter(({ keywords }) => keywords.some((k) => lower.includes(k))).map((f) => f.tag);
  return tags.length ? tags : [];
}

/**
 * Education-relevance filter — plain keyword check since we don't have
 * an LLM judging intent anymore. Conservative: requires at least one
 * clear K-12/education signal word.
 */
const EDUCATION_SIGNAL_WORDS = [
  "school", "education", "student", "teacher", "k-12", "k12", "district",
  "literacy", "stem", "classroom", "academic", "youth", "elementary",
  "secondary", "early childhood", "pre-k", "prek",
];

function isEducationRelevant(text) {
  const lower = (text || "").toLowerCase();
  return EDUCATION_SIGNAL_WORDS.some((w) => lower.includes(w));
}

/**
 * Maps a raw Grants.gov opportunity (summary + optional detail) directly
 * into our grants schema — no LLM needed, since Grants.gov's API already
 * gives structured fields.
 */
export function mapGrantsGovOpportunity({ summary, detail }) {
  const title = summary?.title || detail?.opportunityTitle || null;
  if (!title) return null;

  const descriptionSource = detail?.synopsis?.synopsisDesc || summary?.description || "";
  const combinedTextForInference = `${title} ${descriptionSource}`;

  if (!isEducationRelevant(combinedTextForInference)) return null;

  const awardCeiling = detail?.synopsis?.awardCeiling ? Number(detail.synopsis.awardCeiling) : null;
  const awardFloor = detail?.synopsis?.awardFloor ? Number(detail.synopsis.awardFloor) : null;

  let fundingAmountText = null;
  if (awardCeiling) fundingAmountText = awardFloor ? `$${awardFloor.toLocaleString()} - $${awardCeiling.toLocaleString()}` : `Up to $${awardCeiling.toLocaleString()}`;

  return {
    title,
    funding_source: summary?.agencyName || detail?.agencyName || "Federal (via Grants.gov)",
    description: descriptionSource
      ? descriptionSource.slice(0, 500) // keep it bounded, this is raw agency text not LLM-summarized
      : `Federal grant opportunity: ${title}.`,
    eligibility_requirements: detail?.synopsis?.applicantEligibilityDesc || null,
    funding_amount_text: fundingAmountText,
    possible_funding_amount: awardCeiling || null,
    deadline_text: detail?.synopsis?.responseDate || summary?.closeDate || null,
    is_recurring: false,
    category: inferCategory(combinedTextForInference),
    focus_area: inferFocusAreas(combinedTextForInference),
    source_name: "grants.gov",
    source_url: summary?.id ? `https://www.grants.gov/search-results-detail/${summary.id}` : null,
  };
}

/**
 * Maps a raw CDE forecast row directly into our grants schema — no LLM.
 * CDE's forecast table itself only gives (program name, office, status,
 * due date, link) — there's no prose description to summarize, so this
 * is inherently thinner data than the Claude path would have produced.
 * The linked detail page's full text is stored in raw_payload for your
 * own manual reading later, but not auto-summarized into `description`.
 */
export function mapCdeForecastRow(row) {
  const title = row.programName;
  if (!title) return null;

  const combinedText = `${title} ${row.office || ""}`;

  return {
    title,
    funding_source: row.office ? `Colorado Department of Education (${row.office})` : "Colorado Department of Education",
    description: `Competitive grant program administered by CDE's ${row.office || "relevant"} office. See source link for full program details and eligibility.`,
    eligibility_requirements: null, // not available without reading detail.rawText, which we're not LLM-summarizing
    funding_amount_text: null,
    possible_funding_amount: null,
    deadline_text: row.dueDate || row.status || null,
    is_recurring: true, // most CDE competitive grants recur annually/cyclically
    category: inferCategory(combinedText),
    focus_area: inferFocusAreas(combinedText),
    source_name: "cde",
    source_url: row.sourceUrl || null,
  };
}
