/**
 * 공고 중인 유기동물 사진을 실사로 만든다 (주 1회, 이 맥에서 사람이 돌린다).
 *
 *   npm run shelter:make                         후보(public/data/candidates.json)를 판정하고 만들어 미리보기를 연다
 *   npm run shelter:make -- --publish id1,id2    미리보기에서 고른 아이만 로컬 shelter-data 브랜치로 확정 (push는 사람이 따로)
 *   npm run shelter:make -- --hq id1,id2 [--yes-paid]   고퀄: AI 표정(원본 사진 편집만, 앞발 없음)을 붙인다.
 *                                                AI 사진이 없는 아이가 있으면 유료라 --yes-paid가 필요하다. 이미 만든 AI 사진은 다시 쓴다 (무료)
 *
 * 고퀄 작업 흐름 (보호소 아이를 초코·삼식처럼)
 *   1) npm run shelter:make                → 미리보기에서 D-day가 먼 순으로 통과한 아이를 본다
 *   2) [사람] npm run dev 후 /rig.html?id=shelter-<공고번호> 에서 눈·코·턱·귀 기준점을 손으로 맞추고 저장 → '다시 만들기'
 *      (손으로 맞춘 아이는 표시가 남아, 다시 shelter:make를 돌려도 기준점을 덮어쓰지 않는다)
 *   3) npm run shelter:make -- --hq <공고번호,...> --yes-paid   → AI 표정 (개 약 $0.28, 고양이 약 $0.55)
 *      기준점을 나중에 고쳐도 같은 명령을 다시 돌리면 AI 사진은 다시 쓰고 부위만 새로 자른다 (무료)
 *   4) npm run shelter:make -- --publish <공고번호,...>
 *   앱은 표정이 있고 손으로 맞춘 아이를 FULL 움직임으로, 그 밖은 SAFE로 그린다 (rig.autoLandmarks)
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
import { deriveRig, dist, expressionBoxes, expressionLayers, type Landmarks, type Pt } from '../src/rigDerive.ts'

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
/** 한 번에 공개하는 최대 수 */
const MAX_PUBLISH = 20
/** 공공데이터 서버에서 사진을 받는 간격 (한 번에 하나씩) */
const DOWNLOAD_GAP_MS = 300
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
  /** 공고 종료일 YYYYMMDD (D-day가 먼 순으로 고른다) */
  end?: string
  /** 손으로 기준점을 맞췄는지, AI 표정을 붙였는지, AI로 정면을 다시 그렸는지 */
  hand?: boolean
  hq?: boolean
  aiFrontal?: boolean
  /** 무료 버전은 '자른 뒤 머리 잘림'으로만 탈락 (고퀄은 AI가 잘린 부분을 채워 그려 만들 수 있다) */
  layoutOnly?: boolean
  /** 원본 사진에서 머리·귀가 사진 밖으로 잘려 AI가 채워 그렸다 */
  aiFill?: boolean
  /** 정면도 0~1, 공고 사진 수, 판정을 통과한 사진 수 */
  frontal?: number
  total?: number
  passed?: number
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
  const previous = new Map<string, Verdict>(
    existsSync(join(STAGE, 'verdicts.json')) ? (readJson(join(STAGE, 'verdicts.json')).verdicts as Verdict[]).map((x) => [x.id, x]) : [],
  )
  for (const c of list) {
    const a = animals.get(c.id)
    if (!a || a.sp === 'etc') {
      verdicts.push({ id: c.id, sp: 'dog', ok: false, why: ['공고 목록에 없어요 (끝났을 수 있어요)'] })
      continue
    }
    log(`\n▶ ${a.sp === 'dog' ? '🐶' : '🐱'} ${c.id} (${c.reasons.join(', ')})`)
    const { options, why, total } = await judge(a)
    const v: Verdict = { id: a.id, sp: a.sp as 'dog' | 'cat', ok: false, why: [...why], total, passed: options.length, end: a.end }
    // 사람이 기준점을 손으로 맞춘 아이와 고퀄로 만든 아이는 다시 만들지 않고 그대로 쓴다 (덮어쓰면 손으로 맞춘 기준점·AI 결과가 사라진다)
    const prevV = previous.get(a.id)
    // (고퀄 작업 자리가 없어졌으면 다시 만든다)
    const prevHqOk = prevV?.hq && existsSync(join(hqDir(a.id), 'landmarks.json'))
    const prev = handTuned(a.id) || prevHqOk ? prevV : undefined
    if (prev?.ok) {
      const hqId = prev.hq ? `shelter-${a.id}-hq` : undefined
      Object.assign(v, prev, { why: ['이전 결과 그대로 (손으로 맞춤·고퀄)', ...prev.why.filter((w) => !w.startsWith('이전 결과'))], end: a.end, rig: rigFor(a, hqId) })
      log(`   ✓ 통과 (이전 결과 그대로)`)
      verdicts.push(v)
      continue
    }
    // 가장 정면인 사진부터 만들어 보고, 자른 뒤 구도까지 통과하는 첫 사진을 쓴다
    for (const o of options) {
      const tag = `사진 ${o.photo + 1}/${total} (정면도 ${(o.frontal * 100).toFixed(0)}%)`
      try {
        writeJson(join(ROOT, 'pets-src', `shelter-${a.id}`, 'landmarks.raw.json'), o.raw)
        const rig = build(a, o.photo)
        // 자른 뒤 구도: 머리가 화면 안에 들어오는지, 턱 아래로 다리·몸통이 너무 길게 보이지 않는지
        const bad = layoutProblems(rig as Rig)
        if (bad.length) {
          v.why.push(`${tag}: ${bad.join(', ')}`)
          // 무료 버전은 탈락이지만, 고퀄(AI 정면)은 잘린 부분을 채워 그릴 수 있어 후보로 남긴다
          if (!v.layoutOnly) Object.assign(v, { layoutOnly: true, photo: o.photo, frontal: o.frontal })
          continue
        }
        Object.assign(v, { ok: true, made: true, rig, photo: o.photo, frontal: o.frontal })
        v.why.unshift(`${tag} 사용 · 통과 ${options.length}장 중 가장 정면`)
        break
      } catch (e) {
        v.why.push(`${tag}: 실사 만들기 실패 ${(e as Error).message.split('\n')[0]}`)
      }
    }
    if (!v.ok) rmSync(join(STAGE, a.id), { recursive: true, force: true })
    log(`   ${v.ok ? '✓ 통과' : '✗ 탈락'}: ${v.why.join(' · ')}`)
    verdicts.push(v)
  }
  writeJson(join(STAGE, 'verdicts.json'), { updated: new Date().toISOString(), judge: JUDGE, verdicts })
  writePreview(verdicts, animals)
  const ok = verdicts.filter((v) => v.ok)
  log(`\n완료: ${ok.length}/${verdicts.length}마리 통과. 미리보기: ${join(STAGE, 'preview.html')}`)
  // D-day가 먼 순(같으면 정면도 순)으로 공개 최대 수만큼 (미리보기에서 바꿔 고를 수 있다)
  const top = [...ok].sort(byPriority).slice(0, MAX_PUBLISH)
  log(`고른 뒤 (D-day 먼 순 ${top.length}마리, 미리보기에서 바꿀 수 있어요): npm run shelter:make -- --publish ${top.map((v) => v.id).join(',') || '<공고번호,...>'}`)
}

