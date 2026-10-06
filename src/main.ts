import './style.css'
import { registerPwa } from './pwa'
import { adChannel, landedGen, track } from './analytics'
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { HandTracker, HAND_CONNECTIONS, PALM_POINTS, isOfferingHand, isOpenHand, isPinchHand } from './hand'
import { Voice } from './voice'
import { Pet, type PetInput } from './pet'
import { FurRenderer, type MotionHand } from './fur'
import { FLOOR_Y, ADOPT_URL, PETS, assetUrl, canGivePaw, josa, type PetProfile } from './pets'
import { TreatTray } from './treatTray'
import { isShelter, loadShelterPets } from './shelterPets'
import { setClipRecorder, sharePet, shareSite, toast } from './share'
import { ClipRecorder, clipSupport } from './recorder'
import { clipOverlay, type Featured } from './clipOverlay'
import { findLookalikes } from './lookalike'
import { myPets, type MyPet } from './myPets'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const stage = $<HTMLCanvasElement>('stage')
const ctx = stage.getContext('2d')!
const video = $<HTMLVideoElement>('video')
const overlay = $<HTMLCanvasElement>('video-overlay')
const octx = overlay.getContext('2d')!
const camStatus = $('cam-status')
const intro = $('intro')
const introError = $('intro-error')
const tabs = $('pet-tabs')
const hud = $('debug-hud')

const tracker = new HandTracker(video)
/** "손!" 하고 말하면 앞발을 준다 (지원하는 브라우저만. 시작 버튼을 누를 때 켠다) */
const voice = new Voice(() => pet.commandPaw())
/** 음성 명령('손!') 켜기. 지금은 꺼 둔다: '손' 개인기를 보여 주지 않아 마이크 권한을 묻지 않는다 (2026-10-06, 코드는 남겨 둔다) */
const VOICE_ENABLED = false

/** 실사 털 셰이더. WebGL을 못 쓰거나 셰이더가 안 되는 기기에서는 null이고 캔버스 그림으로 그린다 */
const fur = (() => {
  try {
    return FurRenderer.create($<HTMLCanvasElement>('pet-gl'))
  } catch (err) {
    console.warn('털 셰이더를 쓸 수 없어 그림으로 표시합니다', err)
    return null
  }
})()
/** 셰이더 캔버스 배율. 프레임이 밀리면 낮춘다 (renderQuality) */
let glDpr = Math.min(window.devicePixelRatio || 1, 1.5)
const debug = new URLSearchParams(location.search).has('debug')
/** 공유용 짧은 영상 녹화: 털 셰이더 캔버스 위에 손끝·간식 캔버스를 겹쳐 담는다 (recorder.ts) */
export const recorder = new ClipRecorder([$<HTMLCanvasElement>('pet-gl'), stage])
hud.hidden = !debug
if (debug) {
  Object.assign(window, { __fur: fur, __tracker: tracker, __setPaused: (on: boolean) => setPaused(on), __recorder: recorder })
  // 테스트용: 현재 펫의 상태를 콘솔에서 보고 바꿀 수 있게
  Object.defineProperty(window, '__pet', { get: () => pet })
}

// ───────────────────────── 상태 ─────────────────────────

const STORAGE_KEY = 'sonkkeut.affection.v1'
const saved: Record<string, number> = (() => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
})()
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
  } catch {
    /* 저장이 안 돼도 동작에는 문제 없음 */
  }
}

let pet = new Pet(PETS[0], saved[PETS[0].id] ?? 0)
let W = 0
let H = 0
let scale = 1
let cx = 0
let cy = 0

interface Pt {
  x: number
  y: number
}
/** 화면에 그릴 손 (무대 좌표) */
interface HandView {
  id: string
  points: Pt[]
  open: boolean
  /** 손바닥을 위로 해서 '손 달라'고 내민 손 */
  offer: boolean
  /** 엄지·검지로 간식을 집은 손 */
  pinch: boolean
  palm: Pt
}
let handViews: HandView[] = []
/** 인식은 초당 30번 안팎이라, 그 사이 프레임은 부드럽게 따라가도록 손마다 보간한 좌표를 쓴다 */
const smoothed = new Map<string, Pt[]>()

// ───────────────────────── 레이아웃 ─────────────────────────

function resize() {
  const rect = stage.getBoundingClientRect()
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  W = rect.width
  H = rect.height
  stage.width = Math.round(W * dpr)
  stage.height = Math.round(H * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  fur?.resize(W, H, glDpr)
  // 펫은 로컬 좌표로 대략 폭 560, 높이 640을 차지한다
  scale = Math.min(W / 560, H / 660)
  cx = W / 2
  cy = H * 0.56
}
window.addEventListener('resize', resize)

const toLocal = (x: number, y: number) => ({ x: (x - cx) / scale, y: (y - cy) / scale })
const toStage = (x: number, y: number) => ({ x: cx + x * scale, y: cy + y * scale })

/** 카메라 화면의 가운데 영역을 무대 전체로 넓혀서, 팔을 크게 뻗지 않아도 닿게 한다 (좌우 반전 포함) */
function landmarkToStage(lm: NormalizedLandmark) {
  return {
    x: ((1 - lm.x - 0.12) / 0.76) * W,
    y: ((lm.y - 0.1) / 0.75) * H,
  }
}

// ───────────────────────── 탭 · 프로필 ─────────────────────────

function renderTabs() {
  // 고를 수 있는 아이: 실제 공고 아이(실사화한 아이)만. 예시 아이(초코·삼식)는 넣지 않는다 (2026-10-06)
  // 고퀄(✨) 먼저, 같으면 공고가 오래 남은 아이 먼저. 우리 아이(이벤트)는 목록에 넣지 않는다
  const shelter = PETS.filter(isShelter).sort(
    (a, b) => Number(!!b.adoption?.aiFrontal) - Number(!!a.adoption?.aiFrontal) || (b.adoption?.noticeEnd ?? '').localeCompare(a.adoption?.noticeEnd ?? ''),
  )
  const list = shelter
  tabs.replaceChildren(
    ...list.map((p) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'face' + (p.id === pet.p.id ? ' active' : '') })
      b.title = p.name
      b.setAttribute('aria-label', `${p.name}${p.adoption?.region ? `, ${p.adoption.region}` : ''}`)
      b.setAttribute('aria-pressed', String(p.id === pet.p.id))
      const img = Object.assign(new Image(), { src: p.photo?.src ?? (p.photos?.[0] ? assetUrl(p.photos[0]) : ''), alt: '', decoding: 'async' })
      b.append(img)
      b.onclick = () => selectPet(p)
      return b
    }),
  )
  // 고른 아이가 보이게 (목록이 넘치면 스크롤)
  tabs.querySelector('.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  renderBanner()
  renderHelp()
  syncInfoPanel()
}

// ───────────────────────── 간식 접시 ─────────────────────────

