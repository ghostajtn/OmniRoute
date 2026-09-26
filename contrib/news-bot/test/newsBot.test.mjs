import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createDiscord,
  loadConfig,
  newsEmbed,
  outputMode,
  resolveSources,
  runCycle,
  selectNewItems,
} from "../newsBot.mjs";
import {
  DiscordWebhook,
  chunkEmbeds,
  clampEmbed,
  isValidWebhookUrl,
  redactWebhook,
} from "../lib/discord.mjs";
import {
  detectOddsMoves,
  formatCalendarLine,
  formatChange,
  formatPct,
  summarizeEvents,
  upcomingHighImpact,
  yesProbability,
} from "../lib/markets.mjs";
import { buildFeed, compactScenario, writeFeed } from "../lib/feed.mjs";
import { buildOutlookPrompt, generateOutlook, isOutlookConfigured } from "../lib/outlook.mjs";
import { parseFeed, stripHtml } from "../lib/rss.mjs";
import { NEWS_FEEDS, OFFICIAL_FEEDS, buildFeedList, isMarketMoving } from "../lib/sources.mjs";
import { describeMediaPosts, isMediaOnlyPost, parsePostPage } from "../lib/truth.mjs";
import {
  emptyState,
  isSeen,
  itemKeys,
  loadState,
  markSeen,
  pruneState,
  rememberHeadline,
  saveState,
} from "../lib/state.mjs";

const NOW = Date.parse("2026-09-25T15:00:00Z"); // 11:00 in New York
const HOUR = 60 * 60 * 1000;
const WEBHOOK = "https://discord.com/api/webhooks/123456789/abcDEF_-token";

const rssDate = (ms) => new Date(ms).toUTCString();

function rss(items) {
  const body = items
    .map(
      (i) => `<item>
        <title><![CDATA[${i.title}]]></title>
        <link>${i.link}</link>
        <guid>${i.link}</guid>
        <pubDate>${rssDate(i.at)}</pubDate>
        ${i.source ? `<source url="https://x.test">${i.source}</source>` : ""}
        <description><![CDATA[${i.description || ""}]]></description>
      </item>`
    )
    .join("\n");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${body}</channel></rss>`;
}

// ── RSS ──────────────────────────────────────────────────────────────────────

test("parseFeed reads RSS items, decodes entities and strips the Google News publisher suffix", () => {
  const xml = rss([
    {
      title: "Fed holds rates &amp; signals cuts - Reuters",
      link: "https://news.google.com/rss/articles/abc?oc=5",
      at: NOW - HOUR,
      source: "Reuters",
      description: "<a href='x'>Fed holds</a>&nbsp;<font>Reuters</font>",
    },
  ]);
  const [item] = parseFeed(xml);
  assert.equal(item.title, "Fed holds rates & signals cuts");
  assert.equal(item.source, "Reuters");
  assert.equal(item.link, "https://news.google.com/rss/articles/abc?oc=5");
  assert.equal(item.published, Math.floor((NOW - HOUR) / 1000) * 1000);
});

test("parseFeed reads Atom entries and prefers the alternate link", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <title type="html">Buffett &#8217;s letter</title>
      <link rel="self" href="https://example.com/self"/>
      <link rel="alternate" href="https://example.com/post?a=1&amp;b=2"/>
      <id>tag:example.com,2026:1</id>
      <updated>2026-09-25T14:00:00Z</updated>
      <summary>Short &lt;b&gt;summary&lt;/b&gt;</summary>
    </entry>
  </feed>`;
  const [entry] = parseFeed(xml);
  assert.equal(entry.title, "Buffett ’s letter");
  assert.equal(entry.link, "https://example.com/post?a=1&b=2");
  assert.equal(entry.guid, "tag:example.com,2026:1");
  assert.equal(entry.published, Date.parse("2026-09-25T14:00:00Z"));
});

test("parseFeed returns [] for junk input", () => {
  assert.deepEqual(parseFeed(""), []);
  assert.deepEqual(parseFeed(null), []);
  assert.deepEqual(parseFeed("<html>not a feed</html>"), []);
});

test("stripHtml keeps text, separates links and drops scripts", () => {
  const html = `<p>RT <a href="u"><span>@</span><span>Someone</span></a><a href="l">https://x.test/a</a></p><script>alert(1)</script>`;
  assert.equal(stripHtml(html), "RT @Someone https://x.test/a");
});

// ── Sources ──────────────────────────────────────────────────────────────────

