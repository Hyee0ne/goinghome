/**
 * AI 표정 업그레이드 (로컬 검증용. 나중에 같은 단계를 서버 함수로 감싼다).
 *
 *   npm run pet:upgrade -- --in <폴더> --id <영문id> [--refs 사진1.jpg,사진2.jpg] [--out <결과 폴더>]
 *
 * 검증 결과 (2026-10-03, 삼식): 참고 사진(--refs)을 표정 편집에 같이 보내면 AI가 참고 사진 쪽으로 털색·얼굴·구도를 다시 그려
 * (더 주황색, 얼굴이 작아짐) 원래 아이와 달라졌다. 표정에는 참고 사진을 쓰지 않는 게 낫다 (앞발처럼 사진에 없는 부위를 만들 때만 쓴다)
 *
 * <폴더>에는 기기 안 엔진(src/maker/engine.ts)이 만든 파일이 있어야 한다: face.webp(또는 .png)와 landmarks.json.
 * 원본 사진은 쓰지 않는다 (배경을 지운 얼굴 사진과 기준점만 서버로 보낸다는 설계 그대로).
 *
 * pet-add.ts의 expressions·assets 단계를 그대로 돌린다: 얼굴 사진을 편집해 표정 사진(중간·최종, 고양이는 먹는 입 2장 더)을 만들고,
 * 부위별로 잘라 표정 레이어와 표정 사이 움직임 아틀라스를 만든다.
 * 결과 폴더에 upgrade.json(rig.expressions 조각, 파일 경로는 같은 폴더의 파일 이름)과 그 파일들을 둔다.
 * 앱은 src/maker/upgrade.ts의 applyUpgrade로 '우리 아이' 기록에 덧붙인다.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expressionBoxes, expressionLayers, type Landmarks } from '../src/rigDerive.ts'

const ROOT = resolve(import.meta.dirname, '..')
const args: Record<string, string> = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? 'true' : argv[++i]

const fail = (msg: string): never => {
  console.error(`✗ ${msg}`)
  process.exit(1)
}
const id = args.id
if (!id || !/^[a-z0-9-]+$/.test(id)) fail('--id는 영문 소문자·숫자·하이픈으로 주세요')
const inDir = args.in ? resolve(args.in) : fail('--in <엔진이 만든 파일 폴더>를 주세요')
const outDir = resolve(args.out ?? join(inDir, 'upgrade'))
const face = ['face.webp', 'face.png'].map((n) => join(inDir, n)).find(existsSync) ?? fail('face.webp가 없어요')
const lmPath = join(inDir, 'landmarks.json')
if (!existsSync(lmPath)) fail('landmarks.json이 없어요')
const lm = JSON.parse(readFileSync(lmPath, 'utf8')) as Landmarks

// pet-add.ts가 읽는 자리에 맞춰 둔다: 엔진의 face 사진이 곧 base (이미 정면으로 맞추고 잘라 투명 여백까지 정리됨, 좌표 이동 0)
const SRC = join(ROOT, 'pets-src', id)
const PUB = join(ROOT, 'public', 'pets', id)
mkdirSync(SRC, { recursive: true })
mkdirSync(PUB, { recursive: true })
const py = (code: string, ...a: string[]) => {
  const r = spawnSync('python3', ['-c', code, ...a], { encoding: 'utf8' })
  if (r.status !== 0) fail(r.stderr)
  return r.stdout.trim()
}
const info = JSON.parse(
  py(
    `import sys, json, numpy as np
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGBA'); im.save(sys.argv[2])
a = np.array(im)[:, :, 3]; rows = np.where((a > 128).any(axis=1))[0]
print(json.dumps({'width': im.width, 'height': im.height, 'bottom': int(rows.max()) if len(rows) else im.height}))`,
    face,
    join(SRC, 'base.png'),
  ),
)
writeFileSync(join(SRC, 'landmarks.json'), JSON.stringify(lm, null, 2))
writeFileSync(join(SRC, 'frame.json'), JSON.stringify({ box: { x0: 0, y0: 0, x1: info.width, y1: info.height }, scale: 1, cutLeft: false, cutRight: false }))
writeFileSync(join(PUB, 'face.json'), JSON.stringify({ offsetX: 0, offsetY: 0, ...info }))

const t0 = Date.now()
const r = spawnSync('node', [join(ROOT, 'scripts', 'pet-add.ts'), '--id', id, '--from', 'expressions', '--until', 'assets', ...(args.refs ? ['--refs', args.refs] : []), ...(args.regen ? ['--regen', 'true'] : []), ...(args.jobs ? ['--jobs', args.jobs] : [])], {
  cwd: ROOT,
  stdio: 'inherit',
})
if (r.status !== 0) fail('표정 만들기에 실패했어요')

// rig.expressions 조각 (pet-add.ts register 단계와 같은 계산, 경로는 결과 폴더의 파일 이름)
const morph = existsSync(join(PUB, 'morph.json')) ? JSON.parse(readFileSync(join(PUB, 'morph.json'), 'utf8')) : null
const layers = expressionLayers(lm, expressionBoxes(lm, info), { pant: 'pant.webp', eyes: 'eyes.webp', ears: 'ears.webp' }, morph?.fills.ears ?? [0.45, 0.28, 0.18])
const made = (file: string) => existsSync(join(PUB, file))
const expressions = {
  ...(made('pant.webp') && { pant: layers.pant }),
  ...(made('eyes.webp') && { eyesClosed: layers.eyesClosed }),
  ...(made('ears.webp') && { earsBack: layers.earsBack }),
  ...(morph && { morph: { src: 'morph.png', range: morph.range, sdfRange: morph.sdfRange, rects: morph.rects } }),
}
mkdirSync(outDir, { recursive: true })
const files = ['pant.webp', 'eyes.webp', 'ears.webp', 'morph.png'].filter(made)
for (const file of files) copyFileSync(join(PUB, file), join(outDir, file))
writeFileSync(join(outDir, 'upgrade.json'), JSON.stringify({ expressions, files }, null, 2))
// 앱 에셋 폴더(public/pets/<id>)는 검증용 임시 자리라 지운다 (저장소에 올라가지 않게). pets-src는 .gitignore
rmSync(PUB, { recursive: true, force: true })
console.log(`\n완료 (${((Date.now() - t0) / 1000).toFixed(0)}초): ${outDir}/upgrade.json + ${files.join(', ')}`)
