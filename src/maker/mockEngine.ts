/**
 * 가짜 엔진: 기술 쪽 실제 엔진이 나오기 전까지 화면 흐름을 확인하는 용도.
 * 배경 지우기는 탭한 자리를 중심으로 한 타원, 리그는 만들지 않는다 (photo 대신 null을 돌려 앱이 아직 못 연다).
 */
import type { MakerEngine, MaskHandle, MaskStroke, RigResult } from './engineTypes'
import type { Pt, Taps } from '../myPets'

class MockMask implements MaskHandle {
  readonly canvas: HTMLCanvasElement
  readonly width: number
  readonly height: number
  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.canvas = Object.assign(document.createElement('canvas'), { width, height })
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const mockEngine: MakerEngine = {
  async loadSegmenter() {
    await wait(300)
  },

  async segment(img: ImageBitmap, tap: Pt) {
    await wait(250)
    const m = new MockMask(img.width, img.height)
    const g = m.canvas.getContext('2d')!
    g.fillStyle = '#000'
    g.beginPath()
    g.ellipse(tap.x, tap.y, img.width * 0.34, img.height * 0.4, 0, 0, Math.PI * 2)
    g.fill()
    return m
  },

  editMask(m: MaskHandle, s: MaskStroke) {
    const g = (m as MockMask).canvas.getContext('2d')!
    g.save()
    g.globalCompositeOperation = s.mode === 'erase' ? 'destination-out' : 'source-over'
    g.strokeStyle = g.fillStyle = '#000'
    g.lineWidth = s.r * 2
    g.lineCap = g.lineJoin = 'round'
    g.beginPath()
    s.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)))
    if (s.pts.length === 1) g.arc(s.pts[0].x, s.pts[0].y, s.r, 0, Math.PI * 2), g.fill()
    else g.stroke()
    g.restore()
  },

  maskPreview(img: ImageBitmap, m: MaskHandle) {
    const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height })
    const g = c.getContext('2d')!
    g.drawImage(img, 0, 0)
    g.globalCompositeOperation = 'destination-in'
    g.drawImage((m as MockMask).canvas, 0, 0)
    return c
  },

  async rigFromTaps(_img: ImageBitmap, _m: MaskHandle, taps: Taps) {
    await wait(900)
    // 두 눈이 얼마나 수평이고, 코가 두 눈 가운데에 있는지로 정면도를 어림한다 (실제 엔진도 비슷하게 계산할 예정)
    const dx = taps.eyeR.x - taps.eyeL.x
    const dy = taps.eyeR.y - taps.eyeL.y
    const mid = (taps.eyeL.x + taps.eyeR.x) / 2
    const tilt = Math.abs(Math.atan2(dy, dx))
    const offset = Math.abs(taps.nose.x - mid) / Math.max(1, Math.abs(dx))
    const frontal = Math.max(0, 1 - tilt * 1.5 - offset * 1.6)
    const warnings = []
    if (offset > 0.25) warnings.push('얼굴이 옆으로 돌아가 있어요. 정면 사진이 더 자연스러워요.')
    return { photo: null, files: {}, quality: { frontal, warnings } } as unknown as RigResult
  },
}
