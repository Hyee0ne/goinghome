import './style.css'
import { landedGen, track } from './analytics'
import { registerPwa } from './pwa'
import './form.css'
import './adopt.css'
import './match.css'
import { openAdoptDetail, type AdoptAnimal } from './adoptDetail'

/**
 * 나랑 맞는 아이: 내 생활(사는 곳·집에 있는 시간·생활 리듬·반려 경험·지역)을 묻고,
 * 공고 아이들(public/data/animals.json)의 종류·나이·몸무게·특징 메모·지역과 견줘 잘 맞는 아이를 보여 준다.
 * 성격은 보호소가 적은 특징 메모의 낱말(순함·활발·겁 많음 …)로만 짐작한다 (메모가 없으면 나이·크기로).
 * 모든 계산은 기기 안에서, 답은 저장하지 않는다.
 */

interface Animal extends AdoptAnimal {
  sp: 'dog' | 'cat' | 'etc'
  sido?: string
}

type Answers = {
  sp?: 'dog' | 'cat' | 'any'
  home?: 'apt' | 'house'
  time?: 'low' | 'mid' | 'high'
  pace?: 'calm' | 'active'
  exp?: 'new' | 'yes'
  sido?: string
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

interface Question {
  key: keyof Answers
  q: string
  hint?: string
  options: { v: string; label: string; sub?: string; icon: string }[]
}

const SIDOS = ['서울특별시', '경기도', '인천광역시', '강원특별자치도', '충청북도', '충청남도', '대전광역시', '세종특별자치시', '전북특별자치도', '전라남도', '광주광역시', '경상북도', '대구광역시', '경상남도', '부산광역시', '울산광역시', '제주특별자치도']
const SHORT: Record<string, string> = { 서울특별시: '서울', 경기도: '경기', 인천광역시: '인천', 강원특별자치도: '강원', 강원도: '강원', 충청북도: '충북', 충청남도: '충남', 대전광역시: '대전', 세종특별자치시: '세종', 전북특별자치도: '전북', 전라북도: '전북', 전라남도: '전남', 광주광역시: '광주', 경상북도: '경북', 대구광역시: '대구', 경상남도: '경남', 부산광역시: '부산', 울산광역시: '울산', 제주특별자치도: '제주' }

const QUESTIONS: Question[] = [
  {
    key: 'sp',
    q: '어떤 아이와 살고 싶어요?',
    options: [
      { v: 'dog', label: '강아지', icon: '🐶' },
      { v: 'cat', label: '고양이', icon: '🐱' },
      { v: 'any', label: '상관없어요', icon: '💛' },
    ],
  },
  {
    key: 'home',
    q: '어디에 살아요?',
    options: [
      { v: 'apt', label: '아파트 · 빌라 · 원룸', sub: '이웃과 벽을 함께 써요', icon: '🏢' },
      { v: 'house', label: '마당 있는 집', sub: '뛰어놀 자리가 있어요', icon: '🏡' },
    ],
  },
  {
    key: 'time',
    q: '하루에 집에 있는 시간은요?',
    options: [
      { v: 'low', label: '거의 없어요', sub: '출근·등교로 낮에는 비어요', icon: '🌙' },
      { v: 'mid', label: '반반이에요', icon: '⛅' },
      { v: 'high', label: '많아요', sub: '재택이거나 집에 자주 있어요', icon: '☀️' },
    ],
  },
  {
    key: 'pace',
    q: '내 생활은 어떤 편이에요?',
    options: [
      { v: 'calm', label: '조용히 쉬는 편', sub: '집에서 느긋하게', icon: '🛋️' },
      { v: 'active', label: '밖에서 움직이는 편', sub: '산책·운동을 좋아해요', icon: '🏃' },
    ],
  },
  {
    key: 'exp',
    q: '반려동물을 키워 봤어요?',
    options: [
      { v: 'new', label: '처음이에요', icon: '🌱' },
      { v: 'yes', label: '키워 봤어요', icon: '🐾' },
    ],
  },
  {
    key: 'sido',
    q: '어느 지역에 살아요?',
    hint: '가까운 보호소 아이를 먼저 보여 드려요',
    options: [{ v: '', label: '상관없어요', icon: '🗺️' }, ...SIDOS.map((s) => ({ v: s, label: SHORT[s], icon: '📍' }))],
  },
]

// ───────────────────────── 아이 특징 ─────────────────────────

/** 나이(년). 'yyyy년생'이 아니면 알 수 없음 */
function ageOf(a: Animal) {
  // '60일 미만'·'3개월' 같은 공고는 갓 태어난 아이
  if (/일|개월/.test(a.age) && !/\d{4}/.test(a.age)) return 0
  const m = a.age.match(/(\d{4})/)
  return m ? Math.max(0, new Date().getFullYear() - Number(m[1])) : null
}
function kgOf(a: Animal) {
  const m = a.weight?.match(/[\d.]+/)
  return m ? Number(m[0]) : null
}
const has = (note: string, re: RegExp) => re.test(note)
function traits(a: Animal) {
  const n = a.note ?? ''
  return {
    calm: has(n, /순함|온순|얌전|착함|순둥|차분|순한/),
    social: has(n, /사람.{0,4}(좋|잘 따|따름|친화)|친화|애교|사람을 잘/),
    active: has(n, /활발|에너지|명랑|발랄/),
    shy: has(n, /겁|경계|소심|예민|낯을/),
    bite: has(n, /입질|공격|사나/),
    care: has(n, /피부|다리|골절|질병|치료|안구|탈장|심장|기력|설사|기침|파행|종양/),
  }
}

/** 공고 마감까지 남은 날 */
function dday(end: string) {
  if (!/^\d{8}$/.test(end)) return null
  const d = new Date(+end.slice(0, 4), +end.slice(4, 6) - 1, +end.slice(6, 8))
  const t = new Date()
  t.setHours(0, 0, 0, 0)
  return Math.round((d.getTime() - t.getTime()) / 86400000)
}

/** 품종 이름: '페르시안-페르시안 친칠라' 같은 겹친 이름은 뒤쪽만 */
const kindName = (k: string) => (k.includes('-') ? k.split('-').pop()!.trim() : k)

/**
 * 궁합 점수와 맞는 이유. 맞는 점을 더하고 안 맞는 점을 뺀 합(대략 -60 ~ +60)을 50~98%로 옮긴다
 * (그냥 더하면 웬만한 아이가 다 99%가 되어 차이가 보이지 않았다). 이유는 더한 것 중 큰 순서로 세 개까지
 */
function score(a: Animal, ans: Answers) {
  let s = 0
  const why: [number, string][] = []
  const plus = (v: number, r: string) => {
    s += v
    if (v > 0) why.push([v, r])
  }
  const age = ageOf(a)
  const kg = kgOf(a)
  const t = traits(a)
  const dog = a.sp === 'dog'
  const young = age !== null && age < 1
  const senior = age !== null && age >= 8
  const small = kg !== null && kg < 7
  const large = kg !== null && kg >= 15

  if (ans.home === 'apt' && dog) {
    if (small) plus(12, `아파트에 맞는 ${kg}kg 작은 체구`)
    else if (large) plus(-25, '')
  }
  if (ans.home === 'apt' && !dog) plus(6, '집 안에서 잘 지내는 고양이')
  if (ans.home === 'house' && dog && !small) plus(8, '마당에서 뛰어놀기 좋은 체구')

  if (ans.time === 'low') {
    if (!dog) plus(10, '혼자 있는 시간에도 잘 지내는 고양이')
    if (dog && young) plus(-20, '')
    if (dog && t.calm && !young) plus(6, '차분해서 혼자 있는 시간도 잘 견뎌요')
  }
  if (ans.time === 'high') {
    if (young) plus(10, '곁에서 함께 클 어린 아이')
    if (t.social) plus(8, '사람을 좋아해 늘 곁에 있고 싶어 해요')
  }

  if (ans.pace === 'calm') {
    if (t.calm) plus(15, '조용한 생활과 잘 맞는 순한 성격')
    else if (senior) plus(10, '느긋한 어른 아이')
    if (t.active) plus(-10, '')
    if (dog && young) plus(-5, '')
  }
  if (ans.pace === 'active') {
    if (t.active) plus(15, '함께 신나게 움직일 활발한 성격')
    if (dog && age !== null && age >= 1 && age <= 6) plus(8, '산책 친구로 딱 좋은 나이')
    if (senior) plus(-5, '')
  }

  if (ans.exp === 'new') {
    if (t.calm || t.social) plus(10, '처음 키우는 사람도 함께하기 쉬워요')
    if (t.shy) plus(-10, '')
    if (t.bite) plus(-25, '')
    if (t.care) plus(-8, '')
  }
  if (ans.exp === 'yes') {
    if (t.shy) plus(6, '겁이 많아 경험 있는 보호자가 필요해요')
    if (t.care) plus(4, '돌봄이 필요한 아이')
  }

  if (ans.sido && a.sido === ans.sido) plus(15, `가까운 ${SHORT[ans.sido] ?? ans.sido} 보호소`)

  why.sort((x, y) => y[0] - x[0])
  return { score: Math.max(50, Math.min(98, Math.round(55 + s * 0.6))), why: why.slice(0, 3).map((w) => w[1]) }
}

// ───────────────────────── 질문 화면 ─────────────────────────

const ans: Answers = {}
let step = 0

function showQuestion() {
  const q = QUESTIONS[step]
  $('mt-step').textContent = `${step + 1} / ${QUESTIONS.length}`
  $('mt-bar').style.width = `${(step / QUESTIONS.length) * 100}%`
  $('mt-q').textContent = q.q
  $('mt-hint').textContent = q.hint ?? ''
  $('mt-hint').hidden = !q.hint
  const box = $('mt-options')
  box.classList.toggle('many', q.options.length > 4)
  box.replaceChildren(
    ...q.options.map((o) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'mt-option' })
      b.setAttribute('role', 'radio')
      b.setAttribute('aria-checked', String(ans[q.key] === o.v))
      b.innerHTML = `<span class="mt-icon" aria-hidden="true">${o.icon}</span><span class="mt-label"><b></b>${o.sub ? '<small></small>' : ''}</span>`
      b.querySelector('b')!.textContent = o.label
      if (o.sub) b.querySelector('small')!.textContent = o.sub
      b.onclick = () => {
        ;(ans as Record<string, string>)[q.key] = o.v
        if (step < QUESTIONS.length - 1) {
          step++
          showQuestion()
        } else showResult()
      }
      return b
    }),
  )
  $('mt-back').hidden = step === 0
  window.scrollTo(0, 0)
}
$('mt-back').onclick = () => {
  if (step > 0) step--
  showQuestion()
}

