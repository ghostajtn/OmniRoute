#!/usr/bin/env node
// News Radar — posts breaking news, what market-moving people are saying, and
// "what could happen" (prediction-market odds, economic calendar, optional AI
// outlook) to a Discord channel through a webhook.
//
//   DISCORD_WEBHOOK_URL=... node contrib/news-bot/newsBot.mjs          # run forever
//   DISCORD_WEBHOOK_URL=... node contrib/news-bot/newsBot.mjs --once   # one cycle (cron / CI)
//   node contrib/news-bot/newsBot.mjs --once --dry-run                 # print, don't post
//   DISCORD_WEBHOOK_URL=... node contrib/news-bot/newsBot.mjs --test   # send a test message
//   NEWS_BOT_FEED_FILE=feed.json node contrib/news-bot/newsBot.mjs --once  # no webhook: app feed only
//
// See contrib/news-bot/README.md for every option.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DiscordWebhook, isValidWebhookUrl, redactWebhook, truncate } from "./lib/discord.mjs";
import { buildFeed, compactEvent, compactScenario, writeFeed } from "./lib/feed.mjs";
import {
  DEFAULT_MARKET_TAGS,
  detectOddsMoves,
  fetchCalendar,
  fetchScenarios,
  formatCalendarLine,
  formatChange,
  formatPct,
  upcomingHighImpact,
} from "./lib/markets.mjs";
import { generateOutlook, isOutlookConfigured } from "./lib/outlook.mjs";
import { parseFeed } from "./lib/rss.mjs";
import {
  CATEGORIES,
  NEWS_FEEDS,
  WATCHLIST,
  buildFeedList,
  isMarketMoving,
} from "./lib/sources.mjs";
import {
  isSeen,
  itemKeys,
  loadState,
  markSeen,
  pruneState,
  rememberHeadline,
  saveState,
} from "./lib/state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOUR_MS = 60 * 60 * 1000;
const USER_AGENT = "Mozilla/5.0 (compatible; NewsRadarBot/1.0; +https://github.com/)";
// Watchlist first so a story about a tracked person is labelled with their name.
const CATEGORY_ORDER = ["trump", "official", "people", "breaking", "markets", "world"];

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function num(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) ? n : fallback;
}

function list(value) {
  if (!value) return null;
  const items = String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : null;
}

export function loadConfig(env = process.env, argv = process.argv.slice(2)) {
  const flags = new Set(argv);
  return {
    webhookUrl: (env.DISCORD_WEBHOOK_URL || "").trim(),
    once: flags.has("--once"),
    dryRun: flags.has("--dry-run"),
    test: flags.has("--test"),
    stateFile: env.NEWS_BOT_STATE_FILE || join(HERE, ".state", "state.json"),
    feedFile: env.NEWS_BOT_FEED_FILE || "",
    configFile: env.NEWS_BOT_CONFIG || "",
    username: env.NEWS_BOT_NAME || "News Radar",
    intervalMinutes: num(env.NEWS_BOT_INTERVAL_MINUTES, 10),
    maxAgeHours: num(env.NEWS_BOT_MAX_AGE_HOURS, 24),
    maxPerCategory: num(env.NEWS_BOT_MAX_PER_CATEGORY, 15),
    firstRunPerCategory: num(env.NEWS_BOT_FIRST_RUN_PER_CATEGORY, 3),
    predictionsEveryHours: num(env.NEWS_BOT_PREDICTIONS_EVERY_HOURS, 6),
    predictionsCount: num(env.NEWS_BOT_PREDICTIONS_COUNT, 8),
    oddsAlertPoints: num(env.NEWS_BOT_ODDS_ALERT_POINTS, 10),
    marketTags: list(env.NEWS_BOT_MARKET_TAGS) || DEFAULT_MARKET_TAGS,
    extraPeople: list(env.NEWS_BOT_EXTRA_PEOPLE) || [],
    disabled: new Set(list(env.NEWS_BOT_DISABLE) || []),
    timeZone: env.NEWS_BOT_TIMEZONE || "America/New_York",
    llmBaseUrl: env.LLM_BASE_URL || "",
    llmApiKey: env.LLM_API_KEY || "",
    llmModel: env.LLM_MODEL || "",
    outlookEveryHours: num(env.NEWS_BOT_OUTLOOK_EVERY_HOURS, 6),
  };
}

