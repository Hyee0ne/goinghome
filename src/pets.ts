export type Species = 'dog' | 'cat'
export type Zone = 'head' | 'chin' | 'body'

export interface PetProfile {
  id: string
  name: string
  species: Species
  breed: string
  age: string
  sex: string
  story: string
  /** 교감 방법 힌트 (프로필 카드에 표시) */
  tip: string
  /** 특히 좋아하는 부위: 마음이 두 배로 빨리 열린다 */
  favorite: Zone
  /** 겁이 많은 아이는 먼저 손 냄새를 맡게 해줘야 쓰다듬을 수 있다 */
  shy: boolean
  fur: string
  furDark: string
  belly: string
  eye: string
  pattern: 'none' | 'tabby' | 'patch'
  /** 털색 글 (공고 아이: 공고의 색상, 닮은 아이 찾기용) */
  coat?: string
  /** 아이 정보 화면의 사진 슬라이드 (public/ 기준 경로 또는 전체 주소). 없으면 실사 얼굴 사진 한 장 */
  photos?: string[]
  /** '손' 개인기를 할 줄 아는지 (강아지만. 고양이는 이 값을 무시한다 → canGivePaw) */
  canPaw?: boolean
  /** 아이 정보 화면의 성격 태그 */
  traits?: string[]
  /** 보호·입양 정보 (아이 정보 화면). 실제 공고와 연결되기 전에는 sample: true */
  adoption?: Adoption
  /** 실사 사진 리그. 있으면 WebGL 털 셰이더로 그리고, 없거나 WebGL을 못 쓰면 캔버스 그림으로 그린다 */
  photo?: PhotoRig
}

export interface Adoption {
  shelter: string
  region: string
  noticeNo?: string
  /** 포인핸드 공고 주소. 없으면 포인핸드 첫 화면으로 보낸다 */
  url?: string
  /** 가상의 아이라 실제 공고가 없다 */
  sample?: boolean
  /** 보호소 전화 (공고 아이: 전화로 입양 문의) */
  tel?: string
  /** 공고 종료일 YYYYMMDD */
  noticeEnd?: string
  /** 보호소 공고 사진으로 실사화한 모습 (출처를 밝힌다) */
  fromShelterPhoto?: boolean
}

export const PAWINHAND_URL = 'https://pawinhand.kr'

/** '손' 개인기를 보여 줄 수 있는 아이: 체크된 강아지만 (고양이는 선택지 자체가 없다) */
export function canGivePaw(p: PetProfile) {
  return p.species === 'dog' && !!p.canPaw
}

interface Ellipse {
  x: number
  y: number
  rx: number
  ry: number
}

/**
 * 사진 위 기준점. 좌표는 모두 사진 픽셀 단위다 (scripts/prepare-pet.py가 잘라낸 뒤의 이미지 기준).
 * 셰이더는 이 값으로 눈꺼풀, 머리 기울임, 귀, 숨쉬기 영역을 잡고, 게임 로직은 쓰다듬는 부위 판정에 쓴다.
 */
