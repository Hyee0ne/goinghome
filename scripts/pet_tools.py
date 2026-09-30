"""사진 파이프라인(scripts/pet-add.ts)이 쓰는 작은 이미지 도구.

  python3 scripts/pet_tools.py grid <투명 배경.png> <격자.jpg>
      흰 배경에 얹고 0~1000 눈금 격자를 그린다 (비전 모델이 좌표를 정확히 읽게)
  python3 scripts/pet_tools.py crop <in.png> <out.png> x0 y0 x1 y1 [최소 폭]
      상자만큼 잘라낸다. 상자가 사진 밖으로 나가면 투명하게 채운다. 너무 작으면 최소 폭까지 키운다
  python3 scripts/pet_tools.py fit <in.png> <out.png> 폭 높이
      크기를 맞춘다 (이미지 편집 결과가 원본과 크기가 다르게 나왔을 때)
  python3 scripts/pet_tools.py size <이미지>
      폭 높이를 출력한다
  python3 scripts/pet_tools.py paste <base.png> <patch.png> <out.png> x0 y0 크기 ['[[cx,cy,rx,ry],...]']
      patch를 '크기'×'크기'로 맞춰 base의 (x0, y0)에 붙인다 (편집한 얼굴을 원본 전체 사진 제자리로).
      붙이기 전에 원본 얼굴에 크기·위치를 맞춘다. 마지막 인자는 맞출 때 뺄 부위 (상자 안 좌표)
  python3 scripts/pet_tools.py defringe <in.png> <out.png>
      배경을 지운 윤곽에 남은 원래 배경색 테두리를 없앤다 (가장자리 색을 안쪽 털 색으로 바꾸고, 가장 바깥 한 겹을 걷어낸다)
  python3 scripts/pet_tools.py rotate <in.png> <out.png> 각도 cx cy 여백
      사방에 투명 여백을 덧댄 뒤 (cx, cy)를 중심으로 반시계 방향으로 돌린다 (고개 기울기 보정)
"""

import sys

from PIL import Image, ImageDraw


def grid(src: str, out: str) -> None:
    im = Image.open(src).convert('RGBA')
    c = Image.alpha_composite(Image.new('RGBA', im.size, (255, 255, 255, 255)), im).convert('RGB')
    w, h = c.size
    d = ImageDraw.Draw(c)
    for k in range(0, 1001, 50):
        x, y = k * w / 1000, k * h / 1000
        col = (255, 0, 0) if k % 100 == 0 else (0, 150, 255)
        d.line([(x, 0), (x, h)], fill=col, width=1)
        d.line([(0, y), (w, y)], fill=col, width=1)
        if k % 100 == 0:
            d.text((x + 2, 2), str(k), fill=(255, 0, 0))
            d.text((2, y + 2), str(k), fill=(255, 0, 0))
    c.save(out, quality=90)


def crop(src: str, out: str, x0: int, y0: int, x1: int, y1: int, min_w: int = 0) -> None:
    im = Image.open(src).convert('RGBA')
    canvas = Image.new('RGBA', (x1 - x0, y1 - y0), (0, 0, 0, 0))
    canvas.paste(im, (-x0, -y0))
    if min_w and canvas.width < min_w:
        s = min_w / canvas.width
        canvas = canvas.resize((round(canvas.width * s), round(canvas.height * s)), Image.LANCZOS)
    canvas.save(out)
    # 동물이 상자 경계에서 잘렸는지 (경계 줄에 불투명한 픽셀이 많으면 잘린 것)
    a = canvas.getchannel('A')
    cut = lambda box: sum(1 for v in a.crop(box).getdata() if v > 200) > 20
    w, h = canvas.size
    print(f'{w} {h} {int(cut((0, 0, 1, h)))} {int(cut((w - 1, 0, w, h)))}')


def fit(src: str, out: str, w: int, h: int) -> None:
    im = Image.open(src).convert('RGBA')
    if im.size != (w, h):
        im = im.resize((w, h), Image.LANCZOS)
    im.save(out)


