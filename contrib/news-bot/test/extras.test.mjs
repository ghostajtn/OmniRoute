import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDiscords,
  isUrgent,
  loadConfig,
  newsEmbed,
  resolveSources,
  runCycle,
  selectNewItems,
} from "../newsBot.mjs";
import { DiscordWebhook } from "../lib/discord.mjs";
import {
  channelWebhooks,
  dueEarnings,
  earningsDays,
  earningsLine,
  parseEarnings,
  parsePing,
  parseTickers,
  secFeeds,
  secTitle,
  tickerFeeds,
} from "../lib/extras.mjs";
import { buildFeed } from "../lib/feed.mjs";
import { emptyState } from "../lib/state.mjs";

const NOW = Date.parse("2026-10-19T15:00:00Z"); // a Monday, 11:00 in New York
const WEBHOOK = "https://discord.com/api/webhooks/123456789/abcDEF_-token";
const TRUMP_HOOK = "https://discord.com/api/webhooks/222222222/trumpTOKEN";

const ok = () => ({
  status: 200,
  ok: true,
  headers: { get: () => null },
  json: async () => ({}),
  text: async () => "{}",
});

function recorder(url = WEBHOOK) {
  const sent = [];
  const hook = new DiscordWebhook(url, {
    fetchImpl: async (endpoint, init) => {
      sent.push({ endpoint, body: JSON.parse(init.body) });
      return ok();
    },
    sleep: async () => {},
    gapMs: 0,
  });
  return { hook, sent };
}

// ── your stocks ──────────────────────────────────────────────────────────────

test("tickers: valid symbols only, upper-cased, no repeats", () => {
  assert.deepEqual(parseTickers("aapl, TSLA nvda;bad!! 123 BRK.B aapl"), [
    "AAPL",
    "TSLA",
    "NVDA",
    "BRK.B",
  ]);
  assert.deepEqual(parseTickers(""), []);
  const many = Array.from(
    { length: 40 },
    (_, i) => `${"AB"[Math.floor(i / 26)]}${String.fromCharCode(65 + (i % 26))}`
  );
  assert.equal(parseTickers(many.join(",")).length, 25, "at most 25");
});

test("each stock gets its own news search in the 'stocks' section", async () => {
  const feeds = tickerFeeds(["AAPL", "TSLA"]);
  assert.equal(feeds.length, 2);
  assert.equal(feeds[0].category, "stocks");
  assert.match(decodeURIComponent(feeds[0].url), /"AAPL" stock/);

  const config = loadConfig({ NEWS_BOT_TICKERS: "AAPL, TSLA" }, []);
  const all = await resolveSources(config);
  assert.equal(all.filter((f) => f.category === "stocks").length, 2);
  const off = await resolveSources(
    loadConfig({ NEWS_BOT_TICKERS: "AAPL", NEWS_BOT_DISABLE: "stocks" }, [])
  );
  assert.equal(off.filter((f) => f.category === "stocks").length, 0);
});

// ── SEC filings ──────────────────────────────────────────────────────────────

test("SEC filings stay off until a contact is given, and the contact only goes in the User-Agent", async () => {
  assert.deepEqual(secFeeds(""), []);
  assert.deepEqual(secFeeds("   "), []);
  const feeds = secFeeds("me@example.com");
  assert.equal(feeds.length, 3);
  assert.ok(feeds.every((f) => f.userAgent.includes("me@example.com")));
  assert.ok(feeds.every((f) => !f.url.includes("me@example.com")));

  const none = await resolveSources(loadConfig({}, []));
  assert.equal(none.filter((f) => f.category === "filings").length, 0);
  const some = await resolveSources(loadConfig({ NEWS_BOT_SEC_CONTACT: "me@example.com" }, []));
  assert.equal(some.filter((f) => f.category === "filings").length, 3);
  const nodisable = await resolveSources(
    loadConfig({ NEWS_BOT_SEC_CONTACT: "me@example.com", NEWS_BOT_DISABLE: "filings" }, [])
  );
  assert.equal(nodisable.filter((f) => f.category === "filings").length, 0);
});

