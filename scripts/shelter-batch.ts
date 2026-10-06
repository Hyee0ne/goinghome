/**
 * 주 1회 고퀄 정면 배치: 공고 아이를 골라 GPT(high)로 정면을 그리고, Windows가 표정을 그릴 수 있게 images-incoming 브랜치에 올린다.
 *
 *   npm run shelter:batch -- --dry-run                      고를 아이와 예상 비용만 보여 준다 (생성·push 없음)
 *   npm run shelter:batch                                   만들고 images-incoming에 push
 *   옵션: --dogs 10 --cats 10 --min-days 3 --max-days 7 --no-push --no-upload --only id1,id2 (--only면 이미 고퀄인 아이도)
 *
 * 고르는 기준 (2026-10-06 사용자 확정: 급한 아이를 살리는 데 집중): 공고 남은 3~7일, 남은 기간 짧은 순.
 * 생성에 방해 요소가 있는 아이는 뺀다 = 무료 판정에서 떨어진 아이 (사람 손·얼굴, 여러 마리, 눈·코 흐림, 고개 많이 돌아감, 얼굴 아주 작음).
 * 머리·귀가 사진 밖으로 잘린 건 생성이 채우니 방해 요소가 아니다 (layoutOnly도 넣는다). 같은 날이면 정면도·얼굴 크기 순. 이미 고퀄인 아이는 뺀다.
 *
 * 그리기: ChatGPT 구독(gpt-image 스킬)을 먼저 쓰고, 실패(사용량 한도 등)한 아이만 OpenAI API로 다시 그린다 (사용자 허락).
 * 비용은 pets-src/shelter-batch-cost.jsonl에 한 줄씩 남긴다 (API만 비용이 든다. 구독은 0).
 * 결과: incoming/<id>/front.png (1024×1536 RGB PNG, 메타데이터 없음, 털색과 대비되는 단색 배경 — Windows 인페인팅용),
 *       front.alpha.png (GPT가 그린 투명 정면 그대로 — 맥이 최종 누끼로 쓴다), README.txt,
 *       incoming/BATCH-<날짜>.md. images-incoming 브랜치만 push한다 (main 금지: 자동 배포).
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const args: Record<string, string> = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++)
  if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? 'true' : argv[++i]
const DRY = args['dry-run'] === 'true'
const N_DOG = Number(args.dogs ?? 10)
const N_CAT = Number(args.cats ?? 10)
// 남은 기간: candidates.json의 window (지금 강아지·고양이 모두 3~7일, 2026-10-06). 없으면 3~7일. --min-days/--max-days로 덮어쓴다
const win = (() => {
  try {
    return (JSON.parse(readFileSync(join(resolve(import.meta.dirname, '..'), 'public', 'data', 'candidates.json'), 'utf8')).window ?? {}) as Record<string, [number, number]>
  } catch {
    return {}
  }
})()
const range = (sp: 'dog' | 'cat'): [number, number] => [
  Number(args['min-days'] ?? win[sp]?.[0] ?? 3),
  Number(args['max-days'] ?? win[sp]?.[1] ?? 7),
]
/** API 한 장 비용 추정 (gpt-image-1.5 high 1024×1536 편집, 지난 실측 토큰 기준) */
const API_COST = 0.2
const BRANCH = 'images-incoming'
/** 동시에 그리는 장 수 (구독은 Codex 작업을 여러 개, API는 요청을 여러 개) */
const CONC_SUB = Number(args['sub-concurrency'] ?? 4)
const CONC_API = Number(args['api-concurrency'] ?? 4)
const GPT_IMAGE = process.env.GPT_IMAGE_SCRIPT ?? join(homedir(), '.claude/skills/gpt-image/scripts/gpt_image.mjs')

const fail = (s: string): never => {
  console.error(`✗ ${s}`)
  process.exit(1)
}
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const log = (s: string) => console.log(s)

interface Animal {
  id: string
  sp: 'dog' | 'cat' | 'etc'
  end: string
  noticeNo: string
  kind: string
  care: { name: string }
}
interface Verdict {
  id: string
  sp: 'dog' | 'cat'
  ok: boolean
  layoutOnly?: boolean
  photo?: number
  frontal?: number
}

/** 배경이 투명한 그림인지 (투명한 픽셀이 2% 넘게) */
function isTransparent(png: string) {
  const r = spawnSync('python3', ['-c', 'import sys, numpy as np\nfrom PIL import Image\na = np.array(Image.open(sys.argv[1]).convert("RGBA"))[:, :, 3]\nprint(int((a < 10).mean() > 0.02))', png], { encoding: 'utf8' })
  return r.stdout.trim() === '1'
}