/** 정면 후보 사진 한 장 */
interface Option {
  photo: number
  /** 정면도 0~1 (1이 정면: 코가 두 눈 가운데) */
  frontal: number
  /** 두 눈 사이 (원본 픽셀). 정면도가 같으면 얼굴이 큰 사진 */
  eyeGap: number
  raw: Record<string, unknown>
}

/** 공고 사진(최대 8장)을 모두 받아 판정하고, 통과한 사진을 정면인 순서로 돌려준다 */
async function judge(a: Animal): Promise<{ options: Option[]; why: string[]; total: number }> {
  const dir = join(ROOT, 'pets-src', `shelter-${a.id}`)
  mkdirSync(dir, { recursive: true })
  const why: string[] = []
  const options: Option[] = []
  for (let i = 0; i < a.photos.length; i++) {
    const file = join(dir, `src-${i}.jpg`)
    if (!existsSync(file)) {
      const res = await download(a.photos[i])
      if (!res?.ok) {
        why.push(`사진 ${i + 1}: 받지 못함`)
        continue
      }
      writeFileSync(file, Buffer.from(await res.arrayBuffer()))
    }
    const det = detectFree(file, join(dir, `src-${i}.detect.json`))
    const problems = det ? check(det, a.sp as 'dog' | 'cat') : ['Apple Vision 실패']
    if (problems.length) {
      why.push(`사진 ${i + 1}: ${problems.join(', ')}`)
      continue
    }
    // 기준점: 무료면 Apple Vision 관절에서, 유료면 비전 모델에서 (pet-add 'detect' 결과와 같은 모양으로 둔다)
    const raw = JUDGE === 'vision' ? await visionLandmarks(file, det!, a.sp as 'dog' | 'cat') : rawFromPose(det!, a.sp as 'dog' | 'cat')
    if (!raw) {
      why.push(`사진 ${i + 1}: 기준점을 찾지 못함`)
      continue
    }
    const e = eyesOf(det!)!
    options.push({ photo: i, frontal: 1 - Math.min(1, Math.abs(yawOf(det!))), eyeGap: dist(e.l, e.r), raw })
  }
  // 정면도 순 (거의 같으면 얼굴이 큰 사진)
  options.sort((x, y) => (Math.abs(x.frontal - y.frontal) > 0.02 ? y.frontal - x.frontal : y.eyeGap - x.eyeGap))
  return { options, why, total: a.photos.length }
}

