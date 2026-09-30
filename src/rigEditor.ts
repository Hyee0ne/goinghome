import { deriveRig, type Landmarks, type Pt } from './rigDerive'

/**
 * 기준점 편집 화면 (/rig.html?id=<아이>, 개발 서버 전용).
 * 사진 파이프라인이 비전 모델로 찾은 핵심 기준점을 사진 위에 보여 주고, 드래그로 고친다.
 * 점을 옮기면 머리·주둥이·턱·눈썹·귀 회전 중심 같은 계산된 부위가 바로 따라 그려진다 (앱과 같은 deriveRig).
 * 저장 → 앱에 반영을 누르면 개발 서버가 파이프라인을 준비 단계부터 다시 돌린다 (표정 사진은 다시 만들지 않는다).
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const canvas = $<HTMLCanvasElement>('canvas')
const ctx = canvas.getContext('2d')!
const select = $<HTMLSelectElement>('pet')
const status = $('status')
const log = $<HTMLPreElement>('log')
const showRig = $<HTMLInputElement>('show-rig')

let id = new URLSearchParams(location.search).get('id') ?? ''
let lm: Landmarks | null = null
let img: HTMLImageElement | null = null
let view = { s: 1, ox: 0, oy: 0 }
let dragging: Handle | null = null
let dirty = false

/** 드래그할 수 있는 점. get/set은 사진 픽셀 좌표 */
interface Handle {
  label: string
  kind: 'point' | 'size'
  get(l: Landmarks): Pt
  set(l: Landmarks, p: Pt): void
}

const point = (label: string, key: 'leftEye' | 'rightEye' | 'nose' | 'mouth' | 'chin' | 'headTop'): Handle => ({
  label,
  kind: 'point',
  get: (l) => l[key],
  set: (l, p) => (l[key] = p),
})
const ear = (label: string, side: 'leftEar' | 'rightEar', part: 'base' | 'tip' | 'outer'): Handle => ({
  label,
  kind: 'point',
  get: (l) => l[side][part],
  set: (l, p) => (l[side][part] = p),
})
const HANDLES: Handle[] = [
  point('왼눈', 'leftEye'),
  point('오른눈', 'rightEye'),
  point('코', 'nose'),
  point('입', 'mouth'),
  point('턱끝', 'chin'),
  point('정수리', 'headTop'),
  ear('왼귀 붙은 곳', 'leftEar', 'base'),
  ear('왼귀 끝', 'leftEar', 'tip'),
  ear('왼귀 바깥', 'leftEar', 'outer'),
  ear('오른귀 붙은 곳', 'rightEar', 'base'),
  ear('오른귀 끝', 'rightEar', 'tip'),
  ear('오른귀 바깥', 'rightEar', 'outer'),
  {
    label: '눈 크기',
    kind: 'size',
    get: (l) => ({ x: l.leftEye.x + l.eyeR, y: l.leftEye.y }),
    set: (l, p) => (l.eyeR = Math.max(4, Math.round(Math.hypot(p.x - l.leftEye.x, p.y - l.leftEye.y)))),
  },
  {
    label: '코 크기',
    kind: 'size',
    get: (l) => ({ x: l.nose.x + l.noseRx, y: l.nose.y + l.noseRy }),
    set: (l, p) => {
      l.noseRx = Math.max(4, Math.round(Math.abs(p.x - l.nose.x)))
      l.noseRy = Math.max(4, Math.round(Math.abs(p.y - l.nose.y)))
    },
  },
]

// ───────────────────────── 불러오기 ─────────────────────────

async function loadList() {
  const ids: string[] = await (await fetch('/__pets')).json()
  select.innerHTML = ids.map((i) => `<option value="${i}">${i}</option>`).join('')
  if (!id && ids[0]) id = ids[0]
  if (!ids.length) status.textContent = '아직 만든 아이가 없어요. npm run pet:add -- <사진> --id <이름> 으로 먼저 만들어 주세요.'
  select.value = id
  if (id) await loadPet(id)
}

