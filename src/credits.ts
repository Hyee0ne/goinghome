/**
 * AI로 만들기 기회. 광고를 보거나, 공유하면 한 번 더 (공유 보상은 하루 1번까지: AI 한 번에 약 $0.5가 들어서).
 * 기기(localStorage)에만 둔다. 서버가 생기면 서버에서 세는 게 맞다 (지금은 가안).
 */

const KEY = 'sonkkeut.aiCredits.v1'
const SHARE_PER_DAY = 1

interface Store {
  credits: number
  /** 공유로 기회를 받은 날 (YYYY-MM-DD) */
  sharedOn?: string
}

function load(): Store {
  try {
    return { credits: 0, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  } catch {
    return { credits: 0 }
  }
}
function save(s: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* 저장이 안 되면 기회도 안 쌓인다 */
  }
}
const today = () => new Date().toLocaleDateString('sv-SE')

export const aiCredits = {
  get count() {
    return load().credits
  },
  /** 공유했으면 기회 +1 (하루 1번). 받았으면 true */
  rewardShare() {
    const s = load()
    if (s.sharedOn === today() && SHARE_PER_DAY <= 1) return false
    s.credits += 1
    s.sharedOn = today()
    save(s)
    return true
  },
  /** 기회를 하나 쓴다 */
  use() {
    const s = load()
    if (s.credits <= 0) return false
    s.credits -= 1
    save(s)
    return true
  },
}
