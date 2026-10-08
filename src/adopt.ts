import './style.css'
import { landedGen, track } from './analytics'
import { registerPwa } from './pwa'
import './form.css'
import './adopt.css'

/**
 * 가족을 기다리는 아이들: 공고 중인 유기동물 목록 (public/data/animals.json, 배포할 때 scripts/fetch-animals.ts가 만든다).
 * 사진이 커서 한 번에 24마리씩만 그린다.
 */

interface Animal {
  id: string
  sp: 'dog' | 'cat' | 'etc'
  kind: string
  age: string
  sex: 'M' | 'F' | 'Q'
  neuter: 'Y' | 'N' | 'U'
  color: string
  weight: string
  note: string
  photos: string[]
  care: { name: string; tel: string; addr: string }
  org: string
  sido: string
  noticeNo: string
  end: string
}

const STEP = 24
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const grid = $('ad-grid')
const more = $<HTMLButtonElement>('ad-more')
const sidoSel = $<HTMLSelectElement>('ad-sido')

let all: Animal[] = []
/** 실사화해서 쓰다듬을 수 있는 아이 (public/data/shelter-live.json) */
let pettable = new Set<string>()
/** 쓰다듬을 수 있는 아이의 가장 정면인 사진 (카드 사진으로 쓴다) */
const frontal = new Map<string, string>()
/** 고퀄(AI 정면 + 표정)으로 만든 아이 */
const vivid = new Set<string>()
let list: Animal[] = []
let shown = 0

const SEX = { M: '남아', F: '여아', Q: '성별 모름' } as const
const NEUTER = { Y: '중성화 완료', N: '', U: '' } as const
/** 문 색: 사진이 뜨기 전에 보이는 파스텔 (연분홍 · 하늘 · 민트 · 모래) */
const DOOR_COLORS = ['#ffd3dc', '#dde4ff', '#d8f1e6', '#f6ead6']

/** 공고 마감까지 남은 날 (D-day) */
function dday(end: string) {
  if (!/^\d{8}$/.test(end)) return null
  const d = new Date(+end.slice(0, 4), +end.slice(4, 6) - 1, +end.slice(6, 8))
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((d.getTime() - today.getTime()) / 86400000)
}

function card(a: Animal) {
  const li = document.createElement('li')
  // D안 문 갤러리: 공고 원본 사진을 아치문 모양으로 잘라 보여 준다 (대부분 배경을 지우지 않은 원본이라)
  const b = Object.assign(document.createElement('button'), { type: 'button', className: 'ad-card' })
  const door = Object.assign(document.createElement('span'), { className: 'ad-door' })
  door.style.background = DOOR_COLORS[grid.childElementCount % DOOR_COLORS.length]
  const img = Object.assign(new Image(), { src: a.photos[0], alt: `${a.kind} 사진`, loading: 'lazy', decoding: 'async' })
  img.referrerPolicy = 'no-referrer'
  door.append(img)
  if (pettable.has(a.id)) door.append(Object.assign(document.createElement('span'), { className: 'ad-pettable', textContent: '쓰다듬기' }))
  const d = dday(a.end)
  const text = document.createElement('span')
  text.className = 'ad-card-text'
  text.append(
    Object.assign(document.createElement('b'), { textContent: a.kind }),
    Object.assign(document.createElement('span'), { textContent: [SEX[a.sex], a.age].filter(Boolean).join(' · ') }),
    Object.assign(document.createElement('small'), { textContent: [a.org.split(' ').slice(0, 2).join(' '), d === null ? '' : d <= 0 ? '오늘 마감' : `D-${d}`].filter(Boolean).join(' · ') }),
  )
  b.append(door, text)
  b.onclick = () => openDetail(a)
  li.append(b)
  return li
}

function render(reset: boolean) {
  if (reset) {
    grid.replaceChildren()
    shown = 0
  }
  const next = list.slice(shown, shown + STEP)
  grid.append(...next.map(card))
  shown += next.length
  more.hidden = shown >= list.length
  more.textContent = `더 보기 (${list.length - shown}마리 더)`
  const empty = $('ad-empty')
  empty.hidden = list.length > 0
  empty.textContent = all.length ? '조건에 맞는 아이가 없어요.' : '공고 정보를 아직 받지 못했어요. 잠시 뒤 다시 와 주세요.'
}

