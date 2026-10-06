/**
 * 닮은 친구 찾기(/find)용 품종표 (2026-10-06).
 * 공고 품종 이름(공공데이터 kind)을 묶어, 같은 품종 → 생김새가 비슷한 무리 → 크기 순으로 닮은 아이를 고른다.
 * 공고의 대부분이 믹스견(약 82%)·한국 고양이(약 95%)라 같은 품종만으로는 결과가 거의 없어서 무리와 크기를 둔다.
 */

export type Size = 'small' | 'medium' | 'large'

export interface Breed {
  /** 사용자에게 보이는 이름 */
  label: string
  /** 이 품종으로 칠 공고 품종 이름(부분 일치) */
  match: RegExp
  /** 생김새가 비슷한 무리 */
  group: string
  size?: Size
}

/** 무리 이름 (닮은 이유 문구에 쓴다) */
export const GROUP_LABEL: Record<string, string> = {
  whiteCurly: '흰 곱슬 소형견',
  smallLong: '털이 긴 소형견',
  spitz: '진도·스피츠형',
  retriever: '리트리버형',
  herding: '목양견형',
  smallShort: '털이 짧은 소형견',
  hound: '하운드형',
  mixDog: '믹스견',
  flatLong: '털이 긴 납작 얼굴 고양이',
  roundShort: '동글동글 단모 고양이',
  pointed: '포인트 무늬 고양이',
  longCat: '털이 긴 고양이',
  korean: '코리안 숏헤어',
}

export const DOG_BREEDS: Breed[] = [
  { label: '믹스 · 잘 모르겠어요', match: /믹스|기타/, group: 'mixDog' },
  { label: '말티즈', match: /말티즈/, group: 'whiteCurly', size: 'small' },
  { label: '푸들', match: /푸들/, group: 'whiteCurly', size: 'small' },
  { label: '비숑 프리제', match: /비숑/, group: 'whiteCurly', size: 'small' },
  { label: '꼬똥 드 툴레아', match: /꼬똥|코통/, group: 'whiteCurly', size: 'small' },
  { label: '포메라니안', match: /포메/, group: 'smallLong', size: 'small' },
  { label: '시츄', match: /시츄|시추/, group: 'smallLong', size: 'small' },
  { label: '요크셔 테리어', match: /요크셔/, group: 'smallLong', size: 'small' },
  { label: '페키니즈', match: /페키니즈/, group: 'smallLong', size: 'small' },
  { label: '빠삐용', match: /빠삐용|파피용/, group: 'smallLong', size: 'small' },
  { label: '진돗개', match: /진도/, group: 'spitz', size: 'medium' },
  { label: '시바', match: /시바/, group: 'spitz', size: 'medium' },
  { label: '스피츠', match: /스피츠/, group: 'spitz', size: 'medium' },
  { label: '시베리안 허스키', match: /허스키|라이카/, group: 'spitz', size: 'large' },
  { label: '래브라도 리트리버', match: /라브라도|래브라도/, group: 'retriever', size: 'large' },
  { label: '골든 리트리버', match: /골든/, group: 'retriever', size: 'large' },
  { label: '보더 콜리', match: /보더/, group: 'herding', size: 'medium' },
  { label: '웰시 코기', match: /코기/, group: 'herding', size: 'medium' },
  { label: '셰퍼드', match: /셰퍼드|쉽독/, group: 'herding', size: 'large' },
  { label: '치와와', match: /치와와/, group: 'smallShort', size: 'small' },
  { label: '닥스훈트', match: /닥스/, group: 'smallShort', size: 'small' },
  { label: '프렌치 불독', match: /불독|퍼그/, group: 'smallShort', size: 'small' },
  { label: '미니어처 핀셔', match: /핀셔/, group: 'smallShort', size: 'small' },
  { label: '비글', match: /비글/, group: 'hound', size: 'medium' },
  { label: '그레이하운드 · 휘펫', match: /하운드|휘펫/, group: 'hound', size: 'medium' },
  { label: '코카 스파니엘', match: /코카|스파니엘/, group: 'hound', size: 'medium' },
  { label: '슈나우저', match: /슈나우/, group: 'smallShort', size: 'small' },
]

export const CAT_BREEDS: Breed[] = [
  { label: '코리안 숏헤어 · 잘 모르겠어요', match: /한국 고양이|믹스|기타/, group: 'korean' },
  { label: '페르시안', match: /페르시안|친칠라/, group: 'flatLong' },
  { label: '브리티시 쇼트헤어', match: /브리티시/, group: 'roundShort' },
  { label: '아메리칸 쇼트헤어', match: /아메리칸/, group: 'roundShort' },
  { label: '스코티시 폴드', match: /스코티시/, group: 'roundShort' },
  { label: '러시안 블루', match: /러시안/, group: 'roundShort' },
  { label: '샴', match: /샴/, group: 'pointed' },
  { label: '랙돌', match: /레그돌|랙돌|래그돌/, group: 'pointed' },
  { label: '터키시 앙고라', match: /앙고라/, group: 'longCat' },
  { label: '노르웨이 숲', match: /노르웨이/, group: 'longCat' },
  { label: '아비시니안', match: /아비시니안/, group: 'roundShort' },
]

/** 공고 품종 이름 → 품종표 항목 (없으면 믹스·코숏으로 본다) */
export function breedOf(kind: string, sp: 'dog' | 'cat'): Breed {
  const list = sp === 'cat' ? CAT_BREEDS : DOG_BREEDS
  return list.slice(1).find((b) => b.match.test(kind)) ?? list[0]
}

/** 공고 몸무게('12kg') → 크기 (모르면 undefined) */
export function sizeOfWeight(weight?: string): Size | undefined {
  const kg = parseFloat(weight ?? '')
  if (!Number.isFinite(kg) || kg <= 0) return undefined
  return kg < 8 ? 'small' : kg < 20 ? 'medium' : 'large'
}
