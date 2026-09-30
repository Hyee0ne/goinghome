import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
import { handIds } from './hand-ids'

/**
 * 손 인식 전용 워커. 추론이 메인 스레드를 막지 않아서, 인식이 느린 기기에서도 화면은 부드럽게 그려진다.
 * 모듈 워커에서는 importScripts를 못 쓰므로 ES 모듈판 wasm 로더(useModule)를 쓴다.
 */

export type WorkerRequest = { type: 'init'; base: string } | { type: 'frame'; bitmap: ImageBitmap; ts: number }

export type WorkerResponse =
  | { type: 'ready'; delegate: 'GPU' | 'CPU' }
  | { type: 'error'; message: string }
  /** landmarks: 손마다 21개 점의 x, y, z를 이어붙인 배열 (손 n개면 길이 n*63). ids: 손마다 'Left' | 'Right' */
  | { type: 'result'; landmarks: Float32Array; ids: string[]; ms: number }

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null
  postMessage(msg: WorkerResponse, transfer?: Transferable[]): void
}

let landmarker: HandLandmarker | null = null

async function init(base: string) {
  const fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe`, true)
  const options = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: `${base}models/hand_landmarker.task`, delegate },
    runningMode: 'VIDEO' as const,
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  })
  try {
    landmarker = await HandLandmarker.createFromOptions(fileset, options('GPU'))
    return 'GPU' as const
  } catch {
    landmarker = await HandLandmarker.createFromOptions(fileset, options('CPU'))
    return 'CPU' as const
  }
}

scope.onmessage = async (e) => {
  const msg = e.data
  if (msg.type === 'init') {
    try {
      scope.postMessage({ type: 'ready', delegate: await init(msg.base) })
    } catch (err) {
      scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
    return
  }
  if (!landmarker) {
    msg.bitmap.close()
    return
  }
  const t0 = performance.now()
  let landmarks = new Float32Array(0)
  let ids: string[] = []
  try {
    const result = landmarker.detectForVideo(msg.bitmap, msg.ts)
    landmarks = new Float32Array(result.landmarks.length * 63)
    result.landmarks.forEach((lm, h) => lm.forEach((p, i) => landmarks.set([p.x, p.y, p.z], h * 63 + i * 3)))
    ids = handIds(result.handedness.map((c) => c[0]?.categoryName ?? ''))
  } finally {
    msg.bitmap.close()
  }
  const out: WorkerResponse = { type: 'result', landmarks, ids, ms: performance.now() - t0 }
  scope.postMessage(out, [landmarks.buffer])
}

