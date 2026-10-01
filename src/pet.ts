import { josa, layoutOf, type Layout, type PetProfile, type Zone } from './pets'

/**
 * 좌표계: 펫 로컬 단위. 원점은 몸통 중심 근처이고, 머리 중심은 (0, L.headY)에 있다.
 * 화면에서는 main.ts가 이동과 확대/축소 변환을 한 번 적용한다.
 * HEAD_Y는 캔버스 그림 전용이고, 판정은 모두 배치(Layout)를 따른다. 실사 사진은 배치가 다르다.
 */
const HEAD_Y = -125
const TAU = Math.PI * 2

/** 이보다 빠르면(로컬 단위/초) 거칠다고 느낀다 */
const ROUGH_SPEED = 2600
const ROUGH_SPEED_SHY = 1800
/** 손의 어느 부분이든 코에서 이 거리 안에 있으면 냄새를 맡는다 */
export const SNIFF_RADIUS = 120
/** 냄새 맡는 동안 이보다 빨리 움직이면 진행이 멈춘다 (손 떨림은 허용) */
const SNIFF_MAX_SPEED = 700
/** 이보다 느리면 쓰다듬기가 아니라 손을 얹고 있는 상태로 본다 */
const STROKE_MIN_SPEED = 45

export interface PetInput {
  /** 손 구분자 ('Left' | 'Right'). 손마다 속도를 따로 잰다 */
  id: string
  x: number
  y: number
  /** 손바닥을 편 상태 (쓰다듬기는 편 손으로만 인정) */
  active: boolean
  /** 손바닥을 위로 해서 '손 달라'고 내민 손인지 (손 주기) */
  offer?: boolean
  /** 손 랜드마크 21개 (펫 로컬 좌표). 냄새 맡기와 닿는 부위 판정에 쓴다 */
  points: { x: number; y: number }[]
}

export type PetEvent =
  | { type: 'say'; text: string }
  | { type: 'heart'; x: number; y: number }
  | { type: 'complete' }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const approach = (cur: number, target: number, rate: number, dt: number) =>
  lerp(cur, target, 1 - Math.exp(-rate * dt))

/** 렌더러가 읽는 현재 몸짓 */
export interface Pose {
  t: number
  blink: number
  happy: number
  petting: number
  startle: number
  sniffing: number
  perk: number
  leanX: number
  leanY: number
  lookX: number
  lookY: number
  /** 머리 기울기 (라디안) */
  tilt: number
  /** 겁 많은 아이가 아직 낯선 손이 다가와 경계하는 정도 (0~1) */
  wary: number

  // ── 스스로 하는 행동 (행동 스케줄러) ──
  /** 두리번거릴 때 고개 방향 (-1~1, 렌더러가 고개 돌리기에 더한다) */
  idleYaw: number
  idlePitch: number
  /** 고개 갸웃 (라디안), 궁금함 (0~1), 갸웃하는 쪽 (-1: 화면 왼쪽, 1: 오른쪽) */
  cock: number
  curious: number
  cockSide: number
  /** 입맛 다시기 (0~1) */
  lick: number
  /** 한숨 (0~1): 숨을 크고 느리게 쉬고 눈을 조금 감는다 */
  sigh: number
  /** 고양이의 느린 눈 깜빡임 (0~1, '고양이 키스'). 믿고 편안하다는 표시 */
  slowBlink: number
  /** 고양이 머리 부비기 (0~1)와 방향 (-1: 화면 왼쪽 손, 1: 오른쪽 손) */
  bunt: number
  buntSide: number
  species: 'dog' | 'cat'
  /** 이번 프레임에 귀를 까딱하는 힘 (한 프레임만 0이 아니다) */
  earKickL: number
  earKickR: number
  /** 숨 빠르기 배율 (천천히 오르내린다) */
  breathRate: number
  // ── 손이 닿기 전 반응 ──
  /** 손이 빠르게 다가와 움찔 (0~1) */
  flinch: number
  /** 손이 천천히 다가와 코를 내밀고 킁킁댐 (0~1) */
  reach: number
  /** 손 주기: 앞발을 든 정도 (0~1)와 앞발이 놓일 손바닥 위치 (펫 로컬 좌표) */
  paw: number
  pawX: number
  pawY: number
}

type Behavior = 'look' | 'earFlick' | 'lick' | 'tilt' | 'sigh' | 'slowBlink'

export class Pet {
  readonly p: PetProfile
  readonly L: Layout
  affection: number
  sniffed: boolean

  private t = Math.random() * 10
  private blink = 0
  private blinkClock = 99
  private nextBlink = 2
  private happy = 0
  private petting = 0
  private startle = 0
  private sniffProgress = 0
  private sniffing = 0
  private perk = 0
  private wary = 0
  // 행동 스케줄러
  private behavior: { kind: Behavior; t: number; dur: number; side: number; pitch: number; twice: boolean } | null = null
  private nextBehavior = 2 + Math.random() * 2
  private idleYaw = 0
  private idlePitch = 0
  private gazeX = 0
  private gazeY = 0
  private cock = 0
  private curious = 0
  private cockSide = 1
  private lick = 0
  private sigh = 0
  private slowBlink = 0
  private bunt = 0
  private buntSide = 1
  /** 고양이는 귀를 자주 까딱인다: 다음 까딱까지 남은 시간 */
  private nextTwitch = 1.5
  private earKickL = 0
  private earKickR = 0
  private breathRate = 1
  private flinch = 0
  private reach = 0
  private hoverFor = 0
  /** 손마다 지난 프레임의 코까지 거리, 손 크기, 닿아 있던 시간 (다가오는 빠르기를 재려고) */
  private handTrack = new Map<string, { d: number; size: number; touchAge: number }>()
  private lookX = 0
  private lookY = 0
  private leanX = 0
  private leanY = 0
  private strokeAcc = 0
  /** 손 주기: 턱 아래에 편 손을 가만히 둔 시간, 앞발을 올린 손, 앞발 위치 */
  private pawHold = 0
  pawHandId: string | null = null
  /** 앞발을 받으려고 손을 가만히 내밀고 있는 손 (아직 앞발을 올리기 전). 이 손은 턱 들기로 치지 않는다 */
  pawOfferId: string | null = null
  /** "손!"이라고 말한 뒤 남은 시간 (이 안에 앞발을 준다) */
  private pawCommand = 0
  /** 손 없이 앞에 들고 있을 남은 시간 */
  private pawAirLeft = 0
  private paw = 0
  private pawX = 0
  private pawY = 0
  /** 손마다 지난 위치와 속도 */
  private hands = new Map<string, { x: number; y: number; speed: number }>()
  private bothFor = 0
  private lastSay = -99
  private lastSayKey = ''
  private handNearNose = false
  private milestone = 0
  private events: PetEvent[] = []

