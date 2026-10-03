/**
 * '우리 아이 만들기' 실제 엔진 (engineTypes.ts 계약). 사진은 기기 밖으로 나가지 않는다.
 *
 *   segment      탭 한 번으로 배경 지우기 (MediaPipe magic_touch, 약 6MB) → 탭한 곳과 이어진 덩어리만 남긴다
 *   editMask     지우개·복원 붓
 *   rigFromTaps  scripts/pet-add.ts의 frontal·frame·prepare 단계를 브라우저로 옮긴 것:
 *                두 눈을 수평으로 돌리고 → 얼굴 위주 3:4로 잘라 → 투명 여백 정리 → 털 결 맵 → rigDerive로 부위 계산.
 *                표정 사진(AI)은 만들지 않는다 (표정 없이도 털·고개·귀·숨·깜빡임·턱은 움직인다)
 *
 * 좌표는 모두 원본 사진 픽셀. 배경 지우기는 긴 변 WORK 픽셀로 줄여서 하고, 마스크도 그 크기로 들고 있는다.
 */
import { deriveRig, dist, type EarPts, type Landmarks } from '../rigDerive'
import type { PhotoRig, Species } from '../pets'
import type { Pt, Taps } from '../myPets'
import type { MakerEngine, MaskHandle, MaskStroke, RigResult } from './engineTypes'
import { loadSegmenter, segment as runSegment } from './segment'

/** 배경 지우기·마스크 작업 크기 (긴 변) */
const WORK = 1024
/** 앱용 사진 크기 (파이프라인 base.png와 같다. 셰이더 상수들이 이 크기 기준으로 맞춰져 있다) */
const BASE_W = 1086
const BASE_H = 1448
/** 셰이더가 경계 밖을 읽을 때 늘어지지 않게 두는 투명 여백 (prepare-pet.py MARGIN) */
const MARGIN = 24
/** 털 결 맵 크기 비율 (prepare-pet.py FLOW_SCALE) */
const FLOW_SCALE = 0.25

class Mask implements MaskHandle {
  readonly width: number
  readonly height: number
  /** 작업 크기 마스크 (0~1) */
  readonly w: number
  readonly h: number
  readonly data: Float32Array
  /** 원본 → 작업 크기 배율 */
  readonly k: number
  constructor(width: number, height: number, w: number, h: number, data: Float32Array) {
    this.width = width
    this.height = height
    this.w = w
    this.h = h
    this.data = data
    this.k = w / width
  }

  /** 작업 크기 마스크를 그림(알파)으로 */
  toCanvas() {
    const c = canvas(this.w, this.h)
    const g = c.getContext('2d')!
    const d = g.createImageData(this.w, this.h)
    for (let i = 0; i < this.data.length; i++) d.data[i * 4 + 3] = Math.round(this.data[i] * 255)
    g.putImageData(d, 0, 0)
    return c
  }
}

function canvas(w: number, h: number) {
  return Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) })
}

/** 원본 사진을 작업 크기로 줄인 것 (같은 사진은 한 번만) */
const workCache = new WeakMap<ImageBitmap, HTMLCanvasElement>()
function workImage(img: ImageBitmap) {
  let c = workCache.get(img)
  if (!c) {
    const k = Math.min(1, WORK / Math.max(img.width, img.height))
    c = canvas(img.width * k, img.height * k)
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
    workCache.set(img, c)
  }
  return c
}

