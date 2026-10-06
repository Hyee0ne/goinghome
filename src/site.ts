/**
 * 사이트 주소: 한 곳에서만 바꾼다 (도메인을 사면 여기만 고치면 된다, 2026-10-06).
 * OG 태그(index·make·adopt의 %SITE_URL%)와 공유 영상 워터마크의 주소가 이 값을 쓴다.
 * 끝에 /를 붙인다.
 */
export const SITE_URL = 'https://hyee0ne.github.io/goinghome/'

/** 워터마크·엔드카드에 보이는 짧은 주소 (https://와 끝의 / 없이) */
export const SITE_LABEL = SITE_URL.replace(/^https?:\/\//, '').replace(/\/$/, '')

/** 미리보기 이미지 버전: 카톡은 이미지를 캐시해서 디버거로도 안 지워진다. 이미지를 바꾸면 숫자를 올린다 */
export const OG_IMAGE_VERSION = 1
