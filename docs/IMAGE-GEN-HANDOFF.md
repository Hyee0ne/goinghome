# 이미지 생성 인수인계: 로컬 생성 모델로 바꾸기

고잉홈의 '고퀄' 보호소 아이(✨ 생생 쓰다듬기)에 쓰는 AI 이미지를 지금까지는 ChatGPT(gpt-image)로 만들었다.
앞으로는 **로컬 이미지 생성 모델**로 만든다. 작업은 두 대에서 Claude Code로 한다.

| 기기 | 하는 일 |
|---|---|
| **Windows 로컬** (생성 모델이 있는 곳) | 정면·표정 이미지를 만든다 → `images-incoming` 브랜치로 올린다 |
| **Mac 로컬** (이 저장소 원래 자리) | 이미지를 받아 누끼·기준점·표정 레이어를 만들고, 공개 목록 확정·dev 반영 |

> 누끼(배경 지우기)와 기준점 찾기는 macOS의 Apple Vision을 쓴다. **파이프라인(`npm run shelter:make`)은 Mac에서만 돈다.** Windows는 이미지만 만든다.

---

## 1. 한 마리에 필요한 이미지

공고 원본 사진(공공데이터 API, `public/data/animals.json`의 `photos`)을 참고해서 만든다.

| 파일 | 내용 | 필수 |
|---|---|---|
| `front.png` | 정면 사진. 입 다묾, 두 눈 뜨고 렌즈를 봄 | ✅ |
| `smile.png` | **front.png를 편집**: 입 살짝 벌림, 혀끝만 보임 (중간 단계). **눈은 뜬 채 그대로** | ✅ |
| `pant.png` | **front.png를 편집**: 강아지는 입 크게 벌리고 혀를 아랫니 위로 내민 헥헥 / 고양이는 츄르 핥듯 혀를 내밀어 살짝 말아 올림. **눈은 뜬 채 그대로** | ✅ |
| `eyes-closed.png` | **front.png를 편집**: 두 눈을 **끝까지** 감음. **입은 다문 채 그대로** | ✅ (없으면 앱이 그린 빠른 깜빡임으로 대신) |

> 파이프라인이 합치는 방식: 앱의 마지막 표정은 '눈 감고 헥헥'이다. `pant.png`의 두 눈 둘레만 `eyes-closed.png`의 눈으로 바꿔 만든다.
> 그래서 표정마다 **한 부위만** 바꿔야 한다(입 이미지는 눈 그대로, 눈 이미지는 입 그대로). 중간 장면(`smile.png`)은 눈을 뜬 채라 눈은 '뜬 눈 ↔ 감은 눈' 두 상태로만 움직인다.

품질 기준은 **공고 413583202600620(광주-담양-2026-00078, 흰 믹스견)**이다. 입 다문 정면, 눈 감고 웃기, 헥헥, 간식 먹기가 다 나온다. 간식 먹기는 입 표정으로 앱이 그리므로 따로 이미지가 필요 없다.

### front.png 규격
- 같은 아이: 털색·길이, 무늬 위치, 얼굴형, 눈 색, 귀 모양(선 귀는 선 채로, 접힌 귀는 접힌 채로)
- 정면, 고개 수평, 가운데. 머리가 화면 대부분, 두 귀가 다 보이고 아래에 가슴 윗부분만
- 원본에서 머리·귀·턱이 잘려 있으면 보이는 부분에 맞춰 자연스럽게 채운다
- 세로 사진, 1024×1536(2:3)이나 1086×1448(3:4) 등 아무 세로 비율이나 된다 (최소 880×1184). 파이프라인이 얼굴 위주로 다시 자른다. **두 눈 사이가 200픽셀 이상**이면 털이 또렷하다. PNG
- 고르고 부드러운 조명, 털·수염이 또렷하게. 배경은 단색(투명이면 더 좋다)
- 사람 손, 목줄, 철창, 음식, 글자가 없어야 한다

참고로 ChatGPT에 쓰던 정면 프롬프트는 `scripts/pet-add.ts`의 `--reference` 부분에 있다. 로컬 모델에 그대로 써도 된다.

