import { landedGen, track } from './analytics'

/**
 * 공고 아이 자세히 (아래에서 올라오는 시트). 전체 공고(/adopt)와 나랑 맞는 아이(/match)가 같이 쓴다.
 * 페이지에 #ad-detail 대화상자 마크업이 있어야 한다 (adopt.html과 같은 마크업)
 */
export interface AdoptAnimal {
  id: string
  kind: string
  age: string
  sex: 'M' | 'F' | 'Q'
  neuter?: 'Y' | 'N' | 'U'
  color?: string
  weight?: string
  note?: string
  photos: string[]
  care?: { name?: string; tel?: string; addr?: string }
  org: string
  noticeNo?: string
  end: string
}

const SEX = { M: '남아', F: '여아', Q: '성별 모름' } as const
const NEUTER = { Y: '중성화 완료', N: '', U: '' } as const
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

/** 공고 마감까지 남은 날 (D-day) */
export function dday(end: string) {
  if (!/^\d{8}$/.test(end)) return null
  const d = new Date(+end.slice(0, 4), +end.slice(4, 6) - 1, +end.slice(6, 8))
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((d.getTime() - today.getTime()) / 86400000)
}

/**
 * 보호소 특징 메모를 한 문장씩 나눈다: '피모상태양호,온순함/전반적인건강은양호함' → ['피모상태양호', '온순함', '전반적인건강은양호함'].
 * 쉼표(숫자 사이 제외)·슬래시·줄바꿈·가운뎃점·문장 끝 마침표로 끊는다
 */
export function noteItems(note?: string) {
  return (note ?? '')
    .split(/[\/\n·]|,(?!\d)|\.(?=\s|$)/)
    .map((t) => t.trim().replace(/^[-–•]+\s*/, ''))
    .filter((t) => t.length >= 2)
}

/** 특징 목록 (줄마다 '- ') */
export function noteList(note?: string, max = Infinity) {
  const ul = Object.assign(document.createElement('ul'), { className: 'note-list' })
  ul.append(...noteItems(note).slice(0, max).map((t) => Object.assign(document.createElement('li'), { textContent: t })))
  return ul
}

let ready = false
let where = 'adopt'
function setup() {
  if (ready) return
  ready = true
  const detail = $<HTMLDialogElement>('ad-detail')
  $('ad-d-close').onclick = () => detail.close()
  $('ad-d-call').addEventListener('click', () => track('adopt_action', { how: 'call', where, gen: landedGen() || undefined }))
  detail.addEventListener('click', (e) => {
    if (e.target === detail) detail.close()
  })
}

/** 아이 자세히 열기. pettable: 쓰다듬을 수 있는 아이 id, from: 어느 화면에서 열었는지 (기록용) */
export function openAdoptDetail(a: AdoptAnimal, pettable: Set<string>, from = 'adopt') {
  setup()
  where = from
  const detail = $<HTMLDialogElement>('ad-detail')
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
  const tags = [a.neuter ? NEUTER[a.neuter] : '', d === null ? '' : d <= 0 ? '오늘 공고 마감' : `공고 마감 D-${d}`].filter(Boolean)
  $('ad-d-tags').replaceChildren(...tags.map((t) => Object.assign(document.createElement('li'), { textContent: t })))
  $('ad-d-note-wrap').hidden = !noteItems(a.note).length
  $('ad-d-note').replaceChildren(noteList(a.note))
  const care = a.care ?? {}
  $('ad-d-care').replaceChildren(
    ...([
      ['보호소', care.name],
      ['전화', care.tel],
      ['주소', care.addr],
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
  call.hidden = !care.tel
  call.href = `tel:${(care.tel ?? '').replace(/[^\d+]/g, '')}`
  call.setAttribute('aria-label', `${care.name ?? '보호소'}에 전화로 입양 문의`)
  detail.showModal()
  detail.querySelector('.sheet-body')!.scrollTop = 0
}