export interface PhotoRig {
  src: string
  flow: string
  width: number
  height: number
  /** 몸의 좌우 중심선과 발바닥 선. 펫 로컬 좌표의 (0, FLOOR_Y)에 맞춰 놓는다 */
  centerX: number
  footY: number
  /** 사진 1픽셀이 펫 로컬 몇 단위인지 */
  scale: number
  /** 쓰다듬기 판정용 머리 영역 (귀 포함) */
  head: Ellipse
  /** 머리가 기울 때 도는 중심 (목) */
  neck: { x: number; y: number }
  nose: Ellipse
  /**
   * 눈의 반사광 조각 (prepare-pet.py --eyes가 사진에서 떼어 낸 것. 눈마다 eyes의 지름 크기 한 칸, 가로로 나란히).
   * 사진에서는 지우고 셰이더가 조명 기준 고정 위치에 다시 얹는다. 그래서 눈동자가 움직여도 반사광은 제자리에 있다
   */
  catchlight?: string
  /** 콧구멍 (킁킁댈 때 벌름거린다) */
  nostrils: { x: number; y: number; r: number }[]
  /** 이 선보다 아래쪽 얼굴은 턱 밑으로 본다 */
  chinY: number
  eyes: { x: number; y: number; r: number }[]
  /** 귀는 붙은 곳(pivot)을 중심으로 흔든다 */
  ears: (Ellipse & { px: number; py: number })[]
  chest: Ellipse
  body: Ellipse
  /** 눈썹 (눈 위 무늬). 손이 다가오면 올라간다 */
  brows: Ellipse[]
  /** 아래턱. 턱 밑을 긁어주면 들어 올린다 */
  chin: Ellipse
  /**
   * 얼굴 입체감(깊이). 고개를 돌리거나 들 때 앞으로 튀어나온 부분일수록 많이 움직인다.
   * skull: 귀를 뺀 머리통, muzzle: 주둥이 (코끝이 가장 앞)
   */
  skull: Ellipse
  muzzle: Ellipse
  /** 같은 자세에서 표정만 바꾼 사진들. 부위(mask) 안에서만 원본 위에 섞는다 */
  expressions?: {
    /** 입 벌리고 헥헥 (기분이 좋을 때) */
    pant?: ExpressionLayer
    /** 눈 감기 (깜빡임, 쓰다듬을 때 지그시). 위에서부터 눈꺼풀이 내려오듯 섞는다 */
    eyesClosed?: ExpressionLayer
    /** 귀 뒤로 젖히기 (놀람, 경계) */
    earsBack?: ExpressionLayer
    /** 단계 사이의 움직임 아틀라스. 있으면 표정이 섞이는 대신 움직여서 바뀐다 */
    morph?: MorphAtlas
  }
  /**
   * 손 주기에 쓰는 앞발 층: 같은 사진을 '앞발을 카메라 쪽으로 든 모습'으로 편집해 다리와 발만 잘라 낸 것 (정면 시점).
   * x/y/width/height: 층이 놓이는 자리 (사진 좌표). 어깨 쪽은 몸에 섞이도록 서서히 투명하다.
   * shoulder: 다리가 몸에 붙은 곳 (들어 올리고 기울이는 축), pad: 발바닥 가운데. 사진 오른쪽 다리 기준
   */
  paw?: { src: string; x: number; y: number; width: number; height: number; shoulder: { x: number; y: number }; pad: { x: number; y: number } }
  /** 전신 사진이면 발밑에 그림자를 깐다. 얼굴 클로즈업처럼 아래가 잘린 사진은 false */
  floorShadow: boolean
  /** 츄르를 핥아 먹는 고양이 (입 표정 사진이 '혀로 핥기'). 간식이 츄르 스틱으로 그려지고 날름날름 핥는다 */
  lick?: boolean
  /** 기준점을 자동으로 잡았는지 (보호소 아이). 표정 사진이 있어도 앱은 차분한(SAFE) 움직임으로 그린다 */
  autoLandmarks?: boolean
  /** 사진 아래쪽을 이 높이(픽셀)만큼 배경으로 서서히 사라지게 한다 (잘린 가슴선을 숨긴다) */
  fadeBottom: number
  /** 얼굴 위주로 자르다 몸통 옆면이 잘렸으면, 그 경계(사진 x좌표)부터 안쪽으로 서서히 사라지게 한다 */
  fadeSides?: { left?: number; right?: number }
}

/**
 * 표정 사진. 용량을 아끼려고 필요한 부위만 잘라 두고, 원본 사진 위 (x, y)에 놓는다.
 * 표정 단계(중간 → 최종)를 세로로 쌓은 한 장이다. 원본 → 중간 → 최종 순서로 이웃한 것끼리만 섞어 전환이 자연스럽다
 */
export interface ExpressionLayer {
  src: string
  x: number
  y: number
  width: number
  height: number
  /** 쌓인 단계 수 */
  frames: number
  /** 윤곽이 바뀌는 부위(귀)에서 두 윤곽 사이 빈틈을 채울 털 색 (0~1) */
  fill?: [number, number, number]
  /** 섞을 부위 (원본 사진 픽셀 좌표, 여러 타원의 합). 가장자리는 부드럽게 풀린다 */
  mask: Ellipse[]
}

/**
 * 표정 단계 사이의 움직임(옵티컬 플로우) 아틀라스 (scripts/prepare-morph.py가 만들고 칸 위치를 출력한다).
 * 칸 위치는 아틀라스 안의 [x, y, w, h] (0~1). 부위마다 0: 원본→중간, 1: 중간→최종
 */
export interface MorphAtlas {
  src: string
  /** 움직임을 담은 최대 거리 (픽셀) */
  range: number
  sdfRange: number
  /** 입 칸은 없을 수 있다 (고양이는 입 표정이 없다) */
  rects: Partial<Record<'pant0' | 'pant1', [number, number, number, number]>> &
    Record<'eyes0' | 'eyes1' | 'ears0' | 'ears1' | 'earsSdf', [number, number, number, number]>
}

/** 펫 로컬 좌표에서 바닥(발바닥) 높이 */
export const FLOOR_Y = 250