/** 탭한 점과 이어진 덩어리만 남긴다 (옆 이불·바닥처럼 떨어진 조각을 버린다). 경계는 원래 값 그대로 */
function keepConnected(data: Float32Array, w: number, h: number, seed: Pt) {
  const on = (i: number) => data[i] > 0.5
  let start = Math.round(seed.y) * w + Math.round(seed.x)
  if (!on(start)) {
    // 탭이 살짝 빗나갔으면 가까운 동물 픽셀에서 시작
    let best = -1
    let bd = Infinity
    for (let i = 0; i < data.length; i++)
      if (on(i)) {
        const d = (i % w - seed.x) ** 2 + (Math.floor(i / w) - seed.y) ** 2
        if (d < bd) (bd = d), (best = i)
      }
    if (best < 0) return
    start = best
  }
  const keep = new Uint8Array(w * h)
  const stack = [start]
  keep[start] = 1
  while (stack.length) {
    const i = stack.pop()!
    const x = i % w
    for (const j of [i - 1, i + 1, i - w, i + w]) {
      if (j < 0 || j >= data.length || keep[j] || !on(j)) continue
      if ((j === i - 1 && x === 0) || (j === i + 1 && x === w - 1)) continue
      keep[j] = 1
      stack.push(j)
    }
  }
  // 덩어리 바로 바깥(경계의 반투명 털)은 남기고, 떨어진 곳은 지운다
  for (let i = 0; i < data.length; i++) {
    if (keep[i]) continue
    const x = i % w
    const near = keep[i - 1] && x > 0 ? 1 : keep[i + 1] && x < w - 1 ? 1 : keep[i - w] || keep[i + w] ? 1 : 0
    if (!near) data[i] = 0
  }
  // 덩어리 안의 작은 구멍(눈 반사, 흰 털)이 비지 않게 채운다
  fillHoles(data, keep, w, h)
}

/** 바깥과 이어지지 않은 빈 곳(구멍)은 동물로 채운다 */
function fillHoles(data: Float32Array, keep: Uint8Array, w: number, h: number) {
  const outside = new Uint8Array(w * h)
  const stack: number[] = []
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) stack.push(y * w + x)
  for (let y = 0; y < h; y++) for (const x of [0, w - 1]) stack.push(y * w + x)
  while (stack.length) {
    const i = stack.pop()!
    if (outside[i] || keep[i]) continue
    outside[i] = 1
    const x = i % w
    if (x > 0) stack.push(i - 1)
    if (x < w - 1) stack.push(i + 1)
    if (i >= w) stack.push(i - w)
    if (i < w * (h - 1)) stack.push(i + w)
  }
  for (let i = 0; i < data.length; i++) if (!outside[i] && !keep[i]) data[i] = Math.max(data[i], 1)
}

export const engine: MakerEngine = {
  async loadSegmenter() {
    await loadSegmenter('v1')
  },

  async segment(img, tap) {
    const work = workImage(img)
    const k = work.width / img.width
    const { mask } = await runSegment('v1', work, [{ x: tap.x * k, y: tap.y * k }])
    keepConnected(mask.data, mask.width, mask.height, { x: tap.x * k, y: tap.y * k })
    return new Mask(img.width, img.height, mask.width, mask.height, mask.data)
  },

  editMask(handle, s: MaskStroke) {
    const m = handle as Mask
    const r = Math.max(1, s.r * m.k)
    const v = s.mode === 'erase' ? 0 : 1
    // 붓 자국: 점 사이를 반지름의 1/3 간격으로 메워 찍는다. 가장자리 1픽셀은 부드럽게
    const stamp = (cx: number, cy: number) => {
      const x0 = Math.max(0, Math.floor(cx - r - 1))
      const x1 = Math.min(m.w - 1, Math.ceil(cx + r + 1))
      const y0 = Math.max(0, Math.floor(cy - r - 1))
      const y1 = Math.min(m.h - 1, Math.ceil(cy + r + 1))
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const a = Math.min(1, Math.max(0, r + 0.5 - Math.hypot(x - cx, y - cy)))
          if (a <= 0) continue
          const i = y * m.w + x
          m.data[i] = m.data[i] + (v - m.data[i]) * a
        }
    }
    const pts = s.pts.map((p) => ({ x: p.x * m.k, y: p.y * m.k }))
    pts.forEach((p, i) => {
      const q = pts[i - 1]
      if (!q) return stamp(p.x, p.y)
      const n = Math.max(1, Math.ceil(Math.hypot(p.x - q.x, p.y - q.y) / (r / 3)))
      for (let t = 1; t <= n; t++) stamp(q.x + ((p.x - q.x) * t) / n, q.y + ((p.y - q.y) * t) / n)
    })
  },

  /** 실행 취소용 사본 (작업 크기 Float32, 1024×1024면 약 4MB) */
  cloneMask(handle) {
    const m = handle as Mask
    return new Mask(m.width, m.height, m.w, m.h, m.data.slice())
  },

  maskPreview(img, handle) {
    const m = handle as Mask
    const c = canvas(img.width, img.height)
    const g = c.getContext('2d')!
    g.drawImage(img, 0, 0)
    g.globalCompositeOperation = 'destination-in'
    g.imageSmoothingQuality = 'high'
    g.drawImage(m.toCanvas(), 0, 0, img.width, img.height)
    return c
  },

  async rigFromTaps(img, handle, taps, species) {
    return buildRig(img, handle as Mask, taps, species)
  },
}