/** Default feeds + watchlist, extended by NEWS_BOT_CONFIG and NEWS_BOT_EXTRA_PEOPLE. */
export async function resolveSources(config) {
  let feeds = NEWS_FEEDS;
  let people = WATCHLIST;
  if (config.configFile) {
    const custom = JSON.parse(await readFile(config.configFile, "utf8"));
    const replace = custom.replaceDefaults === true;
    feeds = [...(replace ? [] : feeds), ...(custom.feeds || [])];
    people = [...(replace ? [] : people), ...(custom.people || [])];
  }
  people = [...people, ...config.extraPeople.map((name) => ({ name }))];
  return buildFeedList({ feeds, people, trump: !config.disabled.has("trump") }).filter(
    (feed) => !config.disabled.has(feed.category)
  );
}

export function createHttpGet(fetchImpl = fetch) {
  return async function httpGet(url) {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchAllFeeds(feeds, httpGet) {
  const perFeed = await mapLimit(feeds, 4, async (feed) => {
    try {
      const items = parseFeed(await httpGet(feed.url)).filter(
        (item) => !feed.exclude?.test(item.title)
      );
      return items.map((item) => ({
        ...item,
        category: feed.category,
        feedName: feed.name,
        person: feed.person,
      }));
    } catch (err) {
      log(`⚠️  ${feed.name}: ${err.message}`);
      return [];
    }
  });
  return perFeed.flat();
}

/**
 * Pick which new stories to post, per category. On the very first run only the
 * newest few per category are posted and everything else is marked as read, so a
 * fresh channel isn't flooded with a day of backlog.
 */
export function selectNewItems(items, state, config, now = Date.now()) {
  const maxAge = config.maxAgeHours * HOUR_MS;
  const inRun = new Set();
  const selected = {};
  const firstRun = !state.initialized;

  const byCategory = new Map(CATEGORY_ORDER.map((c) => [c, []]));
  for (const item of items) {
    if (!byCategory.has(item.category)) byCategory.set(item.category, []);
    byCategory.get(item.category).push(item);
  }

  for (const [category, categoryItems] of byCategory) {
    const fresh = [];
    for (const item of categoryItems) {
      if (!item.title || !item.link) continue;
      if (item.published && now - item.published > maxAge) continue;
      if (isSeen(state, item)) continue;
      const keys = itemKeys(item);
      if (keys.some((k) => inRun.has(k))) continue;
      keys.forEach((k) => inRun.add(k));
      fresh.push(item);
    }
    fresh.sort((a, b) => (b.published || 0) - (a.published || 0));

    const limit = firstRun ? config.firstRunPerCategory : config.maxPerCategory;
    const chosen = fresh.slice(0, limit);
    if (firstRun) fresh.slice(limit).forEach((item) => markSeen(state, item, now));
    // Oldest first so the newest story ends up at the bottom of the channel.
    if (chosen.length) selected[category] = chosen.reverse();
  }
  return selected;
}

/** Headlines that could move prices get a ⚡ (Truth Social posts are judged on their text). */
export function isHot(item) {
  return isMarketMoving(item.category === "trump" ? `${item.title} ${item.summary}` : item.title);
}

export function newsEmbed(item) {
  const category = CATEGORIES[item.category] || CATEGORIES.breaking;
  const isTruth = item.category === "trump";
  const hot = isHot(item);
  const isGoogle = /news\.google\.com/.test(item.link);
  const embed = {
    color: category.color,
    author: {
      name: item.person ? `🗣️ ${item.person}` : `${category.emoji} ${item.feedName}`,
    },
    url: item.link,
    footer: { text: item.source || item.feedName },
  };

  if (isTruth) {
    const repost = item.title.match(/^RT @([\w.]+)/);
    embed.title = `${hot ? "⚡ " : ""}${repost ? `Trump re-posted @${repost[1]}` : "Trump posted on Truth Social"}`;
    embed.description = truncate(item.summary || item.title, 1500);
  } else {
    embed.title = `${hot ? "⚡ " : ""}${item.title}`;
    const summary = item.summary && !isGoogle && item.summary !== item.title ? item.summary : "";
    if (summary) embed.description = truncate(summary, 300);
  }
  if (item.published) embed.timestamp = new Date(item.published).toISOString();
  return embed;
}

function scenarioEmbed(scenario) {
  const single = scenario.markets.length === 1;
  const lines = scenario.markets.slice(0, 4).map((m) => {
    const label = single ? "Yes" : m.label;
    return `**${label}** — ${formatPct(m.probability)}${formatChange(m.dayChange)}`;
  });
  const volume = Math.round(scenario.volume24h).toLocaleString("en-US");
  return {
    color: CATEGORIES.predictions.color,
    title: scenario.title,
    url: scenario.url,
    description: lines.join("\n"),
    footer: { text: `24h volume $${volume} · odds from Polymarket` },
  };
}

function oddsMoveEmbed(move) {
  const up = move.deltaPts > 0;
  return {
    color: up ? 0x2ecc71 : 0xe74c3c,
    author: { name: "🔮 Odds shift" },
    title: move.scenario.title,
    url: move.scenario.url,
    description: `${up ? "📈" : "📉"} **${move.market.question}**\n${formatPct(move.from)} → **${formatPct(move.to)}** (${up ? "+" : ""}${Math.round(move.deltaPts)} pts)`,
    footer: { text: "Prediction-market odds · Polymarket" },
  };
}

function localDayAndHour(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

async function postNews(selected, config, state, discord, now) {
  let posted = 0;
  for (const category of Object.keys(selected)) {
    const items = selected[category];
    const meta = CATEGORIES[category] || CATEGORIES.breaking;
    let done = 0;
    await discord.sendEmbeds(items.map(newsEmbed), {
      username: `${config.username} • ${meta.label}`,
      // Mark stories as posted batch by batch, so a failure never re-posts sent ones.
      onSent: (count) => {
        for (const item of items.slice(done, done + count)) {
          markSeen(state, item, now);
          rememberHeadline(state, { ...item, hot: isHot(item) }, now);
        }
        done += count;
        posted += count;
      },
    });
  }
  return posted;
}

async function postPredictions(config, state, deps, now) {
  const { discord, httpGet } = deps;
  const scenarios = await fetchScenarios(httpGet, { tags: config.marketTags });
  const tracked = scenarios.slice(0, 25);

  const { moves, baseline } = detectOddsMoves(tracked, state.oddsBaseline, {
    thresholdPts: config.oddsAlertPoints,
  });
  state.oddsBaseline = baseline;
  state.latestScenarios = tracked.slice(0, 12).map(compactScenario);
  for (const move of moves) {
    state.recentOddsMoves.push({
      title: move.scenario.title,
      url: move.scenario.url,
      question: move.market.question,
      from: move.from,
      to: move.to,
      deltaPts: Math.round(move.deltaPts * 10) / 10,
      at: now,
    });
  }
  if (moves.length) {
    await discord.sendEmbeds(moves.slice(0, 10).map(oddsMoveEmbed), {
      username: `${config.username} • ${CATEGORIES.predictions.label}`,
    });
  }

  let digest = false;
  if (now - state.lastPredictionsAt >= config.predictionsEveryHours * HOUR_MS && tracked.length) {
    await discord.sendEmbeds(tracked.slice(0, config.predictionsCount).map(scenarioEmbed), {
      username: `${config.username} • ${CATEGORIES.predictions.label}`,
      content:
        "🔮 **What could happen** — live odds on the biggest open questions in politics, the economy and markets:",
    });
    state.lastPredictionsAt = now;
    digest = true;
  }
  return { scenarios: tracked, moves: moves.length, digest };
}

async function postCalendar(config, state, deps, now) {
  const { day, hour } = localDayAndHour(now, config.timeZone);
  if (state.lastCalendarDay === day || hour < 6) return 0;
  const week = await fetchCalendar(deps.httpGet);
  // The whole week (from yesterday on) goes to the web app; Discord gets the next 36 hours.
  state.calendarEvents = upcomingHighImpact(week, {
    now: now - 24 * HOUR_MS,
    hours: 8 * 24,
    impacts: ["High", "Medium"],
  }).map(compactEvent);
  const events = upcomingHighImpact(week, { now, hours: 36 });
  state.lastCalendarDay = day;
  if (!events.length) return 0;
  await deps.discord.sendEmbeds(
    [
      {
        color: CATEGORIES.calendar.color,
        title: "📅 High-impact events in the next 36 hours",
        description: events
          .slice(0, 25)
          .map((e) => formatCalendarLine(e, config.timeZone))
          .join("\n"),
        footer: {
          text: "Economic calendar · these releases often move stocks, bonds and currencies",
        },
      },
    ],
    { username: `${config.username} • ${CATEGORIES.calendar.label}` }
  );
  return events.length;
}

async function postOutlook(config, state, deps, scenarios, now) {
  if (!isOutlookConfigured(config)) return false;
  if (now - state.lastOutlookAt < config.outlookEveryHours * HOUR_MS) return false;
  if (state.recentHeadlines.length < 5) return false;
  const text = await generateOutlook(config, state.recentHeadlines, scenarios, deps.fetchImpl);
  await deps.discord.sendEmbeds(
    [
      {
        color: CATEGORIES.outlook.color,
        author: { name: "🧠 AI outlook — what could happen next" },
        description: text,
        footer: {
          text: "AI-generated speculation from recent headlines and market odds · not financial advice",
        },
      },
    ],
    { username: `${config.username} • ${CATEGORIES.outlook.label}` }
  );
  state.lastOutlookAt = now;
  state.lastOutlook = { text, at: now };
  return true;
}

/** One full cycle: news → prediction markets → calendar → AI outlook. */
export async function runCycle(config, state, deps) {
  const now = deps.now ? deps.now() : Date.now();
  const summary = { news: 0, oddsMoves: 0, digest: false, calendar: 0, outlook: false, errors: [] };

  const feeds = await resolveSources(config);
  const items = await fetchAllFeeds(feeds, deps.httpGet);
  const selected = selectNewItems(items, state, config, now);
  summary.news = await postNews(selected, config, state, deps.discord, now);

  let scenarios = [];
  const optional = [
    [
      "predictions",
      async () => {
        const result = await postPredictions(config, state, deps, now);
        scenarios = result.scenarios;
        summary.oddsMoves = result.moves;
        summary.digest = result.digest;
      },
    ],
    ["calendar", async () => (summary.calendar = await postCalendar(config, state, deps, now))],
    [
      "outlook",
      async () => (summary.outlook = await postOutlook(config, state, deps, scenarios, now)),
    ],
  ];
  for (const [name, step] of optional) {
    if (config.disabled.has(name)) continue;
    try {
      await step();
    } catch (err) {
      summary.errors.push(`${name}: ${err.message}`);
      log(`⚠️  ${name} step failed: ${err.message}`);
    }
  }

  state.initialized = true;
  pruneState(state, now);
  return summary;
}

/**
 * Where this run's posts go: Discord, the console (--dry-run), or nowhere. Without a
 * webhook the bot still reads the news when it has a feed file to write ("app-only"),
 * so the web app keeps working while Discord is not set up.
 */
export function outputMode(config) {
  if (config.dryRun) return "dry-run";
  if (config.webhookUrl) return "discord";
  return config.feedFile && !config.test ? "app-only" : "none";
}

/** The Discord client for this run. It only sends in "discord" mode. */
export function createDiscord(config, { mode = outputMode(config), fetchImpl } = {}) {
  return new DiscordWebhook(config.webhookUrl, {
    dryRun: mode !== "discord",
    log: mode === "app-only" ? () => {} : log,
    gapMs: 2000,
    fetchImpl,
  });
}

async function sendTestMessage(config, discord) {
  await discord.send({
    username: config.username,
    embeds: [
      {
        color: CATEGORIES.predictions.color,
        title: "✅ News Radar is connected",
        description:
          "This channel will receive breaking news, what Trump / the Fed / big investors are saying, " +
          "and what could happen next (prediction-market odds + market-moving events).",
      },
    ],
  });
}

async function main() {
  const config = loadConfig();
  const mode = outputMode(config);

  if (mode === "none") {
    const msg = "DISCORD_WEBHOOK_URL is not set — nothing to do. See contrib/news-bot/README.md.";
    if (process.env.GITHUB_ACTIONS) {
      console.log(`::warning::${msg}`);
      return;
    }
    console.error(msg);
    process.exitCode = 1;
    return;
  }
  if (mode === "app-only") {
    const msg =
      "DISCORD_WEBHOOK_URL is not set, so nothing is posted to Discord; only the web app's " +
      "feed is updated. See contrib/news-bot/README.md.";
    console.log(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : msg);
  }
  if (config.webhookUrl && !isValidWebhookUrl(config.webhookUrl)) {
    console.error(`Not a Discord webhook URL: ${redactWebhook(config.webhookUrl)}`);
    process.exitCode = 1;
    return;
  }

  const discord = createDiscord(config, { mode });
  const deps = { discord, httpGet: createHttpGet(), fetchImpl: fetch };

  if (config.test) {
    await sendTestMessage(config, discord);
    log("Test message sent.");
    return;
  }

  let stopping = false;
  let wake = null;
  let timer = null;
  const stop = () => {
    stopping = true;
    clearTimeout(timer);
    wake?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  do {
    const state = await loadState(config.stateFile);
    try {
      const s = await runCycle(config, state, deps);
      log(
        `Cycle done${mode === "app-only" ? " (app only, nothing posted)" : ""}: ` +
          `${s.news} stories, ${s.oddsMoves} odds alerts, digest=${s.digest}, ` +
          `calendar=${s.calendar}, outlook=${s.outlook}${s.errors.length ? `, ${s.errors.length} errors` : ""}`
      );
    } catch (err) {
      log(`❌ Cycle failed: ${err.message}`);
      if (config.once) process.exitCode = 1;
    } finally {
      if (!config.dryRun) await saveState(config.stateFile, state);
      if (config.feedFile) await writeFeed(config.feedFile, buildFeed(state));
    }
    if (config.once || stopping) break;
    await new Promise((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, config.intervalMinutes * 60 * 1000);
    });
  } while (!stopping);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`[news-bot] ${err.message}`);
    process.exit(1);
  });
}
