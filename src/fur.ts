import type { Pose } from './pet'
import { FLOOR_Y, type ExpressionLayer, type PhotoRig, type Zone } from './pets'

/**
 * 실사 사진 + 털 셰이더 렌더러 (WebGL1, 라이브러리 없음).
 *
 * 사진 한 장을 사각형 하나에 그리고, 조각 셰이더에서 좌표를 비틀어 생명감을 준다.
 * - 쓰다듬은 자리의 털이 손이 움직인 방향으로 눕고, 손을 떼면 스프링처럼 살짝 튕기며 돌아온다
 * - 결 방향으로 누운 털은 밝게 빛나고, 결을 거슬러 쓸면 속털이 드러나 어두워진다
 * - 숨쉬기, 머리 기울임, 귀 움직임, 눈 깜빡임, 코 킁킁, 털 끝의 미세한 흔들림
 *
 * 성능: 텍스처 3장, 한 번의 그리기, 픽셀당 텍스처 조회 5~6회. 쓰다듬기 격자는 48x96이라 CPU 비용이 거의 없다.
 */

export interface FurContact {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  r: number
  touch: boolean
}

/** 닿지 않고 흔드는 손이 털을 흔드는 세기 (닿은 손 대비) */
const AIR_STRENGTH = 0.3

const FIELD_W = 48
const FIELD_H = 96

/** 쓰다듬은 자리의 털 변형 (사진 좌표 위의 저해상도 격자). 셀마다 감쇠 스프링으로 원래 자리로 돌아간다 */
export class FurField {
  readonly data = new Uint8Array(FIELD_W * FIELD_H * 4)
  private dx = new Float32Array(FIELD_W * FIELD_H)
  private dy = new Float32Array(FIELD_W * FIELD_H)
  private vx = new Float32Array(FIELD_W * FIELD_H)
  private vy = new Float32Array(FIELD_W * FIELD_H)
  private press = new Float32Array(FIELD_W * FIELD_H)
  /** 튕기지 않고 천천히 돌아오는 털 (FurRenderer가 움직임 묶음에 맞춰 정한다) */
  soft = false
  /** 손마다 지난 접촉 위치 (빠르게 움직여도 선을 따라 빈틈없이 찍기 위해) */
  private last = new Map<string, { x: number; y: number }>()
  /** 격자가 조금이라도 움직였으면 true. false면 텍스처 업로드를 건너뛴다 */
  dirty = true
  private settled = false
  private readonly rig: PhotoRig

  constructor(rig: PhotoRig) {
    this.rig = rig
    this.encode()
  }

  reset() {
    this.dx.fill(0)
    this.dy.fill(0)
    this.vx.fill(0)
    this.vy.fill(0)
    this.press.fill(0)
    this.last.clear()
    this.settled = false
  }

  /**
   * contacts: 손마다 손바닥 중심(사진 픽셀), 속도(픽셀/초), 반지름(픽셀).
   * touch가 false면 털 가까이서 흔드는 손이다. 손바람처럼 약하게 털을 흔들고 누르지는 않는다.
   */
  update(dt: number, contacts: FurContact[]) {
    const n = FIELD_W * FIELD_H
    const cw = this.rig.width / FIELD_W
    const ch = this.rig.height / FIELD_H
    // 스프링: 초당 약 1.2번 흔들리고, 한 번쯤 살짝 넘어갔다 돌아온다.
    // soft면 튕기지 않고 1초쯤에 걸쳐 천천히 제자리로 (자동 기준점 아이: 튕김이 사진 출렁임으로 보인다)
    const k = this.soft ? 9 : 58
    const c = this.soft ? 6.6 : 8.5
    const touched = new Uint8Array(n)

    for (const contact of contacts) {
      const speed = Math.hypot(contact.vx, contact.vy)
      const strength = Math.min(1, speed / 700) * (contact.touch ? 1 : AIR_STRENGTH)
      const tx = speed > 1 ? (contact.vx / speed) * strength : 0
      const ty = speed > 1 ? (contact.vy / speed) * strength : 0
      // 빠르게 움직여도 틈이 생기지 않게 지난 위치부터 선을 따라 찍는다
      const from = this.last.get(contact.id) ?? contact
      const len = Math.hypot(contact.x - from.x, contact.y - from.y)
      const steps = Math.max(1, Math.ceil(len / (contact.r * 0.4)))
      const follow = 1 - Math.exp(-dt * 14)
      for (let s = 1; s <= steps; s++) {
        const px = from.x + ((contact.x - from.x) * s) / steps
        const py = from.y + ((contact.y - from.y) * s) / steps
        const r = contact.r
        const gx0 = Math.max(0, Math.floor((px - r) / cw))
        const gx1 = Math.min(FIELD_W - 1, Math.ceil((px + r) / cw))
        const gy0 = Math.max(0, Math.floor((py - r) / ch))
        const gy1 = Math.min(FIELD_H - 1, Math.ceil((py + r) / ch))
        for (let gy = gy0; gy <= gy1; gy++) {
          for (let gx = gx0; gx <= gx1; gx++) {
            const ox = (gx + 0.5) * cw - px
            const oy = (gy + 0.5) * ch - py
            const q = 1 - (ox * ox + oy * oy) / (r * r)
            if (q <= 0) continue
            const w = q * q
            const i = gy * FIELD_W + gx
            const a = (w * follow) / steps
            // 손 아래 털은 손이 끌고 간다 (속도도 같이 맞춰 손을 떼는 순간 자연스럽게 튕긴다)
            const ndx = this.dx[i] + (tx - this.dx[i]) * a
            const ndy = this.dy[i] + (ty - this.dy[i]) * a
            // 손을 떼는 순간의 튕김이 과하지 않게 속도에 상한을 둔다
            this.vx[i] = clamp((ndx - this.dx[i]) / Math.max(dt, 1e-3), -3, 3)
            this.vy[i] = clamp((ndy - this.dy[i]) / Math.max(dt, 1e-3), -3, 3)
            this.dx[i] = ndx
            this.dy[i] = ndy
            if (contact.touch) this.press[i] = Math.max(this.press[i], w * 0.9)
            touched[i] = 1
          }
        }
      }
      this.last.set(contact.id, { x: contact.x, y: contact.y })
      this.settled = false
    }
    for (const id of this.last.keys()) if (!contacts.some((c) => c.id === id)) this.last.delete(id)

    if (this.settled) return

    // 이웃 칸과 조금씩 섞는다. 변형이 급하게 바뀌면 사진이 접힌 것처럼 보이므로 매끈하게 유지한다
    smooth(this.dx)
    smooth(this.dy)

    let energy = 0
    const pressDecay = Math.exp(-dt * 2.2)
    for (let i = 0; i < n; i++) {
      if (!touched[i]) {
        // 반암시적 오일러: 큰 dt에서도 튀지 않는다
        this.vx[i] += (-k * this.dx[i] - c * this.vx[i]) * dt
        this.vy[i] += (-k * this.dy[i] - c * this.vy[i]) * dt
        this.dx[i] += this.vx[i] * dt
        this.dy[i] += this.vy[i] * dt
        this.press[i] *= pressDecay
      }
      energy += Math.abs(this.dx[i]) + Math.abs(this.dy[i]) + Math.abs(this.vx[i]) * 0.05 + this.press[i]
    }
    this.encode()
    this.dirty = true
    if (!contacts.length && energy < 0.5) {
      this.reset()
      this.encode()
      this.settled = true
    }
  }

  private encode() {
    const d = this.data
    for (let i = 0; i < FIELD_W * FIELD_H; i++) {
      d[i * 4] = Math.round((Math.max(-1, Math.min(1, this.dx[i])) * 0.5 + 0.5) * 255)
      d[i * 4 + 1] = Math.round((Math.max(-1, Math.min(1, this.dy[i])) * 0.5 + 0.5) * 255)
      d[i * 4 + 2] = Math.round(Math.min(1, this.press[i]) * 255)
      d[i * 4 + 3] = 255
    }
  }
}

/** 손 하나의 상태 (사진 픽셀 단위). touch: 편 손이 몸에 닿음, near: 닿진 않았지만 얼굴 가까이 있음 */
export interface MotionHand {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  r: number
  touch: boolean
  near: boolean
  /** 닿은 부위 (touch일 때) */
  zone: Zone | null
  /** 몸에 닿은 손끝들 (사진 픽셀). 눈가를 손끝으로 만져도 눈을 감는다 */
  tips: { x: number; y: number }[]
}

/**
 * 손길을 따라 얼굴이 움직이는 2차 모션.
 * - 머리: 한 덩어리로 움직인다. 닿은 손 쪽으로 조금 끌려가며 목을 중심으로 기울고, 출렁이지 않고 곧 멈춘다
 *   (부분만 늘이거나 오래 출렁이면 젤리처럼 보인다)
 * - 귀: 머리가 움직이면 한 박자 늦게 한두 번 흔들리고, 손이 귀를 쓸면 손에 밀려 들린다
 * - 고개 돌리기/들기(yaw/pitch): 얼굴에 손을 댄 채 옮기면 그만큼 고개가 따라간다.
 *   턱 밑에 손을 대고 올리면 고개를 들고, 볼을 옆으로 밀면 그쪽으로 돈다. 가까이 있는 손 쪽을 살짝 바라본다
 * - 턱: 턱 밑을 긁어주면 들어 올린다
 * - 눈썹: 손이 다가오면 올라가고, 손이 있는 쪽이 더 올라간다
 * 부위마다 늘이지 않고 덩어리째 조금만 움직인다
 * 계산은 펫 로컬 단위로 하고, 렌더러가 사진 픽셀로 바꾼다.
 */
export class FaceMotion {
  ox = 0
  oy = 0
  private vx = 0
  private vy = 0
  rot = 0
  private vr = 0
  earL = 0
  earR = 0
  private vEarL = 0
  private vEarR = 0
  /** 고개 돌리기(+면 화면 오른쪽), 고개 들기(+면 위) : -1~1 */
  yaw = 0
  pitch = 0
  private vYaw = 0
  private vPitch = 0
  /** 손이 얼굴에 처음 닿은 자리. 여기서 손이 옮겨간 만큼 고개가 따라간다 */
  private anchors = new Map<string, { x: number; y: number }>()
  /** 코: 얼굴과 따로 움직인다 (펫 로컬 단위). squash: 코를 톡 건드리면 눌린다, flare: 콧구멍 벌름 (0~1) */
  noseX = 0
  noseY = 0
  private vNoseX = 0
  private vNoseY = 0
  noseSquash = 0
  flare = 0
  private twitchIn = 3
  private twitchT = 99
  /** 눈가를 만져 눈을 감은 정도 (0~1, 눈마다) */
  eyeTouchL = 0
  eyeTouchR = 0
  /** 0~1 */
  chinLift = 0
  browL = 0
  browR = 0
  private readonly rig: PhotoRig

  constructor(rig: PhotoRig) {
    this.rig = rig
  }

  /** 머리가 움직이는 속도 (펫 로컬 단위/초). 털끝이 이만큼 늦게 따라온다 */
  get velocity() {
    return { x: this.vx, y: this.vy }
  }