/** 무대 옆 간식 접시. 손 인식 쪽에서 hit/setHover/take로 쓴다 (treatTray.ts) */
export const treatTray = new TreatTray($('treat-tray'), stage, assetUrl('pets/treat.webp'))
if (debug) Object.assign(window, { __treatTray: treatTray })

// ───────────────────────── 공유 · 공유로 들어온 사람 ─────────────────────────

// 녹화가 되는 브라우저는 짧은 영상(끝 장면 포함)으로 공유한다 (길이는 share.ts)
/** 지금 공유를 누른 버튼 (카운트다운·녹화 중 표시용) */
let shareUi: HTMLButtonElement | null = null
const setShareLabel = (t: string | null) => {
  if (!shareUi) return
  shareUi.dataset.label ??= shareUi.textContent ?? ''
  shareUi.textContent = t ?? shareUi.dataset.label
}
if (clipSupport().ok) {
  setClipRecorder(async (seconds) => {
    const mine = isMine(pet.p)
    // 버튼을 누른 손을 들어 쓰다듬을 시간: 3초 세고 녹화한다
    for (let n = 3; n > 0; n--) {
      setShareLabel(`${n}초 뒤 녹화`)
      toast(`${n}… 손을 보여 주세요. ${seconds}초 동안 담아요`)
      await new Promise((r) => setTimeout(r, 1000))
    }
    setShareLabel('● 녹화 중')
    // 9:16 세로 (릴스·쇼츠·틱톡·스토리)
    const blob = await recorder.record(seconds, { width: 720, height: 1280, overlay: clipOverlay(pet.p, mine, seconds, featured ?? undefined) })
    return { blob, ext: clipSupport().ext }
  })
}

/**
 * 공유 영상 끝 장면에 넣을 실제 보호소 아이 (실사화한 공고 아이 중):
 * 보호소 아이를 공유하면 그 아이, 우리 아이면 털색이 닮은 아이, 그 밖에는 공고가 가장 빨리 끝나는 아이.
 * 사진은 우리 사이트에 있는 실사 얼굴이라 녹화 캔버스에 그릴 수 있다
 */
let featured: Featured | null = null
async function pickFeatured(): Promise<PetProfile | null> {
  const shelter = PETS.filter(isShelter)
  if (!shelter.length) return null
  if (isShelter(pet.p)) return pet.p
  const sp = pet.p.species
  const pool = shelter.map((p) => ({ id: p.id, sp: p.species, color: p.coat ?? '', end: p.adoption?.noticeEnd ?? '' }))
  let color: [number, number, number] | null = null
  if (isMine(pet.p)) color = (await myPets.get(pet.p.id).catch(() => undefined))?.color ?? null
  const pick = findLookalikes(pool, sp, color, 1)[0] ?? findLookalikes(pool, sp === 'dog' ? 'cat' : 'dog', null, 1)[0]
  return pick ? (shelter.find((p) => p.id === pick.id) ?? null) : null
}
async function loadFeatured(p: PetProfile | null): Promise<Featured | null> {
  if (!p?.photo) return null
  const img = new Image()
  img.src = p.photo.src
  try {
    await img.decode()
  } catch {
    return null
  }
  return {
    img,
    line: [p.name, p.adoption?.region.split(' ').slice(0, 2).join(' ')].filter(Boolean).join(' · '),
  }
}

/** 이 아이 입양 정보 공유: 쓰다듬는 짧은 영상(끝 장면에 그 아이) + 입양 정보 글 + 그 아이로 바로 가는 링크 */
async function shareThisPet(btn: HTMLButtonElement) {
  // 휴대폰 상세 시트가 열려 있으면 닫고(무대가 보여야 녹화된다) 공유한다
  if (info.open && info.matches(':modal')) info.close()
  btn.disabled = true
  shareUi = btn
  try {
    const target = await pickFeatured()
    featured = await loadFeatured(target)
    const r = await sharePet(pet.p, isMine(pet.p), (on) => (on ? null : setShareLabel(null)), target?.id)
    if (r === 'copied') toast('입양 정보와 링크를 복사했어요. 친구에게 붙여 넣어 보내 주세요.')
    if (r === 'downloaded') toast('영상을 저장했어요. 인스타그램을 열고 릴스나 스토리에 올려 주세요. 입양 정보와 링크도 복사해 뒀어요.')
  } finally {
    setShareLabel(null)
    shareUi = null
    btn.disabled = false
  }
}
$('info-share').onclick = (e) => shareThisPet(e.currentTarget as HTMLButtonElement)
// 입양 행동 (보호소 전화·공고 보기): 공유만 하고 끝나지 않는지 본다
for (const id of ['card-call', 'info-adopt'])
  $(id).addEventListener('click', (e) => {
    const href = (e.currentTarget as HTMLAnchorElement).getAttribute('href') ?? ''
    track('adopt_action', { how: href.startsWith('tel:') ? 'call' : 'notice', where: 'home', gen: landedGen() || undefined })
  })
$('card-share').onclick = (e) => shareThisPet(e.currentTarget as HTMLButtonElement)

/** 고잉홈(사이트) 공유: 첫 화면 링크 */
$('share-site').onclick = async () => {
  const r = await shareSite()
  if (r === 'copied') toast('고잉홈 링크를 복사했어요.')
}

// 공유 링크(?from=share)로 들어온 사람: 인사를 바꾸고, 쓰다듬기 시작 20초 뒤 '우리 아이도 쓰다듬어 보세요'를 띄운다 (존댓말)
const fromShare = new URLSearchParams(location.search).get('from') === 'share'
let invited = false
let firstPetSent = false
function inviteToMake() {
  if (!fromShare || invited || import.meta.env.VITE_DEMO === '1') return
  invited = true
  setTimeout(() => {
    const el = Object.assign(document.createElement('div'), { className: 'make-invite' })
    el.setAttribute('role', 'status')
    el.innerHTML = '<span>🐾 우리 아이도 손끝으로 쓰다듬어 보세요</span><a class="make-invite-go" href="make.html">우리 아이 만들기</a><button class="make-invite-close" type="button" aria-label="닫기">✕</button>'
    el.querySelector('button')!.onclick = () => el.remove()
    el.querySelector('a')!.onclick = () => track('invite_click', { gen: landedGen(), from: 'share' })
    document.querySelector('.stage-wrap')!.append(el)
  }, 20_000)
}
if (fromShare) {
  intro.querySelector('h1')!.textContent = '친구가 고잉홈을 보냈어요'
  intro.querySelector('.card-emoji')!.textContent = '💌'
}

// ───────────────────────── 도움말 ─────────────────────────

const help = $('help')
const helpToggle = $('help-toggle')
const HELP_KEY = 'sonkkeut.help.v1'
const ZONE_LABEL = { head: '머리', chin: '턱 밑', body: '등' } as const

