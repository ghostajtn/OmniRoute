// Optional extras for News Radar: your own stocks, SEC filings by big investors, earnings
// dates, urgent @mentions and one Discord channel per topic. Each is off until configured.

import { googleNewsSearchUrl, mentionPattern } from "./sources.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- your stocks

/** "aapl, TSLA nvda" -> ["AAPL", "TSLA", "NVDA"]: valid symbols only, no repeats, at most 25. */
export function parseTickers(text) {
  const seen = new Set();
  for (const part of String(text || "").split(/[\s,;]+/)) {
    const symbol = part.trim().toUpperCase();
    if (/^[A-Z][A-Z.-]{0,5}$/.test(symbol)) seen.add(symbol);
  }
  return [...seen].slice(0, 25);
}

/** One Google News search per stock. */
export function tickerFeeds(tickers) {
  return tickers.map((symbol) => ({
    id: `stock:${symbol}`,
    category: "stocks",
    name: symbol,
    url: googleNewsSearchUrl(`"${symbol}" stock`),
  }));
}

// ---------------------------------------------------------------- SEC filings

// Funds and investors whose filings are announced. Add more with NEWS_BOT_EXTRA_FUNDS.
export const FUNDS = [
  "Berkshire Hathaway",
  "Pershing Square",
  "Scion Asset Management",
  "Bridgewater Associates",
  "Soros Fund Management",
  "Appaloosa",
  "Third Point",
  "Icahn Enterprises",
  "Duquesne Family Office",
  "Tiger Global",
  "Elliott Investment Management",
  "Trian Fund Management",
  "ValueAct",
  "Renaissance Technologies",
  "Greenlight Capital",
  "Baupost Group",
  "Starboard Value",
];

const SEC_FORMS = [
  {
    type: "13F-HR",
    short: "13F",
    filed: "its quarterly holdings report (13F)",
    amended: "an amended quarterly holdings report (13F)",
    about: "a 13F holdings report",
  },
  {
    type: "SCHEDULE 13D",
    short: "13D",
    filed: "a 13D: a 5%+ stake, with a say in how the company is run",
    amended: "an amended 13D (a 5%+ stake)",
    about: "a 13D filing (a 5%+ stake)",
  },
  {
    type: "SCHEDULE 13G",
    short: "13G",
    filed: "a 13G: a 5%+ passive stake",
    amended: "an amended 13G (a 5%+ passive stake)",
    about: "a 13G filing (a 5%+ passive stake)",
  },
];

/**
 * EDGAR's "latest filings" feeds, narrowed to the funds. The SEC turns away requests that
 * don't say who is asking, so these only exist when a contact (an email or a web address)
 * is set; it goes into the User-Agent and nowhere else.
 */
export function secFeeds(contact, funds = FUNDS) {
  const who = String(contact || "").trim();
  if (!who) return [];
  return SEC_FORMS.map((form) => ({
    id: `sec:${form.type}`,
    category: "filings",
    name: "SEC EDGAR",
    kind: "sec",
    form: form.short,
    url:
      "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent" +
      `&type=${encodeURIComponent(form.type)}&company=&dateb=&owner=include&start=0&count=100&output=atom`,
    userAgent: `NewsRadar/1.0 ${who}`,
    mentions: mentionPattern(funds),
  }));
}

/** "SCHEDULE 13D/A - Berkshire Hathaway Inc (0001067983) (Filer)" -> a plain sentence. */
export function secTitle(rawTitle, feed) {
  const m = /^(.+?) - (.+?) \(\d{10}\) \((Filer|Subject|Filed by|Reporting)\)/.exec(rawTitle);
  const info = SEC_FORMS.find((f) => f.short === feed?.form);
  if (!m || !info) return rawTitle;
  const [, form, name, role] = m;
  if (role === "Subject") return `${name} is named in ${info.about}`;
  return `${name} filed ${/\/A$/.test(form) ? info.amended : info.filed}`;
}