// ───────────────────────── 결과 ─────────────────────────

let animals: Animal[] = []
const loaded = fetch(`${import.meta.env.BASE_URL}data/animals.json`)
  .then((r) => (r.ok ? r.json() : { animals: [] }))
  .catch(() => ({ animals: [] }))
  .then((d) => (animals = d.animals as Animal[]))
const pettable: Promise<Set<string>> = fetch(`${import.meta.env.BASE_URL}data/shelter-live.json`)
  .then((r) => (r.ok ? r.json() : { pets: [] }))
  .catch(() => ({ pets: [] }))
  .then((d: { pets: { id: string }[] }) => new Set(d.pets.map((p) => p.id)))

const LABEL: Record<string, Record<string, string>> = {
  sp: { dog: '강아지', cat: '고양이', any: '강아지·고양이' },
  home: { apt: '아파트·원룸', house: '마당 있는 집' },
  time: { low: '집에 있는 시간 적음', mid: '집에 있는 시간 반반', high: '집에 오래 있음' },
  pace: { calm: '조용한 생활', active: '활동적인 생활' },
  exp: { new: '처음 키워요', yes: '키워 봤어요' },
}

async function showResult() {
  $('mt-quiz').hidden = true
  $('mt-result').hidden = false
  window.scrollTo(0, 0)
  await loaded
  const ids = await pettable
  const pool = animals.filter((a) => (ans.sp === 'any' || a.sp === ans.sp) && a.sp !== 'etc' && (dday(a.end) ?? 0) >= 0)
  const ranked = pool
    .map((a) => ({ a, ...score(a, ans) }))
    .sort((x, y) => y.score - x.score || (dday(x.a.end) ?? 99) - (dday(y.a.end) ?? 99))
    .slice(0, 6)

  $('mt-answers').replaceChildren(
    ...[...Object.entries(LABEL).map(([k, m]) => m[(ans as Record<string, string>)[k]]), ans.sido ? `${SHORT[ans.sido]} 근처` : '지역 상관없음']
      .filter(Boolean)
      .map((t) => Object.assign(document.createElement('li'), { textContent: t })),
  )
  $('mt-empty').hidden = ranked.length > 0
  $('mt-empty').textContent = animals.length ? '조건에 맞는 아이가 아직 없어요.' : '공고 정보를 아직 받지 못했어요. 잠시 뒤 다시 와 주세요.'
  $('mt-grid').replaceChildren(...ranked.map((r) => card(r.a, r.score, r.why, ids)))
  track('match_result', { sp: ans.sp, home: ans.home, time: ans.time, pace: ans.pace, exp: ans.exp, found: ranked.length, gen: landedGen() || undefined })
}

