/**
 * '우리 아이' 저장소. 사용자가 만든 반려동물은 이 기기(IndexedDB)에만 저장하고 서버로 보내지 않는다.
 * 사진이 커서 localStorage 대신 IndexedDB에 Blob 그대로 넣는다.
 */
import type { PhotoRig, Species } from './pets'

export interface Pt {
  x: number
  y: number
}

/** 사용자가 사진 위에 찍은 점 (원본 사진 픽셀 좌표) */
export interface Taps {
  eyeL: Pt
  eyeR: Pt
  nose: Pt
  chin: Pt
  earL?: Pt
  earR?: Pt
}

export interface MyPet {
  id: string
  name: string
  species: Species
  createdAt: string
  /** 원본 사진 (기기 안에만) */
  photo: Blob
  taps: Taps
  /** 엔진이 만든 앱용 리그. src 등 파일 경로는 files의 키를 가리킨다 (열 때 objectURL로 바꾼다) */
  rig?: PhotoRig
  files?: Record<string, Blob>
  /** 털색 (닮은 보호소 아이 찾기용, 배경 지운 사진의 평균) */
  color?: [number, number, number]
  /** 표정 업그레이드(선택, 서버 AI)를 했는지 */
  upgraded?: boolean
  /** AI 표정 업그레이드 신청 (참고 사진은 서버에 보낼 때까지 기기에만) */
  ai?: {
    status: 'waiting' | 'making' | 'done' | 'failed'
    requestedAt: string
    refs: Blob[]
    canPaw: boolean
  }
}

const DB = 'sonkkeut'
const STORE = 'myPets'

function open() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>) {
  const db = await open()
  return new Promise<T>((resolve, reject) => {
    const req = run(db.transaction(STORE, mode).objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }).finally(() => db.close())
}

export const myPets = {
  list: () => tx<MyPet[]>('readonly', (s) => s.getAll() as IDBRequest<MyPet[]>).then((l) => l.sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
  get: (id: string) => tx<MyPet | undefined>('readonly', (s) => s.get(id) as IDBRequest<MyPet | undefined>),
  put: (p: MyPet) => tx('readwrite', (s) => s.put(p)),
  remove: (id: string) => tx('readwrite', (s) => s.delete(id)),
}

export const newPetId = () => `mine-${Date.now().toString(36)}`
