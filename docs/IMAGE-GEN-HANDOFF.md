# 이미지 생성 인수인계: 정면은 GPT high, 표정은 로컬

고잉홈의 '고퀄' 보호소 아이(✨ 생생 쓰다듬기)에 쓰는 AI 이미지 흐름이다. (2026-10-06 사용자 결정)

- **정면(기본 사진)**: Mac에서 GPT `high`로 만든다. 털 질감 때문이다. medium은 곱슬 털이 뭉개져 인형처럼 보여서 쓰지 않는다(공고 411303202600530으로 비교함).
- **표정(배리에이션)**: Windows의 로컬 생성 모델로 만든다. 정면에서 입·눈만 인페인팅하니 나머지는 high 화질 그대로 남는다.
- 주기: **주 1회**, 강아지 10 + 고양이 10마리. **그날 약 4시간 안에** 정면 생성 → 표정 → 공개까지 끝낸다.
- 목표: **이번 주에 공고가 끝나는 아이를 살리는 것.** 공고 남은 기간 3~7일인 아이만, 급한 아이부터.

| 기기 | 하는 일 |
|---|---|
| **Mac** (`/Users/hyewon/pet`, 기술 / `../pet-service`, 서비스) | ① 이번 주 아이 고르기 → ② GPT high 정면 생성 → ③ `images-incoming`에 올리기 → ⑤ 표정 받아 파이프라인 → 공개 목록 → dev |
| **Windows** (로컬 생성 모델) | ④ 정면을 받아 웃기·헥헥·눈 감기 세 장 인페인팅 → `images-incoming`에 올리기 |

> 누끼(배경 지우기)와 기준점 찾기는 macOS의 Apple Vision을 쓴다. 파이프라인(`npm run shelter:make`)은 Mac에서만 돈다.

---

## 1. 주간 흐름 한눈에

```
[Mac]  ① 아이 고르기 (남은 기간 3~7일, 급한 순, 생성 방해 요소 없는 아이, 강아지 10 · 고양이 10)
       ② 정면 생성: GPT high (ChatGPT 구독 먼저 → 한도에 걸리면 API)
       ③ incoming/<id>/front.png + README.txt, incoming/BATCH-<날짜>.md → images-incoming push
[Win]  ④ git pull → 아이마다 smile.png · pant.png · eyes-closed.png · ears-back.png 인페인팅 → images-incoming push
[Mac]  ⑤ --hq --images 다섯 장 → 확인 → --publish (최대 20) → 서비스 dev 반영
```

### 아이 고르는 기준 (2026-10-06 사용자 결정)
- 후보(`candidates.json`, 서비스 `scripts/fetch-animals.ts`): **공고 남은 기간 3~7일인 아이만**, 남은 기간이 짧은 순. 강아지·고양이 모두 같고 기한을 늘리지 않는다.
- 정면을 생성으로 새로 그리니 **구도(머리·귀 잘림)는 상관없다.** 대신 **생성을 방해하는 요소가 없는 아이**를 고른다. 아래 중 하나라도 있으면 뒤로 보내거나 뺀다.
  - 사람 손·얼굴이 보임 / 철창·목줄이 얼굴을 가림 / 여러 마리 / 눈·코가 흐림 / 고개가 많이 돌아감 / 얼굴이 아주 작음
- 이미 고퀄인 아이는 뺀다. 공개는 한 번에 최대 20마리다.
- 공개 목록(`--publish auto`): 마감이 지난 아이만 빼고, 고퀄 중 급한 순 → 남는 자리는 무료 아이 → 고양이 최소 4마리.

### 비용
- 정면 한 장(GPT high, 1024×1536, 원본 참고): API로 약 300원 안팎이다. 주 20장이면 한 달 약 2만 4천 원이다.
- ChatGPT 구독으로 만들면 추가 비용이 0원이다. **구독을 먼저 쓰고, 한도에 걸린 날만 API**를 쓴다. API 사용은 사용자가 허락했다(2026-10-06). 그래도 쓴 양은 로그로 남긴다.
- 표정(로컬)은 0원이다.

---

## 2. Mac: ①~③ 정면 만들어 올리기

