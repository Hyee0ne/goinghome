import './style.css'
import './register.css'
import './make.css'
import type { MakerEngine, MaskHandle } from './maker/engineTypes'
import { mockEngine } from './maker/mockEngine'
import { engine as realEngine } from './maker/engine'
import { myPets, newPetId, type Pt, type Taps } from './myPets'
import { josa, type PetProfile, type Species } from './pets'
import { renderAdoptLinks } from './adoptLinks'
import { unlockAi } from './rewardedAd'
import { aiCredits } from './credits'
import { sharePet, toast } from './share'

/**
 * '우리 아이 만들기': 사진 → 배경 지우기(탭 한 번 + 붓) → 얼굴 점 찍기 → 완성.
 * 사진은 기기 안에서만 처리하고 IndexedDB에 저장한다.
 * 엔진은 기술 쪽 실제 엔진이 나오면 바꿔 끼운다 (지금은 가짜 엔진).
 */
// 실제 엔진(기기 안 배경 지우기·리그). 화면 흐름만 볼 때는 ?mock=1로 가짜 엔진
const engine: MakerEngine = new URLSearchParams(location.search).has('mock') ? mockEngine : realEngine

/** 처리할 사진의 긴 변 (크면 배경 지우기·털 결 계산이 느려진다) */
const MAX_EDGE = 1600

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

type Step = 'photo' | 'cut' | 'face' | 'done'
const state: {
  img: ImageBitmap | null
  blob: Blob | null
  mask: MaskHandle | null
  preview: HTMLCanvasElement | null
  taps: Partial<Taps>
} = { img: null, blob: null, mask: null, preview: null, taps: {} }

function go(step: Step) {
  for (const s of ['photo', 'cut', 'face', 'done'] as Step[]) $(`step-${s}`).hidden = s !== step
  const order = ['photo', 'cut', 'face', 'done']
  document.querySelectorAll<HTMLElement>('#mk-steps li').forEach((li) => {
    const i = order.indexOf(li.dataset.step!)
    li.classList.toggle('on', i === order.indexOf(step))
    li.classList.toggle('past', i < order.indexOf(step))
  })
  window.scrollTo({ top: 0 })
  if (step === 'cut') cutView.fit()
  if (step === 'face') {
    faceView.fit()
    renderPoints()
  }
}

// ───────────────────────── 1. 사진 ─────────────────────────

const fileInput = $<HTMLInputElement>('mk-file')
const nameInput = $<HTMLInputElement>('mk-name')
const species = () => (document.querySelector('input[name=mk-species]:checked') as HTMLInputElement).value as Species

/** 사진을 줄여 다시 그린다. 위치 같은 사진 메타데이터도 함께 사라진다 */
async function shrinkPhoto(f: File) {
  const src = await createImageBitmap(f, { imageOrientation: 'from-image' })
  const k = Math.min(1, MAX_EDGE / Math.max(src.width, src.height))
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(src.width * k), height: Math.round(src.height * k) })
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height)
  src.close()
  const blob = await new Promise<Blob>((r, j) => c.toBlob((b) => (b ? r(b) : j(new Error('toBlob'))), 'image/jpeg', 0.9))
  return { c, blob }
}

fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0]
  if (!f) return
  try {
    const { c, blob } = await shrinkPhoto(f)
    state.img = await createImageBitmap(c)
    state.blob = blob
    state.mask = null
    state.preview = null
    state.taps = {}
    resetCutHistory()
    faceHistory.length = 0
    faceUndoBtn.disabled = true
    const prev = $<HTMLImageElement>('mk-photo-preview')
    prev.src = c.toDataURL('image/jpeg', 0.8)
    prev.hidden = false
    $('mk-pick-label').innerHTML = '<b>↺</b>다른 사진'
    $('mk-info').hidden = false
    updatePhotoNext()
    nameInput.focus()
  } catch {
    alert('이 사진은 열 수 없어요. 다른 사진을 골라 주세요.')
  }
})
nameInput.addEventListener('input', updatePhotoNext)
function updatePhotoNext() {
  const ai = mode() === 'ai'
  const ready = !!state.img && !!nameInput.value.trim() && (!ai || ((!needRefs() || refs.length > 0) && consent.checked))
  $<HTMLButtonElement>('mk-photo-next').disabled = !ready
  $('mk-refs-error').hidden = !(needRefs() && state.img && refs.length === 0)
}

