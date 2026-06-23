import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CATEGORY_ENUM = [
  "Education", "STEM", "Technology", "Teacher Development", "Mental Health",
  "Literacy", "Career & Technical Education", "English Language Learners",
  "Special Education", "School Improvement", "Arts", "Workforce Development",
  "Research", "Other",
];

const FOCUS_AREA_ENUM = [
  "stem", "technology", "teacher", "literacy", "mental_health", "ell",
  "special_education", "career_readiness", "workforce", "school_improvement",
  "equity", "arts", "research", "after_school", "college_readiness", "community_support",
];

const SYSTEM_PROMPT = `You convert raw, messy grant text (scraped HTML, API JSON, forecast tables) into a single clean JSON object matching an exact schema. You NEVER invent information that isn't present in the input — use null for anything not stated. You NEVER guess at dollar amounts, deadlines, or eligibility beyond what the source text actually says.

Output ONLY a JSON object (no markdown fences, no preamble) with exactly these fields:
{
  "title": string,
  "funding_source": string | null,
  "description": string,              // 1-3 sentences, your own words, summarizing the source text
  "eligibility_requirements": string | null,
  "funding_amount_text": string | null,   // exact amount as written in source, or null
  "possible_funding_amount": number | null, // numeric estimate parsed from funding_amount_text, or null if "varies"/unstated
  "deadline_text": string | null,
  "is_recurring": boolean,
  "category": one of ${JSON.stringify(CATEGORY_ENUM)},
  "focus_area": array of zero or more from ${JSON.stringify(FOCUS_AREA_ENUM)},
  "is_education_relevant": boolean   // true only if this genuinely relates to K-12 schools/districts/teachers/students
}

If the input text does not describe an actual grant (e.g. it's navigation boilerplate, an unrelated news article, or a non-education grant), set "is_education_relevant": false and fill other fields as best-effort or null — the caller will discard these.`;

/**
 * Normalize one raw record (from any source) into the structured schema.
 * `rawText` should be whatever blob of text/JSON you scraped or pulled —
 * the model does the parsing, not regex.
 */
export async function normalizeGrantRecord(rawText, { sourceName, sourceUrl } = {}) {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Source: ${sourceName || "unknown"}\nURL: ${sourceUrl || "unknown"}\n\nRaw content:\n${rawText}`,
      },
    ],
  });

  const textBlock = message.content.find((c) => c.type === "text");
  if (!textBlock) return null;

  try {
    const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed.is_education_relevant) return null;

    return {
      title: parsed.title,
      funding_source: parsed.funding_source,
      description: parsed.description,
      eligibility_requirements: parsed.eligibility_requirements,
      funding_amount_text: parsed.funding_amount_text,
      possible_funding_amount: parsed.possible_funding_amount,
      deadline_text: parsed.deadline_text,
      is_recurring: parsed.is_recurring ?? false,
      category: parsed.category,
      focus_area: parsed.focus_area || [],
      source_name: sourceName || null,
      source_url: sourceUrl || null,
    };
  } catch (err) {
    console.error("Failed to parse Claude normalization output:", err.message, textBlock.text);
    return null;
  }
}

/**
 * Batch helper — normalizes a list of raw records with basic concurrency
 * control so you don't blow through rate limits on a big scrape run.
 */
export async function normalizeBatch(rawRecords, { sourceName, concurrency = 3 } = {}) {
  const results = [];
  const queue = [...rawRecords];

  async function worker() {
    while (queue.length) {
      const record = queue.shift();
      if (!record) continue;
      const rawText = typeof record === "string" ? record : JSON.stringify(record);
      const normalized = await normalizeGrantRecord(rawText, {
        sourceName,
        sourceUrl: record?.sourceUrl || record?.source_url || null,
      });
      if (normalized) results.push(normalized);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