// ---------------------------------------------------------------- earnings dates

export const EARNINGS_BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export function earningsUrl(day) {
  return `https://api.nasdaq.com/api/calendar/earnings?date=${day}`;
}

/** Weekdays from `day` (YYYY-MM-DD) for the next `count` days, inclusive. */
export function earningsDays(day, count = 8) {
  const start = Date.parse(`${day}T12:00:00Z`);
  const days = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(start + i * DAY_MS);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

const EARNINGS_TIME = {
  "time-pre-market": "before the market opens",
  "time-after-hours": "after the market closes",
};

/** Rows of one day's calendar reduced to the stocks you follow. */
export function parseEarnings(text, day, tickers) {
  const rows = JSON.parse(text)?.data?.rows;
  if (!Array.isArray(rows)) return [];
  const wanted = new Set(tickers);
  return rows
    .filter((row) => wanted.has(String(row.symbol).toUpperCase()))
    .map((row) => ({
      symbol: String(row.symbol).toUpperCase(),
      name: String(row.name || ""),
      date: day,
      when: EARNINGS_TIME[row.time] || "time not announced",
      eps: row.epsForecast || "",
    }));
}

/**
 * Which earnings to announce now. Each is announced once when it first shows up within a
 * week ("week") and once more when it is today or tomorrow ("day"). `alerted` maps
 * "SYMBOL:date:tier" to when it was announced.
 */
export function dueEarnings(entries, alerted, today) {
  const due = [];
  for (const entry of entries) {
    const away = Math.round(
      (Date.parse(`${entry.date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY_MS
    );
    if (away < 0) continue;
    const key = (tier) => `${entry.symbol}:${entry.date}:${tier}`;
    if (away <= 1 && !alerted[key("day")])
      due.push({ ...entry, away, keys: [key("day"), key("week")] });
    else if (!alerted[key("week")] && !alerted[key("day")])
      due.push({ ...entry, away, keys: [key("week")] });
  }
  return due;
}

export function earningsLine(entry) {
  const day = entry.away === 0 ? "today" : entry.away === 1 ? "tomorrow" : entry.date;
  const eps = entry.eps ? ` · analysts expect ${entry.eps} a share` : "";
  return `**${entry.symbol}**${entry.name ? ` (${entry.name})` : ""} reports ${day}, ${entry.when}${eps}`;
}

// ---------------------------------------------------------------- urgent pings

/**
 * "@here", "@everyone", "user:123…", "role:123…" (any mix, comma or space separated) ->
 * message text and the only mentions Discord may act on. Headlines never get a say: the
 * text is built here, and `allowed_mentions` is limited to what the operator configured.
 */
export function parsePing(text) {
  const parts = [];
  const allowed = { parse: [], users: [], roles: [] };
  for (const token of String(text || "").split(/[\s,;]+/)) {
    const t = token.trim().toLowerCase();
    if (t === "@here" || t === "@everyone") {
      parts.push(t);
      if (!allowed.parse.includes("everyone")) allowed.parse.push("everyone");
      continue;
    }
    const id = /^(user|role):(\d{15,25})$/.exec(t);
    if (!id) continue;
    if (id[1] === "user") {
      parts.push(`<@${id[2]}>`);
      allowed.users.push(id[2]);
    } else {
      parts.push(`<@&${id[2]}>`);
      allowed.roles.push(id[2]);
    }
  }
  if (!parts.length) return null;
  return { content: `${parts.join(" ")} ⚡ Urgent`, allowed };
}

// ---------------------------------------------------------------- one channel per topic

/** NEWS_BOT_WEBHOOK_TRUMP, NEWS_BOT_WEBHOOK_MARKETS, ... -> { trump: url, markets: url }. */
export function channelWebhooks(env, categories) {
  const found = {};
  for (const category of categories) {
    const url = String(env[`NEWS_BOT_WEBHOOK_${category.toUpperCase()}`] || "").trim();
    if (url) found[category] = url;
  }
  return found;
}