/**
 * 공고 사진 받기: 공공데이터 서버에 부담을 주지 않게 한 번에 하나씩, 요청 사이에 쉬고, 실패하면 한 번만 다시 받는다.
 * 받은 사진은 pets-src에 남겨 다음 실행 때는 받지 않는다
 */
let lastDownload = 0
async function download(url: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = lastDownload + DOWNLOAD_GAP_MS * (attempt + 1) - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastDownload = Date.now()
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => null)
    if (res?.ok || res?.status === 404) return res
  }
  return null
}

/** Apple Vision 판정 프로그램은 한 번 컴파일해 두고 쓴다 (swift 스크립트를 사진마다 실행하면 사진당 1~2초씩 컴파일한다) */
function detectorBin() {
  const src = join(ROOT, 'scripts', 'animal-detect.swift')
  const bin = join(ROOT, 'pets-src', '.bin', 'animal-detect')
  const { statSync } = process.getBuiltinModule('node:fs')
  if (!existsSync(bin) || statSync(bin).mtimeMs < statSync(src).mtimeMs) {
    mkdirSync(join(ROOT, 'pets-src', '.bin'), { recursive: true })
    const r = spawnSync('swiftc', ['-O', src, '-o', bin], { encoding: 'utf8' })
    if (r.status !== 0) fail(`animal-detect.swift 컴파일 실패: ${r.stderr}`)
  }
  return bin
}

