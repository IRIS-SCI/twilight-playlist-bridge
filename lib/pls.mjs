/**
 * PLS parsing — the INI-like format written by Shoutcast/Icecast tools and
 * read by essentially every player. Same shape as the host's own importer:
 * a `[playlist]` section with `FileN` / `TitleN` / `LengthN` keys, emitted in
 * numeric order.
 *
 * Real-world files are inconsistent: numbering may start above 1 or have gaps,
 * and `NumberOfEntries` / `Version` footers may appear first, last, or not at
 * all. The footers are therefore ignored and the order comes from the `N`.
 */

import { isRemoteEntry, splitArtistTitle } from './m3u.mjs'

const MAX_ENTRIES = 20_000

/**
 * @param {string} text
 * @param {{ splitArtistTitle?: boolean }} [options]
 * @returns {{ entries: Array<object>, warnings: string[] }}
 */
export function parsePls(text, options = {}) {
  const splitTitles = options.splitArtistTitle !== false
  const fields = new Map()
  const warnings = []
  let inPlaylist = false
  let lineNumber = 0

  for (const raw of text.split(/\r\n|\n|\r/)) {
    lineNumber += 1
    const line = raw.replace(/^\uFEFF/, '').trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    if (/^\[playlist\]$/i.test(line)) {
      inPlaylist = true
      continue
    }
    if (line.startsWith('[')) {
      inPlaylist = false
      continue
    }
    if (!inPlaylist) continue

    const equals = line.indexOf('=')
    if (equals <= 0) continue
    const key = line.slice(0, equals).trim()
    const value = line.slice(equals + 1).trim()

    const match = /^(file|title|length)(\d+)$/i.exec(key)
    if (!match) continue
    const index = Number(match[2])
    if (!Number.isSafeInteger(index) || index < 1 || index > MAX_ENTRIES) {
      warnings.push(`已跳过非法 PLS 条目序号：${key}`)
      continue
    }

    const record = fields.get(index) ?? { line: lineNumber }
    const kind = match[1].toLowerCase()
    if (kind === 'file') record.path = value
    else if (kind === 'title') record.rawTitle = value
    else {
      const seconds = Number(value)
      record.durationSeconds =
        Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null
    }
    fields.set(index, record)
  }

  const entries = []
  for (const index of [...fields.keys()].sort((a, b) => a - b)) {
    const record = fields.get(index)
    if (!record.path) {
      warnings.push('已跳过没有 FileN 的 PLS 条目')
      continue
    }
    let artist = ''
    let title = record.rawTitle ?? ''
    if (title && splitTitles) {
      const split = splitArtistTitle(title)
      artist = split.artist
      title = split.title
    }
    entries.push({
      path: record.path,
      title,
      artist,
      album: '',
      durationSeconds: record.durationSeconds ?? null,
      remote: isRemoteEntry(record.path),
      line: record.line
    })
  }

  return { entries, warnings }
}
