"""투명 배경 동물 사진을 실사 셰이더용 에셋으로 만든다.

  python3 scripts/prepare-pet.py generated-images/choco.png public/pets/choco [--eyes x,y,r x,y,r]

출력
  <out>.webp       알파 포함 사진 (여백을 잘라내고, 거의 불투명한 알파는 완전 불투명으로 보정)
  <out>-flow.png   털 결 맵. R,G = 털 방향(각도를 두 배로 해서 저장해 필터링해도 부호가 뒤집히지 않음),
                   B = 결의 선명도(털이 한 방향으로 곧게 난 정도)
--eyes를 주면 (잘라낸 사진 좌표의 눈 중심과 반지름) 눈에 박힌 반사광을 지우고, 지운 반사광만 떼어
  <out>-catch.png (눈마다 한 칸, 가로로 나란히)로 저장한다. 셰이더가 조명 기준 고정 위치에 다시 얹는다.
그리고 잘라낸 오프셋을 출력한다 (음수면 여백을 덧댄 것). pets.ts의 기준점 좌표에서 이 값을 빼서 적는다.
"""

import subprocess
import sys

import numpy as np
from PIL import Image

import catchlight

args = sys.argv[1:]
eyes = []
if '--eyes' in args:
    i = args.index('--eyes')
    eyes = [tuple(float(v) for v in e.split(',')) for e in args[i + 1 :]]
    args = args[:i]
src, out = args[0], args[1]
MARGIN = 24
FLOW_SCALE = 0.25

im = Image.open(src).convert('RGBA')
px = np.array(im).astype(np.float32)
alpha = px[:, :, 3]

# 생성 이미지의 몸통 알파가 252~253이라 배경이 살짝 비친다. 불투명 부분을 255로 맞춘다
alpha = np.clip(alpha * (255.0 / 252.0), 0, 255)
px[:, :, 3] = alpha

# 원본 가장자리에 털이 닿아 있어도 셰이더가 경계 밖을 샘플링할 때 픽셀이 늘어지지 않게, 투명 여백을 덧댄다
px = np.pad(px, ((MARGIN, MARGIN), (MARGIN, MARGIN), (0, 0)))
alpha = px[:, :, 3]
ys, xs = np.where(alpha > 8)
x0, x1 = xs.min() - MARGIN, xs.max() + MARGIN + 1
y0, y1 = ys.min() - MARGIN, ys.max() + MARGIN + 1
px = px[y0:y1, x0:x1]
if eyes:
    before = px.copy()
    px = catchlight.remove(px, eyes)
    catchlight.save_patches(before, px, eyes, out + '-catch.png')
x0 -= MARGIN
y0 -= MARGIN
cropped = Image.fromarray(px.round().astype(np.uint8))

tmp_png = out + '.tmp.png'
cropped.save(tmp_png)
subprocess.run(['cwebp', '-quiet', '-q', '84', '-alpha_q', '100', '-exact', tmp_png, '-o', out + '.webp'], check=True)
subprocess.run(['rm', tmp_png], check=True)

def blur(a: np.ndarray, sigma: float) -> np.ndarray:
    """분리형 가우시안 블러 (가장자리는 복제)"""
    r = int(sigma * 3)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]
        pad[axis] = (r, r)
        p = np.pad(a, pad, mode='edge')
        n = a.shape[axis]
        a = sum(w * np.take(p, np.arange(i, i + n), axis=axis) for i, w in enumerate(k))
    return a


# ── 털 결: 휘도 기울기의 구조 텐서. 털 가닥은 기울기와 수직 방향으로 난다 ──
small = cropped.resize((round(cropped.width * FLOW_SCALE), round(cropped.height * FLOW_SCALE)), Image.LANCZOS)
s = np.array(small).astype(np.float32) / 255.0
lum = s[:, :, 0] * 0.3 + s[:, :, 1] * 0.59 + s[:, :, 2] * 0.11
lum = blur(lum, 0.6)

gx = np.zeros_like(lum)
gy = np.zeros_like(lum)
gx[:, 1:-1] = lum[:, 2:] - lum[:, :-2]
gy[1:-1, :] = lum[2:, :] - lum[:-2, :]


jxx, jyy, jxy = blur(gx * gx, 3), blur(gy * gy, 3), blur(gx * gy, 3)
# 기울기의 주방향 각도. 털 방향은 여기에 90도를 더한 것이고, 두 배 각도로는 +180도
theta2 = np.arctan2(2 * jxy, jxx - jyy) + np.pi
coherence = np.sqrt((jxx - jyy) ** 2 + 4 * jxy**2) / (jxx + jyy + 1e-6)

flow = np.zeros((*lum.shape, 3), np.float32)
flow[:, :, 0] = 0.5 + 0.5 * np.cos(theta2)
flow[:, :, 1] = 0.5 + 0.5 * np.sin(theta2)
flow[:, :, 2] = np.clip(coherence, 0, 1)
Image.fromarray((flow * 255).round().astype(np.uint8)).save(out + '-flow.png', optimize=True)

print(f'crop offset: x={x0} y={y0}  size: {cropped.width}x{cropped.height}  flow: {small.width}x{small.height}')
# 파이프라인이 읽는 결과 (잘라낸 위치와 크기, 불투명한 부분의 가장 아래)
import json

opaque_rows = np.where((px[:, :, 3] > 128).any(axis=1))[0]
with open(out + '.json', 'w') as f:
    json.dump({'offsetX': int(x0), 'offsetY': int(y0), 'width': cropped.width, 'height': cropped.height,
               'bottom': int(opaque_rows.max()) if len(opaque_rows) else cropped.height}, f)
