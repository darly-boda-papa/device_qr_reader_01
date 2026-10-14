// 오프라인 사용을 위한 서비스 워커
// - 앱 파일(html/css/js 등): 네트워크 우선 → 새 버전을 올리면 바로 반영, 오프라인이면 저장본 사용
// - 큰 라이브러리 파일: 저장본 우선 → 한 번 받으면 다시 받지 않음

const APP_CACHE = "qr-reader-app-v5";
const LIB_CACHE = "qr-reader-lib-v1"; // 라이브러리 파일을 바꿀 때만 숫자를 올림

const APP_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
];

const LIB_FILES = [
  "./zxing-full.js",
  "./zxing_full.wasm",
  "./tesseract.min.js",
  "./worker.min.js",
  "./tesseract-core-simd-lstm.wasm.js",
  "./eng.traineddata",
];
const LIB_NAMES = LIB_FILES.map((f) => f.slice(2));

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const app = await caches.open(APP_CACHE);
    await app.addAll(APP_FILES.map((u) => new Request(u, { cache: "reload" })));

    // 라이브러리는 아직 없는 것만 받음 (실패해도 설치는 계속)
    const lib = await caches.open(LIB_CACHE);
    for (const f of LIB_FILES) {
      if (!(await lib.match(f))) await lib.add(f).catch(() => {});
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = [APP_CACHE, LIB_CACHE];
    for (const key of await caches.keys()) {
      if (!keep.includes(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;

  const isLib = LIB_NAMES.some((name) => url.pathname.endsWith(`/${name}`));
  event.respondWith(isLib ? cacheFirst(req) : networkFirst(req));
});

async function cacheFirst(req) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(LIB_CACHE)).put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(APP_CACHE);
  try {
    const res = await withTimeout(fetch(req.url, { cache: "no-cache", credentials: "same-origin" }), 4000);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === "navigate") {
      const home = await caches.match(new URL("./", self.registration.scope).href);
      if (home) return home;
    }
    return Response.error();
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