  constructor(profile: PetProfile, affection = 0) {
    this.p = profile
    this.L = layoutOf(profile)
    this.affection = affection
    this.sniffed = !profile.shy || affection > 0
    this.milestone = MILESTONES.filter((m) => affection >= m).length
  }

  get isCat() {
    return this.p.species === 'cat'
  }

  private get nose() {
    return { x: this.leanX, y: this.L.noseY + this.leanY }
  }

  /** 같은 종류의 말은 너무 자주 반복하지 않는다 */
  private say(key: string, text: string, gap = 2.5) {
    if (key === this.lastSayKey && this.t - this.lastSay < gap * 2) return
    if (this.t - this.lastSay < gap && key !== 'milestone') return
    this.lastSay = this.t
    this.lastSayKey = key
    this.events.push({ type: 'say', text })
  }

  /** 손바닥 중심이 우선이고, 거기가 안 닿으면 손가락 쪽(가운뎃손가락 뿌리, 손끝)으로 판정한다 */
  /**
   * 손이 닿은 부위. 손바닥 중심을 먼저 보고, 안 닿으면 손가락 쪽(가운뎃손가락 뿌리, 손끝)을 본다.
   * 다만 손의 어느 부분이든 턱에 닿았으면 턱이다: 턱을 받칠 때는 손끝·손바닥 윗부분이 턱에 닿고 손바닥 중심은 목에 있다
   */
  /** 손끝 (엄지~새끼, 손 랜드마크 번호) */
  static readonly TIPS = [4, 8, 12, 16, 20]

  /** 손가락을 오므려도 손끝으로 긁으면 쓰다듬기로 친다: 검지·중지·약지 끝 중 몸에 닿은 곳 */
  tipZone(input: PetInput): Zone | null {
    if (input.points.length !== 21) return null
    for (const i of [8, 12, 16]) {
      const z = this.zoneAt(input.points[i].x, input.points[i].y)
      if (z) return z
    }
    return null
  }

  contactZone(input: PetInput): Zone | null {
    const pts = input.points
    const candidates =
      pts.length === 21 ? [input, pts[9], pts[5], pts[13], mid(pts[8], pts[12]), mid(pts[12], pts[16])] : [input]
    const zones = candidates.map((c) => this.zoneAt(c.x, c.y))
    if (zones.includes('chin')) return 'chin'
    return zones.find((z) => z) ?? null
  }

  zoneAt(x: number, y: number): Zone | null {
    const L = this.L
    const hx = (x - this.leanX) / L.headRx
    const hy = (y - L.headY - this.leanY) / L.headRy
    const belowMouth = y - L.headY - this.leanY > L.chinDy
    if (hx * hx + hy * hy <= 1) {
      return belowMouth && Math.abs(x - this.leanX) < L.chinDx ? 'chin' : 'head'
    }
    // 턱 바로 아래(목 위쪽)도 턱 밑으로 본다
    if (belowMouth && y - L.headY - this.leanY < L.headRy * 1.45 && Math.abs(x - this.leanX) < L.chinDx * 1.2) return 'chin'
    const bx = x / L.bodyRx
    const by = (y - L.bodyY) / L.bodyRy
    if (bx * bx + by * by <= 1) return 'body'
    return null
  }

