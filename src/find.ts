/**
 * 우리 아이 닮은 친구 찾기 (/find, 2026-10-06): '우리 아이 만들기'(AI 서버가 필요해 잠시 내림) 대신,
 * 우리 아이 사진의 털색과 생김새(기기 안 이미지 분류 모델로 짐작한 품종)로 닮은 보호소 아이 3마리를 보여 준다.
 * 사용자가 품종·크기·털색을 고르지 않는다 (2026-10-06). 사진은 기기 밖으로 나가지 않는다.
 * 영 닮은 데가 없으면 '귀여운 게 닮았어요'라고 한다.
 * 고르는 순서: ① 같은 품종 ② 생김새가 비슷한 무리 ③ (믹스견) 몸무게로 본 크기가 같은 아이 ④ 나머지.
 * 같은 단계 안에서는 털색이 닮은 순 → 공고 남은 3~7일(급한 아이) → 털색 거리 → 마감 순. 같은 보호소는 한 마리, 마감 지난 아이는 뺀다.
 * 서버·AI 비용 없음. 카드는 모두 입양 공고 화면으로 간다. 공유 링크는 가장 닮은 아이의 공고로 연다.
 */
import './style.css'
import { landedGen, shareParams, track } from './analytics'
import './form.css'
import './make.css'
import './find.css'
import { CAT_BREEDS, DOG_BREEDS, GROUP_LABEL, breedOf, guessFromLabels, sizeOfWeight, type Breed, type Size } from './breeds'
import { colorRank, daysLeft, type RGB } from './lookalike'
import { josa } from './pets'
import { toast } from './share'
import { drawShareCard } from './shareCard'

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
  sex?: 'M' | 'F' | 'Q'
  photos: string[]
}

/** 닮은 아이 + 닮은 이유 */
interface Pick {
  a: Animal
  why: string
}

const state: { color: RGB | null; colorName: string; from: 'photo' | 'pick' | null } = { color: null, colorName: '', from: null }
const species = () => (document.querySelector('input[name=fd-species]:checked') as HTMLInputElement).value as 'dog' | 'cat'

const breeds = () => (species() === 'cat' ? CAT_BREEDS : DOG_BREEDS)
/** 사진 생김새로 짐작한 품종 (없으면 믹스·코숏) */
let guessed: Breed | undefined

/** 기기 안 이미지 분류 모델 (사진을 고를 때만 불러온다, 약 5MB) */
let classifier: Promise<import('@mediapipe/tasks-vision').ImageClassifier | null> | null = null
function loadClassifier() {
  classifier ??= (async () => {
    try {
      const { FilesetResolver, ImageClassifier } = await import('@mediapipe/tasks-vision')
      const base = import.meta.env.BASE_URL
      const fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe`)
      return await ImageClassifier.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${base}models/efficientnet_lite0_int8.tflite` },
        maxResults: 5,
        runningMode: 'IMAGE',
      })
    } catch {
      return null
    }
  })()
  return classifier
}