test("buildFeedList adds a Google News search per watchlist person", () => {
  const feeds = buildFeedList({ feeds: [], people: [{ name: "Warren Buffett" }], trump: false });
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0].category, "people");
  assert.equal(feeds[0].person, "Warren Buffett");
  const url = new URL(feeds[0].url);
  assert.equal(url.hostname, "news.google.com");
  assert.equal(url.searchParams.get("q"), '"Warren Buffett" when:1d');
});

test("isMarketMoving flags tariff/rate/earnings style headlines only", () => {
  assert.equal(isMarketMoving("Trump announces new tariffs on EU cars"), true);
  assert.equal(isMarketMoving("Fed signals rate cut in December"), true);
  assert.equal(isMarketMoving("Local bakery wins award"), false);
  assert.equal(isMarketMoving("Federal Reserve issues FOMC statement"), true);
});

test("official feeds come straight from the Fed, the White House and the ECB", () => {
  assert.ok(OFFICIAL_FEEDS.every((f) => f.category === "official" && NEWS_FEEDS.includes(f)));
  assert.deepEqual([...new Set(OFFICIAL_FEEDS.map((f) => new URL(f.url).hostname))].sort(), [
    "www.ecb.europa.eu",
    "www.federalreserve.gov",
    "www.whitehouse.gov",
  ]);
  const actions = OFFICIAL_FEEDS.find((f) => f.id === "white-house-actions");
  for (const ceremonial of [
    "Gold Star Mother’s And Family’s Day, 2026",
    "National Hispanic Heritage Month, 2026",
    "Presidential Message on National Hunting and Fishing Day",
  ]) {
    assert.equal(actions.exclude.test(ceremonial), true, ceremonial);
  }
  assert.equal(actions.exclude.test("Adjusting Imports of Steel into the United States"), false);
});

test("resolveSources honours NEWS_BOT_EXTRA_PEOPLE and NEWS_BOT_DISABLE", async () => {
  const config = loadConfig(
    { NEWS_BOT_EXTRA_PEOPLE: "Nancy Pelosi, Tim Cook", NEWS_BOT_DISABLE: "world,trump" },
    []
  );
  const feeds = await resolveSources(config);
  assert.ok(feeds.some((f) => f.person === "Nancy Pelosi"));
  assert.ok(feeds.some((f) => f.person === "Tim Cook"));
  assert.ok(!feeds.some((f) => f.category === "world"));
  assert.ok(!feeds.some((f) => f.category === "trump"));
});

// ── Truth Social photo and video posts ──────────────────────────────────────

const archivePage = ({
  kind = "video",
  text,
  image = "https://cdn.test/p.jpg",
} = {}) => `<html><head>
  <meta property="og:title" content="Donald J. Trump ${kind} post from September 26, 2026 - Trump&#x2019;s Truth">
  <meta property="og:description" content="${text}">
  <meta property="og:image" content="${image}">
</head></html>`;

const mediaPost = (id) => ({
  title: "[No Title] - Post from September 26, 2026",
  link: `https://www.trumpstruth.org/statuses/${id}`,
  summary: "",
  category: "trump",
  feedName: "Truth Social",
  published: NOW - 60_000,
});

test("parsePostPage reads the kind, caption or transcript, and preview of a post", () => {
  assert.deepEqual(parsePostPage(archivePage({ text: "Get&#x20;this&#x20;lion." })), {
    kind: "video",
    text: "Get this lion.",
    image: "https://cdn.test/p.jpg",
  });
  const photo = parsePostPage(
    archivePage({
      kind: "image",
      text: "Donald J. Trump image published on September 26, 2026, preserved in the archive",
      image: "javascript:alert(1)",
    })
  );
  assert.deepEqual(
    photo,
    { kind: "photo", text: "", image: "" },
    "generic text and bad urls dropped"
  );
  assert.deepEqual(parsePostPage("<html>nothing</html>"), { kind: "", text: "", image: "" });
});

