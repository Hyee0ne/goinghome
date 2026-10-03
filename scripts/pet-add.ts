/**
 * 사진 한 장 → 쓰다듬을 수 있는 실사 동물 (개·고양이).
 *
 *   npm run pet:add -- <사진> --id bori [--species dog|cat] [--name 보리 --breed "진도 믹스" --age "1살 추정" --sex 여아]
 *   npm run pet:add -- --id bori --from prepare     기준점 편집 화면(/rig.html?id=bori)에서 고친 뒤 그 뒤만 다시
 *   npm run pet:add -- --id bori --from expressions --regen    표정 사진을 새로 만들기
 *   --until <단계>   그 단계까지만 (예: --until frontal 로 정면 맞추기까지만 확인)
 *   --paw true|false '손' 개인기를 할 줄 아는 강아지 (손 주기가 켜진다. 앞발 사진은 따로 필요). 고양이는 무시
 *
 * 원본 사진을 편집해 실제 아이의 모습을 지킨다: 배경만 지우고, 표정은 원본을 편집해 만든다.
 *
 * AI 이미지 생성은 표정 2장뿐이다 (얼굴만 잘라 1024×1024로. API 기준 사진 한 장에 약 $0.3)
 *
 * 단계 (각 단계 결과는 pets-src/<id>/에 남아, --from으로 원하는 단계부터 다시 돌릴 수 있다)
 *   cutout       배경 지우기. macOS 내장 Apple Vision으로 무료 (윤곽에 남은 배경색도 정리). --ai-cutout이면 AI 편집.
 *                --reference면 사진은 참고용으로만 쓰고 같은 아이의 정면 클로즈업을 새로 만든다 (가장 자연스럽지만 외모가 조금 다를 수 있다)
 *   detect       기준점 찾기 (비전 모델. 사진에 눈금 격자를 얹어 좌표를 정확히 읽게 한다)
 *   frontal      정면 맞추기. 눈꺼풀·눈 마스크·표정이 모두 두 눈이 수평인 정면 얼굴을 기준으로 하므로,
 *                고개가 기울었으면 두 눈이 수평이 되게 돌린다 (무료). --ai-frontal이면 AI로 정면 편집을 먼저 해 본다
 *                (좌우로 돌아간 얼굴도 고치지만 외모가 달라질 수 있고 비용이 든다. 정면 사진을 찍는 게 가장 좋다)
 *   frame        얼굴 위주로 잘라 base.png를 만들고, 기준점을 최종 사진 좌표로 옮겨 landmarks.json에 쓴다
 *   prepare      앱용 사진·털 결 맵 (눈 반사광은 떼어 두었다가 셰이더가 조명 기준 위치에 다시 얹는다)
 *   expressions  표정 사진 2장: 중간(입 살짝·눈 반쯤·귀 절반)과 최종(입 벌림·눈 감음·귀 젖힘).
 *                입·눈·귀는 겹치지 않는 부위라 한 장에 같이 바꾸고, 다음 단계가 부위별로 잘라 쓴다.
 *                고양이는 입을 그대로 두고, 간식 먹는 입(살짝 벌림·크게 벌려 묾) 2장을 따로 만든다
 *   assets       표정 레이어와 표정 사이 움직임 아틀라스
 *   register     src/rigs/<id>.json (앱이 자동으로 불러온다)
 *
 * 이미지 편집과 기준점 찾기는 두 가지 방법 중 하나로 한다
 *   - OpenAI API: .env.local에 OPENAI_API_KEY가 있으면 쓴다 (사용한 만큼 비용 청구)
 *       이미지 gpt-image-1.5 (OPENAI_IMAGE_MODEL로 변경), 기준점 gpt-5.5 (OPENAI_VISION_MODEL로 변경. 비교해 보니 가장 정확했다)
 *       품질: --quality high|medium|low (기본 high), 표정 6장만 따로 --expr-quality
 *   - ChatGPT 구독: 키가 없으면 Codex CLI(ChatGPT 로그인)와 gpt-image 스킬을 쓴다 (GPT_IMAGE_SCRIPT로 경로 변경)
 *
 * 필요한 것: Python 3 (Pillow, numpy, scipy, opencv-python-headless), cwebp
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { deriveRig, dist, expressionBoxes, expressionLayers, type Landmarks, type Pt } from '../src/rigDerive.ts'

const STAGES = ['cutout', 'detect', 'frontal', 'frame', 'prepare', 'expressions', 'assets', 'register'] as const
type Stage = (typeof STAGES)[number]

/** 얼굴 위주로 잘라 맞추는 크기. 이미지 편집 결과가 이 크기로 나와 표정 사진과 픽셀 위치가 맞는다 */
const BASE_W = 1086
const BASE_H = 1448
/** 표정 편집에 보내는 얼굴 정사각형의 여백 배율 (1이면 귀 끝~턱이 꽉 찬다) */
const EXPR_PAD = 1.3

const ROOT = resolve(import.meta.dirname, '..')
// API 키는 .env.local에서 읽는다 (저장소에 올라가지 않는 파일). 키 값은 어디에도 출력하지 않는다
if (existsSync(join(ROOT, '.env.local'))) process.loadEnvFile(join(ROOT, '.env.local'))
const API_KEY = process.env.OPENAI_API_KEY?.trim() || ''
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1.5'
const VISION_MODEL = process.env.OPENAI_VISION_MODEL ?? 'gpt-5.5'
const GPT_IMAGE = process.env.GPT_IMAGE_SCRIPT ?? join(homedir(), '.claude/skills/gpt-image/scripts/gpt_image.mjs')

// ───────────────────────── 인자 ─────────────────────────

const args = parseArgs(process.argv.slice(2))
const id = args.id
if (!id || !/^[a-z0-9-]+$/.test(id)) fail('--id는 영문 소문자·숫자·하이픈으로 주세요 (예: --id bori)')
const from = (args.from ?? 'cutout') as Stage
if (!STAGES.includes(from)) fail(`--from은 ${STAGES.join(', ')} 중 하나예요`)

