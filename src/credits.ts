/**
 * AI로 만들기 횟수 (2026-10-05 사용자 결정): 하루 1번, 매번 광고를 끝까지 봐야 한다. 공유 보상은 없다 ('신기하면 공유한다').
 * 기기(localStorage)에만 둔다. 서버가 생기면 서버에서 세는 게 맞다 (지금은 가안).
 */

const KEY = 'sonkkeut.aiDaily.v1'
const BASE_PER_DAY = 1

interface Store {
  /** 기준 날짜 (YYYY-MM-DD). 날이 바뀌면 처음부터 */
  day: string
  used: number
}

const today = () => new Date().toLocaleDateString('sv-SE')

function load(): Store {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Store | null
    if (s && s.day === today()) return s
  } catch {
    /* 아래에서 새로 */
  }
  return { day: today(), used: 0 }
}
function save(s: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* 저장이 안 되면 횟수도 안 남는다 */
  }
}

export const aiCredits = {
  /** 오늘 남은 AI 만들기 횟수 */
  get remaining() {
    return Math.max(0, BASE_PER_DAY - load().used)
  },
  /** 한 번 쓴다 (광고를 다 본 뒤) */
  use() {
    const s = load()
    if (s.used >= BASE_PER_DAY) return false
    s.used += 1
    save(s)
    return true
  },
}
