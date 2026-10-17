/**
 * The playlist catalog behind the settings panel: scan, parse, and resolve each
 * entry to a concrete file path. Only the paths are needed — the resolved
 * `Track` objects never leave the plugin, they are what the import pass reads
 * `filePath` from.
 *
 * Design constraints that shape this file:
 *  - UI commands are killed after 5 s and the plugin host is stopped with them,
 *    so no command may scan. Scans run in the background and publish a snapshot.
 *  - The file-existence check is the only per-entry filesystem work, so it is
 *    deferred to `getPlaylistTracks` and cached per playlist revision.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { decodePlaylistBuffer } from './decode.mjs'
import { parseM3u } from './m3u.mjs'
import { parsePls } from './pls.mjs'
import { parseFpl } from './fpl.mjs'
import { parseFplite, nameFromFpliteIndex, readFpliteIndex } from './fplite.mjs'
import { XML_PLAYLIST_PARSERS } from './xmlplaylist.mjs'
import { extensionOf, readFileWithinLimit, scanPlaylistFiles, SCAN_LIMITS } from './scan.mjs'
import {
  describeTrackFileName,
  percentDecodedVariant,
  playlistNameFromFile,
  relocationCandidates,
  resolveEntryPath
} from './paths.mjs'

export const PROVIDER_ID = 'plfile'
export const PLAYLIST_ID_PREFIX = `${PROVIDER_ID}:`

const MAX_TRACKS_PER_PLAYLIST = 20_000
const CACHED_PLAYLIST_DETAILS = 40
/**
 * Materialized track lists are far heavier than parsed entries (each track
 * carries its own strings), so only a handful are kept. Without this cap the
 * cache grew by one full playlist per playlist ever opened.
 */
const CACHED_PLAYLIST_TRACKS = 8
const STAT_CONCURRENCY = 32

/** An `.m3u8` carrying `#EXT-X-` directives is an HLS manifest, not a playlist. */
const HLS_MANIFEST = /^#EXT-X-/m

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

export function playlistIdForFile(filePath) {
  return PLAYLIST_ID_PREFIX + Buffer.from(filePath, 'utf8').toString('base64url')
}

export function fileForPlaylistId(playlistId) {
  const value = String(playlistId ?? '')
  if (!value.startsWith(PLAYLIST_ID_PREFIX)) return null
  try {
    const decoded = Buffer.from(value.slice(PLAYLIST_ID_PREFIX.length), 'base64url').toString(
      'utf8'
    )
    return decoded || null
  } catch {
    return null
  }
}

function trackIdForPath(absolutePath) {
  const digest = createHash('sha1').update(absolutePath.toLowerCase()).digest('hex')
  return `${PROVIDER_ID}:${digest.slice(0, 32)}`
}

/** Parse an already-decoded playlist document, dispatching on its extension. */
export function parsePlaylistText(text, filePath, options = {}) {
  const extension = extensionOf(filePath)

  if (extension === 'pls') return parsePls(text, options)

  if (extension === 'm3u' || extension === 'm3u8') {
    if (HLS_MANIFEST.test(text)) {
      return {
        entries: [],
        warnings: ['这是 HLS 流媒体清单（含 #EXT-X- 指令），不是音乐歌单，已跳过']
      }
    }
    return parseM3u(text, options)
  }

  const xmlParser = XML_PLAYLIST_PARSERS[extension]
  if (xmlParser) return xmlParser(text, options)

  return { entries: [], warnings: [`不支持的内联格式：${extension || '未知'}`] }
}

async function readPlaylistEntries(filePath, config) {
  const extension = extensionOf(filePath)
  const bytes = await readFileWithinLimit(filePath, SCAN_LIMITS.maxFileBytes)

  // Binary formats never go through the text decoder.
  if (extension === 'fpl') return parseFpl(bytes, { splitArtistTitle: config.splitArtistTitle })
  if (extension === 'fplite') return parseFplite(bytes)

  const decoded = decodePlaylistBuffer(bytes, config.encoding)
  const parsed = parsePlaylistText(decoded.text, filePath, {
    splitArtistTitle: config.splitArtistTitle
  })
  parsed.encoding = decoded.encoding
  parsed.warnings = [...decoded.warnings, ...parsed.warnings]
  return parsed
}