  update(dt: number, hands: MotionHand[], pose: Pose) {
    const { rig } = this
    const s = rig.scale
    // 같은 시각의 프레임이 두 번 오면 dt가 0이 되고, 가속도 계산이 0/0이 되어 얼굴 전체가 망가진다
    if (!(dt > 0)) return
    dt = Math.min(dt, 1 / 30)

    // ── 머리 ──
    let restX = 0
    let restY = 0
    let fx = 0
    let fy = 0
    let fr = 0
    for (const h of hands) {
      const V = limit(h.vx * s, h.vy * s, HAND_V_MAX)
      if (h.touch) {
        // 머리는 무거워서 손에 끌려다니지 않는다. 미는 반대쪽으로 버티며 늦게 조금 반응한다 (관성)
        fx -= BRACE * V.x
        fy -= BRACE * V.y
        const px = (h.x - rig.neck.x) * s
        const py = (h.y - rig.neck.y) * s
        const omega = (px * V.y - py * V.x) / (px * px + py * py + 2500)
        fr -= 0.5 * omega
      } else if (h.near) {
        // 가까이 있는 손 쪽으로 고개를 아주 조금 내민다 (손을 따라 흔들리지는 않는다)
        restX += clamp((h.x - rig.head.x) * s * 0.015, -1.5, 1.5)
        restY += clamp((h.y - rig.head.y) * s * 0.01, -1, 1)
      }
    }
    // 턱 밑을 긁어주면 목을 쭉 빼듯 머리 전체도 조금 올라간다
    restY -= this.chinLift * 3
    const pvx = this.vx
    const pvy = this.vy
    this.vx += (-HEAD_K * (this.ox - restX) - HEAD_C * this.vx + fx) * dt
    this.vy += (-HEAD_K * (this.oy - restY) - HEAD_C * this.vy + fy) * dt
    this.ox = clamp(this.ox + this.vx * dt, -HEAD_MAX * 3, HEAD_MAX * 3)
    this.oy = clamp(this.oy + this.vy * dt, -HEAD_MAX * 3, HEAD_MAX * 3)
    this.vr += (-ROT_K * this.rot - ROT_C * this.vr + fr) * dt
    this.rot = clamp(this.rot + this.vr * dt, -ROT_MAX * 3, ROT_MAX * 3)

    // ── 귀: 머리가 가속하면 귀 끝은 제자리에 남으려 해서 반대로 흔들린다 ──
    const ax = (this.vx - pvx) / dt
    const ay = (this.vy - pvy) / dt
    // 손이 귀를 쓸면 귀가 붙은 곳을 중심으로 손을 따라 돈다 (화면 기준 시계 방향이 +)
    let pushL = 0
    let pushR = 0
    for (const h of hands) {
      if (!h.touch) continue
      const V = limit(h.vx * s, h.vy * s, HAND_V_MAX)
      rig.ears.forEach((e, k) => {
        const ex = (h.x - e.x) / (e.rx * 1.2)
        const ey = (h.y - e.y) / (e.ry * 1.2)
        if (ex * ex + ey * ey > 1) return
        const px = (h.x - e.px) * s
        const py = (h.y - e.py) * s
        const omega = (px * V.y - py * V.x) / (px * px + py * py + 900)
        // 왼쪽 귀는 시계 방향이 바깥, 오른쪽 귀는 반시계 방향이 바깥
        if (k === 0) pushL += 5 * (omega - this.vEarL)
        else pushR += 5 * (-omega - this.vEarR)
      })
    }
    // 귀 한쪽 까딱 (행동 스케줄러가 한 프레임만 힘을 준다)
    this.vEarL += pose.earKickL
    this.vEarR += pose.earKickR
    this.vEarL += (-EAR_K * this.earL - EAR_C * this.vEarL + EAR_G * (ax + ay * 0.6) + pushL) * dt
    this.vEarR += (-EAR_K * this.earR - EAR_C * this.vEarR + EAR_G * (-ax + ay * 0.6) + pushR) * dt
    this.earL = clamp(this.earL + this.vEarL * dt, -EAR_MAX, EAR_MAX)
    this.earR = clamp(this.earR + this.vEarR * dt, -EAR_MAX, EAR_MAX)

    // ── 턱: 턱 밑을 긁는 동안 천천히 들고, 손을 떼면 내린다 ──
    const chinTouched = hands.some((h) => h.touch && h.zone === 'chin')
    this.chinLift = ease(this.chinLift, chinTouched ? 1 : 0, chinTouched ? 3 : 2.5, dt)

    // ── 고개 돌리기/들기 ──
    // 쓰다듬을 때는 손을 따라가지 않는다(그러면 얼굴이 손에 붙은 슬라임처럼 보인다). 미는 반대쪽으로 살짝 버틴다.
    // 손이 턱을 위로 받쳐 올릴 때만 그만큼 고개를 든다
    // 두리번거리기(행동 스케줄러), 움찔하면 고개를 뒤로 빼며 살짝 숙인다
    // 턱을 긁어주면 시원해서 고개를 든다 (고양이는 더 높이). 고양이는 부비부비할 때 손 쪽으로 고개를 민다
    let ty = pose.idleYaw + pose.bunt * pose.buntSide * 0.3
    let tp = this.chinLift * (pose.species === 'cat' ? 0.6 : 0.3) + pose.idlePitch - pose.flinch * 0.35
    for (const h of hands) {
      const V = limit(h.vx * s, h.vy * s, HAND_V_MAX)
      if (h.touch && h.zone === 'chin') {
        const a = this.anchors.get(h.id) ?? { x: h.x, y: h.y }
        // 받쳐 든 채로 있으면 고개도 한동안 들고 있다가 천천히 내린다
        const follow = 1 - Math.exp(-dt * 0.2)
        a.x += (h.x - a.x) * follow
        a.y += (h.y - a.y) * follow
        this.anchors.set(h.id, a)
        tp += clamp((-(h.y - a.y) * s) / 34, 0, 0.9)
      } else if (h.touch) {
        this.anchors.delete(h.id)
        ty += clamp(-V.x / 1600, -0.2, 0.2)
        tp += clamp(V.y / 1600, -0.2, 0.2)
      } else if (h.near) {
        // 가까이 있는 손 쪽을 살짝 바라본다. 천천히 다가오는 손에는 코를 내밀듯 더 향한다
        const lean = 1 + pose.reach * 1.5
        ty += clamp(((h.x - rig.head.x) * s) / 260, -1, 1) * 0.15 * lean
        tp += clamp((-(h.y - rig.head.y) * s) / 260, -1, 1) * 0.1 * lean
      }
    }
    for (const id of this.anchors.keys()) if (!hands.some((h) => h.id === id && h.touch)) this.anchors.delete(id)
    ty = clamp(ty, -1, 1)
    tp = clamp(tp, -1, 1)
    this.vYaw += (-TURN_K * (this.yaw - ty) - TURN_C * this.vYaw) * dt
    this.vPitch += (-TURN_K * (this.pitch - tp) - TURN_C * this.vPitch) * dt
    this.yaw = clamp(this.yaw + this.vYaw * dt, -1.2, 1.2)
    this.pitch = clamp(this.pitch + this.vPitch * dt, -1.2, 1.2)

    // ── 눈썹: 관심(손이 가까움)과 놀람에 올라가고, 손 쪽이 더 올라간다. 기분 좋게 눈을 감으면 내려간다 ──
    const base = Math.max(pose.perk * 0.6, pose.startle, pose.flinch * 0.8) * (1 - pose.happy * 0.8)
    // 갸웃할 때는 궁금해서 눈썹이 올라가고, 기울이는 쪽이 더 올라간다
    const side = clamp(pose.lookX, -1, 1) * pose.perk * 0.4 + pose.cockSide * pose.curious * 0.35
    const curiousUp = pose.curious * 0.55
    this.browL = ease(this.browL, clamp(base + curiousUp - side, 0, 1), 6, dt)
    this.browR = ease(this.browR, clamp(base + curiousUp + side, 0, 1), 6, dt)

    // ── 눈가를 만지면 눈을 감는다: 닿은 쪽은 다 감고 반대쪽은 반쯤. 빨리 감고(0.15초) 손을 떼면 천천히 뜬다(0.5초) ──
    const D = Math.hypot(rig.eyes[1].x - rig.eyes[0].x, rig.eyes[1].y - rig.eyes[0].y)
    const near = (e: { x: number; y: number }) =>
      hands.some(
        (h) =>
          (h.touch && Math.hypot(h.x - e.x, (h.y - e.y) * 1.3) < D * EYE_TOUCH) ||
          h.tips.some((t) => Math.hypot(t.x - e.x, (t.y - e.y) * 1.3) < D * EYE_TOUCH * 0.5),
      )
    const tl = near(rig.eyes[0])
    const tr = near(rig.eyes[1])
    const goalL = tl ? 1 : tr ? 0.55 : 0
    const goalR = tr ? 1 : tl ? 0.55 : 0
    this.eyeTouchL = ease(this.eyeTouchL, goalL, goalL > this.eyeTouchL ? 20 : 6, dt)
    this.eyeTouchR = ease(this.eyeTouchR, goalR, goalR > this.eyeTouchR ? 20 : 6, dt)

    // ── 코 ──
    this.updateNose(dt, hands, pose)

    // 만에 하나 숫자가 깨지면(NaN) 셰이더가 사진 전체를 망가뜨리므로 제자리로 되돌린다
    const state = [this.ox, this.oy, this.vx, this.vy, this.rot, this.vr, this.earL, this.earR, this.vEarL, this.vEarR, this.yaw, this.pitch, this.vYaw, this.vPitch, this.noseX, this.noseY, this.vNoseX, this.vNoseY]
    if (!state.every(Number.isFinite)) this.reset()
  }

  /**
   * 코는 얼굴에서 떨어진 부위처럼 따로 움직인다.
   * - 킁킁: 냄새를 맡는 동안 코끝이 빠르게 씰룩이고 콧구멍이 벌름거린다
   * - 손 쪽으로: 손이 코 가까이 오면 코끝이 손 쪽으로 향한다
   * - 톡: 코를 건드리면 살짝 눌렸다가 돌아온다
   * - 가끔 저절로 몇 번 씰룩인다
   */
  private updateNose(dt: number, hands: MotionHand[], pose: Pose) {
    const { rig } = this
    const s = rig.scale
    const n = rig.nose
    let tx = 0
    let ty = 0
    let boop = 0
    for (const h of hands) {
      const dx = (h.x - n.x) * s
      const dy = (h.y - n.y) * s
      const d = Math.hypot(dx, dy)
      // 가까울수록 코끝을 손 쪽으로 (최대 2.5 로컬 단위)
      const reach = clamp(1 - d / 170, 0, 1) * 3
      if (d > 1) {
        tx += (dx / d) * reach
        ty += (dy / d) * reach * 0.6
      }
      const ex = (h.x - n.x) / (n.rx * 1.4)
      const ey = (h.y - n.y) / (n.ry * 1.4)
      // 코를 톡 건드리면 눌린다 (개만. 고양이 코는 만지지 않는다)
      if (pose.species === 'dog' && h.touch && ex * ex + ey * ey < 1) boop = 1
    }

    // 가끔 저절로 씰룩이기: 3~7초마다 0.5초 동안
    this.twitchIn -= dt
    if (this.twitchIn <= 0) {
      this.twitchT = 0
      this.twitchIn = 3 + Math.random() * 4
    }
    this.twitchT += dt
    const idle = this.twitchT < 0.5 ? Math.sin((this.twitchT / 0.5) * Math.PI) : 0
    const sniff = Math.max(pose.sniffing, idle * 0.7)
    const beat = Math.max(0, Math.sin(pose.t * 26)) // 초당 약 4번 킁킁
    ty -= sniff * beat * 2.2

    this.vNoseX += (-NOSE_K * (this.noseX - tx) - NOSE_C * this.vNoseX) * dt
    this.vNoseY += (-NOSE_K * (this.noseY - ty) - NOSE_C * this.vNoseY) * dt
    this.noseX = clamp(this.noseX + this.vNoseX * dt, -4, 4)
    this.noseY = clamp(this.noseY + this.vNoseY * dt, -4, 4)
    this.noseSquash = ease(this.noseSquash, boop, boop ? 14 : 5, dt)
    this.flare = ease(this.flare, sniff * beat, 20, dt)
  }

  reset() {
    this.ox = this.oy = this.vx = this.vy = this.rot = this.vr = 0
    this.earL = this.earR = this.vEarL = this.vEarR = 0
    this.yaw = this.pitch = this.vYaw = this.vPitch = 0
    this.chinLift = this.browL = this.browR = this.eyeTouchL = this.eyeTouchR = 0
    this.noseX = this.noseY = this.vNoseX = this.vNoseY = this.noseSquash = this.flare = 0
    this.anchors.clear()
  }

  /** 렌더링용: 크게 움직여도 부드럽게 한계에 닿도록 tanh로 누른다 */
  static soft(v: number, max: number) {
    return max * Math.tanh(v / max)
  }
}

// 머리: 거의 임계 감쇠라 넘치지 않고 멈춘다. 고개 돌리기가 주가 되므로 평행 이동은 작게
const HEAD_K = 60
const HEAD_C = 14
const HEAD_MAX = 3
/** 쓰다듬는 손이 미는 반대쪽으로 머리가 버티는 세기 */
const BRACE = 0.2
// 고개 돌리기/들기: 부드럽게 따라가고 넘치지 않는다
const TURN_K = 45
const TURN_C = 12.5
/** 고개를 끝까지 돌렸을 때 코끝이 움직이는 거리 (펫 로컬 단위) */
const YAW_SHIFT = 14
const PITCH_SHIFT = 12.5
/** 눈동자가 손을 따라 움직이는 폭 (눈 반지름 대비) */
const GAZE = 0.13
const ROT_K = 55
const ROT_C = 13
const ROT_MAX = 0.045
// 귀: 머리보다 가볍게 한두 번 흔들린다
const EAR_K = 50
const EAR_C = 5
const EAR_G = 0.004
const EAR_MAX = 0.16
/** 턱을 드는 거리, 눈썹이 올라가는 거리 (펫 로컬 단위) */
const CHIN_LIFT = 7
const BROW_LIFT = 3
/** 손바닥 중심이 눈에서 두 눈 사이 거리의 이 배수 안에 있으면 눈가를 만진 것으로 본다 */
const EYE_TOUCH = 0.6
// 코: 가볍고 빨라서 탱탱하게 따라간다
const NOSE_K = 140
const NOSE_C = 15
/** 인식이 순간 튀어 손이 순간이동해도 얼굴이 날아가지 않게 손 속도를 여기서 자른다 (펫 로컬 단위/초) */
const HAND_V_MAX = 1400

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const ease = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt))
const limit = (x: number, y: number, max: number) => {
  const m = Math.hypot(x, y)
  return m > max ? { x: (x / m) * max, y: (y / m) * max } : { x, y }
}