function renderHelp() {
  const p = pet.p
  const cat = p.species === 'cat'
  $('help-title').textContent = `${josa(p.name, '과', '와')} 교감하는 법`
  const steps: [string, string][] = [
    mouseSim
      ? ['👆', '손가락이나 마우스로 아이를 살살 문질러 쓰다듬어 주세요. 손짓으로 쓰다듬으면 더 생생해요.']
      : ['✋', '카메라에 손바닥을 활짝 펴서 보여 주세요. 화면에 손끝 점 다섯 개가 나타나요.'],
    ...(p.shy
      ? ([
          [
            '👃',
            `${josa(p.name, '은', '는')} 겁이 많아요. 먼저 코 앞에 손바닥을 가만히 내밀어 냄새를 맡게 해 주세요. 간식을 받아먹어도 마음을 열어요.`,
          ],
        ] as [string, string][])
      : []),
    ['🫳', '손끝 점이 주황색이 되면 몸에 닿은 거예요. 살살 쓰다듬으면 털이 손길을 따라 누워요.'],
  ]
  // 사진 한 장으로 만든 아이(보호소·우리 아이)는 얼굴을 크게 움직이지 않는 대신 코·눈 반응이 있다
  const photoOnly = !p.photo?.expressions
  if (photoOnly) {
    steps.push(['👃', '코앞에 손바닥을 가만히 대면 킁킁 냄새를 맡아요.'])
    steps.push(['👀', '손을 천천히 움직이면 눈으로 따라와요.'])
  } else {
    steps.push(['💛', `${ZONE_LABEL[p.favorite]}${p.favorite === 'chin' ? '을 긁어' : '를 쓰다듬어'} 주면 가장 좋아해요.`])
    if (cat) steps.push(['😌', '고양이는 기분이 좋으면 눈을 지그시 감아요.'])
  }
  steps.push(['⚡', '너무 빨리 움직이면 깜짝 놀라요. 양손으로 쓰다듬어도 돼요.'])
  $('help-steps').replaceChildren(
    ...steps.map(([icon, text]) => {
      const li = document.createElement('li')
      li.append(Object.assign(document.createElement('span'), { className: 'help-icon', textContent: icon }), text)
      return li
    }),
  )
  // 특별한 교감: 간식 주기(모두), '손' 개인기(체크된 강아지만)
  const specials: [string, string][] = [
    [
      cat ? '🐟 츄르 주기' : '🍗 간식 주기',
      cat
        ? `왼쪽 접시 위에서 엄지와 검지 끝을 모아 츄르를 집고, ${p.name} 입 앞에 가만히 대 보세요. 혀로 날름날름 핥아 먹어요.`
        : `왼쪽 간식 접시 위에서 엄지와 검지 끝을 모아 간식을 집고, ${p.name} 입 앞에 가만히 대 보세요. 냄새를 맡고 세 입에 나눠 받아먹어요.`,
    ],
  ]
  if (canGivePaw(p)) {
    specials.push([
      "🐾 개인기 '손'",
      `턱 아래 왼쪽이나 오른쪽에 손바닥을 위로 펴고 1초쯤 가만히 내밀면, ${josa(p.name, '이', '가')} 그쪽 앞발을 올려요. 정가운데에서는 앞발을 주지 않아요. 양손을 내밀면 두 앞발을 모두 올려요. "손!" 하고 말해도 돼요.`,
    ])
  }
  $('help-trick').replaceChildren(
    ...specials.map(([title, text]) => {
      const box = document.createElement('div')
      box.className = 'help-special'
      box.append(
        Object.assign(document.createElement('b'), { textContent: title }),
        Object.assign(document.createElement('p'), { textContent: text }),
      )
      return box
    }),
  )
}

function setHelp(open: boolean) {
  help.hidden = !open
  helpToggle.setAttribute('aria-expanded', String(open))
  try {
    localStorage.setItem(HELP_KEY, open ? 'open' : 'closed')
  } catch {
    /* 기억 못 해도 괜찮다 */
  }
}
helpToggle.onclick = () => setHelp(help.hidden !== false)
$('help-close').onclick = () => setHelp(false)
// 처음 온 사람에게는 펼쳐 둔다. 휴대폰은 화면이 좁아서 버튼만 두고, 직접 닫았으면 다음에도 닫아 둔다
setHelp(
  ((): boolean => {
    try {
      const v = localStorage.getItem(HELP_KEY)
      if (v) return v === 'open'
    } catch {
      /* 무시 */
    }
    return window.matchMedia('(min-width: 721px)').matches
  })(),
)

/** 사용자가 만든 '우리 아이' (기기 안에만 있는 아이) */
function isMine(p: PetProfile) {
  return p.id.startsWith('mine-')
}

function renderBanner() {
  const p = pet.p
  // 고양이는 모두 츄르 (2026-10-06 결정), 강아지는 간식 큐브
  const churu = p.species === 'cat'
  treatTray.setTreat(assetUrl(churu ? 'pets/churu.webp' : 'pets/treat.webp'), churu ? 'churu' : 'cube')
  // 휴대폰 아래 카드: 이름 · 정보 · 마감 + 입양 문의
  const a = p.adoption
  $('info-banner-title').innerHTML = ''
  $('info-banner-title').append(p.name)
  if (a?.aiFrontal) $('info-banner-title').append(Object.assign(document.createElement('i'), { className: 'hq-badge', textContent: '✨ 생생' }))
  $('info-banner-sub').textContent = [p.sex, p.age, a?.region.split(' ').slice(0, 2).join(' ')].filter(Boolean).join(' · ')
  $('card-due').textContent = a?.noticeEnd ? `${Number(a.noticeEnd.slice(4, 6))}월 ${Number(a.noticeEnd.slice(6, 8))}일까지 가족을 찾아요` : ''
  const call = $<HTMLAnchorElement>('card-call')
  if (a?.tel) {
    call.href = `tel:${a.tel.replace(/[^\d+]/g, '')}`
    call.removeAttribute('target')
    call.textContent = '☎ 입양 문의'
  } else {
    call.href = a?.url ?? ADOPT_URL
    call.removeAttribute('target')
    call.textContent = '입양 공고 보기'
  }
  const thumb = $<HTMLImageElement>('info-thumb')
  // 썸네일은 셰이더가 이미 불러온 얼굴 사진을 써서 따로 내려받지 않는다
  const src = p.photo?.src ?? (p.photos?.length ? assetUrl(p.photos[0]) : undefined)
  thumb.hidden = !src
  if (src) thumb.src = src
}

// 아이 정보 → 입양 문의. 시트를 열 때만 DOM을 채워서 매 프레임 루프에는 영향이 없다
const info = $<HTMLDialogElement>('info')
const FAVORITE_LABEL = { head: '머리 쓰다듬기', chin: '턱 밑 긁기', body: '등 쓰다듬기' } as const

const slides = $('info-slides')
const dots = $('info-dots')

