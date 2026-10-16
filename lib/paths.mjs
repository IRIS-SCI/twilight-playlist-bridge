/**
 * Turning the literal path text of a playlist entry into a real file path.
 *
 * Playlist entries are written by whichever player exported them, so they may
 * be absolute Windows paths, absolute POSIX paths, UNC shares, `file://` URIs,
 * or paths relative to the playlist file itself. Each flavour is normalized
 * with the matching path implementation rather than the host's, so a Windows
 * playlist stays readable when inspected from another platform.
 *
 * foobar2000 in particular writes `file://E:\Music\track.flac` — a `file://`
 * URI whose payload is a raw, **un-escaped** Windows path with backslashes.
 * `fileURLToPath` rejects that shape, so the scheme is stripped by hand before
 * falling back to the standard parser (which is what correctly handles the
 * properly escaped `file:///D:/My%20Music/...` written by VLC and others).
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/
const UNC_PREFIX = /^\\\\/
const WINDOWS_DRIVE = /^([a-zA-Z]):[\\/](.*)$/
const LEADING_DRIVE_SEGMENT = /^\/[a-zA-Z]:[\\/]/
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/

export function isWindowsPath(value) {
  const text = (value ?? '').trim()
  return WINDOWS_ABSOLUTE.test(text) || UNC_PREFIX.test(text)
}

function normalizeSlashes(value) {
  // Mixed separators appear when a playlist is hand-edited or produced on
  // another platform; collapse doubles but keep a leading UNC pair intact.
  return value.replace(/\//g, '\\').replace(/\\{3,}/g, '\\\\')
}

/**
 * Resolves a `file://` entry. Handles the foobar2000 dialect first, then falls
 * back to the standard WHATWG parser for properly escaped URIs.
 */
function resolveFileUri(raw) {
  const rest = raw.slice('file://'.length)
  const body = LEADING_DRIVE_SEGMENT.test(rest) ? rest.slice(1) : rest

  if (isWindowsPath(body)) return path.win32.normalize(normalizeSlashes(body))
  if (body.startsWith('/')) return path.posix.normalize(body)

  try {
    return path.normalize(fileURLToPath(raw))
  } catch {
    return null
  }
}

/**
 * @param {string} entryPath literal value from the playlist
 * @param {string} playlistDir absolute directory holding the playlist file
 * @returns {string | null} absolute path, or null when it cannot be resolved
 */
