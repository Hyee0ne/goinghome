import './style.css'
import './register.css'
import type { PetProfile, Species, Zone } from './pets'

/**
 * 보호소용 등록 화면 (가안).
 * 서버가 생기기 전까지는 이 브라우저(localStorage)에만 저장하고, 사진 → 실사 동물 만들기는
 * 개발자가 `npm run pet:add`로 돌린다 (등록 목록에서 명령어를 복사할 수 있다).
 */

const STORAGE_KEY = 'sonkkeut.registrations.v1'
const MAX_PHOTOS = 6
/** 올린 사진은 이 크기(긴 변)로 줄여 WebP로 저장한다. 슬라이드 칸이 최대 440px라 2배면 충분 */
const PHOTO_EDGE = 900

type Status = 'waiting'

export interface Registration {
  id: string
  createdAt: string
  status: Status
  profile: Pick<PetProfile, 'name' | 'species' | 'breed' | 'age' | 'sex' | 'story' | 'favorite' | 'shy' | 'traits' | 'adoption' | 'canPaw'>
  /** 첫 장이 대표 사진 (실사 동물을 만드는 사진). data URL */
  photos: string[]
}

const TRAITS: Record<Species, string[]> = {
  dog: ['사람을 좋아해요', '낯을 가려요', '산책 좋아해요', '활발해요', '조용한 편이에요', '다른 강아지와 잘 지내요', '배변 훈련 됐어요'],
  cat: ['사람을 좋아해요', '낯을 가려요', '조용한 편이에요', '호기심 많아요', '무릎냥이에요', '다른 고양이와 잘 지내요', '화장실 잘 가려요'],
}
const STATUS_LABEL: Record<Status, string> = { waiting: '실사 만들기 대기' }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const form = $<HTMLFormElement>('reg-form')
const photoList = $('photo-list')
const photoInput = $<HTMLInputElement>('photo-input')
const chips = $('trait-chips')
const traitInput = $<HTMLInputElement>('trait-input')
const pawField = $('paw-field')

// ───────────────────────── 사진 ─────────────────────────

let photos: string[] = []

/** 사진을 줄여 WebP data URL로 만든다. 다시 그리면서 위치 같은 메타데이터도 함께 사라진다 */
async function shrink(file: File) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const k = Math.min(1, PHOTO_EDGE / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas')
  c.width = Math.round(bmp.width * k)
  c.height = Math.round(bmp.height * k)
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
  bmp.close()
  return c.toDataURL('image/webp', 0.8)
}

photoInput.addEventListener('change', async () => {
  const files = [...(photoInput.files ?? [])].slice(0, MAX_PHOTOS - photos.length)
  photoInput.value = ''
  for (const f of files) {
    try {
      photos.push(await shrink(f))
    } catch {
      alert(`${f.name}은(는) 열 수 없는 사진이에요.`)
    }
  }
  renderPhotos()
})

function renderPhotos() {
  const add = photoList.querySelector('.photo-add') as HTMLElement
  photoList.querySelectorAll('.photo').forEach((n) => n.remove())
  photos.forEach((src, i) => {
    const item = document.createElement('figure')
    item.className = 'photo' + (i === 0 ? ' main' : '')
    const img = new Image()
    img.src = src
    img.alt = `사진 ${i + 1}`
    const del = Object.assign(document.createElement('button'), { type: 'button', className: 'photo-del', textContent: '✕' })
    del.setAttribute('aria-label', `사진 ${i + 1} 지우기`)
    del.onclick = () => {
      photos.splice(i, 1)
      renderPhotos()
    }
    item.append(img, del)
    if (i === 0) {
      item.append(Object.assign(document.createElement('figcaption'), { textContent: '대표' }))
    } else {
      const lead = Object.assign(document.createElement('button'), { type: 'button', className: 'photo-lead', textContent: '대표로' })
      lead.onclick = () => {
        photos.unshift(...photos.splice(i, 1))
        renderPhotos()
      }
      item.append(lead)
    }
    photoList.insertBefore(item, add)
  })
  add.hidden = photos.length >= MAX_PHOTOS
  if (photos.length) showError('photos', false)
}

// ───────────────────────── 종류 · 성격 ─────────────────────────

const species = () => (form.elements.namedItem('species') as RadioNodeList).value as Species
/** 고른 성격 (직접 적은 것 포함) */
const picked = new Set<string>()
const custom: string[] = []

function renderChips() {
  const all = [...TRAITS[species()], ...custom.filter((t) => !TRAITS[species()].includes(t))]
  chips.replaceChildren(
    ...all.map((t) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'chip', textContent: t })
      b.setAttribute('aria-pressed', String(picked.has(t)))
      b.onclick = () => {
        if (picked.has(t)) picked.delete(t)
        else picked.add(t)
        b.setAttribute('aria-pressed', String(picked.has(t)))
      }
      return b
    }),
  )
}

function addCustomTrait() {
  const t = traitInput.value.trim()
  if (!t) return
  if (!custom.includes(t)) custom.push(t)
  picked.add(t)
  traitInput.value = ''
  renderChips()
}
$('trait-add').onclick = addCustomTrait
traitInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    addCustomTrait()
  }
})