// ── 만들기 방식: AI면 참고 사진 1~2장과 서버 전송 동의를 더 받는다
const mode = () => (document.querySelector('input[name=mk-mode]:checked') as HTMLInputElement).value as 'free' | 'ai'
const consent = $<HTMLInputElement>('mk-consent')
const refs: { blob: Blob; url: string }[] = []
const MAX_REFS = 2
/**
 * 참고 사진은 '손' 하는 강아지의 앞발을 만들 때만 받는다.
 * 표정 편집에 참고 사진을 같이 주면 AI가 털색·얼굴을 참고 사진 쪽으로 다시 그려 다른 아이처럼 된다 (2026-10-03 기술 검증)
 */
const needRefs = () => mode() === 'ai' && species() === 'dog' && $<HTMLInputElement>('mk-paw').checked
function onMode() {
  const ai = mode() === 'ai'
  const n = aiCredits.count
  $('mk-ai-credit').textContent = n > 0 ? `공유 기회 ${n}번 · 광고 없이` : '공유하면 광고 없이 1번 더'
  $('mk-refs-wrap').hidden = !needRefs()
  $('mk-ai-extra').hidden = !ai
  $('mk-paw-field').hidden = species() !== 'dog'
  $('mk-privacy').textContent = ai
    ? '🔒 배경 지우기와 얼굴 점은 이 기기 안에서 하고, 표정을 만들 때만 사진을 보내요.'
    : '🔒 사진은 이 기기 안에서만 처리돼요. 어디로도 보내지 않아요.'
  updatePhotoNext()
}
document.querySelectorAll('input[name=mk-mode]').forEach((r) => r.addEventListener('change', onMode))
document.querySelectorAll('input[name=mk-species]').forEach((r) => r.addEventListener('change', onMode))
consent.addEventListener('change', updatePhotoNext)
$('mk-paw').addEventListener('change', onMode)

$<HTMLInputElement>('mk-ref-file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement
  for (const f of [...(input.files ?? [])].slice(0, MAX_REFS - refs.length)) {
    try {
      const { blob } = await shrinkPhoto(f)
      refs.push({ blob, url: URL.createObjectURL(blob) })
    } catch {
      alert(`${f.name}은(는) 열 수 없는 사진이에요.`)
    }
  }
  input.value = ''
  renderRefs()
})
function renderRefs() {
  const box = $('mk-refs')
  const add = box.querySelector('.mk-ref-add') as HTMLElement
  box.querySelectorAll('.mk-ref').forEach((n) => n.remove())
  refs.forEach((r, i) => {
    const fig = Object.assign(document.createElement('figure'), { className: 'mk-ref' })
    const img = Object.assign(new Image(), { src: r.url, alt: `참고 사진 ${i + 1}` })
    const del = Object.assign(document.createElement('button'), { type: 'button', className: 'photo-del', textContent: '✕' })
    del.setAttribute('aria-label', `참고 사진 ${i + 1} 빼기`)
    del.onclick = () => {
      URL.revokeObjectURL(r.url)
      refs.splice(i, 1)
      renderRefs()
    }
    fig.append(img, del)
    box.insertBefore(fig, add)
  })
  add.hidden = refs.length >= MAX_REFS
  updatePhotoNext()
}
$('mk-photo-next').onclick = () => go('cut')

// ───────────────────────── 캔버스 보기 (사진을 칸에 맞춰 그리고, 화면 ↔ 사진 좌표 변환) ─────────────────────────

