import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const entries = ['main/index.js', 'preload/index.mjs', 'renderer/index.html']
const mime = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.wasm':'application/wasm', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.ogg':'audio/ogg', '.mp4':'video/mp4' }

export function digestFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function desktopRelease(appRoot, id) {
  if (typeof id !== 'string' || !/^\d{8}T\d{9}Z-[a-f0-9]{8}$/.test(id)) throw Error('Invalid desktop build ID')
  return join(appRoot, 'out', 'cohost-builds', id)
}

/** Startup checks the small entry files, not every large model or asset. */
export function readDesktopBuild(appRoot, id) {
  const folder = desktopRelease(appRoot, id)
  const manifest = JSON.parse(readFileSync(join(folder, 'build.json'), 'utf8'))
  if (manifest.id !== id || manifest.format !== 1) throw Error('Invalid desktop build manifest')
  for (const entry of entries) {
    if (!existsSync(join(folder, entry)) || digestFile(join(folder, entry)) !== manifest.entries?.[entry])
      throw Error('Desktop build is incomplete or changed: ' + entry)
  }
  return { folder, manifest }
}

/** Publish only complete builds. An interrupted build never changes the active pointer. */
export function activateDesktopBuild(pointer, appRoot, id) {
  readDesktopBuild(appRoot, id)
  const selected = existsSync(pointer) ? JSON.parse(readFileSync(pointer, 'utf8')).active : null
  const previous = selected && existsSync(join(desktopRelease(appRoot, selected), 'build.json')) ? selected : null
  const temporary = pointer + '.' + process.pid + '.tmp'
  writeFileSync(temporary, JSON.stringify({ active:id, previous:previous === id ? null : previous }, null, 2) + '\n')
  renameSync(temporary, pointer)
}

export function desktopEntryHashes(folder) {
  return Object.fromEntries(entries.map(entry => [entry, digestFile(join(folder, entry))]))
}

/** Serve only built renderer files on loopback. No source, environment file, or directory listing is exposed. */
export async function serveDesktopRenderer(folder, { port=5174, health=()=>({}) }={}) {
  const root = await realpath(folder)
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    try {
      const allowedHosts = new Set([`localhost:${server.address().port}`, `127.0.0.1:${server.address().port}`])
      if (!allowedHosts.has(req.headers.host)) { res.writeHead(403).end(); return }
      if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405, { Allow:'GET, HEAD' }).end(); return }
      if (req.url === '/__cohost_desktop') {
        res.setHeader('Content-Type','application/json')
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ app:'ds-zhubo-desktop', ...health() }))
        return
      }
      // Decode before validation. Reject Windows device paths, alternate streams and encoded traversal.
      const pathname = decodeURIComponent(req.url.split('?')[0])
      if (!pathname.startsWith('/') || /[\\:\x00]/.test(pathname) || pathname.split('/').some(part => part.startsWith('.'))) {
        res.writeHead(403).end(); return
      }
      const file = await realpath(resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname)))
      const child = relative(root, file)
      if (child.startsWith('..' + sep) || isAbsolute(child)) { res.writeHead(403).end(); return }
      const info = await stat(file)
      if (!info.isFile()) { res.writeHead(404).end(); return }
      res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream')
      res.setHeader('Content-Length', info.size)
      if (req.method === 'HEAD') res.end()
      else {
        const stream = createReadStream(file)
        stream.on('error', () => res.destroy())
        res.on('close', () => stream.destroy())
        stream.pipe(res)
      }
    }
    catch (error) {
      res.writeHead(error instanceof URIError ? 400 : 404).end()
    }
  })
  await new Promise((accept,reject) => { server.once('error',reject);server.listen(port,'127.0.0.1',accept) })
  return server
}