/** 고양이는 '손' 개인기 선택지가 없다 */
function onSpecies() {
  const dog = species() === 'dog'
  pawField.hidden = !dog
  if (!dog) (form.elements.namedItem('canPaw') as HTMLInputElement).checked = false
  // 종류가 바뀌면 그 종류에 없는 기본 성격은 고른 것에서 뺀다
  for (const t of [...picked]) if (!TRAITS[species()].includes(t) && !custom.includes(t)) picked.delete(t)
  renderChips()
}
form.querySelectorAll('input[name=species]').forEach((r) => r.addEventListener('change', onSpecies))

const story = $<HTMLTextAreaElement>('f-story')
story.addEventListener('input', () => ($('story-count').textContent = String(story.value.length)))

// ───────────────────────── 저장 ─────────────────────────

function load(): Registration[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
  } catch {
    return []
  }
}
function save(list: Registration[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
}

// 고치기 시작하면 그 칸의 오류 문구를 지운다
form.addEventListener('input', (e) => {
  const name = (e.target as HTMLInputElement).name
  if (name) showError(name, false)
})

function showError(key: string, on: boolean) {
  const el = form.querySelector<HTMLElement>(`.reg-error[data-for="${key}"]`)
  if (el) el.hidden = !on
}

form.addEventListener('submit', (e) => {
  e.preventDefault()
  const v = (name: string) => ((form.elements.namedItem(name) as HTMLInputElement | null)?.value ?? '').trim()
  const checked = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).checked
  const url = v('url')
  const errors: Record<string, boolean> = {
    photos: photos.length === 0,
    name: !v('name'),
    shelter: !v('shelter'),
    region: !v('region'),
    url: !!url && !/^https:\/\/(www\.)?pawinhand\.kr(\/|$)/.test(url),
  }
  for (const [k, on] of Object.entries(errors)) showError(k, on)
  const first = Object.keys(errors).find((k) => errors[k])
  if (first) {
    form.querySelector(`.reg-error[data-for="${first}"]`)?.closest('.reg-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }

  const sp = species()
  const traits = [...picked]
  if (checked('neutered')) traits.push('중성화 완료')
  const reg: Registration = {
    id: `pet-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    status: 'waiting',
    profile: {
      name: v('name'),
      species: sp,
      breed: v('breed') || (sp === 'cat' ? '코리안 숏헤어' : '믹스견'),
      age: v('age'),
      sex: v('sex'),
      story: v('story'),
      favorite: v('favorite') as Zone,
      shy: checked('shy'),
      ...(sp === 'dog' && { canPaw: checked('canPaw') }),
      traits,
      adoption: { shelter: v('shelter'), region: v('region'), noticeNo: v('noticeNo') || undefined, url: url || undefined },
    },
    photos,
  }
  try {
    save([reg, ...load()])
  } catch {
    alert('이 브라우저의 저장 공간이 가득 찼어요. 등록한 아이를 몇 마리 지운 뒤 다시 시도해 주세요.')
    return
  }
  form.reset()
  photos = []
  picked.clear()
  custom.length = 0
  $('story-count').textContent = '0'
  onSpecies()
  renderPhotos()
  renderList()
  $('reg-done').scrollIntoView({ behavior: 'smooth', block: 'start' })
})

// ───────────────────────── 등록 목록 ─────────────────────────

/** 지금 사진 파이프라인으로 실사 동물을 만드는 명령어 (서버가 생기면 자동으로 돌린다) */
function pipelineCommand(r: Registration) {
  const p = r.profile
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const args = [
    `npm run pet:add -- <대표사진.jpg> --id ${r.id} --species ${p.species}`,
    `--name ${q(p.name)}`,
    p.breed && `--breed ${q(p.breed)}`,
    p.age && `--age ${q(p.age)}`,
    p.sex && `--sex ${q(p.sex)}`,
    p.story && `--story ${q(p.story)}`,
    `--favorite ${p.favorite}`,
    p.shy && '--shy true',
    p.canPaw && '--paw true',
  ]
  return args.filter(Boolean).join(' ')
}

function renderList() {
  const list = load()
  $('reg-done').hidden = list.length === 0
  $('reg-items').replaceChildren(
    ...list.map((r) => {
      const li = document.createElement('li')
      li.className = 'reg-item'
      const img = new Image()
      img.src = r.photos[0]
      img.alt = ''
      const text = document.createElement('div')
      const p = r.profile
      text.append(
        Object.assign(document.createElement('b'), { textContent: `${p.species === 'dog' ? '🐶' : '🐱'} ${p.name}` }),
        Object.assign(document.createElement('span'), {
          textContent: [p.breed, p.sex, p.age, p.canPaw ? "'손'\u00a0가능" : ''].filter(Boolean).join(' · '),
        }),
        Object.assign(document.createElement('span'), { className: 'status', textContent: STATUS_LABEL[r.status] }),
      )
      const actions = document.createElement('div')
      actions.className = 'reg-actions'
      const copy = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small', textContent: '명령어 복사' })
      copy.title = '개발용: 이 아이를 실사로 만드는 명령어'
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(pipelineCommand(r))
          copy.textContent = '복사했어요'
        } catch {
          prompt('아래 명령어를 복사해 주세요', pipelineCommand(r))
        }
      }
      const del = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small ghost', textContent: '삭제' })
      del.onclick = () => {
        if (!confirm(`${p.name} 등록을 지울까요?`)) return
        save(load().filter((x) => x.id !== r.id))
        renderList()
      }
      actions.append(copy, del)
      li.append(img, text, actions)
      return li
    }),
  )
}

onSpecies()
renderPhotos()
renderList()