/** 공고 종료일까지 남은 날 (오늘 0) */
function daysLeft(end: string) {
  if (!/^\d{8}$/.test(end)) return -1
  const e = Date.UTC(+end.slice(0, 4), +end.slice(4, 6) - 1, +end.slice(6, 8))
  const n = new Date()
  return Math.round((e - Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())) / 86400000)
}

// ───────────────────────── 고르기 ─────────────────────────

const vpath = join(ROOT, 'pets-src', 'shelter-stage', 'verdicts.json')
if (!existsSync(vpath)) fail('먼저 npm run shelter:make (무료 판정)')
const verdicts = readJson(vpath).verdicts as Verdict[]
const animals = new Map((readJson(join(ROOT, 'public', 'data', 'animals.json')).animals as Animal[]).map((a) => [a.id, a]))
const hasHq = (id: string) => existsSync(join(ROOT, 'pets-src', `shelter-${id}-hq`, 'cutout.png'))
const only = args.only ? String(args.only).split(',') : null

const pool = verdicts
  .filter((v) => (v.ok || v.layoutOnly) && v.photo !== undefined && animals.has(v.id) && (only ? true : !hasHq(v.id)))
  .filter((v) => !only || only.includes(v.id))
  .map((v) => ({ v, a: animals.get(v.id)!, d: daysLeft(animals.get(v.id)!.end) }))
  .filter((x) => only || (x.d >= range(x.v.sp)[0] && x.d <= range(x.v.sp)[1]))
  .sort((x, y) => x.d - y.d || (y.v.frontal ?? 0) - (x.v.frontal ?? 0))
// (무료 판정 통과·머리 잘림 후보만 들어오므로 방해 요소가 있는 아이는 이미 빠져 있다)
const pick = only ? pool : [...pool.filter((x) => x.v.sp === 'dog').slice(0, N_DOG), ...pool.filter((x) => x.v.sp === 'cat').slice(0, N_CAT)]

log(`고른 아이: 강아지 ${pick.filter((x) => x.v.sp === 'dog').length}, 고양이 ${pick.filter((x) => x.v.sp === 'cat').length} (남은 기간 강아지 ${range('dog').join('~')}일·고양이 ${range('cat').join('~')}일, 짧은 순. 후보 ${pool.length}마리, 이미 고퀄인 아이 제외)`)
for (const x of pick) log(`  ${x.v.sp === 'dog' ? '🐶' : '🐱'} ${x.v.id}  D-${x.d}  ${x.a.noticeNo}  ${x.a.kind}  정면도 ${Math.round((x.v.frontal ?? 0) * 100)}%${x.v.layoutOnly ? '  (머리 잘림 → AI가 채움)' : ''}`)
log(`예상 비용: ChatGPT 구독으로 다 되면 $0 · 한도에 걸려 전부 API로 가면 약 $${(pick.length * API_COST).toFixed(2)} (한 장 약 $${API_COST}, 추정)`)
// 시간: 한 장 약 50초 (구독·API 실측 45~55초). 구독 CONC_SUB장, API CONC_API장을 동시에
const PER = 50
const rounds = (n: number, c: number) => Math.ceil(n / c)
log(`예상 시간: 한 장 약 ${PER}초 · 구독만으로 ${pick.length}장(동시 ${CONC_SUB}장) 약 ${Math.ceil((rounds(pick.length, CONC_SUB) * PER) / 60)}분 · ` +
  `구독 한도로 절반이 API로 넘어가면 약 ${Math.ceil(((rounds(Math.ceil(pick.length / 2), CONC_SUB) + rounds(Math.floor(pick.length / 2), CONC_API)) * PER) / 60)}분 (구독 한도는 대략 10장 안팎에서 걸렸다)`)
if (DRY) {
  log('\n(--dry-run: 만들지 않았어요)')
  process.exit(0)
}
if (!pick.length) fail('고를 아이가 없어요')

// ───────────────────────── 그리기 ─────────────────────────

const date = new Date().toISOString().slice(0, 10)
const work = join(ROOT, 'pets-src', 'shelter-batch', date)
mkdirSync(work, { recursive: true })
/** pet-add.ts --reference와 같은 정면 프롬프트. 배경만 단색 밝은 회색 (Windows 인페인팅과 맥 누끼가 쉽게) */
const prompt = (sp: string) =>
  `Close-up portrait photo of this exact same ${sp} (same fur color and length, same markings and where they are, same face shape, ` +
  'same eye color, same ear shape and ear carriage: upright ears stay upright, folded or floppy ears stay folded or floppy). ' +
  'If the head, ears or chin are cut off by the edge of the photo, complete the missing parts naturally so they match the visible parts ' +
  '(same fur, color and ear shape); the whole head and both full ears must be visible. ' +
  'Face-focused framing: the head fills most of the frame, including both ears fully, with just the top of the chest visible at the bottom edge. ' +
  'Facing the camera straight on, head centered and level, both eyes open and looking directly into the lens, mouth closed and relaxed. ' +
  'Soft, even, diffuse studio lighting with no harsh shadows, very sharp focus on individual fur strands and whiskers, natural colors, photorealistic. ' +
  'Isolated on a fully transparent background. No collar, no leash, no hands, no text. Vertical 2:3 composition with a small margin above the ears and at the sides.'
