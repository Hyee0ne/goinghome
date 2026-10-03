/**
 * 보상형 광고: 끝까지 보면 AI로 만들기가 열린다.
 * 가안: 실제 광고 대신 자리 표시 화면과 15초 카운트다운. 광고 네트워크(예: Google Ad Manager의 웹 보상형 광고)를
 * 붙일 때 showRewardedAd 안쪽만 바꾼다. 결과는 '끝까지 봤는지'만 돌려준다.
 */

import { aiCredits } from './credits'

const LENGTH = 15

/** AI로 만들기 열기: 공유로 받은 기회가 있으면 쓸지 묻고, 없거나 아끼면 광고 */
export async function unlockAi(): Promise<boolean> {
  if (aiCredits.count > 0) {
    const choice = await ask(
      `공유로 받은 기회가 ${aiCredits.count}번 있어요`,
      '기회를 쓰면 광고 없이 바로 AI로 만들어요.',
      ['광고 보고 아끼기', '기회 쓰기'],
    )
    if (choice === 1 && aiCredits.use()) return true
  }
  return showRewardedAd()
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
      <div class="ad-head"><b>광고를 보면 AI 표정을 만들어 드려요</b><span class="ad-timer"></span></div>
      <div class="ad-slot" role="img" aria-label="광고 자리">
        <span>광고 자리 (가안)</span>
      </div>
      <div class="ad-foot">
        <button type="button" class="btn ghost ad-skip">무료로만 만들기</button>
        <button type="button" class="btn primary ad-done" disabled>AI로 만들기</button>
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
