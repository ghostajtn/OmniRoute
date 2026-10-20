#!/usr/bin/env node
// News Radar for your PC. Runs the news bot on this computer, keeps its own copy of the news
// up to date, and shows it in the News Radar app window. Nothing here depends on GitHub.
//
//   node contrib/news-bot/desktop/server.mjs      (Windows: use "News Radar.bat" from the download)
//
// Your settings and the news live in NEWS_RADAR_HOME (default: ~/.news-radar).

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, statSync, truncateSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDiscords, createHttpGet, loadConfig, outputMode, runCycle } from "../newsBot.mjs";
import {
  DEFAULT_SETTINGS,
  appWindowArgs,
  applySettingsChange,
  browserCandidates,
  defaultBrowserFromRegistry,
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

/** The saved settings (defaults for anything missing or broken). */
export async function readSettings(home) {
  try {
    return normalizeSettings({
      ...DEFAULT_SETTINGS,
      ...JSON.parse(await readFile(join(home, "settings.json"), "utf8")),
    });
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS);
  }
}

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

  const loadSettings = () => readSettings(home);
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

/**
 * Resolves to true when the browser process behind an app window ends after a real session.
 * An exit within seconds means the window was handed to a browser that was already running
 * (or never opened), so it says nothing about the window being closed.
 */
export function watchWindow(child, now = Date.now) {
  const started = now();
  return new Promise((resolve) => {
    child.once("exit", () => resolve(now() - started > 10_000));
    child.once("error", () => resolve(false));
  });
}

/**
 * Open the app window: Edge (or Chrome) as an app on Windows, else the default browser.
 * Returns `closed`, a promise that resolves to true when that window's session has ended
 * (only for a window we started and can watch), otherwise null.
 */
export function openWindow(url, home, { watch = true, browser: choice = "auto" } = {}) {
  const env = { ...process.env, NEWS_RADAR_URL: url };
  if (process.platform === "win32") {
    const prefer = choice === "auto" ? defaultBrowser() : choice;
    const browser = browserCandidates(process.env, prefer).find((path) => existsSync(path));
    if (browser) {
      const child = spawn(browser, appWindowArgs(url, join(home, "browser-profile")), {
        stdio: "ignore",
      });
      if (!watch) {
        child.unref();
        return { closed: null };
      }
      const closed = watchWindow(child);
      return { closed };
    }
    // The address goes through the environment, never into the command text.
    spawn("cmd.exe", ["/d", "/c", 'start "" %NEWS_RADAR_URL%'], {
      env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return { closed: null };
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { env, detached: true, stdio: "ignore" }).unref();
  return { closed: null };
}

/** "chrome" or "edge" when that is the user's default browser (Windows only), else null. */
function defaultBrowser() {
  try {
    const result = spawnSync(
      "reg",
      [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice",
        "/v",
        "ProgId",
      ],
      { encoding: "utf8", timeout: 5000, windowsHide: true }
    );
    return defaultBrowserFromRegistry(result.stdout);
  } catch {
    return null;
  }
}

/** A logger that prints and also appends to news-radar.log (the app runs without a console). */
function fileLogger(home) {
  const file = join(home, "news-radar.log");
  try {
    if (statSync(file).size > 1024 * 1024) truncateSync(file, 0);
  } catch {
    /* no log yet */
  }
  return (message) => {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    try {
      appendFileSync(file, line);
    } catch {
      /* the log is a courtesy */
    }
    try {
      process.stdout.write(line);
    } catch {
      /* no console (the Windows launcher hides it); the log file has everything */
    }
  };
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

// Where settings, news and the log are kept: the first argument (the Windows launcher passes it),
// else NEWS_RADAR_HOME, else ~/.news-radar.
const dataHome = () =>
  process.argv[2] || process.env.NEWS_RADAR_HOME || join(homedir(), ".news-radar");

async function main() {
  const home = dataHome();
  await mkdir(home, { recursive: true });
  const log = fileLogger(home);
  // The bot prints with console.log; with no console that would throw, so it all goes to the log.
  const toLog = (...parts) => log(parts.map(String).join(" "));
  console.log = toLog;
  console.warn = toLog;
  console.error = toLog;
  const noOpen = Boolean(process.env.NEWS_RADAR_NO_OPEN);
  let app = null;
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + 10 && !app; port++) {
    try {
      app = await startServer({ home, port, log });
    } catch (err) {
      if (err.code !== "EADDRINUSE") throw err;
      if (await isNewsRadar(port)) {
        log("News Radar is already running. Opening another window.");
        if (!noOpen) {
          const { browser } = await readSettings(home);
          openWindow(`http://127.0.0.1:${port}/`, home, { watch: false, browser });
        }
        return;
      }
    }
  }
  if (!app) throw new Error("No free port for News Radar on this computer.");

  log(`News Radar is running. Settings and news are kept in ${home}`);
  log("Getting the latest news...");
  const first = app.start();
  // The window opens as soon as there is news to show (or after a minute, whatever happens).
  await Promise.race([first, new Promise((resolve) => setTimeout(resolve, 60_000))]);

  const quit = () => {
    log("Quitting News Radar.");
    app.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);

  if (!noOpen) {
    const { browser } = await readSettings(home);
    const { closed } = openWindow(app.url, home, { browser });
    log(`The app window is at ${app.url}`);
    // Closing the window quits News Radar.
    closed?.then((ended) => ended && quit());
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    const message = `News Radar could not start: ${err.message}`;
    try {
      appendFileSync(
        join(dataHome(), "news-radar.log"),
        `[${new Date().toISOString()}] ${message}\n`
      );
    } catch {
      /* nowhere to write it */
    }
    process.exit(1);
  });
}