function fillGallery(p: PetProfile) {
  const srcs = p.photos?.length ? p.photos.map(assetUrl) : p.photo ? [p.photo.src] : []
  $('info-gallery').hidden = srcs.length === 0
  // 사진이 있으면 이모지 아이콘은 뺀다
  $('info-emoji').hidden = srcs.length > 0
  slides.replaceChildren(
    ...srcs.map((src, i) => {
      const img = new Image()
      img.src = src
      img.alt = `${p.name} 사진 ${i + 1}`
      img.decoding = 'async'
      if (i > 0) img.loading = 'lazy'
      return img
    }),
  )
  dots.replaceChildren(...srcs.map(() => document.createElement('i')))
  const many = srcs.length > 1
  dots.hidden = !many
  $('info-prev').hidden = !many
  $('info-next').hidden = !many
  slides.scrollLeft = 0
  markSlide()
}

/** 지금 보이는 사진 번호를 점과 화살표에 반영한다 (스크롤할 때만) */
function markSlide() {
  const n = slides.children.length
  const i = Math.round(slides.scrollLeft / Math.max(1, slides.clientWidth))
  ;[...dots.children].forEach((d, k) => d.classList.toggle('on', k === i))
  $<HTMLButtonElement>('info-prev').disabled = i <= 0
  $<HTMLButtonElement>('info-next').disabled = i >= n - 1
}
slides.addEventListener('scroll', markSlide, { passive: true })
const slideBy = (d: number) => slides.scrollBy({ left: d * slides.clientWidth, behavior: 'smooth' })
$('info-prev').onclick = () => slideBy(-1)
$('info-next').onclick = () => slideBy(1)
slides.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault()
    slideBy(e.key === 'ArrowLeft' ? -1 : 1)
  }
})

function fillInfo(p: PetProfile) {
  fillGallery(p)
  $('info-emoji').textContent = p.species === 'dog' ? '🐶' : '🐱'
  $('info-name').textContent = p.name
  // 공고 아이는 이름이 곧 품종이라 겹치지 않게
  $('info-meta').textContent = [p.breed !== p.name ? p.breed : '', p.sex, p.age].filter(Boolean).join(' · ')
  const end = p.adoption?.noticeEnd
  $('info-due').textContent = end ? `${Number(end.slice(4, 6))}월 ${Number(end.slice(6, 8))}일까지 가족을 찾아요` : ''

  const traits = [...(p.traits ?? []), `${FAVORITE_LABEL[p.favorite]} 좋아해요`]
  if (canGivePaw(p)) traits.push("'손' 할 줄 알아요 🐾")
  if (p.shy && !traits.some((t) => t.includes('낯'))) traits.unshift('겁이 많아요')
  $('info-traits').replaceChildren(
    ...traits.map((t) => Object.assign(document.createElement('li'), { textContent: t })),
  )

  $('info-story-wrap').hidden = !p.story
  $('info-story').textContent = p.story

  const a = p.adoption
  $('info-shelter-wrap').hidden = !a
  $('info-sample').hidden = !a?.sample
  $('info-shelter').replaceChildren(
    ...(a
      ? ([['보호소', a.shelter], ['지역', a.region], ['전화', a.tel], ['공고 마감', a.noticeEnd && `${a.noticeEnd.slice(4, 6)}월 ${a.noticeEnd.slice(6, 8)}일`], ['공고번호', a.noticeNo]] as const).flatMap(([k, v]) =>
          v ? [Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v })] : [],
        )
      : []),
  )

  const adopt = $<HTMLAnchorElement>('info-adopt')
  adopt.classList.toggle('tel', !!a?.tel)
  if (a?.tel) {
    // 공고 아이: 보호소에 바로 전화
    adopt.href = `tel:${a.tel.replace(/[^\d+]/g, '')}`
    adopt.removeAttribute('target')
    adopt.textContent = '전화로 입양 문의'
    $('info-adopt-note').textContent = a.aiFrontal
      ? '쓰다듬는 화면은 AI로 정면을 다시 그린 모습이라 실제와 조금 다를 수 있어요. 위 사진이 실제 공고 사진이에요. 출처: 농림축산식품부 국가동물보호정보시스템'
      : a.fromShelterPhoto
        ? '보호소 공고 사진으로 만든 모습이에요. 출처: 농림축산식품부 국가동물보호정보시스템'
        : ''
  } else {
    adopt.href = a?.url ?? ADOPT_URL
    adopt.removeAttribute('target')
    adopt.textContent = '입양 공고 보기'
    $('info-adopt-note').textContent = a?.url
      ? `${josa(p.name, '이의', '의')} 입양 공고를 열어요. 출처: 농림축산식품부 국가동물보호정보시스템`
      : `${josa(p.name, '은', '는')} 예시 아이라 전체 입양 공고 화면이 열려요. 출처: 농림축산식품부 국가동물보호정보시스템`
  }
}

const wide = window.matchMedia('(min-width: 960px)')
/** PC: 상세를 오른쪽 패널로 늘 열어 두고 지금 아이로 채운다. 휴대폰: 패널을 닫아 둔다 (시트로만) */
function syncInfoPanel() {
  if (wide.matches) {
    if (info.open && info.matches(':modal')) info.close()
    fillInfo(pet.p)
    if (!info.open) info.show()
  } else if (info.open && !info.matches(':modal')) {
    info.close()
  }
}
wide.addEventListener('change', syncInfoPanel)

$('info-open').onclick = () => {
  fillInfo(pet.p)
  // 시트를 보는 동안은 손 인식과 셰이더를 멈춰 배터리를 아낀다 (닫히면 close 이벤트에서 다시 켠다)
  setPaused(true)
  info.showModal()
  info.querySelector('.sheet-body')!.scrollTop = 0
}
$('info-close').onclick = () => info.close()
info.addEventListener('close', () => setPaused(false))
// 시트 바깥(어두운 배경)을 누르면 닫는다
info.addEventListener('click', (e) => {
  if (e.target === info) info.close()
})

function selectPet(p: PetProfile) {
  saved[pet.p.id] = pet.affection
  persist()
  pet = new Pet(p, saved[p.id] ?? 0)
  loadPhoto(p)
  renderTabs()
}

// ───────────────────────── 입력 (카메라 전용) ─────────────────────────

const startBtn = $<HTMLButtonElement>('start-camera')

async function startCamera() {
  // 사용자가 누른 순간에만 마이크를 켤 수 있어서 카메라를 기다리기 전에 켠다
  if (VOICE_ENABLED) voice.start()
  introError.hidden = true
  startBtn.disabled = true
  startBtn.innerHTML = '<b>카메라 준비 중…</b>'
  try {
    await tracker.start()
    overlay.width = video.videoWidth
    overlay.height = video.videoHeight
    intro.hidden = true
    inviteToMake()
  } catch (err) {
    const msg =
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? '카메라 권한이 거부되었어요. 브라우저 주소창의 카메라 아이콘에서 허용한 뒤 다시 시도해 주세요.'
        : err instanceof DOMException && err.name === 'NotFoundError'
          ? '카메라를 찾지 못했어요. 전면 카메라가 있는 기기에서 접속해 주세요.'
          : err instanceof Error
            ? err.message
            : '카메라를 시작하지 못했어요.'
    introError.textContent = msg
    introError.hidden = false
    startBtn.innerHTML = '<b>✋ 다시 시도하기</b><small>또는 아래 화면 문지르기로 시작해요</small>'
  } finally {
    startBtn.disabled = false
  }
}

