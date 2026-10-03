/**
 * 공고 중인 유기동물 사진을 실사로 만든다 (주 1회, 이 맥에서 사람이 돌린다).
 *
 *   npm run shelter:make                         후보(public/data/candidates.json)를 판정하고 만들어 미리보기를 연다
 *   npm run shelter:make -- --publish id1,id2    미리보기에서 고른 아이만 로컬 shelter-data 브랜치로 확정 (push는 사람이 따로)
 *
 * 옵션
 *   --judge apple    (기본) 사진 판정과 눈·코·귀 위치를 macOS Apple Vision으로 (무료)
 *   --judge vision   비전 모델(유료, 장당 약 $0.01~0.03)로 판정·기준점. --dry-run이면 호출하지 않고 보낼 내용만 보여 주고 Apple Vision 값을 쓴다
 *   --limit N        종마다 앞에서 N마리만 (기본 전부)
 *
 * 단계 (아이마다, 결과는 pets-src/shelter-<공고번호>/에 남아 다시 돌리면 이어서 한다)
 *   1) 사진 받기: 공고 사진(최대 8장)을 차례로 받아 첫 번째로 통과하는 사진을 쓴다
 *   2) 판정: 동물 한 마리, 종 일치, 사람 얼굴 없음, 손이 얼굴 근처에 없음, 얼굴 크기, 정면도 (scripts/animal-detect.swift)
 *   3) 실사 만들기: pet-add.ts의 배경 지우기(Apple Vision)·정면 맞추기·자르기·털 결을 그대로 쓴다. 표정 AI는 쓰지 않는다
 *   4) 미리보기: pets-src/shelter-stage/preview.html (사람이 보고 고른다. 철창·목줄이 얼굴을 가리는지는 사람이 본다)
 * 확정(--publish)하면 shelter-data 브랜치를 '지금 공개할 아이들'만으로 새로 만든다 (기록이 쌓이지 않게 매번 부모 없는 커밋).
 * 배포 워크플로가 이 브랜치를 public/shelter/로 받는다. 구조: manifest.json + <공고번호>/{face.webp, flow.png, catch.png, photo.jpg}
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deriveRig, dist, type Landmarks, type Pt } from '../src/rigDerive.ts'

const ROOT = resolve(import.meta.dirname, '..')
const DATA = join(ROOT, 'public', 'data')
const STAGE = join(ROOT, 'pets-src', 'shelter-stage')
const BRANCH = 'shelter-data'

const args: Record<string, string> = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++)
  if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? 'true' : argv[++i]
const JUDGE = (args.judge ?? 'apple') as 'apple' | 'vision'
const DRY = args['dry-run'] === 'true'

/** 판정 기준 (무료 판정) */
const MIN_EYE_GAP = 80 // 두 눈 사이(원본 픽셀). 이보다 작으면 털이 뭉개져 보인다
const MAX_YAW = 0.18 // 코가 두 눈 가운데에서 옆으로 비껴난 정도 (두 눈 사이 거리 비율)
const MIN_JOINT = 0.5 // 눈·코 관절 확신도
/** 자른 뒤 앱 화면 배치 (펫 로컬 좌표, FLOOR_Y 250 기준). 폰 세로 화면에서 보이는 위쪽 끝이 약 -370 */
const MIN_HEAD_TOP = -360 // 머리 위 끝이 이보다 위로 가면 화면 위에서 잘린다 (초코·삼식 약 -320)
const MAX_BELOW_CHIN = 2.6 // 턱 아래로 보이는 몸 길이 (두 눈 사이 거리 배). 길면 가슴 대신 다리·몸통이 크게 보인다 (보통 2.2~2.4)

interface Animal {
  id: string
  sp: 'dog' | 'cat' | 'etc'
  photos: string[]
  end: string
}
interface Candidate {
  id: string
  score: number
  reasons: string[]
}
interface Detect {
  width: number
  height: number
  animals: { label: string; confidence: number; box: number[] }[]
  humanFaces: number
  hands: Pt[]
  pose?: Record<string, { x: number; y: number; c: number }>
}
interface Verdict {
  id: string
  sp: 'dog' | 'cat'
  ok: boolean
  /** 통과한 사진 번호 (0부터) */
  photo?: number
  why: string[]
  made?: boolean
  rig?: unknown
}