function applyFilter() {
  const sp = $<HTMLSelectElement>('ad-sp').value
  const sido = sidoSel.value
  list = all.filter((a) => (sp === 'all' || a.sp === sp) && (!sido || a.sido === sido))
  $('ad-count').textContent = `공고 중 ${list.length.toLocaleString()}마리`
  render(true)
}
$('ad-sp').addEventListener('change', applyFilter)
sidoSel.addEventListener('change', applyFilter)
more.onclick = () => render(false)

// ───────────────────────── 자세히 ─────────────────────────

const detail = $<HTMLDialogElement>('ad-detail')
function openDetail(a: Animal) {
  $('ad-d-slides').replaceChildren(
    ...a.photos.map((src, i) => {
      const img = Object.assign(new Image(), { src, alt: `${a.kind} 사진 ${i + 1}`, decoding: 'async' })
      img.referrerPolicy = 'no-referrer'
      if (i > 0) img.loading = 'lazy'
      return img
    }),
  )
  $('ad-d-name').textContent = a.kind
  $('ad-d-meta').textContent = [SEX[a.sex], a.age, a.weight, a.color].filter(Boolean).join(' · ')
  const d = dday(a.end)
  const tags = [NEUTER[a.neuter], d === null ? '' : d <= 0 ? '오늘 공고 마감' : `공고 마감 D-${d}`].filter(Boolean)
  $('ad-d-tags').replaceChildren(...tags.map((t) => Object.assign(document.createElement('li'), { textContent: t })))
  $('ad-d-note-wrap').hidden = !a.note
  $('ad-d-note').textContent = a.note
  $('ad-d-care').replaceChildren(
    ...([
      ['보호소', a.care.name],
      ['전화', a.care.tel],
      ['주소', a.care.addr],
      ['관할', a.org],
      ['공고번호', a.noticeNo],
    ] as const).flatMap(([k, v]) =>
      v ? [Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v })] : [],
    ),
  )
  const petLink = $<HTMLAnchorElement>('ad-d-pet')
  petLink.hidden = !pettable.has(a.id)
  petLink.href = `./?pet=shelter-${a.id}`
  const call = $<HTMLAnchorElement>('ad-d-call')
  call.hidden = !a.care.tel
  call.href = `tel:${a.care.tel.replace(/[^\d+]/g, '')}`
  call.setAttribute('aria-label', `${a.care.name}에 전화로 입양 문의`)
  detail.showModal()
  detail.querySelector('.sheet-body')!.scrollTop = 0
}
$('ad-d-close').onclick = () => detail.close()
$('ad-d-call').addEventListener('click', () => track('adopt_action', { how: 'call', where: 'adopt', gen: landedGen() || undefined }))
detail.addEventListener('click', (e) => {
  if (e.target === detail) detail.close()
})

// ───────────────────────── 시작 ─────────────────────────

const shelterLive = fetch(`${import.meta.env.BASE_URL}data/shelter-live.json`)
  .then((r) => (r.ok ? r.json() : { pets: [] }))
  .catch(() => ({ pets: [] }))
  .then((d: { pets: { id: string; photo?: string; aiFrontal?: boolean }[] }) => {
    pettable = new Set(d.pets.map((p) => p.id))
    for (const p of d.pets) if (p.aiFrontal) vivid.add(p.id)
    for (const p of d.pets) if (p.photo) frontal.set(p.id, `${import.meta.env.BASE_URL}${p.photo}`)
  })

fetch(`${import.meta.env.BASE_URL}data/animals.json`)
  .then((r) => (r.ok ? r.json() : { animals: [], updated: null }))
  .catch(() => ({ animals: [], updated: null }))
  .then(async (d: { animals: Animal[]; updated: string | null }) => {
    await shelterLive
    // 쓰다듬을 수 있는 아이를 맨 앞에
    all = [...d.animals].sort((x, y) => Number(pettable.has(y.id)) - Number(pettable.has(x.id)))
    const sidos = [...new Set(all.map((a) => a.sido).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'))
    sidoSel.append(...sidos.map((s) => Object.assign(document.createElement('option'), { value: s, textContent: s })))
    if (d.updated) $('ad-updated').textContent = `${new Date(d.updated).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })} 기준`
    applyFilter()
    // 다른 화면(닮은 아이 등)에서 ?id=공고번호로 들어오면 그 아이를 바로 보여 준다
    const want = new URLSearchParams(location.search).get('id')
    const hit = want && all.find((a) => a.id === want)
    if (hit) openDetail(hit)
  })

registerPwa()