const SRC = join(ROOT, 'pets-src', id)
const PUB = join(ROOT, 'public', 'pets', id)
const RIG_JSON = join(ROOT, 'src', 'rigs', `${id}.json`)
mkdirSync(SRC, { recursive: true })
mkdirSync(PUB, { recursive: true })
mkdirSync(join(ROOT, 'src', 'rigs'), { recursive: true })

const photoArg = args._[0]
if (photoArg) {
  if (!existsSync(photoArg)) fail(`사진이 없어요: ${photoArg}`)
  copyFileSync(photoArg, join(SRC, `photo${extname(photoArg).toLowerCase() || '.jpg'}`))
}
const photo = ['.jpg', '.jpeg', '.png', '.webp', '.heic'].map((e) => join(SRC, `photo${e}`)).find(existsSync)

const f = {
  cutout: join(SRC, 'cutout.png'),
  grid: join(SRC, 'grid.jpg'),
  raw: join(SRC, 'landmarks.raw.json'),
  /** 정면으로 맞춘 사진과 그 사진의 기준점 (픽셀) */
  front: join(SRC, 'front.png'),
  frontLm: join(SRC, 'landmarks.front.json'),
  frontGrid: join(SRC, 'grid-front.jpg'),
  frontRaw: join(SRC, 'landmarks.front.raw.json'),
  base: join(SRC, 'base.png'),
  frame: join(SRC, 'frame.json'),
  landmarks: join(SRC, 'landmarks.json'),
  expr: (name: string) => join(SRC, `expr-${name}.png`),
}

const until = (args.until ?? 'register') as Stage
if (!STAGES.includes(until)) fail(`--until은 ${STAGES.join(', ')} 중 하나예요`)
const run = (stage: Stage) => STAGES.indexOf(stage) >= STAGES.indexOf(from) && STAGES.indexOf(stage) <= STAGES.indexOf(until)
const QUALITY = (args.quality ?? 'high') as 'high' | 'medium' | 'low'
const EXPR_QUALITY = (args['expr-quality'] ?? QUALITY) as 'high' | 'medium' | 'low'
console.log(API_KEY ? `OpenAI API 사용 (이미지 ${IMAGE_MODEL} · 품질 ${QUALITY}${EXPR_QUALITY !== QUALITY ? `, 표정 ${EXPR_QUALITY}` : ''} · 기준점 ${VISION_MODEL})` : 'ChatGPT 구독 사용 (Codex CLI)')

// ───────────────────────── 단계 ─────────────────────────

if (run('cutout')) {
  if (!photo) fail('사진을 주세요: npm run pet:add -- <사진> --id ' + id)
  if (args.reference === 'true') {
    // 사진은 참고용으로만 쓰고, 같은 아이가 정면을 보는 깨끗한 클로즈업을 새로 만든다 (초코를 만든 방식).
    // 정면·고른 조명·선명한 털이라 표정과 움직임이 자연스럽다. 대신 무늬나 얼굴형이 실제와 조금 다를 수 있다
    step('1/8 정면 클로즈업 새로 만들기 (사진은 참고용)')
    const species = args.species ?? 'animal'
    ;(await gptImage([
      {
        id: 'reference',
        mode: 'edit',
        edit_target: photo!,
        prompt:
          `Close-up portrait photo of this exact same ${species} (same fur color and length, same markings, same face shape, same eye color). ` +
          'Face-focused framing: the head fills most of the frame, including both ears fully, with just the top of the chest visible at the bottom edge. ' +
          'Facing the camera straight on, head centered and level, both eyes open and looking directly into the lens, mouth closed and relaxed. ' +
          'Soft, even, diffuse studio lighting with no harsh shadows, very sharp focus on individual fur strands and whiskers, natural colors, photorealistic. ' +
          'Isolated on a transparent background. Vertical 3:4 composition with a small margin above the ears and at the sides.',
        background: 'transparent',
        size: '1024x1536',
        out: f.cutout,
      },
    ])).length && fail('정면 사진을 만들지 못했어요. 위 오류를 확인해 주세요')
  } else if (args['ai-cutout'] !== 'true') {
    step('1/8 배경 지우기 (Apple Vision, 무료)')
    const r = spawnSync('swift', [join(ROOT, 'scripts', 'cutout.swift'), photo!, f.cutout], { cwd: ROOT, encoding: 'utf8' })
    if (r.status !== 0) fail(`배경을 지우지 못했어요: ${(r.stderr || r.stdout).trim()}\n   (macOS가 아니면 --ai-cutout 으로 AI 편집을 쓰세요)`)
    console.log(`   ${r.stdout.trim().split('\n')[0]}`)
    py('pet_tools.py', 'defringe', f.cutout, f.cutout)
  } else {
  step('1/8 배경 지우기 (AI 편집)')
  const [w, h] = imageSize(photo!)
  const size = w / h > 1.2 ? '1536x1024' : w / h < 0.83 ? '1024x1536' : '1024x1024'
  ;(await gptImage([
    {
      id: 'cutout',
      mode: 'edit',
      edit_target: photo!,
      prompt:
        'Remove the background completely and make it transparent. Keep the animal exactly as it is in the original photo: ' +
        'same pose, same position and size in the frame, same fur, markings, colors, eyes and every detail. ' +
        'Do not redraw, restyle, crop or reframe the animal. Photorealistic.',
      background: 'transparent',
      size,
      out: f.cutout,
    },
  ])).length && fail('배경을 지우지 못했어요. 위 로그를 확인해 주세요 (ChatGPT 사용량 한도에 걸렸다면 한도가 풀린 뒤 다시 실행)')
  }
}

if (run('detect')) {
  step('2/8 기준점 찾기 (비전 모델)')
  if (!(await detect(f.cutout, f.grid, f.raw))) fail('기준점을 찾지 못했어요. 위 오류를 확인해 주세요 (API 키, 사용량 한도 등)')
  const raw = readJson(f.raw)
  if (args.species && args.species !== raw.species) warn(`--species ${args.species}로 지정했지만 사진은 ${raw.species}로 보여요. 지정한 값을 씁니다`)
}