/** 닮은 아이 n마리를 이유와 함께 고른다 */
function findSimilar(all: Animal[], sp: 'dog' | 'cat', mine: Breed, size: Size | undefined, color: RGB | null, n: number): Pick[] {
  const mixMine = mine === breeds()[0]
  const seen = new Set<string>()
  return all
    .filter((a) => a.sp === sp && daysLeft(a.end) >= 0)
    .map((a) => {
      const b = breedOf(a.kind, sp)
      const sameBreed = !mixMine && b === mine
      const sameGroup = !sameBreed && b.group === mine.group && (!mixMine || sp === 'cat')
      const sameSize = sp === 'dog' && !!size && (b.size ?? sizeOfWeight(a.weight)) === size
      // 단계: 같은 품종 0 / 비슷한 무리 1 / (강아지) 같은 크기 2 / 나머지 3
      const step = sameBreed ? 0 : sameGroup ? 1 : sameSize ? 2 : 3
      const c = colorRank(a.color, color)
      const left = daysLeft(a.end)
      const why = [
        sameBreed ? `${josa(mine.label, '이라', '라')} 닮았어요` : sameGroup ? `${josa(GROUP_LABEL[b.group], '이라', '라')} 생김새가 비슷해요` : sameSize ? '크기가 비슷해요' : '',
        c.tier === 0 ? '털색도 비슷해요' : '',
      ]
        .filter(Boolean)
        .join(' · ')
        .replace(/^털색도/, '털색이')
      // 영 닮은 데가 없으면 귀여운 게 닮았다고 한다
      return { a, step, ctier: c.tier, d: c.d, urgent: left >= 3 && left <= 7 ? 0 : 1, why: why || '귀여운 게 닮았어요 💕' }
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
  const status = $('fd-status')
  status.textContent = '사진을 살펴보고 있어요…'
  $<HTMLButtonElement>('fd-go').disabled = true
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
    // 생김새: 기기 안 분류 모델로 품종을 짐작하고, 강아지·고양이도 맞춰 둔다
    guessed = undefined
    const cls = await loadClassifier()
    if (cls) {
      const res = cls.classify(bmp).classifications[0]?.categories ?? []
      const g = guessFromLabels(res.map((x) => ({ name: x.categoryName, score: x.score })))
      if (g.sp) (document.querySelector(`input[name=fd-species][value=${g.sp}]`) as HTMLInputElement).checked = true
      guessed = g.breed
    }
    const animal = species() === 'cat' ? '고양이' : '강아지'
    status.textContent = guessed && guessed !== breeds()[0] ? `${josa(guessed.label, '을', '를')} 닮은 것 같아요!` : `귀여운 ${animal}네요!`
    bmp.close()
    if (n) pickColor([r / n, gg / n, b / n], '사진 속 털색', 'photo')
  } catch {
    status.textContent = '이 사진은 열 수 없어요. 다른 사진을 골라 주세요.'
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
  const mine = guessed && breeds().includes(guessed) ? guessed : breeds()[0]
  picks = findSimilar(await loadAnimals(), sp, mine, mine.size, state.color, 3)
  const name = $<HTMLInputElement>('fd-name').value.trim()
  const top = picks[0]
  // 두 문: 우리 아이(사용자 원본 사진) · 가장 닮은 친구(공고 원본 사진)
  $<HTMLImageElement>('fd-me-img').src = $<HTMLImageElement>('fd-preview').src
  $('fd-me-name').textContent = name || '우리 아이'
  const where = top ? shortRegion(top.a.org) : ''
  if (top) {
    $<HTMLImageElement>('fd-top-img').src = top.a.photos[0]
    $('fd-top-name').textContent = kindName(top.a.kind)
    $('fd-top-meta').textContent = facts(top.a)
    $('fd-top-where').textContent = `${where} 보호소`
    // 실사화해서 쓰다듬을 수 있는 아이면 바로 만나러 가기
    const pet = $<HTMLAnchorElement>('fd-pet')
    pet.hidden = true
    pettable.then((ids) => {
      pet.hidden = !ids.has(top.a.id)
      pet.href = `./?pet=shelter-${top.a.id}`
    })
    for (const id of ['fd-top-link', 'fd-notice']) {
      const el = $<HTMLAnchorElement>(id)
      el.href = `adopt?id=${top.a.id}`
      el.onclick = () => track('adopt_action', { how: 'notice', where: 'find' })
    }
  }
  const who = name ? josa(name, '이랑', '랑') : '우리 아이랑'
  $('fd-title').innerHTML = ''
  $('fd-title').append(top ? `${who} 꼭 닮은 친구가` : '지금은 닮은 친구를', document.createElement('br'), top ? `${where}에 있어요` : '찾지 못했어요')
  // 닮은 이유 (줄 목록)
  const reasons = top ? top.why.split(' · ').map((r) => r.replace(/^털색도/, '털색이')) : []
  $('fd-why').replaceChildren(
    ...reasons.map((r) => {
      const li = document.createElement('li')
      li.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-check" /></svg>'
      li.append(r)
      return li
    }),
  )
  // 다른 닮은 친구
  const rest = picks.slice(1)
  $('fd-more-label').hidden = !rest.length
  $('fd-list').replaceChildren(...rest.map((p) => moreCard(p.a, p.why)))
  $('fd-ask').hidden = true
  $('fd-result').hidden = false
  for (const id of ['fd-share', 'fd-notice']) $(id).hidden = !top
  if (!top) $('fd-pet').hidden = true
  window.scrollTo(0, 0)
  track('find_result', { species: sp, breed: mine.label, found: picks.length, gen: landedGen() || undefined })
}

/** 지역을 짧게: '충청남도 아산시' → '충남 아산', '서울특별시 마포구' → '서울 마포' */
const SIDO: Record<string, string> = { 서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천', 광주광역시: '광주', 대전광역시: '대전', 울산광역시: '울산', 세종특별자치시: '세종', 경기도: '경기', 강원특별자치도: '강원', 강원도: '강원', 충청북도: '충북', 충청남도: '충남', 전북특별자치도: '전북', 전라북도: '전북', 전라남도: '전남', 경상북도: '경북', 경상남도: '경남', 제주특별자치도: '제주' }
function shortRegion(org: string) {
  const [sido = '', gu = ''] = org.split(' ')
  return [SIDO[sido] ?? sido, gu.replace(/(시|군|구)$/, '')].filter(Boolean).join(' ')
}

/** 품종 이름: 공고의 '페르시안-페르시안 친칠라'처럼 겹친 이름은 뒤쪽(자세한 이름)만 */
function kindName(kind: string) {
  return kind.includes('-') ? kind.split('-').pop()!.trim() : kind
}

/** 성별 · 나이 (있는 것만) */
function facts(a: Animal) {
  const sex = a.sex === 'M' ? '남아' : a.sex === 'F' ? '여아' : ''
  return [sex, a.age].filter(Boolean).join(' · ')
}

/** 실사화해서 쓰다듬을 수 있는 아이 id (public/data/shelter-live.json) */
const pettable: Promise<Set<string>> = fetch(`${import.meta.env.BASE_URL}data/shelter-live.json`)
  .then((r) => (r.ok ? r.json() : { pets: [] }))
  .catch(() => ({ pets: [] }))
  .then((d: { pets: { id: string }[] }) => new Set(d.pets.map((p) => p.id)))

/** 다른 닮은 친구 카드: 아치문 사진(공고 원본) · 품종 · 지역과 닮은 이유 → 입양 공고 화면 */
function moreCard(a: Animal, why: string) {
  const link = Object.assign(document.createElement('a'), { className: 'fd-more-card', href: `adopt?id=${a.id}` })
  link.addEventListener('click', () => track('adopt_action', { how: 'notice', where: 'find' }))
  const door = Object.assign(document.createElement('span'), { className: 'fd-door' })
  const img = Object.assign(new Image(), { src: a.photos[0], alt: '', loading: 'lazy', decoding: 'async' })
  img.referrerPolicy = 'no-referrer'
  door.append(img)
  link.append(
    door,
    Object.assign(document.createElement('b'), { textContent: kindName(a.kind) }),
    Object.assign(document.createElement('small'), { textContent: [facts(a), shortRegion(a.org)].filter(Boolean).join(' · ') }),
    Object.assign(document.createElement('small'), { className: 'fd-more-why', textContent: why.split(' · ')[0] }),
  )
  return link
}

// 공유: 가장 닮은 아이의 공고로 바로 여는 링크 (마감일은 넣지 않는다)
// 공유: 정사각 포스터(기기 안에서 그림)를 먼저 보여 주고, 저장하거나 공유한다. 링크는 가장 닮은 아이의 공고 (마감일은 넣지 않는다)
const poster = $<HTMLDialogElement>('fd-poster')
let card: Blob | null = null
function shareLink() {
  const top = picks[0]!.a
  const u = new URL(`${import.meta.env.BASE_URL}adopt`, location.origin)
  u.searchParams.set('id', top.id)
  u.searchParams.set('from', 'share')
  for (const [k, v] of Object.entries(shareParams('find'))) u.searchParams.set(k, v)
  return u.toString()
}
function shareText() {
  const top = picks[0]!.a
  const name = $<HTMLInputElement>('fd-name').value.trim()
  return `${name ? `우리 ${josa(name, '이랑', '랑')}` : '우리 아이랑'} 닮은 친구가 보호소에서 가족을 기다려요 🐾\n${top.kind} · ${shortRegion(top.org)}\n고잉홈에서 만나 보세요`
}
$('fd-share').onclick = async () => {
  const top = picks[0]?.a
  if (!top) return
  track('share_click', { src: 'find' })
  const name = $<HTMLInputElement>('fd-name').value.trim()
  const btn = $<HTMLButtonElement>('fd-share')
  btn.disabled = true
  try {
    card = await drawShareCard({
      mine: $<HTMLImageElement>('fd-preview').src,
      mineName: name || '우리 아이',
      who: name ? `우리 ${josa(name, '이랑', '랑')}` : '우리 아이랑',
      friend: top.photos[0],
      friendKind: top.kind,
      friendWhere: shortRegion(top.org),
    })
    const url = URL.createObjectURL(card)
    $<HTMLImageElement>('fd-card').src = url
    $<HTMLAnchorElement>('fd-save').href = url
    poster.showModal()
  } catch {
    // 카드를 못 그리면 링크만 공유한다
    await sendLink()
  } finally {
    btn.disabled = false
  }
}
$('fd-save').addEventListener('click', () => track('share_done', { src: 'find', how: 'saved' }))
$('fd-send').onclick = async () => {
  const file = card ? new File([card], 'goinghome-닮은친구.png', { type: 'image/png' }) : null
  if (file && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text: `${shareText()}\n${shareLink()}` })
      track('share_done', { src: 'find', how: 'shared_card' })
      poster.close()
      return
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return
    }
  }
  await sendLink()
  poster.close()
}
$('fd-poster-close').onclick = () => poster.close()
poster.addEventListener('click', (e) => e.target === poster && poster.close())

/** 파일 공유가 안 되는 곳: 글과 링크만 공유하거나 복사 */
async function sendLink() {
  const text = shareText()
  const url = shareLink()
  let how = 'copied'
  if (navigator.share) {
    try {
      await navigator.share({ title: '고잉홈', text, url })
      how = 'shared'
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return
    }
  }
  if (how === 'copied') {
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`)
    } catch {
      prompt('아래 내용을 복사해 보내 주세요', `${text}\n${url}`)
    }
    toast('글과 링크를 복사했어요. 이미지는 저장해서 함께 보내 주세요.')
  }
  track('share_done', { src: 'find', how })
}

$('fd-again').onclick = () => {
  $('fd-result').hidden = true
  $('fd-ask').hidden = false
}