### 표정 이미지(smile / pant / eyes-closed) 규칙: 가장 중요
1. **반드시 front.png를 편집해서 만든다.** 인페인팅이나 img2img로, 바꿀 부위(입 또는 눈)에만 마스크를 씌운다. 새로 그리면 안 된다.
2. 크기, 머리 위치, 각도, 구도, 털, 조명, 배경이 **front.png와 픽셀 단위로 같아야** 한다. 해상도도 같게. 파이프라인이 눈 기준으로 맞추고 주둥이는 따로 한 번 더 맞춰 주지만, 어긋남이 클수록 결과가 나빠진다.
3. **눈은 '완전히 감음' 아니면 '동그랗게 뜸' 둘 중 하나만.** 반쯤 감은 눈(게슴츠레)은 쓰지 않는다. 사용자가 가장 싫어하는 표정이다.
4. 강아지는 헥헥할 때 코가 움직이지 않는다. 코 모양과 위치는 그대로 둔다.
5. 음식, 손, 사람은 넣지 않는다.
6. **밝기는 만지지 않고 생성한 그대로 넘긴다.** 아이들끼리 밝기는 Mac 파이프라인이 맞춘다(정면에 약한 감마, 표정에도 같은 값). 꼭 만져야 하면 네 장 모두 **똑같이** 바꾼다. 장마다 다르면 표정이 바뀔 때 눈·입 둘레에 밝기 경계가 생긴다.

> **실패 사례 (2026-10-06, 공고 441554202601848)**: 로컬 모델이 웃는 얼굴을 새로 그리면서 주둥이를 8도 돌리고 코를 위로 올려 그렸다. 그 결과 앱에서 입이 돌아가고 코가 두 겹으로 보였다. 지금은 파이프라인이 주둥이를 따로 맞춰 고쳐 주지만(코 일치 0.5 미만, 회전 12도 이상이면 포기), 처음부터 편집 방식으로 만드는 것이 가장 확실하다.
> 같은 사례의 eyes-closed는 반쯤 감은 눈이라 쓰지 못했다.

### 프롬프트 참고 (ChatGPT에 쓰던 것, `scripts/pet-add.ts`의 `prompts()`)
- 공통 꼬리말: *Keep everything else exactly identical to the original photo: same head position, size, angle and framing, same fur, markings, ear shape and position, lighting and colors, same background. Photorealistic.*
- 강아지 smile: *mouth slightly open in a soft smile, lips just parted with the tip of the pink tongue visible.*
- 강아지 pant: *happily panting, mouth open in a relaxed doggy smile with the pink tongue slightly out over the lower teeth. Eyes and ears unchanged.*
- 고양이 smile: *mouth slightly open with just the tip of the small pink tongue showing, as if about to lick a treat. No food in the image.*
- 고양이 pant: *pink tongue stuck out and curled slightly upward, licking as if lapping a creamy treat. No food in the image.*
- eyes-closed: *both eyes gently closed, relaxed and content, eyelids fully shut. Mouth and ears unchanged.*

---

## 2. Windows → Mac 전달

- 브랜치 **`images-incoming`**에 올린다. **main에는 절대 올리지 않는다.** main에 push하면 GitHub Pages가 자동 배포된다(`.github/workflows/pages.yml`). 지금 사이트 배포는 사용자가 막아 둔 상태다.
- 폴더 구조: `incoming/<공고번호>/front.png, smile.png, pant.png[, eyes-closed.png]`
  - 공고번호는 `animals.json`의 `id`다(예: `413583202600620`). `noticeNo`(예: 광주-담양-2026-00078)도 같이 적고 싶으면 `incoming/<id>/README.txt`에 한 줄로.
- 저장소는 **공개**다. 공고 사진 기반 이미지(공공데이터)만 올린다. 사용자 개인 반려동물 사진, `.env.local`, API 키는 절대 올리지 않는다.
- 이미지 메타데이터(위치 등)는 지우고 올린다.

## 3. Mac에서 받기 (파이프라인)

```bash
git fetch origin images-incoming
git checkout origin/images-incoming -- incoming/<id>      # 작업 폴더로 가져오기 (커밋하지 않음)
D=incoming/<id>
npm run shelter:make -- --hq <id> --images $D/front.png,$D/smile.png,$D/pant.png,$D/eyes-closed.png
# 순서: 정면, 웃음(중간), 헥헥(최종), 눈 감음(선택). 눈 감음이 없으면 세 장만
```

