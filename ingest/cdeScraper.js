import { chromium } from "playwright";

const CDE_FORECAST_URL = "https://ed.cde.state.co.us/cdeawards/grants";

/**
 * CDE's Competitive Grants page is NOT a table — it's structured as a series
 * of <h3> category headings (e.g. "Health and Wellness", "Educator
 * Development") each followed by a bullet list of program name + link.
 * Confirmed via direct fetch (June 2026). No due dates or funding amounts
 * are on this page directly — those live in a separate, JS-rendered
 * Smartsheet embed (app.smartsheet.com) that isn't practically scrapable
 * the same way. This scraper gets program name + category + link; deadline/
 * amount stay null unless you follow each link to its own detail page
 * (scrapeCdeProgramDetail below already does this for whatever text is there).
 */
export async function scrapeCdeForecast() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const results = [];

  try {
    await page.goto(CDE_FORECAST_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);

    await page.screenshot({ path: "ingest/_debug_cde_forecast.png", fullPage: true }).catch(() => {});

    // Real program detail links follow a consistent pattern: /fs/pages/####
    // (confirmed across every program link on this page). This is a far more
    // reliable filter than trying to scope by heading structure, since the
    // page's nav/footer have hundreds of unrelated links that don't follow
    // this pattern.
    const rows = await page.evaluate(() => {
      const out = [];
      const allLinks = Array.from(document.querySelectorAll("a"));
      const programLinkPattern = /\/fs\/pages\/\d+/;

      for (const a of allLinks) {
        if (!programLinkPattern.test(a.href)) continue;
        const title = a.innerText.trim();
        if (!title) continue;

        let office = null;
        let el = a.closest("li, p, div");
        let cursor = el;
        for (let i = 0; i < 10 && cursor; i++) {
          cursor = cursor.previousElementSibling || cursor.parentElement;
          if (cursor && cursor.tagName === "H3") {
            office = cursor.innerText.trim();
            break;
          }
        }

        out.push({ office, programName: title, sourceUrl: a.href });
      }
      return out;
    });

    for (const row of rows) {
      results.push({
        programName: row.programName,
        office: row.office,
        status: null,
        dueDate: null,
        sourceUrl: row.sourceUrl,
      });
    }

    const seen = new Set();
    return results.filter((r) => {
      const key = `${r.programName}|${r.sourceUrl}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } finally {
    await browser.close();
  }
}

export async function scrapeCdeProgramDetail(url) {
  if (!url) return null;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    const text = await page.evaluate(() => document.querySelector("main")?.innerText || document.body.innerText);
    return { url, rawText: text };
  } catch (err) {
    console.error(`CDE detail scrape failed for ${url}:`, err.message);
    return null;
  } finally {
    await browser.close();
  }
}

export async function scrapeCdeFull() {
  const forecastRows = await scrapeCdeForecast();
  const full = [];

  for (const row of forecastRows) {
    const detail = row.sourceUrl ? await scrapeCdeProgramDetail(row.sourceUrl) : null;
    full.push({ ...row, detail });
    await new Promise((r) => setTimeout(r, 500)); // be polite
  }

  return full;
}
