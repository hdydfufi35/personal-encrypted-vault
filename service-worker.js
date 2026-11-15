/*
 * NotyPad Service Worker (v8)
 * Scope-safe cache management for GitHub Pages PWA.
 */
const CACHE_PREFIX = "notypad-personal-encrypted-vault-";
const CACHE_NAME = `${CACHE_PREFIX}v8`;
const LEGACY_NOTYPAD_CACHE_NAMES = new Set(["notypad-pwa-cache-v5"]);
const NAVIGATION_TIMEOUT_MS = 4000;
const TIMED_OUT = Symbol("timed-out");

const APP_SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./favicon-32x32.png",
  "./apple-touch-icon-180x180.png",
  "./android-chrome-192x192.png",
  "./android-chrome-512x512.png",
  "./maskable-icon-512x512.png",
  "./logo-horizontal.png"
];

function isAllowedStaticCrossOrigin(url) {
  if (url.hostname === "fonts.googleapis.com") return true;
  if (url.hostname === "fonts.gstatic.com") return true;
  return url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/11.0.1/");
}

function isFirebaseOrSensitiveEndpoint(url) {
  const host = url.hostname.toLowerCase();
  if (host.endsWith(".googleapis.com") && host !== "fonts.googleapis.com") return true;
  return host === "firestore.googleapis.com" ||
    host.endsWith(".firebaseio.com") ||
    host.endsWith(".firebasestorage.app") ||
    host.endsWith(".firebaseapp.com") ||
    host === "identitytoolkit.googleapis.com" ||
    host === "securetoken.googleapis.com" ||
    host === "accounts.google.com" ||
    host === "oauth2.googleapis.com" ||
    host === "www.googleapis.com";
}

// Only real, complete, readable responses are cached (no opaque, error or partial 206 responses).
function isCacheableResponse(response) {
  return !!response &&
    response.status === 200 &&
    (response.type === "basic" || response.type === "cors");
}

async function safeCachePut(cache, request, response) {
  try {
    await cache.put(request, response);
  } catch (_) {}
}

function isAppShellRequest(url, scopeUrl) {
  return url.pathname === scopeUrl.pathname || url.pathname === `${scopeUrl.pathname}index.html`;
}

async function matchAppShell(cache, indexUrl, rootUrl) {
  return (await cache.match(indexUrl, { ignoreSearch: true })) ||
    (await cache.match(rootUrl, { ignoreSearch: true }));
}

// Stores one fresh copy of the app shell under both "./" and "./index.html".
// Both clones are taken synchronously, before the original response is handed to the page.
async function storeAppShell(cache, indexUrl, rootUrl, response) {
  if (!isCacheableResponse(response)) return;
  const forIndex = response.clone();
  const forRoot = response.clone();
  await safeCachePut(cache, indexUrl, forIndex);
  await safeCachePut(cache, rootUrl, forRoot);
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const scopeUrl = self.registration.scope;
    const failed = [];
    for (const asset of APP_SHELL_ASSETS) {
      const url = new URL(asset, scopeUrl);
      try {
        const request = new Request(url.href, { cache: "reload" });
        const response = await fetch(request);
        if (isCacheableResponse(response)) {
          await cache.put(request, response.clone());
        } else {
          failed.push(`${asset} (HTTP ${response.status})`);
        }
      } catch (_) {
        failed.push(`${asset} (network error)`);
      }
    }
    if (failed.length > 0) {
      console.warn("[NotyPad SW] These app-shell files could not be cached. Check that they exist in the repo root: " + failed.join(", "));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => (key.startsWith(CACHE_PREFIX) || LEGACY_NOTYPAD_CACHE_NAMES.has(key)) && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

// Fonts and Firebase SDK files: cache first, refreshed in the background.
// Re-fetched in CORS mode so the stored copy is a real (non-opaque) response.
async function handleCrossOriginStatic(event, request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkPromise = fetch(new Request(request.url, { mode: "cors", credentials: "omit" })).then(async (response) => {
    if (isCacheableResponse(response)) await safeCachePut(cache, request, response.clone());
    return response;
  });
  if (cached) {
    event.waitUntil(networkPromise.catch(() => {}));
    return cached;
  }
  try {
    return await networkPromise;
  } catch (_) {
    return Response.error();
  }
}

// App page ("./" and "./index.html"): network first, but fall back to the cached copy
// when the network is offline OR too slow (so a weak connection never hangs the app).
async function handleAppShell(event, request, scopeUrl) {
  const cache = await caches.open(CACHE_NAME);
  const indexUrl = new URL("index.html", scopeUrl).href;
  const rootUrl = new URL("./", scopeUrl).href;

  const networkResult = fetch(request).catch(() => null);
  const timeout = new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), NAVIGATION_TIMEOUT_MS));
  const first = await Promise.race([networkResult, timeout]);

  if (first && first !== TIMED_OUT) {
    event.waitUntil(storeAppShell(cache, indexUrl, rootUrl, first));
    return first;
  }

  const cachedShell = await matchAppShell(cache, indexUrl, rootUrl);

  if (first === TIMED_OUT) {
    if (cachedShell) {
      event.waitUntil(networkResult.then((late) => (late ? storeAppShell(cache, indexUrl, rootUrl, late) : undefined)));
      return cachedShell;
    }
    const late = await networkResult;
    if (late) {
      event.waitUntil(storeAppShell(cache, indexUrl, rootUrl, late));
      return late;
    }
    return Response.error();
  }

  // Network failed immediately (offline).
  return cachedShell || Response.error();
}

// Other files of the app (icons, manifest...): cache first, refreshed in the background.
async function handleSameOriginAsset(event, request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkPromise = fetch(request).then(async (response) => {
    if (isCacheableResponse(response)) await safeCachePut(cache, request, response.clone());
    return response;
  });
  if (cached) {
    event.waitUntil(networkPromise.catch(() => {}));
    return cached;
  }
  try {
    return await networkPromise;
  } catch (_) {
    return Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.headers && request.headers.has("range")) return;

  const url = new URL(request.url);
  const scopeUrl = new URL(self.registration.scope);
  const sameOrigin = url.origin === scopeUrl.origin;
  const inAppScope = sameOrigin && url.pathname.startsWith(scopeUrl.pathname);

  if (isFirebaseOrSensitiveEndpoint(url)) return;

  if (!sameOrigin) {
    if (!isAllowedStaticCrossOrigin(url)) return;
    event.respondWith(handleCrossOriginStatic(event, request));
    return;
  }

  if (!inAppScope) return;

  if (isAppShellRequest(url, scopeUrl)) {
    event.respondWith(handleAppShell(event, request, scopeUrl));
    return;
  }

  // Any other page navigation is left to the browser.
  if (request.mode === "navigate") return;

  event.respondWith(handleSameOriginAsset(event, request));
});
