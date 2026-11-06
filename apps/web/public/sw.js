/* ZenithCore FMIS service worker: keeps the application shell available when
   the connection drops. API calls are never cached (always fresh, or they fail
   and the page queues the work). */
const SHELL = "zc-shell-v4";
const FILES = ["./", "index.html", "app.js", "styles.css", "logo.png", "logo-mark.png", "favicon-32.png",
  "IBMPlexSansArabic-Regular.woff2", "IBMPlexSansArabic-Medium.woff2", "IBMPlexSansArabic-SemiBold.woff2", "IBMPlexSansArabic-Bold.woff2",
  "ReadexPro-SemiBold.woff", "ReadexPro-Bold.woff"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // network first so a new release is picked up at once; the cache answers when offline
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match("index.html")))
  );
});
