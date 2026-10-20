import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_SETTINGS,
  applySettingsChange,
  isOwnRequest,
  normalizeSettings,
  publicSettings,
  settingsToEnv,
  staticFile,
} from "../lib/desktop.mjs";
import { startServer } from "../desktop/server.mjs";

const WEBHOOK = "https://discord.com/api/webhooks/123456789/abcDEF_-token";

// ── settings ─────────────────────────────────────────────────────────────────

test("settings: broken or hostile values fall back to safe ones", () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  const s = normalizeSettings({
    tickers: "aapl, bad!!, TSLA",
    discordWebhook: "https://evil.example.com/hook",
    secContact: "  me@example.com  ",
    ping: "everyone please",
    refreshMinutes: 9999,
  });
  assert.equal(s.tickers, "AAPL, TSLA");
  assert.equal(s.discordWebhook, "", "only Discord webhook links are kept");
  assert.equal(s.secContact, "me@example.com");
  assert.equal(s.ping, "", "an unusable ping is dropped");
  assert.equal(s.refreshMinutes, 60, "limited to 2-60 minutes");
  assert.equal(normalizeSettings({ refreshMinutes: 0 }).refreshMinutes, 2);
  assert.equal(normalizeSettings({ refreshMinutes: "soon" }).refreshMinutes, 5);
});

test("settings form: a blank webhook keeps the saved one; bad input is reported, not saved", () => {
  const current = normalizeSettings({ tickers: "AAPL", discordWebhook: WEBHOOK });

  let r = applySettingsChange(current, { tickers: "TSLA", discordWebhook: "" });
  assert.equal(r.settings.discordWebhook, WEBHOOK);
  assert.equal(r.settings.tickers, "TSLA");
  assert.deepEqual(r.problems, []);

  r = applySettingsChange(current, { discordWebhook: "https://evil.example.com/x" });
  assert.equal(r.settings.discordWebhook, WEBHOOK, "the old one stays");
  assert.equal(r.problems.length, 1);

  r = applySettingsChange(current, { clearWebhook: true });
  assert.equal(r.settings.discordWebhook, "");

  r = applySettingsChange(current, { ping: "@here" });
  assert.equal(r.settings.ping, "@here");
  r = applySettingsChange(current, { ping: "nonsense" });
  assert.equal(r.settings.ping, "");
  assert.equal(r.problems.length, 1);

  assert.deepEqual(applySettingsChange(current, undefined).settings, current);
});

test("the settings form never gets to see the webhook", () => {
  const view = publicSettings(normalizeSettings({ discordWebhook: WEBHOOK, tickers: "AAPL" }));
  assert.equal(view.webhookSet, true);
  assert.ok(!JSON.stringify(view).includes("abcDEF"));
  assert.equal(publicSettings(normalizeSettings({})).webhookSet, false);
});

test("settings become the bot's environment; with no Discord the first run fills the app", () => {
  const files = { stateFile: "/data/state.json", feedFile: "/data/feed.json" };
  const local = settingsToEnv(
    normalizeSettings({ tickers: "AAPL, TSLA", refreshMinutes: 10 }),
    files
  );
  assert.equal(local.NEWS_BOT_TICKERS, "AAPL, TSLA");
  assert.equal(local.NEWS_BOT_FEED_FILE, "/data/feed.json");
  assert.equal(local.NEWS_BOT_INTERVAL_MINUTES, "10");
  assert.equal(local.NEWS_BOT_FIRST_RUN_PER_CATEGORY, "15");
  assert.equal(local.DISCORD_WEBHOOK_URL, "");

  const withDiscord = settingsToEnv(normalizeSettings({ discordWebhook: WEBHOOK }), files);
  assert.equal(withDiscord.DISCORD_WEBHOOK_URL, WEBHOOK);
  assert.equal(withDiscord.NEWS_BOT_FIRST_RUN_PER_CATEGORY, undefined, "no flood into Discord");
});

// ── who may talk to the local server ─────────────────────────────────────────

test("requests: only this computer's own address, and writes need the app's header", () => {
  const ok = { host: "127.0.0.1:47821" };
  assert.equal(isOwnRequest(ok, 47821), true);
  assert.equal(isOwnRequest({ host: "localhost:47821" }, 47821), true);
  assert.equal(isOwnRequest({ host: "evil.example:47821" }, 47821), false, "DNS rebinding");
  assert.equal(isOwnRequest({ host: "127.0.0.1:9999" }, 47821), false);
  assert.equal(isOwnRequest({}, 47821), false);

  assert.equal(isOwnRequest(ok, 47821, { write: true }), false, "no header");
  assert.equal(isOwnRequest({ ...ok, "x-news-radar": "1" }, 47821, { write: true }), true);
  assert.equal(
    isOwnRequest({ ...ok, "x-news-radar": "1", origin: "http://127.0.0.1:47821" }, 47821, {
      write: true,
    }),
    true
  );
  assert.equal(
    isOwnRequest({ ...ok, "x-news-radar": "1", origin: "https://evil.example" }, 47821, {
      write: true,
    }),
    false,
    "another website"
  );
});

test("only the app's own files are served", () => {
  assert.deepEqual(staticFile("/"), ["index.html", "text/html; charset=utf-8"]);
  assert.equal(staticFile("/../newsBot.mjs"), null);
  assert.equal(staticFile("/sw.js"), null);
  assert.equal(staticFile("/state.json"), null);
});