const tmp = new Float32Array(FIELD_W * FIELD_H)
function smooth(a: Float32Array) {
  tmp.set(a)
  for (let y = 1; y < FIELD_H - 1; y++) {
    for (let x = 1; x < FIELD_W - 1; x++) {
      const i = y * FIELD_W + x
      a[i] = tmp[i] * 0.6 + (tmp[i - 1] + tmp[i + 1] + tmp[i - FIELD_W] + tmp[i + FIELD_W]) * 0.1
    }
  }
}

const VERT = `
attribute vec2 aUv;
uniform vec4 uRect; // 클립 공간의 사진 사각형: x, y(위), w, h
varying vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(uRect.x + aUv.x * uRect.z, uRect.y - aUv.y * uRect.w, 0.0, 1.0);
}
`

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform sampler2D uImg;
uniform sampler2D uFlow;
uniform sampler2D uField;
uniform vec2 uSize;        // 사진 크기 (픽셀)
uniform float uTime;

uniform vec2 uFoot;        // 몸 중심선과 발바닥 (픽셀)
uniform float uShrink;     // 놀라서 움츠림
uniform float uShiver;     // 놀라서 떨림 (픽셀)

uniform vec4 uHead;        // 머리 타원 x, y, rx, ry
uniform vec2 uNeck;        // 머리가 도는 중심
uniform float uTilt;       // 머리 기울기 (라디안)
uniform vec2 uLean;        // 머리 기대기 (픽셀)

uniform vec4 uEarL;
uniform vec4 uEarR;
uniform vec4 uEarPivots;   // 왼쪽 귀 pivot xy, 오른쪽 귀 pivot xy
uniform float uEarRotL;    // 양수면 귀가 바깥 위로 들린다
uniform float uEarRotR;

uniform vec4 uChest;
uniform float uBreath;

uniform vec3 uEye0;        // x, y, r
uniform vec3 uEye1;
uniform vec2 uLid;         // 눈마다 (왼쪽, 오른쪽). 0 = 뜬 눈, 1 = 감은 눈
uniform vec4 uNose;
uniform vec2 uNoseOff;     // 코가 따로 움직인 거리 (픽셀)
uniform float uNoseSquash; // 코를 톡 건드려 눌린 정도 (0~1)
uniform vec4 uNostrils;    // 콧구멍 두 개의 중심 (x, y, x, y)
uniform float uNostrilR;
uniform float uFlare;      // 콧구멍 벌름 (0~1)
uniform float uCatEye;     // 그린 눈꺼풀을 고양이 눈 모양으로 (1)
uniform float uNoseGloss;  // 젖은 코 반사광 세기 (개 1, 고양이 0: 고양이 코는 마른 분홍색이라 빛나면 어색하다)

uniform float uFurShift;   // 쓰다듬을 때 털이 눕는 최대 거리 (픽셀)
uniform vec4 uBrow0;       // 눈썹 타원
uniform vec4 uBrow1;
uniform vec2 uBrowLift;    // 눈썹이 올라간 거리 (픽셀, 왼쪽/오른쪽)
uniform vec4 uChin;        // 아래턱 타원
uniform float uChinLift;   // 턱을 든 거리 (픽셀)
uniform float uWhisker;    // 수염 패드가 올라가며 수염이 펴지는 정도 (픽셀, 기분 좋은 고양이)
uniform vec4 uSkull;       // 깊이: 머리통
uniform vec4 uMuzzle;      // 깊이: 주둥이
uniform vec2 uTurn;        // 고개 돌리기/들기로 코끝이 움직이는 거리 (픽셀, 화면 방향)
uniform vec2 uGaze;        // 눈동자가 움직이는 방향 (-1~1)
uniform sampler2D uCatchImg; // 눈 반사광 조각 (눈마다 한 칸, 가로로 나란히)
uniform float uHasCatch;
// 표정 사진 (부위만 잘라 둔 것). box: 원본 사진 위 x, y, w, h (w가 0이면 없음)
uniform sampler2D uPantImg;
uniform sampler2D uEyesImg;
uniform sampler2D uEarsImg;
uniform vec4 uPantBox;
uniform vec4 uEyesBox;
uniform vec4 uEarsBox;
uniform vec4 uPantMask;
uniform vec4 uEyesMask0;
uniform vec4 uEyesMask1;
uniform vec4 uEarsMask0;
uniform vec4 uEarsMask1;
uniform float uPantW;      // 0~1
uniform float uPantKeepNose; // 1이면 입 표정을 섞을 때 코 둘레는 원본 그대로
uniform float uEarsW;      // 0~1
uniform vec3 uFrames;      // 표정마다 쌓인 단계 수 (입, 눈, 귀)
// 표정 단계 사이의 움직임 아틀라스 (scripts/prepare-morph.py). 칸마다 RG: 앞→뒤, BA: 뒤→앞 움직임
uniform sampler2D uMorph;
uniform float uMorphOn;
uniform float uMorphRange;
uniform vec4 uPantR0;
uniform vec4 uPantR1;
uniform vec4 uEyesR0;
uniform vec4 uEyesR1;
uniform vec4 uEarsR0;
uniform vec4 uEarsR1;
uniform vec4 uEarsSdfR;    // 귀 윤곽 거리장 칸 (R: 원본, G/B: 단계)
uniform float uSdfRange;
uniform vec3 uEarsFill;
uniform vec2 uFurLag;      // 머리가 움직일 때 털끝이 늦게 따라오는 거리 (픽셀)
uniform float uBreeze;     // 털끝 흔들림 세기 (픽셀)
uniform float uShimmer;    // 털끝 살랑임 (픽셀): 털 몇 가닥 크기의 짧은 물결이라 영역이 출렁이지 않고 털끝만 산다
uniform float uBreathFur;  // 숨 쉴 때 가슴 털이 결 따라 오르내리는 거리 (픽셀, 몸통 크기는 그대로)
uniform float uShadowAmt;  // 바닥 그림자 세기 (클로즈업 사진은 0)
uniform float uFadeFrom;   // 이 높이(픽셀)부터 아래로 서서히 투명해진다
uniform vec2 uFadeSides;   // 잘린 옆면 경계 (왼쪽 x, 오른쪽 x). 잘리지 않았으면 사진 밖

varying vec2 vUv;

float ellipseDist(vec2 p, vec4 e) {
  return length((p - e.xy) / e.zw);
}

vec2 rotateAround(vec2 p, vec2 pivot, float a) {
  float c = cos(a);
  float s = sin(a);
  vec2 d = p - pivot;
  return pivot + vec2(c * d.x - s * d.y, s * d.x + c * d.y);
}

vec4 img(vec2 px) {
  return texture2D(uImg, px / uSize);
}

/** 세로로 쌓인 표정 단계 중 frame번째 (0부터). 이웃 단계가 번지지 않게 그 칸 안으로 좌표를 묶는다 */
vec4 layer(sampler2D t, vec4 box, float frames, float frame, vec2 px) {
  vec2 uv = (px - box.xy) / box.zw;
  float texel = 0.5 / (box.w * frames);
  uv.y = (clamp(uv.y, texel * frames, 1.0 - texel * frames) + frame) / frames;
  return texture2D(t, uv);
}

/**
 * 윤곽이 다른 두 장을 섞는다. 그냥 겹치면 한쪽에만 있는 부분이 반투명하게 비치므로(유령),
 * 두 윤곽의 중간 모양을 거리장으로 만들어 그 안을 꽉 채운다. 끝(f=0, 1)에서는 원래 사진 그대로다
 */
vec4 morph(vec4 a, vec4 b, float sa, float sb, float f) {
  // 윤곽을 살짝 안쪽으로 잡아, 실제 털 끝 바깥에 테두리가 생기지 않게 한다
  float shape = smoothstep(-2.0, 6.0, mix(sa, sb, f));
  float wa = a.a * (1.0 - f);
  float wb = b.a * f;
  vec3 rgb = wa + wb > 0.02 ? (a.rgb * (1.0 - f) + b.rgb * f) / (wa + wb) : uEarsFill;
  // 양 끝의 짧은 순간만 원래 사진의 알파를 쓰고, 나머지는 보간한 윤곽을 그대로 쓴다 (중간에 겹쳐 비치지 않게)
  float k = smoothstep(0.0, 0.12, f) * smoothstep(1.0, 0.88, f);
  float alpha = mix(mix(a.a, b.a, f), shape, k);
  return vec4(rgb * alpha, alpha);
}

vec4 atlas(vec4 rect, vec4 box, vec2 px) {
  vec2 uv = clamp((px - box.xy) / box.zw, 0.0, 1.0);
  return texture2D(uMorph, rect.xy + uv * rect.zw);
}

/** 움직임 칸: 왼쪽 절반은 앞→뒤, 오른쪽 절반은 뒤→앞. xy: 앞→뒤, zw: 뒤→앞 (픽셀) */
vec4 motion(vec4 rect, vec4 box, vec2 px) {
  vec2 uv = clamp((px - box.xy) / box.zw, 0.02, 0.98);
  vec2 ab = texture2D(uMorph, rect.xy + vec2(uv.x * 0.5, uv.y) * rect.zw).rg;
  vec2 ba = texture2D(uMorph, rect.xy + vec2(0.5 + uv.x * 0.5, uv.y) * rect.zw).rg;
  return (vec4(ab, ba) - 0.5) * 2.0 * uMorphRange;
}

/**
 * 표정 단계 사이 w(0~1) 지점을 만든다. 영상 프레임 보간처럼 앞 장은 움직임 방향으로 밀고 뒤 장은 거꾸로 당겨,
 * 형태가 겹친 채로 섞는다. 그래서 사진이 바뀌는 게 아니라 턱이 내려가고 눈꺼풀이 내려오는 움직임으로 보인다.
 * a, b는 섞을 두 장(미리 민 것), f는 구간 안 위치, i는 구간 번호
 */
void tweenPair(sampler2D t, vec4 box, float frames, float w, vec2 px, vec4 r0, vec4 r1,
               out vec4 a, out vec4 b, out float f, out float i) {
  float s = w * frames;
  i = min(floor(s), frames - 1.0);
  f = s - i;
  vec4 fl = motion(i < 0.5 ? r0 : r1, box, px);
  vec2 pa = px - f * fl.xy;
  vec2 pb = px - (1.0 - f) * fl.zw;
  a = i < 0.5 ? img(pa) : layer(t, box, frames, i - 1.0, pa);
  b = layer(t, box, frames, i, pb);
}

vec4 tween(sampler2D t, vec4 box, float frames, float w, vec2 px, vec4 r0, vec4 r1) {
  vec4 a; vec4 b; float f; float i;
  tweenPair(t, box, frames, w, px, r0, r1, a, b, f, i);
  // 움직임은 처음부터 끝까지 이어지고, 두 장이 겹치는 순간은 가운데로 좁힌다.
  // 움직임이 다 못 맞춘 곳(두 장 색이 크게 다른 곳)은 반투명하게 겹쳐 보이지 않게 아주 짧게 넘긴다
  float diff = length(a.rgb - b.rgb) + abs(a.a - b.a);
  float k = mix(smoothstep(0.3, 0.7, f), smoothstep(0.42, 0.58, f), smoothstep(0.12, 0.3, diff));
  return mix(a, b, k);
}

/** 원본 → 1단계 → 2단계 … 순서로 이웃한 것끼리만 섞는다 (w: 0~1). 움직임 아틀라스가 없을 때 쓴다 */
vec4 staged(sampler2D t, vec4 box, float frames, float w, vec2 px, vec4 base) {
  float s = w * frames;
  float i = min(floor(s), frames - 1.0);
  float f = smoothstep(0.0, 1.0, s - i);
  vec4 from = i < 0.5 ? base : layer(t, box, frames, i - 1.0, px);
  return mix(from, layer(t, box, frames, i, px), f);
}

/** 얼굴의 깊이 (0: 귀·가장자리, 1: 코끝). 고개 돌리기의 입체감과 명암에 쓴다 */
float faceDepth(vec2 p) {
  return smoothstep(1.15, 0.0, ellipseDist(p, uSkull)) * 0.5 + smoothstep(1.1, 0.0, ellipseDist(p, uMuzzle)) * 0.5;
}

/** 값 잡음 (0~1). 털끝 살랑임에 쓴다 */
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

/** 타원 안은 1, 가장자리 30%에서 부드럽게 0으로 */
float region(vec2 p, vec4 e) {
  return 1.0 - smoothstep(0.7, 1.0, ellipseDist(p, e));
}