if (run('frontal')) {
  step('3/8 정면 맞추기')
  const raw = readJson(f.raw)
  const [cw, ch] = imageSize(f.cutout)
  let lm = rawToLandmarks(raw, cw, ch)
  let src = f.cutout
  const pose = facePose(lm)
  console.log(`   고개 기울기 ${pose.rollDeg.toFixed(1)}°, 좌우로 돌아감 ${(pose.yaw * 100).toFixed(0)}% (정면 판정: ${raw.frontal ? '예' : '아니오'})`)
  if (Math.abs(pose.rollDeg) > 4 || Math.abs(pose.yaw) > 0.08 || !raw.frontal) {
    // 1) (--ai-frontal일 때만) 원본을 편집해 정면으로
    const failed = args['ai-frontal'] !== 'true' ? ['skip'] : await gptImage([
      {
        id: 'frontal',
        mode: 'edit',
        edit_target: f.cutout,
        prompt:
          'Edit this photo so the animal faces the camera straight on: head turned to look directly into the lens, head level and upright ' +
          '(not tilted), both eyes at the same height and symmetric, nose centered between the eyes. Keep the same animal with exactly the same ' +
          'fur, markings, colors, eye color and face shape, same lighting, same body position, same transparent background. Photorealistic.',
        background: 'transparent',
        size: cw / ch > 1.2 ? '1536x1024' : cw / ch < 0.83 ? '1024x1536' : '1024x1024',
        out: f.front,
      },
    ])
    if (!failed.length && (await detect(f.front, f.frontGrid, f.frontRaw))) {
      const [fw, fh] = imageSize(f.front)
      lm = rawToLandmarks(readJson(f.frontRaw), fw, fh)
      src = f.front
      const after = facePose(lm)
      console.log(`   정면으로 편집했어요 → 기울기 ${after.rollDeg.toFixed(1)}°, 돌아감 ${(after.yaw * 100).toFixed(0)}%`)
    } else if (failed[0] === 'skip') {
      if (Math.abs(pose.yaw) > 0.12) warn('얼굴이 옆으로 돌아가 있어요. 표정이 어색할 수 있어요 (정면 사진을 쓰거나 --ai-frontal)')
    } else {
      warn('정면 편집을 하지 못해 (사용량 한도 등) 두 눈이 수평이 되게 돌리기만 합니다. 옆으로 돌아간 얼굴은 고쳐지지 않아요')
    }
    // 2) 남은 기울기는 돌려서 맞춘다 (기준점도 같이 돌린다)
    const p = facePose(lm)
    if (Math.abs(p.rollDeg) > 1) {
      const [sw, sh] = imageSize(src)
      const pad = Math.round(Math.max(sw, sh) * 0.2)
      const c = p.center
      py('pet_tools.py', 'rotate', src, f.front, String(p.rollDeg), String(c.x), String(c.y), String(pad))
      const t = (-p.rollDeg * Math.PI) / 180
      const cos = Math.cos(t)
      const sin = Math.sin(t)
      // 화면에서 반시계 방향으로 돌린 좌표 (y가 아래로 커지는 좌표계)
      lm = mapLandmarks(lm, (q) => ({
        x: c.x + (q.x - c.x) * cos - (q.y - c.y) * sin + pad,
        y: c.y + (q.x - c.x) * sin + (q.y - c.y) * cos + pad,
      }), 1)
      src = f.front
      console.log(`   ${p.rollDeg.toFixed(1)}° 돌려 두 눈을 수평으로 맞췄어요`)
    }
  } else {
    console.log('   이미 정면이에요')
  }
  if (src === f.cutout) copyFileSync(f.cutout, f.front)
  writeJson(f.frontLm, lm)
}

