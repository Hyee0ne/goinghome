/**
 * 주 1회 고퀄 정면 배치: 공고 아이를 골라 GPT(high)로 정면을 그리고, Windows가 표정을 그릴 수 있게 images-incoming 브랜치에 올린다.
 *
 *   npm run shelter:batch -- --dry-run                      고를 아이와 예상 비용만 보여 준다 (생성·push 없음)
 *   npm run shelter:batch                                   만들고 images-incoming에 push
 *   옵션: --dogs 10 --cats 10 --min-days 7 --max-days 21 --no-push --only id1,id2
 *
 * 고르는 기준 (2026-10-06 사용자 확정): 무료 판정을 통과한 아이(머리 잘림으로만 떨어진 고퀄 후보 포함) 중
 * 공고 남은 기간이 min~max일인 아이를 남은 기간이 짧은 순으로 (같으면 정면도 순). 이미 고퀄 정면이 있는 아이는 뺀다.
 *
 * 그리기: ChatGPT 구독(gpt-image 스킬)을 먼저 쓰고, 실패(사용량 한도 등)한 아이만 OpenAI API로 다시 그린다 (사용자 허락).
 * 비용은 pets-src/shelter-batch-cost.jsonl에 한 줄씩 남긴다 (API만 비용이 든다. 구독은 0).
 * 결과: incoming/<id>/front.png (1024×1536 RGB PNG, 메타데이터 없음, 단색 밝은 회색 배경 — 인페인팅·누끼가 쉽게), README.txt,
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
const MIN_D = Number(args['min-days'] ?? 7)
const MAX_D = Number(args['max-days'] ?? 21)
/** API 한 장 비용 추정 (gpt-image-1.5 high 1024×1536 편집, 지난 실측 토큰 기준) */
const API_COST = 0.2
const BRANCH = 'images-incoming'
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
  .filter((v) => (v.ok || v.layoutOnly) && v.photo !== undefined && animals.has(v.id) && !hasHq(v.id))
  .filter((v) => !only || only.includes(v.id))
  .map((v) => ({ v, a: animals.get(v.id)!, d: daysLeft(animals.get(v.id)!.end) }))
  .filter((x) => only || (x.d >= MIN_D && x.d <= MAX_D))
  .sort((x, y) => x.d - y.d || (y.v.frontal ?? 0) - (x.v.frontal ?? 0))
const pick = only ? pool : [...pool.filter((x) => x.v.sp === 'dog').slice(0, N_DOG), ...pool.filter((x) => x.v.sp === 'cat').slice(0, N_CAT)]

log(`고른 아이: 강아지 ${pick.filter((x) => x.v.sp === 'dog').length}, 고양이 ${pick.filter((x) => x.v.sp === 'cat').length} (남은 기간 ${MIN_D}~${MAX_D}일, 짧은 순. 후보 ${pool.length}마리, 이미 고퀄인 아이 제외)`)
for (const x of pick) log(`  ${x.v.sp === 'dog' ? '🐶' : '🐱'} ${x.v.id}  D-${x.d}  ${x.a.noticeNo}  ${x.a.kind}  정면도 ${Math.round((x.v.frontal ?? 0) * 100)}%${x.v.layoutOnly ? '  (머리 잘림 → AI가 채움)' : ''}`)
log(`예상 비용: ChatGPT 구독으로 다 되면 $0 · 한도에 걸려 전부 API로 가면 약 $${(pick.length * API_COST).toFixed(2)} (한 장 약 $${API_COST}, 추정)`)
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
  'Plain solid light gray studio background. No collar, no leash, no hands, no text. Vertical 2:3 composition with a small margin above the ears and at the sides.'
const srcOf = (x: (typeof pick)[number]) => join(ROOT, 'pets-src', `shelter-${x.v.id}`, `src-${x.v.photo}.jpg`)
const rawOf = (id: string) => join(work, `${id}.raw.png`)
const costLog = join(ROOT, 'pets-src', 'shelter-batch-cost.jsonl')
const record = (o: Record<string, unknown>) => appendFileSync(costLog, JSON.stringify({ at: new Date().toISOString(), batch: date, ...o }) + '\n')

// 1) ChatGPT 구독
const todo = pick.filter((x) => !existsSync(rawOf(x.v.id)))
if (todo.length && existsSync(GPT_IMAGE)) {
  const manifest = join(work, 'chatgpt-jobs.json')
  writeFileSync(manifest, JSON.stringify({ version: 1, jobs: todo.map((x) => ({ id: x.v.id, mode: 'edit', edit_target: srcOf(x), prompt: prompt(x.v.sp), size: '1024x1536', quality: 'high', out: rawOf(x.v.id) })) }))
  log(`\n▶ ChatGPT 구독으로 ${todo.length}장`)
  spawnSync('node', [GPT_IMAGE, 'batch', '--manifest', manifest, '--overwrite', '--concurrency', '3'], { cwd: ROOT, stdio: 'inherit' })
  for (const x of todo) if (existsSync(rawOf(x.v.id))) record({ id: x.v.id, via: 'chatgpt', usd: 0 })
}

