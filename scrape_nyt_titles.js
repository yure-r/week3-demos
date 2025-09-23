#!/usr/bin/env node
/**
 * Scrape NYT story titles from the homepage + common sections.
 * Outputs:
 *   - nyt_headlines.json   (rich objects)
 *   - nyt_titles_only.json (array of strings)
 */

const fs = require("fs").promises;
const axios = require("axios");
const cheerio = require("cheerio");

// --- Config ---------------------------------------------------------------

const START_URLS = [
  { section: "Home", url: "https://www.nytimes.com/" },
  { section: "World", url: "https://www.nytimes.com/section/world" },
  { section: "U.S.", url: "https://www.nytimes.com/section/us" },
  { section: "Politics", url: "https://www.nytimes.com/section/politics" },
  { section: "Business", url: "https://www.nytimes.com/section/business" },
  { section: "Technology", url: "https://www.nytimes.com/section/technology" },
  { section: "Science", url: "https://www.nytimes.com/section/science" },
  { section: "Health", url: "https://www.nytimes.com/section/health" },
  { section: "Sports", url: "https://www.nytimes.com/section/sports" },
  { section: "Arts", url: "https://www.nytimes.com/section/arts" },
  { section: "Books", url: "https://www.nytimes.com/section/books" },
  { section: "Food", url: "https://www.nytimes.com/section/food" },
  { section: "Travel", url: "https://www.nytimes.com/section/travel" },
  { section: "Magazine", url: "https://www.nytimes.com/section/magazine" },
  { section: "Opinion", url: "https://www.nytimes.com/section/opinion" },
];

const MAX_CONCURRENCY = 3;        // be polite
const PER_REQUEST_DELAY_MS = 800; // small pause between requests
const OUT_FULL = "nyt_headlines.json";
const OUT_TITLES = "nyt_titles_only.json";

// --- Minimal concurrency limiter (CommonJS-friendly) ----------------------
function pLimit(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then((v) => { active--; resolve(v); next(); })
      .catch((e) => { active--; reject(e); next(); });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

// --- Helpers --------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchHTML(url) {
  const res = await axios.get(url, {
    timeout: 20000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif," +
        "image/webp,image/apng,*/*;q=0.8",
    },
    validateStatus: (s) => s >= 200 && s < 400,
  });
  return res.data;
}

function absoluteURL(link, base) {
  try {
    return new URL(link, base).toString();
  } catch {
    return null;
  }
}

// Extract headlines from JSON-LD (NewsArticle/Article)
function extractFromJSONLD($, baseUrl, section) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    try {
      const data = JSON.parse(raw);
      const flatten = (node) => {
        if (Array.isArray(node)) return node.flatMap(flatten);
        if (node && typeof node === "object") {
          return [node, ...Object.values(node).flatMap(flatten)];
        }
        return [];
      };
      const nodes = flatten(data).filter(
        (n) =>
          n &&
          typeof n === "object" &&
          (n["@type"] === "NewsArticle" || n["@type"] === "Article")
      );
      for (const n of nodes) {
        const title = String(n.headline || n.name || "").trim();
        const url =
          n.url ||
          (n.mainEntityOfPage && n.mainEntityOfPage["@id"]) ||
          null;
        if (title && title.length > 5) {
          out.push({
            title,
            url: url ? absoluteURL(url, baseUrl) : null,
            section,
            sourceUrl: baseUrl,
            source: "ld+json",
          });
        }
      }
    } catch {
      /* ignore malformed JSON-LD */
    }
  });
  return out;
}

// Extract headlines from DOM
function extractFromDOM($, baseUrl, section) {
  const out = [];
  const headingSel =
    "article h1, article h2, article h3, section h2, section h3, h2, h3";
  $(headingSel).each((_, el) => {
    const title = $(el).text().replace(/\s+/g, " ").trim();
    if (!title || title.length < 5) return;
    if (/^(advertisement|most popular|sign in|log in)$/i.test(title)) return;

    let href =
      $(el).closest("a").attr("href") ||
      $(el).find("a").attr("href") ||
      $(el).parent().closest("a").attr("href") ||
      null;

    const url = href ? absoluteURL(href, baseUrl) : null;

    out.push({
      title,
      url,
      section,
      sourceUrl: baseUrl,
      source: "dom",
    });
  });
  return out;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => {
    const key = (it.title + "|" + (it.url || "")).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- Main crawl -----------------------------------------------------------

async function crawl() {
  const limit = pLimit(MAX_CONCURRENCY);
  const all = [];
  const sources = [];

  const tasks = START_URLS.map(({ section, url }) =>
    limit(async () => {
      try {
        const html = await fetchHTML(url);
        const $ = cheerio.load(html);

        let items = [
          ...extractFromJSONLD($, url, section),
          ...extractFromDOM($, url, section),
        ];
        items = dedupe(items);

        sources.push({ section, url, count: items.length });
        all.push(...items);
        await sleep(PER_REQUEST_DELAY_MS);
      } catch (err) {
        console.error(`Error scraping ${section} (${url}):`, err.message);
      }
    })
  );

  await Promise.all(tasks);

  const deduped = dedupe(all);
  const data = {
    scrapedAt: new Date().toISOString(),
    total: deduped.length,
    sources: sources.sort((a, b) => a.section.localeCompare(b.section)),
    headlines: deduped.sort(
      (a, b) =>
        a.section.localeCompare(b.section) || a.title.localeCompare(b.title)
    ),
  };

  await fs.writeFile(OUT_FULL, JSON.stringify(data, null, 2), "utf8");
  await fs.writeFile(
    OUT_TITLES,
    JSON.stringify(deduped.map((d) => d.title), null, 2),
    "utf8"
  );

  console.log(
    `Saved ${deduped.length} headlines to ${OUT_FULL} and ${OUT_TITLES}`
  );
}

crawl().catch((e) => {
  console.error(e);
  process.exit(1);
});