async function loadPet(next: string) {
  if (dirty && !confirm('저장하지 않은 변경이 있어요. 다른 아이로 옮길까요?')) {
    select.value = id
    return
  }
  id = next
  history.replaceState(null, '', `?id=${id}`)
  lm = await (await fetch(`/__pets/${id}/landmarks`)).json()
  img = new Image()
  img.src = `/pets/${id}/face.webp?t=${Date.now()}`
  await img.decode()
  dirty = false
  resize()
}

select.onchange = () => loadPet(select.value)

// ───────────────────────── 그리기 ─────────────────────────

function resize() {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.parentElement!.clientWidth
  const h = window.innerHeight - canvas.getBoundingClientRect().top - 16
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  if (img) {
    const s = Math.min(w / img.width, h / img.height)
    view = { s, ox: (w - img.width * s) / 2, oy: (h - img.height * s) / 2 }
  }
  draw()
}
window.addEventListener('resize', resize)
showRig.onchange = () => draw()

const toScreen = (p: Pt) => ({ x: view.ox + p.x * view.s, y: view.oy + p.y * view.s })
const toImage = (x: number, y: number) => ({ x: Math.round((x - view.ox) / view.s), y: Math.round((y - view.oy) / view.s) })

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (!img || !lm) return
  ctx.fillStyle = '#e9e4dc'
  ctx.fillRect(view.ox, view.oy, img.width * view.s, img.height * view.s)
  ctx.drawImage(img, view.ox, view.oy, img.width * view.s, img.height * view.s)

  if (showRig.checked) {
    const rig = deriveRig(lm, { src: '', flow: '', width: img.width, height: img.height, bottom: img.height })
    const el = (e: { x: number; y: number; rx: number; ry: number }, color: string, dash = false) => {
      const c = toScreen(e)
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.setLineDash(dash ? [5, 4] : [])
      ctx.beginPath()
      ctx.ellipse(c.x, c.y, e.rx * view.s, e.ry * view.s, 0, 0, Math.PI * 2)
      ctx.stroke()
    }
    el(rig.head, 'rgba(255,80,80,.8)', true)
    el(rig.skull, 'rgba(255,160,60,.6)', true)
    el(rig.muzzle, 'rgba(255,160,60,.8)')
    el(rig.chin, 'rgba(160,90,255,.9)')
    for (const b of rig.brows) el(b, 'rgba(90,200,120,.9)')
    for (const e of rig.ears) {
      el(e, 'rgba(230,60,200,.8)')
      const p = toScreen({ x: e.px, y: e.py })
      ctx.fillStyle = 'rgba(230,60,200,.9)'
      ctx.fillRect(p.x - 3, p.y - 3, 6, 6)
    }
    for (const n of rig.nostrils) el({ x: n.x, y: n.y, rx: n.r, ry: n.r }, 'rgba(60,160,255,.9)')
    el(rig.chest, 'rgba(0,180,200,.6)', true)
    ctx.setLineDash([])
  }

  // 눈과 코 크기
  ctx.strokeStyle = '#1e90ff'
  ctx.lineWidth = 2
  for (const e of [lm.leftEye, lm.rightEye]) {
    const c = toScreen(e)
    ctx.beginPath()
    ctx.arc(c.x, c.y, lm.eyeR * view.s, 0, Math.PI * 2)
    ctx.stroke()
  }
  const n = toScreen(lm.nose)
  ctx.beginPath()
  ctx.ellipse(n.x, n.y, lm.noseRx * view.s, lm.noseRy * view.s, 0, 0, Math.PI * 2)
  ctx.stroke()

  // 귀 모양 (붙은 곳 → 바깥 → 끝)
  ctx.strokeStyle = 'rgba(255,255,255,.8)'
  for (const e of [lm.leftEar, lm.rightEar]) {
    const [a, b, c] = [e.base, e.outer, e.tip].map(toScreen)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.lineTo(c.x, c.y)
    ctx.stroke()
  }

  // 손잡이
  ctx.font = '600 12px system-ui, sans-serif'
  for (const h of HANDLES) {
    const p = toScreen(h.get(lm))
    const active = h === dragging
    ctx.fillStyle = h.kind === 'size' ? '#1e90ff' : active ? '#ff8a3d' : '#fff'
    ctx.strokeStyle = '#222'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    if (h.kind === 'size') ctx.rect(p.x - 5, p.y - 5, 10, 10)
    else ctx.arc(p.x, p.y, 6, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = 'rgba(0,0,0,.65)'
    const w = ctx.measureText(h.label).width + 8
    ctx.fillRect(p.x + 9, p.y - 9, w, 18)
    ctx.fillStyle = '#fff'
    ctx.fillText(h.label, p.x + 13, p.y + 4)
  }
}