// ───────────────────────── 리그 만들기 ─────────────────────────

async function buildRig(img: ImageBitmap, m: Mask, taps: Taps, species: Species): Promise<RigResult> {
  const warnings: string[] = []
  // 1) 정면 맞추기: 두 눈이 수평이 되게 두 눈 가운데를 축으로 돌린다 (원본 크기로, 마스크는 늘려서)
  const angle = Math.atan2(taps.eyeR.y - taps.eyeL.y, taps.eyeR.x - taps.eyeL.x)
  const c = { x: (taps.eyeL.x + taps.eyeR.x) / 2, y: (taps.eyeL.y + taps.eyeR.y) / 2 }
  const rot = (p: Pt): Pt => {
    const dx = p.x - c.x
    const dy = p.y - c.y
    const cs = Math.cos(-angle)
    const sn = Math.sin(-angle)
    return { x: c.x + dx * cs - dy * sn, y: c.y + dx * sn + dy * cs }
  }
  const t = {
    eyeL: rot(taps.eyeL),
    eyeR: rot(taps.eyeR),
    nose: rot(taps.nose),
    chin: rot(taps.chin),
    earL: taps.earL && rot(taps.earL),
    earR: taps.earR && rot(taps.earR),
  }
  const D = dist(t.eyeL, t.eyeR)
  if (D < 60) warnings.push('얼굴이 너무 작게 찍혔어요. 얼굴이 크게 나온 사진이 더 자연스러워요')

  // 사진과 마스크를 함께 돌린 원본 크기 그림 (알파 = 마스크)
  const W = img.width
  const H = img.height
  const full = canvas(W, H)
  const fg = full.getContext('2d')!
  fg.translate(c.x, c.y)
  fg.rotate(-angle)
  fg.translate(-c.x, -c.y)
  fg.drawImage(img, 0, 0)
  fg.globalCompositeOperation = 'destination-in'
  fg.imageSmoothingQuality = 'high'
  fg.drawImage(m.toCanvas(), 0, 0, W, H)
  fg.setTransform(1, 0, 0, 1, 0, 0)
  const alphaAt = alphaReader(full)

  // 2) 정수리·귀는 탭이 없으면 마스크 윤곽에서 찾는다
  const lm0 = landmarksFromTaps(t, D, species, alphaAt, W, H)

  // 3) 얼굴 위주 3:4로 자르기 (pet-add.ts frame 단계와 같은 범위)
  let x0 = Math.min(lm0.leftEar.outer.x, lm0.leftEar.tip.x) - D * 0.15
  let x1 = Math.max(lm0.rightEar.outer.x, lm0.rightEar.tip.x) + D * 0.15
  const y0 = Math.min(lm0.headTop.y, lm0.leftEar.tip.y, lm0.rightEar.tip.y) - D * 0.25
  const cxm = (x0 + x1) / 2
  const bw = Math.max(x1 - x0, (lm0.chin.y + D * 2 - y0) * 0.75)
  x0 = cxm - bw / 2
  x1 = cxm + bw / 2
  const bh = bw / 0.75
  const s = BASE_W / bw
  const base = canvas(BASE_W, BASE_H)
  const bg = base.getContext('2d')!
  bg.imageSmoothingQuality = 'high'
  bg.drawImage(full, x0, y0, bw, bh, 0, 0, BASE_W, BASE_H)
  cleanEdges(base)
  // 옆면이 사진 밖으로 잘렸으면 앱이 그쪽을 서서히 사라지게 한다
  const cutLeft = x0 < 0 || colHasAlpha(base, 2)
  const cutRight = x1 > W || colHasAlpha(base, BASE_W - 3)

  // 4) 앱용 사진: 거의 불투명한 알파는 완전 불투명으로, 투명 여백 정리 (prepare-pet.py)
  const prep = prepare(base)
  const move = (p: Pt): Pt => ({ x: (p.x - x0) * s - prep.offsetX, y: (p.y - y0) * s - prep.offsetY })
  const lm = mapLandmarks(lm0, move, s)

  // 5) 털 결 맵
  const flow = flowMap(prep.canvas)

  // 6) 부위 계산 (rigDerive) + 파일
  const files: Record<string, Blob> = {
    'face.webp': await toBlob(prep.canvas, 'image/webp', 0.86),
    'flow.png': await toBlob(flow, 'image/png'),
    // 기준점 (face.webp 좌표). 나중에 AI 표정 업그레이드(scripts/pet-upgrade.ts)가 이 점으로 표정 부위를 자른다
    'landmarks.json': new Blob([JSON.stringify(lm)], { type: 'application/json' }),
  }
  const photo: PhotoRig = {
    ...deriveRig(lm, { src: 'face.webp', flow: 'flow.png', width: prep.canvas.width, height: prep.canvas.height, bottom: prep.bottom }),
    ...((cutLeft || cutRight) && {
      fadeSides: { ...(cutLeft && { left: -prep.offsetX }), ...(cutRight && { right: BASE_W - prep.offsetX }) },
    }),
  }

  // 정면도: 코가 두 눈 가운데에서 옆으로 비껴난 만큼 (고개가 돌아가면 코가 한쪽으로 쏠린다)
  const mid = (t.eyeL.x + t.eyeR.x) / 2
  const frontal = Math.max(0, Math.min(1, 1 - Math.abs(t.nose.x - mid) / (D * 0.35)))
  if (frontal < 0.6) warnings.push('얼굴이 옆으로 돌아가 있어요. 정면을 보는 사진이 더 자연스러워요')
  if (Math.abs(angle) > 0.35) warnings.push('고개가 많이 기울어 있어서 바로 세웠어요')
  if (t.chin.y - t.nose.y < D * 0.15) warnings.push('턱 위치가 코와 너무 가까워요. 턱 끝을 다시 찍어 주세요')
  return { photo, files, quality: { frontal, warnings } }
}