startBtn.onclick = startCamera
$('start-touch').onclick = startTouch

/** 보이는 손(최대 2개)마다 손바닥 중심을 펫에 전달한다 */
function currentInputs(now: number, dt: number): PetInput[] {
  const tracked = mouseSim
    ? simulatedHands()
    : tracker.update(now).map((h) => ({
        id: h.id,
        raw: h.landmarks.map(landmarkToStage),
        open: isOpenHand(h.landmarks),
        offer: isOfferingHand(h.landmarks, (video.videoWidth || 4) / (video.videoHeight || 3)),
        pinch: isPinchHand(h.landmarks, (video.videoWidth || 4) / (video.videoHeight || 3)),
      }))

  // 시상수 약 25ms: 인식 사이 프레임을 메우고 손 떨림을 줄이되, 지연은 거의 느껴지지 않게
  const a = 1 - Math.exp(-dt * 40)
  for (const id of smoothed.keys()) if (!tracked.some((t) => t.id === id)) smoothed.delete(id)
  handViews = tracked.map(({ id, raw, open, offer, pinch }) => {
    const prev = smoothed.get(id)
    const points = prev ? prev.map((q, i) => ({ x: q.x + (raw[i].x - q.x) * a, y: q.y + (raw[i].y - q.y) * a })) : raw
    smoothed.set(id, points)
    const palm = PALM_POINTS.reduce(
      (acc, i) => ({ x: acc.x + points[i].x / PALM_POINTS.length, y: acc.y + points[i].y / PALM_POINTS.length }),
      { x: 0, y: 0 },
    )
    return { id, points, open, offer, pinch, palm }
  })

  if (tracker.running || mouseSim) {
    const open = handViews.filter((h) => h.open).length
    camStatus.textContent =
      handViews.length === 0
        ? '손을 화면에 보여주세요'
        : open === 0
          ? '손바닥을 활짝 펴주세요'
          : open === 2
            ? '양손으로 살살 쓰다듬어 보세요'
            : '좋아요! 살살 쓰다듬어 보세요 (양손도 돼요)'
  }
  return handViews.map((h) => ({
    id: h.id,
    ...toLocal(h.palm.x, h.palm.y),
    active: h.open,
    offer: h.offer,
    pinch: h.pinch,
    points: h.points.map((q) => toLocal(q.x, q.y)),
  }))
}

/**
 * ?debug=mouse 전용: 카메라 없이 마우스를 누른 채 움직여 편 손을 흉내낸다 (셰이더와 반응 확인용).
 * Shift를 누르고 있으면 펫을 중심으로 좌우 대칭인 손이 하나 더 생긴다 (양손 확인용).
 * 일반 접속에서는 README대로 카메라 입력만 받는다.
 */
/**
 * 체험판(VITE_DEMO=1 빌드, 아티팩트 공유용): 카메라를 쓸 수 없는 곳이라 손가락·마우스로 문질러 쓰다듬는다.
 * '간식 집기'를 켜면 손끝 모은 손(집은 손)이 된다
 */
const demo = import.meta.env.VITE_DEMO === '1'
let demoPinch = false
/** 화면 문지르기(손가락·마우스)로 쓰다듬는 중. 진입 화면에서 고르거나, 체험판·?debug=mouse면 처음부터 */
let mouseSim = false
let simPointer: { x: number; y: number; both: boolean; offer: boolean; pinch: boolean } | null = null
/** 손바닥 중심 기준 편 손 21개 점 (펫 로컬 단위, 손가락이 위) */
const SIM_HAND: [number, number][] = [
  [0, 55], [-25, 40], [-45, 25], [-60, 10], [-72, -5],
  [-25, -25], [-30, -55], [-33, -75], [-35, -95],
  [-5, -30], [-5, -65], [-5, -88], [-5, -110],
  [15, -27], [18, -58], [20, -80], [22, -98],
  [32, -18], [40, -42], [45, -58], [48, -72],
]
function simulatedHands() {
  if (!simPointer) return []
  const c = toLocal(simPointer.x, simPointer.y)
  // Ctrl(맥은 Cmd)을 누르고 있으면 엄지와 검지 끝을 맞대 간식을 집은 손 (두 손끝이 마우스 자리에서 만난다)
  const pinch = simPointer.pinch
  const hand = (id: string, cx: number, flip: number) => ({
    id,
    raw: SIM_HAND.map(([x, y], i) =>
      pinch && (i === 4 || i === 8) ? toStage(cx, c.y) : pinch ? toStage(cx + x * flip, c.y + y + 90) : toStage(cx + x * flip, c.y + y),
    ),
    open: !pinch,
    // Alt를 누르고 있으면 손바닥을 위로 해서 '손 달라'고 내민 손으로 흉내낸다
    offer: simPointer!.offer,
    pinch,
  })
  const hands = [hand('Right', c.x, 1)]
  if (simPointer.both) hands.push(hand('Left', -c.x, -1))
  return hands
}
/** 화면 문지르기로 시작: 손가락·마우스가 손 하나가 되고, 위에 '간식 집기' 버튼을 띄운다 */
function startTouch() {
  if (mouseSim) return
  mouseSim = true
  intro.hidden = true
  document.body.classList.add('touch')
  inviteToMake()
  const at = (e: PointerEvent) => {
    const r = stage.getBoundingClientRect()
    simPointer = { x: e.clientX - r.left, y: e.clientY - r.top, both: e.shiftKey, offer: e.altKey, pinch: e.ctrlKey || e.metaKey || demoPinch }
  }
  stage.addEventListener('pointerdown', at)
  stage.addEventListener('pointermove', (e) => e.buttons && at(e))
  stage.addEventListener('pointerup', () => (simPointer = null))
  stage.addEventListener('pointerleave', () => (simPointer = null))
  const bar = Object.assign(document.createElement('div'), { className: 'demo-bar' })
  bar.innerHTML = demo
    ? '<span class="demo-long">체험판 · 손가락이나 마우스로 문질러 쓰다듬어 보세요 (실제 앱은 카메라로 손을 인식해요)</span><span class="demo-short">체험판 · 손가락으로 문질러요</span>'
    : '<span class="demo-long">손가락이나 마우스로 살살 문질러 주세요</span><span class="demo-short">살살 문질러 주세요</span>'
  const pinchBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'demo-pinch' })
  const label = () => (demoPinch ? '✋ 쓰다듬기로' : pet.p.species === 'cat' ? '🐟 츄르 집기' : '🍗 간식 집기')
  pinchBtn.textContent = label()
  pinchBtn.setAttribute('aria-pressed', 'false')
  pinchBtn.onclick = () => {
    demoPinch = !demoPinch
    pinchBtn.setAttribute('aria-pressed', String(demoPinch))
    pinchBtn.textContent = label()
  }
  bar.append(pinchBtn)
  document.querySelector('.stage-wrap')!.append(bar)
  renderHelp()
}
if (demo || new URLSearchParams(location.search).get('debug') === 'mouse') startTouch()

