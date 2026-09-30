"""표정 사진(같은 자세에서 표정만 바꾼 편집본)을 부위만 잘라 표정 레이어로 만든다.

  python3 scripts/prepare-expression.py <원본.png> public/pets/<이름> x0 y0 x1 y1 <중간.png> <최종.png>

- 원본과 같은 방식(prepare-pet.py)으로 여백을 덧대고 잘라서 좌표계를 맞춘다
- 그다음 (x0, y0)-(x1, y1) 상자만 잘라, 표정 단계(약한 것부터)를 세로로 쌓아 <이름>.webp 한 장으로 저장한다.
  단계가 여럿이어도 텍스처는 하나라 폰에서 텍스처 개수 한도를 넘지 않는다. 상자 좌표는 잘라낸 원본 사진 기준이다
- pets.ts의 ExpressionLayer에 넣을 x, y, width, height, frames를 출력한다
- 단계 사이의 움직임(전환용)은 scripts/prepare-morph.py가 따로 만든다
- --eyes x,y,r ...를 주면 (잘라낸 원본 사진 좌표) 눈에 박힌 반사광을 지운다 (prepare-pet.py와 같게).
  --eyes-frames 0,1 로 지울 단계를 고른다 (기본은 전부). 눈을 감은 단계는 빼야 털이 뭉개지지 않는다
편집본이 원본과 어긋나 있으면 부위가 겹쳐 보이므로, 편집하지 않은 가슴 부분으로 어긋남을 재서 맞춘다.
"""

import subprocess
import sys

import numpy as np
from PIL import Image

MARGIN = 24  # prepare-pet.py와 같아야 한다

import catchlight

args = sys.argv[1:]
eyes = []
eye_frames = None
if '--eyes-frames' in args:
    i = args.index('--eyes-frames')
    eye_frames = {int(v) for v in args[i + 1].split(',')}
    args = args[:i] + args[i + 2 :]
if '--eyes' in args:
    i = args.index('--eyes')
    eyes = [tuple(float(v) for v in e.split(',')) for e in args[i + 1 :]]
    args = args[:i]
base_src, out = args[0], args[1]
bx0, by0, bx1, by1 = (int(v) for v in args[2:6])
frame_srcs = args[6:]


def load(path: str) -> np.ndarray:
    px = np.array(Image.open(path).convert('RGBA')).astype(np.float32)
    px[:, :, 3] = np.clip(px[:, :, 3] * (255.0 / 252.0), 0, 255)
    return np.pad(px, ((MARGIN, MARGIN), (MARGIN, MARGIN), (0, 0)))


base = load(base_src)

# 원본을 자른 위치 (prepare-pet.py와 같은 계산)
ys, xs = np.where(base[:, :, 3] > 8)
cx0, cy0 = xs.min() - MARGIN, ys.min() - MARGIN
h, w = base.shape[:2]
lum = lambda a: (a[:, :, 0] * 0.3 + a[:, :, 1] * 0.59 + a[:, :, 2] * 0.11) * (a[:, :, 3] / 255)


def misalignment(expr: np.ndarray) -> tuple[int, int]:
    """아래쪽 가슴(편집하지 않은 부분)을 위상 상관으로 비교해 어긋난 픽셀 수를 잰다"""
    A = lum(base)[int(h * 0.62) : int(h * 0.9), int(w * 0.25) : int(w * 0.75)]
    B = lum(expr)[int(h * 0.62) : int(h * 0.9), int(w * 0.25) : int(w * 0.75)]
    win = np.outer(np.hanning(A.shape[0]), np.hanning(A.shape[1]))
    F = np.fft.fft2((A - A.mean()) * win) * np.conj(np.fft.fft2((B - B.mean()) * win))
    r = np.fft.ifft2(F / (np.abs(F) + 1e-9)).real
    dy, dx = np.unravel_index(r.argmax(), r.shape)
    dy = dy - A.shape[0] if dy > A.shape[0] // 2 else dy
    dx = dx - A.shape[1] if dx > A.shape[1] // 2 else dx
    return int(dx), int(dy)


crops = []
for k, src in enumerate(frame_srcs):
    expr = load(src)
    if base.shape != expr.shape:
        sys.exit(f'크기가 다릅니다: 원본 {base.shape[:2]}, {src} {expr.shape[:2]}')
    dx, dy = misalignment(expr)
    if dx or dy:
        # 측정값은 밀린 방향의 반대로 나오므로 그만큼 옮기면 제자리다
        expr = np.roll(expr, (dy, dx), axis=(0, 1))
        print(f'{src}: 원본과 {-dx}, {-dy}픽셀 어긋나 있어 맞췄습니다 (남은 차이 {misalignment(expr)})')
    crop = expr[cy0 + by0 : cy0 + by1, cx0 + bx0 : cx0 + bx1]
    if crop.shape[:2] != (by1 - by0, bx1 - bx0):
        sys.exit(f'상자가 사진 밖으로 나갑니다: 요청 {bx1 - bx0}x{by1 - by0}, 실제 {crop.shape[1]}x{crop.shape[0]}')
    if eyes and (eye_frames is None or k in eye_frames):
        crop = catchlight.remove(crop, [(x - bx0, y - by0, r) for x, y, r in eyes])
    crops.append(crop)

stacked = np.concatenate(crops, axis=0)
tmp = out + '.tmp.png'
Image.fromarray(stacked.round().astype(np.uint8)).save(tmp)
subprocess.run(['cwebp', '-quiet', '-q', '84', '-alpha_q', '100', '-exact', tmp, '-o', out + '.webp'], check=True)
subprocess.run(['rm', tmp], check=True)
print(f'{{ x: {bx0}, y: {by0}, width: {bx1 - bx0}, height: {by1 - by0}, frames: {len(crops)} }}')
