"""눈의 반사광(캐치라이트)을 사진에서 지운다.

사진에 박힌 반사광은 눈동자를 움직이면 같이 움직여 어색하다. 실제 반사광은 조명을 따라 제자리에 있어야 하므로,
사진에서는 지우고(인페인팅) 셰이더가 조명 기준 고정 위치에 다시 그린다.
"""

import cv2
import numpy as np


def remove(px: np.ndarray, eyes: list[tuple[float, float, float]], threshold: float = 120) -> np.ndarray:
    """px: RGBA float(0~255). eyes: (x, y, r) 목록 (px 좌표).
    눈 안쪽에서 밝고 흰빛·회색빛인 부분(반사광과 그 빛무리)만 지운다. 갈색 눈동자와 검은 동공은 채도·밝기로 걸러진다.
    눈을 감은 사진(가운데에 검은 동공이 없음)은 건드리지 않는다"""
    out = px.copy()
    rgb = np.clip(out[:, :, :3], 0, 255).astype(np.uint8)
    lum = rgb[:, :, 0] * 0.3 + rgb[:, :, 1] * 0.59 + rgb[:, :, 2] * 0.11
    hi, lo = rgb.max(axis=2).astype(float), rgb.min(axis=2).astype(float)
    sat = (hi - lo) / np.maximum(hi, 1)
    h, w = lum.shape
    yy, xx = np.mgrid[0:h, 0:w]
    mask = np.zeros((h, w), np.uint8)
    for x, y, r in eyes:
        d2 = (xx - x) ** 2 + (yy - y) ** 2
        if (lum[d2 < (r * 0.5) ** 2] < 60).mean() < 0.1:
            continue  # 동공만큼 넓게 어두운 곳이 없으면 감은 눈이다 (속눈썹 선은 가늘다)
        inside = d2 < (r * 0.9) ** 2
        found = inside & (lum > threshold) & (sat < 0.3)
        # 작고 뚜렷한 반사광만 뗀다. 고양이처럼 눈 전체에 넓게 번진 흐릿한 반사를 지우면 동공이 뭉개진다
        share = found.sum() / max(inside.sum(), 1)
        core = (inside & (lum > 200)).sum()
        if share >= 0.1 or core < 8:
            print(f'눈 ({x:.0f}, {y:.0f}): 반사가 넓거나 흐릿해 사진 그대로 둡니다 (면적 {share:.0%}, 밝은 핵 {core}px)')
            continue
        mask |= found.astype(np.uint8)
    mask = cv2.dilate(mask, np.ones((7, 7), np.uint8))
    fixed = cv2.inpaint(rgb, mask * 255, 5, cv2.INPAINT_TELEA)
    out[:, :, :3] = np.where(mask[:, :, None] > 0, fixed, out[:, :, :3])
    print(f'반사광 {int(mask.sum())}픽셀을 지웠습니다')
    return out


def save_patches(before: np.ndarray, after: np.ndarray, eyes: list[tuple[float, float, float]], path: str) -> None:
    """지우기 전후의 차이로 반사광만 떼어 투명 조각으로 저장한다 (눈마다 지름 크기 한 칸, 가로로 나란히).
    색은 원래 사진 그대로, 알파는 지운 뒤보다 얼마나 밝았는지로 정해서 부드러운 빛무리까지 살린다"""
    from PIL import Image

    tiles = []
    for x, y, r in eyes:
        x0, y0, s = int(round(x - r)), int(round(y - r)), int(round(2 * r))
        b = before[y0 : y0 + s, x0 : x0 + s, :3]
        a = after[y0 : y0 + s, x0 : x0 + s, :3]
        lb = b[:, :, 0] * 0.3 + b[:, :, 1] * 0.59 + b[:, :, 2] * 0.11
        la = a[:, :, 0] * 0.3 + a[:, :, 1] * 0.59 + a[:, :, 2] * 0.11
        alpha = np.clip((lb - la) / np.maximum(255 - la, 1), 0, 1)
        # 알파를 곱했을 때 원래 밝기가 나오도록 색을 되돌린다: before = a*(1-α) + c*α
        color = np.where(alpha[:, :, None] > 0.02, (b - a * (1 - alpha[:, :, None])) / np.maximum(alpha[:, :, None], 0.02), 255)
        tiles.append(np.dstack([np.clip(color, 0, 255), alpha * 255]))
    Image.fromarray(np.concatenate(tiles, axis=1).round().astype(np.uint8)).save(path, optimize=True)
    print(f'반사광 조각: {path}')
