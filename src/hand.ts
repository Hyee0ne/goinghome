import type { HandLandmarker, NormalizedLandmark } from '@mediapipe/tasks-vision'
import type { WorkerRequest, WorkerResponse } from './hand.worker'
import { handIds } from './hand-ids'

export interface TrackedHand {
  /** 'Left' | 'Right' 등. 프레임이 바뀌어도 같은 손을 알아보는 데 쓴다 */
  id: string
  landmarks: NormalizedLandmark[]
}

const BASE = import.meta.env.BASE_URL

/**
 * 전면 카메라 영상에서 손을 두 개까지, 손마다 랜드마크 21개 점을 추적한다. 모든 처리는 기기 안에서 이뤄진다.
 * 추론은 워커에서 돌려서 화면 그리기를 막지 않는다. 워커를 못 쓰는 브라우저에서는 메인 스레드에서 돌린다.
 */
export class HandTracker {
  readonly video: HTMLVideoElement
  private worker: Worker | null = null
  private inFlight = false
  private landmarker: HandLandmarker | null = null
  private stream: MediaStream | null = null
  private lastVideoTime = -1
  /** 손마다 마지막으로 본 결과. 잠깐 놓친 손은 250ms 동안 유지한다 */
  private seen = new Map<string, { hand: TrackedHand; at: number }>()
  latest: TrackedHand[] = []

  /** 디버그 표시용 */
  readonly stats = { mode: '' as 'worker' | 'main' | '', delegate: '', inferMs: 0, detectFps: 0 }
  private detectCount = 0
  private detectWindowStart = 0

  constructor(video: HTMLVideoElement) {
    this.video = video
  }

  get running() {
    return this.stream !== null
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('이 브라우저에서는 카메라를 쓸 수 없어요. HTTPS 주소로 접속했는지 확인해 주세요.')
    }
    const [stream] = await Promise.all([
      navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      }),
      this.worker || this.landmarker ? null : this.initInference(),
    ])
    this.stream = stream
    this.video.srcObject = stream
    await this.video.play()
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.video.srcObject = null
    this.seen.clear()
    this.latest = []
  }

  private async initInference() {
    if (typeof Worker !== 'undefined' && typeof createImageBitmap === 'function') {
      try {
        this.worker = await startWorker()
        this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.onWorkerMessage(e.data)
        this.stats.mode = 'worker'
        return
      } catch (err) {
        console.warn('손 인식 워커를 시작하지 못해 메인 스레드에서 인식합니다', err)
      }
    }
    this.landmarker = await createLandmarker()
    this.stats.mode = 'main'
  }

  private onWorkerMessage(msg: WorkerResponse) {
    if (msg.type !== 'result') return
    this.inFlight = false
    const lm = msg.landmarks
    const hands = msg.ids.map((id, h) => ({
      id,
      landmarks: Array.from({ length: 21 }, (_, i) => {
        const o = h * 63 + i * 3
        return { x: lm[o], y: lm[o + 1], z: lm[o + 2], visibility: 0 }
      }),
    }))
    this.accept(hands, performance.now(), msg.ms)
  }

  private accept(hands: TrackedHand[], now: number, ms: number) {
    this.stats.inferMs = this.stats.inferMs ? this.stats.inferMs * 0.9 + ms * 0.1 : ms
    this.detectCount++
    if (now - this.detectWindowStart > 1000) {
      this.stats.detectFps = (this.detectCount * 1000) / (now - this.detectWindowStart)
      this.detectCount = 0
      this.detectWindowStart = now
    }
    for (const hand of hands) this.seen.set(hand.id, { hand, at: now })
    for (const [id, s] of this.seen) if (now - s.at > 250) this.seen.delete(id)
    this.latest = [...this.seen.values()].map((s) => s.hand)
  }

  /** 새 영상 프레임이 있을 때만 추론한다. 손을 잠깐 놓쳐도 250ms 동안은 마지막 위치를 유지한다. */
  update(now: number): TrackedHand[] {
    if (!this.stream || this.video.readyState < 2) return this.latest
    if (this.video.currentTime === this.lastVideoTime) return this.latest

    if (this.worker) {
      // 워커가 앞 프레임을 처리 중이면 이번 프레임은 건너뛴다 (밀린 프레임이 쌓여 지연되지 않게)
      if (this.inFlight) return this.latest
      this.inFlight = true
      this.lastVideoTime = this.video.currentTime
      const worker = this.worker
      createImageBitmap(this.video).then(
        (bitmap) => worker.postMessage({ type: 'frame', bitmap, ts: now } satisfies WorkerRequest, [bitmap]),
        () => (this.inFlight = false),
      )
    } else if (this.landmarker) {
      this.lastVideoTime = this.video.currentTime
      const t0 = performance.now()
      const result = this.landmarker.detectForVideo(this.video, now)
      const ids = handIds(result.handedness.map((c) => c[0]?.categoryName ?? ''))
      this.accept(
        result.landmarks.map((landmarks, i) => ({ id: ids[i], landmarks })),
        now,
        performance.now() - t0,
      )
    }
    return this.latest
  }
}

function startWorker() {
  const worker = new Worker(new URL('./hand.worker.ts', import.meta.url), { type: 'module' })
  return new Promise<Worker>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (e.data.type === 'ready') resolve(worker)
      else if (e.data.type === 'error') {
        worker.terminate()
        reject(new Error(e.data.message))
      }
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(e)
    }
    worker.postMessage({ type: 'init', base: new URL(BASE, location.href).href } satisfies WorkerRequest)
  })
}

/** 워커를 못 쓸 때만 메인 스레드에서 불러온다 (평소에는 첫 로딩 번들에 넣지 않는다) */
async function createLandmarker() {
  const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision')
  const fileset = await FilesetResolver.forVisionTasks(`${BASE}mediapipe`)
  const options = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: `${BASE}models/hand_landmarker.task`, delegate },
    runningMode: 'VIDEO' as const,
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  })
  try {
    return await HandLandmarker.createFromOptions(fileset, options('GPU'))
  } catch {
    return await HandLandmarker.createFromOptions(fileset, options('CPU'))
  }
}

/** 손가락 4개 중 3개 이상 펴져 있으면 '손바닥을 편 상태'로 본다. */
export function isOpenHand(lm: NormalizedLandmark[]) {
  const wrist = lm[0]
  const d = (a: NormalizedLandmark, b: NormalizedLandmark) => Math.hypot(a.x - b.x, a.y - b.y)
  const fingers: [number, number][] = [
    [8, 6],
    [12, 10],
    [16, 14],
    [20, 18],
  ]
  const extended = fingers.filter(([tip, pip]) => d(lm[tip], wrist) > d(lm[pip], wrist) * 1.1).length
  return extended >= 3
}

export const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
]

export const PALM_POINTS = [0, 1, 5, 9, 13, 17]