export function resolveEntryPath(entryPath, playlistDir) {
  const raw = (entryPath ?? '').trim().replace(/^\uFEFF/, '')
  if (!raw || raw.includes('\0')) return null

  if (/^file:\/\//i.test(raw)) return resolveFileUri(raw)

  if (isWindowsPath(raw)) return path.win32.normalize(normalizeSlashes(raw))

  if (raw.startsWith('/')) return path.posix.normalize(raw)

  // Relative entry: resolve with the flavour of the directory it lives in.
  const windowsDir = isWindowsPath(playlistDir)
  const impl = windowsDir ? path.win32 : path.posix
  const relative = windowsDir ? normalizeSlashes(raw) : raw.replace(/\\/g, '/')
  return impl.resolve(playlistDir, relative)
}

/**
 * A percent-decoded reading of the same path.
 *
 * Whether `%20` in a `file://` entry means a space or three literal characters
 * cannot be decided from the text alone, so both readings are offered as
 * candidates and the first one that exists on disk wins.
 */
export function percentDecodedVariant(absolutePath) {
  if (!absolutePath || !PERCENT_ESCAPE.test(absolutePath)) return null
  try {
    const decoded = decodeURIComponent(absolutePath)
    return decoded && decoded !== absolutePath ? decoded : null
  } catch {
    return null
  }
}

/**
 * Cheap relocation for playlists whose drive letter or library root moved
 * (`D:\Music\A\b.flac` when the library now lives at `E:\Music`).
 *
 * Only the tail below the root segment is re-attached, so this never walks the
 * filesystem; existence is still verified by the caller before it is used.
 *
 * @param {string} absolutePath a path that failed to resolve
 * @param {string[]} searchRoots configured candidate roots
 * @returns {string[]} candidate paths, most specific first
 */
export function relocationCandidates(absolutePath, searchRoots) {
  if (!absolutePath || !Array.isArray(searchRoots) || searchRoots.length === 0) return []

  const windowsMatch = WINDOWS_DRIVE.exec(absolutePath)
  if (!windowsMatch) return []

  const segments = windowsMatch[2].split(/[\\/]+/).filter(Boolean)
  if (segments.length === 0) return []

  const candidates = []
  const seen = new Set()
  // Try dropping leading segments so `D:\Music\Album\x.flac` can match a root
  // that already ends in `Music` or `Album`.
  for (let drop = 0; drop < segments.length; drop++) {
    const tail = segments.slice(drop)
    for (const root of searchRoots) {
      const base = (root ?? '').trim()
      if (!base) continue
      const candidate = path.win32.join(base, ...tail)
      const key = candidate.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push(candidate)
    }
  }
  return candidates
}

/** Lowercased key used to compare paths that came from different sources. */
export function pathKey(value) {
  return (value ?? '').replace(/\//g, '\\').replace(/\\+/g, '\\').toLowerCase()
}

/** File name without extension, used as the playlist display name. */
export function playlistNameFromFile(filePath) {
  const base = path.basename(filePath)
  const dot = base.lastIndexOf('.')
  const name = dot > 0 ? base.slice(0, dot) : base
  return name.trim() || base
}

/** Only strips a plausible file extension, so `S.T.A.Y` keeps its dots. */
const FILE_EXTENSION = /\.[A-Za-z0-9]{2,5}$/

/** `01.`, `01 -`, `(01)`, `01_`, `[01]` — the track-number prefixes rippers emit. */
const TRACK_NUMBER_PREFIX = /^\s*(?:\[(\d{1,3})\]|\((\d{1,3})\)|(\d{1,3}))(?:[.\-_)]|\s)+/

/**
 * A dash counts as an artist/title separator only when at least one side has
 * whitespace. That keeps `Tick-Tock` and `S.T.A.Y` intact while still splitting
 * the `Artist - Title` and `Artist -Title-` shapes rippers produce.
 */
const ARTIST_TITLE_DASH = /\s+-\s*|\s*-\s+/

/**
 * Recovers a title (and artist, when present) from a bare audio file name.
 *
 * Playlists that carry no metadata at all are common — `.fplite`, `.wpl`, and
 * `.m3u` files written without `#EXTINF` — and falling back to the raw file name
 * means the player shows `01. Hans Zimmer - Dreaming of the Crash.flac`
 * instead of `Dreaming of the Crash`. The file name is the only information
 * available in those cases, so it is worth reading properly.
 *
 * @param {string} fileName
 * @param {{ splitArtistTitle?: boolean }} [options] `false` disables both the
 *   track-number strip and the artist/title split, yielding the bare stem.
 * @returns {{ title: string, artist: string }}
 */
export function describeTrackFileName(fileName, options = {}) {
  const raw = String(fileName ?? '').trim()
  if (!raw) return { title: '', artist: '' }

  const base = raw.replace(FILE_EXTENSION, '').trim()
  if (!base) return { title: raw, artist: '' }
  if (options.splitArtistTitle === false) return { title: base, artist: '' }

  const stripped = base.replace(TRACK_NUMBER_PREFIX, '').trim()
  const cleaned = stripped || base

  const match = ARTIST_TITLE_DASH.exec(cleaned)
  if (!match) return { title: cleaned, artist: '' }

  const artist = cleaned.slice(0, match.index).trim()
  let title = cleaned.slice(match.index + match[0].length).trim()
  // `Artist -Title-` leaves a dangling separator behind the title.
  if (title.endsWith('-')) title = title.slice(0, -1).trim()

  if (!artist || !title) return { title: cleaned, artist: '' }
  return { title, artist }
}