/** 게임 로직이 쓰는 부위 배치 (펫 로컬 좌표) */
export interface Layout {
  headY: number
  headRx: number
  headRy: number
  /** 머리 중심에서 이만큼 아래부터 턱 밑 */
  chinDy: number
  chinDx: number
  noseY: number
  /** 입 (간식을 받아먹는 자리). 사진이면 턱 부위 가운데 = 입이 벌어지는 곳 */
  mouthY: number
  bodyY: number
  bodyRx: number
  bodyRy: number
}

export function photoToLocal(rig: PhotoRig, x: number, y: number) {
  return { x: (x - rig.centerX) * rig.scale, y: (y - rig.footY) * rig.scale + FLOOR_Y }
}

export function layoutOf(p: PetProfile): Layout {
  const rig = p.photo
  if (!rig) {
    // 캔버스 그림의 배치 (pet.ts의 그리기 좌표와 같다)
    return {
      headY: -125,
      headRx: 135,
      headRy: 125,
      chinDy: 35,
      chinDx: 90,
      noseY: -125 + (p.species === 'cat' ? 26 : 18),
      mouthY: -125 + (p.species === 'cat' ? 50 : 45),
      bodyY: 100,
      bodyRx: 125,
      bodyRy: 140,
    }
  }
  const s = rig.scale
  const head = photoToLocal(rig, rig.head.x, rig.head.y)
  const body = photoToLocal(rig, rig.body.x, rig.body.y)
  return {
    headY: head.y,
    headRx: rig.head.rx * s,
    headRy: rig.head.ry * s,
    chinDy: (rig.chinY - rig.head.y) * s,
    chinDx: rig.nose.rx * 2.2 * s,
    noseY: photoToLocal(rig, rig.nose.x, rig.nose.y).y,
    mouthY: photoToLocal(rig, rig.chin.x, rig.chin.y).y,
    bodyY: body.y,
    bodyRx: rig.body.rx * s,
    bodyRy: rig.body.ry * s,
  }
}

const BASE = import.meta.env.BASE_URL

/** 가상의 보호 동물. 추후 포인핸드 공고 데이터로 교체할 자리. */
export const PETS: PetProfile[] = [
  {
    id: 'choco',
    name: '초코',
    species: 'dog',
    breed: '믹스견',
    age: '3살 추정',
    sex: '남아',
    story: '비 오는 날 공원 벤치 아래에서 구조됐어요. 사람 손을 아직 조금 무서워해요.',
    tip: '먼저 코 앞에 손바닥을 가만히 내밀어 냄새를 맡게 해주세요.',
    favorite: 'head',
    shy: true,
    canPaw: true,
    traits: ['낯을 가려요', '친해지면 애교쟁이', '산책 좋아해요'],
    photos: ['gallery/choco/1.webp', 'gallery/choco/2.webp', 'gallery/choco/3.webp', 'gallery/choco/4.webp'],
    adoption: { shelter: '마포구 동물보호센터', region: '서울 마포구', noticeNo: '서울-마포-2026-00123', sample: true },
    fur: '#9a6a44',
    furDark: '#6e4a2e',
    belly: '#f1dcc3',
    eye: '#2b1d14',
    pattern: 'patch',
    photo: {
      src: `${BASE}pets/choco-face.webp`,
      flow: `${BASE}pets/choco-face-flow.png`,
      width: 1134,
      height: 1382,
      centerX: 575,
      footY: 1382,
      scale: 0.44,
      head: { x: 575, y: 390, rx: 545, ry: 360 },
      neck: { x: 575, y: 840 },
      nose: { x: 575, y: 565, rx: 81, ry: 66 },
      catchlight: `${BASE}pets/choco-face-catch.png`,
      paw: { src: `${BASE}pets/choco-paw.webp`, x: 612, y: 848, width: 426, height: 477, shoulder: { x: 974, y: 840 }, pad: { x: 814, y: 1210 } },
      nostrils: [
        { x: 540, y: 567, r: 22 },
        { x: 610, y: 567, r: 22 },
      ],
      chinY: 640,
      eyes: [
        { x: 425, y: 329, r: 34 },
        { x: 738, y: 333, r: 34 },
      ],
      ears: [
        { px: 285, py: 143, x: 165, y: 360, rx: 128, ry: 225 },
        { px: 855, py: 143, x: 983, y: 360, rx: 128, ry: 225 },
      ],
      chest: { x: 575, y: 1125, rx: 375, ry: 300 },
      body: { x: 575, y: 1100, rx: 560, ry: 330 },
      brows: [
        { x: 400, y: 225, rx: 95, ry: 70 },
        { x: 720, y: 225, rx: 95, ry: 70 },
      ],
      chin: { x: 575, y: 705, rx: 190, ry: 90 },
      skull: { x: 575, y: 430, rx: 330, ry: 340 },
      muzzle: { x: 575, y: 600, rx: 200, ry: 150 },
      // 같은 사진을 편집해 만든 표정들 (scripts/prepare-expression.py)
      expressions: {
        pant: {
          src: `${BASE}pets/choco-face-pant.webp`,
          ...{ x: 309, y: 420, width: 520, height: 430, frames: 2 },
          mask: [{ x: 569, y: 635, rx: 250, ry: 205 }],
        },
        eyesClosed: {
          src: `${BASE}pets/choco-face-eyes.webp`,
          ...{ x: 315, y: 217, width: 533, height: 214, frames: 2 },
          mask: [
            { x: 425, y: 322, rx: 100, ry: 95 },
            { x: 738, y: 326, rx: 100, ry: 95 },
          ],
        },
        earsBack: {
          src: `${BASE}pets/choco-face-ears.webp`,
          ...{ x: 0, y: 0, width: 1134, height: 760, frames: 2 },
          fill: [0.483, 0.299, 0.202],
          // 원래 귀 끝까지 마스크의 완전히 덮이는 안쪽(70%)에 들어오게 넉넉히 잡는다. 아니면 옛 귀 윤곽이 비친다
          mask: [
            { x: 150, y: 330, rx: 260, ry: 400 },
            { x: 1008, y: 330, rx: 260, ry: 400 },
          ],
        },
        morph: {
          src: `${BASE}pets/choco-face-morph.png`,
          range: 128,
          sdfRange: 48,
          rects: {
            pant0: [0, 0, 0.45844, 0.12019],
            pant1: [0, 0.12019, 0.45844, 0.12019],
            eyes0: [0, 0.24038, 0.46977, 0.0601],
            eyes1: [0, 0.30048, 0.46977, 0.0601],
            ears0: [0, 0.36058, 1, 0.21314],
            ears1: [0, 0.57372, 1, 0.21314],
            earsSdf: [0, 0.78686, 0.5, 0.21314],
          },
        },
      },
      floorShadow: false,
      fadeBottom: 260,
    },
  },
]

