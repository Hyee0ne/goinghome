import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { OG_IMAGE_VERSION, SITE_URL } from './src/site'

const DEV_ONLY_PAGES = ['rig.html', 'maker-spike.html']

// 휴대폰·태블릿에서 카메라를 쓰려면 HTTPS가 필요하다: `npm run dev:mobile`
export default defineConfig({
  // 깃허브 페이지는 https://<계정>.github.io/goinghome/ 아래에서 열린다 (배포 워크플로가 GITHUB_PAGES=1로 빌드)
  base: process.env.GITHUB_PAGES ? '/goinghome/' : '/',
  plugins: [...(process.env.HTTPS ? [basicSsl()] : []), petEditorApi(), siteMeta()],
  // 손 인식 워커는 MediaPipe의 ES 모듈판 wasm 로더를 동적 import하므로 모듈 워커로 빌드한다
  worker: { format: 'es' },
  // 배포에 넣을 화면: 루트의 *.html 전부 (앱, 우리 아이 만들기, 보호소 등록 …).
  // 개발 서버 전용 화면(기준점 편집 rig.html, 측정용 maker-spike.html)은 넣지 않는다
  build: {
    rollupOptions: {
      input: Object.fromEntries(
        readdirSync(import.meta.dirname)
          .filter((f) => f.endsWith('.html') && !DEV_ONLY_PAGES.includes(f))
          .map((f) => [f === 'index.html' ? 'main' : f.replace(/\.html$/, ''), join(import.meta.dirname, f)]),
      ),
    },
  },
})

/** HTML의 %SITE_URL%·%OG_IMAGE_VERSION%을 src/site.ts 값으로 바꾼다 (OG 태그는 절대 주소여야 한다) */
function siteMeta(): Plugin {
  return {
    name: 'site-meta',
    transformIndexHtml: (html) => html.replaceAll('%SITE_URL%', SITE_URL).replaceAll('%OG_IMAGE_VERSION%', String(OG_IMAGE_VERSION)),
  }
}

/**
 * 기준점 편집 화면(/rig.html)용 개발 서버 API. 배포 빌드에는 들어가지 않는다.
 *   GET  /__pets                     사진 파이프라인으로 만든 아이 목록
 *   GET  /__pets/<id>/landmarks      기준점
 *   POST /__pets/<id>/landmarks      기준점 저장
 *   POST /__pets/<id>/rebuild        저장한 기준점으로 앱용 에셋을 다시 만든다 (표정 사진은 다시 만들지 않는다)
 */
function petEditorApi(): Plugin {
  const root = join(import.meta.dirname, 'pets-src')
  return {
    name: 'pet-editor-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__pets', (req, res) => {
        const [, id, what] = (req.url ?? '').split('?')[0].split('/')
        const send = (code: number, body: unknown) => {
          res.statusCode = code
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(body))
        }
        if (!id) {
          const ids = existsSync(root) ? readdirSync(root).filter((d) => existsSync(join(root, d, 'landmarks.json'))) : []
          return send(200, ids)
        }
        if (!/^[a-z0-9-]+$/.test(id)) return send(400, { error: 'bad id' })
        const file = join(root, id, 'landmarks.json')
        if (what === 'landmarks' && req.method === 'GET') {
          if (!existsSync(file)) return send(404, { error: 'no landmarks' })
          return send(200, JSON.parse(readFileSync(file, 'utf8')))
        }
        if (what === 'landmarks' && req.method === 'POST') {
          let body = ''
          req.on('data', (c) => (body += c))
          req.on('end', () => {
            try {
              writeFileSync(file, JSON.stringify(JSON.parse(body), null, 2) + '\n')
              // 보호소 아이는 손으로 맞췄다는 표시를 남긴다 (shelter:make가 기준점을 덮어쓰지 않고, 앱은 FULL 움직임으로)
              if (id.startsWith('shelter-')) writeFileSync(join(root, id, 'hand-tuned'), new Date().toISOString())
              send(200, { ok: true })
            } catch (e) {
              send(400, { error: String(e) })
            }
          })
          return
        }
        if (what === 'rebuild' && req.method === 'POST') {
          // 보호소 아이는 앱에 등록하지 않고(src/rigs에 쓰지 않음) 사진·부위만 다시 만든다. AI 표정 사진이 이미 있을 때만 표정 부위도 (유료 호출 없음)
          const shelter = id.startsWith('shelter-')
          const hasExpr = existsSync(join(root, id, 'expr-final-square.png'))
          const until = shelter ? ['--until', hasExpr ? 'assets' : 'prepare'] : []
          // 보호소 고퀄(-hq)은 눈 감기만 있는 아이라 --parts eyes (빼면 다른 표정 칸을 채우려고 유료 호출을 할 수 있다)
          // (입 표정까지 만든 아이는 eyes+pant(개)·eyes+lick(고양이))
          const mouth = existsSync(join(root, id, 'expr-pant.png'))
          const sp = mouth ? JSON.parse(readFileSync(join(root, id, 'landmarks.json'), 'utf8')).species : ''
          const eyes = id.endsWith('-hq') ? ['--parts', mouth ? (sp === 'cat' ? 'eyes+lick' : 'eyes+pant') : 'eyes'] : []
          const p = spawn('node', ['scripts/pet-add.ts', '--id', id, '--from', 'prepare', ...until, ...eyes], { cwd: import.meta.dirname })
          let log = ''
          p.stdout.on('data', (c) => (log += c))
          p.stderr.on('data', (c) => (log += c))
          p.on('close', (code) => send(code === 0 ? 200 : 500, { ok: code === 0, log }))
          return
        }
        send(404, { error: 'not found' })
      })
    },
  }
}