test("describeMediaPosts fills in text-less posts from the archive and leaves the rest", async () => {
  const fetched = [];
  const httpGet = async (url) => {
    fetched.push(url);
    if (url.endsWith("/2")) throw new Error("HTTP 500");
    return archivePage({ text: "On the orders of the president, Central Command struck" });
  };
  const withText = { ...mediaPost(3), title: "Big news!", summary: "Big news!" };
  const elsewhere = { ...mediaPost(4), link: "https://evil.test/statuses/4" };
  const items = [mediaPost(1), mediaPost(2), withText, elsewhere];
  await describeMediaPosts(items, httpGet);

  assert.deepEqual(fetched, [
    "https://www.trumpstruth.org/statuses/1",
    "https://www.trumpstruth.org/statuses/2",
  ]);
  assert.equal(items[0].mediaKind, "video");
  assert.match(items[0].summary, /Central Command/);
  assert.equal(items[0].image, "https://cdn.test/p.jpg");
  assert.equal(isMediaOnlyPost(items[1]), true, "a page that failed leaves the post as it was");

  const embed = newsEmbed(items[0]);
  assert.equal(embed.title, "🎥 Trump posted a video");
  assert.match(embed.description, /Central Command/);
  assert.deepEqual(embed.image, { url: "https://cdn.test/p.jpg" });
  assert.equal(newsEmbed(items[1]).description, undefined, "no placeholder text in Discord");
});

test("runCycle posts every photo and video post of the day, with its transcript", async () => {
  const httpGet = async (url) => {
    if (url.includes("polymarket") || url.includes("faireconomy")) return "[]";
    if (url === "https://www.trumpstruth.org/feed") {
      const items = [1, 2].map((id) => ({
        title: "[No Title] - Post from September 26, 2026",
        link: `https://www.trumpstruth.org/statuses/${id}`,
        at: NOW - id * 60_000,
      }));
      return rss(items);
    }
    if (url.includes("/statuses/")) return archivePage({ text: `Transcript ${url.slice(-1)}` });
    return rss([]);
  };
  const posted = [];
  const discord = new DiscordWebhook(WEBHOOK, {
    fetchImpl: async (_url, init) => {
      posted.push(JSON.parse(init.body));
      return fakeResponse(200);
    },
    sleep: async () => {},
  });
  const state = emptyState();
  state.initialized = true;
  const config = loadConfig({ NEWS_BOT_EXTRA_PEOPLE: "" }, ["--once"]);
  const summary = await runCycle(config, state, { httpGet, discord, now: () => NOW });

  assert.equal(summary.news, 2);
  assert.deepEqual(
    posted.flatMap((p) => p.embeds).map((e) => e.description),
    ["Transcript 2", "Transcript 1"]
  );
  assert.deepEqual(
    state.recentHeadlines.map((h) => [h.media, h.text]),
    [
      ["video", "Transcript 2"],
      ["video", "Transcript 1"],
    ]
  );
});

// ── Prediction markets / calendar ────────────────────────────────────────────

const polymarketEvent = (overrides = {}) => ({
  id: "1",
  title: "Fed decision in October?",
  slug: "fed-decision-in-october",
  volume24hr: 1_000_000,
  markets: [
    {
      id: "a",
      question: "Will the Fed cut 25 bps?",
      groupItemTitle: "25 bps cut",
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.62","0.38"]',
      oneDayPriceChange: 0.05,
      endDate: "2026-10-30T00:00:00Z",
    },
    {
      id: "b",
      question: "Will the Fed hold?",
      groupItemTitle: "No change",
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.36","0.64"]',
      endDate: "2026-10-30T00:00:00Z",
    },
    {
      id: "closed",
      question: "Old question",
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.5","0.5"]',
      closed: true,
    },
    {
      id: "soon",
      question: "Ends within a day",
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.5","0.5"]',
      endDate: new Date(NOW + HOUR).toISOString(),
    },
  ],
  ...overrides,
});

test("yesProbability reads the Yes price from Polymarket's JSON-encoded arrays", () => {
  assert.equal(yesProbability({ outcomes: '["No","Yes"]', outcomePrices: '["0.3","0.7"]' }), 0.7);
  assert.equal(yesProbability({ outcomes: "bad", outcomePrices: "bad" }), null);
});

test("summarizeEvents keeps open, not-about-to-expire markets sorted by odds", () => {
  const scenarios = summarizeEvents(
    [
      polymarketEvent(),
      polymarketEvent({ id: "2", title: "Elon Musk # tweets this week?", volume24hr: 9e9 }),
    ],
    { now: NOW }
  );
  assert.equal(scenarios.length, 1, "tweet-count markets are excluded");
  const [s] = scenarios;
  assert.equal(s.url, "https://polymarket.com/event/fed-decision-in-october");
  assert.deepEqual(
    s.markets.map((m) => m.id),
    ["a", "b"]
  );
});

