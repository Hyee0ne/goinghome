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

const hasBatchim = (ch: string) => {
  const c = ch.charCodeAt(0) - 0xac00
  return c >= 0 && c < 11172 && c % 28 !== 0
}
const josa = (w: string, a: string, b: string) => w + (hasBatchim(w[w.length - 1]) ? a : b)

/** 끝맺음을 바꾸는 규칙 (보호소 메모에 자주 나오는 꼴): '순함' → '순해요', '마름' → '말랐어요' … */
const ENDINGS: [RegExp, string][] = [
  [/잘\s?따름$/, '잘 따라요'], [/따름$/, '따라요'], [/마름$/, '말랐어요'], [/가림$/, '가려요'], [/다님$/, '다녀요'], [/맞음$/, '맞았어요'],
  [/있음$/, '있어요'], [/없음$/, '없어요'], [/좋음$/, '좋아요'], [/많음$/, '많아요'], [/적음$/, '적어요'], [/않음$/, '않아요'],
  [/같음$/, '같아요'], [/보임$/, '보여요'], [/됨$/, '돼요'], [/짖음$/, '짖어요'], [/움$/, '워요'],
  [/하고$/, '해요'], [/하며$/, '해요'], [/함$/, '해요'], [/임$/, '이에요'],
  [/(온순|소심|얌전|활발|명랑|차분|건강|양호|깨끗|착실|예민|순|필요)$/, '$1해요'],
  [/혼탁$/, '혼탁해요'], [/소실$/, '소실됐어요'], [/부착$/, '붙어 있어요'], [/손상$/, '손상됐어요'], [/중성화$/, '중성화했어요'],
  [/완료$/, '완료했어요'], [/인계$/, '인계됐어요'], [/입소$/, '입소했어요'], [/의심$/, '의심돼요'], [/저하$/, '저하됐어요'], [/착용$/, '착용하고 있어요'], [/불량$/, '좋지 않아요'],
]

/**
 * 메모 조각을 문장으로: '착함' → '착해요', '치석 약간' → '치석이 약간 있어요', '보더콜리로 추정' → '보더콜리로 보여요',
 * '안질환' → '안질환이 있어요', '검정+흰색' → '검정+흰색 털이에요', 그 밖의 명사는 '…이에요/예요'. 이미 문장이면 그대로
 */
export function toSentence(raw: string) {
  const t = raw.trim().replace(/[.。!~]+$/, '').replace(/\s+/g, ' ')
  if (!t || !/[가-힣]$/.test(t) || /(요|다|죠)$/.test(t)) return t
  let m: RegExpMatchArray | null
  if ((m = t.match(/^(.+?)\s*추정$/))) return (/로$/.test(m[1]) ? m[1] : josa(m[1], '으로', '로')) + ' 보여요'
  if ((m = t.match(/^(.+?)\s*약간$/))) return josa(m[1], '이', '가') + ' 약간 있어요'
  if ((m = t.match(/^(.+?)\s*(양성|음성)$/))) return `${m[1]} ${m[2]}이에요`
  for (const [re, rep] of ENDINGS) if (re.test(t)) return t.replace(re, rep)
  if ((m = t.match(/^(.+?(증상|질환|부상|이상|상처|염증|염|피부병|탈모|골절|기생충|백내장|종양|탈장|허니아|궤양))$/))) return josa(m[1], '이', '가') + ' 있어요'
  if (/^[가-힣+\s]*(색|검정|검은)$/.test(t)) return t + ' 털이에요'
  return josa(t, '이에요', '예요')
}

/**
 * 보호소 특징 메모를 한 문장씩 나눠 문장으로 바꾼다: '피모상태양호,온순함/전반적인건강은양호함' → ['피모상태양호해요', '온순해요', …].
 * 쉼표(숫자 사이 제외)·슬래시·줄바꿈·가운뎃점·마침표(숫자 앞 제외)로 끊는다
 */
export function noteItems(note?: string) {
  return (note ?? '')
    .split(/[/\n·]|,(?!\d)|\.(?!\d)/)
    .map((t) => t.trim().replace(/^[-–•]+\s*/, ''))
    .filter((t) => t.length >= 2)
    .map(toSentence)
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