// ───────────────────────── 루프 ─────────────────────────

let last = performance.now()

function frame(now: number) {
  // 첫 프레임은 rAF 시각이 모듈을 읽은 시각(last)보다 이를 수 있어 음수가 된다. 음수 dt는 "손!" 명령 타이머 등을 거꾸로 돌려 엉뚱하게 켠다
  const dt = Math.max(0, Math.min(0.05, (now - last) / 1000))
  const frameMs = now - last
  last = now
  const workStart = performance.now()

  const inputs = currentInputs(now, dt)
  if (debug) (window as unknown as { __lastInputs: PetInput[] }).__lastInputs = inputs
  // 하트와 말풍선은 쓰지 않는다 (펫 로직이 내는 이벤트는 무시)
  updateTray()
  pet.update(dt, inputs)

  // 마음의 거리는 화면에 보이지 않지만, 쓰다듬을수록 편안해지는 표정과 겁 많은 아이의 기억에 쓰여 저장해 둔다
  saved[pet.p.id] = pet.affection

  updateFur(dt, inputs)
  draw()
  // 녹화 중이면 방금 그린 화면을 녹화 캔버스에 합친다 (WebGL 내용은 같은 프레임 안에서만 남아 있다)
  recorder.captureFrame()
  drawCameraOverlay()
  renderQuality(frameMs, dt, performance.now() - workStart)
  raf = requestAnimationFrame(frame)
}

// ───────────────────────── 일시정지 ─────────────────────────

let paused = false
/** 예약된 다음 프레임 (멈출 때 취소해서, 빨리 껐다 켜도 루프가 두 개로 늘지 않게) */
let raf = 0

/**
 * 화면 위에 시트 등을 띄워 동물이 가려질 때 부른다: setPaused(true)로 멈추고, 닫을 때 setPaused(false).
 * 멈춘 동안은 그리기·셰이더·손 인식(워커 추론과 카메라 영상 디코딩)이 모두 쉬어 폰 배터리를 아낀다.
 * 카메라 권한과 스트림은 유지하므로 다시 켜는 데 지연이 없다. 화면에는 멈추기 직전 모습이 남는다.
 */
export function setPaused(on: boolean) {
  if (on === paused) return
  paused = on
  if (on) {
    cancelAnimationFrame(raf)
    tracker.pause()
    voice.setActive(false)
    return
  }
  // 다시 시작: 멈추기 전 손 기록을 버려서, 순간이동한 손에 아이가 놀라지 않게 한다
  tracker.resume()
  voice.setActive(true)
  pet.forgetHands()
  smoothed.clear()
  handViews = []
  lastHandPx.clear()
  lastTipPx.clear()
  tipTouch.clear()
  last = performance.now()
  raf = requestAnimationFrame(frame)
}

// ───────────────────────── 실사 털 ─────────────────────────

function photoActive() {
  return !!fur && !!pet.p.photo && fur.ready(pet.p.photo)
}

function loadPhoto(p: PetProfile) {
  if (!fur || !p.photo) return
  fur.load(p.photo).catch((err) => console.warn('실사 사진을 불러오지 못해 그림으로 표시합니다', err))
}

const lastHandPx = new Map<string, Pt>()
/** 손끝마다 지난 위치 (사진 픽셀). 손끝이 지나간 자리의 털을 가늘게 눕힌다 */
const lastTipPx = new Map<string, Pt>()
/** 화면에 그릴 때 손끝이 몸에 닿았는지 (손 id → 손끝 번호별) */
const tipTouch = new Map<string, boolean[]>()

/**
 * 손마다 사진 좌표로 바꿔 털과 얼굴 움직임에 넘긴다.
 * 편 손이 몸에 닿으면 털이 눕고 얼굴이 끌려가고, 가까이서 흔들기만 해도 털이 살랑이고 고개가 따라온다.
 */
function updateFur(dt: number, inputs: PetInput[]) {
  const rig = pet.p.photo
  if (!fur?.field || !fur.motion || !rig || !photoActive()) return
  const L = pet.L
  const hands: MotionHand[] = []
  const tipContacts = []
  const toPx = (p: Pt) => ({ x: p.x / rig.scale + rig.centerX, y: (p.y - FLOOR_Y) / rig.scale + rig.footY })
  for (const input of inputs) {
    const x = input.x / rig.scale + rig.centerX
    const y = (input.y - FLOOR_Y) / rig.scale + rig.footY
    const prev = lastHandPx.get(input.id)
    lastHandPx.set(input.id, { x, y })
    const pts = input.points
    const palm = pts.length === 21 ? Math.hypot(pts[0].x - pts[9].x, pts[0].y - pts[9].y) : 90
    // 앞발을 맞댄 손은 털·얼굴 반응에서 뺀다 (턱 아래라서 턱 들기로 잡히지 않게)
    if (pet.isBusyHand(input.id)) {
      lastHandPx.delete(input.id)
      tipTouch.set(input.id, [])
      continue
    }
    // 쓰다듬기는 편 손만 인정하지만, 턱을 받쳐 드는 건 손을 오므려도 된다
    const hit = pet.contactZone(input)
    const zone = input.active || hit === 'chin' ? hit : null
    const touch = !!zone
    // 공유 링크·광고로 들어온 사람이 처음 쓰다듬은 순간 (한 번만 센다)
    if (touch && !firstPetSent && (fromShare || adChannel())) {
      firstPetSent = true
      track('first_pet', { gen: landedGen(), pet: isShelter(pet.p) ? pet.p.id : undefined })
    }
    // 손끝: 몸에 닿은 손끝마다 털을 가늘게 눕힌다 (손가락으로 긁으면 빗질한 듯한 가는 결)
    const tips: Pt[] = []
    const touched: boolean[] = []
    if (pts.length === 21) {
      for (const i of Pet.TIPS) {
        const key = `${input.id}-${i}`
        const on = !!pet.zoneAt(pts[i].x, pts[i].y)
        touched.push(on)
        if (!on) {
          lastTipPx.delete(key)
          continue
        }
        const p = toPx(pts[i])
        const prevTip = lastTipPx.get(key)
        lastTipPx.set(key, p)
        tips.push(p)
        tipContacts.push({
          id: key,
          x: p.x,
          y: p.y,
          vx: prevTip ? (p.x - prevTip.x) / Math.max(dt, 1e-3) : 0,
          vy: prevTip ? (p.y - prevTip.y) / Math.max(dt, 1e-3) : 0,
          r: Math.max(18, (palm / rig.scale) * 0.22),
          touch: true,
        })
      }
    }
    tipTouch.set(input.id, touched)
    // 머리 타원을 1.6배로 넓힌 안쪽이면 '가까이'
    const hx = input.x / (L.headRx * 1.6)
    const hy = (input.y - L.headY) / (L.headRy * 1.6)
    hands.push({
      id: input.id,
      x,
      y,
      vx: prev ? (x - prev.x) / Math.max(dt, 1e-3) : 0,
      vy: prev ? (y - prev.y) / Math.max(dt, 1e-3) : 0,
      r: Math.max(40, (palm / rig.scale) * 0.85),
      touch,
      near: !touch && hx * hx + hy * hy < 1,
      zone,
      tips,
    })
  }
  for (const id of lastHandPx.keys()) if (!inputs.some((i) => i.id === id)) lastHandPx.delete(id)
  for (const id of tipTouch.keys()) if (!inputs.some((i) => i.id === id)) tipTouch.delete(id)
  fur.motion.update(dt, hands, pet.pose)
  fur.field.update(dt, [
    ...hands.filter((h) => h.touch || h.near).map((h) => ({ ...h, r: h.touch ? h.r : h.r * 1.6 })),
    ...tipContacts,
  ])
}

