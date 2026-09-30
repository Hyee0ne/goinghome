"""표정 전환용 움직임(옵티컬 플로우) 아틀라스를 만든다.

  python3 scripts/prepare-morph.py <원본.png> public/pets/<이름>-morph.png \\
    pant:309,420,829,850:<중간.png>:<최종.png> \\
    eyes:315,217,848,431:<중간.png>:<최종.png> \\
    ears:0,0,1158,760:<중간.png>:<최종.png>:sdf

표정 사진 사이를 그냥 겹쳐 섞으면(디졸브) 사진이 바뀌는 게 보인다. 대신 단계 사이마다 픽셀이 어디로 움직였는지
(턱이 내려가고 눈꺼풀이 내려오는 움직임)를 미리 구해 두고, 셰이더가 앞 사진은 그 방향으로 밀고 뒤 사진은 거꾸로
당겨 형태를 겹친 채 섞는다 (영상 프레임 보간과 같은 방식).

- 부위마다 단계 구간(원본→중간, 중간→최종)의 움직임을 한 칸에 담는다: 왼쪽 절반 앞→뒤, 오른쪽 절반 뒤→앞 (R,G)
  알파 채널은 쓰지 않는다. 브라우저가 알파를 곱해 디코딩하면서 다른 채널 정밀도가 깎이기 때문이다
- :sdf를 붙인 부위는 윤곽 거리장 칸도 만든다 (R: 원본, G/B: 각 단계). 윤곽이 바뀌는 귀에 쓴다
- 모든 칸을 낮은 해상도로 한 장에 쌓고, pets.ts에 넣을 칸 위치를 출력한다
좌표·어긋남 보정은 prepare-expression.py와 같다.
"""

import json
import sys

import cv2
import numpy as np
from PIL import Image

MARGIN = 24  # prepare-pet.py와 같아야 한다
RANGE = 128  # 움직임을 담는 최대 거리 (픽셀). 8비트라 한 칸은 1픽셀
SDF_RANGE = 48
SCALE = 0.35  # 움직임과 거리장은 부드러워서 낮은 해상도로 충분하다

base_src, out = sys.argv[1], sys.argv[2]
parts = [p.split(':') for p in sys.argv[3:]]


def load(path: str) -> np.ndarray:
    px = np.array(Image.open(path).convert('RGBA')).astype(np.float32)
    px[:, :, 3] = np.clip(px[:, :, 3] * (255.0 / 252.0), 0, 255)
    return np.pad(px, ((MARGIN, MARGIN), (MARGIN, MARGIN), (0, 0)))


base = load(base_src)
ys, xs = np.where(base[:, :, 3] > 8)
cx0, cy0 = xs.min() - MARGIN, ys.min() - MARGIN
H, W = base.shape[:2]
lum = lambda a: (a[:, :, 0] * 0.3 + a[:, :, 1] * 0.59 + a[:, :, 2] * 0.11) * (a[:, :, 3] / 255)


def misalignment(expr: np.ndarray) -> tuple[int, int]:
    A = lum(base)[int(H * 0.62) : int(H * 0.9), int(W * 0.25) : int(W * 0.75)]
    B = lum(expr)[int(H * 0.62) : int(H * 0.9), int(W * 0.25) : int(W * 0.75)]
    win = np.outer(np.hanning(A.shape[0]), np.hanning(A.shape[1]))
    F = np.fft.fft2((A - A.mean()) * win) * np.conj(np.fft.fft2((B - B.mean()) * win))
    r = np.fft.ifft2(F / (np.abs(F) + 1e-9)).real
    dy, dx = np.unravel_index(r.argmax(), r.shape)
    dy = dy - A.shape[0] if dy > A.shape[0] // 2 else dy
    dx = dx - A.shape[1] if dx > A.shape[1] // 2 else dx
    return int(dx), int(dy)


def gray(a: np.ndarray) -> np.ndarray:
    rgb = a[:, :, :3] * (a[:, :, 3:] / 255) + 128 * (1 - a[:, :, 3:] / 255)
    return cv2.cvtColor(rgb.astype(np.uint8), cv2.COLOR_RGB2GRAY)


