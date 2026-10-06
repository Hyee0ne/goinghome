/**
 * 공유 루프 집계 (2026-10-06, 마케팅 docs/VIRAL-STRATEGY.md): 쿠키 없는 GoatCounter로 단계별 숫자만 센다.
 *
 *   make_result      우리 아이 결과가 나옴
 *   share_click      공유 버튼을 누름 (src: pet / site / mine)
 *   share_done       공유를 마침 (취소 제외)
 *   land_from_share  공유 링크(?from=share)로 들어옴 (gen 포함)
 *   first_pet        링크로 들어온 사람이 처음 쓰다듬음
 *   invite_click     '우리 아이 만들기'를 누름
 *   adopt_action     공고 보기·보호소 전화를 누름
 *
 * 개인 정보·사진 정보는 넣지 않는다. 공유 링크에는 익명 파라미터 두 개만 붙인다:
 *   gen  공유 세대 (처음 공유 1, 받은 링크로 들어와 다시 공유하면 받은 gen + 1)
 *   src  보낸 경로 (pet / site / mine)
 * 광고 유입 (2026-10-06): 광고 링크는 ?src=ad_yt(유튜브 쇼츠) / ad_dg(당근) / ad_x(X). 들어오면 land_from_ad를 세고,
 * 그 탭 안에서는 채널을 기억해 이후 모든 이벤트 제목에 ch=ad_…를 붙인다 (sessionStorage, 쿠키·개인 정보 없음).
 * 광고 시안은 cr=a|b (A: 우리 아이 만들기 → make.html, B: 보호소 아이 → /). ch처럼 기억해 이후 이벤트에 cr=…를 붙인다.
 * 그 사람이 다시 공유한 링크는 평소처럼 gen+1, src=pet/site/mine이다 (cr은 붙이지 않는다).
 * 매 프레임 루프에서는 부르지 않는다 (이벤트 때만, 렉 없는 것이 먼저).
 * K = 공유율 × 받은 사람 전환율 → share_done / make_result 와 (invite_click 또는 share_click) / land_from_share 로 본다.
 */
import { GOATCOUNTER_CODE } from './site'

type GoatCounter = { count: (v: { path: string; title?: string; event?: boolean }) => void }
const GEN_KEY = 'goinghome.gen'
const CHANNEL_KEY = 'goinghome.ch'
const CREATIVE_KEY = 'goinghome.cr'

let loading: Promise<GoatCounter | null> | null = null
function counter(): Promise<GoatCounter | null> {
  if (!GOATCOUNTER_CODE) return Promise.resolve(null)
  loading ??= new Promise((resolve) => {
    const s = Object.assign(document.createElement('script'), { async: true, src: 'https://gc.zgo.at/count.js' })
    s.dataset.goatcounter = `https://${GOATCOUNTER_CODE}.goatcounter.com/count`
    s.onload = () => resolve((window as unknown as { goatcounter?: GoatCounter }).goatcounter ?? null)
    s.onerror = () => resolve(null)
    document.head.append(s)
  })
  return loading
}

/** 이벤트 하나 보내기 (실패해도 조용히 넘어간다) */
export function track(name: string, info: Record<string, string | number | undefined> = {}) {
  const title = Object.entries({ ...info, ch: adChannel(), cr: adCreative() })
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  counter()
    .then((gc) => gc?.count({ path: name, title: title || name, event: true }))
    .catch(() => {})
}

/** 이 사람이 받은 공유 세대 (링크로 안 들어왔으면 0). 같은 탭 안 다른 화면(만들기)으로 가도 이어지게 기억한다 */
export function landedGen(): number {
  const q = Number(new URLSearchParams(location.search).get('gen'))
  if (q > 0) {
    try {
      sessionStorage.setItem(GEN_KEY, String(q))
    } catch {
      /* 저장이 막혀도 이번 화면에서는 쓴다 */
    }
    return q
  }
  try {
    return Number(sessionStorage.getItem(GEN_KEY)) || 0
  } catch {
    return 0
  }
}

/** 주소의 파라미터가 맞는 꼴이면 이 탭 동안 기억하고, 없으면 기억해 둔 값 */
function remembered(param: string, key: string, ok: RegExp): string | undefined {
  const q = new URLSearchParams(location.search).get(param) ?? ''
  if (ok.test(q)) {
    try {
      sessionStorage.setItem(key, q)
    } catch {
      /* 저장이 막혀도 이번 화면에서는 쓴다 */
    }
    return q
  }
  try {
    return sessionStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

/** 광고로 들어온 탭이면 그 채널 (ad_yt / ad_dg / ad_x), 아니면 undefined */
export function adChannel(): string | undefined {
  return remembered('src', CHANNEL_KEY, /^ad_[a-z]+$/)
}

/** 광고 시안 (a / b). 광고로 들어온 탭에서만 */
function adCreative(): string | undefined {
  return adChannel() ? remembered('cr', CREATIVE_KEY, /^[ab]$/) : undefined
}

/** 공유 링크에 붙일 파라미터 */
export function shareParams(src: 'pet' | 'site' | 'mine') {
  return { gen: String(landedGen() + 1), src }
}

// 페이지 방문 수도 세도록 한가할 때 집계 스크립트를 불러 둔다 (화면 그리기를 막지 않게)
if (GOATCOUNTER_CODE) (window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1500)))(() => void counter())

// 처음 불러올 때: 공유 링크로 들어왔으면 한 번 센다
const q = new URLSearchParams(location.search)
if (q.get('from') === 'share') track('land_from_share', { gen: landedGen(), src: q.get('src') ?? undefined })
// 광고 도착 (메인 / 와 make.html 모두 이 모듈을 불러서 둘 다 센다)
else if (/^ad_[a-z]+$/.test(q.get('src') ?? '')) track('land_from_ad', { src: q.get('src')!, page: location.pathname.endsWith('make.html') ? 'make' : 'home' })