type AlphaAt = (x: number, y: number) => number

function alphaReader(c: HTMLCanvasElement): AlphaAt {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
  return (x, y) => {
    const xi = Math.round(x)
    const yi = Math.round(y)
    return xi < 0 || yi < 0 || xi >= c.width || yi >= c.height ? 0 : d[(yi * c.width + xi) * 4 + 3]
  }
}

/**
 * 4개 탭(눈 둘·코·턱)에서 rigDerive가 받는 기준점 전부를 만든다.
 * 입은 코와 턱 사이, 정수리와 귀는 마스크 윤곽(동물이 끝나는 곳)을 따라가 찾는다.
 * 귀 끝을 탭했으면 그 점을 쓴다
 */
function landmarksFromTaps(t: { eyeL: Pt; eyeR: Pt; nose: Pt; chin: Pt; earL?: Pt; earR?: Pt }, D: number, species: Species, alphaAt: AlphaAt, W: number, H: number): Landmarks {
  const cat = species === 'cat'
  const cx = t.nose.x
  const eyesY = (t.eyeL.y + t.eyeR.y) / 2
  // 정수리: 코 위로 올라가며 동물이 끝나는 곳
  let topY = eyesY
  for (let y = eyesY; y > Math.max(0, eyesY - D * 2.5); y--) if (alphaAt(cx, y) > 128) topY = y
  // 한쪽 귀: 머리 높이 띠에서 바깥으로 가장 멀리 나간 동물 픽셀(outer), 고양이는 그쪽에서 가장 높은 점이 끝(tip)
  const ear = (side: -1 | 1, eye: Pt, tapped?: Pt): EarPts => {
    const yTop = Math.max(0, topY - D * 0.8)
    // 바깥 끝은 귀 높이에서만 찾는다. 고양이 귀는 정수리 언저리에 있고(눈 높이까지 보면 볼 털이 잡혀 귀가 너무 커진다),
    // 늘어진 개 귀는 턱 높이까지 내려온다
    const yBottom = cat ? topY + D * 0.35 : t.chin.y
    let outer: Pt | null = null
    for (let y = yTop; y < yBottom; y += 2)
      for (let x = eye.x + side * D * 0.4; side < 0 ? x > Math.max(0, eye.x - D * 2.2) : x < Math.min(W, eye.x + D * 2.2); x += side * 2)
        if (alphaAt(x, y) > 128 && (!outer || (x - outer.x) * side > 0)) outer = { x, y }
    outer ??= { x: eye.x + side * D * 0.7, y: cat ? topY : eyesY }
    let tip = tapped
    if (!tip) {
      if (cat) {
        tip = { x: eye.x, y: topY }
        for (let x = eye.x; (x - eye.x) * side < D * 1.2; x += side * 2)
          for (let y = yTop; y < topY + D * 0.2; y++)
            if (alphaAt(x, y) > 128) {
              if (y < tip.y) tip = { x, y }
              break
            }
      } else {
        // 늘어진 귀: 바깥 끝 근처에서 아래로 내려가 귀가 끝나는 곳
        tip = { x: outer.x - side * D * 0.15, y: outer.y }
        for (let y = outer.y; y < Math.min(H, t.chin.y + D * 0.6); y++) if (alphaAt(tip.x, y) > 128) tip = { x: tip.x, y }
      }
    }
    const base = { x: eye.x + side * D * (cat ? 0.35 : 0.45), y: topY + D * (cat ? 0.2 : 0.12) }
    return { base, tip, outer: (outer.x - eye.x) * side > (tip.x - eye.x) * side ? outer : { x: tip.x, y: tip.y } }
  }
  const left = t.eyeL.x < t.eyeR.x ? t.eyeL : t.eyeR
  const right = left === t.eyeL ? t.eyeR : t.eyeL
  return {
    species,
    leftEye: left,
    rightEye: right,
    eyeR: D * 0.11,
    nose: t.nose,
    // 코 크기: 개는 넓고 크며 고양이는 작다 (초코·삼식 기준 비율)
    noseRx: D * (cat ? 0.13 : 0.25),
    noseRy: D * (cat ? 0.13 : 0.21),
    mouth: { x: cx, y: t.nose.y + (t.chin.y - t.nose.y) * (cat ? 0.5 : 0.45) },
    chin: t.chin,
    headTop: { x: cx, y: topY },
    leftEar: ear(-1, left, t.earL && t.earL.x < cx ? t.earL : t.earR && t.earR.x < cx ? t.earR : undefined),
    rightEar: ear(1, right, t.earR && t.earR.x >= cx ? t.earR : t.earL && t.earL.x >= cx ? t.earL : undefined),
  }
}

