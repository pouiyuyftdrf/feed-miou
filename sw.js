// Feed Miou service worker: the page itself is fetched network-first so updates arrive at once,
// static files are cache-first, and Supabase requests always go to the network.
const CACHE = "feedmiou-v1";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co")) return;
  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin && (req.mode === "navigate" || url.pathname.endsWith(".html"))) {
    e.respondWith(fetch(req)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })
      .catch(() => caches.match(req)
        .then((r) => r || caches.match("./"))
        .then((r) => r || caches.match("index.html"))));
    return;
  }
  if (sameOrigin || /fonts\.(googleapis|gstatic)\.com$|cdn\.jsdelivr\.net$/.test(url.hostname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
  }
});

// Push: the server only relays a text sealed on a phone with the coloc key. The page leaves that key
// (and who uses this phone) in IndexedDB; without it, a plain fallback text is shown.
function kv(k) {
  return new Promise((res) => {
    const r = indexedDB.open("feedmiou", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onerror = () => res(null);
    r.onsuccess = () => {
      const db = r.result, q = db.transaction("kv").objectStore("kv").get(k);
      q.onsuccess = () => { db.close(); res(q.result || null); };
      q.onerror = () => { db.close(); res(null); };
    };
  });
}

async function openPush(p) {
  const s = await kv("push");
  const all = Uint8Array.from(atob(p.e), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.subarray(0, 12), additionalData: new TextEncoder().encode("push/" + p.id) }, s.key, all.subarray(12));
  const m = JSON.parse(new TextDecoder().decode(pt));
  const who = m.garde && m.garde === s.me ? m.whoMe : m.who;
  return { title: m.title, body: [p.left < p.total && m.part ? m.part : m.body, who].filter(Boolean).join(" "), tag: m.tag };
}

self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    let p = {}, n = null;
    try { p = e.data ? e.data.json() : {}; n = await openPush(p); } catch (err) {}
    if (!n) n = { title: "Feed Miou", body: p.kind === "late" ? "Un repas est en retard." : "Un repas vient d'être donné." };
    // same tag for a meal's "late" and "fed" notifications, so the second replaces the first
    await self.registration.showNotification(n.title, { body: n.body, tag: n.tag, renotify: !!n.tag, icon: "icons/icon-192.png", lang: "fr" });
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.startsWith(self.registration.scope));
    return open ? open.focus() : self.clients.openWindow(self.registration.scope);
  }));
});
