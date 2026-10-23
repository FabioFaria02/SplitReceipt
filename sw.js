// Service worker: app instalável, funciona offline para consultar divisões
// e recebe recibos partilhados a partir da galeria (Android).
const VERSION = "v6";
const CACHE = `splitreceipt-${VERSION}`;
const SHARE_CACHE = "splitreceipt-share";
const SHELL = [
  "./", "index.html", "css/styles.css", "js/app.js", "js/calc.js", "js/ai.js", "js/rates.js", "js/storage.js", "js/share.js",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "manifest.webmanifest",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith("splitreceipt-") && k !== CACHE && k !== SHARE_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// A página pede para ativar a nova versão quando o utilizador aceita.
self.addEventListener("message", e => {
  if (e.data === "skipWaiting") self.skipWaiting();
});

async function handleShare(request) {
  const form = await request.formData();
  const files = form.getAll("receipts").filter(f => f && typeof f === "object" && f.size);
  const cache = await caches.open(SHARE_CACHE);
  await Promise.all((await cache.keys()).map(k => cache.delete(k)));
  await Promise.all(files.map((f, i) => cache.put(
    new Request(`./__shared/${i}`),
    new Response(f, { headers: { "Content-Type": f.type || "application/octet-stream", "X-File-Name": encodeURIComponent(f.name || `recibo-${i}`) } })
  )));
  return Response.redirect(`./?shared=${files.length}`, 303);
}

self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);

  if (req.method === "POST" && url.pathname.endsWith("/share-target")) {
    e.respondWith(handleShare(req));
    return;
  }
  if (req.method !== "GET" || url.pathname.startsWith("/api/")) return;

  const sameOrigin = url.origin === location.origin;
  const cdn = /fonts\.(googleapis|gstatic)\.com|cdnjs\.cloudflare\.com/.test(url.host);
  if (!sameOrigin && !cdn) return;

  // CDN (fontes e ícones): cache primeiro. App: rede primeiro, para receber atualizações.
  if (cdn) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || (req.mode === "navigate" ? caches.match("index.html") : Response.error())))
  );
});