function mapLandmarks(lm: Landmarks, f: (p: Pt) => Pt, s: number): Landmarks {
  const ear = (e: EarPts): EarPts => ({ base: f(e.base), tip: f(e.tip), outer: f(e.outer) })
  return {
    ...lm,
    leftEye: f(lm.leftEye),
    rightEye: f(lm.rightEye),
    eyeR: lm.eyeR * s,
    nose: f(lm.nose),
    noseRx: lm.noseRx * s,
    noseRy: lm.noseRy * s,
    mouth: f(lm.mouth),
    chin: f(lm.chin),
    headTop: f(lm.headTop),
    leftEar: ear(lm.leftEar),
    rightEar: ear(lm.rightEar),
  }
}

/**
 * 배경 지우기 경계 정리: 경계 몇 픽셀에는 배경색(방바닥·이불)이 섞여 있어 윤곽에 회색 테가 보인다.
 * 1) 알파를 흐린 뒤 다시 조여 경계를 2~3픽셀 안으로 들이고(배경이 묻은 테를 걷어 냄),
 * 2) 새 경계의 반투명 픽셀 색을 안쪽 털 색(가까운 불투명 픽셀들의 평균)으로 바꾼다
 */
function cleanEdges(c: HTMLCanvasElement) {
  const g = c.getContext('2d')!
  const img = g.getImageData(0, 0, c.width, c.height)
  const d = img.data
  const w = c.width
  const h = c.height
  const n = w * h
  const a0 = new Float32Array(n)
  for (let i = 0; i < n; i++) a0[i] = d[i * 4 + 3] / 255
  // 경계에서 흐린 알파는 0.5 근처라, 0.6~0.95만 남기면 경계가 안쪽으로 들어온다
  const ab = blur(a0, w, h, 2.5)
  const na = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = Math.min(1, Math.max(0, (ab[i] - 0.6) / 0.35))
    na[i] = Math.min(a0[i], t * t * (3 - 2 * t))
  }
  const inner = new Float32Array(n)
  const rgb = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  for (let i = 0; i < n; i++) {
    const wgt = na[i] >= 0.97 ? 1 : 0
    inner[i] = wgt
    for (let k = 0; k < 3; k++) rgb[k][i] = d[i * 4 + k] * wgt
  }
  // 안쪽 털 색을 바깥으로 번지게 (정규화 블러)
  const wb = blur(inner, w, h, 4)
  const cb = rgb.map((ch) => blur(ch, w, h, 4))
  for (let i = 0; i < n; i++) {
    const a = na[i]
    if (a < 0.97 && a > 0.004 && wb[i] > 1e-3) {
      // 반투명할수록 안쪽 색을 많이 쓴다
      const keep = a * a
      for (let k = 0; k < 3; k++) d[i * 4 + k] = Math.round(d[i * 4 + k] * keep + (cb[k][i] / wb[i]) * (1 - keep))
    }
    d[i * 4 + 3] = Math.round(a * 255)
  }
  g.putImageData(img, 0, 0)
}