const log = (s: string) => console.log(s)
const fail = (s: string): never => {
  console.error(`✗ ${s}`)
  process.exit(1)
}
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const writeJson = (p: string, d: unknown) => writeFileSync(p, JSON.stringify(d, null, 2) + '\n')

// ───────────────────────── 만들기 ─────────────────────────

async function make() {
  if (!existsSync(join(DATA, 'candidates.json')) || !existsSync(join(DATA, 'animals.json')))
    fail('public/data/candidates.json, animals.json이 없어요. 먼저 npm run data:animals')
  if (JUDGE === 'vision' && !DRY && !args['yes-paid']) fail('--judge vision은 유료예요. 정말 쓰려면 --yes-paid를 붙이세요 (먼저 --dry-run으로 확인)')
  const cands = readJson(join(DATA, 'candidates.json')) as { dogs: Candidate[]; cats: Candidate[] }
  const animals = new Map((readJson(join(DATA, 'animals.json')).animals as Animal[]).map((a) => [a.id, a]))
  const limit = args.limit ? Number(args.limit) : Infinity
  const list = [...cands.dogs.slice(0, limit), ...cands.cats.slice(0, limit)]
  mkdirSync(STAGE, { recursive: true })
  const verdicts: Verdict[] = []
  for (const c of list) {
    const a = animals.get(c.id)
    if (!a || a.sp === 'etc') {
      verdicts.push({ id: c.id, sp: 'dog', ok: false, why: ['공고 목록에 없어요 (끝났을 수 있어요)'] })
      continue
    }
    log(`\n▶ ${a.sp === 'dog' ? '🐶' : '🐱'} ${c.id} (${c.reasons.join(', ')})`)
    const v = await judge(a)
    if (v.ok) {
      try {
        v.rig = build(a, v.photo!)
        v.made = true
        // 자른 뒤 구도: 머리가 화면 안에 들어오는지, 턱 아래로 다리·몸통이 너무 길게 보이지 않는지
        const bad = layoutProblems(v.rig as Rig)
        if (bad.length) {
          v.ok = false
          v.why.push(...bad)
        }
      } catch (e) {
        v.ok = false
        v.why.push(`실사 만들기 실패: ${(e as Error).message.split('\n')[0]}`)
      }
    }
    log(`   ${v.ok ? '✓ 통과' : '✗ 탈락'}: ${v.why.join(' · ')}`)
    verdicts.push(v)
  }
  writeJson(join(STAGE, 'verdicts.json'), { updated: new Date().toISOString(), judge: JUDGE, verdicts })
  writePreview(verdicts, animals)
  const ok = verdicts.filter((v) => v.ok)
  log(`\n완료: ${ok.length}/${verdicts.length}마리 통과. 미리보기: ${join(STAGE, 'preview.html')}`)
  log(`고른 뒤: npm run shelter:make -- --publish ${ok.map((v) => v.id).join(',') || '<공고번호,...>'}`)
}

/** 공고 사진을 차례로 받아 판정한다. 처음 통과하는 사진을 쓴다 */
async function judge(a: Animal): Promise<Verdict> {
  const dir = join(ROOT, 'pets-src', `shelter-${a.id}`)
  mkdirSync(dir, { recursive: true })
  const why: string[] = []
  for (let i = 0; i < a.photos.length; i++) {
    const file = join(dir, `src-${i}.jpg`)
    if (!existsSync(file)) {
      const res = await fetch(a.photos[i]).catch(() => null)
      if (!res?.ok) {
        why.push(`사진 ${i + 1}: 받지 못함`)
        continue
      }
      writeFileSync(file, Buffer.from(await res.arrayBuffer()))
    }
    const det = detectFree(file, join(dir, `src-${i}.detect.json`))
    const problems = det ? check(det, a.sp as 'dog' | 'cat') : ['Apple Vision 실패']
    if (!problems.length) {
      // 기준점: 무료면 Apple Vision 관절에서, 유료면 비전 모델에서 (pet-add 'detect' 결과와 같은 모양으로 둔다)
      const raw = JUDGE === 'vision' ? await visionLandmarks(file, det!, a.sp as 'dog' | 'cat') : rawFromPose(det!, a.sp as 'dog' | 'cat')
      if (!raw) {
        why.push(`사진 ${i + 1}: 기준점을 찾지 못함`)
        continue
      }
      writeJson(join(dir, 'landmarks.raw.json'), raw)
      return { id: a.id, sp: a.sp as 'dog' | 'cat', ok: true, photo: i, why: [`사진 ${i + 1} 사용`, `정면도 ${(100 - Math.abs(yawOf(det!)) * 100).toFixed(0)}%`] }
    }
    why.push(`사진 ${i + 1}: ${problems.join(', ')}`)
  }
  return { id: a.id, sp: a.sp as 'dog' | 'cat', ok: false, why: why.length ? why : ['사진이 없어요'] }
}

