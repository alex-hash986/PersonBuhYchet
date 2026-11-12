const VERSION = "smartbudget-v6";
const SHELL = VERSION + "-shell";
const API = VERSION + "-api";
const ASSETS = [
  "/", "/static/index.html", "/manifest.json", "/static/styles.css", "/static/app.js",
  "/static/storage.js", "/static/analytics.js", "/static/icon.svg",
  "/static/icon-192.png", "/static/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(ASSETS.map((url) => new Request(url, { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("smartbudget-") && key !== SHELL && key !== API) {
        await caches.delete(key);
      }
    }
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  const url = new URL(request.url);
  const cacheable = request.method === "GET" && url.pathname === "/api/transactions" && !url.search;
  if (!cacheable) return fetch(request);

  const cache = await caches.open(API);
  try {
    const response = await fetch(request);
    if (response.ok) {
      try {
        await cache.put(request, response.clone());
      } catch (error) {
        console.warn("SmartBudget could not cache the API response", error);
      }
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (!cached) throw error;
    const headers = new Headers(cached.headers);
    headers.set("X-SmartBudget-Offline", "1");
    return new Response(cached.body, { headers, status: cached.status });
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(request));
  } else if (request.method === "GET" && ASSETS.includes(url.pathname)) {
    const key = request.mode === "navigate" ? "/" : url.pathname;
    event.respondWith(caches.open(SHELL).then(async (cache) => (
      await cache.match(key) || fetch(request)
    )));
  }
});