function colHasAlpha(c: HTMLCanvasElement, x: number) {
  const d = c.getContext('2d')!.getImageData(x, 0, 1, c.height).data
  for (let i = 3; i < d.length; i += 4) if (d[i] > 128) return true
  return false
}

/** prepare-pet.py: 알파 보정, 투명 여백을 MARGIN만 남기고 정리. 잘라낸 위치(음수면 덧댄 여백)와 가장 아래 불투명 줄 */
function prepare(base: HTMLCanvasElement) {
  const g = base.getContext('2d')!
  const img = g.getImageData(0, 0, base.width, base.height)
  const d = img.data
  let minX = Infinity
  let minY = Infinity
  let maxX = -1
  let maxY = -1
  let bottom = 0
  for (let y = 0; y < base.height; y++)
    for (let x = 0; x < base.width; x++) {
      const i = (y * base.width + x) * 4 + 3
      d[i] = Math.min(255, Math.round(d[i] * (255 / 252)))
      if (d[i] > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      if (d[i] > 128) bottom = y
    }
  g.putImageData(img, 0, 0)
  if (maxX < 0) throw new Error('배경을 지운 뒤 남은 부분이 없어요')
  const offsetX = minX - MARGIN
  const offsetY = minY - MARGIN
  const out = canvas(maxX - minX + 1 + MARGIN * 2, maxY - minY + 1 + MARGIN * 2)
  out.getContext('2d')!.drawImage(base, -offsetX, -offsetY)
  return { canvas: out, offsetX, offsetY, bottom: bottom - offsetY }
}

/** 털 결 맵 (prepare-pet.py와 같은 계산): 1/4 크기 휘도의 구조 텐서. R,G = 두 배 각도, B = 결의 선명도 */
function flowMap(src: HTMLCanvasElement) {
  const w = Math.round(src.width * FLOW_SCALE)
  const h = Math.round(src.height * FLOW_SCALE)
  const small = canvas(w, h)
  const sg = small.getContext('2d')!
  sg.imageSmoothingQuality = 'high'
  sg.drawImage(src, 0, 0, w, h)
  const px = sg.getImageData(0, 0, w, h).data
  let lum = new Float32Array(w * h)
  // prepare-pet.py는 알파를 곱하지 않은 RGB로 잰다. 캔버스는 투명한 곳 RGB가 0이라 같은 결과
  for (let i = 0; i < w * h; i++) lum[i] = (px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11) / 255
  lum = blur(lum, w, h, 0.6)
  const gx = new Float32Array(w * h)
  const gy = new Float32Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 1; x < w - 1; x++) gx[y * w + x] = lum[y * w + x + 1] - lum[y * w + x - 1]
  for (let y = 1; y < h - 1; y++) for (let x = 0; x < w; x++) gy[y * w + x] = lum[(y + 1) * w + x] - lum[(y - 1) * w + x]
  const xx = new Float32Array(w * h)
  const yy = new Float32Array(w * h)
  const xy = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    xx[i] = gx[i] * gx[i]
    yy[i] = gy[i] * gy[i]
    xy[i] = gx[i] * gy[i]
  }
  const jxx = blur(xx, w, h, 3)
  const jyy = blur(yy, w, h, 3)
  const jxy = blur(xy, w, h, 3)
  const out = canvas(w, h)
  const og = out.getContext('2d')!
  const od = og.createImageData(w, h)
  for (let i = 0; i < w * h; i++) {
    const theta2 = Math.atan2(2 * jxy[i], jxx[i] - jyy[i]) + Math.PI
    const coh = Math.sqrt((jxx[i] - jyy[i]) ** 2 + 4 * jxy[i] ** 2) / (jxx[i] + jyy[i] + 1e-6)
    od.data[i * 4] = Math.round((0.5 + 0.5 * Math.cos(theta2)) * 255)
    od.data[i * 4 + 1] = Math.round((0.5 + 0.5 * Math.sin(theta2)) * 255)
    od.data[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, coh)) * 255)
    od.data[i * 4 + 3] = 255
  }
  og.putImageData(od, 0, 0)
  return out
}

/** 분리형 가우시안 블러 (가장자리는 복제) */
function blur(a: Float32Array, w: number, h: number, sigma: number) {
  const r = Math.ceil(sigma * 3)
  const k = new Float32Array(r * 2 + 1)
  let sum = 0
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-0.5 * (i / sigma) ** 2)
  for (let i = 0; i < k.length; i++) k[i] /= sum
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0
      for (let i = -r; i <= r; i++) v += a[y * w + Math.min(w - 1, Math.max(0, x + i))] * k[i + r]
      tmp[y * w + x] = v
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0
      for (let i = -r; i <= r; i++) v += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + r]
      out[y * w + x] = v
    }
  return out
}

/** 캔버스 → 파일. webp를 못 만드는 브라우저(일부 Safari)는 png로 */
function toBlob(c: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('사진 파일을 만들지 못했어요'))), type, quality),
  )
}