> **`npm run shelter:batch`**(기술 담당, feature/maker)로 ①~③을 한 번에 한다:
> `npm run shelter:batch [-- --dogs 10 --cats 10 --min-days 3 --max-days 7 --dry-run]` (기본값이 3~7일)
> (`--dry-run`이면 고른 목록과 예상 비용만 보여 준다. 첫 실행은 사용자 확인 후에 한다)
> 그 밖의 옵션: `--only id1,id2`(이 아이들만, 이미 고퀄이어도 다시 그림) · `--no-api`(구독만, API로 넘기지 않음) · `--no-upload`(만들기만, images-incoming에 안 올림) · `--no-push`(커밋만)
> 정면은 **투명 배경**으로 그린다 (2026-10-06 변경). 구독이 투명으로 안 주면(검은 배경·체크무늬) 그 장은 버리고 API로 다시 그린다. 비용은 `pets-src/shelter-batch-cost.jsonl`에 남는다.
> 구독(ChatGPT) 한도: 2026-10-06 현재 **10월 10일 18:44까지 막혀 있다.** 그때까지는 API로만 그릴 수 있다 (한 장 약 $0.2~0.3).

배치를 못 쓸 때는 아이마다 손으로 한다 (`/Users/hyewon/pet`에서):

```bash
npm run data:animals && npm run shelter:make          # 공고 갱신 + 무료 판정
# 아이마다 (verdicts.json의 photo 번호가 가장 정면인 원본 사진)
node scripts/pet-add.ts pets-src/shelter-<id>/src-<photo>.jpg --id shelter-<id>-hq --species dog|cat \
  --reference true --until cutout --quality high [--via chatgpt]
```

- 결과는 `pets-src/shelter-<id>-hq/cutout.png`(배경 투명, 1024×1536)이다. 이걸 `front.png`로 올린다.
- `--via chatgpt`면 구독, 없으면 `.env.local`의 API 키를 쓴다. 키 값은 어디에도 출력하지 않는다.
- 올리기 전에 원본과 같은 아이인지 본다: 털색, 무늬 위치, 귀 모양, 눈 색. **목줄·사람 손·철창이 남아 있으면 다시 만든다.**

### images-incoming에 올리는 구조
```
incoming/
  BATCH-2026-10-06.md            # 이번 주 목록: id, 종, 마감일, 공고번호(noticeNo), 상태 칸
  <id>/
    README.txt                   # 공고번호 · 종 · 품종 · 마감일 · 정면 생성 방법(구독/API)
    front.alpha.png              # Mac이 올림: GPT 투명 정면 그대로 (1024×1536 RGBA). Mac이 최종 누끼로 쓴다
    front.png                    # Mac이 올림: 위 그림을 털색과 대비되는 단색 배경에 얹은 RGB (Windows가 인페인팅할 그림)
    smile.png pant.png eyes-closed.png   # Windows가 올림
    ears-back.png                # Windows가 올림 (귀 젖힘)
```
- **main에는 절대 올리지 않는다.** main에 push하면 GitHub Pages가 자동 배포된다. `images-incoming`만 쓴다.
- 저장소는 **공개**다. 공고 사진에서 만든 이미지(공공데이터)만 올린다. 개인 반려동물 사진, `.env.local`, 키는 절대 올리지 않는다.
- PNG 메타데이터(위치 등)는 지우고 올린다.

---

## 3. Windows: ④ 표정 만들기 (네 장: 웃음 · 헥헥 · 눈 감음 · 귀 젖힘)

```bash
git checkout images-incoming && git pull
# incoming/BATCH-<날짜>.md를 보고, front.png만 있고 표정이 없는 아이부터
```

