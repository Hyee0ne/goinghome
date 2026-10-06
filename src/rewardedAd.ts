/**
 * 보상형 광고: 끝까지 보면 AI로 만들기가 열린다.
 * 가안: 실제 광고 대신 자리 표시 화면과 15초 카운트다운. 광고 네트워크(예: Google Ad Manager의 웹 보상형 광고)를
 * 붙일 때 showRewardedAd 안쪽만 바꾼다. 결과는 '끝까지 봤는지'만 돌려준다.
 */

import { aiCredits } from './credits'

const LENGTH = 15

/**
 * AI로 만들기 열기: 오늘 남은 횟수가 있으면 광고를 끝까지 봐야 열린다 (광고는 항상 필수).
 * 다 썼으면 내일 다시라고 알려 준다 (무료 버전은 없다)
 */
export async function unlockAi(): Promise<boolean> {
  if (aiCredits.remaining <= 0) {
    await ask('오늘은 이미 만들었어요', '광고를 보면 하루 1번 만들 수 있어요. 내일 다시 와 주세요.', ['닫기', '확인'])
    return false
  }
  const watched = await showRewardedAd()
  return watched && aiCredits.use()
}

/** 버튼 두 개짜리 작은 물음 상자. 고른 버튼 번호 (Esc는 0) */
function ask(title: string, body: string, buttons: [string, string]) {
  return new Promise<number>((resolve) => {
    const dlg = document.createElement('dialog')
    dlg.className = 'ad-dialog ask'
    dlg.innerHTML = `<div class="ad-head"><b></b></div><p class="ask-body"></p><div class="ad-foot"><button type="button" class="btn ghost"></button><button type="button" class="btn primary"></button></div>`
    dlg.querySelector('b')!.textContent = title
    dlg.querySelector('.ask-body')!.textContent = body
    const [a, b] = dlg.querySelectorAll<HTMLButtonElement>('.ad-foot button')
    a.textContent = buttons[0]
    b.textContent = buttons[1]
    const done = (n: number) => {
      dlg.close()
      dlg.remove()
      resolve(n)
    }
    a.onclick = () => done(0)
    b.onclick = () => done(1)
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault()
      done(0)
    })
    document.body.append(dlg)
    dlg.showModal()
  })
}

export function showRewardedAd(): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog')
    dlg.className = 'ad-dialog'
    dlg.innerHTML = `
      <div class="ad-head"><b>광고를 끝까지 보면 우리 아이를 만들어 드려요</b><span class="ad-timer"></span></div>
      <div class="ad-slot" role="img" aria-label="광고 자리">
        <span>광고 자리 (가안)</span>
      </div>
      <div class="ad-foot">
        <button type="button" class="btn ghost ad-skip">그만두기</button>
        <button type="button" class="btn primary ad-done" disabled>만들기</button>
      </div>`
    document.body.append(dlg)
    const timer = dlg.querySelector('.ad-timer')!
    const done = dlg.querySelector<HTMLButtonElement>('.ad-done')!
    let left = LENGTH
    const tick = () => {
      timer.textContent = left > 0 ? `${left}초` : '다 봤어요'
      done.disabled = left > 0
      if (left-- > 0) t = window.setTimeout(tick, 1000)
    }
    let t = 0
    const finish = (ok: boolean) => {
      clearTimeout(t)
      dlg.close()
      dlg.remove()
      resolve(ok)
    }
    dlg.querySelector<HTMLButtonElement>('.ad-skip')!.onclick = () => finish(false)
    done.onclick = () => finish(true)
    // Esc로 닫으면 건너뛴 것으로 본다
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault()
      finish(false)
    })
    dlg.showModal()
    tick()
  })
}