class PhotoView {
  readonly canvas: HTMLCanvasElement
  readonly g: CanvasRenderingContext2D
  scale = 1
  ox = 0
  oy = 0
  w = 0
  h = 0
  draw: () => void = () => {}
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.g = canvas.getContext('2d')!
    new ResizeObserver(() => this.fit()).observe(canvas)
  }
  fit() {
    const img = state.img
    const r = this.canvas.getBoundingClientRect()
    if (!img || !r.width) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.w = r.width
    this.h = r.height
    this.canvas.width = Math.round(r.width * dpr)
    this.canvas.height = Math.round(r.height * dpr)
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.scale = Math.min(r.width / img.width, r.height / img.height)
    this.ox = (r.width - img.width * this.scale) / 2
    this.oy = (r.height - img.height * this.scale) / 2
    this.draw()
  }
  toImg(e: PointerEvent): Pt {
    const r = this.canvas.getBoundingClientRect()
    return { x: (e.clientX - r.left - this.ox) / this.scale, y: (e.clientY - r.top - this.oy) / this.scale }
  }
  toView(p: Pt): Pt {
    return { x: this.ox + p.x * this.scale, y: this.oy + p.y * this.scale }
  }
  /** 사진(또는 배경 지운 사진)을 칸에 그린다 */
  image(src: CanvasImageSource, alpha = 1) {
    const img = state.img!
    this.g.globalAlpha = alpha
    this.g.drawImage(src, this.ox, this.oy, img.width * this.scale, img.height * this.scale)
    this.g.globalAlpha = 1
  }
}

/** 투명한 곳을 보여 주는 바둑판 */
function checker(v: PhotoView) {
  const s = 12
  v.g.fillStyle = '#fff'
  v.g.fillRect(0, 0, v.w, v.h)
  v.g.fillStyle = '#f1e6da'
  for (let y = 0; y < v.h; y += s) for (let x = (y / s) % 2 ? s : 0; x < v.w; x += s * 2) v.g.fillRect(x, y, s, s)
}

// ───────────────────────── 2. 배경 지우기 ─────────────────────────

const cutView = new PhotoView($<HTMLCanvasElement>('mk-cut-canvas'))
const tool = () => (document.querySelector('input[name=mk-tool]:checked') as HTMLInputElement).value as 'tap' | 'erase' | 'restore'
const brush = $<HTMLInputElement>('mk-size')

cutView.draw = () => {
  const v = cutView
  if (!state.img) return
  v.g.clearRect(0, 0, v.w, v.h)
  if (!state.preview) return v.image(state.img)
  checker(v)
  // 지워진 곳도 흐리게 보여서 되살릴 자리를 알 수 있게
  v.image(state.img, 0.18)
  v.image(state.preview)
}

// 실행 취소: 다시 톡·붓질 직전의 마스크 사본 (엔진이 cloneMask를 줄 때만). 메모리 때문에 8단계까지
const UNDO_MAX = 8
const cutHistory: (MaskHandle | null)[] = []
const cutUndoBtn = $<HTMLButtonElement>('mk-cut-undo')
cutUndoBtn.hidden = !engine.cloneMask
function pushCut() {
  if (!engine.cloneMask) return
  cutHistory.push(state.mask && engine.cloneMask(state.mask))
  if (cutHistory.length > UNDO_MAX) cutHistory.shift()
  cutUndoBtn.disabled = false
}
cutUndoBtn.onclick = () => {
  if (!cutHistory.length) return
  state.mask = cutHistory.pop()!
  state.preview = state.mask && engine.maskPreview(state.img!, state.mask)
  cutUndoBtn.disabled = cutHistory.length === 0
  $<HTMLButtonElement>('mk-cut-next').disabled = !state.mask
  $('mk-tools').hidden = !state.mask
  cutView.draw()
}
function resetCutHistory() {
  cutHistory.length = 0
  cutUndoBtn.disabled = true
}

let segmentedOnce = false
async function segmentAt(p: Pt) {
  pushCut()
  $('mk-busy').hidden = false
  // 첫 탭은 모델을 받고 준비하느라 오래 걸릴 수 있다 (다음부터는 1초 안쪽)
  $('mk-busy-text').textContent = segmentedOnce || segmenterReady ? '' : '배경 지우기를 준비하고 있어요…'
  try {
    state.mask = await engine.segment(state.img!, p)
    segmentedOnce = true
    state.preview = engine.maskPreview(state.img!, state.mask)
    $('mk-tools').hidden = false
    $<HTMLButtonElement>('mk-cut-next').disabled = false
    $('mk-cut-hint').innerHTML = '배경이 남았으면 <b>지우개</b>로 꼭 지워 주세요<br><small>남은 배경은 아이와 함께 움직여요. 빠진 곳은 <b>되살리기</b></small>'
  } finally {
    $('mk-busy').hidden = true
    cutView.draw()
  }
}

