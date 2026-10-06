/**
 * 공고 중인 유기동물을 받아 앱용 데이터 파일(public/data/animals.json)로 만든다.
 *
 *   npm run data:animals        (.env.local 또는 환경 변수의 DATA_GO_KR_SERVICE_KEY)
 *
 * 출처: 공공데이터포털 '농림축산식품부 농림축산검역본부_국가동물보호정보시스템 구조동물 조회 서비스' (이용허락범위 제한 없음)
 * 키는 브라우저에 드러나지 않게 여기(빌드할 때)에서만 쓴다. 배포 워크플로가 1시간마다 다시 돌린다.
 * 키가 없으면 빈 목록을 쓰고 끝낸다 (빌드가 멈추지 않게).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const OUT = join(import.meta.dirname, '..', 'public', 'data', 'animals.json')
const CANDIDATES = join(import.meta.dirname, '..', 'public', 'data', 'candidates.json')
/** 실사화한 공고 아이들 (기술 쪽 shelter:make가 shelter-data 브랜치에 쓰고, 배포 때 public/shelter/로 받는다) */
const SHELTER_MANIFEST = join(import.meta.dirname, '..', 'public', 'shelter', 'manifest.json')
/** 앱이 읽는 작은 파일: 실사화한 아이 중 아직 공고 중인 아이 + 프로필 */
const SHELTER_LIVE = join(import.meta.dirname, '..', 'public', 'data', 'shelter-live.json')
/**
 * 실사화 후보 수. 사진 판정 통과율이 10~20%라 공개 목표(최대 20마리)보다 넉넉히 뽑는다 (2026-10-03).
 * 판정은 무료(Apple Vision)라 후보가 늘어도 비용은 없고 시간만 는다
 */
const CANDIDATES_PER_SPECIES = { dog: 100, cat: 50 } as const
/**
 * 후보는 공고 남은 기간이 이 범위인 아이만 (2026-10-06 사용자 결정: 주 1회 갱신이라 이번 주에 마감되는 아이를 살리는 데 집중).
 * 급한 아이(남은 기간이 짧은 아이)부터 고른다. 생성형으로 정면을 새로 그리니 사진 구도보다 급한 정도가 먼저다
 */
const WINDOW = { min: 3, max: 7 }
/** 고양이도 같은 범위만 (늘리지 않는다) */
const CAT_MAX_STEPS = [7]
/** 한 시도에서 고르는 최대 비율 (지역을 고르게): 후보 수의 15% */
const PER_SIDO_RATIO = 0.15
const API = 'https://apis.data.go.kr/1543061/abandonmentPublicService_v2/abandonmentPublic_v2'
const PAGE = 1000

function serviceKey() {
  if (process.env.DATA_GO_KR_SERVICE_KEY) return process.env.DATA_GO_KR_SERVICE_KEY.trim()
  const env = join(import.meta.dirname, '..', '.env.local')
  if (!existsSync(env)) return ''
  const line = readFileSync(env, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('DATA_GO_KR_SERVICE_KEY='))
  return line ? line.slice(line.indexOf('=') + 1).trim() : ''
}

/** 앱이 쓰는 모양 (용량을 줄이려고 짧은 이름) */
export interface Animal {
  id: string
  sp: 'dog' | 'cat' | 'etc'
  kind: string
  age: string
  sex: 'M' | 'F' | 'Q'
  neuter: 'Y' | 'N' | 'U'
  color: string
  weight: string
  /** 특징 · 사회성 · 건강 · 특이사항을 이어 붙인 것 */
  note: string
  photos: string[]
  care: { name: string; tel: string; addr: string }
  org: string
  /** 시도 (지역 거르기용) */
  sido: string
  noticeNo: string
  /** 공고 종료일 YYYYMMDD */
  end: string
}

type Raw = Record<string, string | undefined>

/** '2026(60일미만)(년생)' → '60일 미만', '2022(년생)' → '2022년생' */
function ageText(raw: string) {
  const inner = raw.match(/^\d{4}\(([^)]*?)\)\(년생\)$/)
  if (inner && inner[1] !== '년생') return inner[1].replace('미만', ' 미만')
  return raw.replace('(년생)', '년생')
}