function detectFree(photo: string, cache: string): Detect | null {
  if (existsSync(cache)) return readJson(cache)
  const r = spawnSync('swift', [join(ROOT, 'scripts', 'animal-detect.swift'), photo], { encoding: 'utf8', timeout: 120_000 })
  if (r.status !== 0) return null
  writeFileSync(cache, r.stdout)
  return JSON.parse(r.stdout)
}

const J = (d: Detect, name: string) => d.pose?.[`animal_joint_${name}`]

function eyesOf(d: Detect) {
  const a = J(d, 'left_eye')
  const b = J(d, 'right_eye')
  if (!a || !b) return null
  // 픽셀 좌표로 (사진 왼쪽 눈이 먼저)
  const P = (p: { x: number; y: number }) => ({ x: p.x * d.width, y: p.y * d.height })
  const [l, r] = a.x < b.x ? [P(a), P(b)] : [P(b), P(a)]
  return { l, r, c: Math.min(a.c, b.c) }
}

/** 고개가 옆으로 돌아간 정도: 코가 두 눈 가운데에서 비껴난 거리 / 두 눈 사이 */
function yawOf(d: Detect) {
  const e = eyesOf(d)
  const n = J(d, 'nose')
  if (!e || !n) return 1
  return (n.x * d.width - (e.l.x + e.r.x) / 2) / dist(e.l, e.r)
}

/** 무료 판정. 문제가 없으면 빈 배열 */
function check(d: Detect, sp: 'dog' | 'cat'): string[] {
  const out: string[] = []
  const want = sp === 'dog' ? 'Dog' : 'Cat'
  const animals = d.animals.filter((a) => a.confidence >= 0.4)
  if (animals.length !== 1) out.push(animals.length ? `동물 ${animals.length}마리` : '동물을 못 찾음')
  else if (animals[0].label !== want) out.push(`${animals[0].label}로 보임`)
  if (d.humanFaces > 0) out.push('사람 얼굴')
  const e = eyesOf(d)
  const n = J(d, 'nose')
  if (!e || !n || e.c < MIN_JOINT || n.c < MIN_JOINT) {
    out.push('눈·코가 또렷하지 않음')
    return out
  }
  const D = dist(e.l, e.r)
  if (D < MIN_EYE_GAP) out.push(`얼굴이 작음 (눈 사이 ${D.toFixed(0)}px)`)
  const yaw = yawOf(d)
  if (Math.abs(yaw) > MAX_YAW) out.push(`고개가 옆으로 돌아감 (${(yaw * 100).toFixed(0)}%)`)
  // 손이 얼굴(눈·코 둘레, 두 눈 사이 거리의 1.5배 안)에 있으면 가린다
  const face = { x: (e.l.x + e.r.x + n.x * d.width) / 3, y: (e.l.y + e.r.y + n.y * d.height) / 3 }
  if (d.hands.some((h) => Math.hypot(h.x * d.width - face.x, h.y * d.height - face.y) < D * 1.5)) out.push('손이 얼굴 근처에 있음')
  return out
}

/**
 * Apple Vision 관절(눈·코·귀 위·가운데·아래)에서 pet-add 'detect' 결과(landmarks.raw.json, 0~1000 좌표)를 만든다.
 * 입·턱·정수리는 관절에 없어서 눈→코 방향과 거리로 놓는다 (초코·삼식 비율)
 */