  update(dt: number, inputs: PetInput[]): PetEvent[] {
    this.t += dt
    const { p } = this

    // 손마다 속도 (로컬 단위/초)
    const hands = inputs.map((input) => {
      const prev = this.hands.get(input.id)
      const moved = prev ? Math.hypot(input.x - prev.x, input.y - prev.y) : 0
      const speed = prev ? approach(prev.speed, moved / Math.max(dt, 1e-3), 12, dt) : 0
      return { input, moved, speed }
    })
    this.hands = new Map(hands.map((h) => [h.input.id, { x: h.input.x, y: h.input.y, speed: h.speed }]))

    const nose = this.nose
    // 손을 펴지 않아도, 손가락 끝만 닿아도 냄새는 맡을 수 있다
    const nearNoseOf = (h: (typeof hands)[number]) => handDistance(h.input, nose) < SNIFF_RADIUS
    const nearNose = hands.some(nearNoseOf)
    this.handNearNose = nearNose
    const nearHead = hands.some((h) => Math.hypot(h.input.x, h.input.y - this.L.headY) < 300)

    this.startle = Math.max(0, this.startle - dt * 0.9)
    let strokers = 0
    let leanTargetX = 0
    let leanTargetY = 0

    // 1) 냄새 맡기: 겁 많은 아이는 이걸 먼저 해야 마음을 연다
    if (!this.sniffed && hands.some((h) => nearNoseOf(h) && h.speed < SNIFF_MAX_SPEED)) {
      this.sniffProgress += dt / 1.6
      this.sniffing = 1
      this.say('sniff', '킁킁… 손 냄새를 맡고 있어요', 3)
      if (this.sniffProgress >= 1) {
        this.sniffed = true
        this.affection = Math.max(this.affection, 5)
        this.say('sniffed', `냄새를 기억했어요. 이제 살살 쓰다듬어 주세요`, 0)
        this.events.push({ type: 'heart', x: nose.x, y: nose.y - 20 })
      }
    } else {
      this.sniffProgress = Math.max(0, this.sniffProgress - dt * 0.25)
      this.sniffing = Math.max(0, this.sniffing - dt * 3)
    }

    // 2) 손 주기: 턱 아래에 편 손바닥을 0.8초 가만히 내밀면 앞발을 올린다 (겁 많은 아이는 냄새를 맡은 뒤에만)
    this.updatePaw(dt, hands)

    // 3) 쓰다듬기: 손마다 따로 판정한다. 한 손이라도 거칠면 놀란다 (앞발을 올린 손은 빼고)
    const calm = this.startle < 0.35
    const touching: PetInput[] = []
    for (const { input, moved, speed } of hands) {
      if (input.id === this.pawHandId) continue
      const zone = input.active ? this.contactZone(input) : this.tipZone(input)
      if (!zone || !calm || (!this.sniffed && nearNoseOf({ input, moved, speed }))) continue
      touching.push(input)
      const rough = p.shy ? ROUGH_SPEED_SHY : ROUGH_SPEED
      if (!this.sniffed) {
        if (speed > 150) {
          this.startle = Math.max(this.startle, 0.5)
          this.say('notyet', `아직 낯설어해요… 먼저 코 앞에 손을 가만히 내밀어 보세요`, 3)
        }
      } else if (speed > rough) {
        this.startle = 1
        this.affection = Math.max(0, this.affection - 4)
        this.say('rough', `${josa(p.name, '이', '가')} 깜짝 놀랐어요! 조금 더 천천히요`, 1)
      } else if (speed > STROKE_MIN_SPEED) {
        strokers++
        const fav = zone === p.favorite ? 2 : 1
        const shyMul = p.shy ? 0.75 : 1
        this.affection = Math.min(100, this.affection + moved * 0.011 * fav * shyMul)
        this.strokeAcc += moved * fav
        if (this.strokeAcc > 240) {
          this.strokeAcc = 0
          this.events.push({ type: 'heart', x: input.x, y: input.y })
        }
        if (zone === p.favorite) this.say('fav', favoriteLine(p.species, zone), 4)
        else this.say('pet', pettingLine(p.species), 4)
      } else {
        // 손을 얹고만 있어도 아주 조금씩 편안해진다
        this.affection = Math.min(100, this.affection + dt * 0.8)
        this.petting = Math.max(this.petting, 0.4)
      }
    }
    const stroking = strokers > 0

    // 양손으로 감싸듯 쓰다듬으면 더 좋아한다
    this.bothFor = strokers >= 2 ? this.bothFor + dt : 0
    if (this.bothFor > 0.6) this.say('both', bothHandsLine(p), 5)

    if (touching.length) {
      // 손길 쪽으로 머리를 기댄다. 양손이면 두 손의 가운데로
      const ax = touching.reduce((a, t) => a + t.x, 0) / touching.length
      const ay = touching.reduce((a, t) => a + t.y, 0) / touching.length
      leanTargetX = clamp((ax - this.leanX) * 0.12, -20, 20)
      leanTargetY = clamp((ay - this.L.headY) * 0.06, -10, 10)
    }

    const nearest = hands.reduce<PetInput | null>(
      (best, h) => (!best || Math.abs(h.input.x - this.leanX) < Math.abs(best.x - this.leanX) ? h.input : best),
      null,
    )
    if (this.startle > 0.3 && nearest) {
      // 가장 가까운 손에서 멀어지려 한다
      const dx = this.leanX - nearest.x
      leanTargetX = clamp(dx * 0.2, -28, 28)
      leanTargetY = 12
    }

    this.petting = approach(this.petting, stroking ? 1 : 0, stroking ? 8 : 1.5, dt)
    const baseHappy = (this.affection / 100) * 0.35
    const both = Math.min(1, this.bothFor / 0.6) * 0.15
    this.happy = approach(this.happy, Math.min(1, Math.max(this.petting, baseHappy) + both) * (1 - this.startle), 4, dt)
    this.perk = approach(this.perk, nearHead && !stroking ? 1 : 0, 5, dt)
    this.wary = approach(this.wary, p.shy && !this.sniffed && nearHead ? 1 : 0, 3, dt)
    this.leanX = approach(this.leanX, leanTargetX, 5, dt)
    this.leanY = approach(this.leanY, leanTargetY, 5, dt)

    // 스스로 하는 행동과, 손이 닿기 전 반응
    this.updateBehavior(dt, hands, stroking, new Set(touching.map((t) => t.id)))

    // 눈은 가장 빨리 움직이는 손을 따라간다. 손이 없으면 두리번거리는 쪽을 본다
    const focus = hands.reduce<(typeof hands)[number] | null>((best, h) => (!best || h.speed > best.speed ? h : best), null)?.input
    const lookTx = focus ? clamp((focus.x - this.leanX) / 260, -1, 1) : this.gazeX
    const lookTy = focus ? clamp((focus.y - this.L.headY) / 260, -1, 1) : this.gazeY
    this.lookX = approach(this.lookX, lookTx, 10, dt)
    this.lookY = approach(this.lookY, lookTy, 10, dt)

    // 눈 깜빡임: 빠르게 감고(0.07초) 조금 천천히 뜬다(0.13초). 간격은 들쭉날쭉하고 가끔 두 번 연달아 깜빡인다
    this.nextBlink -= dt
    if (this.nextBlink <= 0) {
      this.blinkClock = 0
      this.nextBlink = Math.random() < 0.15 ? 0.28 : 1.2 + Math.random() ** 1.5 * 5.5
    }
    this.blinkClock += dt
    const bc = this.blinkClock
    this.blink = bc < BLINK_CLOSE ? bc / BLINK_CLOSE : Math.max(0, 1 - (bc - BLINK_CLOSE) / BLINK_OPEN)

    // 마음의 거리 단계별 반응
    while (this.milestone < MILESTONES.length && this.affection >= MILESTONES[this.milestone]) {
      const line = milestoneLine(p, this.milestone)
      this.milestone++
      this.say('milestone', line, 0)
      if (this.milestone === MILESTONES.length) this.events.push({ type: 'complete' })
    }

    const out = this.events
    this.events = []
    return out
  }

  /** 손 기록을 비운다 (일시정지 뒤 다시 시작할 때. 멈추기 전 손 위치에서 순간이동한 것으로 보고 놀라지 않게) */
  forgetHands() {
    this.hands.clear()
    this.handTrack.clear()
    this.pawHold = 0
    this.pawHandId = null
    this.pawOfferId = null
  }

  /** 앞발을 받을 자리: 턱 아래, 얼굴 폭 안쪽 (scale 1이면 그 자리, 크면 놓아주는 범위) */
  private inPawZone(x: number, y: number, scale = 1) {
    const L = this.L
    const top = L.headY + L.chinDy + L.headRy * 0.1
    const bottom = L.headY + L.headRy * (1.9 + (scale - 1) * 0.6)
    return Math.abs(x - this.leanX) < L.headRx * 0.75 * scale && y > top - (scale - 1) * L.headRy * 0.4 && y < bottom
  }

  /**
   * "손!" 같은 말로 앞발을 달라고 할 때 부른다 (voice.ts). 손이 보이면 그 손에, 안 보이면 앞에 들었다가 내린다
   */
  commandPaw() {
    if (this.startle > 0.3) return
    this.pawCommand = PAW_COMMAND_WINDOW
  }

  /** 앞발이 갈 자리: 턱 아래 얼굴 폭 안쪽으로 묶는다 (손이 얼굴 위에 있어도 앞발이 얼굴을 덮지 않게) */
  private clampPaw(x: number, y: number) {
    const L = this.L
    return {
      x: clamp(x, this.leanX - L.headRx * 0.7, this.leanX + L.headRx * 0.7),
      y: clamp(y, L.headY + L.chinDy + L.headRy * 0.2, L.headY + L.headRy * 1.8),
    }
  }