const srcOf = (x: (typeof pick)[number]) => join(ROOT, 'pets-src', `shelter-${x.v.id}`, `src-${x.v.photo}.jpg`)
const rawOf = (id: string) => join(work, `${id}.raw.png`)
const costLog = join(ROOT, 'pets-src', 'shelter-batch-cost.jsonl')
const record = (o: Record<string, unknown>) => appendFileSync(costLog, JSON.stringify({ at: new Date().toISOString(), batch: date, ...o }) + '\n')

// 1) ChatGPT 구독
const todo = pick.filter((x) => !existsSync(rawOf(x.v.id)))
if (todo.length && existsSync(GPT_IMAGE)) {
  const manifest = join(work, 'chatgpt-jobs.json')
  writeFileSync(manifest, JSON.stringify({ version: 1, jobs: todo.map((x) => ({ id: x.v.id, mode: 'edit', edit_target: srcOf(x), prompt: prompt(x.v.sp), size: '1024x1536', quality: 'high', background: 'transparent', out: rawOf(x.v.id) })) }))
  log(`\n▶ ChatGPT 구독으로 ${todo.length}장`)
  spawnSync('node', [GPT_IMAGE, 'batch', '--manifest', manifest, '--overwrite', '--concurrency', String(CONC_SUB)], { cwd: ROOT, stdio: 'inherit' })
  // 투명 배경으로 오지 않았으면(구독 경로가 가끔 검은 배경·체크무늬를 그린다) 버리고 다시 그린다 (API)
  for (const x of todo) {
    if (!existsSync(rawOf(x.v.id))) continue
    if (!isTransparent(rawOf(x.v.id))) {
      log(`   ⚠ ${x.v.id}: 투명 배경이 아니라 버려요`)
      rmSync(rawOf(x.v.id))
      continue
    }
    record({ id: x.v.id, via: 'chatgpt', usd: 0 })
  }
}

// 2) 남은 아이는 API (사용자 허락: 구독 한도에 걸리면 API)
const left = pick.filter((x) => !existsSync(rawOf(x.v.id)))
if (left.length && args['no-api'] === 'true') log(`\n--no-api: 남은 ${left.length}장은 API로 넘기지 않았어요`)
else if (left.length) {
  if (existsSync(join(ROOT, '.env.local'))) process.loadEnvFile(join(ROOT, '.env.local'))
  const key = process.env.OPENAI_API_KEY?.trim()
  if (!key) fail(`${left.length}장이 남았는데 OPENAI_API_KEY가 없어요`)
  log(`\n▶ API로 ${left.length}장 (약 $${(left.length * API_COST).toFixed(2)})`)
  const one = async (x: (typeof left)[number]) => {
    const form = new FormData()
    form.append('model', process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1.5')
    form.append('prompt', prompt(x.v.sp))
    form.append('image', new Blob([readFileSync(srcOf(x))], { type: 'image/jpeg' }), 'image.jpg')
    form.append('size', '1024x1536')
    form.append('quality', 'high')
    form.append('output_format', 'png')
    form.append('input_fidelity', 'high')
    form.append('background', 'transparent')
    const res = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(300_000) }).catch((e) => e as Error)
    const j = res instanceof Response ? await res.json().catch(() => ({})) : {}
    const b64 = j?.data?.[0]?.b64_json
    if (!b64) return log(`   ✗ ${x.v.id}: ${res instanceof Response ? `${res.status} ${j?.error?.message ?? ''}` : (res as Error).message}`)
    writeFileSync(rawOf(x.v.id), Buffer.from(b64, 'base64'))
    record({ id: x.v.id, via: 'api', usd: API_COST, usage: j.usage })
    log(`   ✓ ${x.v.id}`)
  }
  // 동시에 CONC_API장씩
  const queue = [...left]
  await Promise.all(Array.from({ length: Math.min(CONC_API, queue.length) }, async () => {
    for (let x = queue.shift(); x; x = queue.shift()) await one(x)
  }))
}