def align(ref: 'np.ndarray', mov: 'np.ndarray', exclude: list) -> 'tuple[np.ndarray, np.ndarray]':
    """mov(RGBA)를 ref(RGBA)에 크기·위치까지 맞춘다. AI 편집은 표정만이 아니라 얼굴 크기와 위치도 조금씩 바꾸기 때문이다.
    AI가 털 결을 새로 그려 세세한 특징점은 맞지 않으므로, 털 결을 흐리게 지운 명암 구조(얼굴형, 코, 이마 무늬)로 맞춘다 (ECC).
    exclude: 표정 때문에 바뀌는 부위 [cx, cy, rx, ry] 목록 (눈·입·귀). 비교에서 뺀다. 못 맞추면 그대로 둔다"""
    import cv2
    import numpy as np

    h, w = ref.shape[:2]
    k = w / 1024

    def gray(a: np.ndarray, sigma: float) -> np.ndarray:
        rgb = a[:, :, :3] * (a[:, :, 3:] / 255) + 128 * (1 - a[:, :, 3:] / 255)
        g = cv2.cvtColor(rgb.astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32) / 255
        return cv2.GaussianBlur(g, (0, 0), sigma * k)

    mask = np.full((h, w), 255, np.uint8)
    for cx, cy, rx, ry in exclude:
        cv2.ellipse(mask, (int(cx), int(cy)), (int(rx), int(ry)), 0, 0, 360, 0, -1)
    W = np.eye(2, 3, dtype=np.float32)
    try:
        for sigma in (16, 8, 4):
            _, W = cv2.findTransformECC(gray(ref, sigma), gray(mov, sigma), W, cv2.MOTION_AFFINE,
                                        (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6), mask, 5)
    except cv2.error:
        print('정렬: 맞추지 못해 그대로 둡니다')
        return mov, np.ones((h, w), np.float32)
    scale = float(np.sqrt(abs(np.linalg.det(W[:, :2]))))
    if not 0.8 < scale < 1.25:
        print(f'정렬: 크기가 x{scale:.2f}로 너무 달라 믿을 수 없어 그대로 둡니다')
        return mov, np.ones((h, w), np.float32)
    print(f'정렬: 크기 x{scale:.3f}, 이동 ({W[0, 2]:+.0f}, {W[1, 2]:+.0f})px')
    flags = cv2.INTER_LANCZOS4 | cv2.WARP_INVERSE_MAP
    warped = cv2.warpAffine(mov, W, (w, h), flags=flags, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
    # 편집 사진이 덮는 영역 (밖은 원본을 쓴다)
    cover = cv2.warpAffine(np.ones((h, w), np.float32), W, (w, h), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderValue=0)
    return warped, cover


def paste(base: str, patch: str, out: str, x0: int, y0: int, size: int, exclude: list) -> None:
    import numpy as np

    im = Image.open(base).convert('RGBA')
    p = Image.open(patch).convert('RGBA').resize((size, size), Image.LANCZOS)
    # 편집한 얼굴을 원본 얼굴에 크기·위치까지 맞춘다. 맞춘 뒤 비는 곳(편집 사진 밖)은 원본을 쓴다
    region0 = np.array(im.crop((x0, y0, x0 + size, y0 + size))).astype(np.float32)
    moved, cover = align(region0, np.array(p).astype(np.float32), exclude)
    cover = cover[:, :, None]
    pa = moved * cover + region0 * (1 - cover)
    p = Image.fromarray(np.clip(pa, 0, 255).round().astype(np.uint8))
    # 얼굴 상자 가장자리는 원본과 부드럽게 이어 붙인다 (편집 결과의 가장자리가 살짝 달라도 경계가 안 보이게)

    feather = max(4, size // 40)
    ramp = np.minimum(np.arange(size), np.arange(size)[::-1]) / feather
    w = np.clip(np.minimum.outer(ramp, ramp), 0, 1)
    region = im.crop((x0, y0, x0 + size, y0 + size))
    a = np.array(region).astype(np.float32)
    b = np.array(p).astype(np.float32)
    mixed = a * (1 - w[:, :, None]) + b * w[:, :, None]
    im.paste(Image.fromarray(mixed.round().astype(np.uint8)), (x0, y0))
    im.save(out)


def defringe(src: str, out: str) -> None:
    import cv2
    import numpy as np

    px = np.array(Image.open(src).convert('RGBA')).astype(np.float32)
    a = px[:, :, 3] / 255
    # 처리 폭은 사진 크기에 맞춘다 (1000px 기준 1)
    k = max(1.0, max(a.shape) / 1000)
    ksz = lambda n: np.ones((int(n * k) | 1, int(n * k) | 1), np.uint8)
    # 가장 바깥 겹(배경색이 가장 많이 섞인 곳)을 걷어내고 가장자리를 부드럽게
    a = cv2.erode(a, ksz(3))
    a = cv2.GaussianBlur(a, (0, 0), 0.8 * k)
    # 확실히 안쪽인 털의 색만 퍼뜨려, 가장자리 픽셀의 색을 그걸로 바꾼다
    core = (cv2.erode((a > 0.97).astype(np.uint8), ksz(5))).astype(np.float32)
    rgb = px[:, :, :3]
    num = cv2.GaussianBlur(rgb * core[:, :, None], (0, 0), 6 * k)
    den = cv2.GaussianBlur(core, (0, 0), 6 * k)[:, :, None]
    inner = num / np.maximum(den, 1e-4)
    near_edge = 1 - cv2.erode((a > 0.97).astype(np.uint8), ksz(9)).astype(np.float32)
    near_edge = cv2.GaussianBlur(near_edge, (0, 0), 1.5 * k)
    w = (near_edge * (den[:, :, 0] > 1e-3))[:, :, None]
    # 가장자리의 밝기 결은 살리고 색만 안쪽 털 쪽으로 (완전히 바꾸면 털 끝이 뭉개진다)
    lum = lambda c: c[:, :, 0:1] * 0.3 + c[:, :, 1:2] * 0.59 + c[:, :, 2:3] * 0.11
    fixed = inner * np.clip(lum(rgb) / np.maximum(lum(inner), 1), 0.85, 1.15)
    px[:, :, :3] = rgb * (1 - w) + fixed * w
    px[:, :, 3] = a * 255
    Image.fromarray(np.clip(px, 0, 255).round().astype(np.uint8)).save(out)


def rotate(src: str, out: str, deg: float, cx: float, cy: float, pad: int) -> None:
    im = Image.open(src).convert('RGBA')
    canvas = Image.new('RGBA', (im.width + 2 * pad, im.height + 2 * pad), (0, 0, 0, 0))
    canvas.paste(im, (pad, pad))
    canvas.rotate(deg, resample=Image.BICUBIC, center=(cx + pad, cy + pad)).save(out)


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'grid':
        grid(sys.argv[2], sys.argv[3])
    elif cmd == 'crop':
        crop(sys.argv[2], sys.argv[3], *[int(v) for v in sys.argv[4:8]], *([int(sys.argv[8])] if len(sys.argv) > 8 else []))
    elif cmd == 'fit':
        fit(sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]))
    elif cmd == 'paste':
        import json

        paste(sys.argv[2], sys.argv[3], sys.argv[4], *[int(v) for v in sys.argv[5:8]], json.loads(sys.argv[8]) if len(sys.argv) > 8 else [])
    elif cmd == 'defringe':
        defringe(sys.argv[2], sys.argv[3])
    elif cmd == 'rotate':
        rotate(sys.argv[2], sys.argv[3], float(sys.argv[4]), float(sys.argv[5]), float(sys.argv[6]), int(sys.argv[7]))
    elif cmd == 'size':
        print(*Image.open(sys.argv[2]).size)
    else:
        sys.exit(f'모르는 명령: {cmd}')
