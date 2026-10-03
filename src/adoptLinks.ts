/**
 * 유기동물 입양 사이트 연결. 공유로 들어온 화면, 우리 아이 완성 화면, 아이 정보 시트에서 같이 쓴다.
 * 주소는 2026-10-03에 열리는지 확인했다.
 */

export interface AdoptSite {
  name: string
  desc: string
  url: string
  icon: string
}

export const ADOPT_SITES: AdoptSite[] = [
  { name: '포인핸드', desc: '전국 보호소 공고를 한곳에서', url: 'https://pawinhand.kr', icon: '🐾' },
  { name: '국가동물보호정보시스템', desc: '지자체 보호소 공고 (농림축산식품부)', url: 'https://www.animal.go.kr', icon: '🏛️' },
  { name: '동물권행동 카라', desc: '보호 중인 아이들 입양', url: 'https://www.ekara.org', icon: '💛' },
  { name: '동물자유연대', desc: '보호 중인 아이들 입양', url: 'https://www.animals.or.kr', icon: '🏡' },
]

/** 사이트 목록을 그린다. 링크는 새 탭으로 연다 */
export function renderAdoptLinks(el: HTMLElement, title = '가족을 기다리는 아이들') {
  el.classList.add('adopt-links')
  const h = Object.assign(document.createElement('h3'), { textContent: title })
  const list = document.createElement('ul')
  list.append(
    ...ADOPT_SITES.map((s) => {
      const li = document.createElement('li')
      const a = Object.assign(document.createElement('a'), { href: s.url, target: '_blank', rel: 'noopener' })
      a.append(
        Object.assign(document.createElement('span'), { className: 'adopt-icon', textContent: s.icon }),
        Object.assign(document.createElement('span'), { className: 'adopt-text' }),
        Object.assign(document.createElement('span'), { className: 'adopt-go', textContent: '↗' }),
      )
      const text = a.querySelector('.adopt-text')!
      text.append(Object.assign(document.createElement('b'), { textContent: s.name }), Object.assign(document.createElement('small'), { textContent: s.desc }))
      li.append(a)
      return li
    }),
  )
  el.replaceChildren(h, list)
}
