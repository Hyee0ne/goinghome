import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

// 휴대폰·태블릿에서 카메라를 쓰려면 HTTPS가 필요하다: `npm run dev:mobile`
export default defineConfig({
  // 깃허브 페이지는 https://<계정>.github.io/sonkkeut-pet/ 아래에서 열린다 (배포 워크플로가 GITHUB_PAGES=1로 빌드)
  base: process.env.GITHUB_PAGES ? '/sonkkeut-pet/' : '/',
  plugins: [...(process.env.HTTPS ? [basicSsl()] : []), petEditorApi()],
  // 손 인식 워커는 MediaPipe의 ES 모듈판 wasm 로더를 동적 import하므로 모듈 워커로 빌드한다
  worker: { format: 'es' },
  // 배포에 넣을 화면: 앱, 보호소용 등록 화면(있으면). 기준점 편집 화면(rig.html)은 개발 서버 전용이라 넣지 않는다
  build: {
    rollupOptions: {
      input: {
        main: join(import.meta.dirname, 'index.html'),
        ...(existsSync(join(import.meta.dirname, 'register.html')) && { register: join(import.meta.dirname, 'register.html') }),
      },
    },
  },
})

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
              send(200, { ok: true })
            } catch (e) {
              send(400, { error: String(e) })
            }
          })
          return
        }
        if (what === 'rebuild' && req.method === 'POST') {
          const p = spawn('node', ['scripts/pet-add.ts', '--id', id, '--from', 'prepare'], { cwd: import.meta.dirname })
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
