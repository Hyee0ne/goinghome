/** 앱웹(PWA) 서비스 워커 등록. 배포 빌드에서만 (개발 중에는 캐시가 고친 코드를 가리지 않게) */
export function registerPwa() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  const base = import.meta.env.BASE_URL
  navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {
    /* 등록이 안 돼도 앱은 그대로 동작한다 */
  })
}
