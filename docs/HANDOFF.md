# 손끝 교감 인수인계 (기술 → 서비스)

2026-10-01, 기술 담당 세션(pet-03)이 작성. 서비스 기능을 붙이는 세션이 읽고 시작하면 된다.

- 라이브: https://hyee0ne.github.io/sonkkeut-pet/ (`main`에 push하면 1분 안에 자동 배포)
- 저장소: https://github.com/Hyee0ne/sonkkeut-pet (공개)
- 로컬: `npm run dev` → http://localhost:5173 (포트가 차 있으면 5176 등), 휴대폰은 `npm run dev:mobile`
- 확인용 주소: `?debug` (fps·손 인식 시간 표시), `?debug=mouse` (카메라 없이 마우스로 쓰다듬기, Shift = 양손)

## 1. 역할 분담

| 기술 담당 (pet-03) | 서비스 담당 (새 세션) |
| --- | --- |
| 털 셰이더, 표정·움직임, 손 인식, 사진 → 실사 동물 파이프라인, 성능 | 화면·흐름, 데이터(보호 동물 정보), 저장·계정, 공고 연동 등 서비스 기능 |

**기술 담당 파일**: 고치기 전에 pet-03에 먼저 알려 주세요. 겉보기엔 작은 값도 다른 곳과 맞물려 있습니다.
- `src/fur.ts` 셰이더·표정·얼굴 움직임 물리
- `src/hand.ts`, `src/hand.worker.ts`, `src/hand-ids.ts` 손 인식
- `src/rigDerive.ts`, `src/rigEditor.ts`, `rig.html` 기준점 → 부위 계산, 기준점 편집 화면
- `src/pet.ts`의 몸짓·행동 부분 (`update`, `updateBehavior`, `pose`)
- `scripts/*` 파이프라인, `public/pets/*`, `src/rigs/*.json`의 `rig`
- `vite.config.ts` (페이지 경로·편집 화면 API)

**서비스 담당이 자유롭게**: `index.html`의 UI, `src/style.css`, `src/main.ts`의 UI 부분(탭·시작 화면·이벤트 처리), `src/pets.ts`의 `PETS` 목록과 `PetProfile` 필드 추가, `src/rigs/*.json`의 `profile`.

**함께 쓰는 파일 `src/main.ts`**: 아래 "건드리면 안 되는 루프"만 피하면 된다. 큰 구조 변경은 서로 알리고 하기.

## 2. 구조 한눈에

```
카메라 ─▶ hand.worker.ts (MediaPipe, 별도 스레드, 손 2개·21점)
            │
main.ts frame() 매 프레임
  currentInputs()  손 좌표 보간 → PetInput[] (손바닥 + 21점, 펫 로컬 좌표)
  pet.update()     pet.ts: 닿은 부위 판정, 기분(happy·startle·affection), 행동 스케줄러 → Pose, PetEvent[]
  updateFur()      손 → 사진 좌표, fur.ts의 FurField(털 눕기)·FaceMotion(얼굴 물리)
  draw()           fur.render(pose) WebGL 사진 셰이더 + 2D 캔버스(손끝 포인터)
```

- **좌표계 3가지**: 화면(CSS px) ↔ 펫 로컬(`toLocal`/`toStage`, 바닥 y=250) ↔ 사진 픽셀(`PhotoRig`). 변환은 `main.ts`와 `pets.ts`의 `photoToLocal`.
- **동물 데이터**: `src/pets.ts`의 `PETS`(초코, 손으로 맞춘 리그) + `src/rigs/<id>.json`(파이프라인이 만든 아이, 지금은 삼식 = id `cream`). 앱이 `import.meta.glob`으로 자동으로 불러와 탭에 붙인다.
- **사진이 없는 아이**는 `pet.ts`의 캔버스 그림으로 그려진다 (지금 목록에는 없음).

## 3. 서비스가 쓸 수 있는 연결점

- **아이 정보**: `PetProfile` (`name, species, breed, age, sex, story, tip, favorite, shy`). 새 필드는 자유롭게 추가. 파이프라인으로 만든 아이는 `src/rigs/<id>.json`의 `profile`을 고치거나 `npm run pet:add -- --id <id> --from register --name ... --story ...`(무료).
- **아이 바꾸기**: `main.ts`의 `selectPet(p)`.
- **이벤트**: `pet.update()`가 돌려주는 `PetEvent[]`
  - `{ type: 'say', text }` 말풍선용 대사 (지금은 **무시 중**: 사용자 요청으로 말풍선 제거)
  - `{ type: 'heart', x, y }` 하트 위치 (지금은 **무시 중**: 하트 제거)
  - `{ type: 'complete' }` 마음의 거리 100 도달 (지금은 **무시 중**: 완료 팝업 제거)
  - 다시 쓰려면 `main.ts` frame()에서 `pet.update()` 반환값을 받아 처리하면 된다.
