/**
 * 공유: 쓰다듬는 장면을 짧은 영상으로 녹화해 보내거나(녹화 엔진이 있을 때), 링크를 보낸다.
 * 공유 링크에는 ?from=share를 붙여, 받은 사람에게는 '너도 만들어 봐'와 입양 사이트를 먼저 보여 준다.
 */
import { josa, type PetProfile } from './pets'

/** 녹화 엔진 (기술 쪽). 연결 전에는 링크만 공유한다 */
export type ClipRecorder = (seconds: number) => Promise<{ blob: Blob; ext: 'mp4' | 'webm' }>
let recorder: ClipRecorder | null = null
const CLIP_SECONDS = 6
export function setClipRecorder(r: ClipRecorder) {
  recorder = r
}

/** petId가 있으면 받은 사람이 그 아이를 바로 보게 (?pet=) */
export function shareUrl(petId?: string) {
  const u = new URL(import.meta.env.BASE_URL, location.origin)
  u.searchParams.set('from', 'share')
  if (petId) u.searchParams.set('pet', petId)
  return u.toString()
}

export function shareText(p: PetProfile, mine: boolean) {
  return mine
    ? `우리 ${p.name} 손끝으로 쓰다듬어 봤어요 🐾 너도 우리 아이 사진으로 만들어 봐!`
    : `${josa(p.name, '이', '가')} 가족을 기다려요. 화면 속에서 손끝으로 쓰다듬어 볼래요? 🐾`
}

export type ShareResult = 'shared' | 'copied' | 'downloaded' | 'cancelled'

export async function sharePet(p: PetProfile, mine: boolean, onRecording?: (on: boolean) => void, linkPet?: string): Promise<ShareResult> {
  const text = shareText(p, mine)
  const url = shareUrl(linkPet)

  if (recorder) {
    onRecording?.(true)
    let clip: Awaited<ReturnType<ClipRecorder>>
    try {
      clip = await recorder(CLIP_SECONDS)
    } finally {
      onRecording?.(false)
    }
    const file = new File([clip.blob], `sonkkeut-${p.name}.${clip.ext}`, { type: clip.blob.type })
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text: `${text}\n${url}` })
        return 'shared'
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return 'cancelled'
      }
    }
    // 파일 공유가 안 되는 곳(데스크톱 등)은 저장하고 링크를 복사해 둔다
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: file.name })
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
    await copy(`${text}\n${url}`)
    return 'downloaded'
  }

  if (navigator.share) {
    try {
      await navigator.share({ title: '손끝 교감', text, url })
      return 'shared'
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'cancelled'
    }
  }
  await copy(`${text}\n${url}`)
  return 'copied'
}

async function copy(s: string) {
  try {
    await navigator.clipboard.writeText(s)
  } catch {
    prompt('아래 내용을 복사해 보내 주세요', s)
  }
}

/** 화면 아래에 잠깐 뜨는 알림 */
export function toast(msg: string) {
  let el = document.getElementById('toast')
  if (!el) {
    el = Object.assign(document.createElement('div'), { id: 'toast', className: 'toast' })
    el.setAttribute('role', 'status')
    document.body.append(el)
  }
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(Number(el.dataset.t))
  el.dataset.t = String(setTimeout(() => el!.classList.remove('show'), 2400))
}
