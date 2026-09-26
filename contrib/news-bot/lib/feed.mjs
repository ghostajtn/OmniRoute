// Snapshot of what the bot has posted, published as feed.json for the News Radar
// web app (contrib/news-bot/app). Everything in it is public news and market data.

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const FEED_VERSION = 1;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/** The subset of a prediction-market scenario the app shows. */
export function compactScenario(scenario) {
  return {
    id: scenario.id,
    title: scenario.title,
    url: scenario.url,
    volume24h: Math.round(scenario.volume24h),
    markets: scenario.markets.slice(0, 4).map((m) => ({
      label: m.label,
      question: m.question,
      probability: round(m.probability, 4),
      dayChange: m.dayChange === null ? null : round(m.dayChange, 4),
    })),
  };
}

/** The subset of an economic-calendar event the app shows. */
export function compactEvent(event) {
  return {
    title: event.title,
    country: event.country,
    impact: event.impact,
    time: event.time,
    forecast: event.forecast || "",
    previous: event.previous || "",
  };
}

export function buildFeed(state, now = Date.now()) {
  return {
    version: FEED_VERSION,
    generatedAt: new Date(now).toISOString(),
    headlines: [...state.recentHeadlines].reverse(),
    scenarios: state.latestScenarios || [],
    oddsMoves: [...(state.recentOddsMoves || [])].reverse(),
    events: (state.calendarEvents || []).filter(
      (e) => e.time >= now - 2 * HOUR_MS && e.time < now + 7 * DAY_MS
    ),
    outlook: state.lastOutlook || null,
    markets: state.marketQuotes || [],
  };
}

export async function writeFeed(file, feed) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(feed));
  await rename(tmp, file);
}
