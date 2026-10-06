#!/usr/bin/env bash
# Vercel 빌드 (https://goinghome.ricecookey.com, 2026-10-06 GitHub Pages에서 옮김). vercel.json의 buildCommand가 부른다.
#   1) 공고 아이 실사: 공개 저장소의 shelter-data 브랜치 → public/shelter/ (없으면 건너뛴다)
#   2) 공고 중인 유기동물 → public/data/ (Vercel 환경 변수 DATA_GO_KR_SERVICE_KEY. 실패하면 지금 배포된 목록을 그대로 쓴다)
#   3) vite build → dist/ (루트 / 경로. GITHUB_PAGES를 켜지 않는다)
# 매시간 공고 갱신은 GitHub Actions(.github/workflows/refresh.yml)가 Vercel Deploy Hook을 불러 이 빌드를 다시 돌린다.
set -euo pipefail

REPO="${SHELTER_REPO:-Hyee0ne/goinghome}"
mkdir -p public/shelter
# 빌드 환경에는 다른 브랜치가 없어서 깃허브 공개 압축 파일로 받는다
if curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/heads/shelter-data" -o /tmp/shelter-data.tgz; then
  tar -xzf /tmp/shelter-data.tgz --strip-components=1 -C public/shelter
  echo "공고 아이 실사: $(ls public/shelter | grep -vc manifest.json)마리"
else
  echo 'shelter-data 브랜치가 없어 건너뜁니다'
fi

ANIMALS_FALLBACK_URL="${ANIMALS_FALLBACK_URL:-https://goinghome.ricecookey.com/data/animals.json}" npm run data:animals
npm run build