// ───────────────────────── 드래그 ─────────────────────────

canvas.addEventListener('pointerdown', (e) => {
  if (!lm) return
  const r = canvas.getBoundingClientRect()
  const x = e.clientX - r.left
  const y = e.clientY - r.top
  let best: Handle | null = null
  let bestD = 14
  for (const h of HANDLES) {
    const p = toScreen(h.get(lm))
    const d = Math.hypot(p.x - x, p.y - y)
    if (d < bestD) {
      best = h
      bestD = d
    }
  }
  dragging = best
  if (best) canvas.setPointerCapture(e.pointerId)
  draw()
})
canvas.addEventListener('pointermove', (e) => {
  if (!dragging || !lm) return
  const r = canvas.getBoundingClientRect()
  dragging.set(lm, toImage(e.clientX - r.left, e.clientY - r.top))
  dirty = true
  status.textContent = '바뀐 기준점이 있어요. 저장한 뒤 "앱에 반영"을 눌러 주세요.'
  draw()
})
canvas.addEventListener('pointerup', () => {
  dragging = null
  draw()
})

// ───────────────────────── 저장 · 반영 ─────────────────────────

async function save() {
  if (!lm) return false
  const r = await fetch(`/__pets/${id}/landmarks`, { method: 'POST', body: JSON.stringify(lm) })
  if (!r.ok) {
    status.textContent = '저장하지 못했어요.'
    return false
  }
  dirty = false
  status.textContent = '저장했어요.'
  return true
}

$('save').onclick = save
$('rebuild').onclick = async () => {
  if (dirty && !(await save())) return
  const btn = $<HTMLButtonElement>('rebuild')
  btn.disabled = true
  status.textContent = '앱용 에셋을 다시 만드는 중… (표정 사진은 그대로 쓰므로 수십 초면 끝나요)'
  const r = await fetch(`/__pets/${id}/rebuild`, { method: 'POST' })
  const res = await r.json()
  btn.disabled = false
  log.hidden = false
  log.textContent = res.log
  status.textContent = res.ok ? '반영했어요. 앱 탭을 새로고침하면 보여요.' : '다시 만들다가 실패했어요. 아래 로그를 확인해 주세요.'
  if (res.ok) await loadPet(id)
}

window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault()
})

// 편집 화면 스타일 (앱 스타일과 섞이지 않게 여기에 둔다)
const style = document.createElement('style')
style.textContent = `
  body { margin: 0; font-family: 'Pretendard', 'Apple SD Gothic Neo', system-ui, sans-serif; background: #f6f1ea; color: #4a3322; }
  .bar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: #fff; border-bottom: 1px solid #e5dccf; flex-wrap: wrap; }
  .bar select, .bar button { font: inherit; padding: 6px 12px; border: 1px solid #d9cdbd; border-radius: 8px; background: #fff; }
  .bar button.primary { background: #4a3322; color: #fff; border-color: #4a3322; }
  .bar button:disabled { opacity: .5; }
  .spacer { flex: 1; }
  .status { margin: 8px 16px; font-size: 14px; }
  .wrap { padding: 0 16px; }
  canvas { display: block; touch-action: none; cursor: crosshair; }
  .log { margin: 8px 16px; max-height: 200px; overflow: auto; font-size: 12px; background: #221a14; color: #cfe; padding: 8px; border-radius: 8px; }
`
document.head.append(style)

loadList()