- **상태 값** (`pet.pose`, 읽기 전용으로 쓰기): `happy`(0~1 기분), `petting`(쓰다듬는 중), `startle`(놀람), `sniffing`, `affection`(`pet.affection`, 0~100, 화면엔 안 보이지만 저장·사용 중), `pet.sniffed`(겁 많은 아이가 냄새를 기억했는지)
- **저장**: `localStorage['sonkkeut.affection.v1']` = `{ [petId]: affection }`. 계정 저장으로 바꾸면 여기를 대체.
- **손 상태**: `handViews`(화면 좌표 손), `tipTouch`(손끝이 몸에 닿았는지).

## 4. 지켜야 할 것 (사용자가 정한 원칙)

1. **렉 없는 게 최우선.** 지금 60fps, 메인 스레드 프레임당 0.2~0.5ms. 매 프레임 도는 코드(`frame`, `updateFur`, `draw`, `pet.update`)에 무거운 일(DOM 대량 갱신, 큰 라이브러리, 네트워크 대기)을 넣지 않기. 서비스 UI는 이벤트 때만 갱신.
2. **화면은 최소한으로.** 지금 화면엔 상단 아이 선택 탭(초코/삼식)과 손끝 포인터만 있다. 사용자가 직접 뺀 것: 마음의 거리 게이지, 완료 팝업, 하트, 말풍선, 프로필 카드, 앱 제목, 카메라 미리보기, 냄새 맡기 안내 원, 소리(합성음이 "물건 소리" 같고 렉이 느껴져서 전부 제거). 다시 넣으려면 사용자와 먼저 확인.
3. **개와 고양이는 다르게 반응한다.** 고양이는 기분 좋아도 입을 벌리지 않는다(게슴츠레·느린 눈 깜빡임·부비부비). 고양이 코는 만지지 않는다(반응·반사광 없음).
4. **포인터는 지금 디자인 유지** (손끝 5개 점, 닿으면 주황). 다른 안을 시도했다가 사용자가 되돌렸다.
5. **카메라 영상은 기기 밖으로 보내지 않는다.** 시작 화면에 그렇게 약속하고 있음.
6. **비용 민감**: 새 아이 하나 만드는 데 OpenAI API 약 $0.5. 힉스필드는 쓰지 않는다.

## 5. 새 아이 추가 (파이프라인)

```bash
npm run pet:add -- 사진.jpg --id <영문id> --species dog|cat --reference --name 이름 --breed ... --favorite head|chin|body [--shy true]
```
- `--reference`: 사진은 참고용, 정면 클로즈업을 새로 만든다 (가장 자연스럽지만 외모가 조금 다를 수 있음)
- 결과: `public/pets/<id>/`, `src/rigs/<id>.json` → 앱에 자동으로 탭 추가
- 기준점이 틀리면 `npm run dev` 후 `/rig.html?id=<id>`에서 고치고 "앱에 반영"
- 필요: macOS(배경 제거), Python 3 + Pillow·numpy·scipy·opencv-python-headless, `cwebp`, `.env.local`의 `OPENAI_API_KEY`
- **서비스에서 "보호소가 사진을 올리면 자동 생성"을 하려면** 이 파이프라인을 서버로 옮겨야 한다 (지금은 macOS 전용 단계와 로컬 Python이 있음). 그때는 pet-03과 함께 설계.

## 6. 배포·저장소 규칙

- `main`에 push하면 GitHub Actions가 빌드해 페이지에 배포 (`.github/workflows/pages.yml`, `GITHUB_PAGES=1`이면 경로가 `/sonkkeut-pet/`).
- 경로는 항상 `import.meta.env.BASE_URL` 기준으로 (절대경로 `/...` 쓰면 페이지에서 깨진다).
- 커밋하면 안 되는 것: `.env.local`(API 키), `pets-src/`, `generated-images/`(사용자의 원본 사진). 이미 `.gitignore`에 있음.
- 저장소가 **공개**라는 점 유의 (키·개인정보 절대 커밋 금지).
- 큰 작업은 브랜치에서 하고 `main`에 합치기 권장 (main = 곧 배포).

## 7. 기술 한계·남은 일 (참고)

- WebGL 텍스처를 8개 다 쓰고 있다 (저사양 폰 최소 한도). 셰이더에 이미지를 더 넣으려면 pet-03에 요청.
- 고양이 긴 수염은 얼굴이 움직이면 같이 휘어 보일 수 있음.
- 삼식(`cream`)은 `--reference`로 다시 만든 사진이라 실제 아이보다 털이 짧게 나왔다. 실제 정보(나이·성별·사연)도 비어 있음.
- 실제 휴대폰 성능은 아직 실기기로 재 보지 않았다 (`?debug`로 확인 가능).

## 8. 연락

기술 쪽 질문·요청은 세션 `pet-03`에 메시지로. 셰이더·파이프라인·성능 관련 변경이 필요하면 요청만 주면 처리한다.
