/**
 * 닮은 친구 공유 포스터 (D안, 2026-10-06): 정사각 카드(1080×1080)를 기기 안 캔버스로 그린다.
 * [제목 두 줄] [우리 아이 문 | 닮은 친구 문] [이름표] [고잉홈 · 주소]. 사진은 모두 원본을 아치문 모양으로 자른다.
 * 우리 아이 사진은 사용자가 공유를 누를 때만 이 카드로 나간다 (서버로 보내지 않는다).
 * 공고 사진은 다른 사이트라 캔버스가 막히므로 우리 주소(/animal-photo, vite 프록시·vercel rewrites)를 거쳐 받는다.
 */
import { SITE_LABEL } from './site'

const SIZE = 1080
const FONT = `"Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Noto Sans KR", system-ui, sans-serif`
const INK = '#12183a'
const SOFT = '#5b6283'
const BLUE = '#2a45c9'
const PHOTO_HOST = 'https://openapi.animal.go.kr/openapi/service/rest/fileDownloadSrvc/files/'

/** 공고 사진 주소 → 우리 주소를 거치는 같은 출처 주소 */
export function sameOriginPhoto(url: string) {
  return url.startsWith(PHOTO_HOST) ? `${import.meta.env.BASE_URL}animal-photo/${url.slice(PHOTO_HOST.length)}` : url
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`사진을 불러오지 못했어요: ${src}`))
    img.src = src
  })
}

/** 아치문 모양 (위는 반원, 아래는 살짝 둥근 네모) */
function archPath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath()
  g.moveTo(x, y + w / 2)
  g.arc(x + w / 2, y + w / 2, w / 2, Math.PI, 0)
  g.lineTo(x + w, y + h - r)
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  g.lineTo(x + r, y + h)
  g.quadraticCurveTo(x, y + h, x, y + h - r)
  g.closePath()
}

/** 문 안에 사진을 꽉 차게 (위쪽 30% 기준으로 잘라 얼굴이 보이게) */
function drawDoor(g: CanvasRenderingContext2D, img: HTMLImageElement | null, x: number, y: number, w: number, h: number, bg: string) {
  g.save()
  archPath(g, x, y, w, h, 28)
  g.fillStyle = bg
  g.fill()
  g.clip()
  if (img) {
    const k = Math.max(w / img.naturalWidth, h / img.naturalHeight)
    const iw = img.naturalWidth * k
    const ih = img.naturalHeight * k
    g.drawImage(img, x + (w - iw) / 2, y + (h - ih) * 0.3, iw, ih)
  }
  g.restore()
}

export interface CardInput {
  /** 우리 아이 사진 (blob: 주소) */
  mine: string
  mineName: string
  /** 제목에 쓰는 '삼식이랑' (조사까지) */
  who: string
  /** 닮은 친구 공고 사진 (원래 주소) */
  friend: string
  friendKind: string
  friendWhere: string
}

/** 카드를 그려 PNG Blob으로 돌려준다 */
export async function drawShareCard(c: CardInput): Promise<Blob> {
  await document.fonts?.load(`700 64px ${FONT}`).catch(() => {})
  const [mine, friend, logo] = await Promise.all([
    loadImage(c.mine).catch(() => null),
    loadImage(sameOriginPhoto(c.friend)).catch(() => null),
    loadImage(`${import.meta.env.BASE_URL}logo-goinghome.png`).catch(() => null),
  ])
  const canvas = Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE })
  const g = canvas.getContext('2d')!
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, SIZE, SIZE)

  const pad = 84
  // 제목 두 줄 (둘째 줄은 코발트)
  g.textBaseline = 'alphabetic'
  g.fillStyle = INK
  g.font = `700 58px ${FONT}`
  g.fillText(`${c.who} 꼭 닮은 친구가`, pad, 150)
  g.fillStyle = BLUE
  g.fillText('보호소에서 가족을 기다려요', pad, 228)

  // 문 두 개
  const gap = 36
  const w = (SIZE - pad * 2 - gap) / 2
  const h = w * 1.18
  const top = 290
  drawDoor(g, mine, pad, top, w, h, '#ffd3dc')
  drawDoor(g, friend, pad + w + gap, top, w, h, '#dde4ff')

  // 이름표
  g.textAlign = 'center'
  const label = (x: number, name: string, sub: string) => {
    g.fillStyle = INK
    g.font = `700 34px ${FONT}`
    g.fillText(name, x, top + h + 52)
    g.fillStyle = SOFT
    g.font = `500 26px ${FONT}`
    g.fillText(sub, x, top + h + 90)
  }
  label(pad + w / 2, c.mineName, '우리 집')
  label(pad + w + gap + w / 2, c.friendKind, c.friendWhere)

  // 아래: 고잉홈 로고 · 주소
  g.textAlign = 'left'
  const by = SIZE - 70
  if (logo) {
    const lh = 46
    g.drawImage(logo, pad, by - lh + 10, (logo.naturalWidth / logo.naturalHeight) * lh, lh)
  }
  g.textAlign = 'right'
  g.fillStyle = SOFT
  g.font = `500 28px ${FONT}`
  g.fillText(SITE_LABEL, SIZE - pad, by)

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('카드를 만들지 못했어요'))), 'image/png'))
}