| 파일 | 내용 |
|---|---|
| `smile.png` | front.png 편집: 입 살짝 벌림, 혀끝만 보임. **눈은 뜬 채 그대로** |
| `pant.png` | front.png 편집: 강아지는 입 크게 벌리고 혀를 아랫니 위로 내민 헥헥 / 고양이는 츄르 핥듯 혀를 내밀어 살짝 말아 올림. **눈은 뜬 채 그대로** |
| `eyes-closed.png` | front.png 편집: 두 눈을 **끝까지** 감음. **입은 다문 채 그대로**. 속눈썹은 그리지 않고 감은 선만 (사용자가 다시 만들어 고른 방식) |
| `ears-back.png` | front.png 편집: 쓰다듬어 기분이 좋을 때의 귀. **강아지**는 귀를 뒤로 젖혀 머리에 붙인다(귀 뿌리 자리는 그대로, 귀가 뒤로 눕는다. 접힌 귀는 뒤·아래로 당겨져 머리 옆에 붙는다). **고양이**는 비행기 귀다. 귀가 양옆으로 눕고 귀 구멍이 옆을 향하며, 귀 끝이 정수리 높이쯤으로 내려온다(겁먹거나 화나서 납작하게 뒤로 붙인 귀는 아니다). **눈은 뜬 채, 입은 다문 채 그대로**. 마스크와 배경 규칙은 아래 '귀 젖힘 마스크와 배경'을 따른다 |

### 귀 젖힘 마스크와 배경 (다른 세 장과 다르다)
- **마스크**: 두 귀 전체, 귀가 새로 갈 자리, 귀가 원래 있던 자리 둘레의 배경까지 씌운다. 귀 뿌리 근처 정수리 털은 조금 들어가도 된다. 눈, 눈썹 아래, 코, 입, 볼, 수염에는 씌우지 않는다.
- **배경이 중요하다.** Mac은 이 사진의 배경색으로 젖힌 귀의 윤곽(알파)을 따로 딴다. 귀 모양이 바뀌어 front.alpha.png의 윤곽을 쓸 수 없기 때문이다. 그래서 다음을 지킨다.
  - 귀가 비운 자리는 front.png와 **같은 단색 배경**으로 깨끗이 채운다. 그림자, 빛 번짐, 털 부스러기, 다른 색은 남기지 않는다.
  - 마스크 밖 배경색은 바꾸지 않는다(배경 전체를 다시 칠하지 않는다).
  - 새 귀 끝이 사진의 위나 옆 가장자리에 닿지 않게 한다.
- 크기는 다른 장과 같이 1024×1536 그대로, PNG로 저장한다.
- Mac은 윤곽이 실제로 바뀐 곳(귀가 비운 자리와 새 자리)에서만 이 사진의 알파를 쓰고, 나머지는 정면 누끼 그대로 둔다. 마스크 밖이 front.png와 같으면 경계가 보이지 않는다.

파이프라인은 앱의 마지막 표정('눈 감고 헥헥')을 `pant.png`에 `eyes-closed.png`의 두 눈만 얹어 만든다. 그래서 **표정 한 장에 한 부위만** 바꾼다.

### 화질을 지키는 규칙 (가장 중요)
1. **front.png를 받은 해상도 그대로(1024×1536) 편집한다.** 줄여서 작업하고 키우지 않는다. 결과는 **PNG**로 저장한다(JPG 금지).
2. **반드시 인페인팅**으로 만든다. 바꿀 부위(입 또는 눈)에만 마스크를 씌우고, 마스크 밖은 front.png와 픽셀 단위로 같아야 한다. 새로 그리지 않는다.
3. **눈은 '완전히 감음' 아니면 '동그랗게 뜸'만** 쓴다. 반쯤 감은 눈(게슴츠레)은 쓰지 않는다. 사용자가 가장 싫어하는 표정이다. 파이프라인이 걸러 주지 못하니 올리기 전에 눈으로 확인한다.
4. 코는 움직이지 않는다. 코 모양과 위치는 그대로 둔다.
5. **밝기·색은 만지지 않는다.** Mac 파이프라인이 아이들끼리 밝기를 맞춘다. 꼭 만져야 하면 세 장 모두 똑같이 바꾼다.
6. 음식, 손, 사람은 넣지 않는다.
7. **배경은 신경 쓰지 않는다 (ears-back.png만 예외, 위 '귀 젖힘 마스크와 배경').** front.png 배경은 털색과 대비되는 단색이다(밝은 털은 진한 회청색, 어두운 털은 밝은 크림색). 배경색이 조금 바뀌어도 최종 결과에는 남지 않는다. Mac이 GPT 투명 경계(front.alpha.png)를 다시 씌운다.
8. **사람이 확인한다.** 초기에는 품질 때문에 사용자가 단계마다 직접 본다(자동 감시·자동 처리 금지, 2026-10-06 사용자 결정). 올린 뒤 사용자에게 알린다.

