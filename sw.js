// sw.js — LifeVault™ (Premium PWA Service Worker)
//
// Goals:
// - Instant load offline (shell cached on install)
// - Safe updates (cache version bump + cleanup)
// - Good UX offline (fallback to index.html)
// - Avoid caching Stripe/3rd-party dynamic endpoints
// - Cache-first for static assets, network-first for navigation

const CACHE_VERSION = "lifevault-v3";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

// Anything you do NOT want cached (Stripe, analytics, API endpoints, etc.)
const NO_CACHE_HOSTS = new Set([
  "checkout.stripe.com",
  "api.stripe.com",
  "js.stripe.com",
  "m.stripe.network"
]);

const NO_CACHE_PATH_PREFIXES = [
  "/api/",              // your Stripe session endpoints live here
  "/.netlify/functions/",
  "/functions/",
  "/_worker.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      await cache.addAll(STATIC_ASSETS);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !k.startsWith(CACHE_VERSION))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

function isNoCacheRequest(requestUrl) {
  try {
    const url = new URL(requestUrl);
    if (NO_CACHE_HOSTS.has(url.hostname)) return true;
    const p = url.pathname || "";
    return NO_CACHE_PATH_PREFIXES.some((pref) => p.startsWith(pref));
  } catch {
    return false;
  }
}

// Navigation requests: prefer network (fresh code), fallback to cached shell
async function handleNavigation(request) {
  try {
    const res = await fetch(request);
    // Update cached shell so next offline load is current
    const cache = await caches.open(STATIC_CACHE);
    cache.put("./index.html", res.clone());
    return res;
  } catch {
    const cached = await caches.match("./index.html");
    return cached || new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

// Static assets: cache-first + background update
async function handleStatic(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    // background update
    fetch(request)
      .then((res) => res.ok && cache.put(request, res.clone()))
      .catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    // fallback to app shell for same-origin requests
    return (await caches.match("./index.html")) || new Response("Offline", { status: 503 });
  }
}

// Runtime: stale-while-revalidate for same-origin GET
async function handleRuntime(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);

  return cached || (await fetchPromise) || new Response("Offline", { status: 503 });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle GET
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Never cache Stripe / API / sensitive endpoints
  if (isNoCacheRequest(req.url)) {
    event.respondWith(fetch(req));
    return;
  }

  // App navigation: network-first
  if (req.mode === "navigate") {
    event.respondWith(handleNavigation(req));
    return;
  }

  // Same-origin static assets: cache-first
  const isSameOrigin = url.origin === self.location.origin;
  const isStatic = isSameOrigin && (
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".json") ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".jpg") ||
    url.pathname.endsWith(".jpeg") ||
    url.pathname.endsWith(".svg") ||
    url.pathname.endsWith(".webp") ||
    url.pathname.endsWith(".ico")
  );

  if (isStatic) {
    event.respondWith(handleStatic(req));
    return;
  }

  // Everything else (same-origin GET): runtime cache
  if (isSameOrigin) {
    event.respondWith(handleRuntime(req));
    return;
  }

  // Cross-origin: network only (don’t cache)
  event.respondWith(fetch(req));
});
