// Pure helpers for the News Radar desktop app (desktop/server.mjs): the settings the user
// can change in the app, and the checks that keep its local server from being driven by
// other websites.

import { isValidWebhookUrl } from "./discord.mjs";
import { parsePing, parseTickers } from "./extras.mjs";

export const DEFAULT_SETTINGS = {
  tickers: "",
  discordWebhook: "",
  secContact: "",
  ping: "",
  refreshMinutes: 5,
  browser: "auto",
};

// Which browser shows the app window: the default browser if it is Chrome or Edge, or a choice.
export const BROWSERS = new Set(["auto", "chrome", "edge"]);

const clampMinutes = (value, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(60, Math.max(2, n)) : fallback;
};

/** Settings read from disk: unknown or broken values fall back to the defaults. */
export function normalizeSettings(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    tickers: parseTickers(input.tickers).join(", "),
    discordWebhook:
      typeof input.discordWebhook === "string" && isValidWebhookUrl(input.discordWebhook.trim())
        ? input.discordWebhook.trim()
        : "",
    secContact: typeof input.secContact === "string" ? input.secContact.trim().slice(0, 200) : "",
    ping: parsePing(input.ping) && typeof input.ping === "string" ? input.ping.trim() : "",
    refreshMinutes: clampMinutes(input.refreshMinutes, DEFAULT_SETTINGS.refreshMinutes),
    browser: BROWSERS.has(input.browser) ? input.browser : DEFAULT_SETTINGS.browser,
  };
}

/**
 * Apply a change from the settings form. A blank webhook keeps the saved one (the form never
 * shows it); `clearWebhook` removes it. Returns the new settings and what was rejected.
 */
export function applySettingsChange(current, change) {
  const input = change && typeof change === "object" ? change : {};
  const problems = [];
  const next = { ...current };

  if ("tickers" in input) next.tickers = parseTickers(input.tickers).join(", ");

  if (input.clearWebhook === true) {
    next.discordWebhook = "";
  } else if (typeof input.discordWebhook === "string" && input.discordWebhook.trim()) {
    if (isValidWebhookUrl(input.discordWebhook.trim())) {
      next.discordWebhook = input.discordWebhook.trim();
    } else {
      problems.push("That is not a Discord webhook link, so it was not saved.");
    }
  }

  if (typeof input.secContact === "string") next.secContact = input.secContact.trim().slice(0, 200);

  if (typeof input.ping === "string") {
    const ping = input.ping.trim();
    if (!ping || parsePing(ping)) next.ping = ping;
    else problems.push("The ping must be @here, @everyone, user:<id> or role:<id>.");
  }

  if (typeof input.browser === "string" && BROWSERS.has(input.browser))
    next.browser = input.browser;

  if ("refreshMinutes" in input) {
    next.refreshMinutes = clampMinutes(input.refreshMinutes, current.refreshMinutes);
  }
  return { settings: normalizeSettings(next), problems };
}

/** What the settings form may see: never the webhook itself. */
export function publicSettings(settings) {
  const { discordWebhook, ...rest } = settings;
  return { ...rest, webhookSet: Boolean(discordWebhook) };
}

/** The environment variables the bot reads, built from the settings. */
export function settingsToEnv(settings, { stateFile, feedFile }) {
  const env = {
    NEWS_BOT_STATE_FILE: stateFile,
    NEWS_BOT_FEED_FILE: feedFile,
    NEWS_BOT_TICKERS: settings.tickers,
    NEWS_BOT_SEC_CONTACT: settings.secContact,
    NEWS_BOT_PING: settings.ping,
    DISCORD_WEBHOOK_URL: settings.discordWebhook,
    NEWS_BOT_INTERVAL_MINUTES: String(settings.refreshMinutes),
  };
  // Without a Discord channel to protect from a flood, the first run fills the app properly.
  if (!settings.discordWebhook) env.NEWS_BOT_FIRST_RUN_PER_CATEGORY = "15";
  return env;
}

/**
 * Whether a request really comes from the app's own window. Browsers send the Host header
 * of the address typed in; another website reaching this server by DNS trickery sends its
 * own name, so only 127.0.0.1 and localhost on this port are accepted. Anything that
 * changes something must also carry the custom header (which other websites cannot add
 * without the browser asking first) and, when the browser says where it came from, an
 * Origin that is this server.
 */
export function isOwnRequest(headers, port, { write = false } = {}) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!hosts.has(String(headers.host || "").toLowerCase())) return false;
  if (!write) return true;
  if (headers["x-news-radar"] !== "1") return false;
  const origin = headers.origin;
  return (
    origin === undefined ||
    hosts.has(
      String(origin)
        .replace(/^http:\/\//, "")
        .toLowerCase()
    )
  );
}

// The only files the server hands out, by address.
const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
  "/icon.svg": ["icon.svg", "image/svg+xml"],
  "/icon-192.png": ["icon-192.png", "image/png"],
  "/icon-512.png": ["icon-512.png", "image/png"],
  "/icon-maskable-512.png": ["icon-maskable-512.png", "image/png"],
  "/apple-touch-icon.png": ["apple-touch-icon.png", "image/png"],
};

/** The app file (name and content type) for a request path, or null. */
export function staticFile(pathname) {
  return STATIC_FILES[pathname] || null;
}

/**
 * Which browser the user's default web browser is, from the registry value
 * `reg query "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice" /v ProgId`.
 * Returns "chrome", "edge", or null for anything else (Firefox and so on).
 */
export function defaultBrowserFromRegistry(output) {
  const progId = /ProgId\s+REG_SZ\s+(\S+)/i.exec(String(output || ""))?.[1] || "";
  if (/^ChromeHTML/i.test(progId)) return "chrome";
  if (/^MSEdgeHTM/i.test(progId)) return "edge";
  return null;
}

/**
 * Where Chrome and Edge usually live on Windows, the preferred one first ("chrome" or "edge";
 * without a preference, Edge first because every Windows 10/11 has it).
 */
export function browserCandidates(env, prefer = null) {
  const pf86 = env["ProgramFiles(x86)"];
  const pf = env.ProgramFiles;
  const local = env.LOCALAPPDATA;
  const edge = [pf86, pf, local]
    .filter(Boolean)
    .map((base) => `${base}\\Microsoft\\Edge\\Application\\msedge.exe`);
  const chrome = [pf, pf86, local]
    .filter(Boolean)
    .map((base) => `${base}\\Google\\Chrome\\Application\\chrome.exe`);
  return prefer === "chrome" ? [...chrome, ...edge] : [...edge, ...chrome];
}

/**
 * Command-line arguments for an app window (no address bar or tabs). It gets its own browser
 * profile, so it is a separate browser process: closing the window ends that process, which
 * is how News Radar knows to quit.
 */
export function appWindowArgs(url, profileDir) {
  return [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    "--window-size=1240,880",
  ];
}