const SEX = { M: '남아', F: '여아', Q: '' } as const
function card(a: Animal, pct: number, why: string[], ids: Set<string>) {
  const pet = ids.has(a.id)
  const li = document.createElement('li')
  // 누르면 이 화면에서 바로 자세히 (전체 공고로 넘어가지 않는다)
  const link = Object.assign(document.createElement('button'), { type: 'button', className: 'mt-card' })
  link.addEventListener('click', () => {
    track('adopt_action', { how: 'detail', where: 'match' })
    openAdoptDetail(a, ids, 'match')
  })
  const door = Object.assign(document.createElement('span'), { className: 'ad-door' })
  const img = Object.assign(new Image(), { src: a.photos[0], alt: `${kindName(a.kind)} 사진`, loading: 'lazy', decoding: 'async' })
  img.referrerPolicy = 'no-referrer'
  door.append(img, Object.assign(document.createElement('span'), { className: 'mt-pct', textContent: `${pct}% 맞아요` }))
  const d = dday(a.end)
  const text = document.createElement('span')
  text.className = 'ad-card-text'
  text.append(
    Object.assign(document.createElement('b'), { textContent: kindName(a.kind) }),
    Object.assign(document.createElement('span'), { textContent: [SEX[a.sex], a.age, a.weight].filter(Boolean).join(' · ') }),
    Object.assign(document.createElement('small'), { textContent: [a.org.split(' ').slice(0, 2).join(' '), d === null ? '' : d <= 0 ? '오늘 마감' : `D-${d}`].filter(Boolean).join(' · ') }),
  )
  const ul = Object.assign(document.createElement('ul'), { className: 'mt-why' })
  ul.append(
    ...why.map((w) => {
      const l = document.createElement('li')
      l.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-check" /></svg>'
      l.append(w)
      return l
    }),
  )
  // 보호소가 적은 특징이 있으면 그것만 보여 주고, 공통 문구(맞는 이유)는 특징이 없는 아이에게만
  const note = a.note?.trim()
  if (note) link.append(door, text, Object.assign(document.createElement('p'), { className: 'mt-note-line', textContent: `특징 · ${note}` }))
  else link.append(door, text, ul)
  li.append(link)
  if (pet) {
    const p = Object.assign(document.createElement('a'), { className: 'mt-pet', href: `./?pet=shelter-${a.id}` })
    p.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-hand" /></svg><span>쓰다듬어 보기</span>'
    li.append(p)
  }
  return li
}

$('mt-again').onclick = () => {
  for (const k of Object.keys(ans)) delete (ans as Record<string, unknown>)[k]
  step = 0
  $('mt-result').hidden = true
  $('mt-quiz').hidden = false
  showQuestion()
}

showQuestion()
registerPwa()