> **잘 된 예 (2026-10-06, 공고 441554202601848)**: FLUX.1 Kontext dev(Q5_K_M)로 입·눈 마스크만 인페인팅했고, 마스크 밖은 정면과 같았다. 파이프라인 정렬은 코 일치 1.00, 회전 0도였고 앱에서 자연스러웠다. 감은 눈꺼풀이 주변 털보다 조금 하얗고 볼록한 점만 아쉬웠다.
> **실패 예 (같은 아이, 처음)**: 웃는 얼굴을 새로 그려서 주둥이가 8도 돌고 코가 올라갔다. 앱에서 입이 돌아가고 코가 두 겹이 됐다. 눈 감기는 반쯤 감은 눈이라 쓰지 못했다.

### 프롬프트 참고 (ChatGPT에 쓰던 것, `scripts/pet-add.ts`의 `prompts()`)
- 공통 꼬리말: *Keep everything else exactly identical to the original photo: same head position, size, angle and framing, same fur, markings, ear shape and position, lighting and colors, same background. Photorealistic.*
- 강아지 smile: *mouth slightly open in a soft smile, lips just parted with the tip of the pink tongue visible. Eyes unchanged.*
- 강아지 pant: *happily panting, mouth open in a relaxed doggy smile with the pink tongue slightly out over the lower teeth. Eyes and ears unchanged.*
- 고양이 smile: *mouth slightly open with just the tip of the small pink tongue showing, as if about to lick a treat. No food in the image. Eyes unchanged.*
- 고양이 pant: *pink tongue stuck out and curled slightly upward, licking as if lapping a creamy treat. No food in the image. Eyes unchanged.*
- eyes-closed: *both eyes gently closed, relaxed and content, eyelids fully shut, same fur color on the eyelids. Mouth and ears unchanged.*
- 강아지 ears-back: *ears relaxed and folded back against the head, as a happy dog being petted. Ear bases stay in place. Eyes open and mouth closed, unchanged. Where the ears used to be, show only the same plain background color.*
- 고양이 ears-back: *relaxed "airplane ears": both ears rotated out to the sides and slightly down, ear openings facing sideways, as a content cat being petted (not flattened in fear or anger). Eyes open and mouth closed, unchanged. Where the ears used to be, show only the same plain background color.*

### 올리기
- 네 장을 `incoming/<id>/`에 넣고 `images-incoming`에 커밋·push한다. 커밋 메시지 예: `incoming: <id> 웃기·헥헥·눈 감기·귀 젖힘 (로컬 인페인팅)`
- `BATCH-<날짜>.md`의 그 아이 상태 칸을 '표정 완료'로 바꾼다.
- 공고 데이터가 따로 필요하면(선택) `.env.local`에 `DATA_GO_KR_SERVICE_KEY`를 사용자가 직접 넣고 `npm run data:animals`. 키 값은 채팅·깃·문서에 적지 않는다. 기본 흐름에서는 front.png와 README.txt만 있으면 된다.

---

## 4. Mac: ⑤ 표정 받아서 공개까지