  private updatePaw(dt: number, hands: { input: PetInput; speed: number }[]) {
    // 겁 많은 아이도 손은 주지만, 냄새를 맡기 전에는 더 오래 기다려야 한다
    const hold = this.sniffed ? PAW_HOLD : PAW_HOLD_SHY
    this.pawCommand = Math.max(0, this.pawCommand - dt)
    if (!this.pawHandId) {
      const offer =
        this.startle < 0.2 && hands.find(({ input, speed }) => input.offer && speed < PAW_STILL && this.inPawZone(input.x, input.y))
      this.pawHold = offer ? this.pawHold + dt : Math.max(0, this.pawHold - dt * 2)
      this.pawOfferId = offer && this.pawHold > 0.1 ? offer.input.id : null
      // 말로 시켰으면: 편 손이 보이면 그 손에, 아니면 앞에 든다
      const commanded = this.pawCommand > 0 && this.startle < 0.2
      const target =
        offer && this.pawHold >= hold ? offer.input : commanded ? hands.find(({ input }) => input.offer || input.active)?.input : undefined
      if (target || commanded) {
        this.pawHandId = target ? target.id : PAW_AIR
        this.pawAirLeft = target ? 0 : PAW_AIR_SECONDS
        this.pawOfferId = null
        this.pawCommand = 0
        const p = this.clampPaw(target?.x ?? this.leanX, target?.y ?? this.L.headY + this.L.headRy * 1.3)
        this.pawX = p.x
        this.pawY = p.y
        this.affection = Math.min(100, this.affection + 1.5)
      }
    } else if (this.pawHandId === PAW_AIR) {
      // 손 없이 말로만 시켰을 때: 잠깐 들고 있다가 내린다. 그사이 편 손이 다가오면 그 손에 얹는다
      this.pawAirLeft -= dt
      const h = hands.find(({ input }) => (input.offer || input.active) && this.inPawZone(input.x, input.y, 1.3))
      if (h) this.pawHandId = h.input.id
      else if (this.pawAirLeft <= 0 || this.startle > 0.3) this.pawHandId = null
      this.petting = Math.max(this.petting, 0.4)
    } else {
      const h = hands.find(({ input }) => input.id === this.pawHandId)
      // 손을 빼거나, 놀라면 앞발을 내린다 (앞발을 얹은 뒤에는 손 모양이 조금 흔들려도 그대로 둔다)
      if (!h || this.startle > 0.3 || !this.inPawZone(h.input.x, h.input.y, 1.6)) {
        this.pawHandId = null
        this.pawHold = 0
      } else {
        const p = this.clampPaw(h.input.x, h.input.y)
        this.pawX = approach(this.pawX, p.x, 10, dt)
        this.pawY = approach(this.pawY, p.y, 10, dt)
        // 손을 맞잡고 있으면 좋아한다
        this.petting = Math.max(this.petting, 0.5)
      }
    }
    // 들 때는 조금 빨리, 내릴 때는 천천히
    this.paw = approach(this.paw, this.pawHandId ? 1 : 0, this.pawHandId ? 4 : 3, dt)
  }

  private blinkNow() {
    if (this.blinkClock > 0.25) this.blinkClock = 0
  }

