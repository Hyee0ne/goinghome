/**
 * AI 표정 업그레이드 결과를 '우리 아이' 기록에 덧붙인다.
 * 결과는 scripts/pet-upgrade.ts(나중에는 같은 단계를 감싼 서버 함수)가 만든 upgrade.json과 그 파일들이다:
 * rig.expressions 조각의 경로(src)는 files의 키를 가리킨다 (앱이 열 때 objectURL로 바꾼다. main.ts myPetProfile)
 */
import type { MyPet } from '../myPets'
import type { PhotoRig } from '../pets'

export interface UpgradeResult {
  expressions: NonNullable<PhotoRig['expressions']>
  files: Record<string, Blob>
}

export function applyUpgrade(p: MyPet, r: UpgradeResult): MyPet {
  if (!p.rig) throw new Error('무료 버전이 먼저 있어야 해요')
  return {
    ...p,
    rig: { ...p.rig, expressions: r.expressions },
    files: { ...p.files, ...r.files },
    upgraded: true,
    ...(p.ai && { ai: { ...p.ai, status: 'done' as const } }),
  }
}