test("SEC filing titles become plain sentences", () => {
  const thirteenD = { form: "13D" };
  assert.equal(
    secTitle("SCHEDULE 13D - Pershing Square Capital Management (0001336528) (Filer)", thirteenD),
    "Pershing Square Capital Management filed a 13D: a 5%+ stake, with a say in how the company is run"
  );
  assert.equal(
    secTitle("SCHEDULE 13D/A - Pershing Square Capital Management (0001336528) (Filer)", thirteenD),
    "Pershing Square Capital Management filed an amended 13D (a 5%+ stake)"
  );
  assert.equal(
    secTitle("SCHEDULE 13D - Berkshire Hathaway Inc (0001067983) (Subject)", thirteenD),
    "Berkshire Hathaway Inc is named in a 13D filing (a 5%+ stake)"
  );
  assert.equal(
    secTitle("13F-HR - Berkshire Hathaway Inc (0001067983) (Filer)", { form: "13F" }),
    "Berkshire Hathaway Inc filed its quarterly holdings report (13F)"
  );
  assert.equal(secTitle("something else entirely", thirteenD), "something else entirely");
});

test("only the followed funds get through, and a 13D filing is urgent", async () => {
  const atom = (title, id) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>${title}</title><link href="https://www.sec.gov/Archives/${id}-index.htm"/>
    <id>urn:${id}</id><updated>2026-10-19T14:50:00-04:00</updated><summary>Filed</summary></entry></feed>`;
  const calls = [];
  const httpGet = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes("sec.gov") && url.includes("13D")) {
      return atom("SCHEDULE 13D - Pershing Square Capital Management (0001336528) (Filer)", "a1");
    }
    if (url.includes("sec.gov")) {
      return atom("13F-HR - Some Random Fund LP (0000000001) (Filer)", "b1");
    }
    return `<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>`;
  };
  const config = loadConfig(
    {
      NEWS_BOT_SEC_CONTACT: "me@example.com",
      NEWS_BOT_DISABLE: "brief,calendar,predictions,prices,trending,outlook,earnings",
    },
    ["--once"]
  );
  const { hook, sent } = recorder();
  const state = emptyState();
  state.initialized = true;
  await runCycle(config, state, { httpGet, discord: hook, now: () => NOW });

  const sec = calls.filter((c) => c.url.includes("sec.gov"));
  assert.equal(sec.length, 3);
  assert.ok(sec.every((c) => c.options.userAgent.includes("me@example.com")));
  const titles = sent.flatMap((m) => m.body.embeds.map((e) => e.title));
  assert.equal(titles.filter((t) => /Pershing Square/.test(t)).length, 1);
  assert.ok(!titles.some((t) => /Random Fund/.test(t)));
  assert.equal(state.recentHeadlines.find((h) => h.category === "filings").urgent, true);
});

// ── earnings dates ───────────────────────────────────────────────────────────

const nasdaq = (rows) => JSON.stringify({ data: { asOf: "x", rows } });

test("earnings: weekdays only, and only the stocks you follow", () => {
  assert.deepEqual(earningsDays("2026-10-23", 5), ["2026-10-23", "2026-10-26", "2026-10-27"]);
  const rows = [
    { symbol: "NFLX", name: "Netflix, Inc.", time: "time-after-hours", epsForecast: "$0.82" },
    { symbol: "GE", name: "GE Aerospace", time: "time-pre-market", epsForecast: "$2.02" },
  ];
  const found = parseEarnings(nasdaq(rows), "2026-10-20", ["NFLX", "TSLA"]);
  assert.deepEqual(found, [
    {
      symbol: "NFLX",
      name: "Netflix, Inc.",
      date: "2026-10-20",
      when: "after the market closes",
      eps: "$0.82",
    },
  ]);
  assert.deepEqual(
    parseEarnings(JSON.stringify({ data: { rows: null } }), "2026-10-24", ["NFLX"]),
    []
  );
});

test("earnings: one heads-up within a week, one more the day before, never twice", () => {
  const entry = {
    symbol: "NFLX",
    name: "Netflix",
    date: "2026-10-21",
    when: "after the market closes",
    eps: "",
  };
  const alerted = {};
  let due = dueEarnings([entry], alerted, "2026-10-17");
  assert.equal(due.length, 1);
  assert.equal(due[0].away, 4);
  for (const key of due[0].keys) alerted[key] = 1;
  assert.equal(dueEarnings([entry], alerted, "2026-10-18").length, 0, "no repeat in between");
  due = dueEarnings([entry], alerted, "2026-10-20");
  assert.equal(due.length, 1, "tomorrow");
  assert.equal(due[0].away, 1);
  for (const key of due[0].keys) alerted[key] = 1;
  assert.equal(dueEarnings([entry], alerted, "2026-10-21").length, 0);
  assert.equal(dueEarnings([entry], {}, "2026-10-22").length, 0, "already reported");
  assert.match(
    earningsLine({ ...entry, away: 1 }),
    /NFLX.*reports tomorrow, after the market closes/
  );
});

test("earnings step: posts to its channel, remembers it after sending, feeds the app", async () => {
  const httpGet = async (url, options = {}) => {
    if (url.includes("api.nasdaq.com")) {
      assert.match(options.userAgent, /Mozilla/);
      const day = new URL(url).searchParams.get("date");
      return nasdaq(
        day === "2026-10-21"
          ? [
              {
                symbol: "NFLX",
                name: "Netflix, Inc.",
                time: "time-after-hours",
                epsForecast: "$0.82",
              },
            ]
          : []
      );
    }
    return `<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>`;
  };
  const config = loadConfig(
    {
      NEWS_BOT_TICKERS: "NFLX",
      NEWS_BOT_DISABLE: "brief,calendar,predictions,prices,trending,outlook,stocks",
    },
    ["--once"]
  );
  const { hook, sent } = recorder();
  const state = emptyState();
  state.initialized = true;
  const run = () => runCycle(config, state, { httpGet, discord: hook, now: () => NOW });

  const first = await run();
  assert.equal(first.earnings, 1);
  assert.match(
    sent.at(-1).body.embeds[0].description,
    /\*\*NFLX\*\* \(Netflix, Inc\.\) reports 2026-10-21/
  );
  assert.equal((await run()).earnings, 0, "not announced twice");
  assert.deepEqual(
    buildFeed(state, NOW).earnings.map((e) => e.symbol),
    ["NFLX"]
  );

  // A failed send is not recorded, so it is tried again.
  const broken = emptyState();
  broken.initialized = true;
  const failing = new DiscordWebhook(WEBHOOK, {
    fetchImpl: async () => {
      throw new Error("socket hang up");
    },
    sleep: async () => {},
    maxRetries: 0,
  });
  const result = await runCycle(config, broken, { httpGet, discord: failing, now: () => NOW });
  assert.equal(result.errors.length, 1);
  assert.deepEqual(broken.earningsAlerted, {});
});

// ── urgent @mentions ─────────────────────────────────────────────────────────

test("ping settings: only valid mentions, and only what was configured is allowed", () => {
  assert.equal(parsePing(""), null);
  assert.equal(parsePing("everyone please"), null);
  assert.equal(parsePing("user:123"), null, "ids must be real snowflakes");
  const ping = parsePing("@here, user:123456789012345678 role:987654321098765432");
  assert.equal(ping.content, "@here <@123456789012345678> <@&987654321098765432> ⚡ Urgent");
  assert.deepEqual(ping.allowed, {
    parse: ["everyone"],
    users: ["123456789012345678"],
    roles: ["987654321098765432"],
  });
});

test("a ping carries only the configured mention; the headline can never ping", async () => {
  const { hook, sent } = recorder();
  await hook.send({
    username: "Bot",
    content: "@everyone hi",
    embeds: [{ title: "@everyone" }],
  });
  assert.deepEqual(sent[0].body.allowed_mentions, { parse: [] });

  const ping = parsePing("user:123456789012345678");
  await hook.send({ username: "Bot", embeds: [{ title: "x @everyone" }], mention: ping });
  assert.equal(sent[1].body.content, "<@123456789012345678> ⚡ Urgent");
  assert.deepEqual(sent[1].body.allowed_mentions.users, ["123456789012345678"]);
  assert.deepEqual(sent[1].body.allowed_mentions.parse, []);
});

test("urgent: market-moving Trump and official posts, and 13D filings, only", () => {
  const item = (category, title, extra = {}) => ({ category, title, summary: "", ...extra });
  assert.equal(isUrgent(item("trump", "Trump posted", { summary: "New tariffs on China" })), true);
  assert.equal(
    isUrgent(item("trump", "Trump posted", { summary: "Happy birthday Melania" })),
    false
  );
  assert.equal(isUrgent(item("official", "Federal Open Market Committee statement")), true);
  assert.equal(isUrgent(item("official", "Speech on the weather")), false);
  assert.equal(isUrgent(item("filings", "x", { form: "13D" })), true);
  assert.equal(isUrgent(item("filings", "x", { form: "13F" })), false);
  assert.equal(isUrgent(item("markets", "Tariffs crash markets")), false);
});

test("only the message with an urgent story pings, at most a few times a run", async () => {
  const config = loadConfig(
    {
      NEWS_BOT_PING: "user:123456789012345678",
      NEWS_BOT_MAX_PINGS: "2",
      NEWS_BOT_DISABLE: "brief,calendar,predictions,prices,trending,outlook,earnings",
    },
    ["--once"]
  );
  const post = (n, extra) => ({
    title: `Trump post ${n}`,
    link: `https://truth.test/${n}`,
    published: NOW - n * 60_000,
    summary: extra,
    source: "Truth",
    category: "trump",
    feedName: "Truth Social",
  });
  const posts = [
    post(1, "new tariffs"),
    post(2, "nice weather"),
    post(3, "sanctions"),
    post(4, "war"),
    post(5, "tariff"),
  ];
  const httpGet = async (url) =>
    url.includes("trumpstruth.org/feed")
      ? `<?xml version="1.0"?><rss version="2.0"><channel>${posts
          .map(
            (p) =>
              `<item><title>${p.title}</title><link>${p.link}</link><guid>${p.link}</guid><pubDate>${new Date(p.published).toUTCString()}</pubDate><description>${p.summary}</description></item>`
          )
          .join("")}</channel></rss>`
      : `<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>`;
  const { hook, sent } = recorder();
  const state = emptyState();
  state.initialized = true;
  config.maxPerCategory = 1; // one story per message, so each can be pinged on its own
  const first = await runCycle(config, state, { httpGet, discord: hook, now: () => NOW });
  assert.equal(first.news, 1);
  assert.equal(sent.filter((m) => m.body.content?.includes("⚡ Urgent")).length, 1);

  config.maxPerCategory = 15;
  const sentBefore = sent.length;
  await runCycle(config, state, { httpGet, discord: hook, now: () => NOW + 60_000 });
  const pinged = sent.slice(sentBefore).filter((m) => m.body.content?.includes("⚡ Urgent"));
  assert.ok(pinged.length <= 2, `got ${pinged.length} pings, expected at most 2`);
});

