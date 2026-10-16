/**
 * XML-based playlists: XSPF, WPL and ASX.
 *
 * These carry no formal need for a full XML parser — each is a flat list of
 * media entries with a handful of leaf elements — so they are read with
 * targeted, namespace-tolerant extraction instead of pulling in a dependency.
 * Element matching is deliberately narrow (a tag must be followed by `>` or
 * whitespace) so that `<trackList>` is never mistaken for `<track>`.
 */

import { isRemoteEntry, splitArtistTitle } from './m3u.mjs'

const NAMESPACE_PREFIX = '(?:[\\w.-]+:)?'

function tagName(tag) {
  return `${NAMESPACE_PREFIX}${tag}`
}

function elementText(text, tag) {
  const pattern = new RegExp(
    `<${tagName(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName(tag)}\\s*>`,
    'i'
  )
  const match = pattern.exec(text)
  if (!match) return ''
  return stripCdata(decodeEntities(match[1])).trim()
}

function elementAttribute(text, tag, attribute) {
  const pattern = new RegExp(`<${tagName(tag)}\\b[^>]*\\b${attribute}\\s*=\\s*["']([^"']*)["']`, 'i')
  const match = pattern.exec(text)
  return match ? decodeEntities(match[1]).trim() : ''
}

/** Every occurrence of a paired element, in document order. */
function allElements(text, tag) {
  const pattern = new RegExp(
    `<${tagName(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName(tag)}\\s*>`,
    'gi'
  )
  return [...text.matchAll(pattern)].map((match) => match[1])
}

function stripCdata(value) {
  const match = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value)
  return match ? match[1] : value
}

function fromCodePoint(code) {
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

export function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => fromCodePoint(Number(decimal)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Ampersand last, so `&amp;lt;` decodes to the literal `&lt;`.
    .replace(/&amp;/g, '&')
}

/**
 * XSPF (`application/xspf+xml`) — VLC's own format, also written by Quod Libet,
 * Clementine and others. Durations are in **milliseconds**.
 */
export function parseXspf(text, options = {}) {
  const splitTitles = options.splitArtistTitle !== false
  const entries = []
  const warnings = []
  let skipped = 0
  let line = 0

  for (const block of allElements(text, 'track')) {
    line += 1
    // A track may list several locations; the first is the canonical one.
    const location = elementText(block, 'location')
    if (!location) {
      skipped += 1
      continue
    }

    const rawTitle = elementText(block, 'title')
    const creator = elementText(block, 'creator')
    const album = elementText(block, 'album')

    let artist = creator
    let title = rawTitle
    if (!artist && title && splitTitles) {
      const split = splitArtistTitle(title)
      artist = split.artist
      title = split.title
    }

    const milliseconds = Number(elementText(block, 'duration'))
    const durationSeconds =
      Number.isFinite(milliseconds) && milliseconds > 0 ? Math.round(milliseconds / 1000) : null

    entries.push({
      path: location,
      title,
      artist,
      album,
      durationSeconds,
      remote: isRemoteEntry(location),
      line
    })
  }

  if (skipped > 0) warnings.push(`已跳过 ${skipped} 个没有 location 的 XSPF 曲目`)
  if (entries.length === 0 && skipped === 0) warnings.push('XSPF 中没有找到曲目')
  return { entries, warnings }
}

/**
 * WPL — Windows Media Player's SMIL-derived playlist. Entries are
 * `<media src="..."/>` elements in document order.
 */
export function parseWpl(text) {
  const entries = []
  const warnings = []
  let line = 0

  const pattern = new RegExp(
    `<${tagName('media')}\\b[^>]*\\bsrc\\s*=\\s*["']([^"']*)["'][^>]*>`,
    'gi'
  )
  for (const match of text.matchAll(pattern)) {
    line += 1
    const source = decodeEntities(match[1]).trim()
    if (!source) continue

    // WPL carries no per-entry metadata at all; the provider falls back to the
    // file name for both title and artist.
    entries.push({
      path: source,
      title: '',
      artist: '',
      album: '',
      durationSeconds: null,
      remote: isRemoteEntry(source),
      line
    })
  }

  if (entries.length === 0) warnings.push('WPL 中没有找到 media 条目')
  return { entries, warnings }
}

/**
 * ASX / WAX — Windows Media metafiles. Mostly used for streams, but local
 * entries appear too.
 */
export function parseAsx(text, options = {}) {
  const splitTitles = options.splitArtistTitle !== false
  const entries = []
  const warnings = []
  let line = 0

  const blocks = allElements(text, 'entry')
  const sources = blocks.length > 0 ? blocks : [text]

  for (const block of sources) {
    line += 1
    const href = elementAttribute(block, 'ref', 'href') || elementAttribute(block, 'entryref', 'href')
    if (!href) {
      if (blocks.length === 0) warnings.push('ASX 中没有找到 ref 条目')
      continue
    }

    let artist = elementText(block, 'author')
    let title = elementText(block, 'title')
    if (!artist && title && splitTitles) {
      const split = splitArtistTitle(title)
      artist = split.artist
      title = split.title
    }

    entries.push({
      path: href,
      title,
      artist,
      album: elementText(block, 'album'),
      durationSeconds: null,
      remote: isRemoteEntry(href),
      line
    })
  }

  return { entries, warnings }
}

export const XML_PLAYLIST_PARSERS = {
  xspf: parseXspf,
  wpl: parseWpl,
  asx: parseAsx,
  wax: parseAsx
}

export const __internal = { elementText, elementAttribute, allElements }
