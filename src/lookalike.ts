/**
 * 우리 아이를 닮은 보호소 아이 찾기.
 * 우리 아이는 배경을 지운 사진의 털색(가운데 몸 부분 평균)을, 보호소 아이는 공고의 색상 글('갈색', '흰색/검은색' 등)을
 * 대표 색으로 바꿔 가장 가까운 아이를 고른다. 같은 종만, 쓰다듬을 수 있는 아이(실사화한 아이)를 조금 앞에 둔다.
 */

export type RGB = [number, number, number]

/** 배경을 지운 사진에서 털색: 불투명한 픽셀의 평균 (눈·코처럼 아주 어두운 점과 하이라이트는 뺀다) */
export function furColor(cutout: HTMLCanvasElement): RGB | null {
  const size = 64
  const c = Object.assign(document.createElement('canvas'), { width: size, height: size })
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(cutout, 0, 0, size, size)
  const d = g.getImageData(0, 0, size, size).data
  let r = 0
  let gg = 0
  let b = 0
  let n = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue
    const lum = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11
    if (lum < 18 || lum > 250) continue
    r += d[i]
    gg += d[i + 1]
    b += d[i + 2]
    n++
  }
  return n ? [r / n, gg / n, b / n] : null
}

/** 공고 색상 글 → 대표 색들 (여러 색이면 여러 개). 모르는 말은 빈 배열 */
const WORDS: [RegExp, RGB][] = [
  [/흰|백|화이트|하양|아이보리/, [235, 230, 222]],
  [/검|흑|블랙|까망/, [35, 32, 30]],
  [/진갈|다크브라운|초코|밤색/, [90, 60, 40]],
  [/갈|브라운|황갈/, [150, 105, 65]],
  [/연갈|베이지|크림|레몬|누렁|황|노랑|살구|탄/, [205, 170, 120]],
  [/회|그레이|은|실버|블루/, [150, 148, 145]],
  [/치즈|주황|오렌지|빨강|레드/, [215, 145, 75]],
]

export function textColors(text: string): RGB[] {
  return WORDS.filter(([re]) => re.test(text)).map(([, c]) => c)
}

/** 사람 눈에 가까운 색 거리 (간단한 가중 RGB) */
function dist(a: RGB, b: RGB) {
  const rm = (a[0] + b[0]) / 2
  const dr = a[0] - b[0]
  const dg = a[1] - b[1]
  const db = a[2] - b[2]
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db)
}

export interface MatchAnimal {
  id: string
  sp: 'dog' | 'cat' | 'etc'
  color: string
  end: string
}

/** 공고 마감(YYYYMMDD)까지 남은 날 (오늘 마감이면 0, 지났으면 음수) */
export function daysLeft(end: string, now = new Date()) {
  if (!/^\d{8}$/.test(end)) return Infinity
  const d = new Date(Number(end.slice(0, 4)), Number(end.slice(4, 6)) - 1, Number(end.slice(6, 8)))
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((d.getTime() - today.getTime()) / 86_400_000)
}

/**
 * 닮은 아이 n마리. 색이 가까운 순인데, 이번 주에 공고가 끝나는 아이(남은 7일 이내)를 앞에 둔다
 * (2026-10-06: 급한 아이를 살리는 데 집중). 같으면 공고가 곧 끝나는 아이 먼저. 마감이 지난 아이는 뺀다.
 * 색을 모르면 급한 아이와 마감 순으로 고른다
 */
export function findLookalikes<T extends MatchAnimal>(all: T[], species: 'dog' | 'cat', color: RGB | null, n: number) {
  return all
    .filter((a) => a.sp === species && daysLeft(a.end) >= 0)
    .map((a) => {
      const cs = textColors(a.color)
      const d = color && cs.length ? Math.min(...cs.map((c) => dist(color, c))) : 400
      // 같은 색 계열이면 급한 아이를 앞에 (색 거리 60만큼 이득)
      return { a, score: d - (daysLeft(a.end) <= 7 ? 60 : 0) }
    })
    .sort((x, y) => x.score - y.score || x.a.end.localeCompare(y.a.end))
    .slice(0, n)
    .map((x) => x.a)
}