// 3) 규격 맞추기: 1024×1536 RGB PNG, 메타데이터 없음 (투명이나 다른 크기로 와도 맞춘다)
// front.alpha.png: GPT가 그린 투명 정면 그대로 (최종 누끼로 쓴다). front.png: 털색과 대비되는 단색 배경에 얹은 RGB (Windows 인페인팅용)
//   밝은 털(동물 부분 밝기 중앙값 > 0.5)은 진한 회청색, 어두운 털은 밝은 크림색 배경
const made = pick.filter((x) => existsSync(rawOf(x.v.id)))
for (const x of made) {
  const r = spawnSync('python3', ['-c', `
import sys, numpy as np
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGBA')
if im.size != (1024, 1536):
    k = max(1024 / im.width, 1536 / im.height); im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
    l, t = (im.width - 1024) // 2, (im.height - 1536) // 2; im = im.crop((l, t, l + 1024, t + 1536))
a = np.array(im).astype(np.float32) / 255
m = a[:, :, 3] > 0.5
med = float(np.median((a[:, :, 0] * .299 + a[:, :, 1] * .587 + a[:, :, 2] * .114)[m])) if m.any() else 0.5
color = (62, 74, 92) if med > 0.5 else (240, 229, 208)
clean = Image.new('RGBA', im.size); clean.putdata(list(im.getdata())); clean.save(sys.argv[3], 'PNG')
bg = Image.new('RGBA', im.size, color + (255,)); bg.alpha_composite(clean)
rgb = Image.new('RGB', im.size); rgb.putdata(list(bg.convert('RGB').getdata())); rgb.save(sys.argv[2], 'PNG')
print('배경', '진한 회청색' if med > 0.5 else '밝은 크림색', '(털 밝기 %.2f)' % med)`, rawOf(x.v.id), join(work, `${x.v.id}.png`), join(work, `${x.v.id}.alpha.png`)], { encoding: 'utf8' })
  if (r.status !== 0) log(`   ✗ ${x.v.id} 규격 맞추기 실패: ${r.stderr.trim().split('\n').slice(-1)[0]}`)
}
const ready = made.filter((x) => existsSync(join(work, `${x.v.id}.png`)))
log(`\n정면 ${ready.length}/${pick.length}장 준비 (${work})`)
const spent = pick.length ? readFileSync(costLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((o) => o.batch === date).reduce((s, o) => s + (o.usd ?? 0), 0) : 0
log(`이번 배치 비용(추정): $${spent.toFixed(2)}  — 기록: ${costLog}`)

// ───────────────────────── images-incoming에 올리기 ─────────────────────────

if (args['no-upload'] === 'true') {
  log(`\n--no-upload: 올리지 않았어요 (${work})`)
  process.exit(0)
}
const wt = join(ROOT, 'pets-src', 'images-incoming-wt')
const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8' })
  if (r.status !== 0) fail(`git ${a.join(' ')}: ${r.stderr.trim()}`)
  return r.stdout.trim()
}
git(ROOT, 'fetch', 'origin', BRANCH)
if (!existsSync(wt)) git(ROOT, 'worktree', 'add', '--detach', wt, `origin/${BRANCH}`)
else git(wt, 'checkout', '--detach', `origin/${BRANCH}`)
const lines = [`# 고퀄 정면 배치 ${date}`, '', `남은 기간 강아지 ${range('dog').join('~')}일·고양이 ${range('cat').join('~')}일, 짧은 순. Windows: 같은 폴더에 smile.png, pant.png, eyes-closed.png (front.png를 인페인팅, 1024×1536 그대로, PNG)`, '', '| 공고 | 종 | 공고번호 | 마감 | 남은 날 |', '|---|---|---|---|---|']
for (const x of ready) {
  const d = join(wt, 'incoming', x.v.id)
  mkdirSync(d, { recursive: true })
  copyFileSync(join(work, `${x.v.id}.png`), join(d, 'front.png'))
  copyFileSync(join(work, `${x.v.id}.alpha.png`), join(d, 'front.alpha.png'))
  writeFileSync(join(d, 'README.txt'), `공고 ${x.v.id}\n공고번호 ${x.a.noticeNo}\n종 ${x.v.sp === 'dog' ? '강아지' : '고양이'} (${x.a.kind})\n마감 ${x.a.end} (배치 날 기준 D-${x.d})\n보호소 ${x.a.care.name}\n`)
  lines.push(`| ${x.v.id} | ${x.v.sp === 'dog' ? '강아지' : '고양이'} | ${x.a.noticeNo} | ${x.a.end} | D-${x.d} |`)
}
writeFileSync(join(wt, 'incoming', `BATCH-${date}.md`), lines.join('\n') + '\n')
git(wt, 'add', 'incoming')
if (git(wt, 'status', '--porcelain')) git(wt, 'commit', '-m', `고퀄 정면 배치 ${date}: ${ready.length}마리`)
if (args['no-push'] === 'true') log(`\n--no-push: ${wt}에 커밋만 했어요`)
else {
  git(wt, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`)
  log(`\n✓ ${BRANCH}에 올렸어요 (incoming/BATCH-${date}.md)`)
}
rmSync(join(work, 'chatgpt-jobs.json'), { force: true })
