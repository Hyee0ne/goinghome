/**
 * 짧은 영상 녹화 (공유용 5~8초 클립).
 *
 * 털 셰이더 캔버스(WebGL)와 손끝·간식을 그린 2D 캔버스를 녹화용 캔버스 한 장에 합쳐 MediaRecorder로 담는다.
 * 녹화하는 동안만 매 프레임 합친다 (drawImage 두 번, 약 1~2ms). 그 밖에는 아무 일도 하지 않는다.
 * WebGL 캔버스는 그린 직후 같은 프레임 안에서 복사해야 내용이 남아 있으므로, main.ts가 그리기 직후 captureFrame()을 부른다.
 * 카메라 영상은 넣지 않는다 (기기 밖으로 나가는 영상에 사용자 얼굴·방이 담기지 않게).
 */

export interface ClipSupport {
  ok: boolean
  mime: string
  ext: 'mp4' | 'webm'
}

/** 이 브라우저가 녹화할 수 있는 형식. iOS Safari는 mp4(H.264)만, 크롬·파이어폭스는 webm이 확실하다 */
export function clipSupport(): ClipSupport {
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return { ok: false, mime: '', ext: 'webm' }
  const candidates: [string, 'mp4' | 'webm'][] = [
    ['video/mp4;codecs=avc1.42E01E', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp9', 'webm'],
    ['video/webm;codecs=vp8', 'webm'],
    ['video/webm', 'webm'],
  ]
  for (const [mime, ext] of candidates) if (MediaRecorder.isTypeSupported(mime)) return { ok: true, mime, ext }
  return { ok: false, mime: '', ext: 'webm' }
}

export interface ClipOptions {
  /** 녹화 크기 (세로 화면 3:4) */
  width?: number
  height?: number
  fps?: number
  /** 배경색 (투명한 펫 캔버스 뒤) */
  background?: string
  /** 마지막에 얹는 그림 (워터마크 등). 녹화 캔버스 좌표로 그린다 */
  overlay?: (g: CanvasRenderingContext2D, w: number, h: number, t: number) => void
}

export class ClipRecorder {
  private readonly sources: HTMLCanvasElement[]
  private canvas: HTMLCanvasElement | null = null
  private g: CanvasRenderingContext2D | null = null
  private opts: Required<Omit<ClipOptions, 'overlay'>> & Pick<ClipOptions, 'overlay'> = { width: 720, height: 960, fps: 30, background: '#fdf1e4' }
  private t0 = 0
  /** 녹화 중인지 (main.ts가 이때만 captureFrame을 부른다) */
  active = false

  /** sources: 아래부터 겹칠 캔버스들 (모두 같은 화면 크기) */
  constructor(sources: HTMLCanvasElement[]) {
    this.sources = sources
  }

  /** 그리기 직후 부른다. 화면 가운데를 세로 3:4로 잘라 녹화 캔버스에 합친다 */
  captureFrame() {
    const g = this.g
    if (!this.active || !g) return
    const { width: w, height: h, background } = this.opts
    g.fillStyle = background
    g.fillRect(0, 0, w, h)
    for (const src of this.sources) {
      if (!src.width || !src.height) continue
      // 화면 가운데를 녹화 비율로 자른다 (가로가 넓은 PC 화면이면 양옆을, 세로가 긴 폰 화면이면 위아래를)
      const k = Math.min(src.width / w, src.height / h)
      const sw = w * k
      const sh = h * k
      g.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, w, h)
    }
    this.opts.overlay?.(g, w, h, (performance.now() - this.t0) / 1000)
  }

  /** seconds초 녹화해 영상 파일을 돌려준다 */
  async record(seconds: number, opts: ClipOptions = {}): Promise<Blob> {
    const support = clipSupport()
    if (!support.ok) throw new Error('이 브라우저는 영상 녹화를 지원하지 않아요')
    if (this.active) throw new Error('이미 녹화 중이에요')
    this.opts = { ...this.opts, ...opts }
    const { width, height, fps } = this.opts
    if (!this.canvas) this.canvas = document.createElement('canvas')
    this.canvas.width = width
    this.canvas.height = height
    this.g = this.canvas.getContext('2d', { alpha: false })
    const stream = this.canvas.captureStream(fps)
    const rec = new MediaRecorder(stream, { mimeType: support.mime, videoBitsPerSecond: 4_000_000 })
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    const done = new Promise<void>((resolve, reject) => {
      rec.onstop = () => resolve()
      rec.onerror = (e) => reject((e as unknown as { error?: Error }).error ?? new Error('녹화 실패'))
    })
    this.t0 = performance.now()
    this.active = true
    this.captureFrame()
    rec.start(500)
    await new Promise((r) => setTimeout(r, seconds * 1000))
    rec.stop()
    try {
      await done
    } finally {
      this.active = false
      stream.getTracks().forEach((t) => t.stop())
    }
    return new Blob(chunks, { type: support.mime.split(';')[0] })
  }
}