// ───────────────────────── 성능 ─────────────────────────

let frameEma = 16.7
let workEma = 0
let slowFor = 0
let hudTimer = 0

/**
 * 프레임이 계속 밀리면(평균 40fps 미만이 1.5초 이상) 셰이더 캔버스 배율을 한 단계씩 낮춘다.
 * 다시 올리지는 않는다: 오르내리며 화면이 흔들리는 것보다 한 번 안정되는 게 낫다.
 */
function renderQuality(frameMs: number, dt: number, workMs: number) {
  frameEma = frameEma * 0.95 + Math.min(frameMs, 100) * 0.05
  workEma = workEma * 0.95 + workMs * 0.05
  if (fur && photoActive()) {
    slowFor = frameEma > 25 ? slowFor + dt : 0
    if (slowFor > 1.5 && glDpr > 0.75) {
      glDpr = glDpr > 1 ? 1 : 0.75
      fur.resize(W, H, glDpr)
      slowFor = 0
    }
  }
  if (debug && (hudTimer -= dt) <= 0) {
    hudTimer = 0.25
    const st = tracker.stats
    hud.textContent = [
      `${(1000 / frameEma).toFixed(0)} fps · 메인 스레드 ${workEma.toFixed(1)}ms`,
      `그리기 ${photoActive() ? `실사 셰이더 (배율 ${glDpr})` : fur ? '그림 (사진 없음/로딩 중)' : '그림 (WebGL 없음)'}`,
      st.mode ? `손 인식 ${st.mode === 'worker' ? '워커' : '메인 스레드'} · ${st.inferMs.toFixed(1)}ms · ${st.detectFps.toFixed(0)}회/초` : '손 인식 대기',
      `손 모양 ${handViews.map((h) => (h.pinch ? '집은 손' : h.offer ? '내민 손' : h.open ? '편 손' : '오므림')).join(', ') || '-'} · 음성 ${voice.supported ? `"${voice.heard}"` : '지원 안 함'}`,
    ].join('\n')
  }
}


setInterval(persist, 5000)
window.addEventListener('pagehide', persist)

// ───────────────────────── 그리기 ─────────────────────────

function draw() {
  ctx.clearRect(0, 0, W, H)

  const photo = photoActive()
  if (photo) fur!.render(pet.pose, { cx, cy, scale, W, H })
  else fur?.clear()

  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(scale, scale)
  if (!photo) pet.draw(ctx)
  ctx.restore()

  drawHands()
}