def flow(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """a의 픽셀이 b에서 어디로 갔는지 (픽셀). 털 무늬에 흔들리지 않게 조금 흐린다"""
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    dis.setPatchSize(16)
    dis.setPatchStride(4)
    dis.setFinestScale(0)
    dis.setVariationalRefinementIterations(10)
    dis.setVariationalRefinementAlpha(40)
    return cv2.GaussianBlur(dis.calc(gray(a), gray(b), None), (0, 0), 3)


def half(img: np.ndarray) -> np.ndarray:
    return cv2.resize(img, (round(img.shape[1] * SCALE), round(img.shape[0] * SCALE)), interpolation=cv2.INTER_AREA)


def enc(v: np.ndarray, rng: float) -> np.ndarray:
    return np.clip(0.5 + v / (2 * rng), 0, 1)


def sdf(alpha: np.ndarray) -> np.ndarray:
    from scipy.ndimage import distance_transform_edt

    inside = alpha > 127
    return distance_transform_edt(inside) - distance_transform_edt(~inside)


tiles = []  # (이름, RGBA 0~1)
fills = {}  # 부위마다 윤곽 사이 빈틈을 채울 털 색
for spec in parts:
    name, box = spec[0], [int(v) for v in spec[1].split(',')]
    want_sdf = spec[-1] == 'sdf'
    srcs = spec[2:-1] if want_sdf else spec[2:]
    bx0, by0, bx1, by1 = box
    frames = [base[cy0 + by0 : cy0 + by1, cx0 + bx0 : cx0 + bx1]]
    for src in srcs:
        expr = load(src)
        dx, dy = misalignment(expr)
        if dx or dy:
            expr = np.roll(expr, (dy, dx), axis=(0, 1))
            print(f'{src}: {-dx}, {-dy}픽셀 어긋남을 맞췄습니다')
        frames.append(expr[cy0 + by0 : cy0 + by1, cx0 + bx0 : cx0 + bx1])
    for i in range(len(frames) - 1):
        fab, fba = flow(frames[i], frames[i + 1]), flow(frames[i + 1], frames[i])
        print(f'{name} {i}: 최대 움직임 {max(np.abs(fab).max(), np.abs(fba).max()):.0f}px')
        pad = lambda f: np.dstack([enc(f, RANGE), np.full(f.shape[:2], 0.5)])
        tiles.append((f'{name}{i}', half(np.hstack([pad(fab), pad(fba)]))))
    if want_sdf:
        # 빈틈 채움 색: 원본에만 있고 최종 단계에서 사라진 부분(바뀌는 부위) 털의 평균
        changing = (frames[0][:, :, 3] > 250) & (frames[-1][:, :, 3] < 5)
        if changing.sum() < 100:
            changing = frames[0][:, :, 3] > 250
        fills[name] = [round(float(v), 3) for v in frames[0][:, :, :3][changing].mean(axis=0) / 255]
        chans = [enc(sdf(f[:, :, 3]), SDF_RANGE) for f in frames][:3]
        tiles.append((f'{name}Sdf', half(np.dstack(chans))))

# 세로로 쌓는다
aw = max(t.shape[1] for _, t in tiles)
ah = sum(t.shape[0] for _, t in tiles)
atlas = np.zeros((ah, aw, 3), np.float32)
rects = {}
y = 0
for name, t in tiles:
    atlas[y : y + t.shape[0], : t.shape[1]] = t
    rects[name] = (0, y / ah, t.shape[1] / aw, t.shape[0] / ah)
    y += t.shape[0]
Image.fromarray((atlas * 255).round().astype(np.uint8)).save(out, optimize=True)
print(f'{out}: {aw}x{ah}')
# 파이프라인이 읽는 결과 (칸 위치, 범위, 빈틈 채움 색)
with open(out.rsplit('.', 1)[0] + '.json', 'w') as f:
    json.dump({'range': RANGE, 'sdfRange': SDF_RANGE, 'rects': {k: [round(v, 5) for v in r] for k, r in rects.items()}, 'fills': fills}, f)
print('rects: {')
for name, r in rects.items():
    print(f'  {name}: [{r[0]:.5f}, {r[1]:.5f}, {r[2]:.5f}, {r[3]:.5f}],')
print('}')