const https = (u?: string) => (u ? u.replace(/^http:\/\//, 'https://') : '')

function toAnimal(r: Raw): Animal {
  const photos = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => https(r[`popfile${i}`])).filter(Boolean)
  const note = [r.specialMark, r.sfeSoci, r.sfeHealth, r.etcBigo]
    .map((s) => (s ?? '').trim())
    .filter((s, i, a) => s && a.indexOf(s) === i)
    .join(' · ')
  return {
    id: r.desertionNo ?? '',
    sp: r.upKindCd === '417000' ? 'dog' : r.upKindCd === '422400' ? 'cat' : 'etc',
    kind: r.kindNm ?? '',
    age: ageText(r.age ?? ''),
    sex: (r.sexCd as Animal['sex']) ?? 'Q',
    neuter: (r.neuterYn as Animal['neuter']) ?? 'U',
    color: r.colorCd ?? '',
    weight: (r.weight ?? '').replace('(Kg)', 'kg'),
    note,
    photos,
    care: { name: r.careNm ?? '', tel: r.careTel ?? '', addr: r.careAddr ?? '' },
    org: r.orgNm ?? '',
    sido: (r.orgNm ?? '').split(' ')[0],
    noticeNo: r.noticeNo ?? '',
    end: r.noticeEdt ?? '',
  }
}

// ───────────────────────── 실사화 후보 점수 (2단계) ─────────────────────────
// 1단계(사진 품질)는 사진을 봐야 해서 기술 쪽 판정에 맡기고, 여기서는 공공데이터만으로 우선순위를 매긴다.

export interface Candidate {
  id: string
  score: number
  reasons: string[]
}

const THIS_YEAR = new Date().getFullYear()

/** 나이(살). '60일 미만'·올해생은 0 */
function years(a: Animal) {
  const y = Number(a.age.slice(0, 4))
  return Number.isFinite(y) && /^\d{4}/.test(a.age) ? THIS_YEAR - y : 0
}
const kg = (a: Animal) => Number.parseFloat(a.weight) || 0
function daysLeft(a: Animal) {
  if (!/^\d{8}$/.test(a.end)) return -1
  const end = Date.UTC(+a.end.slice(0, 4), +a.end.slice(4, 6) - 1, +a.end.slice(6, 8))
  const now = new Date()
  return Math.round((end - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000)
}
/** 교감 이야기가 되는 성격 낱말 */
const WARM = /사람|온순|순함|순해|애교|친화|얌전|착함|착해|좋아|활발|다정|순둥/

function score(a: Animal): Candidate | null {
  const y = years(a)
  const left = daysLeft(a)
  // 성견·성묘만, 공고가 만드는 동안 남아 있게 3일 이상
  if (a.sp === 'etc' || y < 1 || left < 3) return null
  return a.sp === 'dog' ? dogScore(a, y, left) : catScore(a, y, left)
}

/** 남은 기간은 점수 대신 범위(WINDOW)로 거른다. 이유에만 적는다 */
function addDday(add: (n: number, why: string) => void, left: number) {
  add(0, `공고 D-${left}`)
}

function dogScore(a: Animal, y: number, left: number): Candidate {
  const reasons: string[] = []
  let s = 0
  const add = (n: number, why: string) => {
    s += n
    reasons.push(why)
  }
  if (y >= 7) add(3, `${y}살 노견`)
  else if (y >= 3) add(1, `${y}살`)
  if (kg(a) >= 25) add(3, `${kg(a)}kg 대형견`)
  else if (kg(a) >= 15) add(2, `${kg(a)}kg 중형견`)
  if (a.kind.includes('믹스')) add(1, '믹스견')
  if (a.note.length >= 20 && WARM.test(a.note)) add(1, '성격 이야기')
  if (a.photos.length >= 3) add(1, `사진 ${a.photos.length}장`)
  addDday(add, left)
  return { id: a.id, score: s, reasons }
}

/**
 * 고양이: 보호소 고양이는 대부분 새끼라 성묘 자체가 드물다(2026-10 기준 746마리 중 110마리).
 * 몸무게는 입양 어려움과 상관이 적어 빼고, 3살 이상에 더 무게를 둔다. 한국 고양이·믹스묘는 믹스견처럼 +1
 */
function catScore(a: Animal, y: number, left: number): Candidate {
  const reasons: string[] = []
  let s = 0
  const add = (n: number, why: string) => {
    s += n
    reasons.push(why)
  }
  if (y >= 7) add(3, `${y}살 노묘`)
  else if (y >= 3) add(2, `${y}살`)
  if (/한국 고양이|믹스/.test(a.kind)) add(1, a.kind)
  if (a.note.length >= 20 && WARM.test(a.note)) add(1, '성격 이야기')
  if (a.photos.length >= 3) add(1, `사진 ${a.photos.length}장`)
  addDday(add, left)
  return { id: a.id, score: s, reasons }
}

/**
 * 남은 기간이 min~max일인 아이를 급한 순으로 고르되 (같으면 점수순) 한 시도에서 count의 PER_SIDO_RATIO까지 (개·고양이 따로)
 */
function pickCandidates(animals: Animal[], count: number, max = WINDOW.max) {
  const perSido = Math.max(2, Math.ceil(count * PER_SIDO_RATIO))
  const bySido = new Map<string, number>()
  const byId = new Map(animals.map((a) => [a.id, a]))
  return animals
    .filter((a) => daysLeft(a) >= WINDOW.min && daysLeft(a) <= max)
    .map(score)
    .filter((c): c is Candidate => !!c)
    .sort((a, b) => daysLeft(byId.get(a.id)!) - daysLeft(byId.get(b.id)!) || b.score - a.score)
    .filter((c) => {
      const sido = byId.get(c.id)!.sido
      const n = bySido.get(sido) ?? 0
      if (n >= perSido) return false
      bySido.set(sido, n + 1)
      return true
    })
    .slice(0, count)
}

// ───────────────────────── 실사화한 공고 아이 → 앱용 ─────────────────────────

/** 실사화한 아이 중 아직 공고 중인 아이만 프로필을 붙여 쓴다. 공고가 끝나면 여기서 빠져 앱에서도 사라진다 */
function writeShelterLive(animals: Animal[]) {
  let pets: { id: string; sp: string; rig: unknown; photo?: string }[] = []
  try {
    if (existsSync(SHELTER_MANIFEST)) pets = JSON.parse(readFileSync(SHELTER_MANIFEST, 'utf8')).pets ?? []
  } catch (e) {
    console.warn('shelter/manifest.json을 읽지 못했어요', e)
  }
  const byId = new Map(animals.map((a) => [a.id, a]))
  const live = pets.flatMap((p) => {
    const a = byId.get(p.id)
    return a ? [{ ...p, profile: a }] : []
  })
  writeFileSync(SHELTER_LIVE, JSON.stringify({ updated: new Date().toISOString(), pets: live }))
  if (pets.length) console.log(`실사화한 공고 아이 ${pets.length}마리 중 공고 중 ${live.length}마리`)
}

async function page(key: string, no: number) {
  const q = new URLSearchParams({ serviceKey: key, _type: 'json', state: 'notice', numOfRows: String(PAGE), pageNo: String(no) })
  const res = await fetch(`${API}?${q}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()).response?.body
  const items = body?.items?.item ?? []
  return { total: Number(body?.totalCount ?? 0), items: (Array.isArray(items) ? items : [items]) as Raw[] }
}

async function main() {
  mkdirSync(dirname(OUT), { recursive: true })
  const key = serviceKey()
  if (!key) {
    console.warn('DATA_GO_KR_SERVICE_KEY가 없어요')
    return fallback()
  }
  const first = await page(key, 1)
  const raws = [...first.items]
  for (let no = 2; (no - 1) * PAGE < first.total; no++) raws.push(...(await page(key, no)).items)
  const animals = raws
    .map(toAnimal)
    .filter((a) => a.id && a.photos.length)
    // 공고가 곧 끝나는 아이부터
    .sort((a, b) => a.end.localeCompare(b.end))
  if (!animals.length) throw new Error('받은 공고가 0마리예요')
  const updated = new Date().toISOString()
  writeFileSync(OUT, JSON.stringify({ updated, animals }))
  writeShelterLive(animals)
  const dogs = pickCandidates(animals.filter((a) => a.sp === 'dog'), CANDIDATES_PER_SPECIES.dog)
  const allCats = animals.filter((a) => a.sp === 'cat')
  let catMax = CAT_MAX_STEPS[0]
  let cats = pickCandidates(allCats, CANDIDATES_PER_SPECIES.cat, catMax)
  for (const m of CAT_MAX_STEPS.slice(1)) {
    if (cats.length >= CANDIDATES_PER_SPECIES.cat) break
    catMax = m
    cats = pickCandidates(allCats, CANDIDATES_PER_SPECIES.cat, catMax)
  }
  writeFileSync(CANDIDATES, JSON.stringify({ updated, window: { dog: [WINDOW.min, WINDOW.max], cat: [WINDOW.min, catMax] }, dogs, cats }, null, 1))
  console.log(`실사화 후보: 강아지 ${dogs.length}마리 (남은 ${WINDOW.min}~${WINDOW.max}일), 고양이 ${cats.length}마리 (남은 ${WINDOW.min}~${catMax}일)`)
  console.log(`공고 중 ${first.total}마리 → 사진 있는 ${animals.length}마리를 ${OUT}에 썼어요`)
}

/**
 * 받아 오지 못했을 때: 지금 배포된 사이트의 목록(ANIMALS_FALLBACK_URL)을 그대로 쓴다.
 * 매시간 배포라, 한 번 실패했다고 다음 정시까지 공고가 사라지면 안 된다. 그것도 안 되면 빈 목록
 */
async function fallback() {
  const url = process.env.ANIMALS_FALLBACK_URL
  if (url) {
    try {
      const res = await fetch(url)
      const d = res.ok ? await res.json() : null
      if (d?.animals?.length) {
        writeFileSync(OUT, JSON.stringify(d))
        writeShelterLive(d.animals)
        console.warn(`배포된 목록(${d.animals.length}마리, ${d.updated} 기준)을 그대로 씁니다`)
        return
      }
    } catch {
      /* 아래에서 빈 목록 */
    }
  }
  if (!existsSync(OUT)) writeFileSync(OUT, JSON.stringify({ updated: null, animals: [] }))
  writeShelterLive(JSON.parse(readFileSync(OUT, 'utf8')).animals ?? [])
}

main().catch(async (e) => {
  // 받아 오지 못해도 빌드는 계속한다
  console.error('유기동물 데이터를 받지 못했어요:', e instanceof Error ? e.message : e)
  await fallback()
})