test("detectOddsMoves alerts on big swings and resets the baseline after alerting", () => {
  const scenarios = summarizeEvents([polymarketEvent()], { now: NOW });
  const first = detectOddsMoves(scenarios, {});
  assert.equal(first.moves.length, 0, "first sighting only sets a baseline");
  assert.deepEqual(first.baseline, { a: 0.62, b: 0.36 });

  const moved = detectOddsMoves(scenarios, { a: 0.4, b: 0.33, gone: 0.5 }, { thresholdPts: 10 });
  assert.equal(moved.moves.length, 1);
  assert.equal(moved.moves[0].market.id, "a");
  assert.equal(Math.round(moved.moves[0].deltaPts), 22);
  assert.deepEqual(moved.baseline, { a: 0.62, b: 0.33 }, "stale markets are dropped");
});

test("formatPct / formatChange", () => {
  assert.equal(formatPct(0.623), "62%");
  assert.equal(formatPct(0.052), "5.2%");
  assert.equal(formatPct(0.004), "<1%");
  assert.equal(formatChange(0.05), " ▲5 pts");
  assert.equal(formatChange(-0.123), " ▼12.3 pts");
  assert.equal(formatChange(0.001), "");
  assert.equal(formatChange(null), "");
});

test("upcomingHighImpact picks high-impact events in the window, in order", () => {
  const events = [
    {
      title: "CPI m/m",
      country: "USD",
      impact: "High",
      date: "2026-09-26T08:30:00-04:00",
      forecast: "0.3%",
      previous: "0.4%",
    },
    { title: "Old", country: "USD", impact: "High", date: "2026-09-24T08:30:00-04:00" },
    { title: "Minor", country: "USD", impact: "Low", date: "2026-09-25T12:00:00-04:00" },
    { title: "FOMC", country: "USD", impact: "High", date: "2026-09-25T14:00:00-04:00" },
  ];
  const upcoming = upcomingHighImpact(events, { now: NOW, hours: 36 });
  assert.deepEqual(
    upcoming.map((e) => e.title),
    ["FOMC", "CPI m/m"]
  );
  const line = formatCalendarLine(upcoming[1]);
  assert.match(line, /🇺🇸 \*\*CPI m\/m\*\*/);
  assert.match(line, /forecast \*\*0\.3%\*\* · prev 0\.4%/);
  assert.match(line, /8:30/);
});

// ── Discord ──────────────────────────────────────────────────────────────────

test("isValidWebhookUrl accepts Discord webhooks only", () => {
  assert.equal(isValidWebhookUrl(WEBHOOK), true);
  assert.equal(isValidWebhookUrl("https://discordapp.com/api/webhooks/1/abc"), true);
  assert.equal(isValidWebhookUrl("https://canary.discord.com/api/v10/webhooks/1/abc"), true);
  assert.equal(isValidWebhookUrl("https://evil.test/api/webhooks/1/abc"), false);
  assert.equal(isValidWebhookUrl("http://discord.com/api/webhooks/1/abc"), false);
  assert.equal(isValidWebhookUrl(""), false);
});

test("redactWebhook hides the token", () => {
  assert.equal(redactWebhook(WEBHOOK), "https://discord.com/api/webhooks/123456789/***");
});

test("clampEmbed truncates to Discord limits and drops non-http urls", () => {
  const embed = clampEmbed({
    title: "x".repeat(400),
    description: "y".repeat(5000),
    url: "javascript:alert(1)",
  });
  assert.equal(embed.title.length, 256);
  assert.equal(embed.description.length, 4096);
  assert.equal(embed.url, undefined);
});

test("chunkEmbeds respects 10 embeds and 6000 chars per message", () => {
  const small = Array.from({ length: 23 }, (_, i) => ({ title: `t${i}` }));
  assert.deepEqual(
    chunkEmbeds(small).map((b) => b.length),
    [10, 10, 3]
  );
  const big = Array.from({ length: 5 }, () => ({ description: "z".repeat(2500) }));
  for (const batch of chunkEmbeds(big)) {
    const size = batch.reduce((n, e) => n + e.description.length, 0);
    assert.ok(size <= 6000);
  }
});

