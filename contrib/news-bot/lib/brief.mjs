// The morning brief: one post a day with what happened overnight and what's ahead, built
// from what the bot already knows (recent headlines, prices, the calendar and the odds).

import { formatCalendarLine } from "./markets.mjs";
import { quoteLine } from "./prices.mjs";
import { CATEGORIES } from "./sources.mjs";

const HOUR_MS = 60 * 60 * 1000;
const OVERNIGHT_MS = 14 * HOUR_MS;
const BRIEF_MARKETS = ["ES=F", "^TNX", "CL=F", "GC=F", "DX-Y.NYB", "BTC-USD"];
// Discord allows 4096 characters per embed, and Google News links alone can run to 400.
const MAX_DESCRIPTION = 3800;

/** A Markdown link that a headline's brackets or a URL's parentheses can't break. */
export function markdownLink(text, url) {
  const label = String(text || "")
    .replace(/[[\]]/g, "")
    .trim();
  return /^https?:\/\/\S+$/.test(url || "") ? `[${label}](${url.replace(/\)/g, "%29")})` : label;
}

function localDay(ms, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(new Date(ms));
}

function leadingOutcome(scenario) {
  const [top] = [...scenario.markets].sort((a, b) => b.probability - a.probability);
  if (!top) return "";
  const label = scenario.markets.length === 1 ? "Yes" : top.label;
  return `${label} ${Math.round(top.probability * 100)}%`;
}

/** The brief's embeds, or [] when the bot has nothing to say yet. */
export function buildBrief(state, { now = Date.now(), timeZone = "America/New_York" } = {}) {
  const recent = state.recentHeadlines.filter((h) => now - h.at < OVERNIGHT_MS).reverse();
  const news = recent.filter((h) => h.category !== "trump");
  const top = news.filter((h) => h.hot).slice(0, 8);
  // A quiet night: fill up with top stories.
  for (const h of news.filter((h) => !h.hot && h.category === "breaking")) {
    if (top.length >= 5) break;
    top.push(h);
  }
  const posts = recent.filter((h) => h.category === "trump");
  let trump = "";
  if (posts.length) {
    const text = posts[0].text || "";
    const latest = text ? `: “${text.length > 160 ? `${text.slice(0, 160).trim()}…` : text}”` : "";
    trump =
      `\n🇺🇸 Trump posted ${posts.length} time${posts.length === 1 ? "" : "s"} on Truth Social overnight. ` +
      `${markdownLink("Latest", posts[0].link)}${latest}`;
  }
  // Whole stories only, as many as fit next to the Trump line.
  const lines = [];
  let length = trump.length;
  for (const h of top) {
    // The person for watchlist stories, otherwise the outlet (not "Google News").
    const credit = h.category === "people" ? h.who : h.source || h.who;
    const line = `• ${markdownLink(h.title, h.link)} · ${credit}`;
    if (length + line.length + 1 > MAX_DESCRIPTION) break;
    lines.push(line);
    length += line.length + 1;
  }
  if (trump) lines.push(trump);

  const today = localDay(now, timeZone);
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(now));
  const embeds = [];
  if (lines.length) {
    embeds.push({
      color: CATEGORIES.breaking.color,
      title: `☀️ Morning brief · ${date}`,
      description: lines.join("\n"),
    });
  }
  // Only prices from the last 12 hours count as "this morning" (not Friday's on a Sunday).
  const quotes = BRIEF_MARKETS.map((s) => state.marketQuotes?.find((q) => q.symbol === s)).filter(
    (q) => q && now - q.asOf < 12 * HOUR_MS
  );
  if (quotes.length) {
    embeds.push({
      color: CATEGORIES.prices.color,
      title: "📊 Markets this morning",
      description: quotes.map(quoteLine).join("\n"),
    });
  }
  const events = (state.calendarEvents || []).filter(
    (e) => e.impact === "High" && e.time >= now && localDay(e.time, timeZone) === today
  );
  if (events.length) {
    embeds.push({
      color: CATEGORIES.calendar.color,
      title: "📅 On the calendar today",
      description: events.map((e) => formatCalendarLine(e, timeZone)).join("\n"),
    });
  }
  const scenarios = (state.latestScenarios || []).slice(0, 3);
  if (scenarios.length) {
    embeds.push({
      color: CATEGORIES.predictions.color,
      title: "🔮 What could happen",
      description: scenarios
        .map((s) => `• ${markdownLink(s.title, s.url)}: **${leadingOutcome(s)}**`)
        .join("\n"),
      footer: { text: "Prediction-market odds, not financial advice" },
    });
  }
  return embeds;
}

const DAY_MS = 24 * HOUR_MS;

/**
 * The week ahead, posted on Sunday evenings: the coming week's high-impact releases,
 * day by day, and the biggest open questions. [] when there is nothing to say.
 */
export function buildWeekAhead(state, { now = Date.now(), timeZone = "America/New_York" } = {}) {
  const dayName = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  const events = (state.calendarEvents || [])
    .filter((e) => e.impact === "High" && e.time >= now && e.time < now + 7 * DAY_MS)
    .sort((a, b) => a.time - b.time);
  const lines = [];
  let lastDay = "";
  for (const e of events) {
    const day = dayName.format(new Date(e.time));
    if (day !== lastDay) {
      lines.push(`${lines.length ? "\n" : ""}**${day}**`);
      lastDay = day;
    }
    lines.push(formatCalendarLine(e, timeZone));
  }
  const embeds = [];
  if (lines.length) {
    let description = "";
    for (const line of lines) {
      if (description.length + line.length + 1 > MAX_DESCRIPTION) break;
      description += `${description ? "\n" : ""}${line}`;
    }
    embeds.push({
      color: CATEGORIES.calendar.color,
      title: "🗓️ The week ahead: market-moving releases",
      description,
      footer: {
        text: "Economic calendar · high-impact releases often move stocks, bonds and currencies",
      },
    });
  }
  const scenarios = (state.latestScenarios || []).slice(0, 5);
  if (scenarios.length) {
    embeds.push({
      color: CATEGORIES.predictions.color,
      title: "🔮 What could happen this week",
      description: scenarios
        .map((s) => `• ${markdownLink(s.title, s.url)}: **${leadingOutcome(s)}**`)
        .join("\n"),
      footer: { text: "Prediction-market odds, not financial advice" },
    });
  }
  return embeds;
}
