#!/usr/bin/env node
// News Radar for your PC. Runs the news bot on this computer, keeps its own copy of the news
// up to date, and shows it in the News Radar app window. Nothing here depends on GitHub.
//
//   node contrib/news-bot/desktop/server.mjs      (Windows: use "News Radar.bat" from the download)
//
// Your settings and the news live in NEWS_RADAR_HOME (default: ~/.news-radar).

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDiscords, createHttpGet, loadConfig, outputMode, runCycle } from "../newsBot.mjs";
import {
  DEFAULT_SETTINGS,
  applySettingsChange,
  isOwnRequest,
  normalizeSettings,
  publicSettings,
  settingsToEnv,
  staticFile,
} from "../lib/desktop.mjs";
import { buildFeed, writeFeed } from "../lib/feed.mjs";
import { loadState, saveState } from "../lib/state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(HERE, "..", "app");
export const DEFAULT_PORT = 47821;
const MAX_BODY = 10 * 1024;

const stamp = () => new Date().toLocaleTimeString();

/**
 * Start the server and the news cycle. Returns what a caller needs to talk to or stop it.
 * `httpGet` and `now` exist so tests can run it without the internet.
 */
export async function startServer({
  home,
  port = DEFAULT_PORT,
  httpGet,
  fetchImpl = fetch,
  log = (message) => console.log(`[${stamp()}] ${message}`),
  schedule = true,
} = {}) {
  await mkdir(home, { recursive: true });
  const files = {
    settings: join(home, "settings.json"),
    state: join(home, "state.json"),
    feed: join(home, "feed.json"),
  };

  async function loadSettings() {
    try {
      return normalizeSettings({
        ...DEFAULT_SETTINGS,
        ...JSON.parse(await readFile(files.settings, "utf8")),
      });
    } catch {
      return normalizeSettings(DEFAULT_SETTINGS);
    }
  }
  async function saveSettings(settings) {
    // Holds the Discord webhook, so only the owner may read it.
    await writeFile(files.settings, JSON.stringify(settings, null, 2), { mode: 0o600 });
  }

  let settings = await loadSettings();
  const status = { running: false, lastCycleAt: 0, lastError: "" };
  let timer = null;
  let current = null;
  let closed = false;

  async function cycle() {
    if (current) return current;
    current = (async () => {
      status.running = true;
      const config = loadConfig(
        settingsToEnv(settings, { stateFile: files.state, feedFile: files.feed }),
        ["--once"]
      );
      const mode = outputMode(config);
      const clients = createDiscords(config, { mode, fetchImpl });
      const state = await loadState(files.state);
      try {
        const s = await runCycle(config, state, {
          ...clients,
          httpGet: httpGet || createHttpGet(),
          fetchImpl,
        });
        status.lastError = s.errors.length ? s.errors.join("; ") : "";
        log(
          `Updated: ${s.news} new stories` +
            (s.failingSources.length ? `, sources down: ${s.failingSources.join(", ")}` : "") +
            (s.errors.length ? `, ${s.errors.length} problems` : "")
        );
      } catch (err) {
        status.lastError = err.message;
        log(`Could not update the news: ${err.message}`);
      } finally {
        await saveState(files.state, state);
        await writeFeed(files.feed, buildFeed(state));
        status.lastCycleAt = Date.now();
        status.running = false;
        current = null;
      }
    })();
    return current;
  }

  function scheduleNext() {
    if (!schedule || closed) return;
    clearTimeout(timer);
    timer = setTimeout(
      async () => {
        await cycle();
        scheduleNext();
      },
      settings.refreshMinutes * 60 * 1000
    );
    timer.unref?.();
  }

  const send = (res, code, body, type, extra = {}) => {
    res.writeHead(code, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      ...extra,
    });
    res.end(body);
  };
  const sendJson = (res, code, value) =>
    send(res, code, JSON.stringify(value), "application/json; charset=utf-8");

  async function readJsonBody(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new Error("too large");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }

  const view = () => ({
    app: "news-radar",
    ...publicSettings(settings),
    running: status.running,
    lastCycleAt: status.lastCycleAt,
    lastError: status.lastError,
  });

  const server = createServer(async (req, res) => {
    try {
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      const url = new URL(req.url || "/", `http://127.0.0.1:${boundPort}`);
      const write = req.method === "POST";
      if (!isOwnRequest(req.headers, boundPort, { write })) {
        return send(res, 403, "Forbidden", "text/plain; charset=utf-8");
      }

      if (req.method === "GET" || req.method === "HEAD") {
        if (url.pathname === "/feed.json") {
          try {
            return send(res, 200, await readFile(files.feed), "application/json; charset=utf-8");
          } catch {
            return send(res, 404, "No news yet", "text/plain; charset=utf-8");
          }
        }
        if (url.pathname === "/api/settings") return sendJson(res, 200, view());
        const entry = staticFile(url.pathname);
        if (entry) {
          return send(res, 200, await readFile(join(APP_DIR, entry[0])), entry[1]);
        }
        return send(res, 404, "Not found", "text/plain; charset=utf-8");
      }

      if (req.method === "POST" && url.pathname === "/api/refresh") {
        void cycle();
        return sendJson(res, 202, view());
      }
      if (req.method === "POST" && url.pathname === "/api/settings") {
        const { settings: next, problems } = applySettingsChange(settings, await readJsonBody(req));
        settings = next;
        await saveSettings(settings);
        void cycle().then(scheduleNext);
        return sendJson(res, 200, { ...view(), problems });
      }
      return send(res, 404, "Not found", "text/plain; charset=utf-8");
    } catch (err) {
      const tooBig = err.message === "too large";
      return send(res, tooBig ? 413 : 400, tooBig ? "Too large" : "Bad request", "text/plain");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const boundPort = server.address().port;

  return {
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}/`,
    files,
    status,
    cycle,
    start() {
      const first = cycle();
      first.then(scheduleNext);
      return first;
    },
    async close() {
      closed = true;
      clearTimeout(timer);
      await current;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Open the app window: Edge as an app (no address bar) on Windows, else the default browser. */
export function openWindow(url) {
  const env = { ...process.env, NEWS_RADAR_URL: url };
  const options = { env, detached: true, stdio: "ignore", windowsHide: true };
  if (process.platform === "win32") {
    // The address goes through the environment, never into the command text.
    spawn(
      "cmd.exe",
      ["/d", "/c", 'start "" msedge --app=%NEWS_RADAR_URL% || start "" %NEWS_RADAR_URL%'],
      options
    ).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], options).unref();
  } else {
    spawn("xdg-open", [url], options).unref();
  }
}

async function isNewsRadar(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      signal: AbortSignal.timeout(2000),
    });
    return (await res.json()).app === "news-radar";
  } catch {
    return false;
  }
}

async function main() {
  const home = process.env.NEWS_RADAR_HOME || join(homedir(), ".news-radar");
  const noOpen = Boolean(process.env.NEWS_RADAR_NO_OPEN);
  let app = null;
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + 10 && !app; port++) {
    try {
      app = await startServer({ home, port });
    } catch (err) {
      if (err.code !== "EADDRINUSE") throw err;
      if (await isNewsRadar(port)) {
        console.log("News Radar is already running. Opening its window.");
        if (!noOpen) openWindow(`http://127.0.0.1:${port}/`);
        return;
      }
    }
  }
  if (!app) throw new Error("No free port for News Radar on this computer.");

  console.log("News Radar is running on this computer.");
  console.log("Keep this window open (you can minimise it). Close it to quit News Radar.");
  console.log(`Your settings and news are saved in ${home}`);
  console.log("Getting the latest news…");

  const first = app.start();
  // The window opens as soon as there is news to show (or after a minute, whatever happens).
  await Promise.race([first, new Promise((resolve) => setTimeout(resolve, 60_000))]);
  if (!noOpen) openWindow(app.url);
  console.log(`The app window is at ${app.url}`);

  const quit = () => {
    app.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`News Radar could not start: ${err.message}`);
    process.exit(1);
  });
}