async function fileExists(target) {
  try {
    const info = await fs.stat(target)
    return info.isFile()
  } catch {
    return false
  }
}

/**
 * Resolve every entry to a concrete path and report which ones exist.
 *
 * Each entry gets an ordered candidate list — the literal path, a
 * percent-decoded reading of the same `file://` URI, and (when the user
 * configured roots) re-attached tails for a moved library. Candidates are
 * de-duplicated across the whole playlist so each is stat'ed once, and the
 * first existing candidate wins.
 */
async function materializeEntries(entries, playlistFile, config) {
  const playlistDir = path.dirname(playlistFile)
  const prepared = entries.slice(0, MAX_TRACKS_PER_PLAYLIST).map((entry) => {
    if (entry.remote) {
      return { entry, candidates: [], absolutePath: '', exists: true, remote: true }
    }
    const absolutePath = resolveEntryPath(entry.path, playlistDir)
    const candidates = []
    if (absolutePath) {
      candidates.push(absolutePath)
      const decoded = percentDecodedVariant(absolutePath)
      if (decoded) candidates.push(decoded)
    }
    return { entry, candidates, absolutePath: absolutePath ?? '', exists: false, remote: false }
  })

  const unique = [...new Set(prepared.flatMap((row) => row.candidates))]
  const resolved = new Map()

  await mapLimit(unique, STAT_CONCURRENCY, async (candidate) => {
    if (await fileExists(candidate)) {
      resolved.set(candidate, candidate)
      return
    }
    for (const relocated of relocationCandidates(candidate, config.searchRoots)) {
      if (await fileExists(relocated)) {
        resolved.set(candidate, relocated)
        return
      }
    }
    resolved.set(candidate, null)
  })

  for (const row of prepared) {
    if (row.remote) continue
    for (const candidate of row.candidates) {
      const match = resolved.get(candidate)
      if (match) {
        row.exists = true
        row.absolutePath = match
        break
      }
    }
  }

  return prepared
}

function fileNameFromRemote(target) {
  try {
    const pathname = new URL(target).pathname
    return decodeURIComponent(pathname.split('/').pop() ?? '') || path.basename(target)
  } catch {
    return path.basename(target)
  }
}

function entryToTrack(row, usedIds, config) {
  const remote = row.remote
  const target = remote ? row.entry.path.trim() : row.absolutePath
  const fileName = remote ? fileNameFromRemote(target) : path.basename(target)

  // Metadata the playlist states explicitly always wins; the file name is only
  // consulted when the format carries none (which is the norm for bare-path
  // `.m3u`, `.fplite` and `.wpl` playlists).
  const explicitTitle = String(row.entry.title ?? '').trim()
  const explicitArtist = String(row.entry.artist ?? '').trim()
  const naming = explicitTitle
    ? { title: explicitTitle, artist: explicitArtist }
    : describeTrackFileName(fileName, { splitArtistTitle: config.splitArtistTitle })

  let id = remote
    ? `${PROVIDER_ID}:url:${createHash('sha1').update(target).digest('hex').slice(0, 32)}`
    : trackIdForPath(target)

  // Playlists may legitimately hold the same song twice; keep the first id
  // stable and disambiguate later occurrences.
  const seen = usedIds.get(id) ?? 0
  usedIds.set(id, seen + 1)
  if (seen > 0) id = `${id}#${seen + 1}`

  return {
    id,
    title: naming.title || fileName || target,
    artist: naming.artist || '',
    album: row.entry.album || '',
    filePath: remote ? '' : target,
    fileName,
    duration: row.entry.durationSeconds ?? 0,
    size: 0,
    cover: null,
    lyrics: null,
    source: PROVIDER_ID,
    streamUrl: remote ? target : null
  }
}