function rawFromPose(d: Detect, sp: 'dog' | 'cat') {
  const e = eyesOf(d)!
  const nj = J(d, 'nose')!
  const n = { x: nj.x * d.width, y: nj.y * d.height }
  const mid = { x: (e.l.x + e.r.x) / 2, y: (e.l.y + e.r.y) / 2 }
  const D = dist(e.l, e.r)
  const down = { x: n.x - mid.x, y: n.y - mid.y }
  const at = (k: number) => ({ x: mid.x + down.x * k, y: mid.y + down.y * k })
  const cat = sp === 'cat'
  const N = (p: Pt) => ({ x: Math.round((p.x / d.width) * 1000), y: Math.round((p.y / d.height) * 1000) })
  const nx = (v: number) => Math.round((v / d.width) * 1000)
  const ny = (v: number) => Math.round((v / d.height) * 1000)
  // 귀: 사진 왼쪽 귀 = 사진 왼쪽 눈 쪽 관절. 위(끝)·아래(붙은 곳)·셋 중 얼굴 가운데에서 가장 먼 점(바깥)
  const ear = (side: 'left' | 'right') => {
    const pts = (['top', 'middle', 'bottom'] as const).map((k) => J(d, `${side}_ear_${k}`)).map((p) => p && { x: p.x * d.width, y: p.y * d.height })
    return pts.every(Boolean) ? (pts as Pt[]) : null
  }
  const ears = [ear('left'), ear('right')].filter(Boolean) as Pt[][]
  const sideOf = (pts: Pt[]) => (pts[1].x < mid.x ? 'L' : 'R')
  const fallback = (s: -1 | 1): Pt[] => [
    { x: mid.x + s * D * 0.9, y: mid.y - D * (cat ? 1.1 : 0.6) },
    { x: mid.x + s * D * 0.85, y: mid.y - D * 0.6 },
    { x: mid.x + s * D * 0.5, y: mid.y - D * 0.7 },
  ]
  const L = ears.find((p) => sideOf(p) === 'L') ?? fallback(-1)
  const R = ears.find((p) => sideOf(p) === 'R') ?? fallback(1)
  const outer = (pts: Pt[]) => pts.reduce((a, b) => (Math.abs(b.x - mid.x) > Math.abs(a.x - mid.x) ? b : a))
  const yaw = Math.abs(yawOf(d))
  return {
    species: sp,
    frontal: yaw < 0.1,
    left_eye: N(e.l),
    right_eye: N(e.r),
    eye_radius: nx(D * 0.11),
    nose: N(n),
    nose_width: nx(D * (cat ? 0.26 : 0.5)),
    nose_height: ny(D * (cat ? 0.26 : 0.42)),
    mouth: N(at(cat ? 1.45 : 1.4)),
    // 턱 끝: 눈→코 거리의 1.9배(고양이)·1.8배(개). 삼식 1.93, 초코 1.79
    chin_bottom: N(at(cat ? 1.9 : 1.8)),
    head_top: N(at(cat ? -1.1 : -1.0)),
    left_ear_base: N(L[2]),
    left_ear_tip: N(L[0]),
    left_ear_outer: N(outer(L)),
    right_ear_base: N(R[2]),
    right_ear_tip: N(R[0]),
    right_ear_outer: N(outer(R)),
    _source: 'apple-vision',
  }
}

/** 유료 판정 (비전 모델): pet-add detect와 같은 기준점 + 사진 품질. --dry-run이면 호출하지 않는다 */
async function visionLandmarks(photo: string, d: Detect, sp: 'dog' | 'cat') {
  const prompt =
    'This is a shelter photo of an animal with a coordinate grid overlay (0-1000 on each axis). Judge whether it is usable for a front-facing ' +
    'face portrait (single animal, face toward the camera, eyes and nose sharp, no hands/leash/cage bars covering the face, no human face) and ' +
    'locate the facial landmarks exactly as in the landmarks schema. Answer with the JSON.'
  if (DRY) {
    log(`   (dry-run) 비전 모델에 보낼 것: ${photo} + 격자, 프롬프트 ${prompt.length}자 → 호출하지 않고 Apple Vision 값을 씁니다`)
    return rawFromPose(d, sp)
  }
  fail('비전 모델 판정은 아직 사용자 확인 전이라 막아 두었어요')
}

type Rig = ReturnType<typeof deriveRig>

