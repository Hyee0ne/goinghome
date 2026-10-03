/**
 * 사진에서 탭 한 번으로 동물만 남기기 (MediaPipe Interactive Segmenter). 기기 안에서만 돈다.
 *
 * 모델 두 가지를 견줘 보는 중이다 (시험판):
 *   v1  magic_touch (float32, 약 6MB)  탭할 때마다 사진 전체를 다시 돌린다
 *   v2  interactive_segmentation (int8, 약 30MB)  사진을 한 번 읽어 두고(인코더), 탭·붓질마다 가벼운 디코더만 돈다.
 *       붓질을 '더하기/빼기'로 넘길 수 있어 지우개·복원 붓이 모델 안에서 바로 된다
 */
import type { BrushMode, InteractiveSegmenter, InteractiveSegmenterLegacy } from '@mediapipe/tasks-vision'

export type SegModel = 'v1' | 'v2'

const MODEL_URL: Record<SegModel, string> = {
  v1: 'https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite',
  v2: 'https://storage.googleapis.com/mediapipe-models/interactive_segmenter_v2/magic_touch/int8/1/interactive_segmentation.task',
}

export interface Pt {
  x: number
  y: number
}

/** 0~1 마스크 (사진 크기 그대로, 1 = 동물) */
export interface Mask {
  width: number
  height: number
  data: Float32Array
}

export interface Timing {
  /** 모델 받기·준비 */
  loadMs?: number
  /** v2: 사진 읽기(인코더) */
  encodeMs?: number
  /** 탭 한 번 처리 */
  segmentMs: number
}

const BASE = import.meta.env.BASE_URL
const BRUSH_POSITIVE = 1 as BrushMode.POSITIVE
const BRUSH_NEGATIVE = 2 as BrushMode.NEGATIVE
const cache = new Map<SegModel, Promise<{ seg: InteractiveSegmenter | InteractiveSegmenterLegacy; loadMs: number }>>()

/** 모델 미리 받기 (화면에 들어올 때 부른다) */
export function loadSegmenter(model: SegModel = 'v2') {
  let p = cache.get(model)
  if (!p) {
    p = (async () => {
      const t0 = performance.now()
      const { FilesetResolver, InteractiveSegmenter, InteractiveSegmenterLegacy } = await import('@mediapipe/tasks-vision')
      const fileset = await FilesetResolver.forVisionTasks(`${BASE}mediapipe`)
      const seg =
        model === 'v2'
          ? await InteractiveSegmenter.createFromModelPath(fileset, MODEL_URL.v2)
          : await InteractiveSegmenterLegacy.createFromOptions(fileset, {
              baseOptions: { modelAssetPath: MODEL_URL.v1, delegate: 'GPU' },
              outputCategoryMask: false,
              outputConfidenceMasks: true,
            })
      return { seg, loadMs: performance.now() - t0 }
    })()
    cache.set(model, p)
  }
  return p
}

/** v2는 사진을 한 번만 읽어 둔다 (같은 사진에 탭·붓질을 여러 번 해도 인코더는 한 번) */
let encoded: { model: SegModel; img: TexImageSource } | null = null

/** 탭(사진 픽셀 좌표) 한 번으로 그 자리의 물체 마스크를 얻는다. negatives는 '이건 아니에요' 탭 */
export async function segment(model: SegModel, img: TexImageSource & { width: number; height: number }, taps: Pt[], negatives: Pt[] = []): Promise<{ mask: Mask; timing: Timing }> {
  const { seg, loadMs } = await loadSegmenter(model)
  const W = img.width
  const H = img.height
  const norm = (p: Pt) => ({ x: p.x / W, y: p.y / H })
  if (model === 'v2') {
    const s = seg as InteractiveSegmenter
    let encodeMs: number | undefined
    if (!encoded || encoded.img !== img || encoded.model !== model) {
      const t0 = performance.now()
      s.setImage(img)
      encodeMs = performance.now() - t0
      encoded = { model, img }
    }
    const t1 = performance.now()
    // BrushMode는 타입 선언만 있고 실행 코드에는 내보내지 않아 숫자로 쓴다 (1: 더하기, 2: 빼기)
    const strokes = [
      ...taps.map((p) => ({ brushMode: BRUSH_POSITIVE, point: [norm(p)], isCompleted: true })),
      ...negatives.map((p) => ({ brushMode: BRUSH_NEGATIVE, point: [norm(p)], isCompleted: true })),
    ]
    const m = s.segment(strokes)
    const mask = toMask(m.getAsFloat32Array(), m.width, m.height, W, H)
    m.close()
    return { mask, timing: { loadMs, encodeMs, segmentMs: performance.now() - t1 } }
  }
  const s = seg as InteractiveSegmenterLegacy
  const t1 = performance.now()
  const mask = await new Promise<Mask>((resolve) => {
    s.segment(img as never, { keypoint: norm(taps[0]) }, (r) => {
      const m = r.confidenceMasks![0]
      resolve(toMask(m.getAsFloat32Array(), m.width, m.height, W, H))
    })
  })
  return { mask, timing: { loadMs, segmentMs: performance.now() - t1 } }
}

/** 모델 출력 크기가 사진과 다르면 사진 크기로 늘린다 (양선형) */
function toMask(src: Float32Array, sw: number, sh: number, W: number, H: number): Mask {
  if (sw === W && sh === H) return { width: W, height: H, data: new Float32Array(src) }
  const data = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    const fy = ((y + 0.5) * sh) / H - 0.5
    const y0 = Math.max(0, Math.floor(fy))
    const y1 = Math.min(sh - 1, y0 + 1)
    const ty = Math.min(1, Math.max(0, fy - y0))
    for (let x = 0; x < W; x++) {
      const fx = ((x + 0.5) * sw) / W - 0.5
      const x0 = Math.max(0, Math.floor(fx))
      const x1 = Math.min(sw - 1, x0 + 1)
      const tx = Math.min(1, Math.max(0, fx - x0))
      const a = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx
      const b = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx
      data[y * W + x] = a * (1 - ty) + b * ty
    }
  }
  return { width: W, height: H, data }
}
