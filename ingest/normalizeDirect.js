Normalizedirect · JS
/**
 * Plain-code normalizer — replaces the Claude-based normalizeWithClaude.js.
 * Works well for Grants.gov since its API already returns structured fields.
 *
 * EDUCATION RELEVANCE FILTER — tightened after real-world testing showed
 * the original single-word list was too loose. Generic words like "district"
 * (matches "congressional district" in boilerplate) and "youth" (matches
 * "youth homelessness" in HUD housing grants) let clearly non-education
 * federal grants slip through — aviation research, surgical trial networks,
 * affordable housing programs were all getting tagged as education-relevant
 * because they happened to contain one stray word.
 *
 * Now uses specific multi-word phrases, and requires either:
 *   (a) at least one match in the TITLE alone, OR
 *   (b) at least TWO distinct phrase matches in the description
 * — one stray phrase in thousands of words of boilerplate isn't a reliable
 * signal by itself.
 */
 
const CATEGORY_KEYWORDS = [
  { category: "STEM", keywords: ["stem", "science", "math", "computer science", "engineering"] },
  { category: "Literacy", keywords: ["literacy", "reading", "early literacy"] },
  { category: "Mental Health", keywords: ["mental health", "behavioral health", "counselor", "wellness", "social emotional"] },
  { category: "English Language Learners", keywords: ["english language learner", "ell", "english learner", "bilingual", "multilingual learner"] },
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
  { tag: "ell", keywords: ["english language learner", "ell", "bilingual", "multilingual learner"] },
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
  return FOCUS_AREA_KEYWORDS
    .filter(({ keywords }) => keywords.some((k) => lower.includes(k)))
    .map((f) => f.tag);
}
 
// Specific multi-word phrases that reliably indicate K-12 education content.
// Single generic words deliberately excluded — "district" matches
// "congressional district," "youth" matches "youth homelessness," etc.
const EDUCATION_SIGNAL_PHRASES = [
  "school district", "k-12", "k12", "public school", "public schools",
  "local education agency", "school system", "elementary school",
  "secondary school", "early childhood education", "pre-k education",
  "education", "student", "teacher", "literacy", "stem education",
  "classroom", "charter school", "boces",
  // Named federal/state programs whose titles don't contain a generic
  // "education" word but are clearly K-12 in scope
  "learning center", "after school", "afterschool", "out-of-school time",
  "head start", "title i", "idea part b", "perkins", "migrant education",
  "homeless education", "mckinney-vento", "21st century community learning",
  "school day", "gifted and talented", "special education",
];
 
function countSignalMatches(text) {
  const lower = (text || "").toLowerCase();
  return EDUCATION_SIGNAL_PHRASES.filter((phrase) => lower.includes(phrase)).length;
}
 
function isEducationRelevant(title, description) {
  // A single strong signal in the title is enough — grant titles are terse
  // and deliberate, so one education phrase there is highly reliable.
  const titleMatches = countSignalMatches(title);
  if (titleMatches >= 1) return true;
 
  // In the description, require at least 2 distinct phrase matches, since
  // long eligibility boilerplate often contains one stray education word
  // even in completely unrelated grants.
  const descriptionMatches = countSignalMatches(description);
  return descriptionMatches >= 2;
}
 
/**
 * Maps a raw Grants.gov opportunity (summary + optional detail) directly
 * into our grants schema — no LLM needed.
 */
export function mapGrantsGovOpportunity({ summary, detail }) {
  const title = summary?.title || detail?.opportunityTitle || null;
  if (!title) return null;
 
  const descriptionSource = detail?.synopsis?.synopsisDesc || summary?.description || "";
 
  if (!isEducationRelevant(title, descriptionSource)) return null;
 
  const combinedTextForInference = `${title} ${descriptionSource}`;
  const awardCeiling = detail?.synopsis?.awardCeiling ? Number(detail.synopsis.awardCeiling) : null;
  const awardFloor = detail?.synopsis?.awardFloor ? Number(detail.synopsis.awardFloor) : null;
 
  let fundingAmountText = null;
  if (awardCeiling) {
    fundingAmountText = awardFloor
      ? `$${awardFloor.toLocaleString()} - $${awardCeiling.toLocaleString()}`
      : `Up to $${awardCeiling.toLocaleString()}`;
  }
 
  return {
    title,
    funding_source: summary?.agencyName || detail?.agencyName || "Federal (via Grants.gov)",
    description: descriptionSource
      ? descriptionSource.slice(0, 500)
      : `Federal grant opportunity: ${title}.`,
    eligibility_requirements: detail?.synopsis?.applicantEligibilityDesc || null,
    funding_amount_text: fundingAmountText,
    possible_funding_amount: awardCeiling || null,
    deadline_text: detail?.synopsis?.responseDate || summary?.closeDate || null,
    is_recurring: false,
    category: inferCategory(combinedTextForInference),
    focus_area: inferFocusAreas(combinedTextForInference),
    source_name: "grants.gov",
    source_url: summary?.id
      ? `https://www.grants.gov/search-results-detail/${summary.id}`
      : null,
  };
}
 
/**
 * Maps a raw CDE forecast row directly into our grants schema.
 * CDE rows are always education-relevant by definition (it's CDE's own
 * competitive grants page), so no relevance filtering applied here.
 */
export function mapCdeForecastRow(row) {
  const title = row.programName;
  if (!title) return null;
 
  const combinedText = `${title} ${row.office || ""}`;
 
  return {
    title,
    funding_source: row.office
      ? `Colorado Department of Education (${row.office})`
      : "Colorado Department of Education",
    description: `Competitive grant program administered by CDE's ${row.office || "relevant"} office. See source link for full program details and eligibility.`,
    eligibility_requirements: null,
    funding_amount_text: null,
    possible_funding_amount: null,
    deadline_text: row.dueDate || row.status || null,
    is_recurring: true,
    category: inferCategory(combinedText),
    focus_area: inferFocusAreas(combinedText),
    source_name: "cde",
    source_url: row.sourceUrl || null,
  };
}
 
