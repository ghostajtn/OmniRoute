// Tiny JSON state file: which stories were already posted, prediction-market
// baselines, and when each periodic digest last ran.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const SEEN_TTL_MS = 4 * DAY_MS;
// The app keeps two days of headlines, capped per section so a busy section (the
// watchlist can add 40 stories an hour) never pushes a quiet one (Trump, the Fed) out.
const HEADLINE_TTL_MS = 2 * DAY_MS;
const HEADLINES_PER_CATEGORY = 80;
const MAX_RECENT_ODDS_MOVES = 30;

export function emptyState() {
  return {
    version: 1,
    initialized: false,
    seen: {},
    oddsBaseline: {},
    lastPredictionsAt: 0,
    lastOutlookAt: 0,
    lastCalendarDay: "",
    recentHeadlines: [],
    // Kept for the web app's feed.json (see lib/feed.mjs).
    latestScenarios: [],
    recentOddsMoves: [],
    calendarEvents: [],
    lastOutlook: null,
    marketQuotes: [],
    priceAlerts: {},
    lastCloseDay: "",
  };
}

export async function loadState(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return { ...emptyState(), ...parsed };
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[news-bot] Could not read state file (${err.message}); starting fresh`);
    }
    return emptyState();
  }
}

export async function saveState(file, state) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, file);
}

function hash(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

/** Headline normalised so the same story from two feeds/queries dedupes. */
export function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function itemKeys(item) {
  const keys = [];
  // Titles catch one story carried by several feeds. Truth Social posts are unique by link,
  // and their titles are often a placeholder ("[No Title] - Post from <date>").
  const title = item.category === "trump" ? "" : normalizeTitle(item.title);
  if (title) keys.push(`t:${hash(title)}`);
  const id = item.guid || item.link;
  if (id) keys.push(`l:${hash(id)}`);
  return keys;
}

export function isSeen(state, item) {
  return itemKeys(item).some((key) => key in state.seen);
}

export function markSeen(state, item, now = Date.now()) {
  for (const key of itemKeys(item)) state.seen[key] = now;
}

export function pruneState(state, now = Date.now()) {
  for (const [key, ts] of Object.entries(state.seen)) {
    if (now - ts > SEEN_TTL_MS) delete state.seen[key];
  }
  state.recentHeadlines = trimHeadlines(state.recentHeadlines, now);
  if (state.recentOddsMoves.length > MAX_RECENT_ODDS_MOVES) {
    state.recentOddsMoves = state.recentOddsMoves.slice(-MAX_RECENT_ODDS_MOVES);
  }
}

/** Newest `HEADLINES_PER_CATEGORY` per section from the last two days, oldest first. */
function trimHeadlines(headlines, now) {
  const perCategory = new Map();
  const kept = [];
  for (let i = headlines.length - 1; i >= 0; i--) {
    const h = headlines[i];
    const count = perCategory.get(h.category) || 0;
    if (now - h.at > HEADLINE_TTL_MS || count >= HEADLINES_PER_CATEGORY) continue;
    perCategory.set(h.category, count + 1);
    kept.push(h);
  }
  return kept.reverse();
}

export function rememberHeadline(state, item, now = Date.now()) {
  state.recentHeadlines.push({
    title: item.title,
    link: item.link,
    source: item.source || item.feedName,
    who: item.person || item.feedName,
    category: item.category,
    published: item.published || null,
    hot: Boolean(item.hot),
    // Truth Social posts carry their text in the summary; other feeds only need the title.
    text: item.category === "trump" ? String(item.summary || "").slice(0, 600) : "",
    ...(item.mediaKind ? { media: item.mediaKind } : {}),
    at: now,
  });
}
