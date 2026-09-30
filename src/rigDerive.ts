import type { ExpressionLayer, MorphAtlas, PhotoRig, Species } from './pets'

/**
 * 사진에서 찾는 핵심 기준점 (사진 픽셀 좌표, 좌우는 '사진 기준').
 * 나머지 부위(머리, 주둥이, 턱, 눈썹, 가슴…)는 deriveRig가 이 점들과 두 눈 사이 거리로 계산한다.
 * 비율은 손으로 맞춘 초코의 리그에서 가져왔다. 파이프라인(Node)과 기준점 편집 화면(브라우저)이 같이 쓴다.
 */
export interface Landmarks {
  species: Species
  leftEye: Pt
  rightEye: Pt
  /** 눈(홍채) 반지름 */
  eyeR: number
  nose: Pt
  noseRx: number
  noseRy: number
  mouth: Pt
  chin: Pt
  headTop: Pt
  leftEar: EarPts
  rightEar: EarPts
}

export interface Pt {
  x: number
  y: number
}

export interface EarPts {
  /** 귀가 머리에 붙은 곳 (위쪽) */
  base: Pt
  /** 귀 끝 */
  tip: Pt
  /** 얼굴 중심에서 가장 먼 귀의 점 */
  outer: Pt
}

/** 사진 파일 정보 (prepare 단계에서 나온 값) */
export interface ImageInfo {
  src: string
  flow: string
  catchlight?: string
  width: number
  height: number
  /** 불투명한 부분의 가장 아래 (발바닥/잘린 가슴선) */
  bottom: number
}

/** 표정 사진을 잘라낼 상자 (prepare-expression.py에 넘긴다) */
export interface ExpressionBoxes {
  pant: Box
  eyes: Box
  ears: Box
}

export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

const r = Math.round

/** 핵심 기준점에서 셰이더가 쓰는 리그 전체를 계산한다 (표정·움직임 아틀라스는 따로 붙인다) */
export function deriveRig(lm: Landmarks, img: ImageInfo): Omit<PhotoRig, 'expressions'> {
  const D = dist(lm.leftEye, lm.rightEye)
  const cx = lm.nose.x
  const earSpan = Math.abs(lm.rightEar.outer.x - lm.leftEar.outer.x)
  const headTop = lm.headTop.y
  const chinY = lm.chin.y
  const eyesY = (lm.leftEye.y + lm.rightEye.y) / 2

  const cat = lm.species === 'cat'
  const ear = (e: EarPts) => {
    if (cat) {
      // 고양이 귀는 짧은 세모: 세 점(붙은 곳·끝·바깥)의 가운데를 중심으로 딱 귀만큼. 크게 잡으면 귀를 까딱일 때 이마까지 출렁인다
      const cx = (e.base.x + e.tip.x + e.outer.x) / 3
      const cy = (e.base.y + e.tip.y + e.outer.y) / 3 + D * 0.08
      return {
        px: r(e.base.x + (e.outer.x - e.base.x) * 0.2),
        py: r(e.base.y + D * 0.05),
        x: r(cx),
        y: r(cy),
        rx: r(Math.max(D * 0.2, dist(e.base, e.outer) * 0.55)),
        ry: r(Math.max(D * 0.25, Math.hypot(e.tip.x - cx, e.tip.y - cy) * 1.1)),
      }
    }
    // 귀 타원: 붙은 곳과 끝의 가운데, 폭은 눈 사이의 0.41배, 길이는 붙은 곳~끝 거리에 맞춘다
    const mx = (e.base.x + e.tip.x + e.outer.x) / 3
    const my = (e.base.y + e.tip.y) / 2
    // 도는 중심은 윗부분이 붙은 곳에서 바깥쪽 끝으로 조금 옮긴 점 (귀는 머리 옆면에 붙어 있다)
    const px = e.base.x + (e.outer.x - e.base.x) * 0.25
    const py = e.base.y + (e.outer.y - e.base.y) * 0.25
    return { px: r(px), py: r(py), x: r(mx), y: r(my), rx: r(D * 0.41), ry: r(Math.max(D * 0.5, dist(e.base, e.tip) * 0.45)) }
  }
  const brow = (e: Pt) => ({ x: r(e.x), y: r(e.y - D * 0.33), rx: r(D * 0.3), ry: r(D * 0.22) })

  return {
    src: img.src,
    flow: img.flow,
    catchlight: img.catchlight,
    width: img.width,
    height: img.height,
    centerX: r(cx),
    footY: r(img.bottom),
    // 얼굴 크기가 초코와 비슷하게 보이도록: 귀 끝에서 끝까지(귀가 좁은 고양이는 두 눈 사이 거리 기준)가 펫 로컬 약 470단위.
    // 다만 사진 폭이 폰 화면 폭(펫 로컬 560)을 넘으면 몸통이 화면 밖으로 잘리므로 540단위 안으로 줄인다
    scale: +Math.min(470 / Math.max(earSpan, D * 3.2), img.width > 0 ? 540 / img.width : Infinity).toFixed(4),
    head: { x: r(cx), y: r((headTop + chinY) / 2), rx: r(earSpan * 0.51), ry: r((chinY - headTop) / 2) },
    neck: { x: r(cx), y: r(chinY + D * 0.29) },
    nose: { x: r(lm.nose.x), y: r(lm.nose.y), rx: r(lm.noseRx), ry: r(lm.noseRy) },
    nostrils: [
      { x: r(lm.nose.x - lm.noseRx * 0.43), y: r(lm.nose.y + D * 0.01), r: r(Math.max(6, lm.noseRx * 0.27)) },
      { x: r(lm.nose.x + lm.noseRx * 0.43), y: r(lm.nose.y + D * 0.01), r: r(Math.max(6, lm.noseRx * 0.27)) },
    ],
    chinY: r(lm.nose.y + lm.noseRy * 1.2),
    eyes: [lm.leftEye, lm.rightEye].map((e) => ({ x: r(e.x), y: r(e.y), r: r(lm.eyeR) })),
    ears: [ear(lm.leftEar), ear(lm.rightEar)],
    chest: { x: r(cx), y: r(chinY + D * 1.2), rx: r(D * 1.2), ry: r(D * 0.96) },
    body: { x: r(cx), y: r(chinY + D * 1.1), rx: r(D * 1.8), ry: r(D * 1.05) },
    brows: [brow(lm.leftEye), brow(lm.rightEye)],
    chin: cat
      ? { x: r(cx), y: r((lm.mouth.y + chinY) / 2), rx: r(D * 0.33), ry: r(Math.max(D * 0.12, (chinY - lm.mouth.y) * 0.8)) }
      : { x: r(cx), y: r(lm.mouth.y + D * 0.1), rx: r(D * 0.6), ry: r(D * 0.29) },
    // 고양이는 주둥이가 짧아 입체감 영역을 실제 정수리~턱, 코~턱 위치로 잡는다 (개 비율로 잡으면 가슴까지 같이 움직인다)
    skull: cat
      ? { x: r(cx), y: r((headTop + chinY) / 2 + D * 0.03), rx: r(D * 0.95), ry: r((chinY - headTop) / 2) }
      : { x: r(cx), y: r(eyesY + D * 0.32), rx: r(D * 1.05), ry: r(D * 1.09) },
    muzzle: cat
      ? { x: r(cx), y: r(lm.nose.y + (chinY - lm.nose.y) * 0.25), rx: r(D * 0.42), ry: r(Math.max(D * 0.2, (chinY - lm.nose.y) * 0.6)) }
      : { x: r(cx), y: r(lm.nose.y + D * 0.11), rx: r(D * 0.64), ry: r(D * 0.48) },
    floorShadow: false,
    fadeBottom: r(img.height * 0.185),
  }
}

