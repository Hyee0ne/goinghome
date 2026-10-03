/**
 * '우리 아이 만들기' 엔진 계약 (서비스 화면 ↔ 기술 엔진).
 * 기술 쪽 실제 엔진(engine.ts)과 서비스 쪽 가짜 엔진(mockEngine.ts)이 같은 모양을 따른다.
 * 좌표는 모두 원본 사진 픽셀 단위.
 */
import type { Pt, Taps } from '../myPets'
import type { PhotoRig, Species } from '../pets'

export type MaskHandle = { readonly width: number; readonly height: number }

export interface MaskStroke {
  pts: Pt[]
  /** 붓 반지름 (사진 픽셀) */
  r: number
  mode: 'erase' | 'restore'
}

export interface RigResult {
  photo: PhotoRig
  /** PhotoRig의 src·flow 등이 가리키는 파일들 (키 = 경로) */
  files: Record<string, Blob>
  quality: {
    /** 정면도 0~1 (1이 정면). 낮으면 사진을 다시 고르라고 안내한다 */
    frontal: number
    warnings: string[]
  }
}

export interface MakerEngine {
  /** 배경 지우기 모델을 미리 받아 둔다 (화면에 들어올 때 부른다) */
  loadSegmenter(): Promise<void>
  /** 아이 몸을 한 번 탭한 자리로 배경을 지운다 */
  segment(img: ImageBitmap, tap: Pt): Promise<MaskHandle>
  /** 지우개·복원 붓 */
  editMask(m: MaskHandle, stroke: MaskStroke): void
  /** 실행 취소용 사본 (붓질·다시 톡 전에 떠 둔다). 엔진이 아직 없으면 실행 취소 버튼을 숨긴다 */
  cloneMask?(m: MaskHandle): MaskHandle
  /** 배경을 지운 사진 미리보기 (원본 크기) */
  maskPreview(img: ImageBitmap, m: MaskHandle): HTMLCanvasElement
  /** 탭한 점으로 앱용 리그와 파일을 만든다 */
  rigFromTaps(img: ImageBitmap, m: MaskHandle, taps: Taps, species: Species): Promise<RigResult>
}
