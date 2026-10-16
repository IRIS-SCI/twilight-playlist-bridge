/**
 * Optional loopback audio proxy.
 *
 * The player authorizes local playback by checking that a file sits under one of
 * the user's library roots. A playlist can point anywhere, so when that check
 * would fail the plugin can instead stream the file itself over a loopback HTTP
 * server — a route the plugin spec explicitly supports for providers
 * ("若 getPlaybackUrl 成功返回 HTTP(S) 回环地址…当前宿主保持运行").
 *
 * Safety properties:
 *  - binds 127.0.0.1 only (never a routable interface), on an ephemeral port;
 *  - the URL never carries a filesystem path, only an unguessable token, so
 *    there is no traversal surface;
 *  - only paths registered by the library can be served;
 *  - read-only, Range-capable, and shut down on deactivate.
 */

import fs from 'node:fs'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

const CONTENT_TYPES = {
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  wave: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  ape: 'audio/x-ape',
  wv: 'audio/x-wavpack',
  mpc: 'audio/x-musepack',
  tak: 'audio/x-tak',
  tta: 'audio/x-tta',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  dsf: 'audio/x-dsf',
  dff: 'audio/x-dff',
  wma: 'audio/x-ms-wma',
  alac: 'audio/mp4',
  caf: 'audio/x-caf'
}

export function contentTypeFor(filePath) {
  const extension = path.extname(filePath).replace('.', '').toLowerCase()
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}

/** `bytes=start-end` only; anything malformed means "serve the whole file". */
export function parseRangeHeader(header, size) {
  if (typeof header !== 'string' || !header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null

  let start
  let end
  if (rawStart === '') {
    // Suffix range: the last N bytes.
    const length = Number(rawEnd)
    if (!Number.isFinite(length) || length <= 0) return null
    start = Math.max(0, size - length)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start > end || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

/**
 * @param {{ logger?: object }} [deps]
 */
export function createAudioProxy(deps = {}) {
  const logger = deps.logger ?? { info() {}, warn() {}, error() {} }
  /** token -> absolute path */
  const tokens = new Map()
  /** lowercase path -> token, so repeated playback reuses one URL */
  const byPath = new Map()
  let server = null
  let baseUrl = null
  let starting = null

  function register(filePath) {
    const token = randomBytes(18).toString('hex')
    tokens.set(token, filePath)
    byPath.set(filePath.toLowerCase(), token)
    return token
  }

  function handleRequest(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const token = url.pathname.startsWith('/audio/') ? url.pathname.slice(7) : ''
    const filePath = tokens.get(token)

    if (!filePath) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('not found')
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' })
      response.end()
      return
    }

    fs.stat(filePath, (error, info) => {
      if (error || !info.isFile()) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('not found')
        return
      }

      const headers = {
        'Content-Type': contentTypeFor(filePath),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Length': String(info.size)
      }

      const range = parseRangeHeader(request.headers.range, info.size)
      if (range) {
        headers['Content-Length'] = String(range.end - range.start + 1)
        headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`
        response.writeHead(206, headers)
        if (request.method === 'HEAD') {
          response.end()
          return
        }
        fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(response)
        return
      }

      response.writeHead(200, headers)
      if (request.method === 'HEAD') {
        response.end()
        return
      }
      fs.createReadStream(filePath).pipe(response)
    })
  }

  async function start() {
    if (baseUrl) return baseUrl
    if (starting) return starting
    starting = new Promise((resolve, reject) => {
      const created = http.createServer(handleRequest)
      created.on('error', (error) => {
        logger.warn(`本地音频代理启动失败：${error?.message ?? error}`)
        starting = null
        reject(error)
      })
      created.listen(0, '127.0.0.1', () => {
        const address = created.address()
        server = created
        baseUrl = `http://127.0.0.1:${address.port}`
        logger.info(`本地音频代理已启动：${baseUrl}`)
        resolve(baseUrl)
      })
    })
    return starting
  }

  async function stop() {
    tokens.clear()
    byPath.clear()
    baseUrl = null
    starting = null
    const current = server
    server = null
    if (!current) return
    await new Promise((resolve) => current.close(() => resolve()))
  }

  /**
   * @param {string} filePath
   * @returns {Promise<string>} a loopback URL for the file
   */
  async function urlFor(filePath) {
    const origin = await start()
    const existing = byPath.get(filePath.toLowerCase())
    if (existing && tokens.has(existing)) return `${origin}/audio/${existing}`
    return `${origin}/audio/${register(filePath)}`
  }

  return {
    start,
    stop,
    urlFor,
    origin: () => baseUrl,
    isRunning: () => baseUrl !== null
  }
}