  /**
   * 행동 스케줄러: 가만히 있을 때도 두리번거리고, 귀를 까딱하고, 입맛을 다시고, 갸웃하고, 한숨을 쉰다.
   * 손이 닿기 전에도 반응한다: 빠르게 다가오면 움찔하고, 천천히 다가오면 코를 내밀고, 가까이 멈춰 있으면 갸웃한다
   */
  private updateBehavior(dt: number, hands: { input: PetInput; speed: number }[], stroking: boolean, touching: Set<string>) {
    const { p } = this
    this.earKickL = 0
    this.earKickR = 0

    if (this.isCat) {
      // ── 고양이: 기분 좋게 머리를 쓰다듬어 주면 손 쪽으로 머리를 밀며 비빈다 (부비부비) ──
      const headHand = hands.find(({ input }) => touching.has(input.id) && this.zoneAt(input.x, input.y) === 'head')
      const want = headHand && this.happy > 0.3 && this.startle < 0.2 ? 1 : 0
      if (headHand) this.buntSide = Math.sign(headHand.input.x - this.leanX) || this.buntSide
      this.bunt = approach(this.bunt, want, want ? 2.5 : 1.5, dt)

      // ── 고양이: 귀를 자주 까딱인다 (한쪽씩, 작게). 손이 가까이 오면 더 자주 ──
      this.nextTwitch -= dt * (hands.length ? 1.8 : 1)
      if (this.nextTwitch <= 0) {
        if (Math.random() < 0.5) this.earKickL = 1.3
        else this.earKickR = 1.3
        this.nextTwitch = 1.2 + Math.random() * 3
      }
    }

    // ── 손이 다가오는 빠르기 ──
    // 화면 위에서 코 쪽으로 오는 속도와, 카메라 쪽으로 내미는 속도(손이 커지는 빠르기)를 함께 본다.
    // 카메라에서는 손이 나타나자마자 얼굴 위에 겹치는 일이 많아서, 막 닿은 순간(0.25초)까지는 다가오는 중으로 친다
    const nose = this.nose
    let fast = false
    let gentle = false
    let hover = false
    const seen = new Set<string>()
    for (const { input, speed } of hands) {
      seen.add(input.id)
      const d = handDistance(input, nose)
      const pts = input.points
      const size = pts.length === 21 ? Math.hypot(pts[0].x - pts[9].x, pts[0].y - pts[9].y) : 0
      const prev = this.handTrack.get(input.id)
      const touchingNow = touching.has(input.id)
      const touchAge = touchingNow ? (prev?.touchAge ?? 0) + dt : 0
      this.handTrack.set(input.id, { d, size, touchAge })
      if (!prev) continue
      const closing = (prev.d - d) / Math.max(dt, 1e-3)
      const zoom = prev.size > 1 && size > 1 ? (size - prev.size) / prev.size / Math.max(dt, 1e-3) : 0
      const arriving = !touchingNow || touchAge < 0.25
      if (arriving && d < 330 && (closing > FLINCH_SPEED || zoom > FLINCH_ZOOM)) fast = true
      else if ((!touchingNow || touchAge < 0.6) && d < 230 && (closing > 40 || zoom > 0.15)) gentle = true
      // 코 가까이에 손을 가만히 두면 냄새를 맡는다
      if (d < 120 && speed < 80) gentle = true
      if (!touchingNow && d < 230 && speed < 80) hover = true
    }
    for (const id of this.handTrack.keys()) if (!seen.has(id)) this.handTrack.delete(id)

    // 움찔: 겁 많은 아이는 더 크게
    if (fast && this.flinch < 0.25) {
      this.flinch = p.shy && !this.sniffed ? 1 : 0.6
      this.blinkNow()
    }
    this.flinch = Math.max(0, this.flinch - dt * 2.2)
    // 천천히 다가오거나 가까이 있는 손에는 코를 내밀고 킁킁댄다 (겁 많은 아이가 낯설어하는 동안은 덜)
    const reachTarget = (gentle || hover) && this.flinch < 0.2 ? (this.wary > 0.5 ? 0.4 : 1) : 0
    this.reach = approach(this.reach, reachTarget, reachTarget > this.reach ? 4 : 2, dt)
    // 가까이 가만히 대고 있으면 궁금해서 갸웃한다
    this.hoverFor = hover ? this.hoverFor + dt : 0
    if (this.hoverFor > 0.9 && !this.behavior) {
      this.startBehavior('tilt')
      this.hoverFor = -3 // 한 번 갸웃하고 나면 한동안은 다시 안 한다
    }

    // ── 스스로 하는 행동 고르기 ──
    this.nextBehavior -= dt
    if (!this.behavior && this.nextBehavior <= 0) {
      const busy = stroking || touching.size > 0
      // 고양이는 기분이 좋아도 입을 벌리거나 입맛을 다시지 않는다. 대신 천천히 눈을 감았다 뜬다 (고양이 키스)
      const pool: Behavior[] = this.isCat
        ? busy
          ? this.happy > 0.4
            ? ['slowBlink', 'slowBlink', 'earFlick']
            : ['earFlick']
          : ['look', 'look', 'earFlick', 'tilt', this.happy > 0.25 ? 'slowBlink' : 'look', this.happy > 0.3 ? 'slowBlink' : 'look']
        : busy
          ? this.happy > 0.5
            ? ['earFlick', 'lick', 'earFlick']
            : ['earFlick']
          : ['look', 'look', 'earFlick', 'lick', 'tilt', this.happy > 0.3 ? 'sigh' : 'look']
      this.startBehavior(pool[Math.floor(Math.random() * pool.length)])
      this.nextBehavior = 2.5 + Math.random() * 3.5
    }

    // ── 진행 중인 행동 ──
    let yaw = 0
    let pitch = 0
    let gazeX = Math.sin(this.t * 0.31) * 0.15 // 가만히 있을 때 시선이 아주 조금씩 떠돈다
    let gazeY = Math.sin(this.t * 0.23) * 0.08
    let cock = 0
    let curious = 0
    let lick = 0
    let sigh = 0
    let slowBlink = 0
    const b = this.behavior
    if (b) {
      b.t += dt
      const u = Math.min(1, b.t / b.dur)
      // 들어갔다 머물다 나오는 모양 (0 → 1 → 0)
      const env = smooth01(Math.min(1, u / 0.25)) * smooth01(Math.min(1, (1 - u) / 0.25))
      if (b.kind === 'look') {
        // 눈이 먼저 가고 고개가 뒤따른다. 가끔은 반대쪽도 본다
        const side = b.twice && u > 0.5 ? -b.side : b.side
        if (b.twice && u > 0.5 && u - dt / b.dur <= 0.5) this.blinkNow()
        gazeX = side * 0.85 * smooth01(Math.min(1, u / 0.08)) * smooth01(Math.min(1, (1 - u) / 0.12))
        gazeY = b.pitch * 0.5
        yaw = side * 0.45 * env
        pitch = b.pitch * env
      } else if (b.kind === 'lick') {
        lick = Math.sin(Math.PI * u) ** 1.5
      } else if (b.kind === 'tilt') {
        cock = b.side * 0.09 * env
        curious = env
        gazeY = -0.1
      } else if (b.kind === 'sigh') {
        sigh = Math.sin(Math.PI * u)
      } else if (b.kind === 'slowBlink') {
        // 천천히 감고(0.6초) 잠깐 머물렀다(0.4초) 천천히 뜬다(0.7초)
        const t = b.t
        slowBlink = t < 0.6 ? smooth01(t / 0.6) : t < 1.0 ? 1 : 1 - smooth01(Math.min(1, (t - 1.0) / 0.7))
      }
      if (u >= 1) this.behavior = null
    }
    this.idleYaw = yaw
    this.idlePitch = pitch
    this.gazeX = gazeX
    this.gazeY = gazeY
    this.cock = cock
    this.curious = curious
    this.lick = lick
    this.sigh = sigh
    this.slowBlink = slowBlink

    // 숨 빠르기는 천천히 오르내린다 (두 사인을 섞어 규칙적으로 들리지 않게)
    this.breathRate = 1 + Math.sin(this.t * 0.13) * 0.12 + Math.sin(this.t * 0.051 + 1.3) * 0.1
    // 킁킁: 냄새를 맡는 중이거나 코를 내밀 때
    this.sniffing = Math.max(this.sniffing, this.reach * 0.7)
  }

  private startBehavior(kind: Behavior) {
    const side = Math.random() < 0.5 ? -1 : 1
    const dur = { look: 1.4 + Math.random() * 0.9, earFlick: 0.3, lick: 0.5, tilt: 1.4 + Math.random() * 0.8, sigh: 2.8, slowBlink: 1.7 }[kind]
    this.behavior = { kind, t: 0, dur, side, pitch: (Math.random() - 0.6) * 0.4, twice: Math.random() < 0.35 }
    if (kind === 'earFlick') {
      // 한쪽 귀만 까딱
      if (side < 0) this.earKickL = 2.2
      else this.earKickR = 2.2
    }
    if (kind === 'look' && Math.random() < 0.5) this.blinkNow() // 시선을 옮길 때 깜빡이곤 한다
    if (kind === 'tilt') this.cockSide = side
  }

  private get tilt() {
    return this.leanX * 0.006 + Math.sin(this.t * 0.7) * 0.03 + this.perk * (1 - this.petting) * 0.1 * Math.sign(this.lookX || 1)
  }

  get pose(): Pose {
    return {
      t: this.t,
      blink: this.blink,
      happy: this.happy,
      petting: this.petting,
      startle: this.startle,
      sniffing: this.sniffing,
      perk: this.perk,
      leanX: this.leanX,
      leanY: this.leanY,
      lookX: this.lookX,
      lookY: this.lookY,
      tilt: this.tilt,
      wary: this.wary,
      idleYaw: this.idleYaw,
      idlePitch: this.idlePitch,
      cock: this.cock,
      curious: this.curious,
      cockSide: this.cockSide,
      lick: this.lick,
      sigh: this.sigh,
      slowBlink: this.slowBlink,
      bunt: this.bunt,
      buntSide: this.buntSide,
      species: this.p.species,
      earKickL: this.earKickL,
      earKickR: this.earKickR,
      breathRate: this.breathRate,
      flinch: this.flinch,
      reach: this.reach,
      paw: this.paw,
      pawX: this.pawX,
      pawY: this.pawY,
    }
  }

  // ───────────────────────── 그리기 ─────────────────────────