/** 앱이 사진을 놓는 방식(발밑 = FLOOR_Y, rig.scale)으로 머리 위치를 계산해 구도를 본다 */
function layoutProblems(r: Rig) {
  const out: string[] = []
  const FLOOR_Y = 250
  const headTop = (r.head.y - r.head.ry - r.footY) * r.scale + FLOOR_Y
  const D = dist(r.eyes[0], r.eyes[1])
  const belowChin = (r.footY - (r.head.y + r.head.ry)) / D
  if (headTop < MIN_HEAD_TOP) out.push(`자른 뒤 머리가 화면 위로 잘림 (${headTop.toFixed(0)})`)
  if (belowChin > MAX_BELOW_CHIN) out.push(`턱 아래로 몸·다리가 길게 보임 (${belowChin.toFixed(1)}D)`)
  return out
}

/** pet-add.ts로 실사 에셋을 만들고(표정 없이), 앱용 리그를 계산해 무대(stage)에 둔다 */
function build(a: Animal, photo: number) {
  const id = `shelter-${a.id}`
  const SRC = join(ROOT, 'pets-src', id)
  const PUB = join(ROOT, 'public', 'pets', id)
  const add = (...extra: string[]) => {
    const r = spawnSync('node', [join(ROOT, 'scripts', 'pet-add.ts'), ...extra], { cwd: ROOT, encoding: 'utf8' })
    if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' '))
    return r.stdout
  }
  // 배경 지우기만 먼저 (detect는 건너뛰고 위에서 만든 landmarks.raw.json을 쓴다)
  add(join(SRC, `src-${photo}.jpg`), '--id', id, '--species', a.sp, '--until', 'cutout')
  add('--id', id, '--from', 'frontal', '--until', 'prepare')
  const lm = readJson(join(SRC, 'landmarks.json')) as Landmarks
  const face = readJson(join(PUB, 'face.json'))
  const frame = readJson(join(SRC, 'frame.json'))
  const base = `shelter/${a.id}`
  const out = join(STAGE, a.id)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  copyFileSync(join(PUB, 'face.webp'), join(out, 'face.webp'))
  copyFileSync(join(PUB, 'face-flow.png'), join(out, 'flow.png'))
  const hasCatch = existsSync(join(PUB, 'face-catch.png'))
  if (hasCatch) copyFileSync(join(PUB, 'face-catch.png'), join(out, 'catch.png'))
  // 정보 화면용 대표 사진 (긴 변 1024로 줄여서)
  spawnSync('python3', ['-c', 'import sys; from PIL import Image, ImageOps; im=ImageOps.exif_transpose(Image.open(sys.argv[1])).convert("RGB"); im.thumbnail((1024,1024)); im.save(sys.argv[2], quality=85)', join(SRC, 'photo.jpg'), join(out, 'photo.jpg')])
  // 앱 에셋 자리(public/pets/<id>)는 pet-add가 쓰는 임시 자리라 지운다 (저장소에 올라가지 않게)
  rmSync(PUB, { recursive: true, force: true })
  return {
    ...deriveRig(lm, { src: `${base}/face.webp`, flow: `${base}/flow.png`, ...(hasCatch && { catchlight: `${base}/catch.png` }), width: face.width, height: face.height, bottom: face.bottom }),
    ...((frame.cutLeft || frame.cutRight) && {
      fadeSides: { ...(frame.cutLeft && { left: -face.offsetX }), ...(frame.cutRight && { right: 1086 - face.offsetX }) },
    }),
  }
}

// ───────────────────────── 미리보기 ─────────────────────────

