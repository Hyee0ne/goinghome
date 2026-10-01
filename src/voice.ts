/**
 * 말로 시키기: "손!", "손 줘", "하이파이브" 같은 말을 알아듣는다 (브라우저 내장 음성 인식, Web Speech API).
 *
 * 주의: Chrome은 음성을 Google 서버로 보내 글자로 바꾼다 (카메라 영상과 달리 기기 밖으로 나간다).
 * 지원하지 않는 브라우저(Firefox 등)에서는 조용히 꺼진다. 인식은 브라우저가 따로 처리해 화면 루프에 부담이 없다.
 */

type Recognition = {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error: string }) => void) | null
}

/** "손"은 짧아서 비슷하게 잘못 알아듣는 말도 받아 준다 */
const PAW_WORDS = /(^|\s)(손|쏜|손줘|손 줘|손줄래|악수|하이파이브|하이 파이브|하이 화이브|하이파이)(\s|$|!|\.)/

export class Voice {
  private rec: Recognition | null = null
  private wanted = false
  private lastFire = 0
  /** 마지막으로 알아들은 말 (디버그 표시용) */
  heard = ''

  private readonly onPaw: () => void

  constructor(onPaw: () => void) {
    this.onPaw = onPaw
  }

  get supported() {
    return !!(window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }).SpeechRecognition ||
      !!(window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition
  }

  /** 사용자가 누른 순간(시작 버튼)에 부른다. 마이크 권한을 묻는다 */
  start() {
    const W = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }
    const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition
    if (!Ctor || this.rec) return
    const rec = new Ctor()
    rec.lang = 'ko-KR'
    rec.continuous = true
    // 말이 끝나기 전 중간 결과로도 반응해 빠르게 앞발을 준다
    rec.interimResults = true
    rec.maxAlternatives = 3
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        for (let k = 0; k < r.length; k++) {
          const text = r[k].transcript.trim()
          this.heard = text
          // 한 글자 "손"은 중간 결과(말이 끝나기 전 추측)에서 잘못 나오기 쉬워 최종 결과만 믿는다
          const short = text.replace(/[\s!.?]/g, '').length <= 1
          if (PAW_WORDS.test(` ${text} `) && (!short || r.isFinal)) {
            const now = performance.now()
            // 같은 말의 중간·최종 결과가 여러 번 와도 한 번만
            if (now - this.lastFire > 1500) {
              this.lastFire = now
              this.onPaw()
            }
            return
          }
        }
      }
    }
    // 브라우저가 잠시 뒤 스스로 끄므로, 켜 둔 동안은 다시 켠다
    rec.onend = () => {
      if (this.wanted) setTimeout(() => this.wanted && this.safeStart(), 300)
    }
    rec.onerror = (e) => {
      // 권한 거부·지원 안 함이면 그만 켠다
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.wanted = false
    }
    this.rec = rec
    this.wanted = true
    this.safeStart()
  }

  /** 일시정지 등에서 잠깐 끄기 */
  setActive(on: boolean) {
    if (!this.rec) return
    this.wanted = on
    if (on) this.safeStart()
    else this.rec.stop()
  }

  private safeStart() {
    try {
      this.rec?.start()
    } catch {
      /* 이미 켜져 있으면 예외가 난다 */
    }
  }
}