```bash
cd /Users/hyewon/pet
git fetch origin images-incoming
D=$(mktemp -d) && git archive origin/images-incoming incoming/<id> | tar -x -C $D && D=$D/incoming/<id>
npm run shelter:make -- --hq <id> --images $D/front.png,$D/smile.png,$D/pant.png,$D/eyes-closed.png,$D/ears-back.png
```
- 무료다. 순서는 정면, 웃음(중간), 헥헥(최종), 눈 감음, 귀 젖힘이다. 자리로 구분하므로 귀 젖힘을 넣으려면 앞의 네 장이 모두 있어야 한다. 귀 젖힘이 없으면 네 장만 넣는다(귀는 젖히지 않고 쫑긋만 한다).
- 귀 젖힘: 실루엣(알파)은 ears-back.png의 대비 배경(테두리로 맞춘 배경색 지도)으로 따로 딴다. 로그에 `대비 배경(…)으로 알파를 땄어요 · 윤곽이 바뀐 곳 N%`가 나온다. N이 0에 가깝거나 20%를 크게 넘으면 배경이 칠해졌거나 귀가 안 바뀐 것이니 사진을 확인한다.
- 앱 동작(고퀄): 기분 좋게 0.6초쯤 쓰다듬으면 귀가 0.16초 만에 젖혀지고, 쓰다듬는 동안 그대로 있다가 손을 떼면 0.2초 만에 돌아온다. 젖힌 동안은 귀 쫑긋을 하지 않는다.
- `front.png` 옆에 `front.alpha.png`가 있으면 Apple Vision 누끼 대신 그 알파를 쓴다 (털 끝 경계가 훨씬 자연스럽다. 회색 배경 + 누끼는 귀 끝이 뭉개져 보였다).
- 입 표정 범위는 받은 웃음·헥헥 사진에서 실제로 바뀐 곳에 맞춰 아래로 늘어난다 (턱 아래로 내민 혀가 잘리지 않게. 기록: `pets-src/shelter-<id>-hq/expr-pant-region.json`).
- 무대 크기는 귀 끝·정수리 털이 화면 안에 들어오게 자동으로 맞춘다 (사진 맨 위가 앱 좌표 -300보다 아래).
- 밝기 맞춤이 자동으로 들어간다(동물 부분 밝기 중앙값을 0.68 쪽으로 약하게, 표정에도 같은 값). 끄려면 `--no-brighten`.
- 정면을 이미 ②에서 같은 자리(`pets-src/shelter-<id>-hq/cutout.png`)에 만들었으면 그걸 그대로 쓴다.

### 확인
1. `pets-src/shelter-stage/preview.html`: 원본과 닮았는지, '✅ 표정 완성'인지
2. 로그에서 '주둥이 맞춤: 코 일치'가 0.9 이상, 회전이 거의 0도인지
3. 앱에서 쓰다듬어 보기: 코가 한 겹인지, 입이 수평인지, **감은 눈이 받은 사진대로 나오는지**, 두 눈이 같이 감기는지
4. 기준점은 `rig.html?id=shelter-<id>-hq`에서 다듬고 **저장**하면 고개까지 움직인다(FULL). 다시 돌려도 손으로 맞춘 기준점은 덮어쓰지 않는다

### 공개 목록 확정과 dev 반영
```bash
npm run shelter:make -- --publish <공개할 id들, 쉼표로, 최대 20>   # 로컬 shelter-data를 새로 만든다 (push 금지)
cd ../pet-service
rm -rf public/shelter && mkdir -p public/shelter && git -C ../pet archive shelter-data | tar -x -C public/shelter
npm run data:animals      # ← 꼭 같이 돌린다. 안 돌리면 앱이 옛 목록(shelter-live.json)을 읽어 새 표정이 안 나온다
```
- `--publish`는 매번 목록 전체로 새로 만든다. 마감이 지난 아이는 빼고, 이번 주 아이를 더해 20마리 안으로 맞춘다.
- `git push origin shelter-data`는 실제 사이트 공개다. 사용자가 허락할 때만 한다.

---

## 5. 지금 상태 (2026-10-06 저녁)

### dev(5181)에 올라 있는 것: 첫 배치 7마리만
사용자 요청으로 dev 공개 목록은 오늘 배치 7마리뿐이다. 예시 아이(초코·삼식)는 얼굴 목록에서 뺐고, 아래 예전 고퀄 아이들도 지금 dev에는 없다(파일은 남아 있어 `--publish`에 넣으면 다시 나온다).