void main() {
  vec2 P = vUv * uSize;

  // ── 바닥 그림자 (비틀기 전 좌표) ──
  vec2 sp = (P - vec2(uFoot.x, uFoot.y - 6.0)) / vec2(uSize.x * 0.42, 34.0);
  float shadow = (1.0 - smoothstep(0.15, 1.0, length(sp))) * 0.26 * uShadowAmt;

  // ── 역방향 매핑: 화면 픽셀 P에 보일 사진 픽셀 Q를 찾는다 ──
  vec2 Q = uFoot + (P - uFoot) / (1.0 - uShrink);
  Q.x -= uShiver;

  // 머리: 목을 중심으로 기울이고 손 쪽으로 기댄다. 경계는 부드럽게 이어 목이 찢어지지 않게
  // 귀도 머리와 한 덩어리로 돈다 (머리 밖으로 삐져나온 귀가 제자리에 남으면 그 사이가 늘어나 슬라임처럼 보인다).
  // 목 쪽 경계는 넓게 풀어 목이 덜 늘어나게 한다
  float mh = max(1.0 - smoothstep(0.75, 1.55, ellipseDist(Q, uHead)),
                 max(1.0 - smoothstep(0.7, 1.6, ellipseDist(Q, uEarL)), 1.0 - smoothstep(0.7, 1.6, ellipseDist(Q, uEarR))));
  Q = rotateAround(Q, uNeck, -uTilt * mh) - uLean * mh;

  // 고개 돌리기/들기: 앞으로 튀어나온 부분(코끝 > 주둥이 > 눈·이마 > 귀)일수록 많이 움직여 입체적으로 돈다
  Q -= uTurn * faceDepth(Q);
  // 눈동자를 옮기기 전 좌표: 반사광과 명암은 눈동자를 따라가지 않는다
  vec2 Qturn = Q;

  // 눈동자: 눈 안쪽만 손 쪽으로 옮긴다 (가장자리는 고정해 눈꺼풀이 따라오지 않게)
  for (int k = 0; k < 2; k++) {
    vec3 eye = k == 0 ? uEye0 : uEye1;
    float m = 1.0 - smoothstep(0.5, 0.95, length(Q - eye.xy) / eye.z);
    Q -= uGaze * eye.z * m;
  }

  // 귀: 붙은 곳을 중심으로 흔든다. 경계를 넓게 풀어야 크게 흔들어도 사진이 접히지 않는다
  float mel = 1.0 - smoothstep(0.25, 1.45, ellipseDist(Q, uEarL));
  float mer = 1.0 - smoothstep(0.25, 1.45, ellipseDist(Q, uEarR));
  Q = rotateAround(Q, uEarPivots.xy, -uEarRotL * mel);
  Q = rotateAround(Q, uEarPivots.zw, uEarRotR * mer);

  // 턱과 눈썹: 부위를 늘이지 않고 덩어리째 위로 옮긴다 (경계는 넓게 풀어 접히지 않게)
  Q.y += uChinLift * (1.0 - smoothstep(0.3, 1.3, ellipseDist(Q, uChin)));
  // 수염: 코 양옆 볼(수염 패드)과 그 바깥 수염을 살짝 올리고 바깥으로 편다. 코와 입 가운데는 그대로
  if (uWhisker > 0.01) {
    float side = smoothstep(uNose.z * 0.6, uNose.z * 1.4, abs(Q.x - uNose.x));
    float band = 1.0 - smoothstep(0.4, 1.9, ellipseDist(Q, vec4(uNose.x, uNose.y + uNose.w * 0.9, uMuzzle.z * 1.7, uMuzzle.w * 0.9)));
    float w = side * band;
    Q.y += uWhisker * w;
    Q.x -= sign(Q.x - uNose.x) * uWhisker * 0.6 * w;
  }
  Q.y += uBrowLift.x * (1.0 - smoothstep(0.35, 1.1, ellipseDist(Q, uBrow0)));
  Q.y += uBrowLift.y * (1.0 - smoothstep(0.35, 1.1, ellipseDist(Q, uBrow1)));

  // 숨쉬기: 가슴이 부풀었다 가라앉는다
  float mc = 1.0 - smoothstep(0.2, 1.0, ellipseDist(Q, uChest));
  Q -= (Q - uChest.xy) * uBreath * mc;

  // 코: 얼굴과 따로 움직인다. 경계는 주둥이 쪽으로 넓게 풀어 떨어져 보이지 않게
  float mn = 1.0 - smoothstep(0.75, 1.6, ellipseDist(Q, uNose));
  Q -= uNoseOff * mn;
  Q.y = mix(Q.y, uNose.y + (Q.y - uNose.y) / (1.0 - 0.13 * uNoseSquash), mn);
  Q.x = mix(Q.x, uNose.x + (Q.x - uNose.x) / (1.0 + 0.06 * uNoseSquash), mn);
  for (int k = 0; k < 2; k++) {
    vec2 c = k == 0 ? uNostrils.xy : uNostrils.zw;
    float mf = 1.0 - smoothstep(0.5, 1.6, length(Q - c) / uNostrilR);
    Q -= (Q - c) * uFlare * 0.34 * mf;
  }

  // 눈과 코는 털처럼 밀리면 어색하므로 보호한다
  float protect = 1.0 - max(max(
    1.0 - smoothstep(1.1, 1.8, length(Q - uEye0.xy) / uEye0.z),
    1.0 - smoothstep(1.1, 1.8, length(Q - uEye1.xy) / uEye1.z)),
    1.0 - smoothstep(0.9, 1.4, ellipseDist(Q, uNose)));

  // ── 쓰다듬은 털 ──
  vec4 field = texture2D(uField, Q / uSize);
  vec2 d = (field.rg * 2.0 - 1.0) * protect;
  float dm = length(d);
  float press = field.b * protect;
  Q -= d * uFurShift;

  // ── 털 결 (미리 계산한 방향) 따라 털 끝이 미세하게 흔들린다 ──
  vec3 fl = texture2D(uFlow, Q / uSize).rgb;
  vec2 f2 = fl.rg * 2.0 - 1.0;
  float fa = atan(f2.y, f2.x) * 0.5;
  vec2 fdir = vec2(cos(fa), sin(fa));
  if (fdir.y < 0.0) fdir = -fdir; // 털은 대체로 아래로 자란다
  float breeze = sin(dot(Q, vec2(0.031, 0.052)) + uTime * 1.3) * sin(dot(Q, vec2(-0.043, 0.027)) - uTime * 0.9);
  // 윤곽 가까운 털(주변에 투명한 곳이 있는 털)일수록 가볍게 더 흔들리고 더 늦게 따라온다
  float around = min(min(img(Q + vec2(12.0, 0.0)).a, img(Q - vec2(12.0, 0.0)).a),
                     min(img(Q + vec2(0.0, 12.0)).a, img(Q - vec2(0.0, 12.0)).a));
  float edge = img(Q).a * (1.0 - around);
  float drift = sin(uTime * 0.7 + Q.y * 0.013 + Q.x * 0.007); // 윤곽 털이 천천히 나부낀다
  Q += fdir * (breeze * uBreeze * fl.b * (1.0 + 2.5 * edge) + drift * 1.2 * edge * min(1.0, uBreeze)) * protect;
  // 털끝 살랑임: 털 몇 가닥 크기(파장 약 18픽셀)의 잡음을 결 방향으로만, 시간에 따라 천천히 바꾼다.
  // 파장이 짧아 이웃 털끼리 따로 움직이므로 사진 영역이 통째로 출렁이지 않는다
  if (uShimmer > 0.0) {
    float sn = vnoise(Q * 0.055 + vec2(uTime * 0.45, -uTime * 0.3)) * 0.65 + vnoise(Q * 0.13 - vec2(uTime * 0.7, uTime * 0.5)) * 0.35;
    Q += fdir * (sn - 0.5) * 2.0 * uShimmer * (0.35 + 0.65 * fl.b) * (1.0 + 1.2 * edge) * protect;
  }
  // 숨쉬기(털): 가슴 쪽 털만 결 따라 아주 조금 오르내린다
  Q += fdir * uBreathFur * mc * protect;
  // 머리가 움직이면 털끝은 관성으로 늦게 따라온다 (결이 뚜렷한 긴 털일수록 더)
  Q += uFurLag * (0.55 + 0.45 * breeze) * (0.3 + 0.7 * fl.b) * (1.0 + 1.5 * edge) * protect;

  // ── 샘플링: 누운 털은 쓸린 방향으로 결이 길게 이어진다 (방향성 블러) ──
  // 무늬가 선명한 곳(줄무늬, 얼룩)에서는 번짐이 흐물흐물해 보이므로 줄인다
  float contrast = length(img(Q + vec2(6.0, 0.0)).rgb - img(Q - vec2(6.0, 0.0)).rgb)
                 + length(img(Q + vec2(0.0, 6.0)).rgb - img(Q - vec2(0.0, 6.0)).rgb);
  vec2 smear = d * mix(5.0, 1.5, smoothstep(0.1, 0.45, contrast));
  vec4 col = img(Q) * 0.3
    + (img(Q + smear * 0.5) + img(Q - smear * 0.5)) * 0.2
    + (img(Q + smear) + img(Q - smear)) * 0.15;

  // ── 표정 사진: 부위 안에서만 원본 위에 섞는다 ──
  if (uPantW > 0.001 && uPantBox.z > 0.0) {
    vec4 pant = uMorphOn > 0.5
      ? tween(uPantImg, uPantBox, uFrames.x, uPantW, Q, uPantR0, uPantR1)
      : staged(uPantImg, uPantBox, uFrames.x, uPantW, Q, col);
    // 코는 입 표정에 섞지 않고 원래 코를 둔다 (uPantKeepNose): 주둥이가 긴 개는 코가 입 범위 가장자리에 걸려
    // 원본 코와 AI 사진의 코가 반씩 섞이며 번져 코가 사라진 것처럼 보였다
    float keepNose = uPantKeepNose * (1.0 - smoothstep(1.0, 1.45, ellipseDist(Q, uNose)));
    col = mix(col, pant, region(Q, uPantMask) * (1.0 - keepNose));
  }
  if (uEarsW > 0.001 && uEarsBox.z > 0.0) {
    float m = max(region(Q, uEarsMask0), region(Q, uEarsMask1));
    vec4 ears;
    if (uMorphOn > 0.5) {
      // 귀는 윤곽 자체가 바뀌어 겹치면 반투명하게 비치므로, 색은 움직임으로 섞고 윤곽은 거리장으로 보간한다
      vec4 a; vec4 b; float f; float i;
      tweenPair(uEarsImg, uEarsBox, uFrames.z, uEarsW, Q, uEarsR0, uEarsR1, a, b, f, i);
      vec3 sd = (atlas(uEarsSdfR, uEarsBox, Q).rgb - 0.5) * 2.0 * uSdfRange;
      ears = i < 0.5 ? morph(a, b, sd.r, sd.g, f) : morph(a, b, sd.g, sd.b, f);
    } else {
      ears = staged(uEarsImg, uEarsBox, uFrames.z, uEarsW, Q, col);
    }
    col = mix(col, ears, m);
  }

  // ── 눈꺼풀 ──
  if (max(uLid.x, uLid.y) > 0.01) {
    if (uEyesBox.z > 0.0 && uMorphOn > 0.5) {
      // 뜬 눈 → 반쯤 감은 눈 → 감은 눈을 움직임으로 이어, 눈꺼풀이 실제로 내려오는 것처럼 보인다 (눈마다 따로)
      float m0 = region(Q, uEyesMask0);
      float m1 = region(Q, uEyesMask1);
      if (m0 > 0.0 && uLid.x > 0.01) col = mix(col, tween(uEyesImg, uEyesBox, uFrames.y, min(uLid.x, 1.0), Q, uEyesR0, uEyesR1), m0);
      if (m1 > 0.0 && uLid.y > 0.01) col = mix(col, tween(uEyesImg, uEyesBox, uFrames.y, min(uLid.y, 1.0), Q, uEyesR0, uEyesR1), m1);
    } else {
      for (int k = 0; k < 2; k++) {
        vec3 eye = k == 0 ? uEye0 : uEye1;
        float lid = k == 0 ? uLid.x : uLid.y;
        vec2 e = (Q - eye.xy) / eye.z;
        if (uEyesBox.z > 0.0) {
          // 움직임 아틀라스가 없으면: 단계마다 눈꺼풀 선이 위에서 내려오며 다음 사진을 드러낸다
          float m = region(Q, k == 0 ? uEyesMask0 : uEyesMask1);
          for (int i = 0; i < 2; i++) {
            float fi = float(i);
            if (fi >= uFrames.y) break;
            float l = clamp(lid * uFrames.y - fi, 0.0, 1.0);
            if (l <= 0.0) break;
            float lidY = mix(-1.3, 1.35, l) + 0.2 * e.x * e.x;
            float cover = smoothstep(lidY + 0.15, lidY - 0.15, e.y) * m;
            col = mix(col, layer(uEyesImg, uEyesBox, uFrames.y, fi, Q), cover);
          }
        } else {
          // 눈 감은 사진이 없으면 눈꺼풀을 그린다: 위·아래 눈꺼풀이 눈 둘레 털 색으로 덮고, 둥글게 휜 속눈썹 선에서 만난다.
          // (예전처럼 눈 위 한 곳의 털을 끌어내리면 밝은 눈썹 털이 늘어나 하얀 딱지처럼 보였다)
          // 고양이 눈은 크고 아몬드형이며 눈 둘레 테두리가 진하다: 가로로 더 넓게 덮고, 감은 선은 거의 일자로
          float cat = uCatEye;
          float r = length(vec2(e.x * mix(0.85, 0.78, cat), e.y));
          if (r < 1.65) {
            // 눈꺼풀 색: 눈 바깥 둘레 8곳의 평균 (눈 바로 옆의 어두운 테두리는 피해 조금 바깥에서)
            // (고양이는 눈 아래 눈물 자국·털색 차이가 커서 눈 위쪽 둘레를 더 믿는다)
            vec3 ring = vec3(0.0);
            float ringW = 0.0;
            for (int i = 0; i < 8; i++) {
              float a = float(i) * 0.7853982;
              float w = mix(1.0, sin(a) < -0.1 ? 1.0 : 0.35, cat);
              ring += img(eye.xy + vec2(cos(a) * mix(2.2, 1.6, cat), sin(a) * mix(1.9, 1.45, cat)) * eye.z).rgb * w;
              ringW += w;
            }
            ring /= ringW;
            // 털 무늬: 같은 모양 그대로 위쪽(눈 지름 하나 반 위) 털을 가져와, 그 자리 평균 색을 빼고 무늬만 얹는다 (늘이지 않아 줄무늬가 생기지 않는다)
            vec2 up = vec2(0.0, -2.6) * eye.z;
            vec3 patch = img(eye.xy + e * eye.z + up).rgb;
            vec3 patchMean = (img(eye.xy + up + vec2(-0.8, 0.0) * eye.z).rgb + img(eye.xy + up + vec2(0.8, 0.0) * eye.z).rgb + img(eye.xy + up).rgb) / 3.0;
            // (둘레 평균은 밝은 털이 섞여 눈꺼풀보다 조금 밝다)
            vec3 skin = ring * 0.98 + (patch - patchMean) * 0.6;
            // 위 눈꺼풀 끝: 감을수록 내려와 눈 아래쪽 1/3쯤에서 멈추고, 가운데가 아래로 둥글게 휜다
            float upper = mix(-1.1, mix(0.3, 0.12, cat), lid) - mix(0.2, 0.05, cat) * e.x * e.x;
            // 아래 눈꺼풀: 거의 다 감을 때만 조금 올라와 위 눈꺼풀과 만난다
            float lower = mix(1.3, upper + 0.02, smoothstep(0.6, 1.0, lid));
            float inUpper = smoothstep(upper + 0.07, upper - 0.07, e.y);
            float inLower = smoothstep(lower - 0.07, lower + 0.07, e.y);
            // 가장자리는 넓게 풀어 둘레 털에 녹아들게
            // 다 감을수록 눈 둘레의 어두운 테두리까지 덮도록 넓히고, 가장자리를 더 길게 풀어 둘레 털에 녹인다
            float full = smoothstep(0.7, 1.0, lid);
            // (고양이는 눈 반지름을 크게 잡아 두어 넓히지 않는다)
            float grow = full * (1.0 - cat);
            float m = max(inUpper, inLower) * smoothstep(mix(1.3, 1.65, grow), mix(1.02, 1.15, grow), r);
            // 위 눈꺼풀은 끝으로 갈수록 살짝 어둡게 (둥근 눈꺼풀의 그늘)
            float shade = 1.0 - 0.12 * smoothstep(upper - 0.6, upper, e.y) * inUpper;
            col.rgb = mix(col.rgb, skin * shade, m);
            // 속눈썹 선 (가운데가 가장 짙고 양끝으로 흐려진다)
            float lash = smoothstep(mix(0.07, 0.055, cat), 0.0, abs(e.y - upper)) * smoothstep(mix(1.0, 1.15, cat), 0.55, r) * smoothstep(0.05, 0.3, lid);
            col.rgb *= 1.0 - mix(0.5, 0.65, cat) * lash;
          }
        }
      }
    }
  }

  // ── 누운 털의 빛: 결 방향으로 쓸면 윤기가 돌고, 결을 거슬러 쓸면 속털이 드러나 어두워진다 ──
  //    사진의 털 무늬를 그대로 살리도록 곱해서 밝기만 바꾼다
  if (dm > 0.01) {
    // 결이 거의 수평이면 위아래(자라는 방향)를 알 수 없어 부호가 갑자기 뒤집히므로, 그런 곳에서는 효과를 뺀다
    float grain = dot(d / dm, fdir) * smoothstep(0.25, 0.6, fdir.y);
    // (부위마다 색이 달라져 보이지 않게 아주 약하게)
    col.rgb *= 1.0 + max(grain, 0.0) * dm * 0.04 - max(-grain, 0.0) * dm * 0.05;
  }
  col.rgb *= 1.0 - press * 0.02;

  // ── 눈: 반사광은 조명 기준으로 제자리에 두고, 촉촉한 윤기를 더한다 ──
  // (눈꺼풀이 내려오면 가려진다. 고개를 돌리면 눈의 절반만큼만 따라 움직인다)
  {
    for (int k = 0; k < 2; k++) {
      vec3 eye = k == 0 ? uEye0 : uEye1;
      float eyeVis = 1.0 - smoothstep(0.12, 0.4, k == 0 ? uLid.x : uLid.y);
      float er = length(Qturn - eye.xy) / eye.z;
      if (er < 1.1 && eyeVis > 0.0) {
        // 사진에서 떼어 둔 반사광을 조명 기준 자리에 얹는다
        if (uHasCatch > 0.5) {
          vec2 shift = uTurn * faceDepth(eye.xy) * 0.5;
          vec2 uv = (Qturn - (eye.xy - shift)) / (2.0 * eye.z) + 0.5;
          if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
            vec4 c = texture2D(uCatchImg, vec2((uv.x + float(k)) * 0.5, uv.y));
            col.rgb = col.rgb * (1.0 - c.a * eyeVis) + c.rgb * col.a * eyeVis;
          }
        }
        // 각막 위쪽의 넓고 옅은 윤기, 아래 눈꺼풀을 따라 비치는 물기
        float sheen = smoothstep(1.0, 0.55, er) * smoothstep(0.15, -0.55, (Qturn.y - eye.y) / eye.z) * 0.05;
        float rim = smoothstep(0.07, 0.0, abs(er - 0.92)) * smoothstep(0.2, 0.7, (Qturn.y - eye.y) / eye.z) * 0.08;
        col.rgb += vec3(0.88, 0.92, 1.0) * col.a * (sheen + rim) * eyeVis;
      }
    }
  }

  // ── 코: 젖은 코의 반사광. 고개를 돌리면 반대로 살짝 미끄러지고, 킁킁댈 때 반짝인다 ──
  float nm = 1.0 - smoothstep(0.8, 1.0, ellipseDist(Q, uNose));
  if (nm > 0.0 && uNoseGloss > 0.0) {
    vec4 hs = img(Q + uTurn * 0.35);
    float hl = smoothstep(0.28, 0.55, dot(hs.rgb / max(hs.a, 0.01), vec3(0.3, 0.59, 0.11)));
    col.rgb += hl * nm * (0.06 + 0.14 * uFlare + 0.03 * sin(uTime * 1.7)) * col.a * uNoseGloss;
  }

  // ── 합성 (premultiplied alpha) ──
  col *= 1.0 - smoothstep(uFadeFrom, uSize.y, P.y);
  col *= smoothstep(uFadeSides.x, uFadeSides.x + uSize.x * 0.08, P.x) * smoothstep(uFadeSides.y, uFadeSides.y - uSize.x * 0.08, P.x);
  vec3 shadowCol = vec3(0.35, 0.22, 0.1);
  gl_FragColor = vec4(col.rgb + shadowCol * shadow * (1.0 - col.a), col.a + shadow * (1.0 - col.a));
}
`

/** 사진 가장자리 밖으로 그릴 여백 (바닥 그림자와 옆으로 삐져나오는 털) */
const MARGIN = 0.06

export class FurRenderer {
  readonly canvas: HTMLCanvasElement
  private gl: WebGLRenderingContext
  private prog: WebGLProgram
  private u: Record<string, WebGLUniformLocation | null> = {}
  private imgTex: WebGLTexture
  private flowTex: WebGLTexture
  private fieldTex: WebGLTexture
  /** 표정 사진: 입(헥헥), 눈 감기, 귀 젖히기 */
  private exprTex: WebGLTexture[]
  /** 표정 단계 사이 움직임 아틀라스 */
  private morphTex: WebGLTexture
  /** 눈 반사광 조각 */
  private catchTex: WebGLTexture
  private buf: WebGLBuffer
  private aUv: number
  /** 손 주기 앞발 (털 셰이더와 따로 그리는 층) */
  private paw: PawLayer
  /** 표정 전환 상태 (0~1) */
  private pant = 0
  /** 씹기: 살짝 벌린 입 사진으로 넘어간 정도 (0~1) */
  private chewW = 0
  /**
   * 차분한 움직임(SAFE)의 고퀄 아이: 숨에 맞춘 아주 작은 끄덕임 (펫 로컬 단위). 머리 전체가 위아래로 반 픽셀 남짓만 움직여
   * 사진이 멈춘 느낌을 덜고, 기울이지 않아 꿀렁이지 않는다. 헥헥대면 조금 더 빠르고 크게
   */
  private nodY(rig: PhotoRig, p: Pose) {
    if (!rig.snapFace || !this.calmMotion) return 0
    return Math.sin(this.breathPhase) * (NOD + this.snapPant * NOD) + Math.sin(p.t * Math.PI * 2 * PANT_HZ) * this.snapPant * NOD * 0.5
  }
  private pantClock = 0
  /** 보호소 고퀄: 눈·입이 열고 닫는 두 상태 사이를 빠르게 넘어간 정도 */
  private snapLid = [0, 0]
  private snapPant = 0
  /** 그린 눈꺼풀이 감긴 정도 (눈마다, 표정 사진이 없는 아이) */
  private drawnLid = [0, 0]
  /** 그린 눈꺼풀이 다 감은 채로 있은 시간 (눈마다) */
  private drawnFullFor = [0, 0]
  /** 다시 감기까지 남은 쉬는 시간 (눈마다) */
  private drawnRest = [0, 0]
  private earsBack = 0
  private panting = false
  private wary = false
  private lastT = 0
  private breathPhase = 0
  private breathDepth = 1
  /** 눈 감은 표정 사진이 있는지 (없으면 눈꺼풀을 흉내 낸다) */
  private hasEyesPhoto = false
  /** 자동 기준점 아이(표정 사진이 하나도 없음)는 AUTO_MOTION 묶음 */
  private calmMotion = false
  /** 지금 그리는 아이의 종 (움직임 묶음을 개·고양이로 나눈다) */
  private species: 'dog' | 'cat' = 'dog'
  /** 지금 쓰는 움직임 묶음. ?motion=로 바꾸고, ?debug면 window.__motionOverride로 효과를 하나씩 켜 볼 수 있다 */
  motionNow(): Motion {
    const name = MOTION_Q && MOTION[MOTION_Q] ? MOTION_Q : AUTO_MOTION
    const base = !this.calmMotion ? MOTION.full : name === 'safe' && this.species === 'cat' ? MOTION.safeCat : MOTION[name]
    const o = (window as unknown as { __motionOverride?: Partial<Motion> }).__motionOverride
    return o ? { ...base, ...o } : base
  }
  private rig: PhotoRig | null = null
  private loading: string | null = null
  private cache = new Map<
    string,
    {
      img: HTMLImageElement
      flow: HTMLImageElement
      expr: (HTMLImageElement | null)[]
      morph: HTMLImageElement | null
      catch: HTMLImageElement | null
    }
  >()
  field: FurField | null = null
  motion: FaceMotion | null = null
  lost = false
  dpr = 1
  private cleared = true

  static create(canvas: HTMLCanvasElement) {
    try {
      const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false })
      return gl ? new FurRenderer(canvas, gl) : null
    } catch {
      return null
    }
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGLRenderingContext) {
    this.canvas = canvas
    this.gl = gl
    this.prog = link(gl, VERT, FRAG)
    gl.useProgram(this.prog)

    this.buf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
    const a = -MARGIN
    const b = 1 + MARGIN
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([a, a, b, a, a, b, b, b]), gl.STATIC_DRAW)
    this.aUv = gl.getAttribLocation(this.prog, 'aUv')
    gl.enableVertexAttribArray(this.aUv)
    gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 0, 0)
    this.paw = new PawLayer(gl)

    this.imgTex = makeTexture(gl)
    this.flowTex = makeTexture(gl)
    this.fieldTex = makeTexture(gl)
    this.exprTex = [makeTexture(gl), makeTexture(gl), makeTexture(gl)]
    this.morphTex = makeTexture(gl)
    this.catchTex = makeTexture(gl)
    gl.uniform1i(this.loc('uImg'), 0)
    gl.uniform1i(this.loc('uFlow'), 1)
    gl.uniform1i(this.loc('uField'), 2)
    gl.uniform1i(this.loc('uPantImg'), 3)
    gl.uniform1i(this.loc('uEyesImg'), 4)
    gl.uniform1i(this.loc('uEarsImg'), 5)
    gl.uniform1i(this.loc('uMorph'), 6)
    gl.uniform1i(this.loc('uCatchImg'), 7)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.clearColor(0, 0, 0, 0)

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.lost = true
    })
  }

  private loc(name: string) {
    if (!(name in this.u)) this.u[name] = this.gl.getUniformLocation(this.prog, name)
    return this.u[name]
  }

  /** 지금 이 리그를 그릴 수 있으면 true */
  ready(rig: PhotoRig) {
    return !this.lost && this.rig === rig
  }

  /** 사진과 결 맵을 불러와 올린다. 실패하면 reject (호출한 쪽은 캔버스 그림으로 대체) */
  async load(rig: PhotoRig) {
    if (this.rig === rig || this.loading === rig.src) return
    this.loading = rig.src
    try {
      let assets = this.cache.get(rig.src)
      if (!assets) {
        const layers = exprLayers(rig)
        const morphSrc = rig.expressions?.morph?.src
        const [img, flow, morph, catchImg, ...expr] = await Promise.all([
          loadImage(rig.src),
          loadImage(rig.flow),
          // 움직임 아틀라스가 없으면 표정은 섞어서 바뀐다
          morphSrc ? loadImage(morphSrc).catch(() => null) : Promise.resolve(null),
          rig.catchlight ? loadImage(rig.catchlight).catch(() => null) : Promise.resolve(null),
          // 표정 사진은 없어도 동작한다 (그 표정만 빠진다)
          ...layers.map((l) => (l ? loadImage(l.src).catch(() => null) : Promise.resolve(null))),
        ])
        assets = { img: img!, flow: flow!, expr, morph, catch: catchImg }
        this.cache.set(rig.src, assets)
      }
      if (this.loading !== rig.src || this.lost) return
      const gl = this.gl
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.imgTex)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, assets.img)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this.flowTex)
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, assets.flow)
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      assets.expr.forEach((im, k) => {
        gl.activeTexture(gl.TEXTURE3 + k)
        gl.bindTexture(gl.TEXTURE_2D, this.exprTex[k])
        if (im) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im)
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
      })
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.activeTexture(gl.TEXTURE6)
      gl.bindTexture(gl.TEXTURE_2D, this.morphTex)
      if (assets.morph) {
        // 데이터 텍스처라 색 공간 변환을 하지 않는다
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, assets.morph)
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL)
      }
      this.rig = rig
      this.field = new FurField(rig)
      this.motion = new FaceMotion(rig)
      // 앞발 층이 자기 프로그램을 쓰고 나면 그게 켜져 있어서, 아이를 바꿀 때 리그 값이 털 셰이더에 안 들어간다 (다른 아이 눈 자리에 눈 감은 사진이 뜬다)
      gl.useProgram(this.prog)
      this.uploadField(true)
      gl.activeTexture(gl.TEXTURE7)
      gl.bindTexture(gl.TEXTURE_2D, this.catchTex)
      if (assets.catch) {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, assets.catch)
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      }
      gl.uniform1f(this.loc('uHasCatch'), assets.catch ? 1 : 0)
      this.hasEyesPhoto = !!rig.expressions?.eyesClosed && !!assets.expr[1]
      // 표정 사진이 없거나, 있어도 기준점을 자동으로 잡은 아이는 차분하게 (손으로 맞춘 고퀄 아이는 초코·삼식처럼 FULL)
      this.calmMotion = !rig.expressions || !!rig.autoLandmarks
      this.paw.load(rig.paw)
      this.setRigUniforms(rig, assets.expr.map((im) => !!im), !!assets.morph)
    } finally {
      if (this.loading === rig.src) this.loading = null
    }
  }

  private setRigUniforms(rig: PhotoRig, loaded: boolean[], morphLoaded: boolean) {
    const gl = this.gl
    const v4 = (n: string, e: { x: number; y: number; rx: number; ry: number }) => gl.uniform4f(this.loc(n), e.x, e.y, e.rx, e.ry)
    gl.uniform2f(this.loc('uSize'), rig.width, rig.height)
    gl.uniform2f(this.loc('uFoot'), rig.centerX, rig.footY)
    v4('uHead', rig.head)
    gl.uniform2f(this.loc('uNeck'), rig.neck.x, rig.neck.y)
    v4('uEarL', rig.ears[0])
    v4('uEarR', rig.ears[1])
    gl.uniform4f(this.loc('uEarPivots'), rig.ears[0].px, rig.ears[0].py, rig.ears[1].px, rig.ears[1].py)
    v4('uChest', rig.chest)
    gl.uniform3f(this.loc('uEye0'), rig.eyes[0].x, rig.eyes[0].y, rig.eyes[0].r)
    gl.uniform3f(this.loc('uEye1'), rig.eyes[1].x, rig.eyes[1].y, rig.eyes[1].r)
    v4('uNose', rig.nose)
    const [n0, n1] = rig.nostrils
    gl.uniform4f(this.loc('uNostrils'), n0.x, n0.y, n1.x, n1.y)
    gl.uniform1f(this.loc('uNostrilR'), n0.r)
    v4('uBrow0', rig.brows[0])
    v4('uBrow1', rig.brows[1])
    v4('uChin', rig.chin)
    v4('uSkull', rig.skull)
    const none = { x: 0, y: 0, rx: 1, ry: 1 }
    const morph = rig.expressions?.morph
    gl.uniform1f(this.loc('uMorphOn'), morph && morphLoaded ? 1 : 0)
    if (morph) {
      gl.uniform1f(this.loc('uMorphRange'), morph.range)
      gl.uniform1f(this.loc('uSdfRange'), morph.sdfRange)
      const r = morph.rects
      for (const [u, key] of [
        ['uPantR0', 'pant0'], ['uPantR1', 'pant1'], ['uEyesR0', 'eyes0'], ['uEyesR1', 'eyes1'],
        ['uEarsR0', 'ears0'], ['uEarsR1', 'ears1'], ['uEarsSdfR', 'earsSdf'],
      ] as const) gl.uniform4f(this.loc(u), ...(r[key] ?? [0, 0, 0, 0]))
    }
    const fill = rig.expressions?.earsBack?.fill ?? [0.45, 0.28, 0.18]
    gl.uniform3f(this.loc('uEarsFill'), fill[0], fill[1], fill[2])
    const frames = exprLayers(rig).map((l) => l?.frames ?? 1)
    gl.uniform3f(this.loc('uFrames'), frames[0], frames[1], frames[2])
    exprLayers(rig).forEach((l, k) => {
      const name = ['Pant', 'Eyes', 'Ears'][k]
      const ok = !!l && loaded[k]
      gl.uniform4f(this.loc(`u${name}Box`), ok ? l.x : 0, ok ? l.y : 0, ok ? l.width : 0, ok ? l.height : 0)
      if (name === 'Pant') v4('uPantMask', l?.mask[0] ?? none)
      else {
        v4(`u${name}Mask0`, l?.mask[0] ?? none)
        v4(`u${name}Mask1`, l?.mask[1] ?? l?.mask[0] ?? none)
      }
    })
    v4('uMuzzle', rig.muzzle)
    // 털이 눕는 거리는 화면 기준으로 같게 (펫 로컬 3.8단위)
    gl.uniform1f(this.loc('uShadowAmt'), rig.floorShadow ? 1 : 0)
    gl.uniform1f(this.loc('uFadeFrom'), rig.fadeBottom > 0 ? rig.height - rig.fadeBottom : rig.height + 1)
    gl.uniform2f(this.loc('uFadeSides'), rig.fadeSides?.left ?? -1e4, rig.fadeSides?.right ?? 1e4)
  }

  private uploadField(force = false) {
    const f = this.field
    if (!f || (!f.dirty && !force)) return
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, FIELD_W, FIELD_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, f.data)
    f.dirty = false
  }

  /** 화면 크기(CSS 픽셀)와 그리기 배율. 느린 기기에서는 main.ts가 배율을 낮춘다 */
  resize(w: number, h: number, dpr: number) {
    this.dpr = dpr
    const cw = Math.max(1, Math.round(w * dpr))
    const ch = Math.max(1, Math.round(h * dpr))
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw
      this.canvas.height = ch
    }
  }

  clear() {
    if (this.cleared || this.lost) return
    this.gl.clear(this.gl.COLOR_BUFFER_BIT)
    this.cleared = true
  }

  /** 펫 로컬 → 화면: (cx + x * scale, cy + y * scale). W, H는 CSS 픽셀 */
  render(pose: Pose, view: { cx: number; cy: number; scale: number; W: number; H: number }) {
    const rig = this.rig
    if (!rig || this.lost) return
    const gl = this.gl
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clear(gl.COLOR_BUFFER_BIT)
    this.cleared = false
    // 앞발 층이 프로그램·버퍼·0번 텍스처를 바꿔 놓으므로 털 셰이더 상태를 되돌린다
    gl.useProgram(this.prog)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
    gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 0, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex)

    const k = rig.scale * view.scale
    const left = view.cx - rig.centerX * k
    const top = view.cy + (FLOOR_Y - rig.footY * rig.scale) * view.scale
    // 사진 좌표 0~1이 가리키는 사각형 (여백은 aUv가 0 밖/1 밖으로 나가면서 자연히 포함된다)
    gl.uniform4f(
      this.loc('uRect'),
      (left / view.W) * 2 - 1,
      1 - (top / view.H) * 2,
      ((rig.width * k) / view.W) * 2,
      ((rig.height * k) / view.H) * 2,
    )

    const p = pose
    const toPx = 1 / rig.scale
    const m = this.motion!
    const soft = FaceMotion.soft
    gl.uniform1f(this.loc('uTime'), p.t)
    this.species = p.species
    const mo = this.motionNow()
    gl.uniform1f(this.loc('uFurShift'), (3.8 / rig.scale) * mo.field)
    // SAFE: 털 눕기는 튕기지 않고 천천히 돌아온다, 털끝 살랑임·가슴 털 숨쉬기
    if (this.field) this.field.soft = mo.shimmer > 0
    gl.uniform1f(this.loc('uShimmer'), mo.shimmer * toPx)
    // (헥헥대는 동안은 가슴 털이 더 크게 빠르게 오르내린다)
    gl.uniform1f(this.loc('uBreathFur'), Math.sin(this.breathPhase) * mo.breathFur * (1 + this.snapPant) * toPx)
    gl.uniform1f(this.loc('uShrink'), (p.startle * 0.03 + p.flinch * 0.02) * mo.startle)
    gl.uniform1f(this.loc('uShiver'), p.startle * Math.sin(p.t * 60) * 2.5 * toPx * 0.6 * mo.startle)
    // 사진은 크게 비틀면 티가 나므로 몸짓(pose)은 작게, 손에 끌려가는 움직임(motion)은 한계를 두고 더한다
    // 고양이 부비부비: 손 쪽으로 기울며 천천히 좌우로 비빈다
    const rub = p.bunt * p.buntSide * (0.045 + 0.02 * Math.sin(p.t * 2.6))
    // 자동 기준점 아이(보호소 사진·기기에서 만든 아이)는 움직임 묶음으로 줄인다 (MOTION, 기본 SAFE)
    const calm = this.motionNow()
    const sway = calm.head
    gl.uniform1f(this.loc('uTilt'), (p.tilt * 0.55 + soft(m.rot, ROT_MAX) + p.cock + rub) * sway)
    gl.uniform2f(
      this.loc('uLean'),
      (p.leanX * 0.08 + soft(m.ox, HEAD_MAX)) * toPx * sway,
      (p.leanY * 0.08 + soft(m.oy, HEAD_MAX)) * toPx * sway + this.nodY(rig, p) * toPx,
    )
    const flap = Math.sin(p.t * 10) * 0.05 * p.petting
    // 관심이 가면 쫑긋, 기분 좋으면 편하게 늘어지고, 놀라면 뒤로 젖힌다
    // 기분 좋으면 개는 귀가 편하게 늘어지고, 고양이는 귀가 살짝 앞으로(위로) 향한다
    const ear = p.perk * 0.1 + p.happy * (p.species === 'cat' ? 0.035 : -0.05) - p.startle * 0.12 + flap + Math.sin(p.t * 1.7) * 0.008
    // 귀 사진이 바뀌는 동안 귀를 조금 안쪽으로 젖혀, 사진 사이를 동작으로 이어 준다 (다 바뀌면 0)
    const tuck = -Math.sin(Math.PI * this.earsBack) * 0.12
    // 갸웃할 때는 기울이는 쪽 반대 귀가 쫑긋, 움찔하면 귀를 젖힌다
    const perkL = p.curious * (p.cockSide > 0 ? 0.1 : 0.03)
    const perkR = p.curious * (p.cockSide < 0 ? 0.1 : 0.03)
    gl.uniform1f(this.loc('uEarRotL'), (ear + m.earL + tuck + perkL - p.flinch * 0.1) * calm.ear)
    gl.uniform1f(this.loc('uEarRotR'), (ear + m.earR + tuck + perkR - p.flinch * 0.1) * calm.ear)
    const dt = Math.min(0.05, Math.max(0, p.t - this.lastT))
    this.lastT = p.t
    // 헥헥댈 때는 숨이 빨라진다
    // 숨: 빠르기가 천천히 오르내리고 숨마다 깊이가 조금씩 다르다. 한숨은 크고 느리게. 헥헥댈 때는 빠르게
    // (헥헥은 실제 강아지처럼 초당 2~3번)
    const breathRate = (2.2 * p.breathRate + this.pant * 12) * (1 - p.sigh * 0.55)
    const prevPhase = this.breathPhase
    this.breathPhase += dt * breathRate
    if (Math.floor(prevPhase / (Math.PI * 2)) !== Math.floor(this.breathPhase / (Math.PI * 2))) {
      this.breathDepth = 0.8 + Math.random() * 0.45
    }
    const depth = this.breathDepth * (1 + p.sigh * 1.6)
    gl.uniform1f(this.loc('uBreath'), (Math.sin(this.breathPhase) * (0.012 * depth + p.startle * 0.01) + p.happy * 0.004) * calm.breath)
    // 표정 전환: 반쯤 섞인 상태가 오래가면 두 장이 겹쳐 보이므로, 켜고 끄기는 문턱으로 정하고 전환은 빠르게
    // 고양이는 기분이 좋아도 입을 벌리지 않는다 (입을 벌리면 하악질처럼 보인다)
    // 간식을 먹는 동안은 헥헥대지 않는다 (먹고 나서 기분 좋으면 헥헥댄다)
    const eating = p.chomp > 0.02 || p.chew > 0.02
    if (!this.panting && p.species === 'dog' && p.happy > 0.55 && p.startle < 0.2 && !eating) this.panting = true
    else if (this.panting && (p.happy < 0.4 || p.startle > 0.3 || eating)) this.panting = false
    if (!this.wary && (p.startle > 0.25 || p.wary > 0.5)) this.wary = true
    else if (this.wary && p.startle < 0.1 && p.wary < 0.3) this.wary = false
    // 일정한 속도로 진행한다 (가속·감속은 셰이더가 단계 사이마다 준다). 초 단위 전환 시간
    this.pant = ramp(this.pant, this.panting, PANT_OPEN, PANT_CLOSE, dt)
    this.earsBack = ramp(this.earsBack, this.wary, EARS_BACK, EARS_RETURN, dt)
    // 입맛 다시기: 입을 살짝 열었다 닫는다 (헥헥 중간 단계까지만)
    // 고양이는 헥헥대지 않고, 간식을 받아먹을 때만 입을 벌린다: 한 입 물 때 크게 벌린 입 사진까지(중간 모양은 구겨져 보여 머물지 않는다)
    // 씹을 때는 살짝 벌린 입(중간 사진)에 머문 채 아래턱만 오르내린다 (닫힌 입과 사이를 오가면 사진 사이 변형만 보여 입이 물결친다)
    // (강아지는 헥헥대는 입 사진이라 끝까지 벌리면 혀가 너무 나와서 80%까지)
    // 씹기: 다문 입과 살짝 벌린 입 사진을 번갈아 빠르게 오간다 (사이 모양은 한두 프레임만)
    this.chewW = ramp(this.chewW, p.chew > 0.5 && Math.sin(p.t * 9) > -0.3, 0.05, 0.05, dt)
    // 고양이는 크게 벌린 입 사진이 너무 커 보여서, 한 입 물 때도 살짝 벌린 입 사진(0.5)까지만 쓴다
    // 츄르를 핥는 고양이(rig.lick, 혀 표정 사진): 한 입마다 혀를 날름날름 (혀 살짝 ↔ 혀로 핥기 사진을 초당 3번 넘나든다)
    const licking = rig.lick && p.chomp > 0.5 ? (Math.sin(p.t * Math.PI * 2 * 3) > 0 ? 1 : 0.5) : 0
    const eatW = rig.lick ? Math.max(licking, this.chewW * 0.5) : Math.max(p.chomp * (p.species === 'dog' ? 0.8 : 0.5), this.chewW * 0.5)
    // 보호소 고퀄(rig.snapFace): 입은 확실히 벌리거나(헥헥) 다물거나 둘 중 하나. 반쯤 열렸다 닫혔다 하면 오물거려 보인다 (입맛 다시기도 뺀다)
    gl.uniform1f(this.loc('uPantKeepNose'), rig.snapFace ? 1 : 0)
    if (rig.snapFace) {
      // 헥헥은 몇 초 하다가 잠깐 다물고 다시 연다 (계속 열어 두면 사진이 멈춘 듯하다)
      this.pantClock = this.panting ? this.pantClock + dt : 0
      const resting = this.panting && this.pantClock % (PANT_ON_S + PANT_REST_S) > PANT_ON_S
      this.snapPant = step01(this.snapPant, this.panting && !resting ? 1 : 0, SNAP_CLOSE_S, SNAP_OPEN_S, dt)
      gl.uniform1f(this.loc('uPantW'), Math.max(this.snapPant, eatW))
    } else gl.uniform1f(this.loc('uPantW'), p.species === 'dog' ? Math.max(this.pant, p.lick * 0.42, eatW) : eatW)
    gl.uniform1f(this.loc('uEarsW'), this.earsBack)

    // 기분 좋은 눈: 개는 지그시 감고, 고양이는 게슴츠레 반쯤 뜬 채로 있다 (반쯤 감은 표정 사진이 딱 그 모양)
    const squint =
      p.startle >= 0.2 ? 0
      : p.species === 'cat' ? Math.min(0.5 + m.chinLift * 0.2, Math.max(0, p.happy - 0.2) * 1.2 + m.chinLift * 0.3)
      : Math.max(0, p.happy - 0.4) * 0.9
    const slow = p.slowBlink
    // 눈가를 만지면 그쪽 눈을 감는다 (반대쪽도 반쯤 따라 감는다)
    const lid = Math.max(p.blink * 1.1, squint, p.sigh * 0.35, slow)
    if (this.hasEyesPhoto && rig.snapFace) {
      // 보호소 고퀄: 게슴츠레 반쯤 머물지 않는다. 감을 때는 빠르게 끝까지, 뜰 때는 빠르게 동그랗게 (다 감은 채로 있는 건 괜찮다)
      // 기분 좋은 눈은 계속 감고 있지 않고, 4.5초에 한 번 1.2초쯤 감았다 뜬다 (그사이 빠른 깜빡임도 보인다)
      const want = (v: number) => (v > DRAWN_SNAP ? 1 : 0)
      const squintPulse = squint > DRAWN_SNAP && p.t % SQUINT_EVERY_S < SQUINT_HOLD_S ? 1 : 0
      const lidS = Math.max(p.blink * 1.1, squintPulse, p.sigh * 0.35, slow)
      this.snapLid[0] = step01(this.snapLid[0], want(Math.max(lidS, m.eyeTouchL)), SNAP_CLOSE_S, SNAP_OPEN_S, dt)
      this.snapLid[1] = step01(this.snapLid[1], want(Math.max(lidS, m.eyeTouchR)), SNAP_CLOSE_S, SNAP_OPEN_S, dt)
      gl.uniform2f(this.loc('uLid'), this.snapLid[0], this.snapLid[1])
    } else if (this.hasEyesPhoto) {
      gl.uniform2f(this.loc('uLid'), Math.min(1, Math.max(lid, m.eyeTouchL)), Math.min(1, Math.max(lid, m.eyeTouchR)))
    } else {
      // 눈 감은 표정 사진이 없는 아이는 눈꺼풀을 그려 덮는다. 그린 눈꺼풀은 반쯤 감은 채 멈춰 있거나 다 감은 채로 있으면 티가 나서,
      // 눈 감는 모습은 빠른 깜빡임으로만 보인다: 천천히 깜빡임·눈가 만지기는 0.08초 만에 끝까지 감고 DRAWN_HOLD_S 안에 바로 뜬다
      // (같은 동작이 이어지는 동안 다시 감지 않는다). 쓰다듬을 때 지그시 감기는 없고, 대신 깜빡임이 잦아진다 (pet.ts)
      const snap = (v: number) => (v > DRAWN_SNAP ? 1 : 0)
      // 한 번 감았다 뜬 뒤 DRAWN_REARM_S 동안은 다시 감지 않는다 (실제 카메라에서는 손끝이 눈가를 들락거려, 감기가 계속 다시 켜지면 오래 감은 것처럼 보인다)
      const held = (k: 0 | 1, touch: number) => {
        this.drawnRest[k] = Math.max(0, this.drawnRest[k] - dt)
        if (!Math.max(snap(slow), snap(touch))) {
          if (this.drawnFullFor[k] > 0) this.drawnRest[k] = DRAWN_REARM_S
          this.drawnFullFor[k] = 0
          return 0
        }
        if (this.drawnFullFor[k] === 0 && this.drawnRest[k] > 0) return 0
        this.drawnFullFor[k] += dt
        return this.drawnFullFor[k] < DRAWN_CLOSE_S + DRAWN_HOLD_S ? 1 : 0
      }
      const step = (cur: number, target: number) =>
        target > cur ? Math.min(target, cur + dt / DRAWN_CLOSE_S) : Math.max(target, cur - dt / DRAWN_OPEN_S)
      this.drawnLid[0] = step(this.drawnLid[0], held(0, m.eyeTouchL))
      this.drawnLid[1] = step(this.drawnLid[1], held(1, m.eyeTouchR))
      // 깜빡임은 원래 빠르다 (감기 0.07초·뜨기 0.13초, pet.ts)
      gl.uniform2f(this.loc('uLid'), Math.min(1, Math.max(p.blink * 1.1, this.drawnLid[0])), Math.min(1, Math.max(p.blink * 1.1, this.drawnLid[1])))
    }
    gl.uniform2f(this.loc('uNoseOff'), m.noseX * toPx * calm.nose, m.noseY * toPx * calm.nose)
    gl.uniform1f(this.loc('uNoseSquash'), m.noseSquash * calm.nose)
    gl.uniform1f(this.loc('uFlare'), m.flare * calm.nose)
    gl.uniform1f(this.loc('uNoseGloss'), p.species === 'dog' ? 1 : 0)
    gl.uniform1f(this.loc('uCatEye'), p.species === 'cat' ? 1 : 0)

    gl.uniform2f(this.loc('uBrowLift'), m.browL * BROW_LIFT * toPx * calm.face, m.browR * BROW_LIFT * toPx * calm.face)
    // 헥헥댈 때 아래턱이 숨에 맞춰 들썩인다
    // (보호소 고퀄은 헥헥 입이 숨에 맞춰 들썩이면 오물거려 보여 뺀다)
    // 헥헥: 입을 활짝 연 채로 아래턱·혀가 빠르고 작게 들썩인다 (고퀄은 반쯤 닫히지 않을 만큼만)
    const pantBob = rig.snapFace
      ? this.snapPant * (Math.sin(p.t * Math.PI * 2 * PANT_HZ) * 0.5 + 0.5) * -PANT_BOB
      : this.pant * (Math.sin(this.breathPhase) * 0.5 + 0.5) * -2.2
    // 간식을 한 입 물 때 아래턱을 벌렸다 다물고, 다 먹고 나면 오물오물 씹는다
    // (입 벌린 사진이 있으면 무는 동작은 사진이 하고, 씹을 때 아래턱만 오르내린다)
    const chewBob = p.chew * (0.5 + 0.5 * Math.sin(p.t * 9)) * CHEW_OPEN
    // 입 사진이 있으면 턱은 그대로 둔다 (턱 부위만 끌어내리면 아랫입술 선이 어긋나 구겨져 보인다)
    // 입 사진이 없는 고양이(츄르)는 입을 벌리지 못하니, 츄르를 댄 채 아래턱만 아주 작게 오물거린다
    const nibble = p.species === 'cat' && p.chomp > 0.5 ? (0.5 + 0.5 * Math.sin(p.t * Math.PI * 2 * 3)) * CHURU_NIBBLE : 0
    const eatJaw = rig.expressions?.pant ? 0 : p.species === 'cat' ? -(nibble + chewBob * 0.5) : -(p.chomp * CHOMP_OPEN + chewBob)
    gl.uniform1f(this.loc('uChinLift'), (m.chinLift * CHIN_LIFT * calm.face + pantBob + eatJaw) * toPx)
    gl.uniform1f(this.loc('uWhisker'), p.species === 'cat' ? Math.max(0, p.happy - 0.3) * 3.2 * toPx * calm.face : 0)
    gl.uniform2f(this.loc('uTurn'), soft(m.yaw, 1) * YAW_SHIFT * toPx * calm.head, -soft(m.pitch, 1) * PITCH_SHIFT * toPx * calm.head)
    gl.uniform2f(this.loc('uGaze'), clamp(p.lookX, -1, 1) * GAZE * calm.gaze, clamp(p.lookY, -1, 1) * GAZE * 0.6 * calm.gaze)
    const v = m.velocity
    const lag = Math.min(1, 2.5 / (Math.hypot(v.x, v.y) * 0.03 + 1e-6))
    gl.uniform2f(this.loc('uFurLag'), -v.x * 0.03 * lag * toPx * calm.drag, -v.y * 0.03 * lag * toPx * calm.drag)
    gl.uniform1f(this.loc('uBreeze'), (0.7 + Math.min(0.6, Math.hypot(v.x, v.y) / 60)) * calm.breeze)

    this.uploadField()
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    // 손 주기: 앞발을 털 위에 따로 그린다
    if (rig.paw) {
      for (const [k, pw] of p.paws.entries()) if (pw.amt > 0.005) this.paw.draw(pw, k === 0, p.t, rig, view)
    }
  }
}

/**
 * 손 주기 앞발 층. 털 셰이더와 다른 작은 프로그램이라 텍스처 칸 제한(8개)과 상관없다.
 * 같은 사진을 앞발을 든 모습으로 편집해 잘라 낸 층(정면 시점)을 사진 좌표 그대로 겹친다.
 * 어깨를 축으로 아래에서 들어 올리고, 손 쪽으로 살짝 기운다 (늘이지 않아서 흐물거리지 않는다).
 */
class PawLayer {
  private gl: WebGLRenderingContext
  private prog: WebGLProgram
  private buf: WebGLBuffer
  private tex: WebGLTexture
  private ready = false
  private src = ''
  private u: Record<string, WebGLUniformLocation | null> = {}

  constructor(gl: WebGLRenderingContext) {
    this.gl = gl
    this.prog = link(
      gl,
      `attribute vec2 aUv;
       uniform vec2 uOrigin; uniform vec2 uAxisX; uniform vec2 uAxisY;
       varying vec2 vUv;
       void main() { vUv = aUv; gl_Position = vec4(uOrigin + aUv.x * uAxisX + aUv.y * uAxisY, 0.0, 1.0); }`,
      `precision mediump float;
       uniform sampler2D uTex; uniform float uAlpha;
       uniform vec2 uFade;     // 층 안 세로 0~1: 여기부터 아래로 사진 아랫단처럼 서서히 사라진다
       varying vec2 vUv;
       void main() {
         vec4 c = texture2D(uTex, vUv);
         c *= (1.0 - smoothstep(uFade.x, uFade.y, vUv.y)) * uAlpha;
         gl_FragColor = c;
       }`,
    )
    this.buf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
    this.tex = makeTexture(gl)
    for (const n of ['uOrigin', 'uAxisX', 'uAxisY', 'uTex', 'uAlpha', 'uFade']) this.u[n] = gl.getUniformLocation(this.prog, n)
  }

  async load(paw: PhotoRig['paw']) {
    if (!paw || paw.src === this.src) return
    this.src = paw.src
    this.ready = false
    const img = await loadImage(paw.src).catch(() => null)
    if (!img || this.src !== paw.src) return
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    this.ready = true
  }

  /** view: 펫 로컬 → 화면 (털 셰이더와 같은 사진 배치) */
  /** pw: 한쪽 앞발 (펫 로컬 좌표). flip: 화면 왼쪽 앞발이면 사진 속 다리를 좌우로 뒤집어 쓴다 */
  draw(pw: Pose['paws'][number], flip: boolean, t: number, rig: PhotoRig, view: { cx: number; cy: number; scale: number; W: number; H: number }) {
    const paw = rig.paw
    if (!this.ready || !paw) return
    const gl = this.gl
    const e = pw.amt
    // 살짝 넘쳤다 자리 잡는 모양 (ease-out-back)
    const s = 1.4
    const rise = 1 + (s + 1) * Math.pow(e - 1, 3) + s * Math.pow(e - 1, 2)
    // 사진 속 앞발은 사진 오른쪽 다리. 화면 왼쪽 앞발은 좌우를 뒤집어 쓴다
    const mirror = (x: number) => (flip ? 2 * rig.centerX - x : x)
    // 손 위치 (사진 좌표, 뒤집기 전 기준)
    const hx = mirror(pw.x / rig.scale + rig.centerX)
    const hy = (pw.y - FLOOR_Y) / rig.scale + rig.footY
    const S = paw.shoulder
    const v0x = paw.pad.x - S.x
    const v0y = paw.pad.y - S.y
    const v1x = hx - S.x
    const v1y = hy - S.y
    // 어깨를 축으로 손 쪽으로 조금만 기울이고, 손이 멀면 카메라 쪽으로 조금 더 뻗는다 (크게 틀면 사진 티가 난다)
    const toward = clamp(Math.atan2(v1y, v1x) - Math.atan2(v0y, v0x), -0.3, 0.3) * 0.5
    const reach = clamp(Math.hypot(v1x, v1y) / Math.hypot(v0x, v0y), 0.95, 1.08)
    // 들어 올리는 동안: 아래로 내려 있던 발이 어깨를 축으로 올라오며 앞으로(크게) 나온다
    const ang = toward + (1 - rise) * 0.35 + Math.sin(t * 2.1) * 0.012 * e
    const sc = reach * (0.88 + 0.12 * rise)
    const drop = (1 - rise) * paw.height * 0.25
    const cos = Math.cos(ang)
    const sin = Math.sin(ang)
    const k = rig.scale * view.scale
    const left = view.cx - rig.centerX * k
    const top = view.cy + (FLOOR_Y - rig.footY * rig.scale) * view.scale
    // 층의 사진 좌표 → 클립 공간 (어깨 축 회전·확대 → 좌우 뒤집기 → 화면)
    const map = (X: number, Y: number) => {
      const dx = (X - S.x) * sc
      const dy = (Y - S.y) * sc
      const qx = mirror(S.x + dx * cos - dy * sin)
      const qy = S.y + dx * sin + dy * cos + drop
      return [((left + qx * k) / view.W) * 2 - 1, 1 - ((top + qy * k) / view.H) * 2]
    }
    const o = map(paw.x, paw.y)
    const ax = map(paw.x + paw.width, paw.y)
    const ay = map(paw.x, paw.y + paw.height)
    // 사진 아랫단이 사라지는 높이에 맞춰 발도 끝자락만 같이 사라진다 (발바닥은 남게 털 셰이더보다 늦게)
    const fadeFrom = rig.fadeBottom > 0 ? rig.height - rig.fadeBottom * 0.35 : rig.height + 1
    gl.useProgram(this.prog)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
    const loc = gl.getAttribLocation(this.prog, 'aUv')
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.uniform1i(this.u.uTex, 0)
    gl.uniform1f(this.u.uAlpha, Math.min(1, e * 2.5))
    gl.uniform2f(this.u.uFade, (fadeFrom - paw.y - drop) / paw.height, (rig.height - paw.y - drop) / paw.height + 1e-3)
    gl.uniform2f(this.u.uOrigin, o[0], o[1])
    gl.uniform2f(this.u.uAxisX, ax[0] - o[0], ax[1] - o[1])
    gl.uniform2f(this.u.uAxisY, ay[0] - o[0], ay[1] - o[1])
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }
}

/** 눈 감은 표정 사진이 없는 아이의 그린 눈꺼풀: 감기·뜨기 시간(초), 감기 시작하는 기준, 고양이 게슴츠레 정도 */
const DRAWN_CLOSE_S = 0.08
const DRAWN_OPEN_S = 0.15
const DRAWN_SNAP = 0.3
/** 보호소 고퀄 눈·입: 닫기(감기)·열기(뜨기) 시간 */
/** 고퀄 헥헥: 입 열고 있는 시간·쉬는 시간(초), 턱 들썩임 빠르기·크기, 숨 끄덕임 크기 (펫 로컬 단위) */
const PANT_ON_S = 3.2
const PANT_REST_S = 1.4
const PANT_HZ = 2.6
const PANT_BOB = 1.3
const NOD = 0.35
/** 고퀄 기분 좋은 눈: 이만큼마다 이 시간 동안 감는다 (초) */
const SQUINT_EVERY_S = 4.5
const SQUINT_HOLD_S = 1.2
const SNAP_CLOSE_S = 0.09
const SNAP_OPEN_S = 0.12

/** 0~1을 목표 쪽으로 정해진 시간에 걸쳐 일정하게 옮긴다 (올라갈 때 upS초, 내려갈 때 downS초) */
function step01(cur: number, target: number, upS: number, downS: number, dt: number) {
  return target > cur ? Math.min(target, cur + dt / upS) : Math.max(target, cur - dt / downS)
}

/** 다 감은 채로 있는 최대 시간(초). 그 뒤로는 바로 뜬다 */
const DRAWN_HOLD_S = 0.3
/**
 * 움직임 묶음 (효과마다 배율 0~1). 손으로 기준점을 맞춘 아이(초코·삼식, 표정 사진 있음)는 FULL,
 * 자동 기준점 아이(보호소 사진·기기에서 만든 아이)는 AUTO_MOTION (기본 SAFE). ?motion=safe|calm|full 로 바꿔 볼 수 있다.
 *   field  쓰다듬을 때 털이 눕는 것 (손이 닿은 자리만)     breeze 가만히 있을 때 털끝 흔들림
 *   drag   손에 끌리는 털·얼굴                          head   고개 기울이기·따라오기·돌리기 (깊이 변형 포함)
 *   ear    귀 따로 까딱이기·젖히기                        breath 숨쉬기 (가슴이 부풀었다 꺼짐)
 *   face   눈썹·턱 들기·수염 패드                        nose   코 움직임·킁킁 벌름 (코 둘레만)
 *   startle 놀라 움츠림·떨림
 * 보호소 사진은 정성 들여 찍은 사진이 아니라 부위 위치가 대충이고, 얼굴 전체가 계속 휘면 사진 한 장의 한계가 드러난다.
 * SAFE는 좁은 곳에서 짧게 일어나는 반응(털 눕기, 깜빡임, 코, 간식)만 남긴다
 */
type Motion = Record<'field' | 'breeze' | 'drag' | 'head' | 'ear' | 'breath' | 'face' | 'nose' | 'startle' | 'gaze' | 'shimmer' | 'breathFur', number>
// (gaze: 눈동자가 손을 따라가는 거리. 얼굴은 그대로이고 눈 안에서만 움직여 사진 한 장으로도 자연스럽다)
// SAFE 털 눕기는 손이 닿은 자리만 얌전하게, 코는 아주 조금만 (사용자 확인 2026-10-03)
// shimmer·breathFur는 펫 로컬 단위 (털끝 살랑임·가슴 털 오르내림 거리). SAFE에서만 쓴다 (FULL·CALM은 breeze·breath가 있다)
// SAFE는 털이 살아 있게 하되 영역이 출렁이지 않게: 짧은 파장 살랑임 + 가슴 털 숨쉬기 + 튕기지 않는 털 눕기.
// 고양이는 털이 길고 부드러워 살랑임·털 눕기를 조금 더 (사용자 확인 2026-10-05 '털이 안 움직여 인위적, 고양이 특히')
const MOTION: Record<'full' | 'calm' | 'safe' | 'safeCat', Motion> = {
  full: { field: 1, breeze: 1, drag: 1, head: 1, ear: 1, breath: 1, face: 1, nose: 1, startle: 1, gaze: 1, shimmer: 0, breathFur: 0 },
  calm: { field: 1, breeze: 1, drag: 0.6, head: 0.35, ear: 0.25, breath: 1, face: 0.5, nose: 0.5, startle: 1, gaze: 1, shimmer: 0, breathFur: 0 },
  safe: { field: 0.5, breeze: 0, drag: 0, head: 0, ear: 0, breath: 0, face: 0, nose: 0.3, startle: 0.3, gaze: 2.2, shimmer: 0.35, breathFur: 0.35 },
  safeCat: { field: 0.65, breeze: 0, drag: 0, head: 0, ear: 0, breath: 0, face: 0, nose: 0.3, startle: 0.3, gaze: 2.2, shimmer: 0.75, breathFur: 0.5 },
}
/** 자동 기준점 아이의 기본 움직임 묶음 */
const AUTO_MOTION: 'safe' | 'calm' | 'full' = 'safe'
const MOTION_Q = new URLSearchParams(location.search).get('motion') as 'safe' | 'calm' | 'full' | null
/** 감았다 뜬 뒤 다시 감기까지 쉬는 시간(초) */
const DRAWN_REARM_S = 1.5

/** 간식 먹기: 한 입 물 때, 씹을 때 아래턱이 내려가는 거리 (펫 로컬 단위) */
const CHOMP_OPEN = 5
/** 입 사진이 없는 고양이가 츄르를 먹을 때 턱이 오물거리는 거리 */
const CHURU_NIBBLE = 1.4
const CHEW_OPEN = 3

/** 표정 전환 시간 (초). 놀랄 때 귀는 빨리 젖히고 천천히 돌아온다 */
const PANT_OPEN = 0.45
const PANT_CLOSE = 0.6
const EARS_BACK = 0.3
const EARS_RETURN = 0.7

function ramp(v: number, on: boolean, upSec: number, downSec: number, dt: number) {
  return on ? Math.min(1, v + dt / upSec) : Math.max(0, v - dt / downSec)
}

/** 셰이더의 표정 슬롯 순서: 입, 눈, 귀 */
function exprLayers(rig: PhotoRig): (ExpressionLayer | undefined)[] {
  return [rig.expressions?.pant, rig.expressions?.eyesClosed, rig.expressions?.earsBack]
}

function makeTexture(gl: WebGLRenderingContext) {
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
  return tex
}

function link(gl: WebGLRenderingContext, vs: string, fs: string) {
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader compile failed')
    return sh
  }
  const prog = gl.createProgram()!
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs))
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'program link failed')
  return prog
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`이미지를 불러오지 못했어요: ${src}`))
    img.src = src
  })
}