function fakeResponse(status, body = {}, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("DiscordWebhook retries after a 429 and never allows mentions", async () => {
  const calls = [];
  const sleeps = [];
  const responses = [fakeResponse(429, { retry_after: 1.5 }), fakeResponse(200)];
  const hook = new DiscordWebhook(WEBHOOK, {
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return responses.shift();
    },
    sleep: async (ms) => sleeps.push(ms),
    gapMs: 0,
  });
  await hook.send({ username: "Bot", content: "@everyone hi", embeds: [{ title: "x" }] });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${WEBHOOK}?wait=true`);
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
  assert.equal(sleeps[0], 1600);
  assert.equal(hook.sent, 1);
});

test("DiscordWebhook waits out an exhausted rate-limit bucket", async () => {
  const sleeps = [];
  const hook = new DiscordWebhook(WEBHOOK, {
    fetchImpl: async () =>
      fakeResponse(200, {}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "2" }),
    sleep: async (ms) => sleeps.push(ms),
  });
  await hook.send({ embeds: [{ title: "x" }] });
  assert.deepEqual(sleeps, [2100]);
});

test("DiscordWebhook surfaces a deleted webhook (404) as an error", async () => {
  const hook = new DiscordWebhook(WEBHOOK, {
    fetchImpl: async () => fakeResponse(404, { message: "Unknown Webhook" }),
    sleep: async () => {},
  });
  await assert.rejects(() => hook.send({ embeds: [{ title: "x" }] }), /HTTP 404/);
});

// ── State ────────────────────────────────────────────────────────────────────

test("itemKeys dedupes the same headline across feeds regardless of punctuation", () => {
  const a = itemKeys({ title: "Trump: New Tariffs!", link: "https://a.test/1" });
  const b = itemKeys({ title: "trump new tariffs", link: "https://b.test/2" });
  assert.equal(a[0], b[0]);
  assert.notEqual(a[1], b[1]);
});

test("Truth Social posts are told apart by link, not by their (often placeholder) title", () => {
  // Photo and video posts all arrive as "[No Title] - Post from <date>".
  const post = (id) => ({
    title: "[No Title] - Post from September 26, 2026",
    link: `https://www.trumpstruth.org/statuses/${id}`,
    category: "trump",
    published: NOW - 60_000,
  });
  const state = emptyState();
  state.initialized = true;
  const config = loadConfig({}, ["--once"]);
  assert.equal(selectNewItems([post(1), post(2)], state, config, NOW).trump.length, 2);

  markSeen(state, post(1), NOW);
  assert.equal(isSeen(state, post(2)), false, "a later photo post the same day is still new");
  assert.equal(isSeen(state, post(1)), true);
});

test("pruneState forgets stories older than a few days", () => {
  const state = emptyState();
  markSeen(state, { title: "old", link: "https://a.test/old" }, NOW - 10 * 24 * HOUR);
  markSeen(state, { title: "new", link: "https://a.test/new" }, NOW);
  pruneState(state, NOW);
  assert.equal(isSeen(state, { title: "old", link: "https://a.test/old" }), false);
  assert.equal(isSeen(state, { title: "new", link: "https://a.test/new" }), true);
});

test("pruneState keeps two days of headlines, capped per section", () => {
  const state = emptyState();
  const add = (category, title, at) => rememberHeadline(state, newsItem(title, category, 0), at);
  add("people", "stale", NOW - 3 * 24 * HOUR);
  add("trump", "quiet section", NOW - 20 * HOUR);
  for (let i = 0; i < 120; i++) add("people", `busy ${i}`, NOW - (120 - i) * 60_000);
  pruneState(state, NOW);

  const titles = state.recentHeadlines.map((h) => h.title);
  assert.equal(titles.includes("stale"), false);
  assert.equal(titles.includes("quiet section"), true, "a busy section can't push it out");
  assert.equal(state.recentHeadlines.filter((h) => h.category === "people").length, 80);
  assert.equal(titles.at(-1), "busy 119", "oldest first, newest kept");
  assert.equal(titles.includes("busy 39"), false);
});