function detectFree(photo: string, cache: string): Detect | null {
  if (existsSync(cache)) return readJson(cache)
  const r = spawnSync(detectorBin(), [photo], { encoding: 'utf8', timeout: 120_000 })
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
  // Apple Vision 귀 관절은 위·가운데·아래라, 선 귀는 아래가 붙은 곳이지만 늘어진 귀는 위가 붙은 곳이다.
  // 그래서 얼굴 가운데에 더 가까운 끝을 붙은 곳(base), 먼 끝을 귀 끝(tip)으로 잡아 [끝, 가운데, 붙은 곳] 순서로 둔다
  // (거꾸로 잡으면 늘어진 귀가 가운데를 축으로 돌아 꿀렁거린다)
  const ear = (side: 'left' | 'right') => {
    const pts = (['top', 'middle', 'bottom'] as const).map((k) => J(d, `${side}_ear_${k}`)).map((p) => p && { x: p.x * d.width, y: p.y * d.height })
    if (!pts.every(Boolean)) return null
    const [top, middle, bottom] = pts as Pt[]
    return dist(top, mid) < dist(bottom, mid) ? [bottom, middle, top] : [top, middle, bottom]
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
    // 눈(홍채) 반지름: 고양이 눈은 개보다 훨씬 크다 (두 눈 사이의 약 0.17배, 개 0.11배)
    eye_radius: nx(D * (cat ? 0.17 : 0.11)),
    nose: N(n),
    nose_width: nx(D * (cat ? 0.26 : 0.5)),
    nose_height: ny(D * (cat ? 0.26 : 0.42)),
    mouth: N(at(cat ? 1.45 : 1.4)),
    // 턱 끝: 눈→코 거리의 2.1배(고양이)·1.8배(개). 고양이는 코가 짧아 이 비율이 크다
    // (얼굴이 납작한 고양이는 눈→코가 아주 짧아, 코에서 두 눈 사이의 0.5배 아래보다는 내려가게)
    chin_bottom: N(cat ? { x: at(2.1).x, y: Math.max(at(2.1).y, n.y + D * 0.5) } : at(1.8)),
    // 정수리: 고양이는 코가 짧아 눈→코 비율로 잡으면 이마 중간에 걸린다 (머리 부위가 이마를 못 덮어, 고개를 기울이면 이마가 접힌다).
    // 그래서 두 귀가 붙은 곳 높이를 쓴다
    head_top: N(cat ? { x: mid.x, y: Math.min(at(-1.1).y, (L[2].y + R[2].y) / 2 - D * 0.1) } : at(-1.0)),
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
  rmSync(join(SRC, 'hand-tuned'), { force: true })
  writeFileSync(join(SRC, 'landmarks.auto.json'), readFileSync(join(SRC, 'landmarks.json')))
  return rigFor(a)
}

/** 사람이 rig.html에서 기준점을 손으로 맞췄는지 (vite.config.ts 편집 API가 저장할 때 표시를 남긴다) */
function handTuned(id: string) {
  return existsSync(join(ROOT, 'pets-src', `shelter-${id}`, 'hand-tuned'))
}

/**
 * pet-add가 만든 사진·기준점(public/pets/shelter-<id>, pets-src/shelter-<id>)으로 무대(stage)에 공개용 파일을 두고 리그를 만든다.
 * public/pets/shelter-*는 기준점 편집 화면이 읽는 자리라 지우지 않는다 (gitignore)
 */
function rigFor(a: Animal, id = `shelter-${a.id}`) {
  const SRC = join(ROOT, 'pets-src', id)
  const PUB = join(ROOT, 'public', 'pets', id)
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
  // (고퀄은 AI로 다시 그린 정면이라, 대표 사진은 공고 원본 사진을 쓴다)
  const orig = join(ROOT, 'pets-src', `shelter-${a.id}`, 'photo.jpg')
  spawnSync('python3', ['-c', 'import sys; from PIL import Image, ImageOps; im=ImageOps.exif_transpose(Image.open(sys.argv[1])).convert("RGB"); im.thumbnail((1024,1024)); im.save(sys.argv[2], quality=85)', existsSync(orig) ? orig : join(SRC, 'photo.jpg'), join(out, 'photo.jpg')])
  // 고퀄: AI 표정 레이어가 있으면 같이 (pet-add assets 단계 결과)
  const made = (f: string) => existsSync(join(PUB, f))
  let expressions: Record<string, unknown> | undefined
  if (made('eyes.webp') && made('morph.json')) {
    const morph = readJson(join(PUB, 'morph.json'))
    const layers = expressionLayers(lm, expressionBoxes(lm, face), { pant: `${base}/pant.webp`, eyes: `${base}/eyes.webp`, ears: `${base}/ears.webp` }, morph.fills.ears ?? [0.45, 0.28, 0.18])
    for (const f of ['pant.webp', 'eyes.webp', 'ears.webp', 'morph.png']) if (made(f)) copyFileSync(join(PUB, f), join(out, f))
    expressions = {
      ...(made('pant.webp') && { pant: layers.pant }),
      eyesClosed: layers.eyesClosed,
      ...(made('ears.webp') && { earsBack: layers.earsBack }),
      morph: { src: `${base}/morph.png`, range: morph.range, sdfRange: morph.sdfRange, rects: morph.rects },
    }
  }
  return {
    ...deriveRig(lm, { src: `${base}/face.webp`, flow: `${base}/flow.png`, ...(hasCatch && { catchlight: `${base}/catch.png` }), width: face.width, height: face.height, bottom: face.bottom }),
    ...((frame.cutLeft || frame.cutRight) && {
      fadeSides: { ...(frame.cutLeft && { left: -face.offsetX }), ...(frame.cutRight && { right: 1086 - face.offsetX }) },
    }),
    ...(expressions && { expressions }),
    // 고퀄 고양이에 입 표정(츄르 핥는 혀)이 있으면 핥아 먹는다
    ...(a.sp === 'cat' && id.endsWith('-hq') && expressions?.pant && { lick: true }),
    // 손으로 맞추지 않은 기준점이면 앱이 표정이 있어도 SAFE로 그린다
    autoLandmarks: !existsSync(join(SRC, 'hand-tuned')),
  }
}

/** D-day가 먼 순, 같으면 정면도 순 */
function byPriority(a: Verdict, b: Verdict) {
  return (b.end ?? '').localeCompare(a.end ?? '') || (b.frontal ?? 0) - (a.frontal ?? 0)
}

function dday(end?: string) {
  if (!end || !/^\d{8}$/.test(end)) return 'D-?'
  const e = Date.UTC(+end.slice(0, 4), +end.slice(4, 6) - 1, +end.slice(6, 8))
  const n = new Date()
  return `D-${Math.round((e - Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())) / 86400000)}`
}

// ───────────────────────── 고퀄 (AI 정면 + 눈 감기) ─────────────────────────
//
// 초코·삼식 수준으로: 가장 정면인 공고 사진을 참고로 같은 아이의 정면 클로즈업을 AI로 새로 그리고(pet-add --reference),
// 배경 지우기·기준점(Apple Vision, 무료)·자르기 뒤 눈 감기 표정 2장만 AI로 만든다 (입·귀는 원본 그대로, pet-add --parts eyes).
// 작업 자리는 pets-src/shelter-<공고번호>-hq (무료 버전과 따로). 이미 만든 AI 사진은 다시 쓴다.
// 사람이 할 일: 미리보기에서 원본과 닮았는지 확인, rig.html?id=shelter-<공고번호>-hq 에서 기준점 다듬기

function hqDir(id: string) {
  return join(ROOT, 'pets-src', `shelter-${id}-hq`)
}

async function hq(ids: string[]) {
  const vpath = join(STAGE, 'verdicts.json')
  const all = existsSync(vpath) ? (readJson(vpath).verdicts as Verdict[]) : fail('먼저 npm run shelter:make')
  const animals = new Map((readJson(join(DATA, 'animals.json')).animals as Animal[]).map((a) => [a.id, a]))
  const pick = ids.map((id) => all.find((v) => v.id === id && (v.ok || v.layoutOnly)) ?? fail(`통과하지 못했거나 없는 아이예요: ${id}`))
  // 유료: 정면 새로 그리기 약 $0.2, 눈 감기 2장 약 $0.28
  const cost = pick.reduce((s, v) => s + (existsSync(join(hqDir(v.id), 'cutout.png')) ? 0 : 0.2) + (existsSync(join(hqDir(v.id), 'expr-final-square.png')) ? 0 : 0.28), 0)
  // --via chatgpt: ChatGPT 구독(gpt-image 스킬)으로 그린다 (API 비용 없음, 구독 사용량을 쓴다)
  const via = args.via === 'chatgpt'
  if (via) process.env.PET_IMAGE_VIA = 'chatgpt'
  const partsArg = args.parts ?? 'eyes'
  if (cost > 0 && !via && !args['yes-paid']) fail(`AI 사진을 새로 만들어야 해요: 약 $${cost.toFixed(2)}. 진행하려면 --yes-paid를 붙이세요`)
  const add = (...a: string[]) => {
    const r = spawnSync('node', [join(ROOT, 'scripts', 'pet-add.ts'), ...a], { cwd: ROOT, encoding: 'utf8' })
    process.stdout.write((r.stdout ?? '').split('\n').filter((l) => /✓|✗|정렬|이미 있는|정면/.test(l)).map((l) => l + '\n').join(''))
    if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-2).join(' '))
  }
  for (const v of pick) {
    const id = `shelter-${v.id}-hq`
    const dir = hqDir(v.id)
    log(`\n▶ ✨ ${v.sp === 'dog' ? '🐶' : '🐱'} ${v.id}`)
    try {
      // 1) 정면 새로 그리기 (참고: 무료 판정에서 고른 가장 정면인 공고 사진)
      if (!existsSync(join(dir, 'cutout.png'))) add(join(ROOT, 'pets-src', `shelter-${v.id}`, `src-${v.photo}.jpg`), '--id', id, '--species', v.sp, '--reference', 'true', '--until', 'cutout')
      // 2) 기준점: Apple Vision (무료). 손으로 맞췄으면 그대로
      if (!handTunedDir(dir)) {
        const det = detectPadded(join(dir, 'cutout.png'), join(dir, 'cutout.detect.json'))
        const problems = det ? check({ ...det, humanFaces: 0, hands: [] }, v.sp).filter((p) => !p.startsWith('얼굴이 작음')) : ['Apple Vision 실패']
        if (problems.length) throw new Error(`AI 정면 사진 판정: ${problems.join(', ')}`)
        const raw = rawFromPose(det!, v.sp)
        // 정수리: 관절로 짐작한 높이보다 실제 머리(불투명한 털)가 더 위면 그 높이로 (털이 풍성하거나 귀가 접힌 고양이는 짐작이 낮아 머리 위가 평평하게 잘렸다)
        const top = spawnSync('python3', ['-c', `
import sys, numpy as np
from PIL import Image
a = np.array(Image.open(sys.argv[1]).convert('RGBA'))[:, :, 3] > 128
h, w = a.shape
x0, x1 = int(float(sys.argv[2]) * w), int(float(sys.argv[3]) * w)
cols = a[:, max(0, x0):min(w, x1)]
rows = np.where(cols.mean(axis=1) > 0.5)[0]
print(rows.min() / h if len(rows) else 1)`, join(dir, 'cutout.png'), String(raw.left_eye.x / 1000), String(raw.right_eye.x / 1000)], { encoding: 'utf8' })
        const topN = Math.round(Number(top.stdout.trim()) * 1000)
        if (Number.isFinite(topN) && topN < raw.head_top.y) raw.head_top = { x: raw.head_top.x, y: topN }
        writeJson(join(dir, 'landmarks.raw.json'), raw)
        add('--id', id, '--from', 'frontal', '--until', 'prepare')
        writeFileSync(join(dir, 'landmarks.auto.json'), readFileSync(join(dir, 'landmarks.json')))
      } else add('--id', id, '--from', 'prepare', '--until', 'prepare')
      // 3) 눈 감기 2장 (입·귀는 원본 그대로) + 표정 사이 움직임
      add('--id', id, '--from', 'expressions', '--until', 'assets', '--parts', partsArg === 'mouth' ? (v.sp === 'cat' ? 'eyes+lick' : 'eyes+pant') : partsArg)
      const a = animals.get(v.id) ?? ({ id: v.id, sp: v.sp, photos: [], end: v.end ?? '' } as Animal)
      v.rig = rigFor(a, id)
      v.hq = !!(v.rig as { expressions?: unknown }).expressions
      v.hand = handTunedDir(dir)
      v.aiFrontal = true
      v.aiFill = cutAtEdge(join(ROOT, 'pets-src', `shelter-${v.id}`, `src-${v.photo}.jpg`), join(ROOT, 'pets-src', `shelter-${v.id}`, 'cutout.png'))
      // 고퀄이 되면 공개 후보 (무료 버전이 구도로 떨어졌어도)
      v.ok = true
      log(`   ${v.hq ? '✓ 정면 + 눈 감기' : '✗ 눈 감기 표정 파일이 없어요'}${v.hand ? '' : ' (기준점 자동 → 앱은 SAFE. rig.html에서 맞추면 FULL)'}`)
    } catch (e) {
      log(`   ✗ 실패: ${(e as Error).message}`)
    }
  }
  writeJson(vpath, { ...readJson(vpath), verdicts: all })
  writePreview(all, animals)
  log(`\n완료. 미리보기: ${join(STAGE, 'preview.html')}`)
}