| 공고 | 종 | 상태 |
|---|---|---|
| 447502202600909 | 강아지 (포항 말티즈) | ✅ 네 장 완성 (마감 10/11) |
| 427343202600939 | 강아지 (휘펫) | ✅ 네 장 완성. 정면 털색이 원본(회청색)과 조금 다름, 감은 눈꺼풀이 약간 하얗다 |
| 448547202600878 | 강아지 (거창 믹스) | ✅ 네 장 완성 |
| 426334202600883 | 고양이 (부산 사하) | ✅ 네 장 완성 |
| 448535202601211 | 고양이 (김해 고등어) | ✅ 네 장 완성 |
| 448567202601414 | 고양이 (창원 레그돌) | ✅ 네 장 완성 |
| 444452202602092 | 고양이 (아산 페르시안) | ✅ 네 장 완성 |

- 이 7마리는 투명 배경 방식 이전(회색 배경 + 누끼)이다. 공고가 곧 끝나서 다시 만들지 않고, **다음 배치부터 투명 방식**을 쓴다.
- 첫 배치의 **나머지 13마리 정면은 아직 안 만들었다.** 구독이 10/10까지 막혀 API로만 가능하다(약 3,600원). 사용자 답을 기다리는 중.
- 공개 목록 자동 규칙: `npm run shelter:make -- --publish auto [--dry-run]` (마감 지난 아이 제외 → 고퀄 급한 순 → 무료 아이 → 고양이 최소 4).

### 진행 중
- **귀 젖힘(ears-back.png)**: 사용자가 '귀 쫑긋(작게 터는 동작)'을 본 뒤 이미지 방식으로 하기로 했다. **이미지는 Windows가 만든다.** Mac 쪽(`--images` 다섯 번째 자리, 젖힌 귀 알파, 앱 동작)은 feature/maker `302a83c`에 들어갔다. 귀 쫑긋은 `ef55973`이다. 첫 배치 7마리의 ears-back.png를 Windows에서 받으면 위 명령으로 다시 돌린다. 맥에서는 거친 합성 이미지로 흐름만 확인했다(실제 공개용 아님).

### 예전 고퀄 아이 (dev에서는 빠짐)

| 공고 | 종 | 상태 |
|---|---|---|
| 413583202600620 | 강아지 | ✅ 품질 기준 (정면·웃기·헥헥·간식) |
| 445476202600344 | 강아지 | ✅ 표정 완성, 기준점 손으로 맞춤 |
| 445467202601928 | 강아지 (말리노이즈) | ✅ 표정 완성 |
| 448548202600845 | 강아지 | ✅ 표정 완성 |
| 413578202601891 | 고양이 (페르시안) | ✅ 표정 완성 (츄르 핥기) |
| 441554202601848 | 강아지 (크림) | ✅ 로컬 인페인팅 네 장으로 완성. 마감 10/8 |
| 411303202600530 | 강아지 | ⚠ GPT high 정면만 있음 → Windows 표정 세 장 필요. 정면에 빨간 목줄이 있어 다시 만들지 정해야 함 |

- `npm run shelter:batch`: 첫 배치는 dry-run 결과를 사용자에게 보여 주고 확인받은 뒤 실행한다.
- 사용자 '우리 아이 만들기'(make.html)의 AI 표정은 별개다. 바로바로 만들어야 해서 로컬 모델을 쓰려면 GPU 서버가 필요하다. 아직 정하지 않았다.

## 6. 지켜야 할 것
- main, shelter-data push 금지 (자동 배포·사이트 공개). 작업은 feature 브랜치와 `images-incoming`
- `.env.local`, `pets-src/`, `generated-images/`는 커밋 금지 (공개 저장소)
- 정면 생성은 구독 먼저, API는 한도에 걸린 날만. 그 밖의 유료 호출은 사용자 확인 후에만
- 사용자에게는 한국어로 답한다
- 공공데이터(국가동물보호정보시스템) 공고 아이만 언급한다. 포인핸드 등 다른 입양 사이트 이름·링크는 넣지 않는다 (2026-10-06)
- 초기에는 단계마다 사용자가 품질을 확인한다. 자동 감시·자동 처리는 사용자가 다시 원할 때만
- 역할: 기술(셰이더·파이프라인)은 `/Users/hyewon/pet`(feature/maker), 서비스는 `../pet-service`(feature/viral). 자세한 인수인계는 `docs/HANDOFF.md`
