/**
 * foobar2000 2.x `.fplite` playlists.
 *
 * Despite the name, `.fplite` is **not** the binary `.fpl` format. It is plain
 * UTF-8 text (with BOM, LF endings) holding exactly one location URI per line
 * and no metadata at all:
 *
 *     file://E:\CloudMusic\Artist - Track.flac
 *     file://E:\Music\album.dsf\t1          <- \t<subsong> for container files
 *     cdda://E:\Track01.cda
 *
 * Playlist *names* are not stored in the file either: a sibling `index.txt`
 * maps playlist GUIDs to names, which is why a directory full of
 * `playlist-<GUID>.fplite` files is otherwise unreadable.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

const FPLITE_PREFIX = 'playlist-'
const INDEX_FILE = 'index.txt'
const SUPPORTED_SCHEME = /^file:\/\//i

/** `playlist-7F9B1053-....fplite` -> `7F9B1053-...` */
export function fpliteGuidFromFile(filePath) {
  const base = path.basename(filePath)
  if (!base.toLowerCase().endsWith('.fplite')) return null
  const withoutExtension = base.slice(0, -'.fplite'.length)
  if (!withoutExtension.toLowerCase().startsWith(FPLITE_PREFIX)) return null
  const guid = withoutExtension.slice(FPLITE_PREFIX.length).trim()
  return guid || null
}

/**
 * Reads the sibling `index.txt` that carries playlist names.
 * Each line is `<guid>:<name>`. Returns an empty map when it is absent.
 *
 * @param {string} directory
 * @returns {Promise<Map<string, string>>}
 */
export async function readFpliteIndex(directory) {
  const names = new Map()
  let text
  try {
    text = await fs.readFile(path.join(directory, INDEX_FILE), 'utf8')
  } catch {
    return names
  }
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.replace(/^\uFEFF/, '').trim()
    if (!line) continue
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const guid = line.slice(0, separator).trim()
    const name = line.slice(separator + 1).trim()
    if (guid && name) names.set(guid.toLowerCase(), name)
  }
  return names
}

/** Looks a `.fplite` file up in an `index.txt` map. */
export function nameFromFpliteIndex(filePath, names) {
  if (!names || names.size === 0) return null
  const guid = fpliteGuidFromFile(filePath)
  if (!guid) return null
  return names.get(guid.toLowerCase()) ?? null
}

/**
 * @param {Uint8Array} bytes
 * @returns {{ entries: Array<object>, warnings: string[] }}
 */
export function parseFplite(bytes) {
  const warnings = []
  const text = Buffer.isBuffer(bytes)
    ? bytes.toString('utf8')
    : Buffer.from(bytes ?? []).toString('utf8')

  const entries = []
  let skippedSchemes = 0
  let lineNumber = 0

  for (const raw of text.split(/\r\n|\n|\r/)) {
    lineNumber += 1
    const line = raw.replace(/^\uFEFF/, '').trim()
    if (!line || line.startsWith('#')) continue

    // A tab separates the location from the subsong index.
    const tab = line.indexOf('\t')
    const location = (tab === -1 ? line : line.slice(0, tab)).trim()
    if (!location) continue

    if (!SUPPORTED_SCHEME.test(location)) {
      // cdda:// and friends point at hardware, not at files.
      skippedSchemes += 1
      continue
    }

    entries.push({
      path: location,
      title: '',
      artist: '',
      album: '',
      durationSeconds: null,
      remote: false,
      line: lineNumber
    })
  }

  if (skippedSchemes > 0) {
    warnings.push(`已跳过 ${skippedSchemes} 条非文件条目（如 cdda://）`)
  }
  if (entries.length === 0 && skippedSchemes === 0) {
    warnings.push('文件中没有可用的文件路径')
  }

  return { entries, warnings }
}
