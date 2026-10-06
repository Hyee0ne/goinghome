/**
 * 우리 아이 닮은 친구 찾기 (/find, 2026-10-06): '우리 아이 만들기'(AI 서버가 필요해 잠시 내림) 대신,
 * 우리 아이 사진의 털색(이 기기 안에서만 본다)과 품종·크기로 닮은 보호소 아이 3마리를 보여 준다. (털색 고르기는 뺐다, 2026-10-06)
 * 고르는 순서: ① 같은 품종 ② 생김새가 비슷한 무리 ③ (믹스견) 몸무게로 본 크기가 같은 아이 ④ 나머지.
 * 같은 단계 안에서는 털색이 닮은 순 → 공고 남은 3~7일(급한 아이) → 털색 거리 → 마감 순. 같은 보호소는 한 마리, 마감 지난 아이는 뺀다.
 * 서버·AI 비용 없음. 카드는 모두 입양 공고 화면으로 간다. 공유 링크는 가장 닮은 아이의 공고로 연다.
 */
import './style.css'
import { landedGen, shareParams, track } from './analytics'
import './form.css'
import './make.css'
import './find.css'
import { CAT_BREEDS, DOG_BREEDS, GROUP_LABEL, breedOf, sizeOfWeight, type Breed, type Size } from './breeds'
import { colorRank, daysLeft, type RGB } from './lookalike'
import { josa } from './pets'
import { toast } from './share'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

interface Animal {
  id: string
  sp: 'dog' | 'cat' | 'etc'
  kind: string
  age: string
  color: string
  org: string
  end: string
  care?: { name?: string }
  weight?: string
  photos: string[]
}

/** 닮은 아이 + 닮은 이유 */
interface Pick {
  a: Animal
  why: string
}

const state: { color: RGB | null; colorName: string; from: 'photo' | 'pick' | null } = { color: null, colorName: '', from: null }
const species = () => (document.querySelector('input[name=fd-species]:checked') as HTMLInputElement).value as 'dog' | 'cat'

// 품종 목록 (종류에 따라 바뀐다). 품종을 고르면 크기를 자동으로 맞춘다 (강아지만)
const breedSel = $<HTMLSelectElement>('fd-breed')
const breeds = () => (species() === 'cat' ? CAT_BREEDS : DOG_BREEDS)
function fillBreeds() {
  breedSel.replaceChildren(...breeds().map((b, i) => Object.assign(document.createElement('option'), { value: String(i), textContent: b.label })))
  $('fd-size-field').hidden = species() === 'cat'
}
breedSel.addEventListener('change', () => {
  const s = breeds()[Number(breedSel.value)]?.size
  if (s) (document.querySelector(`input[name=fd-size][value=${s}]`) as HTMLInputElement).checked = true
})
document.querySelectorAll('input[name=fd-species]').forEach((r) => r.addEventListener('change', fillBreeds))
fillBreeds()
const mySize = () => (document.querySelector('input[name=fd-size]:checked') as HTMLInputElement).value as Size

/** 닮은 아이 n마리를 이유와 함께 고른다 */
function findSimilar(all: Animal[], sp: 'dog' | 'cat', mine: Breed, size: Size, color: RGB | null, n: number): Pick[] {
  const mixMine = mine === breeds()[0]
  const seen = new Set<string>()
  return all
    .filter((a) => a.sp === sp && daysLeft(a.end) >= 0)
    .map((a) => {
      const b = breedOf(a.kind, sp)
      const sameBreed = !mixMine && b === mine
      const sameGroup = !sameBreed && b.group === mine.group && (!mixMine || sp === 'cat')
      const sameSize = sp === 'dog' && (b.size ?? sizeOfWeight(a.weight)) === size
      // 단계: 같은 품종 0 / 비슷한 무리 1 / (강아지) 같은 크기 2 / 나머지 3
      const step = sameBreed ? 0 : sameGroup ? 1 : sameSize ? 2 : 3
      const c = colorRank(a.color, color)
      const left = daysLeft(a.end)
      const why = [
        sameBreed ? `같은 ${josa(mine.label, '이에요', '예요')}` : sameGroup ? `${josa(GROUP_LABEL[b.group], '이라', '라')} 생김새가 비슷해요` : sameSize ? '크기가 비슷해요' : '',
        c.tier === 0 ? '털색도 비슷해요' : '',
      ]
        .filter(Boolean)
        .join(' · ')
        .replace(/^털색도/, '털색이')
      return { a, step, ctier: c.tier, d: c.d, urgent: left >= 3 && left <= 7 ? 0 : 1, why: why || '가족을 기다리는 친구예요' }
    })
    .sort((x, y) => x.step - y.step || x.ctier - y.ctier || x.urgent - y.urgent || x.d - y.d || x.a.end.localeCompare(y.a.end))
    .filter((x) => {
      const key = x.a.care?.name || x.a.org || x.a.id
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, n)
    .map(({ a, why }) => ({ a, why }))
}

function pickColor(rgb: RGB, name: string, from: 'photo' | 'pick') {
  state.color = rgb
  state.colorName = name
  state.from = from
  $<HTMLButtonElement>('fd-go').disabled = false
}

// 사진: 가운데 부분의 털색만 본다 (배경을 지우지 않으니 가장자리는 빼고, 아주 어둡거나 밝은 점도 뺀다)
$<HTMLInputElement>('fd-file').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const bmp = await createImageBitmap(file)
    const size = 64
    const c = Object.assign(document.createElement('canvas'), { width: size, height: size })
    const g = c.getContext('2d', { willReadFrequently: true })!
    g.drawImage(bmp, 0, 0, size, size)
    const d = g.getImageData(0, 0, size, size).data
    let r = 0
    let gg = 0
    let b = 0
    let n = 0
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        // 가운데 타원 안만 (아이가 보통 가운데에 있다)
        if (((x - size / 2) / (size * 0.32)) ** 2 + ((y - size * 0.55) / (size * 0.38)) ** 2 > 1) continue
        const i = (y * size + x) * 4
        const lum = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11
        if (lum < 18 || lum > 250) continue
        r += d[i]
        gg += d[i + 1]
        b += d[i + 2]
        n++
      }
    const prev = $<HTMLImageElement>('fd-preview')
    prev.src = URL.createObjectURL(file)
    prev.hidden = false
    $('fd-pick-label').hidden = true
    bmp.close()
    if (n) pickColor([r / n, gg / n, b / n], '사진 속 털색', 'photo')
  } catch {
    alert('이 사진은 열 수 없어요. 다른 사진을 골라 주세요.')
  }
})