- 무료다. ChatGPT나 API를 부르지 않는다.
- 밝기 맞춤이 자동으로 들어간다: 동물 부분 밝기 중앙값을 0.68 쪽으로 (어두우면 차이의 40%만 밝히고, 밝으면 25%만 낮춤, 감마 0.8~1.12). 흰 털·검은 털은 그대로다. 끄려면 `--no-brighten`. 미리보기에 '밝기 전→후'가 보인다.
- 그 아이가 무료 판정 후보(`pets-src/shelter-stage/verdicts.json`)에 있어야 한다. 없으면 먼저 `npm run shelter:make`.
- 결과는 `pets-src/shelter-<id>-hq/`(커밋 금지)와 `public/pets/shelter-<id>-hq/`에 생긴다.
- `--images`는 한 번에 한 마리만 받는다.

### 확인
1. `pets-src/shelter-stage/preview.html`: 원본과 닮았는지, '✅ 표정 완성'인지
2. 정면과 표정을 반반 겹쳐서 **코가 한 겹인지, 입이 수평인지** 확인한다
3. `http://localhost:<vite 포트>/rig.html?id=shelter-<id>-hq`에서 기준점 다듬기 → **저장**. 손으로 맞춘 아이만 고개 기울이기까지 움직인다(FULL). 다시 돌려도 손으로 맞춘 기준점은 덮어쓰지 않는다

### 공개 목록 확정과 dev 반영
```bash
npm run shelter:make -- --publish <공개할 id들, 쉼표로, 최대 20>   # 로컬 shelter-data 브랜치를 새로 만든다 (push 금지)
# 서비스 worktree(../pet-service)에서
rm -rf public/shelter && mkdir -p public/shelter && git -C ../pet archive shelter-data | tar -x -C public/shelter
npm run data:animals
```
- `--publish`는 매번 목록 전체로 새로 만든다. 지금 공개 중인 18마리 목록에 새 아이를 더해서 넘긴다.
- `git push origin shelter-data`는 사이트 공개라 사용자가 허락할 때만 한다.

---

## 4. 아직 안 되는 것 (기술 쪽 할 일)

- ~~`--images`가 eyes-closed를 받지 못함~~ → 네 번째 자리로 받는다 (2026-10-06, feature/maker). 반쯤 감은 눈은 파이프라인이 걸러 주지 못하니 사람이 확인한다.
- 로컬 모델을 파이프라인이 직접 부르는 경로(`--via local`)는 없다. 지금은 사람이(또는 Windows의 Claude Code가) 이미지를 만들어 넘기는 방식이다.
- 사용자 '우리 아이 만들기'(make.html)의 AI 표정은 아직 서버가 없어 로컬 품질 검증까지만 돼 있다. 로컬 모델로 바꿀지는 정해지지 않았다.

## 5. 지금 고퀄 아이 상태 (2026-10-06)

| 공고 | 종 | 상태 |
|---|---|---|
| 413583202600620 | 강아지 | ✅ 기준 (정면·웃기·헥헥) |
| 445476202600344 | 강아지 | ✅ 표정 완성, 기준점 손으로 맞춤 |
| 445467202601928 | 강아지 (말리노이즈) | ✅ 표정 완성, 웃을 때 코 남기기 수정됨 |
| 448548202600845 | 강아지 | ✅ 표정 완성 |
| 413578202601891 | 고양이 (페르시안) | ✅ 표정 완성 (츄르 핥기) |
| 411303202600530 | 강아지 | ⚠ 표정 없음 → 로컬 모델로 front 편집해 smile·pant·eyes-closed 필요 |
| 441554202601848 | 강아지 | ⚠ 로컬 이미지로 만듦(정면·웃음, 주둥이 따로 맞춤). 헥헥(혀)과 꼭 감은 눈 없음 → pant·eyes-closed 다시 필요. 원본 로컬 이미지는 main에서 지웠다 (700c07e) |

## 6. 지켜야 할 것
- main, shelter-data push 금지 (자동 배포). 작업은 feature 브랜치와 `images-incoming`
- `.env.local`, `pets-src/`, `generated-images/`는 커밋 금지 (공개 저장소)
- 유료 API 호출은 사용자 확인 후에만
- 사용자에게는 한국어로 답한다
- 역할: 기술(셰이더·파이프라인)은 `/Users/hyewon/pet`(feature/maker), 서비스는 `../pet-service`(feature/viral). 자세한 인수인계는 `docs/HANDOFF.md`