/** 손은 그리지 않고 손끝 포인터만 그린다. 몸에 닿으면 주황, 아니면 흰 점 (밝은 털 위에서도 보이게 옅은 그림자와 테두리) */
function drawHands() {
  for (const { id, points: pts, open } of handViews) {
    const size = Math.hypot(pts[0].x - pts[9].x, pts[0].y - pts[9].y)
    const r = Math.max(5, size * 0.06)
    const touched = tipTouch.get(id)
    ctx.save()
    ctx.globalAlpha = open ? 1 : 0.6
    ctx.lineWidth = 1.5
    Pet.TIPS.forEach((i, k) => {
      const on = !!touched?.[k]
      ctx.shadowColor = on ? 'rgba(255, 138, 61, 0.7)' : 'rgba(0, 0, 0, 0.35)'
      ctx.shadowBlur = on ? 12 : 6
      ctx.fillStyle = on ? '#ff8a3d' : 'rgba(255, 255, 255, 0.95)'
      ctx.strokeStyle = on ? 'rgba(255, 255, 255, 0.9)' : 'rgba(74, 51, 34, 0.35)'
      ctx.beginPath()
      ctx.arc(pts[i].x, pts[i].y, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.shadowBlur = 0
      ctx.stroke()
    })
    ctx.restore()
    // 간식은 손끝 점 위에 (두 손끝이 간식을 집고 있는 것처럼)
    drawTreat(pet.treatOf(id), pts)
  }
}

/** 지난 프레임에 집고 있던 손 (집기가 시작되는 순간을 찾는다) */
const wasPinching = new Set<string>()

/**
 * 간식 접시: 손끝을 모으기 시작한 자리가 접시 위면 간식 하나를 그 손에 쥐여 준다 (손끝을 떼면 간식은 사라진다).
 * 간식을 들지 않은 손의 손끝(집는 손은 두 손끝 사이, 편 손은 검지 끝)이 접시 위에 오면 접시를 강조한다
 */
function updateTray() {
  let hover = false
  for (const h of handViews) {
    const pts = h.points
    const tip = h.pinch ? { x: (pts[4].x + pts[8].x) / 2, y: (pts[4].y + pts[8].y) / 2 } : pts[8]
    const over = treatTray.hit(tip.x, tip.y)
    if (h.pinch && !wasPinching.has(h.id) && over && treatTray.take()) pet.giveTreat(h.id)
    if (over && pet.treatOf(h.id) === 0) hover = true
  }
  wasPinching.clear()
  for (const h of handViews) if (h.pinch) wasPinching.add(h.id)
  treatTray.setHover(hover)
}

/** 간식 그림과, 한 입씩 베어 먹은 모양 (남은 입 수마다 한 번만 만들어 둔다) */
const treatImg = new Image()
treatImg.src = assetUrl('pets/treat.webp')
const treatStages: HTMLCanvasElement[] = []

function treatStage(left: number) {
  if (treatStages[left]) return treatStages[left]
  if (!treatImg.complete || !treatImg.naturalWidth) return null
  const w = treatImg.naturalWidth
  const h = treatImg.naturalHeight
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  g.drawImage(treatImg, 0, 0)
  // 위쪽(입 쪽)부터 둥글게 베어 문 자국
  g.globalCompositeOperation = 'destination-out'
  const bites: [number, number, number][] = [
    [0.3, 0.02, 0.3],
    [0.72, 0.08, 0.32],
    [0.5, 0.42, 0.42],
  ]
  for (const [bx, by, br] of bites.slice(0, 3 - left)) {
    g.beginPath()
    g.arc(bx * w, by * h, br * w, 0, Math.PI * 2)
    g.fill()
  }
  treatStages[left] = c
  return c
}

/** 엄지·검지 끝 사이에 간식을 그린다 (left: 남은 입 수, 0이면 다 먹어서 없다) */
/** 츄르 스틱 (츄르를 핥는 고양이, rig.lick) */
const churuImg = new Image()
churuImg.src = assetUrl('pets/churu.webp')

function drawTreat(left: number, pts: Pt[]) {
  if (left <= 0) return
  // 고양이 간식은 츄르 (접시도 츄르 스틱)
  if (pet.p.species === 'cat') return drawChuru(left, pts)
  const img = treatStage(left)
  if (!img) return
  const x = (pts[4].x + pts[8].x) / 2
  const y = (pts[4].y + pts[8].y) / 2
  // 크기는 아이 얼굴에 맞춘다 (손 크기는 카메라 거리마다 달라서, 손 기준이면 간식이 너무 작거나 커 보인다)
  const w = pet.L.headRx * 0.3 * scale
  const h = (w * img.height) / img.width
  ctx.save()
  ctx.shadowColor = 'rgba(60, 35, 15, 0.35)'
  ctx.shadowBlur = w * 0.15
  ctx.shadowOffsetY = w * 0.06
  ctx.drawImage(img, x - w / 2, y - h / 2, w, h)
  ctx.restore()
}

/** 츄르: 뜯은 위쪽이 입(손끝)을 향해 아래로 늘어진다. 핥을수록 짜 놓은 퓨레가 줄고 스틱이 납작해진다 */
function drawChuru(left: number, pts: Pt[]) {
  if (!churuImg.complete || !churuImg.naturalWidth) return
  const x = (pts[4].x + pts[8].x) / 2
  const y = (pts[4].y + pts[8].y) / 2
  const f = left / 3
  // 손에 든 츄르가 또렷이 보이게: 얼굴 반폭의 1.4배 길이 (짧으면 혀에 가려 보이지 않는다)
  const h = pet.L.headRx * 1.4 * scale
  const w = (h * churuImg.naturalWidth) / churuImg.naturalHeight
  // 남은 양만큼 위쪽(퓨레)을 덜 보이게: 다 먹을수록 위쪽 15%까지 잘라 낸다
  const cut = (1 - f) * 0.15
  const sy = churuImg.naturalHeight * cut
  const dh = h * (1 - cut)
  ctx.save()
  ctx.shadowColor = 'rgba(60, 35, 15, 0.3)'
  ctx.shadowBlur = w * 0.3
  ctx.drawImage(churuImg, 0, sy, churuImg.naturalWidth, churuImg.naturalHeight - sy, x - w / 2, y - h * 0.08, w, dh)
  ctx.restore()
}

function drawCameraOverlay() {
  if (!tracker.running) return
  octx.clearRect(0, 0, overlay.width, overlay.height)
  const w = overlay.width
  const h = overlay.height
  octx.lineWidth = Math.max(2, w / 160)
  for (const hand of tracker.latest) {
    const lm = hand.landmarks
    octx.strokeStyle = handViews.find((v) => v.id === hand.id)?.open ? '#7ee081' : '#ffb35c'
    octx.beginPath()
    for (const [a, b] of HAND_CONNECTIONS) {
      octx.moveTo(lm[a].x * w, lm[a].y * h)
      octx.lineTo(lm[b].x * w, lm[b].y * h)
    }
    octx.stroke()
  }
}

// ───────────────────────── 체험판 ─────────────────────────

if (demo) {
  document.body.classList.add('demo')
  // 공유·전체 공고(바깥 사진)는 체험판에서 쓸 수 없어 숨긴다
  for (const id of ['share-site', 'info-share', 'card-share']) $(id).hidden = true
  document.querySelector<HTMLElement>('.adopt-link')!.hidden = true
}

// ───────────────────────── 시작 ─────────────────────────

resize()
renderTabs()
loadPhoto(pet.p)
raf = requestAnimationFrame(frame)
loadMyPets()
// 실사화한 공고 아이들 (공고가 끝난 아이는 파일에서 이미 빠져 있다)
loadShelterPets().then((list) => {
  for (const p of list) if (!PETS.some((q) => q.id === p.id)) PETS.push(p)
  renderTabs()
  const want = new URLSearchParams(location.search).get('pet')
  const target = want && PETS.find((p) => p.id === want)
  if (target && target !== pet.p) selectPet(target)
  // 처음에는 예시 아이 대신 목록 맨 앞의 실제 공고 아이로 연다
  else if (!want && !isShelter(pet.p)) {
    const first = tabs.querySelector<HTMLButtonElement>('.face')
    first?.click()
  }
})

/**
 * 이 기기에 저장된 '우리 아이'(make.html에서 만든)를 탭 목록에 넣고, ?pet=mine-… 로 들어왔으면 바로 연다.
 * 사진은 IndexedDB에만 있고, 리그의 파일 경로(files의 키)를 objectURL로 바꿔 셰이더가 읽게 한다
 */
async function loadMyPets() {
  let list: MyPet[] = []
  try {
    list = await myPets.list()
  } catch {
    return // IndexedDB를 못 쓰는 환경 (사생활 보호 모드 등)
  }
  for (const m of list) if (m.rig && m.files && !PETS.some((p) => p.id === m.id)) PETS.push(myPetProfile(m))
  renderTabs()
  const want = new URLSearchParams(location.search).get('pet')
  const target = want && PETS.find((p) => p.id === want)
  if (target && target !== pet.p) selectPet(target)
}

function myPetProfile(m: MyPet): PetProfile {
  const files = m.files!
  const url = (key: string) => (files[key] ? URL.createObjectURL(files[key]) : key)
  const rig = m.rig!
  const ex = rig.expressions
  const cat = m.species === 'cat'
  return {
    id: m.id,
    name: m.name,
    species: m.species,
    breed: '',
    age: '',
    sex: '',
    story: '',
    tip: '손바닥으로 머리를 살살 쓰다듬어 보세요.',
    favorite: 'head',
    shy: false,
    fur: cat ? '#e8d6c2' : '#9a6a44',
    furDark: cat ? '#c9b29a' : '#6e4a2e',
    belly: '#f1dcc3',
    eye: '#3b2a1e',
    pattern: 'none',
    // 표정 사진·앞발 사진은 없다 (기기 안에서 AI 없이 만든 아이). 손 주기는 앞발 사진이 없어 자동으로 꺼진다
    photo: {
      ...rig,
      src: url(rig.src),
      flow: url(rig.flow),
      catchlight: rig.catchlight && url(rig.catchlight),
      // AI 표정 업그레이드를 했으면 표정 사진·움직임 아틀라스도 이 기기의 파일에서 읽는다 (maker/upgrade.ts)
      expressions: ex && {
        ...ex,
        pant: ex.pant && { ...ex.pant, src: url(ex.pant.src) },
        eyesClosed: ex.eyesClosed && { ...ex.eyesClosed, src: url(ex.eyesClosed.src) },
        earsBack: ex.earsBack && { ...ex.earsBack, src: url(ex.earsBack.src) },
        morph: ex.morph && { ...ex.morph, src: url(ex.morph.src) },
      },
    },
  }
}

registerPwa()