let animals: Animal[] = []
let picks: Pick[] = []
async function loadAnimals() {
  if (animals.length) return animals
  const d = await fetch(`${import.meta.env.BASE_URL}data/animals.json`)
    .then((r) => (r.ok ? r.json() : { animals: [] }))
    .catch(() => ({ animals: [] }))
  animals = d.animals as Animal[]
  return animals
}

$('fd-go').onclick = async () => {
  const sp = species()
  const mine = breeds()[Number(breedSel.value)] ?? breeds()[0]
  picks = findSimilar(await loadAnimals(), sp, mine, mySize(), state.color, 3)
  const name = $<HTMLInputElement>('fd-name').value.trim()
  $<HTMLImageElement>('fd-me-img').src = $<HTMLImageElement>('fd-preview').src
  $('fd-title').textContent = picks.length
    ? `${name ? josa(name, '이랑', '랑') : '우리 아이랑'} 닮은 친구들이 가족을 기다려요 🐾`
    : '지금은 닮은 친구를 찾지 못했어요'
  $('fd-why').textContent = picks.length ? `${mine === breeds()[0] ? '' : `${mine.label} · `}털색과 생김새로 찾았어요` : ''
  $('fd-list').replaceChildren(...picks.map((p) => card(p.a, p.why)))
  $('fd-ask').hidden = true
  $('fd-result').hidden = false
  $<HTMLButtonElement>('fd-share').hidden = !picks.length
  window.scrollTo(0, 0)
  track('find_result', { species: sp, breed: mine.label, found: picks.length, gen: landedGen() || undefined })
}

/** 카드: 공고 사진 · 품종 · 닮은 이유 · 나이·지역 · 마감 → 입양 공고 화면 */
function card(a: Animal, why: string) {
  const link = Object.assign(document.createElement('a'), { className: 'mk-look-card', href: `adopt?id=${a.id}` })
  link.addEventListener('click', () => track('adopt_action', { how: 'notice', where: 'find' }))
  const img = Object.assign(new Image(), { src: a.photos[0], alt: `${a.kind} 사진`, loading: 'lazy', decoding: 'async' })
  img.referrerPolicy = 'no-referrer'
  const text = Object.assign(document.createElement('span'), { className: 'mk-look-text' })
  const due = Object.assign(document.createElement('em'), { className: 'mk-look-due' })
  const left = daysLeft(a.end)
  if (Number.isFinite(left)) {
    due.textContent = left === 0 ? '오늘까지 가족을 찾아요' : `${Number(a.end.slice(4, 6))}월 ${Number(a.end.slice(6, 8))}일까지 가족을 찾아요`
    if (left <= 7) due.classList.add('soon')
  }
  text.append(
    Object.assign(document.createElement('b'), { textContent: a.kind }),
    Object.assign(document.createElement('span'), { className: 'mk-look-why', textContent: why }),
    Object.assign(document.createElement('small'), { textContent: [a.age, a.org.split(' ').slice(0, 2).join(' ')].filter(Boolean).join(' · ') }),
    due,
    Object.assign(document.createElement('i'), { textContent: '입양 공고 보기 ›' }),
  )
  link.append(img, text)
  return link
}

// 공유: 가장 닮은 아이의 공고로 바로 여는 링크 (마감일은 넣지 않는다)
$('fd-share').onclick = async () => {
  const top = picks[0]?.a
  if (!top) return
  const name = $<HTMLInputElement>('fd-name').value.trim()
  const u = new URL(`${import.meta.env.BASE_URL}adopt`, location.origin)
  u.searchParams.set('id', top.id)
  u.searchParams.set('from', 'share')
  for (const [k, v] of Object.entries(shareParams('find'))) u.searchParams.set(k, v)
  const text = `${name ? `우리 ${josa(name, '이랑', '랑')}` : '우리 아이랑'} 닮은 친구가 가족을 기다리고 있어요 🐾\n${top.kind} · ${top.org.split(' ').slice(0, 2).join(' ')}\n고잉홈에서 만나 보세요`
  track('share_click', { src: 'find' })
  let how = 'copied'
  if (navigator.share) {
    try {
      await navigator.share({ title: '고잉홈', text, url: u.toString() })
      how = 'shared'
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return
    }
  }
  if (how === 'copied') {
    try {
      await navigator.clipboard.writeText(`${text}\n${u}`)
    } catch {
      prompt('아래 내용을 복사해 보내 주세요', `${text}\n${u}`)
    }
    toast('링크를 복사했어요. 친구에게 붙여 넣어 보내 주세요.')
  }
  track('share_done', { src: 'find', how })
}

$('fd-again').onclick = () => {
  $('fd-result').hidden = true
  $('fd-ask').hidden = false
}
