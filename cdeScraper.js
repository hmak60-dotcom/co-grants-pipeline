import { chromium } from "playwright";

const CDE_FORECAST_URL = "https://ed.cde.state.co.us/cdeawards/grants";

/**
 * CDE's Competitive Grants and Awards Forecast has no public API —
 * it's a server-rendered table/list. We scrape it on a schedule rather
 * than re-fetching live on every page load.
 *
 * IMPORTANT: re-check this selector logic periodically. CDE has migrated
 * this page between a plain table and an embedded Smartsheet iframe before.
 * If `programRows.length === 0`, check screenshot.png (saved below) to see
 * what actually rendered before assuming the scraper is broken vs. the
 * page structure changed.
 */
export async function scrapeCdeForecast() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const results = [];

  try {
    await page.goto(CDE_FORECAST_URL, { waitUntil: "networkidle", timeout: 30000 });

    // Defensive: take a screenshot for debugging if structure ever shifts
    await page.screenshot({ path: "ingest/_debug_cde_forecast.png", fullPage: true }).catch(() => {});

    // CDE forecast is typically rendered as a table with program name,
    // office, status, due date, and a link to the program's own page.
    const rows = await page.$$eval("table tr", (trs) =>
      trs.map((tr) => {
        const cells = Array.from(tr.querySelectorAll("td")).map((td) => td.innerText.trim());
        const link = tr.querySelector("a")?.href || null;
        return { cells, link };
      })
    );

    for (const row of rows) {
      if (!row.cells.length || row.cells.every((c) => !c)) continue;
      results.push({
        programName: row.cells[0] || null,
        office: row.cells[1] || null,
        status: row.cells[2] || null,
        dueDate: row.cells[3] || null,
        sourceUrl: row.link,
        rawCells: row.cells,
      });
    }

    // If the embedded view is actually a Smartsheet iframe instead of a table,
    // table scraping will return nothing — fall back to grabbing iframe text.
    if (results.length === 0) {
      const iframeEl = await page.$("iframe");
      if (iframeEl) {
        const frame = await iframeEl.contentFrame();
        if (frame) {
          const text = await frame.evaluate(() => document.body.innerText);
          results.push({ rawIframeText: text, sourceUrl: CDE_FORECAST_URL });
        }
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}

/**
 * Each program in the forecast links to its own subpage with the real
 * description, eligibility, and amount. Fetch those too, but cap concurrency
 * since CDE's site is not built for heavy traffic.
 */
export async function scrapeCdeProgramDetail(url) {
  if (!url) return null;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
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
