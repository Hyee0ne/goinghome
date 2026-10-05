/**
 * 고잉홈 앱웹(PWA) 서비스 워커.
 * - 큰 파일(손 인식 프로그램·모델, 아이 사진, 빌드된 코드)은 한 번 받으면 기기에 두고 다시 쓴다 (다시 열 때 빠르고 전송량이 준다)
 * - 화면(html)과 공고 데이터(data/*.json)는 늘 새로 받고, 인터넷이 안 될 때만 저장해 둔 것을 쓴다
 * - 다른 사이트(보호소 사진 등)는 건드리지 않는다
 */
const CACHE = 'goinghome-v1'
const CACHE_FIRST = /\/(mediapipe|models|pets|shelter|gallery|icons|assets)\//

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (CACHE_FIRST.test(url.pathname)) {
    e.respondWith(
      caches.open(CACHE).then(async (c) => {
        const hit = await c.match(req)
        if (hit) return hit
        const res = await fetch(req)
        if (res.ok) c.put(req, res.clone())
        return res
      }),
    )
    return
  }
  // 화면·데이터: 새로 받고, 안 되면 저장해 둔 것
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()))
        return res
      })
      .catch(() => caches.match(req).then((hit) => hit ?? Response.error())),
  )
})