/**
 * AI가 그린 정면 사진은 배경이 투명하고 얼굴이 꽉 차 있어, Apple Vision 관절 인식이 눈·코를 못 찾을 때가 있다.
 * 회색 배경에 여백을 두고 얹어 판정한 뒤 좌표를 원래 사진으로 되돌린다
 */
function detectPadded(png: string, cache: string): Detect | null {
  if (existsSync(cache)) {
    const c = readJson(cache) as Detect
    if (c.pose?.animal_joint_left_eye) return c
  }
  const padded = png.replace(/\.png$/, '.padded.jpg')
  // 배경 밝기·여백·크기를 바꿔 가며 눈·코가 잡힐 때까지 (사진마다 잡히는 조합이 다르다)
  for (const [bg, pad, sc] of [[150, 0.35, 1], [90, 0.6, 0.5], [255, 0.35, 1], [200, 1, 0.6], [255, 1.5, 0.4], [60, 0.8, 0.7]]) {
    const info = spawnSync('python3', ['-c', `
import sys, json
from PIL import Image
bgc, pad, sc = int(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5])
im = Image.open(sys.argv[1]).convert('RGBA'); w, h = im.size; p = int(max(w, h) * pad)
bg = Image.new('RGBA', (w + 2 * p, h + 2 * p), (bgc, bgc, bgc, 255)); bg.alpha_composite(im, (p, p))
bg.convert('RGB').resize((int((w + 2 * p) * sc), int((h + 2 * p) * sc))).save(sys.argv[2], quality=92)
print(json.dumps({'w': w, 'h': h, 'p': p}))`, png, padded, String(bg), String(pad), String(sc)], { encoding: 'utf8' })
    if (info.status !== 0) return null
    const { w, h, p } = JSON.parse(info.stdout)
    rmSync(cache, { force: true })
    const d = detectFree(padded, cache)
    if (!d?.pose?.animal_joint_left_eye || !d.pose.animal_joint_right_eye || !d.pose.animal_joint_nose) continue
    const W = w + 2 * p
    const H = h + 2 * p
    const back = (q: { x: number; y: number }) => ({ x: (q.x * W - p) / w, y: (q.y * H - p) / h })
    const out: Detect = {
      ...d,
      width: w,
      height: h,
      animals: d.animals.map((a) => ({ ...a, box: [(a.box[0] * W - p) / w, (a.box[1] * H - p) / h, (a.box[2] * W) / w, (a.box[3] * H) / h] })),
      hands: [],
      humanFaces: 0,
      pose: Object.fromEntries(Object.entries(d.pose).map(([k, v]) => [k, { ...v, ...back(v) }])),
    }
    writeJson(cache, out)
    return out
  }
  return null
}

