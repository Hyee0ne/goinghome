/**
 * 공유 영상 위에 얹는 그림: 처음부터 작은 워터마크, 마지막 1.4초는 끝 장면
 * (우리 아이: '너도 만들어 봐' / 보호소 아이: '가족을 기다려요' + 입양 사이트).
 * featured가 있으면 끝 장면 가운데에 실제 보호소 아이(실사화한 아이, 우리 사이트 사진)를 크게 보여 준다.
 * 다른 사이트 사진은 녹화 캔버스에 그리면 녹화가 막혀서 쓰지 않는다.
 * recorder.record의 overlay로 넘긴다. 녹화 캔버스 좌표(720×960 기준)로 그린다.
 */
import { josa, type PetProfile } from './pets'

const FONT = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`
const END = 1.4

export interface Featured {
  img: HTMLImageElement
  /** 품종 · 지역 */
  line: string
  /** 공고 마감 (예: '10월 13일까지') */
  due?: string
}

export function clipOverlay(p: PetProfile, mine: boolean, seconds: number, host: string, featured?: Featured) {
  return (g: CanvasRenderingContext2D, w: number, h: number, t: number) => {
    const u = w / 720
    // 워터마크 (왼쪽 아래)
    g.save()
    g.font = `700 ${26 * u}px ${FONT}`
    g.textBaseline = 'alphabetic'
    const label = '🐾 손끝 교감'
    const tw = g.measureText(label).width
    g.fillStyle = 'rgba(255, 255, 255, 0.85)'
    roundRect(g, 24 * u, h - 76 * u, tw + 32 * u, 50 * u, 25 * u)
    g.fill()
    g.fillStyle = '#4a3322'
    g.fillText(label, 40 * u, h - 42 * u)
    g.restore()

    // 끝 장면: 크림색으로 덮으며 문구
    const k = Math.min(1, Math.max(0, (t - (seconds - END)) / 0.35))
    if (k <= 0) return
    g.save()
    g.globalAlpha = k
    g.fillStyle = 'rgba(255, 244, 230, 0.94)'
    g.fillRect(0, 0, w, h)
    g.textAlign = 'center'
    if (featured) {
      featuredCard(g, w, h, u, p, mine, host, featured)
      g.restore()
      return
    }
    g.fillStyle = '#4a3322'
    g.font = `800 ${50 * u}px ${FONT}`
    const lines = mine ? [`우리 ${p.name},`, '손끝으로 쓰다듬었어요'] : [`${josa(p.name, '이', '가')}`, '가족을 기다려요']
    lines.forEach((l, i) => g.fillText(l, w / 2, h * 0.38 + i * 64 * u))
    g.font = `600 ${30 * u}px ${FONT}`
    g.fillStyle = '#8a6e58'
    g.fillText(mine ? '너도 우리 아이 사진으로 만들어 봐' : '포인핸드에서 입양 문의할 수 있어요', w / 2, h * 0.38 + 150 * u)
    // 주소 알약
    g.font = `700 ${30 * u}px ${FONT}`
    const pill = host
    const pw = g.measureText(pill).width + 56 * u
    g.fillStyle = '#ff8a3d'
    roundRect(g, (w - pw) / 2, h * 0.62, pw, 64 * u, 32 * u)
    g.fill()
    g.fillStyle = '#fff'
    g.fillText(pill, w / 2, h * 0.62 + 43 * u)
    g.font = `500 ${24 * u}px ${FONT}`
    g.fillStyle = '#8a6e58'
    g.fillText('가족을 기다리는 아이들 · 포인핸드 · 국가동물보호정보시스템', w / 2, h * 0.62 + 120 * u)
    g.restore()
  }
}

/** 끝 장면: 위에 한 줄, 가운데 보호소 아이 사진, 아래 '가족을 기다려요'와 주소 */
function featuredCard(g: CanvasRenderingContext2D, w: number, h: number, u: number, p: PetProfile, mine: boolean, host: string, f: Featured) {
  g.fillStyle = '#4a3322'
  g.font = `800 ${38 * u}px ${FONT}`
  g.fillText(mine ? `우리 ${p.name}, 손끝으로 쓰다듬었어요` : `${josa(p.name, '이', '가')} 가족을 기다려요`, w / 2, h * 0.12)
  // 사진: 둥근 네모 안에 꽉 차게
  const s = 380 * u
  const x = (w - s) / 2
  const y = h * 0.17
  g.save()
  roundRect(g, x, y, s, s, 36 * u)
  g.fillStyle = '#fff'
  g.fill()
  g.clip()
  const iw = f.img.naturalWidth
  const ih = f.img.naturalHeight
  const k = Math.max(s / iw, s / ih)
  g.drawImage(f.img, x + (s - iw * k) / 2, y + (s - ih * k) * 0.3, iw * k, ih * k)
  g.restore()
  let ty = y + s + 60 * u
  g.fillStyle = '#4a3322'
  g.font = `800 ${40 * u}px ${FONT}`
  if (mine) {
    g.fillText('이 아이도 가족을 기다려요', w / 2, ty)
    ty += 48 * u
  }
  g.font = `600 ${28 * u}px ${FONT}`
  g.fillStyle = '#8a6e58'
  g.fillText(f.line, w / 2, ty)
  if (f.due) {
    ty += 42 * u
    g.fillStyle = '#e5484d'
    g.font = `700 ${28 * u}px ${FONT}`
    g.fillText(`${f.due} 가족을 찾아요`, w / 2, ty)
  }
  // 주소 알약
  g.font = `700 ${30 * u}px ${FONT}`
  const pw = g.measureText(host).width + 56 * u
  const py = h - 150 * u
  g.fillStyle = '#ff8a3d'
  roundRect(g, (w - pw) / 2, py, pw, 64 * u, 32 * u)
  g.fill()
  g.fillStyle = '#fff'
  g.fillText(host, w / 2, py + 43 * u)
  g.font = `500 ${24 * u}px ${FONT}`
  g.fillStyle = '#8a6e58'
  g.fillText('눌러서 이 아이를 쓰다듬어 보세요', w / 2, py + 100 * u)
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath()
  g.roundRect(x, y, w, h, r)
}
