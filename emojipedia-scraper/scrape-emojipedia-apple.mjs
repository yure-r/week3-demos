import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const START_URL = "https://emojipedia.org/apple";
const OUTPUT = path.resolve("apple_emojis.json");

// Scrolling/harvest tuning
const VIEWPORT = { width: 1280, height: 2000 }; // taller viewport hydrates more items per step
const STEP_PAUSE_MS = 250;     // wait after each scroll step
const QUIET_MS = 1500;         // stop after this long with no new items
const MAX_PASSES = 800;        // absolute safety cap
const EDGE_NUDGE_PX = 120;     // small nudges to tick IntersectionObservers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function upsizeThumb(url, desired = null) {
  if (!url || !desired) return url;
  return url.replace(/\/thumbs\/(\d+)\//, `/thumbs/${desired}/`);
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);

  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
  );

  // Don’t block images; we only read the URL from style/data-src, but some sites
  // set those only after image request fires. Keep defaults.
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });

  // Wait for *some* emoji tile to exist before starting.
  // We try a few selector variants because classes can churn.
  const candidateSelector =
    'a[aria-label^="Image link to page for"], a[class*="Emoji_emoji-image"], a[href^="/apple/"]';
  await page.waitForSelector(candidateSelector, { timeout: 15000 }).catch(() => {});

  // Helper to harvest whatever is currently mounted and has an image ready.
  const harvestBatch = async () => {
    return await page.evaluate(() => {
      const extractBgUrl = (styleStr = "") => {
        const m = styleStr.match(/background-image:\s*url\((["']?)(.*?)\1\)/i);
        return m ? m[2] : null;
      };

      const anchors = Array.from(
        document.querySelectorAll(
          'a[aria-label^="Image link to page for"], a[class*="Emoji_emoji-image"], a[href^="/apple/"]'
        )
      );

      const pickImageUrl = (el) => {
        // Prefer data-src if it points at the emoji CDN
        const ds = el.getAttribute("data-src");
        if (ds && /\bem-content\.zobj\.net\b|\bem-content\.zobjcdn\b/.test(ds)) return ds;

        // inline style
        const style = el.getAttribute("style") || "";
        const fromStyle = extractBgUrl(style);
        if (fromStyle && /\bem-content\.zobj\.net\b|\bem-content\.zobjcdn\b/.test(fromStyle)) return fromStyle;

        // computed style fallback
        const computed = getComputedStyle(el).backgroundImage || "";
        const m = computed.match(/url\((["']?)(.*?)\1\)/i);
        const fromComputed = m ? m[2] : null;
        if (fromComputed && /\bem-content\.zobj\.net\b|\bem-content\.zobjcdn\b/.test(fromComputed)) return fromComputed;

        return null;
      };

      const out = [];
      for (const a of anchors) {
        const href = a.getAttribute("href") || "";
        const img = pickImageUrl(a);
        if (!img) continue;

        let slug = null;
        try {
          const parts = href.split("/").filter(Boolean);
          slug = decodeURIComponent(parts[parts.length - 1]);
        } catch {}

        if (!slug) continue;

        const name = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        out.push({
          slug,
          name,
          href: new URL(href, "https://emojipedia.org").toString(),
          image: img,
        });
      }
      return out;
    });
  };

  // Scroll incrementally and harvest at every step
  const collected = new Map(); // slug -> {name, href, image}
  let lastAddedAt = Date.now();
  let passes = 0;

  // Start at the very top
  await page.evaluate(() => (document.scrollingElement || document.documentElement).scrollTo(0, 0));
  await sleep(400);

  while (passes < MAX_PASSES) {
    // 1) Harvest whatever's currently mounted
    const batch = await harvestBatch();
    let newCount = 0;
    for (const item of batch) {
      if (!collected.has(item.slug)) {
        collected.set(item.slug, item);
        newCount++;
      }
    }
    if (newCount > 0) {
      lastAddedAt = Date.now();
      console.log(`harvested ${newCount} new, total: ${collected.size}`);
    }

    // 2) Scroll one viewport down (+ small nudge to trip observers)
    const atBottom = await page.evaluate((EDGE_NUDGE_PX) => {
      const el = document.scrollingElement || document.documentElement;
      const before = el.scrollTop;
      const next = Math.min(before + el.clientHeight * 0.9 + EDGE_NUDGE_PX, el.scrollHeight);
      el.scrollTo(0, next);
      const bottom = next >= el.scrollHeight - el.clientHeight - 1 || next === before;
      return bottom;
    }, EDGE_NUDGE_PX);

    await sleep(STEP_PAUSE_MS);
    passes++;

    // 3) Exit conditions
    if (Date.now() - lastAddedAt > QUIET_MS) {
      console.log("No new items recently; stopping.");
      break;
    }
    if (atBottom) {
      console.log("Reached bottom; doing end-of-page passes…");

      // Final harvest at bottom
      for (let i = 0; i < 3; i++) {
        // small up/down nudges to tick any stragglers
        await page.evaluate((EDGE_NUDGE_PX) => {
          const el = document.scrollingElement || document.documentElement;
          el.scrollTo(0, Math.max(0, el.scrollTop - EDGE_NUDGE_PX));
        }, EDGE_NUDGE_PX);
        await sleep(STEP_PAUSE_MS);
        await page.evaluate((EDGE_NUDGE_PX) => {
          const el = document.scrollingElement || document.documentElement;
          el.scrollTo(0, el.scrollTop + EDGE_NUDGE_PX);
        }, EDGE_NUDGE_PX);
        await sleep(STEP_PAUSE_MS);

        const b = await harvestBatch();
        let added = 0;
        for (const it of b) {
          if (!collected.has(it.slug)) {
            collected.set(it.slug, it);
            added++;
          }
        }
        if (added > 0) {
          lastAddedAt = Date.now();
          console.log(`end-pass added ${added}, total: ${collected.size}`);
        }
      }
      break;
    }
  }

  // Optional: upsize thumbs (set to 120 or 160 if you want larger thumbs)
  const DESIRED_THUMB_SIZE = null;

  const bySlug = {};
  for (const [slug, { name, href, image }] of collected.entries()) {
    bySlug[slug] = {
      name,
      href,
      image: upsizeThumb(image, DESIRED_THUMB_SIZE),
    };
  }

  await fs.writeFile(OUTPUT, JSON.stringify(bySlug, null, 2), "utf8");
  console.log(`✅ Saved ${Object.keys(bySlug).length} emojis to ${OUTPUT}`);

  await browser.close();
})().catch((err) => {
  console.error("Scrape failed:", err);
  process.exit(1);
});
