/**
 * M3U / M3U8 parsing.
 *
 * The de-facto universal playlist format, written by foobar2000, VLC, Winamp,
 * AIMP, MusicBee, PotPlayer and most others. Follows the same dialect the
 * host's own importer accepts (`#EXTM3U`, `#EXTINF:<seconds>,<title>`,
 * `#`-comments, one path per line) and tolerates the extended tags some players
 * emit (`#EXTART` / `#EXTALB` / `#EXTGENRE`), which foobar2000 itself ignores.
 */

/** Entries whose target is a network stream rather than a local file. */
const REMOTE_URL_PATTERN = /^(?:https?|rtmp|rtsp|mms|mmsh|rtp|udp):\/\//i

/**
 * foobar2000's default title format is `Artist - Title`. Splitting it recovers
 * the two fields the player UI wants; anything else stays as a whole title.
 */
const ARTIST_TITLE_SEPARATOR = ' - '

export function isRemoteEntry(value) {
  return REMOTE_URL_PATTERN.test(value.trim())
}

export function splitArtistTitle(value) {
  const text = value.trim()
  const index = text.indexOf(ARTIST_TITLE_SEPARATOR)
  if (index <= 0) return { artist: '', title: text }
  const artist = text.slice(0, index).trim()
  const title = text.slice(index + ARTIST_TITLE_SEPARATOR.length).trim()
  if (!artist || !title) return { artist: '', title: text }
  return { artist, title }
}

/**
 * `#EXTINF:<duration>[,<title>]` — duration is frequently `-1` when the source
 * has no length, IPTV-style files append attributes before the comma, and
 * titles legitimately contain commas, so only the first comma splits.
 */
export function parseExtInf(value) {
  const body = value.slice(value.indexOf(':') + 1)
  const comma = body.indexOf(',')
  const head = comma === -1 ? body : body.slice(0, comma)
  const rawTitle = comma === -1 ? '' : body.slice(comma + 1).trim()

  const durationMatch = /[+-]?\d+(?:\.\d+)?/.exec(head)
  const seconds = durationMatch ? Number(durationMatch[0]) : Number.NaN
  const durationSeconds = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null

  return { durationSeconds, rawTitle }
}

/** Strips one layer of surrounding quotes, which some exporters add. */
function unquote(value) {
  const text = value.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).trim()
  }
  return text
}

/**
 * @param {string} text
 * @param {{ splitArtistTitle?: boolean }} [options]
 * @returns {{ entries: Array<object>, warnings: string[] }}
 */
export function parseM3u(text, options = {}) {
  const splitTitles = options.splitArtistTitle !== false
  const entries = []
  const warnings = []

  let pending = { title: '', artist: '', album: '', durationSeconds: null }
  let lineNumber = 0

  for (const raw of text.split(/\r\n|\n|\r/)) {
    lineNumber += 1
    const line = raw.replace(/^\uFEFF/, '').trim()
    if (!line) continue

    if (line.startsWith('#')) {
      const upper = line.toUpperCase()
      if (upper.startsWith('#EXTINF:')) {
        const info = parseExtInf(line)
        pending.durationSeconds = info.durationSeconds
        if (info.rawTitle) {
          if (splitTitles) {
            const split = splitArtistTitle(info.rawTitle)
            pending.artist = split.artist
            pending.title = split.title
          } else {
            pending.title = info.rawTitle
          }
        }
        continue
      }
      // Extended info tags written by Winamp and friends.
      const colon = line.indexOf(':')
      if (colon > 0) {
        const tag = upper.slice(1, colon)
        const value = line.slice(colon + 1).trim()
        if (tag === 'EXTART' || tag === 'ARTIST') pending.artist = value
        else if (tag === 'EXTALB' || tag === 'ALBUM') pending.album = value
      }
      // #EXTM3U, #PLAYLIST, #EXT-X-*, #EXTENC, #EXTBYT ... carry no path.
      continue
    }

    entries.push({
      path: unquote(line),
      title: pending.title,
      artist: pending.artist,
      album: pending.album,
      durationSeconds: pending.durationSeconds,
      remote: isRemoteEntry(line),
      line: lineNumber
    })
    pending = { title: '', artist: '', album: '', durationSeconds: null }
  }

  return { entries, warnings }
}
