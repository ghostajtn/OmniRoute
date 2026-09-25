// "What could happen": live prediction-market odds (Polymarket) and the week's
// scheduled market-moving events (economic calendar). Both are public, keyless APIs.

const POLYMARKET_EVENTS = "https://gamma-api.polymarket.com/events";
const CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

export const DEFAULT_MARKET_TAGS = ["politics", "economy", "finance", "geopolitics"];

// Short-lived or noisy markets that would spam the channel.
const DEFAULT_EXCLUDE = /\btweets?\b|up or down|above _+ on/i;

const DAY_MS = 24 * 60 * 60 * 1000;

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Probability (0..1) of the "Yes" outcome of a Polymarket market, or null. */
export function yesProbability(market) {
  const outcomes = parseJsonArray(market.outcomes);
  const prices = parseJsonArray(market.outcomePrices).map(Number);
  if (prices.length === 0) return null;
  const yesIndex = outcomes.findIndex((o) => String(o).toLowerCase() === "yes");
  const price = prices[yesIndex >= 0 ? yesIndex : 0];
  return Number.isFinite(price) ? price : null;
}

/**
 * Turn raw Polymarket events into compact "scenario" objects: one per event with its
 * most likely open outcomes.
 */
export function summarizeEvents(events, { now = Date.now(), exclude = DEFAULT_EXCLUDE } = {}) {
  const seen = new Set();
  const scenarios = [];
  for (const event of events) {
    if (!event || seen.has(event.id) || exclude.test(event.title || "")) continue;
    seen.add(event.id);

    const markets = (event.markets || [])
      .filter((m) => m.active !== false && !m.closed)
      .filter((m) => !m.endDate || Date.parse(m.endDate) > now + DAY_MS)
      .map((m) => ({
        id: String(m.id),
        label: m.groupItemTitle || m.question || event.title,
        question: m.question || event.title,
        probability: yesProbability(m),
        dayChange: Number.isFinite(Number(m.oneDayPriceChange))
          ? Number(m.oneDayPriceChange)
          : null,
      }))
      .filter((m) => m.probability !== null && m.probability > 0.005 && m.probability < 0.995)
      .sort((a, b) => b.probability - a.probability);
    if (markets.length === 0) continue;

    scenarios.push({
      id: String(event.id),
      title: event.title,
      url: `https://polymarket.com/event/${event.slug}`,
      volume24h: Number(event.volume24hr) || 0,
      endDate: event.endDate || null,
      markets,
    });
  }
  return scenarios.sort((a, b) => b.volume24h - a.volume24h);
}

export async function fetchScenarios(httpGet, { tags = DEFAULT_MARKET_TAGS, perTag = 10 } = {}) {
  const results = await Promise.allSettled(
    tags.map((tag) => {
      const url = `${POLYMARKET_EVENTS}?active=true&closed=false&order=volume24hr&ascending=false&limit=${perTag}&tag_slug=${encodeURIComponent(tag)}`;
      return httpGet(url).then((body) => JSON.parse(body));
    })
  );
  const events = results.flatMap((r) =>
    r.status === "fulfilled" && Array.isArray(r.value) ? r.value : []
  );
  return summarizeEvents(events);
}

/**
 * Compare current odds to the last alerted baseline. Returns markets that moved at
 * least `thresholdPts` percentage points, and the updated baseline map.
 */
export function detectOddsMoves(
  scenarios,
  baseline = {},
  { thresholdPts = 10, minVolume = 50000 } = {}
) {
  const moves = [];
  // Only markets still being tracked are kept, so the state file stays small.
  const next = {};
  for (const scenario of scenarios) {
    for (const market of scenario.markets) {
      const prev = baseline[market.id];
      next[market.id] = prev ?? market.probability;
      if (prev === undefined) continue;
      const deltaPts = (market.probability - prev) * 100;
      if (Math.abs(deltaPts) >= thresholdPts && scenario.volume24h >= minVolume) {
        moves.push({ scenario, market, from: prev, to: market.probability, deltaPts });
        next[market.id] = market.probability;
      }
    }
  }
  return { moves, baseline: next };
}

export function formatPct(p) {
  const pct = p * 100;
  return pct < 1 ? "<1%" : `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}

export function formatChange(dayChange) {
  if (dayChange === null || Math.abs(dayChange) < 0.005) return "";
  const pts = Math.round(dayChange * 1000) / 10;
  return pts > 0 ? ` ▲${pts} pts` : ` ▼${Math.abs(pts)} pts`;
}

// ── Economic calendar ────────────────────────────────────────────────────────

const FLAGS = {
  USD: "🇺🇸",
  EUR: "🇪🇺",
  GBP: "🇬🇧",
  JPY: "🇯🇵",
  CNY: "🇨🇳",
  CAD: "🇨🇦",
  AUD: "🇦🇺",
  NZD: "🇳🇿",
  CHF: "🇨🇭",
};

export async function fetchCalendar(httpGet) {
  const body = await httpGet(CALENDAR_URL);
  const data = JSON.parse(body);
  return Array.isArray(data) ? data : [];
}

/** High-impact events in [now, now + hours). */
export function upcomingHighImpact(
  events,
  { now = Date.now(), hours = 36, impacts = ["High"] } = {}
) {
  const end = now + hours * 60 * 60 * 1000;
  return events
    .map((e) => ({ ...e, time: Date.parse(e.date) }))
    .filter((e) => impacts.includes(e.impact) && Number.isFinite(e.time))
    .filter((e) => e.time >= now && e.time < end)
    .sort((a, b) => a.time - b.time);
}

export function formatCalendarLine(event, timeZone = "America/New_York") {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(event.time));
  const flag = FLAGS[event.country] || "🌐";
  const numbers = [
    event.forecast ? `forecast **${event.forecast}**` : "",
    event.previous ? `prev ${event.previous}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `\`${when}\` ${flag} **${event.title}**${numbers ? ` — ${numbers}` : ""}`;
}