let stroke: Pt[] | null = null
let strokeFrame = 0
cutView.canvas.addEventListener('pointerdown', (e) => {
  if (!state.img) return
  const p = cutView.toImg(e)
  if (tool() === 'tap' || !state.mask) return void segmentAt(p)
  cutView.canvas.setPointerCapture(e.pointerId)
  pushCut()
  stroke = [p]
  applyStroke()
})
cutView.canvas.addEventListener('pointermove', (e) => {
  if (!stroke) return
  stroke.push(cutView.toImg(e))
  if (!strokeFrame) strokeFrame = requestAnimationFrame(applyStroke)
})
const endStroke = () => {
  if (stroke) applyStroke()
  stroke = null
}
cutView.canvas.addEventListener('pointerup', endStroke)
cutView.canvas.addEventListener('pointercancel', endStroke)

/** 붓질은 프레임마다 모아서 한 번에 반영한다 */
function applyStroke() {
  strokeFrame = 0
  if (!stroke || !state.mask || stroke.length === 0) return
  const mode = tool() === 'erase' ? 'erase' : 'restore'
  // 붓 크기는 화면 기준 → 사진 픽셀로
  engine.editMask(state.mask, { pts: stroke, r: Number(brush.value) / cutView.scale / 2, mode })
  stroke = stroke.slice(-1)
  state.preview = engine.maskPreview(state.img!, state.mask)
  cutView.draw()
}

document.querySelectorAll('input[name=mk-tool]').forEach((r) =>
  r.addEventListener('change', () => ($('mk-size-wrap').hidden = tool() === 'tap')),
)
$('mk-cut-next').onclick = () => go('face')

// ───────────────────────── 3. 얼굴 점 찍기 ─────────────────────────

type Key = keyof Taps
const POINTS: { key: Key; label: string; hint: string; optional?: boolean }[] = [
  { key: 'eyeL', label: '왼쪽 눈', hint: '화면에서 <b>왼쪽 눈</b> 가운데를 눌러 주세요' },
  { key: 'eyeR', label: '오른쪽 눈', hint: '이번엔 <b>오른쪽 눈</b> 가운데를 눌러 주세요' },
  { key: 'nose', label: '코끝', hint: '<b>코끝</b>을 눌러 주세요' },
  { key: 'chin', label: '턱 끝', hint: '<b>턱 끝</b>(아래턱 가장 아래)을 눌러 주세요' },
  { key: 'earL', label: '왼쪽 귀 끝', hint: '<b>왼쪽 귀 끝</b>을 눌러 주세요<br><small>선택이지만, 찍으면 귀가 훨씬 자연스럽게 움직여요</small>', optional: true },
  { key: 'earR', label: '오른쪽 귀 끝', hint: '<b>오른쪽 귀 끝</b>을 눌러 주세요 (선택)', optional: true },
]
const faceView = new PhotoView($<HTMLCanvasElement>('mk-face-canvas'))
const loupe = $<HTMLCanvasElement>('mk-loupe')
let skippedEars = false
/** 지금 찍을 점 (다 찍었으면 null) */
const current = () => POINTS.find((p) => !state.taps[p.key] && !(p.optional && skippedEars)) ?? null
const required = () => POINTS.filter((p) => !p.optional).every((p) => state.taps[p.key])

function renderPoints() {
  const cur = current()
  $('mk-face-hint').innerHTML = cur ? cur.hint : '점을 끌어서 위치를 다듬을 수 있어요. 다 됐으면 <b>만들기</b>'
  $('mk-points').replaceChildren(
    ...POINTS.map((p) => {
      const li = document.createElement('li')
      li.textContent = p.label
      li.className = state.taps[p.key] ? 'done' : p === cur ? 'on' : p.optional ? 'opt' : ''
      return li
    }),
  )
  $('mk-skip').hidden = !(cur?.optional && !skippedEars)
  $<HTMLButtonElement>('mk-face-next').disabled = !required()
  faceView.draw()
}