/** 표정 사진을 잘라낼 상자 (사진 안으로 잘라 둔다) */
export function expressionBoxes(lm: Landmarks, img: { width: number; height: number }): ExpressionBoxes {
  const D = dist(lm.leftEye, lm.rightEye)
  const clampBox = (b: Box): Box => ({
    x0: Math.max(0, r(b.x0)),
    y0: Math.max(0, r(b.y0)),
    x1: Math.min(img.width, r(b.x1)),
    y1: Math.min(img.height, r(b.y1)),
  })
  const ex0 = Math.min(lm.leftEye.x, lm.rightEye.x)
  const ex1 = Math.max(lm.leftEye.x, lm.rightEye.x)
  // 고개가 기울면 두 눈 높이가 달라서, 위쪽 눈과 아래쪽 눈을 모두 넣는다
  const eyTop = Math.min(lm.leftEye.y, lm.rightEye.y)
  const eyBottom = Math.max(lm.leftEye.y, lm.rightEye.y)
  return {
    pant: clampBox({ x0: lm.nose.x - D * 0.83, y0: lm.nose.y - D * 0.46, x1: lm.nose.x + D * 0.83, y1: lm.chin.y + D * 0.32 }),
    eyes: clampBox({ x0: ex0 - D * 0.35, y0: eyTop - D * 0.36, x1: ex1 + D * 0.35, y1: eyBottom + D * 0.32 }),
    ears: clampBox({ x0: 0, y0: 0, x1: img.width, y1: lm.chin.y + D * 0.03 }),
  }
}

/** 표정 레이어 (상자와 섞을 부위). 단계 수는 2 (중간 → 최종) */
export function expressionLayers(
  lm: Landmarks,
  boxes: ExpressionBoxes,
  srcs: { pant: string; eyes: string; ears: string },
  earsFill: [number, number, number],
): { pant: ExpressionLayer; eyesClosed: ExpressionLayer; earsBack: ExpressionLayer } {
  const D = dist(lm.leftEye, lm.rightEye)
  const cx = lm.nose.x
  const box = (b: Box) => ({ x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0, frames: 2 })
  const rig = deriveRig(lm, { src: '', flow: '', width: 0, height: 0, bottom: 0 })
  return {
    pant: {
      src: srcs.pant,
      ...box(boxes.pant),
      mask: [{ x: r(cx), y: r((lm.nose.y + lm.chin.y) / 2 + D * 0.03), rx: r(D * 0.8), ry: r(D * 0.65) }],
    },
    eyesClosed: {
      src: srcs.eyes,
      ...box(boxes.eyes),
      mask: [lm.leftEye, lm.rightEye].map((e) => ({ x: r(e.x), y: r(e.y - D * 0.02), rx: r(D * 0.32), ry: r(D * 0.3) })),
    },
    earsBack: {
      src: srcs.ears,
      ...box(boxes.ears),
      fill: earsFill,
      // 원래 귀 끝까지 마스크의 완전히 덮이는 안쪽(70%)에 들어오게 넉넉히 잡는다. 아니면 옛 귀 윤곽이 비친다
      mask: rig.ears.map((e) =>
        lm.species === 'cat'
          ? { x: r(e.x), y: r(e.y + D * 0.05), rx: r(e.rx * 2.3), ry: r(e.ry * 2.1) }
          : { x: r(e.x + (e.x < cx ? -1 : 1) * D * 0.05), y: r(e.y - D * 0.1), rx: r(e.rx * 2), ry: r(e.ry * 1.8) },
      ),
    },
  }
}

export function dist(a: Pt, b: Pt) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** 움직임 아틀라스 칸 위치는 prepare-morph.py가 출력한 값을 그대로 쓴다 */
export type { MorphAtlas }
