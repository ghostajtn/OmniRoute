// Tiny JSON state file: which stories were already posted, prediction-market
// baselines, and when each periodic digest last ran.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const SEEN_TTL_MS = 4 * 24 * 60 * 60 * 1000;
const MAX_RECENT_HEADLINES = 200;
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
  const title = normalizeTitle(item.title);
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
  if (state.recentHeadlines.length > MAX_RECENT_HEADLINES) {
    state.recentHeadlines = state.recentHeadlines.slice(-MAX_RECENT_HEADLINES);
  }
  if (state.recentOddsMoves.length > MAX_RECENT_ODDS_MOVES) {
    state.recentOddsMoves = state.recentOddsMoves.slice(-MAX_RECENT_ODDS_MOVES);
  }
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
    at: now,
  });
}