faceView.draw = () => {
  const v = faceView
  if (!state.img) return
  v.g.fillStyle = '#fff8f0'
  v.g.fillRect(0, 0, v.w, v.h)
  v.image(state.preview ?? state.img)
  for (const p of POINTS) {
    const t = state.taps[p.key]
    if (!t) continue
    // 눈을 가리지 않게 가운데가 빈 고리 + 작은 점
    const q = v.toView(t)
    const on = drag?.key === p.key
    v.g.lineWidth = 2.5
    v.g.strokeStyle = '#fff'
    v.g.beginPath()
    v.g.arc(q.x, q.y, on ? 12 : 9, 0, Math.PI * 2)
    v.g.stroke()
    v.g.lineWidth = 1.5
    v.g.strokeStyle = '#ff8a3d'
    v.g.stroke()
    v.g.beginPath()
    v.g.arc(q.x, q.y, 2.5, 0, Math.PI * 2)
    v.g.fillStyle = '#ff8a3d'
    v.g.fill()
  }
}

/** 손가락에 가려지지 않게 위쪽에 확대해서 보여 준다 */
function showLoupe(e: PointerEvent, p: Pt) {
  const r = faceView.canvas.getBoundingClientRect()
  const size = 120
  loupe.hidden = false
  loupe.style.left = `${Math.min(r.width - size, Math.max(0, e.clientX - r.left - size / 2))}px`
  loupe.style.top = `${Math.max(0, e.clientY - r.top - size - 40)}px`
  const g = loupe.getContext('2d')!
  const zoom = 3
  const src = 40 / faceView.scale / zoom * 3
  g.clearRect(0, 0, 240, 240)
  g.save()
  g.beginPath()
  g.arc(120, 120, 120, 0, Math.PI * 2)
  g.clip()
  g.fillStyle = '#fff8f0'
  g.fillRect(0, 0, 240, 240)
  g.drawImage(state.preview ?? state.img!, p.x - src, p.y - src, src * 2, src * 2, 0, 0, 240, 240)
  g.restore()
  g.strokeStyle = '#ff8a3d'
  g.lineWidth = 3
  g.beginPath()
  g.moveTo(120, 100)
  g.lineTo(120, 140)
  g.moveTo(100, 120)
  g.lineTo(140, 120)
  g.stroke()
}

const faceHistory: { taps: Partial<Taps>; skipped: boolean }[] = []
const faceUndoBtn = $<HTMLButtonElement>('mk-face-undo')
function pushFace() {
  faceHistory.push({ taps: { ...state.taps }, skipped: skippedEars })
  if (faceHistory.length > 30) faceHistory.shift()
  faceUndoBtn.disabled = false
}
faceUndoBtn.onclick = () => {
  const prev = faceHistory.pop()
  if (!prev) return
  state.taps = prev.taps
  skippedEars = prev.skipped
  faceUndoBtn.disabled = faceHistory.length === 0
  renderPoints()
}

let drag: { key: Key } | null = null
faceView.canvas.addEventListener('pointerdown', (e) => {
  if (!state.img) return
  const p = faceView.toImg(e)
  // 이미 찍은 점 근처를 누르면 그 점을 옮긴다
  const near = POINTS.find((q) => {
    const t = state.taps[q.key]
    return t && Math.hypot(t.x - p.x, t.y - p.y) * faceView.scale < 22
  })
  const key = near?.key ?? current()?.key
  if (!key) return
  faceView.canvas.setPointerCapture(e.pointerId)
  pushFace()
  drag = { key }
  state.taps[key] = p
  showLoupe(e, p)
  renderPoints()
})
faceView.canvas.addEventListener('pointermove', (e) => {
  if (!drag) return
  const p = faceView.toImg(e)
  state.taps[drag.key] = p
  showLoupe(e, p)
  faceView.draw()
})
const endDrag = () => {
  drag = null
  loupe.hidden = true
  renderPoints()
}
faceView.canvas.addEventListener('pointerup', endDrag)
faceView.canvas.addEventListener('pointercancel', endDrag)
$('mk-skip').onclick = () => {
  pushFace()
  skippedEars = true
  renderPoints()
}

// ───────────────────────── 4. 완성 ─────────────────────────

