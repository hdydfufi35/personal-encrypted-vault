/*
 * NotyPad Service Worker
 * Scope-safe cache management for the GitHub Pages app.
 *
 * - Only caches owned by this NotyPad installation are cleaned up.
 * - Firebase Auth / Firestore requests are never cached.
 * - App navigations use network-first so deployed updates are picked up.
 * - Static app assets use cache-first with background refresh.
 */

const CACHE_PREFIX = "notypad-personal-encrypted-vault-";
const CACHE_NAME = `${CACHE_PREFIX}v6`;
const LEGACY_NOTYPAD_CACHE_NAMES = new Set(["notypad-pwa-cache-v5"]);

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

// Only public, static third-party resources are eligible for runtime caching.
// Authentication, Firestore, and other API endpoints are deliberately excluded.
function isAllowedStaticCrossOrigin(url) {
  if (url.hostname === "cdn.tailwindcss.com") return true;
  if (url.hostname === "fonts.googleapis.com") return true;
  if (url.hostname === "fonts.gstatic.com") return true;
  return url.hostname === "www.gstatic.com" &&
    url.pathname.startsWith("/firebasejs/11.0.1/");
}

function isFirebaseOrSensitiveEndpoint(url) {
  const host = url.hostname.toLowerCase();
  // Except for the explicitly allowlisted Fonts CSS host, never cache Google API traffic.
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

function isCacheableResponse(response) {
  return !!response && (response.ok || response.type === "opaque");
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const scopeUrl = self.registration.scope;

    // Cache each file independently so one missing optional asset cannot abort install.
    for (const asset of APP_SHELL_ASSETS) {
      const url = new URL(asset, scopeUrl);
      try {
        const request = new Request(url.href, { cache: "reload" });
        const response = await fetch(request);
        if (response.ok) {
          await cache.put(request, response.clone());
        } else {
          console.warn("[NotyPad SW] App-shell asset unavailable:", url.pathname, response.status);
        }
      } catch (error) {
        console.warn("[NotyPad SW] Could not precache:", url.pathname, error);
      }
    }

    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();

    // Delete only older caches with this app's unique prefix.
    // Never touch caches belonging to other apps on the shared GitHub Pages origin.
    await Promise.all(
      keys
        .filter((key) => (key.startsWith(CACHE_PREFIX) || LEGACY_NOTYPAD_CACHE_NAMES.has(key)) && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    );

    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const scopeUrl = new URL(self.registration.scope);
  const sameOrigin = url.origin === scopeUrl.origin;
  const inAppScope = sameOrigin && url.pathname.startsWith(scopeUrl.pathname);

  // Never intercept Firebase/Auth/Firestore or other sensitive API traffic.
  if (isFirebaseOrSensitiveEndpoint(url)) return;

  if (!sameOrigin) {
    if (!isAllowedStaticCrossOrigin(url)) return;

    // Cache only allowlisted static libraries, fonts and stylesheets.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      const networkPromise = fetch(request).then(async (response) => {
        if (isCacheableResponse(response)) await cache.put(request, response.clone());
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
    })());
    return;
  }

  // Do not intercept other projects or apps on the same origin.
  if (!inAppScope) return;

  if (request.mode === "navigate" || url.pathname.endsWith("/index.html")) {
    // Network-first for HTML so deployments are not hidden behind stale index files.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          await cache.put(request, response.clone());
          await cache.put(new URL("index.html", scopeUrl).href, response.clone());
        }
        return response;
      } catch (_) {
        const cached = await cache.match(request) ||
          await cache.match(new URL("index.html", scopeUrl).href) ||
          await cache.match(new URL("./", scopeUrl).href);
        return cached || Response.error();
      }
    })());
    return;
  }

  // Cache-first for app static files, with background revalidation.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    const networkPromise = fetch(request).then(async (response) => {
      if (response && response.ok) await cache.put(request, response.clone());
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
  })());
});