  /** 동물 위에 겹치는 안내 (겁 많은 아이의 냄새 맡기 표시). 캔버스 그림과 실사 모두 쓴다 */
  drawOverlay(ctx: CanvasRenderingContext2D) {
    if (!this.sniffed) this.drawSniffTarget(ctx)
  }

  /** 캔버스 그림으로 동물을 그린다 (실사 사진이 없거나 WebGL을 못 쓸 때) */
  draw(ctx: CanvasRenderingContext2D) {
    const { p } = this
    const breathe = 1 + Math.sin(this.t * 2.2) * 0.012
    const purr = this.isCat ? this.petting : 0
    const shiver = this.startle * Math.sin(this.t * 60) * 2.5 + purr * Math.sin(this.t * 45) * 0.8

    // 바닥 그림자
    ctx.fillStyle = 'rgba(120, 80, 40, 0.13)'
    ellipse(ctx, 0, 250, 170, 26)

    ctx.save()
    ctx.translate(shiver, 0)
    ctx.scale(1 - this.startle * 0.03, 1 - this.startle * 0.03)

    this.drawTail(ctx)

    // 뒷다리
    ctx.fillStyle = p.fur
    ellipse(ctx, -88, 212, 50, 32)
    ellipse(ctx, 88, 212, 50, 32)

    // 몸통 (숨쉬기)
    ctx.save()
    ctx.translate(0, 225)
    ctx.scale(1, breathe)
    ctx.translate(0, -225)
    ctx.fillStyle = p.fur
    ellipse(ctx, 0, 95, this.isCat ? 104 : 116, 130)
    if (p.pattern === 'tabby') this.drawBodyStripes(ctx)
    ctx.fillStyle = p.belly
    ellipse(ctx, 0, 122, this.isCat ? 56 : 64, 92)
    if (p.pattern === 'patch') {
      ctx.fillStyle = p.furDark
      ellipse(ctx, 62, 60, 34, 42, 0.4)
    }
    ctx.restore()

    // 앞발
    for (const sgn of [-1, 1]) {
      ctx.fillStyle = p.belly
      ellipse(ctx, sgn * 42, 228, 34, 22)
      ctx.strokeStyle = 'rgba(0,0,0,0.12)'
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(sgn * 42 - 10, 222)
      ctx.lineTo(sgn * 42 - 10, 240)
      ctx.moveTo(sgn * 42 + 10, 222)
      ctx.lineTo(sgn * 42 + 10, 240)
      ctx.stroke()
    }

    if (purr > 0.3) this.drawPurr(ctx, purr)

    // 머리
    ctx.save()
    ctx.translate(this.leanX, HEAD_Y + this.leanY)
    ctx.rotate(this.tilt + this.cock)
    if (this.isCat) this.drawCatHead(ctx)
    else this.drawDogHead(ctx)
    ctx.restore()

    ctx.restore()
  }

  private drawTail(ctx: CanvasRenderingContext2D) {
    const { p } = this
    ctx.save()
    ctx.strokeStyle = p.fur
    ctx.lineCap = 'round'
    if (this.isCat) {
      ctx.translate(78, 205)
      const sway = Math.sin(this.t * (1.2 + this.happy * 1.5)) * (18 - this.startle * 14)
      ctx.lineWidth = 22 + this.startle * 18
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.bezierCurveTo(95, 25, 120, -55, 95 + sway, -125 + this.startle * 30)
      ctx.stroke()
      if (p.pattern === 'tabby') {
        ctx.strokeStyle = p.furDark
        ctx.lineWidth = 6
        for (const tt of [0.35, 0.55, 0.75]) {
          const x = bez(0, 95, 120, 95 + sway, tt)
          const y = bez(0, 25, -55, -125 + this.startle * 30, tt)
          ctx.beginPath()
          ctx.moveTo(x - 12, y - 4)
          ctx.lineTo(x + 12, y + 4)
          ctx.stroke()
        }
      }
    } else {
      ctx.translate(88, 180)
      const speed = 3 + this.happy * 16
      const amp = this.startle > 0.3 ? 0.04 : 0.12 + this.happy * 0.5
      ctx.rotate(Math.sin(this.t * speed) * amp + this.startle * 0.9)
      ctx.lineWidth = 28
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.quadraticCurveTo(70, -5, 78, -90)
      ctx.stroke()
      ctx.strokeStyle = p.belly
      ctx.lineWidth = 16
      ctx.beginPath()
      ctx.moveTo(80, -70)
      ctx.lineTo(78, -92)
      ctx.stroke()
    }
    ctx.restore()
  }

