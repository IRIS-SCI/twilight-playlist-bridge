/**
 * Text decoding for playlist files.
 *
 * Only `.m3u8` and `.xspf` have a guaranteed encoding; `.m3u` is whatever the
 * exporting player's system codepage was — for a Chinese Windows install that
 * is GBK. Reading those bytes as UTF-8 produces mojibake titles, so every
 * playlist is decoded through an ordered strategy instead of assuming UTF-8.
 */

const UTF8_BOM = [0xef, 0xbb, 0xbf]
const UTF16LE_BOM = [0xff, 0xfe]
const UTF16BE_BOM = [0xfe, 0xff]

/** Encodings offered in the settings panel, in fallback order. */
export const SUPPORTED_ENCODINGS = [
  'auto',
  'utf-8',
  'gb18030',
  'big5',
  'shift_jis',
  'euc-kr',
  'windows-1252',
  'utf-16le',
  'utf-16be'
]

const REPLACEMENT = '\uFFFD'

function startsWithBytes(bytes, prefix) {
  if (bytes.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false
  }
  return true
}

function decodeWith(bytes, label) {
  return new TextDecoder(label, { fatal: false, ignoreBOM: true }).decode(bytes)
}

/**
 * A decode is treated as plausible only when it produced no replacement
 * characters. `TextDecoder` substitutes U+FFFD instead of throwing for most
 * invalid input, so counting replacements is the practical validity signal.
 */
function tryDecode(bytes, label, fatal) {
  try {
    const text = decodeWith(bytes, label, fatal)
    return text.includes(REPLACEMENT) ? null : text
  } catch {
    return null
  }
}

export function isSupportedEncoding(label) {
  return SUPPORTED_ENCODINGS.includes(label)
}

/**
 * BOM-aware, codepage-tolerant decode.
 *
 * @param {Uint8Array} bytes
 * @param {string} [preferred] one of SUPPORTED_ENCODINGS; `auto` (default)
 *   probes UTF-8 first and then falls back through the legacy codepages.
 * @returns {{ text: string, encoding: string, warnings: string[] }}
 */
export function decodePlaylistBuffer(bytes, preferred = 'auto') {
  const warnings = []
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? [])

  // A BOM is authoritative: players write one for UTF-16 playlists and
  // sometimes for UTF-8 ones.
  if (startsWithBytes(source, UTF8_BOM)) {
    return { text: decodeWith(source.subarray(3), 'utf-8'), encoding: 'utf-8', warnings }
  }
  if (startsWithBytes(source, UTF16LE_BOM)) {
    return { text: decodeWith(source.subarray(2), 'utf-16le'), encoding: 'utf-16le', warnings }
  }
  if (startsWithBytes(source, UTF16BE_BOM)) {
    return { text: decodeWith(source.subarray(2), 'utf-16be'), encoding: 'utf-16be', warnings }
  }

  if (preferred && preferred !== 'auto') {
    if (!isSupportedEncoding(preferred)) {
      warnings.push(`未知编码 ${preferred}，已改用自动检测`)
    } else {
      const text = tryDecode(source, preferred, true) ?? tryDecode(source, preferred, false)
      if (text !== null) return { text, encoding: preferred, warnings }
      warnings.push(`${preferred} 解码失败，已改用自动检测`)
    }
  }

  // Strict UTF-8 accepts every valid multi-byte sequence and rejects the lone
  // high bytes a GBK file is full of, so it cleanly separates the two. This
  // must come before gb18030, which decodes almost any byte sequence and would
  // otherwise mangle genuine UTF-8.
  const detected = detectDeclaredEncoding(source)
  if (detected && detected !== 'utf-8' && isSupportedEncoding(detected)) {
    const text = tryDecode(source, detected, true)
    if (text !== null) {
      return { text, encoding: detected, warnings }
    }
  }

  const utf8 = tryDecode(source, 'utf-8', true)
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8', warnings }

  for (const label of ['gb18030', 'big5', 'shift_jis', 'euc-kr']) {
    const text = tryDecode(source, label, true)
    if (text !== null) {
      // gb18030 is a superset of GBK and decodes the widest range of Chinese
      // legacy files, so it is the preferred first fallback.
      return { text, encoding: label, warnings }
    }
  }

  // Last resort: never fail an import over encoding.
  warnings.push('无法确定歌单编码，已按 windows-1252 解码，标题可能显示异常')
  return { text: decodeWith(source, 'windows-1252'), encoding: 'windows-1252', warnings }
}

/**
 * XML playlists declare their own encoding. Honour it when it names something
 * we support, so a `encoding="gb2312"` XSPF is not decoded as UTF-8.
 */
const DECLARED_ENCODING = /<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']/i

const ENCODING_ALIASES = {
  gb2312: 'gb18030',
  gbk: 'gb18030',
  gb18030: 'gb18030',
  big5: 'big5',
  'shift-jis': 'shift_jis',
  shift_jis: 'shift_jis',
  sjis: 'shift_jis',
  euc_kr: 'euc-kr',
  'euc-kr': 'euc-kr',
  cp1252: 'windows-1252',
  'windows-1252': 'windows-1252',
  utf8: 'utf-8',
  'utf-8': 'utf-8',
  'utf-16': 'utf-16le',
  'utf-16le': 'utf-16le'
}

export function detectDeclaredEncoding(bytes) {
  // The declaration is pure ASCII and lives in the first line of the file.
  const head = Buffer.from(
    bytes instanceof Uint8Array ? bytes.subarray(0, 256) : Buffer.alloc(0)
  ).toString('latin1')
  const match = DECLARED_ENCODING.exec(head)
  if (!match) return null
  return ENCODING_ALIASES[match[1].toLowerCase()] ?? null
}

/** Decode a byte buffer that is known to be UTF-8, tolerating a BOM. */
export function decodeUtf8(bytes) {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? [])
  const body = startsWithBytes(source, UTF8_BOM) ? source.subarray(3) : source
  return decodeWith(body, 'utf-8')
}