/**
 * 사진 파이프라인(npm run pet:add)이 만든 아이들. src/rigs/<id>.json 하나에 프로필과 실사 리그가 들어 있다.
 * 사진 경로는 public/ 기준 상대 경로로 저장되어 있어 여기서 BASE_URL을 붙인다.
 * 같은 id가 위 목록에 있으면 그 프로필은 두고 실사 리그만 붙인다.
 */
export interface GeneratedPet {
  profile: Omit<PetProfile, 'photo'>
  rig: PhotoRig
}

const generated = import.meta.glob<GeneratedPet>('./rigs/*.json', { eager: true, import: 'default' })

function withBase(rig: PhotoRig): PhotoRig {
  const u = (path: string) => (/^(https?:)?\//.test(path) ? path : `${BASE}${path}`)
  const ex = rig.expressions
  return {
    ...rig,
    src: u(rig.src),
    flow: u(rig.flow),
    catchlight: rig.catchlight && u(rig.catchlight),
    expressions: ex && {
      pant: ex.pant && { ...ex.pant, src: u(ex.pant.src) },
      eyesClosed: ex.eyesClosed && { ...ex.eyesClosed, src: u(ex.eyesClosed.src) },
      earsBack: ex.earsBack && { ...ex.earsBack, src: u(ex.earsBack.src) },
      morph: ex.morph && { ...ex.morph, src: u(ex.morph.src) },
    },
  }
}

for (const g of Object.values(generated)) {
  const known = PETS.find((p) => p.id === g.profile.id)
  if (known) known.photo = withBase(g.rig)
  else PETS.push({ ...g.profile, photo: withBase(g.rig) })
}

/** 사진 경로에 BASE_URL을 붙인다 (전체 주소나 이미 /로 시작하면 그대로) */
export function assetUrl(path: string) {
  return /^(https?:)?\//.test(path) ? path : `${BASE}${path}`
}

/** 받침 유무에 따라 조사를 고른다: josa('초코', '이', '가') → '초코가' */
export function josa(word: string, withBatchim: string, without: string) {
  const code = word.charCodeAt(word.length - 1) - 0xac00
  const has = code >= 0 && code <= 11171 && code % 28 !== 0
  return word + (has ? withBatchim : without)
}