  private drawBodyStripes(ctx: CanvasRenderingContext2D) {
    ctx.strokeStyle = this.p.furDark
    ctx.lineWidth = 9
    ctx.lineCap = 'round'
    for (const sgn of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const y = 30 + i * 42
        ctx.beginPath()
        ctx.moveTo(sgn * 102, y)
        ctx.quadraticCurveTo(sgn * 80, y + 8, sgn * 70, y + 26)
        ctx.stroke()
      }
    }
  }

  private drawPurr(ctx: CanvasRenderingContext2D, level: number) {
    ctx.save()
    ctx.strokeStyle = `rgba(255, 140, 80, ${0.5 * level})`
    ctx.lineWidth = 4
    ctx.lineCap = 'round'
    for (const sgn of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const r = 30 + i * 18 + ((this.t * 40) % 18)
        ctx.beginPath()
        ctx.arc(sgn * 110, 90, r, sgn > 0 ? -0.5 : Math.PI - 0.5, sgn > 0 ? 0.5 : Math.PI + 0.5)
        ctx.stroke()
      }
    }
    ctx.restore()
  }

  private drawDogHead(ctx: CanvasRenderingContext2D) {
    const { p } = this
    const flap = Math.sin(this.t * 10) * 0.08 * this.petting

    // 귀 (접힌 귀). 오른쪽을 그리고 좌우 반전으로 왼쪽을 그린다
    for (const sgn of [-1, 1]) {
      ctx.save()
      ctx.scale(sgn, 1)
      ctx.translate(92, -52)
      ctx.rotate(-(0.28 + this.perk * 0.3) + this.startle * 0.35 + flap)
      ctx.fillStyle = p.furDark
      ellipse(ctx, 16, 58, 40, 80)
      ctx.restore()
    }

    ctx.fillStyle = p.fur
    ellipse(ctx, 0, 0, 128, 116)

    if (p.pattern === 'patch') {
      ctx.fillStyle = p.furDark
      ellipse(ctx, -48, -18, 38, 34, -0.3)
    }

    // 주둥이
    ctx.fillStyle = p.belly
    ellipse(ctx, 0, 45, 68, 52)

    this.drawBlush(ctx, 80, 28)
    this.drawDogEyes(ctx)

    // 혀
    if (this.happy > 0.35) {
      ctx.fillStyle = '#ff8a9a'
      const h = 10 + this.happy * 14 + Math.sin(this.t * 12) * 2 * this.petting
      ellipse(ctx, 0, 58 + h * 0.5, 13, h)
    }

    // 코
    const sniffScale = 1 + this.sniffing * Math.sin(this.t * 30) * 0.08
    ctx.save()
    ctx.translate(0, 18)
    ctx.scale(sniffScale, sniffScale)
    ctx.fillStyle = '#2a1f1a'
    roundedNose(ctx, 22, 15)
    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    ellipse(ctx, -6, -5, 6, 3.5)
    ctx.restore()

    // 입
    ctx.strokeStyle = '#3a2a20'
    ctx.lineWidth = 4
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(0, 32)
    ctx.lineTo(0, 44)
    const smile = 10 + this.happy * 8 - this.startle * 12
    ctx.moveTo(0, 44)
    ctx.quadraticCurveTo(-14, 44 + smile, -28, 46)
    ctx.moveTo(0, 44)
    ctx.quadraticCurveTo(14, 44 + smile, 28, 46)
    ctx.stroke()
  }

  private drawDogEyes(ctx: CanvasRenderingContext2D) {
    for (const sgn of [-1, 1]) {
      const ex = sgn * 46
      const ey = -14
      if (this.happy > 0.55 && this.startle < 0.2) {
        happyEye(ctx, ex, ey, 15)
        continue
      }
      const open = 1 - this.blink
      const r = 15 + this.startle * 4
      ctx.save()
      ctx.translate(ex + this.lookX * 5, ey + this.lookY * 4)
      ctx.scale(1, Math.max(0.08, open))
      if (this.startle > 0.3) {
        ctx.fillStyle = '#fff'
        ellipse(ctx, 0, 0, r + 5, r + 5)
      }
      ctx.fillStyle = this.p.eye
      ellipse(ctx, 0, 0, r, r)
      ctx.fillStyle = '#fff'
      ellipse(ctx, -r * 0.35, -r * 0.35, r * 0.32, r * 0.32)
      ctx.restore()
    }
  }

  private drawCatHead(ctx: CanvasRenderingContext2D) {
    const { p } = this

    // 귀 (뾰족한 귀). 놀라면 옆으로 눕는다
    for (const sgn of [-1, 1]) {
      ctx.save()
      ctx.scale(sgn, 1)
      ctx.translate(68, -70)
      ctx.rotate(0.08 + this.startle * 0.85 - this.perk * 0.06 + Math.sin(this.t * 3.1 + sgn) * 0.02)
      ctx.fillStyle = p.fur
      ctx.beginPath()
      ctx.moveTo(-48, 18)
      ctx.quadraticCurveTo(-8, -70, 12, -88)
      ctx.quadraticCurveTo(40, -40, 55, 22)
      ctx.closePath()
      ctx.fill()
      ctx.fillStyle = '#f5b5b5'
      ctx.beginPath()
      ctx.moveTo(-28, 10)
      ctx.quadraticCurveTo(-2, -48, 10, -62)
      ctx.quadraticCurveTo(28, -30, 36, 12)
      ctx.closePath()
      ctx.fill()
      ctx.restore()
    }

    ctx.fillStyle = p.fur
    ellipse(ctx, 0, 0, 126, 108)

    if (p.pattern === 'tabby') {
      ctx.strokeStyle = p.furDark
      ctx.lineWidth = 8
      ctx.lineCap = 'round'
      ctx.beginPath()
      for (const x of [-24, 0, 24]) {
        ctx.moveTo(x, -98)
        ctx.lineTo(x * 0.8, -62 + Math.abs(x) * 0.4)
      }
      for (const sgn of [-1, 1]) {
        ctx.moveTo(sgn * 124, 0)
        ctx.lineTo(sgn * 96, 6)
        ctx.moveTo(sgn * 120, 24)
        ctx.lineTo(sgn * 94, 24)
      }
      ctx.stroke()
    }

    // 주둥이
    ctx.fillStyle = p.belly
    ellipse(ctx, -17, 40, 24, 18)
    ellipse(ctx, 17, 40, 24, 18)
    ellipse(ctx, 0, 58, 22, 14)

    this.drawBlush(ctx, 76, 30)
    this.drawCatEyes(ctx)

    // 코
    const sniffScale = 1 + this.sniffing * Math.sin(this.t * 30) * 0.12
    ctx.save()
    ctx.translate(0, 26)
    ctx.scale(sniffScale, sniffScale)
    ctx.fillStyle = '#e88a95'
    ctx.beginPath()
    ctx.moveTo(-10, -5)
    ctx.quadraticCurveTo(0, -9, 10, -5)
    ctx.quadraticCurveTo(4, 4, 0, 6)
    ctx.quadraticCurveTo(-4, 4, -10, -5)
    ctx.fill()
    ctx.restore()

    // 입 (ω)
    ctx.strokeStyle = '#5a4040'
    ctx.lineWidth = 3.5
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(0, 32)
    ctx.lineTo(0, 38)
    ctx.moveTo(0, 38)
    ctx.quadraticCurveTo(-9, 48, -18, 40)
    ctx.moveTo(0, 38)
    ctx.quadraticCurveTo(9, 48, 18, 40)
    ctx.stroke()

    // 수염
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = 2.5
    const twitch = Math.sin(this.t * 7) * 3 * (this.sniffing + this.perk * 0.3)
    ctx.beginPath()
    for (const sgn of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        ctx.moveTo(sgn * 38, 36 + i * 8)
        ctx.lineTo(sgn * 125, 22 + i * 16 + twitch)
      }
    }
    ctx.stroke()
  }

  private drawCatEyes(ctx: CanvasRenderingContext2D) {
    for (const sgn of [-1, 1]) {
      const ex = sgn * 48
      const ey = -8
      if (this.happy > 0.55 && this.startle < 0.2) {
        happyEye(ctx, ex, ey, 17)
        continue
      }
      const open = 1 - this.blink
      ctx.save()
      ctx.translate(ex, ey)
      ctx.scale(1, Math.max(0.08, open * (1 - this.happy * 0.35)))
      ctx.fillStyle = this.p.eye
      ellipse(ctx, 0, 0, 22, 21)
      // 동공: 평소엔 세로로 가늘고, 놀라거나 손에 관심을 보이면 커진다
      const dilate = Math.max(this.startle, this.perk * 0.5)
      ctx.fillStyle = '#1b1b1b'
      ellipse(ctx, this.lookX * 6, this.lookY * 4, 5 + dilate * 10, 17 - dilate * 2)
      ctx.fillStyle = '#fff'
      ellipse(ctx, -7, -8, 5, 5)
      ctx.restore()
    }
  }

  /** 겁 많은 아이: 어디에 손을 내밀어야 하는지와 진행 정도를 보여준다 */
  private drawSniffTarget(ctx: CanvasRenderingContext2D) {
    const { x, y } = this.nose
    const pulse = this.handNearNose ? 0 : Math.sin(this.t * 3) * 6
    const r = SNIFF_RADIUS * 0.75 + pulse
    ctx.save()
    ctx.lineWidth = 5
    ctx.setLineDash([10, 10])
    ctx.lineDashOffset = -this.t * 20
    ctx.strokeStyle = this.handNearNose ? 'rgba(255, 138, 61, 0.9)' : 'rgba(255, 138, 61, 0.45)'
    ctx.beginPath()
    ctx.arc(x, y, r, 0, TAU)
    ctx.stroke()
    if (this.sniffProgress > 0.01) {
      ctx.setLineDash([])
      ctx.lineWidth = 9
      ctx.lineCap = 'round'
      ctx.strokeStyle = '#ff8a3d'
      ctx.beginPath()
      ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, this.sniffProgress))
      ctx.stroke()
    }
    if (!this.handNearNose) {
      ctx.setLineDash([])
      const label = '여기에 손을 내밀어 주세요'
      ctx.font = '600 22px system-ui, sans-serif'
      const w = ctx.measureText(label).width + 32
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)'
      ctx.beginPath()
      ctx.roundRect(x - w / 2, y + r + 12, w, 40, 20)
      ctx.fill()
      ctx.fillStyle = '#4a3322'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, x, y + r + 33)
    }
    ctx.restore()
  }

  private drawBlush(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const a = this.happy * 0.55
    if (a < 0.02) return
    ctx.fillStyle = `rgba(255, 120, 140, ${a})`
    ellipse(ctx, -x, y, 19, 11)
    ellipse(ctx, x, y, 19, 11)
  }

  /** 말풍선을 띄울 위치 (머리 위) */
  get bubbleAnchor() {
    return { x: this.leanX, y: this.L.headY - this.L.headRy - 25 }
  }
}

