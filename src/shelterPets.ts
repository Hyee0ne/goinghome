/**
 * 실사화한 공고 아이들 (public/data/shelter-live.json, 배포 때 scripts/fetch-animals.ts가 만든다).
 * 공고가 끝난 아이는 그 파일에서 빠지므로 앱에서도 자동으로 사라진다.
 */
import { assetUrl, type PetProfile, type PhotoRig } from './pets'

interface LiveAnimal {
  kind: string
  age: string
  sex: 'M' | 'F' | 'Q'
  neuter: 'Y' | 'N' | 'U'
  weight: string
  color: string
  note: string
  photos: string[]
  care: { name: string; tel: string; addr: string }
  org: string
  noticeNo: string
  end: string
}

interface LivePet {
  id: string
  sp: 'dog' | 'cat'
  rig: PhotoRig
  /** 공고 사진 중 가장 정면인 사진 (shelter:make가 고른다, public 기준 경로) */
  photo?: string
  /** AI로 정면을 다시 그린 아이 (생김새가 원본과 조금 다를 수 있어 화면에 밝힌다) */
  aiFrontal?: boolean
  profile: LiveAnimal
}

export const isShelter = (p: PetProfile) => p.id.startsWith('shelter-')

/** 사진 경로에 BASE_URL을 붙인다 */
function withBase(rig: PhotoRig): PhotoRig {
  const ex = rig.expressions
  return {
    ...rig,
    src: assetUrl(rig.src),
    flow: assetUrl(rig.flow),
    catchlight: rig.catchlight && assetUrl(rig.catchlight),
    expressions: ex && {
      pant: ex.pant && { ...ex.pant, src: assetUrl(ex.pant.src) },
      eyesClosed: ex.eyesClosed && { ...ex.eyesClosed, src: assetUrl(ex.eyesClosed.src) },
      earsBack: ex.earsBack && { ...ex.earsBack, src: assetUrl(ex.earsBack.src) },
      morph: ex.morph && { ...ex.morph, src: assetUrl(ex.morph.src) },
    },
  }
}

function toProfile(l: LivePet): PetProfile {
  const a = l.profile
  const cat = l.sp === 'cat'
  return {
    id: `shelter-${l.id}`,
    // 공고에는 이름이 없어서 품종으로 부른다 (품종이 '기타'면 강아지·고양이로)
    name: a.kind && a.kind !== '기타' ? a.kind : cat ? '고양이' : '강아지',
    species: l.sp,
    breed: a.kind,
    coat: a.color,
    age: a.age,
    sex: a.sex === 'M' ? '남아' : a.sex === 'F' ? '여아' : '',
    story: a.note,
    tip: '',
    favorite: cat ? 'chin' : 'head',
    shy: false,
    traits: ['보호소 공고 중', a.neuter === 'Y' ? '중성화 완료' : '', a.weight].filter(Boolean),
    // 갤러리: 실사화한 얼굴 → 가장 정면인 공고 사진 → 나머지 공고 사진 (너무 많지 않게 5장까지)
    photos: [l.rig.src, ...(l.photo ? [l.photo] : []), ...(import.meta.env.VITE_DEMO === '1' ? [] : a.photos)].slice(0, 5),
    adoption: { shelter: a.care.name, region: a.org, noticeNo: a.noticeNo, tel: a.care.tel, noticeEnd: a.end, fromShelterPhoto: true, aiFrontal: !!l.aiFrontal },
    fur: cat ? '#e8d6c2' : '#9a6a44',
    furDark: cat ? '#c9b29a' : '#6e4a2e',
    belly: '#f1dcc3',
    eye: '#3b2a1e',
    pattern: 'none',
    photo: withBase(l.rig),
  }
}

export async function loadShelterPets(): Promise<PetProfile[]> {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}data/shelter-live.json`)
    if (!r.ok) return []
    const d: { pets: LivePet[] } = await r.json()
    return d.pets.map(toProfile)
  } catch {
    return []
  }
}
