/** 왼손/오른손 이름으로 손을 구분한다. 드물게 둘 다 같은 쪽으로 나오면 순서로 구분한다 */
export function handIds(names: string[]) {
  return names.map((n, i) => (names.indexOf(n) === i && n ? n : `${n || 'hand'}${i}`))
}