const BLINK_CLOSE = 0.07
const BLINK_OPEN = 0.13
/** 손이 이보다 빨리(로컬 단위/초) 다가오면 움찔한다 */
const FLINCH_SPEED = 1100
/** 손 주기: 손바닥을 이 시간(초) 동안 이 속도(로컬 단위/초) 아래로 가만히 두면 앞발을 올린다 */
const PAW_HOLD = 0.8
/** 겁 많은 아이가 냄새를 맡기 전이면 더 오래 */
const PAW_HOLD_SHY = 1.4
/** 실제 카메라는 가만히 둔 손도 조금씩 떨려 보여서 넉넉하게 */
const PAW_STILL = 260
/** 말로 시켰을 때: 이 시간 안에 앞발을 준다, 손이 없으면 이만큼 들고 있다 */
const PAW_COMMAND_WINDOW = 1
const PAW_AIR_SECONDS = 2.5
/** 손 없이 앞에 들고 있는 상태의 이름 (손 id 대신) */
const PAW_AIR = 'air'
/** 손이 초당 이 비율보다 빨리 커지면(카메라 쪽으로 불쑥 내밀면) 움찔한다 */
const FLINCH_ZOOM = 1.6

const smooth01 = (x: number) => x * x * (3 - 2 * x)

const MILESTONES = [20, 50, 80, 100]

function milestoneLine(p: PetProfile, i: number) {
  const n = p.name
  const dog = [
    `${josa(n, '이', '가')} 꼬리를 살랑살랑 흔들기 시작했어요`,
    `당신의 손길이 좋은가 봐요!`,
    `${josa(n, '이', '가')} 몸을 기대 오네요`,
    `${josa(n, '이', '가')} 당신을 완전히 믿게 되었어요 💛`,
  ]
  const cat = [
    `${josa(n, '이', '가')} 눈을 천천히 깜빡여요`,
    `골골골… 기분이 좋아졌어요`,
    `${josa(n, '이', '가')} 머리를 부비부비 해요`,
    `${josa(n, '이', '가')} 당신을 완전히 믿게 되었어요 💛`,
  ]
  return (p.species === 'dog' ? dog : cat)[i]
}

function bothHandsLine(p: PetProfile) {
  return p.species === 'dog'
    ? `양손으로 쓰다듬어 주니 ${josa(p.name, '이', '가')} 녹아내려요`
    : `양손 쓰담쓰담… ${josa(p.name, '이', '가')} 골골송을 크게 불러요`
}

function pettingLine(species: PetProfile['species']) {
  const lines =
    species === 'dog'
      ? ['헥헥, 좋아요!', '꼬리가 멈추질 않아요', '더 해주세요!']
      : ['그르릉…', '골골송을 불러요', '눈이 스르르 감겨요']
  return lines[Math.floor(Math.random() * lines.length)]
}

function favoriteLine(species: PetProfile['species'], zone: Zone) {
  if (zone === 'chin') return species === 'cat' ? '거기예요, 거기! 턱 밑 최고…' : '턱 밑이 시원해요!'
  if (zone === 'body') return '등 쓰다듬기 최고예요!'
  return species === 'cat' ? '머리 쓰담쓰담 좋아요…' : '머리 쓰다듬어 주는 거 제일 좋아요!'
}

// ───────────────────────── 그리기 도우미 ─────────────────────────

function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rot = 0) {
  ctx.beginPath()
  ctx.ellipse(x, y, rx, ry, rot, 0, TAU)
  ctx.fill()
}

function happyEye(ctx: CanvasRenderingContext2D, x: number, y: number, w: number) {
  ctx.save()
  ctx.strokeStyle = '#2b1d14'
  ctx.lineWidth = 5
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(x - w, y + 4)
  ctx.quadraticCurveTo(x, y - w, x + w, y + 4)
  ctx.stroke()
  ctx.restore()
}

function roundedNose(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.beginPath()
  ctx.moveTo(-w, -h * 0.4)
  ctx.quadraticCurveTo(-w, -h, 0, -h)
  ctx.quadraticCurveTo(w, -h, w, -h * 0.4)
  ctx.quadraticCurveTo(w * 0.6, h, 0, h)
  ctx.quadraticCurveTo(-w * 0.6, h, -w, -h * 0.4)
  ctx.fill()
}

function mid(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** 손 전체(손바닥 중심 + 21개 점) 중 가장 가까운 점까지의 거리 */
function handDistance(input: PetInput, target: { x: number; y: number }) {
  let d = Math.hypot(input.x - target.x, input.y - target.y)
  for (const p of input.points) d = Math.min(d, Math.hypot(p.x - target.x, p.y - target.y))
  return d
}

function bez(a: number, b: number, c: number, d: number, t: number) {
  const u = 1 - t
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d
}
