/* global self, caches, fetch, Headers, Response, URL */
// News Radar service worker (deployed as sw.js). Keeps the app shell and the last
// feed.json on the device so the app still opens with the latest news offline.

const SHELL_CACHE = "news-radar-shell-v1";
const FEED_CACHE = "news-radar-feed-v1";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== FEED_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

async function feedFromNetwork(request) {
  const cache = await caches.open(FEED_CACHE);
  const key = new URL("feed.json", self.registration.scope).href;
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(key, response.clone());
    return response;
  } catch {
    const cached = await cache.match(key);
    if (!cached) throw new Error("offline and no saved feed");
    // Tell the page this copy came from the device, not the network.
    const headers = new Headers(cached.headers);
    headers.set("x-news-radar-cache", "1");
    return new Response(await cached.blob(), { status: 200, headers });
  }
}

async function shellFromCache(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.endsWith("/feed.json")) {
    event.respondWith(feedFromNetwork(event.request));
  } else {
    event.respondWith(shellFromCache(event.request));
  }
});
