import './style.css'
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { HandTracker, HAND_CONNECTIONS, PALM_POINTS, isOfferingHand, isOpenHand, isPinchHand } from './hand'
import { Voice } from './voice'
import { Pet, type PetInput } from './pet'
import { FurRenderer, type MotionHand } from './fur'
import { FLOOR_Y, PAWINHAND_URL, PETS, assetUrl, canGivePaw, josa, type PetProfile } from './pets'
import { TreatTray } from './treatTray'
import { renderAdoptLinks } from './adoptLinks'
import { setClipRecorder, sharePet, toast } from './share'
import { ClipRecorder, clipSupport } from './recorder'
import { clipOverlay } from './clipOverlay'
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
  tabs.innerHTML = ''
  for (const p of PETS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'pet-tab' + (p.id === pet.p.id ? ' active' : '')
    b.innerHTML = `<span>${p.species === 'dog' ? '🐶' : '🐱'}</span>${p.name}`
    b.onclick = () => selectPet(p)
    tabs.append(b)
  }
  // 우리 아이 만들기 (바이럴 입구)
  const make = Object.assign(document.createElement('a'), { href: 'make.html', className: 'pet-tab make-tab', textContent: '＋ 우리 아이' })
  tabs.append(make)
  renderBanner()
  renderHelp()
}

// ───────────────────────── 간식 접시 ─────────────────────────

/** 무대 옆 간식 접시. 손 인식 쪽에서 hit/setHover/take로 쓴다 (treatTray.ts) */
export const treatTray = new TreatTray($('treat-tray'), stage, assetUrl('pets/treat.webp'))
if (debug) Object.assign(window, { __treatTray: treatTray })

// ───────────────────────── 공유 · 공유로 들어온 사람 ─────────────────────────

// 녹화가 되는 브라우저는 짧은 영상(끝 장면 포함)으로 공유한다 (길이는 share.ts)
if (clipSupport().ok) {
  setClipRecorder(async (seconds) => {
    const mine = pet.p.id.startsWith('mine-')
    const host = new URL(import.meta.env.BASE_URL, location.origin).host + import.meta.env.BASE_URL.replace(/\/$/, '')
    // 버튼을 누른 손을 들어 쓰다듬을 시간: 3초 세고 녹화한다
    for (let n = 3; n > 0; n--) {
      shareBtn.querySelector('b')!.textContent = `${n}초 뒤`
      toast(`${n}… 손을 보여 주세요. ${seconds}초 동안 담아요`)
      await new Promise((r) => setTimeout(r, 1000))
    }
    shareBtn.querySelector('b')!.textContent = '녹화 중'
    const blob = await recorder.record(seconds, { overlay: clipOverlay(pet.p, mine, seconds, host) })
    return { blob, ext: clipSupport().ext }
  })
}

const shareBtn = $<HTMLButtonElement>('share-btn')
shareBtn.onclick = async () => {
  shareBtn.disabled = true
  try {
    const r = await sharePet(pet.p, pet.p.id.startsWith('mine-'), (on) => {
      shareBtn.classList.toggle('recording', on)
      if (!on) shareBtn.querySelector('b')!.textContent = '공유'
    })
    if (r === 'copied') toast('링크를 복사했어요. 친구에게 붙여 넣어 보내 주세요')
    if (r === 'downloaded') toast('영상을 저장하고 링크를 복사했어요')
  } finally {
    shareBtn.disabled = false
  }
}

// 공유 링크(?from=share)로 들어온 사람: 만들기와 입양 사이트를 먼저 보여 준다
if (new URLSearchParams(location.search).get('from') === 'share') {
  intro.querySelector('h1')!.textContent = '친구가 손끝 교감을 보냈어요'
  intro.querySelector('.card-emoji')!.textContent = '💌'
  const adopt = $('intro-adopt')
  adopt.hidden = false
  renderAdoptLinks(adopt)
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
    ['✋', '카메라에 손바닥을 활짝 펴서 보여 주세요. 화면에 손끝 점 다섯 개가 나타나요.'],
    ...(p.shy
      ? ([
          [
            '👃',
            `${josa(p.name, '은', '는')} 겁이 많아요. 먼저 코 앞에 손바닥을 가만히 내밀어 냄새를 맡게 해 주세요. 간식을 받아먹어도 마음을 열어요.`,
          ],
        ] as [string, string][])
      : []),
    ['🫳', '손끝 점이 주황색이 되면 몸에 닿은 거예요. 살살 쓰다듬어 주세요.'],
    ['💛', `${ZONE_LABEL[p.favorite]}${p.favorite === 'chin' ? '을 긁어' : '를 쓰다듬어'} 주면 가장 좋아해요.`],
    ['⚡', '너무 빨리 움직이면 깜짝 놀라요. 양손으로 쓰다듬어도 돼요.'],
  ]
  if (cat) steps.push(['😌', '고양이는 기분이 좋으면 눈을 지그시 감아요.'])
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
      '🍗 간식 주기',
      `왼쪽 간식 접시 위에서 엄지와 검지 끝을 모아 간식을 집고, ${p.name} 입 앞에 가만히 대 보세요. 냄새를 맡고 세 입에 나눠 받아먹어요.`,
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

function renderBanner() {
  const p = pet.p
  $('info-banner-title').textContent = `${josa(p.name, '이', '가')} 가족을 기다려요`
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
  $('info-meta').textContent = [p.breed, p.sex, p.age].filter(Boolean).join(' · ')

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
      ? ([['보호소', a.shelter], ['지역', a.region], ['공고번호', a.noticeNo]] as const).flatMap(([k, v]) =>
          v ? [Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v })] : [],
        )
      : []),
  )

  const adopt = $<HTMLAnchorElement>('info-adopt')
  adopt.href = a?.url ?? PAWINHAND_URL
  $('info-adopt-note').textContent = a?.url
    ? `포인핸드에서 ${josa(p.name, '이의', '의')} 공고를 열어요.`
    : `포인핸드로 이동해요. ${josa(p.name, '은', '는')} 예시 아이라 실제 공고 대신 포인핸드 첫 화면이 열려요.`
}

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
  voice.start()
  introError.hidden = true
  startBtn.disabled = true
  startBtn.textContent = '카메라 준비 중…'
  try {
    await tracker.start()
    overlay.width = video.videoWidth
    overlay.height = video.videoHeight
    intro.hidden = true
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
    startBtn.textContent = '다시 시도하기'
  } finally {
    startBtn.disabled = false
  }
}

startBtn.onclick = startCamera

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
const mouseSim = new URLSearchParams(location.search).get('debug') === 'mouse'
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
if (mouseSim) {
  intro.hidden = true
  const at = (e: PointerEvent) => {
    const r = stage.getBoundingClientRect()
    simPointer = { x: e.clientX - r.left, y: e.clientY - r.top, both: e.shiftKey, offer: e.altKey, pinch: e.ctrlKey || e.metaKey }
  }
  stage.addEventListener('pointerdown', at)
  stage.addEventListener('pointermove', (e) => e.buttons && at(e))
  stage.addEventListener('pointerup', () => (simPointer = null))
  stage.addEventListener('pointerleave', () => (simPointer = null))
}

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
function drawTreat(left: number, pts: Pt[]) {
  if (left <= 0) return
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

// ───────────────────────── 시작 ─────────────────────────

resize()
renderTabs()
loadPhoto(pet.p)
raf = requestAnimationFrame(frame)
loadMyPets()

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
    photo: { ...rig, src: url(rig.src), flow: url(rig.flow), catchlight: rig.catchlight && url(rig.catchlight) },
  }
}