// ── the local server ─────────────────────────────────────────────────────────

const emptyRss = `<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>`;

// Nothing may reach the real Discord from a test.
const noDiscord = async () => {
  throw new Error("no network in tests");
};

// A quiet internet: no news, no odds, an empty calendar, no prices.
function quietInternet(seen = []) {
  return async (url) => {
    seen.push(url);
    if (/polymarket|faireconomy/.test(url)) return "[]";
    if (/nasdaq/.test(url)) return JSON.stringify({ data: { rows: [] } });
    if (/finance\.yahoo/.test(url)) return "{}";
    return emptyRss;
  };
}

function call(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("desktop server: serves the app and the news, saves settings, refuses other websites", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "news-radar-"));
  const fetched = [];
  const httpGet = quietInternet(fetched);
  const app = await startServer({
    home,
    port: 0,
    httpGet,
    fetchImpl: noDiscord,
    schedule: false,
    log: () => {},
  });
  t.after(async () => {
    await app.close();
    await rm(home, { recursive: true, force: true });
  });
  await app.start();
  const { port } = app;
  const write = { "x-news-radar": "1", "content-type": "application/json" };

  const index = await call(port, { path: "/" });
  assert.equal(index.status, 200);
  assert.match(index.text, /News Radar/);
  assert.equal(index.headers["x-frame-options"], "DENY");

  const feed = await call(port, { path: "/feed.json" });
  assert.equal(feed.status, 200);
  assert.ok(Array.isArray(JSON.parse(feed.text).headlines));
  assert.equal(feed.headers["cache-control"], "no-store");

  assert.equal((await call(port, { path: "/../newsBot.mjs" })).status, 404);
  assert.equal((await call(port, { path: "/state.json" })).status, 404);
  assert.equal(
    (await call(port, { path: "/feed.json", headers: { host: "evil.example" } })).status,
    403
  );

  // Settings: other websites can't read or change them.
  const settings = JSON.parse((await call(port, { path: "/api/settings" })).text);
  assert.equal(settings.app, "news-radar");
  assert.equal(
    (await call(port, { method: "POST", path: "/api/settings", body: "{}" })).status,
    403
  );
  assert.equal(
    (
      await call(port, {
        method: "POST",
        path: "/api/settings",
        headers: { ...write, origin: "https://evil.example" },
        body: "{}",
      })
    ).status,
    403
  );
  assert.equal(
    (
      await call(port, {
        method: "POST",
        path: "/api/settings",
        headers: write,
        body: "x".repeat(20000),
      })
    ).status,
    413
  );
  assert.equal(
    (await call(port, { method: "POST", path: "/api/settings", headers: write, body: "not json" }))
      .status,
    400
  );

  const saved = await call(port, {
    method: "POST",
    path: "/api/settings",
    headers: write,
    body: JSON.stringify({ tickers: "aapl", discordWebhook: "https://evil.example.com/x" }),
  });
  assert.equal(saved.status, 200);
  const result = JSON.parse(saved.text);
  assert.equal(result.tickers, "AAPL");
  assert.equal(result.webhookSet, false);
  assert.equal(result.problems.length, 1);
  await app.cycle();
  assert.ok(
    fetched.some((url) => decodeURIComponent(url).includes('"AAPL" stock')),
    "the next update searches the news for the new stock"
  );

  // A valid webhook is stored, but never sent back.
  const withHook = await call(port, {
    method: "POST",
    path: "/api/settings",
    headers: write,
    body: JSON.stringify({ discordWebhook: WEBHOOK }),
  });
  assert.equal(JSON.parse(withHook.text).webhookSet, true);
  assert.ok(!withHook.text.includes("abcDEF"));
  assert.ok(!(await call(port, { path: "/api/settings" })).text.includes("abcDEF"));
  const onDisk = JSON.parse(await readFile(join(home, "settings.json"), "utf8"));
  assert.equal(onDisk.discordWebhook, WEBHOOK);
  assert.equal(onDisk.tickers, "AAPL");
  if (process.platform !== "win32") {
    assert.equal((await stat(join(home, "settings.json"))).mode & 0o077, 0, "owner-only file");
  }
  await app.cycle();
});

test("desktop server: settings survive a restart, and a broken file falls back to defaults", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "news-radar-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const httpGet = quietInternet();
  const write = { "x-news-radar": "1", "content-type": "application/json" };

  const first = await startServer({
    home,
    port: 0,
    httpGet,
    fetchImpl: noDiscord,
    schedule: false,
    log: () => {},
  });
  await call(first.port, {
    method: "POST",
    path: "/api/settings",
    headers: write,
    body: JSON.stringify({ tickers: "NVDA", refreshMinutes: 15 }),
  });
  await first.cycle();
  await first.close();

  const second = await startServer({
    home,
    port: 0,
    httpGet,
    fetchImpl: noDiscord,
    schedule: false,
    log: () => {},
  });
  const view = JSON.parse((await call(second.port, { path: "/api/settings" })).text);
  assert.equal(view.tickers, "NVDA");
  assert.equal(view.refreshMinutes, 15);
  await second.close();

  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(home, "settings.json"), "{ this is not json");
  const third = await startServer({
    home,
    port: 0,
    httpGet,
    fetchImpl: noDiscord,
    schedule: false,
    log: () => {},
  });
  assert.equal(JSON.parse((await call(third.port, { path: "/api/settings" })).text).tickers, "");
  await third.close();
});
