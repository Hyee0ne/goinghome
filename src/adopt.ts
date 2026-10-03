import './style.css'
import './register.css'
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
let list: Animal[] = []
let shown = 0

const SEX = { M: '남아', F: '여아', Q: '성별 모름' } as const
const NEUTER = { Y: '중성화 완료', N: '', U: '' } as const
const ICON = { dog: '🐶', cat: '🐱', etc: '🐾' } as const

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
  const b = Object.assign(document.createElement('button'), { type: 'button', className: 'ad-card' })
  const img = Object.assign(new Image(), { src: a.photos[0], alt: `${a.kind} 사진`, loading: 'lazy', decoding: 'async' })
  img.referrerPolicy = 'no-referrer'
  const d = dday(a.end)
  const badge = Object.assign(document.createElement('span'), {
    className: 'ad-dday' + (d !== null && d <= 3 ? ' soon' : ''),
    textContent: d === null ? '' : d <= 0 ? '오늘 마감' : `D-${d}`,
  })
  const text = document.createElement('span')
  text.className = 'ad-card-text'
  text.append(
    Object.assign(document.createElement('b'), { textContent: `${ICON[a.sp]} ${a.kind}` }),
    Object.assign(document.createElement('span'), { textContent: [SEX[a.sex], a.age].filter(Boolean).join(' · ') }),
    Object.assign(document.createElement('small'), { textContent: a.org }),
  )
  b.append(img, badge, text)
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
  const sp = (document.querySelector('input[name=ad-sp]:checked') as HTMLInputElement).value
  const sido = sidoSel.value
  list = all.filter((a) => (sp === 'all' || a.sp === sp) && (!sido || a.sido === sido))
  $('ad-count').textContent = `공고 중 ${list.length.toLocaleString()}마리`
  render(true)
}
document.querySelectorAll('input[name=ad-sp]').forEach((r) => r.addEventListener('change', applyFilter))
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
  $('ad-d-name').textContent = `${ICON[a.sp]} ${a.kind}`
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
  const call = $<HTMLAnchorElement>('ad-d-call')
  call.hidden = !a.care.tel
  call.href = `tel:${a.care.tel.replace(/[^\d+]/g, '')}`
  call.textContent = `${a.care.name}에 전화로 입양 문의`
  detail.showModal()
  detail.querySelector('.sheet-body')!.scrollTop = 0
}
$('ad-d-close').onclick = () => detail.close()
detail.addEventListener('click', (e) => {
  if (e.target === detail) detail.close()
})

// ───────────────────────── 시작 ─────────────────────────

fetch(`${import.meta.env.BASE_URL}data/animals.json`)
  .then((r) => (r.ok ? r.json() : { animals: [], updated: null }))
  .catch(() => ({ animals: [], updated: null }))
  .then((d: { animals: Animal[]; updated: string | null }) => {
    all = d.animals
    const sidos = [...new Set(all.map((a) => a.sido).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'))
    sidoSel.append(...sidos.map((s) => Object.assign(document.createElement('option'), { value: s, textContent: s })))
    if (d.updated) $('ad-updated').textContent = `${new Date(d.updated).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })} 기준`
    applyFilter()
  })