/** 사진에 눈금 격자를 얹어 비전 모델로 기준점을 찾는다 (0~1000 좌표 JSON). 실패하면 false */
async function detect(image: string, grid: string, out: string) {
  rmSync(out, { force: true })
  py('pet_tools.py', 'grid', image, grid)
  const prompt =
    'The image shows an animal with a coordinate grid overlay. Coordinates run 0-1000 on each axis (x left to right across the image width, ' +
    'y top to bottom across the image height); red lines every 100 are labeled, blue lines every 50. Locate these facial landmarks as precisely ' +
    'as possible using the grid: left_eye/right_eye = center of the pupil of the eye on the IMAGE left/right; eye_radius = radius of the ' +
    'visible eye (iris) in x units; nose = center of the nose leather, nose_width/nose_height in the same units; mouth = center of the mouth ' +
    'line; chin_bottom = lowest point of the chin; head_top = top of the skull between the ears; for each ear: base = where the ear attaches ' +
    'to the head (top of attachment), tip = the ear tip, outer = the point of the ear farthest from the face center. species = dog or cat. ' +
    'frontal = whether the face looks straight at the camera. Do not run any commands; just look at the image and answer with the JSON.'
  const schema = readJson(join(ROOT, 'scripts', 'landmarks-schema.json'))
  if (API_KEY) {
    const res = await openai('/v1/chat/completions', {
      model: VISION_MODEL,
      ...(VISION_MODEL.startsWith('gpt-5') && { reasoning_effort: 'low' }),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt.replace(' Do not run any commands; just look at the image and answer with the JSON.', ' Answer with the JSON.') },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${readFileSync(grid).toString('base64')}`, detail: 'high' } },
          ],
        },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'landmarks', strict: true, schema } },
    })
    const text = res?.choices?.[0]?.message?.content
    if (!text) return false
    writeFileSync(out, text)
    return true
  }
  const r = spawnSync(
    'codex',
    ['exec', '--skip-git-repo-check', '-s', 'read-only', '-c', 'model_reasoning_effort=low',
      '--output-schema', join(ROOT, 'scripts', 'landmarks-schema.json'), '-o', out, '-i', grid, '--', prompt],
    { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5 * 60_000 },
  )
  return r.status === 0 && existsSync(out)
}

/** OpenAI API 호출. 실패하면 오류를 보여 주고 null (키는 출력하지 않는다) */
async function openai(path: string, body: unknown | FormData) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://api.openai.com${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, ...(!(body instanceof FormData) && { 'content-type': 'application/json' }) },
        body: body instanceof FormData ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(5 * 60_000),
      })
      const json = await res.json().catch(() => ({}))
      if (res.ok) return json
      const msg = json?.error?.message ?? res.statusText
      // 잠깐 몰린 경우(429, 5xx)만 다시 시도한다. 잔액 부족·잘못된 요청은 바로 알린다
      if ((res.status === 429 && json?.error?.code !== 'insufficient_quota') || res.status >= 500) {
        warn(`OpenAI ${res.status}: ${msg} (${attempt}/3, 잠시 후 다시 시도)`)
        await new Promise((r) => setTimeout(r, 4000 * attempt))
        continue
      }
      warn(`OpenAI ${res.status}: ${msg}`)
      return null
    } catch (e) {
      warn(`OpenAI 요청 실패: ${e instanceof Error ? e.message : e} (${attempt}/3)`)
    }
  }
  return null
}

/** 고개 기울기(두 눈을 잇는 선의 각도)와 좌우로 돌아간 정도(두 눈 가운데에서 코가 벗어난 비율) */
function facePose(lm: Landmarks) {
  const dx = lm.rightEye.x - lm.leftEye.x
  const dy = lm.rightEye.y - lm.leftEye.y
  const center = { x: (lm.leftEye.x + lm.rightEye.x) / 2, y: (lm.leftEye.y + lm.rightEye.y) / 2 }
  return { rollDeg: (Math.atan2(dy, dx) * 180) / Math.PI, yaw: (lm.nose.x - center.x) / Math.hypot(dx, dy), center }
}

if (run('frame')) {
  step('4/8 얼굴 위주로 자르기')
  const lm0 = readJson(f.frontLm) as Landmarks
  const D = dist(lm0.leftEye, lm0.rightEye)
  // 귀 끝에서 끝까지 + 여백, 머리나 귀 중 더 높은 곳 위 여백부터 가슴까지. 3:4로 맞춘다 (초코와 같은 구도)
  // (고양이는 귀 끝이 정수리보다 높다)
  let x0 = Math.min(lm0.leftEar.outer.x, lm0.leftEar.tip.x) - D * 0.15
  let x1 = Math.max(lm0.rightEar.outer.x, lm0.rightEar.tip.x) + D * 0.15
  let y0 = Math.min(lm0.headTop.y, lm0.leftEar.tip.y, lm0.rightEar.tip.y) - D * 0.25
  let y1 = lm0.chin.y + D * 2
  const cxm = (x0 + x1) / 2
  const w = Math.max(x1 - x0, (y1 - y0) * 0.75)
  x0 = cxm - w / 2
  x1 = cxm + w / 2
  y1 = y0 + w / 0.75
  const box = { x0: Math.round(x0), y0: Math.round(y0), x1: Math.round(x1), y1: Math.round(y1) }
  const [, , cutL, cutR] = py('pet_tools.py', 'crop', f.front, f.base, String(box.x0), String(box.y0), String(box.x1), String(box.y1)).split(/\s+/).map(Number)
  py('pet_tools.py', 'fit', f.base, f.base, String(BASE_W), String(BASE_H))
  const s = BASE_W / (box.x1 - box.x0)
  // 자르는 범위가 바뀌면 전에 만든 표정 사진은 다른 구도라 쓸 수 없다
  const prevFrame = existsSync(f.frame) ? JSON.stringify(readJson(f.frame).box) : ''
  if (prevFrame && prevFrame !== JSON.stringify(box)) {
    for (const name of Object.keys(prompts('dog'))) rmSync(f.expr(name), { force: true })
    rmSync(join(SRC, 'face-square.json'), { force: true })
    warn('자르는 범위가 바뀌어 전에 만든 표정 사진을 지웠어요')
  }
  // 옆면이 잘렸으면 앱이 그쪽을 배경으로 서서히 사라지게 한다 (아래쪽은 늘 그렇게 한다)
  writeJson(f.frame, { box, scale: s, cutLeft: !!cutL, cutRight: !!cutR })

  // 최종 사진(앱이 쓰는, 투명 여백을 정리한) 좌표로 옮긴다
  const info = preparePet([])
  const move = (p: Pt): Pt => ({ x: (p.x - box.x0) * s - info.offsetX, y: (p.y - box.y0) * s - info.offsetY })
  const lm = mapLandmarks(lm0, move, s)
  writeJson(f.landmarks, { ...lm, species: (args.species as Landmarks['species']) ?? readJson(f.raw).species })
  console.log(`   기준점: pets-src/${id}/landmarks.json  (편집: npm run dev 후 /rig.html?id=${id})`)
}

if (run('prepare')) {
  step('5/8 앱용 사진 만들기 (털 결, 눈 반사광 떼어 두기)')
  const lm = readJson(f.landmarks) as Landmarks
  preparePet([lm.leftEye, lm.rightEye].map((e) => `${Math.round(e.x)},${Math.round(e.y)},${Math.round(lm.eyeR)}`))
}

if (run('expressions')) {
  step('6/8 표정 사진 2장 (얼굴만 잘라 원본 편집)')
  const lm = readJson(f.landmarks) as Landmarks
  const face = readJson(join(PUB, 'face.json'))
  const P = prompts(lm.species)
  // 얼굴 정사각형 (귀와 턱까지). 최종 사진 좌표 → base 좌표 (+잘라낸 위치)
  const D = dist(lm.leftEye, lm.rightEye)
  const top = Math.min(lm.headTop.y, lm.leftEar.tip.y, lm.rightEar.tip.y) - D * 0.15
  const bottom = lm.chin.y + D * 0.35
  const left = Math.min(lm.leftEar.outer.x, lm.leftEar.tip.x) - D * 0.15
  const right = Math.max(lm.rightEar.outer.x, lm.rightEar.tip.x) + D * 0.15
  // 표정 사진을 만든 얼굴 정사각형 자리는 저장해 두고, 이미 만든 표정 사진을 다시 쓸 때는 그 자리를 쓴다
  // (기준점만 고쳐 다시 돌릴 때 정사각형이 바뀌면 전에 만든 표정 사진이 어긋난다)
  const sqFile = join(SRC, 'face-square.json')
  const reuse = args.regen !== 'true' && existsSync(sqFile)
  // 얼굴 둘레에 여백을 두고 보낸다. 얼굴이 정사각형을 꽉 채우면 AI가 구도를 다시 잡아 얼굴을 작게·아래로 옮겨 그린다
  // (삼식 검증: 꽉 채웠을 때 크기 x0.86, 아래로 171px). 예전에 여백 없이 만든 표정 사진이 남아 있으면 그때 크기 그대로
  const legacy = ['mid-square', 'final-square', 'eat-square', 'eatmid-square'].some((n) => existsSync(join(SRC, `expr-${n}.png`)))
  const pad = args.regen === 'true' || !legacy ? EXPR_PAD : 1
  const side = reuse ? readJson(sqFile).side : Math.round(Math.max(bottom - top, right - left) * pad)
  const sq = reuse
    ? { x0: readJson(sqFile).x0, y0: readJson(sqFile).y0 }
    : { x0: Math.round((left + right) / 2 - side / 2 + face.offsetX), y0: Math.round((top + bottom) / 2 - side / 2 + face.offsetY) }
  writeJson(sqFile, { ...sq, side })
  const faceSq = join(SRC, 'face-square.png')
  py('pet_tools.py', 'crop', f.base, faceSq, String(sq.x0), String(sq.y0), String(sq.x0 + side), String(sq.y0 + side))
  py('pet_tools.py', 'fit', faceSq, faceSq, '1024', '1024')
  const out = { mid: join(SRC, 'expr-mid-square.png'), final: join(SRC, 'expr-final-square.png') }
  // --refs a.jpg,b.jpg: 같은 아이의 다른 사진. 편집할 때 같이 보내 털색·무늬·귀 모양을 지킨다 (자세·배경은 따르지 않게)
  const refs = (args.refs ? String(args.refs).split(',') : []).filter((r) => {
    if (!existsSync(r)) warn(`참고 사진이 없어요: ${r}`)
    return existsSync(r)
  })
  const withRefs = (prompt: string) =>
    refs.length
      ? `${prompt} The first image is the photo to edit. The other images are other photos of the same animal: use them only as a reference ` +
        `to keep its exact fur colors, markings and ear shape. Do not copy their pose, framing or background.`
      : prompt
  const refJob = refs.length ? { refs: refs.join('|') } : {}
  // 이미 만든 표정은 다시 만들지 않는다 (기준점만 고쳤을 때). 새로 만들려면 --regen
  // --jobs mid,final: 이 편집만 돌린다 (검증 등으로 일부만 다시 만들 때 비용을 아낀다)
  const only = args.jobs ? String(args.jobs).split(',') : null
  const allowed = (name: string) => !only || only.includes(name)
  const jobs = (['mid', 'final'] as const)
    .filter((k) => allowed(k) && (args.regen === 'true' || !existsSync(out[k])))
    .map((k) => ({ id: k, mode: 'edit', edit_target: faceSq, prompt: withRefs(P[k]), background: 'transparent', size: '1024x1024', quality: EXPR_QUALITY, out: out[k], ...refJob }))
  const failed = jobs.length ? await gptImage(jobs) : []
  if (!jobs.length) console.log('   이미 있는 표정 사진을 씁니다 (새로 만들려면 --regen)')
  if (failed.length) {
    warn(`표정 사진을 만들지 못했어요: ${failed.join(', ')}. 표정 없이 등록합니다 (움직임·털·깜빡임은 동작해요).`)
    warn(`사용량 한도라면, 한도가 풀린 뒤 npm run pet:add -- --id ${id} --from expressions 로 표정만 추가하세요`)
  }
  // 편집한 얼굴을 원본 전체 사진 위 제자리에 붙인다 (얼굴 밖은 원본 그대로). 다음 단계는 여기서 부위별로 잘라 쓴다.
  // 붙이기 전에 크기·위치를 원본에 맞추는데, 표정 때문에 바뀌는 눈·입·귀는 비교에서 뺀다 (상자 안 좌표)
  const inSq = (p: { x: number; y: number }) => [p.x + face.offsetX - sq.x0, p.y + face.offsetY - sq.y0]
  const exclude = [
    ...[lm.leftEye, lm.rightEye].map((e) => [...inSq(e), D * 0.4, D * 0.35]),
    [...inSq(lm.mouth), D * 0.55, D * 0.45],
    ...[lm.leftEar, lm.rightEar].flatMap((e) => [e.tip, e.outer, e.base].map((q) => [...inSq(q), D * 0.45, D * 0.45])),
  ].map((v) => v.map(Math.round))
  // 고양이는 기분이 좋아도 입을 벌리지 않아 위 두 장에서는 입을 그대로 둔다 (입 표정은 아래에서 따로)
  const cat = lm.species === 'cat'
  const parts = { mid: [...(cat ? [] : ['pantMid']), 'eyesHalf', 'earsMid'], final: [...(cat ? [] : ['pant']), 'eyesClosed', 'earsBack'] }
  for (const k of ['mid', 'final'] as const) {
    for (const name of parts[k]) rmSync(f.expr(name), { force: true })
    if (!existsSync(out[k])) continue
    const full = join(SRC, `expr-${k}.png`)
    py('pet_tools.py', 'paste', f.base, out[k], full, String(sq.x0), String(sq.y0), String(side), JSON.stringify(exclude))
    for (const name of parts[k]) copyFileSync(full, f.expr(name))
  }
  // 고양이 입은 간식을 받아먹을 때만 쓴다: 살짝 벌린 입, 크게 벌려 무는 입 2장을 따로 만든다 (약 2장 비용 추가)
  if (cat) {
    const eatOut = { pantMid: join(SRC, 'expr-eatmid-square.png'), pant: join(SRC, 'expr-eat-square.png') }
    const eatJobs = (['pantMid', 'pant'] as const)
      .filter((k) => allowed(k === 'pant' ? 'eat' : 'eatMid') && (args.regen === 'true' || !existsSync(eatOut[k])))
      .map((k) => ({ id: `eat-${k}`, mode: 'edit', edit_target: faceSq, prompt: withRefs(k === 'pant' ? P.eat : P.eatMid), background: 'transparent', size: '1024x1024', quality: EXPR_QUALITY, out: eatOut[k], ...refJob }))
    const eatFailed = eatJobs.length ? await gptImage(eatJobs) : []
    if (eatFailed.length) warn(`간식 먹는 입 사진을 만들지 못했어요: ${eatFailed.join(', ')}. 입은 턱만 조금 움직입니다`)
    for (const k of ['pantMid', 'pant'] as const) {
      rmSync(f.expr(k), { force: true })
      if (existsSync(eatOut[k])) py('pet_tools.py', 'paste', f.base, eatOut[k], f.expr(k), String(sq.x0), String(sq.y0), String(side), JSON.stringify(exclude))
    }
  }
}

if (run('assets')) {
  step('7/8 표정 레이어와 움직임 아틀라스')
  const lm = readJson(f.landmarks) as Landmarks
  const face = readJson(join(PUB, 'face.json'))
  const b = expressionBoxes(lm, face)
  const box = (x: { x0: number; y0: number; x1: number; y1: number }) => [x.x0, x.y0, x.x1, x.y1].map(String)
  const eyes = [lm.leftEye, lm.rightEye].map((e) => `${Math.round(e.x)},${Math.round(e.y)},${Math.round(lm.eyeR)}`)
  const has = (...names: string[]) => names.every((n) => existsSync(f.expr(n)))
  // 표정 사진이 있는 부위만 만든다 (사용량 한도 등으로 빠진 부위는 앱이 표정 없이 그린다)
  for (const file of ['pant.webp', 'eyes.webp', 'ears.webp', 'morph.png', 'morph.json']) rmSync(join(PUB, file), { force: true })
  if (has('pantMid', 'pant')) py('prepare-expression.py', f.base, join(PUB, 'pant'), ...box(b.pant), f.expr('pantMid'), f.expr('pant'), '--match-color')
  if (has('eyesHalf', 'eyesClosed'))
    py('prepare-expression.py', f.base, join(PUB, 'eyes'), ...box(b.eyes), f.expr('eyesHalf'), f.expr('eyesClosed'), '--eyes-frames', '0', '--eyes', ...eyes)
  // 귀 레이어는 머리 위쪽 전체라 편집본의 털색 차이가 잘 보인다: 원본 색에 맞춘다
  if (has('earsMid', 'earsBack')) py('prepare-expression.py', f.base, join(PUB, 'ears'), ...box(b.ears), f.expr('earsMid'), f.expr('earsBack'), '--match-color')
  const part = (name: string, x: { x0: number; y0: number; x1: number; y1: number }, a: string, c: string, extra = '') =>
    `${name}:${x.x0},${x.y0},${x.x1},${x.y1}:${f.expr(a)}:${f.expr(c)}${extra}`
  // 움직임 아틀라스: 눈·귀는 꼭 있어야 하고, 입은 있을 때만 (고양이 입은 간식 먹을 때 쓰는 입)
  if (has('eyesHalf', 'eyesClosed', 'earsMid', 'earsBack'))
    py('prepare-morph.py', f.base, join(PUB, 'morph.png'),
      ...(has('pantMid', 'pant') ? [part('pant', b.pant, 'pantMid', 'pant')] : []),
      part('eyes', b.eyes, 'eyesHalf', 'eyesClosed'), part('ears', b.ears, 'earsMid', 'earsBack', ':sdf'))
  else if (has('pant') || has('eyesHalf') || has('earsMid')) warn('표정 사진이 일부만 있어 움직임 아틀라스는 건너뜁니다')
}

if (run('register')) {
  step('8/8 앱에 등록')
  const lm = readJson(f.landmarks) as Landmarks
  const face = readJson(join(PUB, 'face.json'))
  const morph = existsSync(join(PUB, 'morph.json')) ? readJson(join(PUB, 'morph.json')) : null
  const rel = (name: string) => `pets/${id}/${name}`
  const layers = expressionLayers(
    lm,
    expressionBoxes(lm, face),
    { pant: rel('pant.webp'), eyes: rel('eyes.webp'), ears: rel('ears.webp') },
    morph?.fills.ears ?? [0.45, 0.28, 0.18],
  )
  const made = (file: string) => existsSync(join(PUB, file))
  const expressions = {
    ...(made('pant.webp') && { pant: layers.pant }),
    ...(made('eyes.webp') && { eyesClosed: layers.eyesClosed }),
    ...(made('ears.webp') && { earsBack: layers.earsBack }),
    ...(morph && { morph: { src: rel('morph.png'), range: morph.range, sdfRange: morph.sdfRange, rects: morph.rects } }),
  }
  const frame = readJson(f.frame)
  // 잘린 옆면의 위치 (최종 사진 좌표): base의 0열 / 끝 열
  const fadeSides = {
    ...(frame.cutLeft && { left: -face.offsetX }),
    ...(frame.cutRight && { right: BASE_W - face.offsetX }),
  }
  const rig = {
    ...deriveRig(lm, { src: rel('face.webp'), flow: rel('face-flow.png'), catchlight: rel('face-catch.png'), width: face.width, height: face.height, bottom: face.bottom }),
    ...(Object.keys(fadeSides).length && { fadeSides }),
    ...(Object.keys(expressions).length && { expressions }),
  }
  if (!Object.keys(expressions).length) warn('표정 없이 등록했어요')
  const prev = existsSync(RIG_JSON) ? readJson(RIG_JSON).profile : undefined
  writeJson(RIG_JSON, { profile: profile(lm.species, prev), rig })
  console.log(`\n완료: src/rigs/${id}.json  → npm run dev 로 확인하세요`)
}

// ───────────────────────── 도우미 ─────────────────────────

function prompts(species: 'dog' | 'cat') {
  const KEEP =
    'Keep everything else exactly identical to the original photo: same head position, size, angle and framing, same fur, markings, ' +
    'lighting and colors, same transparent background. Photorealistic.'
  const a = species === 'cat' ? 'cat' : 'dog'
  // 고양이는 기분이 좋아도 입을 벌리지 않는다: 입은 그대로 두고 눈과 귀만 바꾼다
  const catCombined = {
    mid:
      `Edit this close-up photo of the cat with two small changes at the same time, each only halfway, keeping the mouth closed and unchanged: ` +
      `(1) both eyes half closed, upper eyelids lowered halfway in a relaxed, content, sleepy look (a happy cat's squint), lower half of the irises still visible; ` +
      `(2) ears rotated only halfway sideways and back, between upright and flattened. ` +
      KEEP,
    final:
      `Edit this close-up photo of the cat with two changes at the same time, keeping the mouth closed and unchanged: ` +
      `(1) both eyes gently and fully closed, relaxed and content, like a slow blink; ` +
      `(2) ears flattened sideways and back against the head (airplane ears). ` +
      KEEP,
  }
  const combined = species === 'cat' ? catCombined : {
    mid:
      `Edit this close-up photo of the ${a} with three small changes at the same time, each only halfway: ` +
      `(1) mouth only slightly open, lips just parted, with only the tip of a pink tongue visible; ` +
      `(2) both eyes half closed, upper eyelids lowered halfway over the eyes in a relaxed, sleepy, content look, lower half of the irises still visible; ` +
      (species === 'cat'
        ? `(3) ears rotated only halfway sideways and back, between upright and flattened. `
        : `(3) ears pulled back only halfway, in between their relaxed position and being pressed flat against the head. `) +
      KEEP,
    final:
      `Edit this close-up photo of the ${a} with three changes at the same time: ` +
      (species === 'cat'
        ? `(1) mouth open in a soft, relaxed meow, showing a little of the pink tongue; `
        : `(1) happily panting, mouth open in a relaxed doggy smile with the pink tongue slightly out over the lower teeth; `) +
      `(2) both eyes gently and fully closed, relaxed and content; ` +
      (species === 'cat'
        ? `(3) ears flattened sideways and back against the head (airplane ears). `
        : `(3) ears pulled back and pressed flat against the sides of the head. `) +
      KEEP,
    }
  return {
    ...combined,
    pant:
      species === 'cat'
        ? `Edit this photo so the cat's mouth is open in a soft, relaxed meow, showing a little of the pink tongue. Eyes and ears unchanged. ${KEEP}`
        : `Edit this photo so the dog is happily panting: mouth open in a relaxed doggy smile with the pink tongue slightly out and resting over the lower teeth. Eyes and ears unchanged. ${KEEP}`,
    pantMid: `Edit this photo so the ${a}'s mouth is only slightly open: lips just parted, jaw raised about halfway toward closed, with only the tip of the same pink tongue visible behind the lower lip. Eyes and ears unchanged. ${KEEP}`,
    // 고양이가 간식을 받아먹을 때의 입 (앞 장은 오물오물 씹는 정도, 뒤 장은 한 입 무는 순간)
    eatMid:
      `Edit this photo so the cat's mouth is slightly open as if chewing: lower jaw dropped a little, lips just parted, ` +
      `a hint of the small lower teeth and the pink tongue tip inside. Eyes, nose, whiskers and ears unchanged. No food in the image. ${KEEP}`,
    eat:
      `Edit this photo so the cat's mouth is wide open as if taking a bite of a small treat: lower jaw dropped, ` +
      `small sharp canines and lower teeth visible, pink tongue inside the mouth. Eyes, nose, whiskers and ears unchanged. No food in the image. ${KEEP}`,
    eyesHalf: `Edit this photo so the ${a}'s eyes are half closed: upper eyelids lowered halfway over the eyes in a relaxed, sleepy, content look, lower half of the irises still visible. Mouth and ears unchanged. ${KEEP}`,
    eyesClosed: `Edit this photo so the ${a} has both eyes gently closed, relaxed and content, eyelids fully shut. Mouth and ears unchanged. ${KEEP}`,
    earsMid:
      species === 'cat'
        ? `Edit this photo so the cat's ears are rotated only halfway sideways and back, between upright and flattened. Eyes, nose and mouth unchanged. ${KEEP}`
        : `Edit this photo so the dog's ears are pulled back only halfway: rotated partly back toward the head, in between their relaxed position and being pressed flat against the head. Eyes, nose and mouth unchanged. ${KEEP}`,
    earsBack:
      species === 'cat'
        ? `Edit this photo so the cat's ears are flattened sideways and back against the head (airplane ears), a slightly wary expression. Eyes, nose and mouth unchanged. ${KEEP}`
        : `Edit this photo so the dog's ears are pulled back and pressed flat against the sides of its head, a slightly wary expression. Eyes, nose and mouth unchanged. ${KEEP}`,
  }
}

/** 비전 모델의 0~1000 좌표 → 사진 픽셀 */
function rawToLandmarks(raw: Record<string, any>, w: number, h: number): Landmarks {
  const P = (p: { x: number; y: number }) => ({ x: (p.x * w) / 1000, y: (p.y * h) / 1000 })
  return {
    species: raw.species,
    leftEye: P(raw.left_eye),
    rightEye: P(raw.right_eye),
    eyeR: (raw.eye_radius * w) / 1000,
    nose: P(raw.nose),
    noseRx: (raw.nose_width * w) / 2000,
    noseRy: (raw.nose_height * h) / 2000,
    mouth: P(raw.mouth),
    chin: P(raw.chin_bottom),
    headTop: P(raw.head_top),
    leftEar: { base: P(raw.left_ear_base), tip: P(raw.left_ear_tip), outer: P(raw.left_ear_outer) },
    rightEar: { base: P(raw.right_ear_base), tip: P(raw.right_ear_tip), outer: P(raw.right_ear_outer) },
  }
}

function mapLandmarks(lm: Landmarks, move: (p: Pt) => Pt, s: number): Landmarks {
  const round = (p: Pt) => ({ x: Math.round(p.x), y: Math.round(p.y) })
  const m = (p: Pt) => round(move(p))
  return {
    species: lm.species,
    leftEye: m(lm.leftEye),
    rightEye: m(lm.rightEye),
    eyeR: Math.round(lm.eyeR * s),
    nose: m(lm.nose),
    noseRx: Math.round(lm.noseRx * s),
    noseRy: Math.round(lm.noseRy * s),
    mouth: m(lm.mouth),
    chin: m(lm.chin),
    headTop: m(lm.headTop),
    leftEar: { base: m(lm.leftEar.base), tip: m(lm.leftEar.tip), outer: m(lm.leftEar.outer) },
    rightEar: { base: m(lm.rightEar.base), tip: m(lm.rightEar.tip), outer: m(lm.rightEar.outer) },
  }
}

/** 앱 프로필. 이미 있으면 그대로 두고, 인자로 준 값만 바꾼다 */
function profile(species: 'dog' | 'cat', prev?: Record<string, unknown>) {
  const base = prev ?? {
    id,
    name: id,
    species,
    breed: species === 'cat' ? '코리안 숏헤어' : '믹스견',
    age: '',
    sex: '',
    story: '',
    tip: '살살 쓰다듬어 주세요.',
    favorite: 'head',
    shy: false,
    // 사진을 못 쓸 때 그리는 그림의 색 (사진이 있으면 쓰이지 않는다)
    fur: '#9a6a44',
    furDark: '#6e4a2e',
    belly: '#f1dcc3',
    eye: '#2b1d14',
    pattern: 'none',
  }
  const pick = ['name', 'breed', 'age', 'sex', 'story', 'tip', 'favorite'] as const
  const out: Record<string, unknown> = { ...base, species }
  for (const k of pick) if (args[k]) out[k] = args[k]
  if (args.shy) out.shy = args.shy === 'true' || args.shy === '1'
  // '손' 개인기: 강아지만. 고양이에 주면 무시한다 (고양이는 손 주기가 없다)
  if (args.paw) {
    if (species === 'cat') warn("고양이는 '손' 개인기를 쓰지 않아요. --paw는 무시합니다")
    else out.canPaw = args.paw === 'true' || args.paw === '1'
  }
  if (species === 'cat') delete out.canPaw
  return out
}

function preparePet(eyes: string[]) {
  py('prepare-pet.py', f.base, join(PUB, 'face'), ...(eyes.length ? ['--eyes', ...eyes] : []))
  return readJson(join(PUB, 'face.json')) as { offsetX: number; offsetY: number; width: number; height: number; bottom: number }
}

/** 이미지 편집을 돌리고, 실패한 작업 id를 돌려준다 */
async function gptImage(jobs: Record<string, string>[]): Promise<string[]> {
  if (API_KEY) {
    // 동시에 4개까지
    const failed: string[] = []
    const queue = [...jobs]
    await Promise.all(
      Array.from({ length: Math.min(4, jobs.length) }, async () => {
        for (let j = queue.shift(); j; j = queue.shift()) if (!(await apiEdit(j))) failed.push(j.id)
      }),
    )
    return failed
  }
  if (!existsSync(GPT_IMAGE)) fail(`gpt-image 스크립트가 없어요: ${GPT_IMAGE} (GPT_IMAGE_SCRIPT로 경로를 지정할 수 있어요)`)
  const manifest = join(SRC, `batch-${jobs.map((j) => j.id).join('-')}.json`)
  writeJson(manifest, { version: 1, jobs })
  const r = spawnSync('node', [GPT_IMAGE, 'batch', '--manifest', manifest, '--overwrite', '--concurrency', String(Math.min(4, jobs.length))], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  const missing = jobs.filter((j) => !existsSync(j.out)).map((j) => j.id)
  if (r.status !== 0 && !missing.length) return jobs.map((j) => j.id)
  return missing
}

/** 이미지 편집 한 장 (OpenAI API). 원본을 최대한 지키도록 input_fidelity high */
async function apiEdit(job: Record<string, string>) {
  const t0 = Date.now()
  const form = new FormData()
  form.append('model', IMAGE_MODEL)
  form.append('prompt', job.prompt)
  // 참고 사진이 있으면 편집할 사진을 첫 장으로, 참고 사진을 뒤에 붙여 여러 장으로 보낸다 (털색·무늬를 지키는 용도)
  const refs = job.refs ? job.refs.split('|') : []
  if (refs.length) {
    form.append('image[]', new Blob([readFileSync(job.edit_target)], { type: 'image/png' }), 'image.png')
    refs.forEach((r, i) => form.append('image[]', new Blob([readFileSync(r)], { type: mimeOf(r) }), `ref${i}${extname(r)}`))
  } else form.append('image', new Blob([readFileSync(job.edit_target)], { type: 'image/png' }), 'image.png')
  form.append('size', job.size ?? '1024x1536')
  form.append('quality', job.quality ?? QUALITY)
  form.append('output_format', 'png')
  if (job.background) form.append('background', job.background)
  if (IMAGE_MODEL.startsWith('gpt-image-1')) form.append('input_fidelity', 'high')
  const res = await openai('/v1/images/edits', form)
  const b64 = res?.data?.[0]?.b64_json
  if (!b64) return false
  writeFileSync(job.out, Buffer.from(b64, 'base64'))
  const u = res.usage
  console.log(`   ✓ ${job.id} (${((Date.now() - t0) / 1000).toFixed(0)}초${u ? `, 입력 ${u.input_tokens} · 출력 ${u.output_tokens} 토큰` : ''})`)
  return true
}

function mimeOf(path: string) {
  const e = extname(path).toLowerCase()
  return e === '.png' ? 'image/png' : e === '.webp' ? 'image/webp' : 'image/jpeg'
}

function py(script: string, ...a: string[]) {
  const r = spawnSync('python3', [join(ROOT, 'scripts', script), ...a], { cwd: ROOT, encoding: 'utf8' })
  const out = (r.stdout ?? '').trim()
  if (out) console.log(out.replace(/^/gm, '   '))
  if (r.status !== 0) fail(`${script} 실패\n${(r.stderr ?? '').split('\n').filter((l) => !l.includes('Deprecat')).join('\n')}`)
  return out
}

function imageSize(path: string) {
  return py('pet_tools.py', 'size', path).split(/\s+/).map(Number) as [number, number]
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

function parseArgs(argv: string[]) {
  const out: Record<string, string> & { _: string[] } = { _: [] } as never
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? 'true' : argv[++i]
    else out._.push(a)
  }
  return out
}

function step(msg: string) {
  console.log(`\n▶ ${msg}`)
}

function warn(msg: string) {
  console.log(`   ⚠ ${msg}`)
}

function fail(msg: string): never {
  console.error(`\n✖ ${msg}`)
  process.exit(1)
}
