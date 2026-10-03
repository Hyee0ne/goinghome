/**
 * 공고 중인 유기동물을 받아 앱용 데이터 파일(public/data/animals.json)로 만든다.
 *
 *   npm run data:animals        (.env.local 또는 환경 변수의 DATA_GO_KR_SERVICE_KEY)
 *
 * 출처: 공공데이터포털 '농림축산식품부 농림축산검역본부_국가동물보호정보시스템 구조동물 조회 서비스' (이용허락범위 제한 없음)
 * 키는 브라우저에 드러나지 않게 여기(빌드할 때)에서만 쓴다. 배포 워크플로가 1시간마다 다시 돌린다.
 * 키가 없으면 빈 목록을 쓰고 끝낸다 (빌드가 멈추지 않게).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const OUT = join(import.meta.dirname, '..', 'public', 'data', 'animals.json')
const API = 'https://apis.data.go.kr/1543061/abandonmentPublicService_v2/abandonmentPublic_v2'
const PAGE = 1000

function serviceKey() {
  if (process.env.DATA_GO_KR_SERVICE_KEY) return process.env.DATA_GO_KR_SERVICE_KEY.trim()
  const env = join(import.meta.dirname, '..', '.env.local')
  if (!existsSync(env)) return ''
  const line = readFileSync(env, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('DATA_GO_KR_SERVICE_KEY='))
  return line ? line.slice(line.indexOf('=') + 1).trim() : ''
}

/** 앱이 쓰는 모양 (용량을 줄이려고 짧은 이름) */
export interface Animal {
  id: string
  sp: 'dog' | 'cat' | 'etc'
  kind: string
  age: string
  sex: 'M' | 'F' | 'Q'
  neuter: 'Y' | 'N' | 'U'
  color: string
  weight: string
  /** 특징 · 사회성 · 건강 · 특이사항을 이어 붙인 것 */
  note: string
  photos: string[]
  care: { name: string; tel: string; addr: string }
  org: string
  /** 시도 (지역 거르기용) */
  sido: string
  noticeNo: string
  /** 공고 종료일 YYYYMMDD */
  end: string
}

type Raw = Record<string, string | undefined>

/** '2026(60일미만)(년생)' → '60일 미만', '2022(년생)' → '2022년생' */
function ageText(raw: string) {
  const inner = raw.match(/^\d{4}\(([^)]*?)\)\(년생\)$/)
  if (inner && inner[1] !== '년생') return inner[1].replace('미만', ' 미만')
  return raw.replace('(년생)', '년생')
}

const https = (u?: string) => (u ? u.replace(/^http:\/\//, 'https://') : '')

function toAnimal(r: Raw): Animal {
  const photos = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => https(r[`popfile${i}`])).filter(Boolean)
  const note = [r.specialMark, r.sfeSoci, r.sfeHealth, r.etcBigo]
    .map((s) => (s ?? '').trim())
    .filter((s, i, a) => s && a.indexOf(s) === i)
    .join(' · ')
  return {
    id: r.desertionNo ?? '',
    sp: r.upKindCd === '417000' ? 'dog' : r.upKindCd === '422400' ? 'cat' : 'etc',
    kind: r.kindNm ?? '',
    age: ageText(r.age ?? ''),
    sex: (r.sexCd as Animal['sex']) ?? 'Q',
    neuter: (r.neuterYn as Animal['neuter']) ?? 'U',
    color: r.colorCd ?? '',
    weight: (r.weight ?? '').replace('(Kg)', 'kg'),
    note,
    photos,
    care: { name: r.careNm ?? '', tel: r.careTel ?? '', addr: r.careAddr ?? '' },
    org: r.orgNm ?? '',
    sido: (r.orgNm ?? '').split(' ')[0],
    noticeNo: r.noticeNo ?? '',
    end: r.noticeEdt ?? '',
  }
}

async function page(key: string, no: number) {
  const q = new URLSearchParams({ serviceKey: key, _type: 'json', state: 'notice', numOfRows: String(PAGE), pageNo: String(no) })
  const res = await fetch(`${API}?${q}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()).response?.body
  const items = body?.items?.item ?? []
  return { total: Number(body?.totalCount ?? 0), items: (Array.isArray(items) ? items : [items]) as Raw[] }
}

async function main() {
  mkdirSync(dirname(OUT), { recursive: true })
  const key = serviceKey()
  if (!key) {
    console.warn('DATA_GO_KR_SERVICE_KEY가 없어 빈 목록을 씁니다')
    writeFileSync(OUT, JSON.stringify({ updated: null, animals: [] }))
    return
  }
  const first = await page(key, 1)
  const raws = [...first.items]
  for (let no = 2; (no - 1) * PAGE < first.total; no++) raws.push(...(await page(key, no)).items)
  const animals = raws
    .map(toAnimal)
    .filter((a) => a.id && a.photos.length)
    // 공고가 곧 끝나는 아이부터
    .sort((a, b) => a.end.localeCompare(b.end))
  writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), animals }))
  console.log(`공고 중 ${first.total}마리 → 사진 있는 ${animals.length}마리를 ${OUT}에 썼어요`)
}

main().catch((e) => {
  // 받아 오지 못해도 빌드는 계속한다 (지난번 파일이 있으면 그대로)
  console.error('유기동물 데이터를 받지 못했어요:', e instanceof Error ? e.message : e)
  if (!existsSync(OUT)) writeFileSync(OUT, JSON.stringify({ updated: null, animals: [] }))
})