function buildTracks(rows, config) {
  const usedIds = new Map()
  const tracks = []
  let missing = 0
  let remote = 0
  let unusable = 0

  rows.forEach((row) => {
    if (row.remote) remote += 1
    if (!row.remote && !row.exists) {
      missing += 1
      // An entry with no resolvable path at all can never play, so it is always
      // dropped regardless of the skipMissing preference.
      if (!row.absolutePath) {
        unusable += 1
        return
      }
      if (config.skipMissing) return
    }
    tracks.push(entryToTrack(row, usedIds, config))
  })

  return { tracks, missing, remote, unusable }
}

/**
 * @param {{ logger?: object }} [deps]
 */
export function createPlaylistLibrary(deps = {}) {
  const logger = deps.logger ?? { info() {}, warn() {}, error() {} }

  /** @type {{ files: string[], warnings: string[], truncated: boolean } | null} */
  let snapshot = null
  let snapshotConfig = null
  let refreshPromise = null
  let refreshing = false
  let lastRefreshAt = null
  let lastError = null

  /** playlistId -> { entries, warnings, encoding, config } */
  const detailCache = new Map()
  /** playlistId -> materialized track list */
  const trackCache = new Map()
  /** directory -> Map<guid, name> from foobar2000's index.txt */
  const fpliteIndexCache = new Map()

  function rememberDetail(playlistId, value) {
    detailCache.delete(playlistId)
    detailCache.set(playlistId, value)
    while (detailCache.size > CACHED_PLAYLIST_DETAILS) {
      const oldest = detailCache.keys().next().value
      detailCache.delete(oldest)
    }
  }

  function rememberTracks(playlistId, value) {
    trackCache.delete(playlistId)
    trackCache.set(playlistId, value)
    while (trackCache.size > CACHED_PLAYLIST_TRACKS) {
      const oldest = trackCache.keys().next().value
      trackCache.delete(oldest)
    }
  }

  function invalidate(playlistId) {
    detailCache.delete(playlistId)
    trackCache.delete(playlistId)
  }

  function invalidateAll() {
    detailCache.clear()
    trackCache.clear()
    fpliteIndexCache.clear()
  }

  /**
   * Rebuild the catalog. Never throws: a failed refresh keeps the previous
   * snapshot so an open library view does not empty itself.
   */
  async function refresh(config, options = {}) {
    if (refreshPromise) return refreshPromise
    refreshing = true
    refreshPromise = (async () => {
      try {
        const result = await scanPlaylistFiles(config.playlistDirs, {
          extensions: config.extensions,
          recursive: config.recursive,
          signal: options.signal
        })
        snapshot = {
          files: result.files.slice(0, config.maxPlaylists),
          warnings: result.warnings,
          truncated: result.truncated || result.files.length > config.maxPlaylists
        }
        snapshotConfig = config
        lastRefreshAt = new Date().toISOString()
        lastError = null
        invalidateAll()
        logger.info(`扫描到 ${snapshot.files.length} 个歌单文件`)
      } catch (error) {
        lastError = error?.message ?? String(error)
        logger.error(`扫描歌单失败：${lastError}`)
      } finally {
        refreshing = false
        refreshPromise = null
      }
      return snapshot
    })()
    return refreshPromise
  }

  async function ensureSnapshot(config, options = {}) {
    if (snapshot && snapshotConfig === config) return snapshot
    return await refresh(config, options)
  }

  async function loadEntries(playlistId, config) {
    const cached = detailCache.get(playlistId)
    if (cached && cached.config === config) return cached
    const filePath = fileForPlaylistId(playlistId)
    if (!filePath) throw new Error('歌单 ID 无效')
    const parsed = await readPlaylistEntries(filePath, config)
    const value = {
      filePath,
      entries: parsed.entries ?? [],
      warnings: parsed.warnings ?? [],
      encoding: parsed.encoding ?? null,
      config
    }
    rememberDetail(playlistId, value)
    return value
  }

  /** foobar2000 2.x stores playlist names in a per-directory index.txt. */
  async function fpliteIndexFor(directory) {
    const cached = fpliteIndexCache.get(directory)
    if (cached) return cached
    const names = await readFpliteIndex(directory)
    fpliteIndexCache.set(directory, names)
    return names
  }

  function displayName(filePath, duplicates, indexNames) {
    const fromIndex = nameFromFpliteIndex(filePath, indexNames?.get(path.dirname(filePath)))
    const base = fromIndex ?? playlistNameFromFile(filePath)
    if (!duplicates.has(base)) return base
    const parent = path.basename(path.dirname(filePath))
    return parent ? `${parent}/${base}` : base
  }

  async function buildSummaries(files, config) {
    const indexNames = new Map()
    const fpliteDirs = [
      ...new Set(files.filter((file) => extensionOf(file) === 'fplite').map((f) => path.dirname(f)))
    ]
    await mapLimit(fpliteDirs, 4, async (directory) => {
      indexNames.set(directory, await fpliteIndexFor(directory))
    })

    const nameCounts = new Map()
    for (const file of files) {
      const name = displayName(file, new Set(), indexNames)
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
    }
    const duplicates = new Set(
      [...nameCounts.entries()].filter(([, count]) => count > 1).map(([name]) => name)
    )

    return files.map((file) => {
      const playlistId = playlistIdForFile(file)
      const cached = detailCache.get(playlistId)
      return {
        id: playlistId,
        name: displayName(file, duplicates, indexNames),
        trackCount: cached && cached.config === config ? cached.entries.length : undefined,
        creatorName: PROVIDER_ID
      }
    })
  }

  async function listPlaylists(config, options = {}) {
    const current = await ensureSnapshot(config, options)
    const files = current?.files ?? []
    // Fill in counts opportunistically so the library list shows real numbers
    // without blocking on a full parse of every file.
    await mapLimit(files, 8, async (file) => {
      const playlistId = playlistIdForFile(file)
      if (detailCache.get(playlistId)?.config === config) return
      try {
        await loadEntries(playlistId, config)
      } catch (error) {
        logger.warn(`读取歌单失败 ${file}：${error?.message ?? error}`)
        rememberDetail(playlistId, {
          filePath: file,
          entries: [],
          warnings: [error?.message ?? String(error)],
          encoding: null,
          config
        })
      }
    })
    return { playlists: await buildSummaries(files, config), snapshot: current }
  }

  /**
   * @param {{ keep?: boolean }} [options] `keep: false` builds the list without
   *   retaining it, which is what the bulk "import to local playlists" pass
   *   uses so importing fifty playlists does not hold fifty track arrays.
   */
  async function getPlaylistTracks(playlistId, config, options = {}) {
    const cached = trackCache.get(playlistId)
    if (cached && cached.config === config) return cached
    const detail = await loadEntries(playlistId, config)
    const rows = await materializeEntries(detail.entries, detail.filePath, config)
    const built = buildTracks(rows, config)
    const value = {
      config,
      filePath: detail.filePath,
      tracks: built.tracks,
      missing: built.missing,
      remote: built.remote,
      unusable: built.unusable,
      warnings: detail.warnings,
      encoding: detail.encoding,
      fileCount: detail.entries.length
    }
    if (options.keep !== false) rememberTracks(playlistId, value)
    return value
  }

  function status() {
    return {
      refreshing,
      lastRefreshAt,
      lastError,
      fileCount: snapshot?.files.length ?? 0,
      warnings: snapshot?.warnings ?? [],
      truncated: snapshot?.truncated ?? false
    }
  }

  return {
    refresh,
    ensureSnapshot,
    listPlaylists,
    getPlaylistTracks,
    invalidate,
    invalidateAll,
    status
  }
}