test("saveState/loadState round-trip and tolerate a missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "news-bot-"));
  try {
    const file = join(dir, "nested", "state.json");
    assert.deepEqual(await loadState(file), emptyState());
    const state = { ...emptyState(), initialized: true, lastCalendarDay: "2026-09-25" };
    await saveState(file, state);
    assert.deepEqual(await loadState(file), state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Selection & embeds ───────────────────────────────────────────────────────

const newsItem = (title, category, minutesAgo, extra = {}) => ({
  title,
  link: `https://news.test/${encodeURIComponent(title)}`,
  guid: `https://news.test/${encodeURIComponent(title)}`,
  published: NOW - minutesAgo * 60 * 1000,
  summary: "",
  source: "Test",
  category,
  feedName: "Test Feed",
  ...extra,
});

test("selectNewItems: first run posts only the newest few and marks the rest as read", () => {
  const state = emptyState();
  const config = loadConfig({}, []);
  const items = Array.from({ length: 6 }, (_, i) => newsItem(`story ${i}`, "world", i * 10));
  const selected = selectNewItems(items, state, config, NOW);
  assert.deepEqual(
    selected.world.map((i) => i.title),
    ["story 2", "story 1", "story 0"],
    "newest 3, oldest first"
  );
  assert.equal(isSeen(state, items[5]), true, "overflow is marked read on the first run");
  assert.equal(isSeen(state, items[0]), false, "chosen items are marked only once posted");
});

test("selectNewItems: later runs skip seen, stale and duplicate stories; watchlist wins", () => {
  const state = { ...emptyState(), initialized: true };
  const config = loadConfig({}, []);
  markSeen(state, newsItem("already posted", "world", 5), NOW);
  const items = [
    newsItem("already posted", "world", 5),
    newsItem("too old", "world", 60 * 30),
    newsItem("Buffett buys stake in X", "breaking", 3),
    newsItem("Buffett buys stake in X", "people", 4, { person: "Warren Buffett" }),
    newsItem("fresh world story", "world", 1),
  ];
  const selected = selectNewItems(items, state, config, NOW);
  assert.deepEqual(Object.keys(selected).sort(), ["people", "world"]);
  assert.equal(selected.people[0].person, "Warren Buffett");
  assert.deepEqual(
    selected.world.map((i) => i.title),
    ["fresh world story"]
  );
});

test("newsEmbed flags market-moving headlines and formats Truth Social posts", () => {
  const hot = newsEmbed(
    newsItem("Trump slaps tariffs on chips", "people", 1, { person: "Donald Trump" })
  );
  assert.equal(hot.title, "⚡ Trump slaps tariffs on chips");
  assert.equal(hot.author.name, "🗣️ Donald Trump");
  assert.equal(hot.timestamp, new Date(NOW - 60000).toISOString());

  const post = newsEmbed(
    newsItem("RT @someone", "trump", 1, {
      summary: "RT @someone big news",
      feedName: "Truth Social",
    })
  );
  assert.equal(post.title, "Trump re-posted @someone");
  assert.equal(post.description, "RT @someone big news");
});

// ── Outlook ──────────────────────────────────────────────────────────────────

test("outlook is optional and calls an OpenAI-compatible endpoint", async () => {
  assert.equal(isOutlookConfigured({}), false);
  const config = { llmBaseUrl: "http://localhost:20128/v1/", llmModel: "auto", llmApiKey: "k" };
  assert.equal(isOutlookConfigured(config), true);

  const prompt = buildOutlookPrompt([{ who: "Donald Trump", title: "Tariffs coming" }], []);
  assert.match(prompt, /\[Donald Trump\] Tariffs coming/);

  let request;
  const text = await generateOutlook(config, [{ title: "a" }], [], async (url, init) => {
    request = { url, init };
    return fakeResponse(200, { choices: [{ message: { content: " 1. **Rate cut** " } }] });
  });
  assert.equal(text, "1. **Rate cut**");
  assert.equal(request.url, "http://localhost:20128/v1/chat/completions");
  assert.equal(request.init.headers.Authorization, "Bearer k");
  assert.equal(JSON.parse(request.init.body).model, "auto");
});

// ── Full cycle ───────────────────────────────────────────────────────────────

test("runCycle posts news, odds and calendar once, then nothing new on the next run", async () => {
  const feedXml = rss([
    { title: "Stocks plunge as yields jump", link: "https://news.test/a", at: NOW - 5 * 60 * 1000 },
  ]);
  const calendar = JSON.stringify([
    {
      title: "Non-Farm Employment Change",
      country: "USD",
      impact: "High",
      date: "2026-09-25T20:30:00Z",
      forecast: "150K",
      previous: "142K",
    },
    {
      title: "Pending Home Sales m/m",
      country: "USD",
      impact: "Medium",
      date: "2026-09-26T14:00:00Z",
      forecast: "0.4%",
      previous: "-1.1%",
    },
  ]);
  const httpGet = async (url) => {
    if (url.includes("polymarket")) return JSON.stringify([polymarketEvent()]);
    if (url.includes("faireconomy")) return calendar;
    if (url.includes("trumpstruth")) return rss([]);
    return feedXml;
  };
  const posted = [];
  const discord = new DiscordWebhook(WEBHOOK, {
    fetchImpl: async (_url, init) => {
      posted.push(JSON.parse(init.body));
      return fakeResponse(200);
    },
    sleep: async () => {},
  });
  const config = loadConfig({ NEWS_BOT_EXTRA_PEOPLE: "" }, ["--once"]);
  const state = emptyState();

  const first = await runCycle(config, state, { httpGet, discord, now: () => NOW });
  assert.equal(first.news, 1, "identical headline from every feed is posted once");
  assert.equal(first.digest, true);
  assert.equal(first.calendar, 1);
  assert.deepEqual(first.errors, []);
  assert.equal(state.initialized, true);
  assert.ok(
    posted.some((p) => p.embeds.some((e) => e.title === "⚡ Stocks plunge as yields jump"))
  );
  assert.ok(posted.some((p) => p.content?.includes("What could happen")));
  assert.ok(posted.some((p) => p.embeds.some((e) => e.description?.includes("Non-Farm"))));
  assert.ok(
    !posted.some((p) => p.embeds.some((e) => e.description?.includes("Pending Home Sales"))),
    "Discord only gets high-impact events"
  );

  // What the web app's feed.json is built from.
  assert.equal(state.recentHeadlines.length, 1);
  assert.equal(state.recentHeadlines[0].hot, true);
  assert.equal(state.recentHeadlines[0].link, "https://news.test/a");
  assert.deepEqual(
    state.latestScenarios.map((s) => s.url),
    ["https://polymarket.com/event/fed-decision-in-october"]
  );
  assert.deepEqual(
    state.calendarEvents.map((e) => [e.title, e.impact]),
    [
      ["Non-Farm Employment Change", "High"],
      ["Pending Home Sales m/m", "Medium"],
    ]
  );

  posted.length = 0;
  const second = await runCycle(config, state, {
    httpGet,
    discord,
    now: () => NOW + 15 * 60 * 1000,
  });
  assert.equal(second.news, 0);
  assert.equal(second.digest, false);
  assert.equal(second.calendar, 0);
  assert.equal(posted.length, 0);
});

test("runCycle skips ceremonial White House posts and labels official statements", async () => {
  const httpGet = async (url) => {
    if (url.includes("polymarket")) return "[]";
    if (url.includes("faireconomy")) return "[]";
    if (!url.includes("presidential-actions")) return rss([]);
    return rss([
      { title: "National Farm Safety Week, 2026", link: "https://wh.test/p", at: NOW - 60_000 },
      {
        title: "Imposing Tariffs on Imported Trucks",
        link: "https://wh.test/eo",
        at: NOW - 60_000,
      },
    ]);
  };
  const posted = [];
  const discord = new DiscordWebhook(WEBHOOK, {
    fetchImpl: async (_url, init) => {
      posted.push(JSON.parse(init.body));
      return fakeResponse(200);
    },
    sleep: async () => {},
  });
  const config = loadConfig({ NEWS_BOT_EXTRA_PEOPLE: "" }, ["--once"]);
  const summary = await runCycle(config, emptyState(), { httpGet, discord, now: () => NOW });
  assert.equal(summary.news, 1);
  const embeds = posted.flatMap((p) => p.embeds);
  assert.deepEqual(
    embeds.map((e) => [e.title, e.author.name]),
    [["⚡ Imposing Tariffs on Imported Trucks", "🏛️ White House · Presidential actions"]]
  );
  assert.ok(posted.some((p) => p.username.endsWith("Official Statements")));
});

test("outputMode: without a webhook the bot still updates the app's feed", () => {
  const mode = (env, argv = ["--once"]) => outputMode(loadConfig(env, argv));
  assert.equal(mode({ DISCORD_WEBHOOK_URL: WEBHOOK }), "discord");
  assert.equal(mode({ DISCORD_WEBHOOK_URL: WEBHOOK, NEWS_BOT_FEED_FILE: "f.json" }), "discord");
  assert.equal(mode({ NEWS_BOT_FEED_FILE: "f.json" }), "app-only");
  assert.equal(mode({ DISCORD_WEBHOOK_URL: " " }), "none");
  assert.equal(
    mode({ NEWS_BOT_FEED_FILE: "f.json" }, ["--test"]),
    "none",
    "a test needs a webhook"
  );
  assert.equal(mode({ DISCORD_WEBHOOK_URL: WEBHOOK }, ["--once", "--dry-run"]), "dry-run");
});

test("app-only mode fills the app's feed and never calls Discord", async () => {
  const httpGet = async (url) => {
    if (url.includes("polymarket")) return JSON.stringify([polymarketEvent()]);
    if (url.includes("faireconomy")) return "[]";
    if (url.includes("trumpstruth")) return rss([]);
    return rss([
      { title: "Stocks plunge as yields jump", link: "https://news.test/a", at: NOW - 60_000 },
    ]);
  };
  const config = loadConfig({ NEWS_BOT_FEED_FILE: "f.json", NEWS_BOT_EXTRA_PEOPLE: "" }, [
    "--once",
  ]);
  let discordCalls = 0;
  const discord = createDiscord(config, {
    fetchImpl: async () => {
      discordCalls++;
      return fakeResponse(200);
    },
  });
  const state = emptyState();

  const summary = await runCycle(config, state, { httpGet, discord, now: () => NOW });
  assert.equal(discordCalls, 0);
  assert.equal(summary.news, 1);
  assert.deepEqual(summary.errors, []);
  const feed = buildFeed(state, NOW);
  assert.deepEqual(
    feed.headlines.map((h) => h.link),
    ["https://news.test/a"]
  );
  assert.equal(feed.scenarios.length, 1);

  // The story counts as seen, so it is not posted later once the webhook is added.
  const again = await runCycle(config, state, { httpGet, discord, now: () => NOW + 60_000 });
  assert.equal(again.news, 0);
});

// ── Web app feed ─────────────────────────────────────────────────────────────

test("rememberHeadline keeps what the app needs, including Truth Social post text", () => {
  const state = emptyState();
  rememberHeadline(state, newsItem("Fed cuts rates", "markets", 3, { hot: true }), NOW);
  rememberHeadline(
    state,
    newsItem("RT @someone", "trump", 1, {
      summary: "RT @someone big news",
      feedName: "Truth Social",
    }),
    NOW
  );
  const [story, post] = state.recentHeadlines;
  assert.equal(story.hot, true);
  assert.equal(story.link, "https://news.test/Fed%20cuts%20rates");
  assert.equal(story.source, "Test");
  assert.equal(story.text, "", "only Truth Social posts carry their text");
  assert.equal(post.text, "RT @someone big news");
  assert.equal(post.who, "Truth Social");
});

test("compactScenario keeps the top four outcomes with rounded odds", () => {
  const [scenario] = summarizeEvents([polymarketEvent()], { now: NOW });
  const compact = compactScenario({
    ...scenario,
    volume24h: 1234.6,
    markets: [...scenario.markets, ...scenario.markets, ...scenario.markets],
  });
  assert.equal(compact.volume24h, 1235);
  assert.equal(compact.markets.length, 4);
  assert.deepEqual(compact.markets[0], {
    label: "25 bps cut",
    question: "Will the Fed cut 25 bps?",
    probability: 0.62,
    dayChange: 0.05,
  });
});

test("buildFeed lists newest headlines first and only upcoming events", () => {
  const state = emptyState();
  state.recentHeadlines = [{ title: "older" }, { title: "newer" }];
  state.recentOddsMoves = [{ question: "first" }, { question: "second" }];
  state.calendarEvents = [
    { title: "long gone", time: NOW - 5 * HOUR },
    { title: "just happened", time: NOW - HOUR },
    { title: "tomorrow", time: NOW + 24 * HOUR },
    { title: "far away", time: NOW + 9 * 24 * HOUR },
  ];
  state.lastOutlook = { text: "Rates stay high", at: NOW };
  const feed = buildFeed(state, NOW);
  assert.equal(feed.version, 1);
  assert.equal(feed.generatedAt, new Date(NOW).toISOString());
  assert.deepEqual(
    feed.headlines.map((h) => h.title),
    ["newer", "older"]
  );
  assert.deepEqual(
    feed.oddsMoves.map((m) => m.question),
    ["second", "first"]
  );
  assert.deepEqual(
    feed.events.map((e) => e.title),
    ["just happened", "tomorrow"]
  );
  assert.equal(feed.outlook.text, "Rates stay high");
});

test("writeFeed writes the feed as JSON, creating the folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "news-feed-"));
  try {
    const file = join(dir, "site", "feed.json");
    const feed = buildFeed(emptyState(), NOW);
    await writeFeed(file, feed);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), feed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