/** 원본 사진에서 동물이 위·왼쪽·오른쪽 가장자리에 닿아 있는지 (머리·귀가 사진 밖으로 잘렸을 수 있다) */
function cutAtEdge(_photo: string, cutout: string) {
  if (!existsSync(cutout)) return false
  const r = spawnSync('python3', ['-c', `
import sys
import numpy as np
from PIL import Image
a = np.array(Image.open(sys.argv[1]).convert('RGBA'))[:, :, 3] > 128
h, w = a.shape
band = max(2, int(min(h, w) * 0.01))
print(int(a[:band].mean() > 0.03 or a[:, :band].mean() > 0.05 or a[:, -band:].mean() > 0.05))`, cutout], { encoding: 'utf8' })
  return r.stdout.trim() === '1'
}

function handTunedDir(dir: string) {
  return existsSync(join(dir, 'hand-tuned'))
}

// ───────────────────────── 미리보기 ─────────────────────────

function writePreview(verdicts: Verdict[], animals: Map<string, Animal>) {
  // 통과한 아이를 앞에, D-day가 먼 순(같으면 정면도 순)으로. 처음에는 앞에서 ${MAX_PUBLISH}마리만 체크해 둔다
  const sorted = [...verdicts].sort((a, b) => Number(b.ok) - Number(a.ok) || byPriority(a, b))
  const preChecked = new Set(sorted.filter((v) => v.ok).slice(0, MAX_PUBLISH).map((v) => v.id))
  const card = (v: Verdict) => {
    const a = animals.get(v.id)
    const src = v.photo !== undefined ? `../shelter-${v.id}/src-${v.photo}.jpg` : a?.photos[0] ?? ''
    return `<label class="card ${v.ok ? 'ok' : 'no'}">
  <div class="imgs"><img src="${src}" loading="lazy">${v.made ? `<img class="face" src="${v.id}/face.webp" loading="lazy">` : ''}</div>
  <div class="meta">${v.ok ? `<input type="checkbox" value="${v.id}"${preChecked.has(v.id) ? ' checked' : ''}> ` : ''}<b>${v.sp === 'dog' ? '🐶' : '🐱'} ${v.id}</b>
 ${!v.ok && v.layoutOnly ? `<div class="pick">${dday(v.end)} · 무료 버전은 머리 잘림 → 고퀄 후보 (AI가 채워 그림)</div>` : ''}
  ${v.ok ? `<div class="pick">${dday(v.end)} ·${v.aiFill ? ' ✂️ 잘린 부분 AI로 채움 ·' : ''} ${v.hq && v.hand ? '✨ 고퀄 · ✋ 손으로 맞춤' : v.hand ? '✋ 손으로 맞춤' : v.hq ? `✨ 고퀄 (기준점 자동) · <a href="http://localhost:5173/rig.html?id=shelter-${v.id}-hq" target="_blank">기준점 맞추기</a>` : `<a href="http://localhost:5173/rig.html?id=shelter-${v.id}${v.aiFrontal ? '-hq' : ''}" target="_blank">기준점 맞추기</a>`}</div>` : ''}
  ${v.ok ? `<div class="pick">정면도 ${Math.round((v.frontal ?? 0) * 100)}% · ${v.total}장 중 ${(v.photo ?? 0) + 1}번째 (통과 ${v.passed}장)</div>` : ''}
  <small>${v.why.join('<br>')}</small></div>
</label>`
  }
  const html = `<!doctype html><meta charset="utf-8"><title>공고 아이 실사 미리보기</title>
<style>
body{font:14px system-ui;margin:16px;background:#fdf1e4;color:#3b2a1e}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.card{display:block;background:#fff;border-radius:12px;padding:8px;border:2px solid transparent}
.card.ok{border-color:#7ec27e}.pick{margin-top:4px;font-weight:600;color:#3f7a3f}.card.no{opacity:.55}
.imgs{display:flex;gap:6px}.imgs img{width:50%;aspect-ratio:3/4;object-fit:contain;border-radius:8px;background:#eee}
.imgs img.face{background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/16px 16px}
small{display:block;color:#7a6556;margin-top:4px}pre{background:#fff;padding:10px;border-radius:8px;white-space:pre-wrap}
</style>
<h2>공고 아이 실사 미리보기 (판정: ${JUDGE === 'apple' ? 'Apple Vision, 무료' : '비전 모델'})</h2>
<p>철창·목줄·손이 얼굴을 가리는지, 배경이 남았는지 보고 공개할 아이만 체크하세요. 아래 명령을 터미널에 붙여 넣으면 로컬 ${BRANCH} 브랜치로 확정돼요 (push는 따로).</p>
<pre id="cmd"></pre>
<div class="grid">${sorted.map(card).join('\n')}</div>
<script>
const upd=()=>{const ids=[...document.querySelectorAll('input:checked')].map(i=>i.value);document.getElementById('cmd').textContent=ids.length>${MAX_PUBLISH}?'${MAX_PUBLISH}마리까지 고를 수 있어요 (지금 '+ids.length+'마리)':'npm run shelter:make -- --publish '+ids.join(',')}
document.addEventListener('change',upd);upd()
</script>`
  writeFileSync(join(STAGE, 'preview.html'), html)
}

// ───────────────────────── 확정 (로컬 브랜치) ─────────────────────────

function publish(ids: string[]) {
  if (ids.length > MAX_PUBLISH) fail(`한 번에 ${MAX_PUBLISH}마리까지 공개해요 (${ids.length}마리를 골랐어요)`)
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
    pets: pick.map((p) => ({ id: p.id, sp: p.sp, madeAt, rig: p.rig, photo: `shelter/${p.id}/photo.jpg`, ...(p.aiFrontal && { aiFrontal: true }), ...(p.aiFill && { aiFill: true }) })),
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
else if (args.hq) await hq(args.hq.split(',').filter(Boolean))
else await make()