// ── one channel per topic ────────────────────────────────────────────────────

test("topic channels: read from NEWS_BOT_WEBHOOK_<TOPIC>, bad ones ignored", () => {
  const found = channelWebhooks(
    { NEWS_BOT_WEBHOOK_TRUMP: ` ${TRUMP_HOOK} `, NEWS_BOT_WEBHOOK_MARKETS: "", OTHER: "x" },
    ["trump", "markets", "world"]
  );
  assert.deepEqual(found, { trump: TRUMP_HOOK });

  const config = loadConfig(
    {
      DISCORD_WEBHOOK_URL: WEBHOOK,
      NEWS_BOT_WEBHOOK_TRUMP: TRUMP_HOOK,
      NEWS_BOT_WEBHOOK_WORLD: "https://evil.example.com/hook",
    },
    []
  );
  const { discordFor, discord, byCategory } = createDiscords(config, { fetchImpl: ok });
  assert.notEqual(discordFor("trump"), discord);
  assert.equal(discordFor("trump").url, TRUMP_HOOK);
  assert.equal(discordFor("world"), discord, "an invalid webhook falls back to the main channel");
  assert.equal(discordFor("markets"), discord);
  assert.deepEqual(Object.keys(byCategory), ["trump"]);
});

test("stories go to their topic's channel; the rest stay in the main one", async () => {
  const sentTo = [];
  const fetchImpl = async (endpoint, init) => {
    sentTo.push({ endpoint, body: JSON.parse(init.body) });
    return ok();
  };
  const config = loadConfig(
    {
      DISCORD_WEBHOOK_URL: WEBHOOK,
      NEWS_BOT_WEBHOOK_TRUMP: TRUMP_HOOK,
      NEWS_BOT_DISABLE: "brief,calendar,predictions,prices,trending,outlook,earnings",
    },
    ["--once"]
  );
  const clients = createDiscords(config, { mode: "discord", fetchImpl });
  for (const c of new Set([clients.discord, ...Object.values(clients.byCategory)])) {
    c.sleep = async () => {};
    c.gapMs = 0;
  }
  const feedXml = (title, link) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><item><title>${title}</title><link>${link}</link><guid>${link}</guid><pubDate>${new Date(NOW - 60_000).toUTCString()}</pubDate></item></channel></rss>`;
  const httpGet = async (url) => {
    if (url.includes("trumpstruth.org/feed")) return feedXml("Trump post", "https://truth.test/1");
    if (url.includes("bbci.co.uk/news/world")) return feedXml("World story", "https://news.test/w");
    return `<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>`;
  };
  const state = emptyState();
  state.initialized = true;
  await runCycle(config, state, { ...clients, httpGet, now: () => NOW });

  const trumpMsgs = sentTo.filter((m) => m.endpoint.startsWith(TRUMP_HOOK));
  const mainMsgs = sentTo.filter((m) => m.endpoint.startsWith(WEBHOOK));
  assert.ok(trumpMsgs.length >= 1);
  assert.ok(
    trumpMsgs.every((m) => m.body.embeds.every((e) => /Truth|Trump/.test(JSON.stringify(e))))
  );
  assert.ok(mainMsgs.length >= 1);
  assert.ok(!mainMsgs.some((m) => JSON.stringify(m.body).includes("Trump post")));
});

// ── embeds ───────────────────────────────────────────────────────────────────

test("stock and filing stories get their own look", () => {
  const stock = newsEmbed({
    title: "Apple unveils chip",
    link: "https://news.test/a",
    category: "stocks",
    feedName: "AAPL",
    source: "Reuters",
    summary: "",
  });
  assert.equal(stock.author.name, "📈 AAPL");
  const filing = newsEmbed({
    title: "Pershing Square filed a 13D",
    link: "https://sec.test/x",
    category: "filings",
    feedName: "SEC EDGAR",
    source: "SEC EDGAR",
    summary: "",
  });
  assert.equal(filing.author.name, "📑 SEC EDGAR");
});

test("filings are never merged with other outlets' versions of a story", () => {
  const item = (title, link) => ({
    title,
    link,
    published: NOW - 60_000,
    summary: "",
    source: "SEC",
    category: "filings",
    feedName: "SEC EDGAR",
    form: "13D",
  });
  const state = emptyState();
  state.initialized = true;
  const config = loadConfig({}, []);
  const picked = selectNewItems(
    [
      item("Pershing Square filed a 13D: a 5%+ stake in Acme", "https://sec.test/1"),
      item("Pershing Square filed a 13D: a 5%+ stake in Beta", "https://sec.test/2"),
    ],
    state,
    config,
    NOW
  );
  assert.equal(picked.filings.length, 2);
});