function writePreview(verdicts: Verdict[], animals: Map<string, Animal>) {
  const card = (v: Verdict) => {
    const a = animals.get(v.id)
    const src = v.photo !== undefined ? `../shelter-${v.id}/src-${v.photo}.jpg` : a?.photos[0] ?? ''
    return `<label class="card ${v.ok ? 'ok' : 'no'}">
  <div class="imgs"><img src="${src}" loading="lazy">${v.made ? `<img class="face" src="${v.id}/face.webp" loading="lazy">` : ''}</div>
  <div class="meta">${v.ok ? `<input type="checkbox" value="${v.id}" checked> ` : ''}<b>${v.sp === 'dog' ? '🐶' : '🐱'} ${v.id}</b>
  <small>${v.why.join('<br>')}</small></div>
</label>`
  }
  const html = `<!doctype html><meta charset="utf-8"><title>공고 아이 실사 미리보기</title>
<style>
body{font:14px system-ui;margin:16px;background:#fdf1e4;color:#3b2a1e}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.card{display:block;background:#fff;border-radius:12px;padding:8px;border:2px solid transparent}
.card.ok{border-color:#7ec27e}.card.no{opacity:.55}
.imgs{display:flex;gap:6px}.imgs img{width:50%;aspect-ratio:3/4;object-fit:contain;border-radius:8px;background:#eee}
.imgs img.face{background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/16px 16px}
small{display:block;color:#7a6556;margin-top:4px}pre{background:#fff;padding:10px;border-radius:8px;white-space:pre-wrap}
</style>
<h2>공고 아이 실사 미리보기 (판정: ${JUDGE === 'apple' ? 'Apple Vision, 무료' : '비전 모델'})</h2>
<p>철창·목줄·손이 얼굴을 가리는지, 배경이 남았는지 보고 공개할 아이만 체크하세요. 아래 명령을 터미널에 붙여 넣으면 로컬 ${BRANCH} 브랜치로 확정돼요 (push는 따로).</p>
<pre id="cmd"></pre>
<div class="grid">${verdicts.map(card).join('\n')}</div>
<script>
const upd=()=>{document.getElementById('cmd').textContent='npm run shelter:make -- --publish '+[...document.querySelectorAll('input:checked')].map(i=>i.value).join(',')}
document.addEventListener('change',upd);upd()
</script>`
  writeFileSync(join(STAGE, 'preview.html'), html)
}

// ───────────────────────── 확정 (로컬 브랜치) ─────────────────────────

function publish(ids: string[]) {
  const v = existsSync(join(STAGE, 'verdicts.json')) ? (readJson(join(STAGE, 'verdicts.json')).verdicts as Verdict[]) : fail('먼저 npm run shelter:make')
  const pick = v.filter((x) => ids.includes(x.id) && x.ok && x.rig && existsSync(join(STAGE, x.id, 'face.webp')))
  const missing = ids.filter((id) => !pick.some((p) => p.id === id))
  if (missing.length) fail(`만들어지지 않았거나 통과하지 못한 아이예요: ${missing.join(', ')}`)
  // 브랜치에 넣을 파일만 모은 폴더
  const tree = join(STAGE, '_publish')
  rmSync(tree, { recursive: true, force: true })
  mkdirSync(tree, { recursive: true })
  const madeAt = new Date().toISOString()
  for (const p of pick) {
    mkdirSync(join(tree, p.id))
    for (const f of readdirSync(join(STAGE, p.id))) copyFileSync(join(STAGE, p.id, f), join(tree, p.id, f))
  }
  writeJson(join(tree, 'manifest.json'), {
    updated: madeAt,
    pets: pick.map((p) => ({ id: p.id, sp: p.sp, madeAt, rig: p.rig, photo: `shelter/${p.id}/photo.jpg` })),
  })
  // 부모 없는 커밋 하나로 브랜치를 새로 만든다 (지금 공개할 아이들만, 기록이 쌓이지 않게). 작업 폴더·현재 브랜치는 건드리지 않는다
  const index = join(STAGE, '_index')
  rmSync(index, { force: true })
  const git = (...a: string[]) => {
    const r = spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: index } })
    if (r.status !== 0) fail(`git ${a.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  git('--work-tree', tree, 'add', '-A', '.')
  const sha = git('commit-tree', git('write-tree'), '-m', `공고 아이 실사 ${pick.length}마리 (${madeAt.slice(0, 10)})`)
  git('update-ref', `refs/heads/${BRANCH}`, sha)
  rmSync(index, { force: true })
  log(`✓ 로컬 ${BRANCH} 브랜치를 ${pick.length}마리로 새로 만들었어요 (${sha.slice(0, 7)}). 공개하려면: git push -f origin ${BRANCH}`)
}

// 위의 상수·함수가 모두 정의된 뒤에 시작한다
if (args.publish) publish(args.publish.split(',').filter(Boolean))
else await make()
