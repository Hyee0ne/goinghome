/**
 * 공유 영상 위에 얹는 그림: 처음부터 작은 워터마크, 마지막 1초는 끝 장면
 * (우리 아이: '너도 쓰다듬어 볼래?' / 보호소 아이: '가족을 기다려요' + 주소).
 * featured가 있으면 끝 장면 가운데에 실제 보호소 아이(실사화한 아이, 우리 사이트 사진)를 크게 보여 준다.
 * 다른 사이트 사진은 녹화 캔버스에 그리면 녹화가 막혀서 쓰지 않는다.
 * recorder.record의 overlay로 넘긴다. 녹화 캔버스는 9:16 세로(720×1280 기준)다.
 *
 * 세이프존 (릴스·쇼츠·틱톡·스토리): 위 약 15%, 아래 약 35%, 오른쪽 약 15%는 앱 UI가 덮는다.
 * 워터마크와 끝 장면 글자·주소는 그 밖(위 15%~아래 65%, 왼쪽 8%~오른쪽 85%)에 둔다.
 * 워터마크에는 '고잉홈 + 주소'를 넣어 스크린샷·재공유로 퍼져도 출처가 남게 한다 (주소는 src/site.ts).
 */
import { josa, type PetProfile } from './pets'
import { SITE_LABEL } from './site'

const FONT = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`
/** 끝 장면 길이 (초). 엔드카드는 짧게: 1초 안팎 */
const END = 1
/** 안전한 영역 (비율) */
const SAFE_TOP = 0.15
const SAFE_BOTTOM = 0.65
/** 오른쪽 15%를 피해 글자 가운데를 살짝 왼쪽으로 */
const CENTER_X = (0.08 + 0.85) / 2

export interface Featured {
  img: HTMLImageElement
  /** 품종 · 지역 (공유물에는 공고 마감일을 넣지 않는다, 2026-10-06) */
  line: string
}

export function clipOverlay(p: PetProfile, mine: boolean, seconds: number, featured?: Featured) {
  return (g: CanvasRenderingContext2D, w: number, h: number, t: number) => {
    const u = w / 720
    const cx = w * CENTER_X
    // 워터마크 (위쪽 세이프존 바로 아래, 가운데, 작게)
    g.save()
    g.font = `700 ${22 * u}px ${FONT}`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    const label = `🏠 고잉홈 · ${SITE_LABEL}`
    const tw = g.measureText(label).width
    const y = h * SAFE_TOP + 26 * u
    g.fillStyle = 'rgba(255, 255, 255, 0.82)'
    roundRect(g, cx - tw / 2 - 16 * u, y - 20 * u, tw + 32 * u, 40 * u, 20 * u)
    g.fill()
    g.fillStyle = '#4a3322'
    g.fillText(label, cx, y + 1 * u)
    g.restore()

    // 끝 장면: 크림색으로 덮으며 문구
    const k = Math.min(1, Math.max(0, (t - (seconds - END)) / 0.25))
    if (k <= 0) return
    g.save()
    g.globalAlpha = k
    g.fillStyle = 'rgba(255, 244, 230, 0.95)'
    g.fillRect(0, 0, w, h)
    g.textAlign = 'center'
    g.textBaseline = 'alphabetic'
    if (featured) featuredCard(g, h, u, cx, p, mine, featured)
    else plainCard(g, h, u, cx, p, mine)
    g.restore()
  }
}

/** 끝 장면 (보호소 아이 사진이 없을 때): 두 줄 문구 + 한 줄 + 주소 */
function plainCard(g: CanvasRenderingContext2D, h: number, u: number, cx: number, p: PetProfile, mine: boolean) {
  g.fillStyle = '#4a3322'
  g.font = `800 ${50 * u}px ${FONT}`
  const lines = mine ? [`우리 ${p.name},`, '손끝으로 쓰다듬었어요'] : [`${josa(p.name, '이', '가')}`, '가족을 기다려요']
  const top = h * 0.3
  lines.forEach((l, i) => g.fillText(l, cx, top + i * 64 * u))
  g.font = `600 ${30 * u}px ${FONT}`
  g.fillStyle = '#8a6e58'
  g.fillText(mine ? '너도 쓰다듬어 볼래?' : '보호소에 입양 문의할 수 있어요', cx, top + 150 * u)
  addressPill(g, u, cx, h * SAFE_BOTTOM - 130 * u)
}

/** 끝 장면: 위에 한 줄, 가운데 보호소 아이 사진, 아래 '가족을 기다려요'와 주소 (모두 세이프존 안) */
function featuredCard(g: CanvasRenderingContext2D, h: number, u: number, cx: number, p: PetProfile, mine: boolean, f: Featured) {
  g.fillStyle = '#4a3322'
  g.font = `800 ${36 * u}px ${FONT}`
  g.fillText(mine ? `우리 ${p.name}, 손끝으로 쓰다듬었어요` : `${josa(p.name, '이', '가')} 가족을 기다려요`, cx, h * SAFE_TOP + 100 * u)
  // 사진: 둥근 네모 안에 꽉 차게
  // 우리 아이 공유는 글이 한 줄 더 있어 사진을 조금 줄인다 (주소가 아래 세이프존을 넘지 않게)
  const s = (mine ? 250 : 300) * u
  const x = cx - s / 2
  const y = h * SAFE_TOP + 130 * u
  g.save()
  roundRect(g, x, y, s, s, 32 * u)
  g.fillStyle = '#fff'
  g.fill()
  g.clip()
  const iw = f.img.naturalWidth
  const ih = f.img.naturalHeight
  const k = Math.max(s / iw, s / ih)
  g.drawImage(f.img, x + (s - iw * k) / 2, y + (s - ih * k) * 0.3, iw * k, ih * k)
  g.restore()
  let ty = y + s + 50 * u
  g.fillStyle = '#4a3322'
  g.font = `800 ${34 * u}px ${FONT}`
  if (mine) {
    g.fillText('이 아이도 가족을 기다려요', cx, ty)
    ty += 42 * u
  }
  g.font = `600 ${26 * u}px ${FONT}`
  g.fillStyle = '#8a6e58'
  g.fillText(f.line, cx, ty)
  addressPill(g, u, cx, Math.max(ty + 30 * u, h * SAFE_BOTTOM - 130 * u))
}

/** 주소 알약 + '링크를 눌러 손끝으로 만나 보세요' (y: 알약 위 끝) */
function addressPill(g: CanvasRenderingContext2D, u: number, cx: number, y: number) {
  g.font = `700 ${28 * u}px ${FONT}`
  const pw = g.measureText(SITE_LABEL).width + 52 * u
  g.fillStyle = '#ff8a3d'
  roundRect(g, cx - pw / 2, y, pw, 58 * u, 29 * u)
  g.fill()
  g.fillStyle = '#fff'
  g.fillText(SITE_LABEL, cx, y + 39 * u)
  g.font = `500 ${22 * u}px ${FONT}`
  g.fillStyle = '#8a6e58'
  g.fillText('링크를 눌러 손끝으로 만나 보세요 👆', cx, y + 90 * u)
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath()
  g.roundRect(x, y, w, h, r)
}
