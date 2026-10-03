/**
 * 배경 지우기 시험판 (개발 서버 전용, 배포 빌드에 넣지 않는다): /maker-spike.html
 * 모델 받기·사진 읽기·탭 처리 시간을 재고, 지운 결과를 체크무늬 위에 보여 준다.
 * ?src=<사진 경로>&auto=x,y(0~1)&model=v1|v2 면 열리자마자 한 번 돌려 window.__spike에 결과를 둔다 (헤드리스 측정용)
 */
import { loadSegmenter, segment, type Mask, type Pt, type SegModel } from './segment'

const q = new URLSearchParams(location.search)
const view = document.getElementById('view') as HTMLCanvasElement
const g = view.getContext('2d')!
const logEl = document.getElementById('log')!
const log = (s: string) => (logEl.textContent = `${s}\n${logEl.textContent}`)
/** 폰 사진은 크므로 긴 변을 이만큼으로 줄여서 쓴다 */
const MAX_SIDE = 1024

let img: HTMLCanvasElement | null = null
let taps: Pt[] = []
let negs: Pt[] = []
const model = () => ((document.querySelector('input[name=m]:checked') as HTMLInputElement)?.value ?? 'v2') as SegModel
if (q.get('model')) (document.querySelector(`input[value=${q.get('model')}]`) as HTMLInputElement).checked = true

async function open(src: string | Blob) {
  const bmp = await createImageBitmap(typeof src === 'string' ? await (await fetch(src)).blob() : src, { imageOrientation: 'from-image' })
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height))
  img = document.createElement('canvas')
  img.width = Math.round(bmp.width * k)
  img.height = Math.round(bmp.height * k)
  img.getContext('2d')!.drawImage(bmp, 0, 0, img.width, img.height)
  view.width = img.width
  view.height = img.height
  taps = []
  negs = []
  g.drawImage(img, 0, 0)
  log(`사진 ${bmp.width}x${bmp.height} → ${img.width}x${img.height}`)
}

function show(mask: Mask) {
  const d = img!.getContext('2d')!.getImageData(0, 0, img!.width, img!.height)
  for (let i = 0; i < mask.data.length; i++) d.data[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, mask.data[i])) * 255)
  g.clearRect(0, 0, view.width, view.height)
  g.putImageData(d, 0, 0)
  g.fillStyle = '#ff8a3d'
  for (const p of taps) g.fillRect(p.x - 4, p.y - 4, 8, 8)
  g.fillStyle = '#3b6cff'
  for (const p of negs) g.fillRect(p.x - 4, p.y - 4, 8, 8)
}

async function run(p: Pt, negative = false) {
  if (!img) return
  ;(negative ? negs : taps).push(p)
  const m = model()
  const { mask, timing } = await segment(m, img, taps, negs)
  show(mask)
  const cover = mask.data.reduce((a, v) => a + (v > 0.5 ? 1 : 0), 0) / mask.data.length
  const r = { model: m, ...timing, cover }
  ;(window as unknown as { __spike: unknown[] }).__spike ??= []
  ;(window as unknown as { __spike: unknown[] }).__spike.push(r)
  log(`${m}: ${timing.loadMs !== undefined ? `준비 ${timing.loadMs.toFixed(0)}ms · ` : ''}${timing.encodeMs !== undefined ? `사진 읽기 ${timing.encodeMs.toFixed(0)}ms · ` : ''}탭 ${timing.segmentMs.toFixed(0)}ms · 남은 부분 ${(cover * 100).toFixed(0)}%`)
}

let pressT = 0
view.addEventListener('pointerdown', () => (pressT = performance.now()))
view.addEventListener('pointerup', (e) => {
  const r = view.getBoundingClientRect()
  const p = { x: ((e.clientX - r.left) * view.width) / r.width, y: ((e.clientY - r.top) * view.height) / r.height }
  run(p, performance.now() - pressT > 450)
})
document.getElementById('file')!.addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) open(f)
})
document.querySelectorAll('input[name=m]').forEach((el) => el.addEventListener('change', () => loadSegmenter(model())))

loadSegmenter(model())
if (q.get('src')) {
  await open(q.get('src')!)
  const a = q.get('auto')
  if (a) {
    const [x, y] = a.split(',').map(Number)
    await run({ x: x * img!.width, y: y * img!.height })
    // 같은 사진에 한 번 더 탭 (v2는 사진을 다시 읽지 않는다)
    await run({ x: x * img!.width, y: y * img!.height * 1.1 })
    ;(window as unknown as { __done: boolean }).__done = true
  }
}
