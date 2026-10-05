/**
 * 무대 옆 간식 접시. 손끝을 모아(집은 손) 접시에서 간식을 집어 아이 입 앞으로 끌어온다.
 *
 * 매 프레임 루프에서 부르는 것(hit, setHover)은 DOM을 읽지 않는다: 접시 위치는 크기가 바뀔 때만 재서 둔다.
 * 좌표는 main.ts의 handViews와 같은 무대 좌표 (무대 왼쪽 위 기준 CSS px).
 */

const MAX = 3
/** 하나 집어 가면 이만큼 뒤에 하나 채운다 */
const REFILL_MS = 2500

export class TreatTray {
  private rect = { x: 0, y: 0, w: 0, h: 0 }
  private hover = false
  private count = MAX
  private refillTimer = 0
  private readonly items: HTMLElement[]
  private readonly el: HTMLElement
  private readonly stage: HTMLElement

  constructor(el: HTMLElement, stage: HTMLElement, treatSrc: string) {
    this.el = el
    this.stage = stage
    const pile = el.querySelector('.tray-pile')!
    this.items = Array.from({ length: MAX }, (_, i) => {
      const img = new Image()
      img.src = treatSrc
      img.alt = ''
      img.className = `tray-treat t${i}`
      img.decoding = 'async'
      pile.append(img)
      return img
    })
    new ResizeObserver(() => this.measure()).observe(stage)
    window.addEventListener('resize', () => this.measure())
    this.measure()
  }

  private measure() {
    const s = this.stage.getBoundingClientRect()
    const r = this.el.getBoundingClientRect()
    // 손이 조금 빗나가도 집히게 둘레를 넉넉히
    const pad = 16
    this.rect = { x: r.left - s.left - pad, y: r.top - s.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 }
  }

  /** 간식 그림 바꾸기 (고양이는 츄르 스틱). 같은 그림이면 아무것도 안 한다 */
  setTreat(src: string, kind: 'cube' | 'churu') {
    this.el.classList.toggle('churu', kind === 'churu')
    for (const img of this.items) if ((img as HTMLImageElement).src !== new URL(src, location.href).href) (img as HTMLImageElement).src = src
    this.el.querySelector('.tray-label')!.textContent = kind === 'churu' ? '츄르' : '간식'
    this.el.setAttribute('aria-label', kind === 'churu' ? '츄르 접시. 손끝을 모아 츄르를 집어 아이 입 앞에 대 주세요' : '간식 접시. 손끝을 모아 간식을 집어 아이 입 앞에 대 주세요')
  }

  /** 무대 좌표 (x, y)가 접시 위인지 */
  hit(x: number, y: number) {
    const { x: rx, y: ry, w, h } = this.rect
    return x >= rx && x <= rx + w && y >= ry && y <= ry + h
  }

  /** 손이 접시 위에 있으면 접시를 강조한다. 바뀔 때만 DOM을 건드린다 */
  setHover(on: boolean) {
    if (on === this.hover) return
    this.hover = on
    this.el.classList.toggle('hover', on)
  }

  get available() {
    return this.count
  }

  /** 간식 하나를 집어 간다. 비었으면 false */
  take() {
    if (this.count <= 0) return false
    this.count--
    this.render()
    this.scheduleRefill()
    return true
  }

  private scheduleRefill() {
    if (this.refillTimer || this.count >= MAX) return
    this.refillTimer = window.setTimeout(() => {
      this.refillTimer = 0
      this.count = Math.min(MAX, this.count + 1)
      this.render()
      this.scheduleRefill()
    }, REFILL_MS)
  }

  private render() {
    this.items.forEach((img, i) => img.classList.toggle('gone', i >= this.count))
    this.el.classList.toggle('empty', this.count === 0)
  }
}