$('mk-face-next').onclick = async () => {
  go('done')
  $('mk-making').hidden = false
  $('mk-made').hidden = true
  const name = nameInput.value.trim()
  const sp = species()
  const taps = state.taps as Taps
  // 무료 버전을 만드는 동안 (AI를 골랐으면) 보상형 광고를 보여 준다. 끝까지 봐야 AI 신청이 된다
  const making = engine.rigFromTaps(state.img!, state.mask!, taps, sp)
  const wantAi = mode() === 'ai' && (await unlockAi())
  const result = await making
  const id = newPetId()
  await myPets.put({
    id,
    name,
    species: sp,
    createdAt: new Date().toISOString(),
    photo: state.blob!,
    taps,
    rig: result.photo ?? undefined,
    files: result.files,
    ...(wantAi && {
      ai: { status: 'waiting' as const, requestedAt: new Date().toISOString(), refs: needRefs() ? refs.map((r) => r.blob) : [], canPaw: sp === 'dog' && $<HTMLInputElement>('mk-paw').checked },
    }),
  })
  $('mk-ai-status').hidden = !wantAi

  $<HTMLImageElement>('mk-result-img').src = (state.preview ?? document.createElement('canvas')).toDataURL('image/png')
  $('mk-result-title').textContent = `${josa(name, '이', '가')} 준비됐어요!`
  const f = Math.round(result.quality.frontal * 100)
  $('mk-meter-bar').style.width = `${f}%`
  $('mk-meter-bar').className = f >= 70 ? 'good' : f >= 45 ? 'ok' : 'bad'
  $('mk-meter-text').textContent = f >= 70 ? '좋아요' : f >= 45 ? '괜찮아요' : '아쉬워요'
  const warnings = [...result.quality.warnings]
  if (f < 45) warnings.push('정면 사진으로 다시 만들면 훨씬 자연스럽게 움직여요.')
  $('mk-warnings').replaceChildren(...warnings.map((w) => Object.assign(document.createElement('li'), { textContent: w })))

  const go2 = $<HTMLAnchorElement>('mk-go')
  if (result.photo) {
    go2.href = `./?pet=${id}`
    go2.removeAttribute('aria-disabled')
    $('mk-go-note').textContent = ''
  } else {
    // 가짜 엔진: 리그가 없어 아직 앱에서 열 수 없다
    go2.href = './'
    go2.setAttribute('aria-disabled', 'true')
    $('mk-go-note').textContent = '가안: 움직이는 엔진이 붙으면 바로 쓰다듬을 수 있어요. 지금은 이 기기에 저장까지만 돼요.'
  }
  $('mk-making').hidden = true
  $('mk-made').hidden = false
  // 공유하면 AI로 만들 기회 +1
  $('mk-share').onclick = async () => {
    const r = await sharePet({ id, name, species: sp } as PetProfile, true)
    if (r === 'cancelled') return
    const bonus = aiCredits.rewardShare()
    toast(bonus ? '공유 고마워요! AI로 만들 기회가 1번 생겼어요 ✨' : r === 'copied' ? '링크를 복사했어요' : '공유했어요')
  }
  const adopt = $('mk-adopt')
  adopt.hidden = false
  renderAdoptLinks(adopt, `${name}처럼 사랑받을 가족을 기다리는 아이들`)
}

$('mk-again').onclick = () => {
  fileInput.value = ''
  state.img = null
  state.preview = null
  state.mask = null
  state.taps = {}
  skippedEars = false
  resetCutHistory()
  faceHistory.length = 0
  faceUndoBtn.disabled = true
  $<HTMLImageElement>('mk-photo-preview').hidden = true
  $('mk-pick-label').innerHTML = '<b>＋</b>사진 고르기'
  $('mk-tools').hidden = true
  $<HTMLButtonElement>('mk-cut-next').disabled = true
  $('mk-cut-hint').innerHTML = '아이 몸을 <b>한 번 톡</b> 눌러 주세요'
  onMode()
  go('photo')
}

onMode()

// 배경 지우기 모델은 들어오자마자 준비한다 (사진을 고르는 동안 끝난다)
let segmenterReady = false
engine.loadSegmenter().then(() => (segmenterReady = true))
go('photo')