// 2) 남은 아이는 API (사용자 허락: 구독 한도에 걸리면 API)
const left = pick.filter((x) => !existsSync(rawOf(x.v.id)))
if (left.length) {
  if (existsSync(join(ROOT, '.env.local'))) process.loadEnvFile(join(ROOT, '.env.local'))
  const key = process.env.OPENAI_API_KEY?.trim()
  if (!key) fail(`${left.length}장이 남았는데 OPENAI_API_KEY가 없어요`)
  log(`\n▶ API로 ${left.length}장 (약 $${(left.length * API_COST).toFixed(2)})`)
  for (const x of left) {
    const form = new FormData()
    form.append('model', process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1.5')
    form.append('prompt', prompt(x.v.sp))
    form.append('image', new Blob([readFileSync(srcOf(x))], { type: 'image/jpeg' }), 'image.jpg')
    form.append('size', '1024x1536')
    form.append('quality', 'high')
    form.append('output_format', 'png')
    form.append('input_fidelity', 'high')
    const res = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(300_000) }).catch((e) => e as Error)
    const j = res instanceof Response ? await res.json().catch(() => ({})) : {}
    const b64 = j?.data?.[0]?.b64_json
    if (!b64) {
      log(`   ✗ ${x.v.id}: ${res instanceof Response ? `${res.status} ${j?.error?.message ?? ''}` : (res as Error).message}`)
      continue
    }
    writeFileSync(rawOf(x.v.id), Buffer.from(b64, 'base64'))
    record({ id: x.v.id, via: 'api', usd: API_COST, usage: j.usage })
    log(`   ✓ ${x.v.id}`)
  }
}

// 3) 규격 맞추기: 1024×1536 RGB PNG, 메타데이터 없음 (투명이나 다른 크기로 와도 맞춘다)
const made = pick.filter((x) => existsSync(rawOf(x.v.id)))
for (const x of made) {
  const r = spawnSync('python3', ['-c', `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGBA')
bg = Image.new('RGBA', im.size, (225, 225, 225, 255)); bg.alpha_composite(im)
im = bg.convert('RGB')
if im.size != (1024, 1536):
    k = max(1024 / im.width, 1536 / im.height); im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
    l, t = (im.width - 1024) // 2, (im.height - 1536) // 2; im = im.crop((l, t, l + 1024, t + 1536))
clean = Image.new('RGB', im.size); clean.putdata(list(im.getdata())); clean.save(sys.argv[2], 'PNG')`, rawOf(x.v.id), join(work, `${x.v.id}.png`)], { encoding: 'utf8' })
  if (r.status !== 0) log(`   ✗ ${x.v.id} 규격 맞추기 실패: ${r.stderr.trim().split('\n').slice(-1)[0]}`)
}
const ready = made.filter((x) => existsSync(join(work, `${x.v.id}.png`)))
log(`\n정면 ${ready.length}/${pick.length}장 준비 (${work})`)
const spent = pick.length ? readFileSync(costLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((o) => o.batch === date).reduce((s, o) => s + (o.usd ?? 0), 0) : 0
log(`이번 배치 비용(추정): $${spent.toFixed(2)}  — 기록: ${costLog}`)

// ───────────────────────── images-incoming에 올리기 ─────────────────────────

const wt = join(ROOT, 'pets-src', 'images-incoming-wt')
const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8' })
  if (r.status !== 0) fail(`git ${a.join(' ')}: ${r.stderr.trim()}`)
  return r.stdout.trim()
}
git(ROOT, 'fetch', 'origin', BRANCH)
if (!existsSync(wt)) git(ROOT, 'worktree', 'add', '--detach', wt, `origin/${BRANCH}`)
else git(wt, 'checkout', '--detach', `origin/${BRANCH}`)
const lines = [`# 고퀄 정면 배치 ${date}`, '', `남은 기간 ${MIN_D}~${MAX_D}일, 짧은 순. Windows: 같은 폴더에 smile.png, pant.png, eyes-closed.png (front.png를 인페인팅, 1024×1536 그대로, PNG)`, '', '| 공고 | 종 | 공고번호 | 마감 | 남은 날 |', '|---|---|---|---|---|']
for (const x of ready) {
  const d = join(wt, 'incoming', x.v.id)
  mkdirSync(d, { recursive: true })
  copyFileSync(join(work, `${x.v.id}.png`), join(d, 'front.png'))
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
