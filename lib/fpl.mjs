/**
 * foobar2000 `.fpl` playlists.
 *
 * `.fpl` is foobar2000's proprietary binary playlist format. It carries no
 * published specification — foobar2000's own FAQ states it is deliberately not
 * meant to be interchangeable — so this parser follows the reverse-engineered
 * layout documented by the `fpl-format` / `fplreader` projects and cross-checked
 * against their reference readers:
 *
 *   playlist := magic[16] meta_size:u32 meta[meta_size] track_count:u32 track*
 *   track    := flags:u32 file_name_offset:u32 subsong:u32
 *               [ file_size:u64 file_time:u64 duration:f64
 *                 rpg_album:f32 rpg_track:f32 rpk_album:f32 rpk_track:f32
 *                 entry_count:u32 entry[entry_count]:u32 ]
 *               [ padding[64] ]
 *
 * `meta` is a pool of NUL-terminated UTF-8 strings; every string field is an
 * offset into it. A track whose `flags` bit 0 is clear (a stream that was never
 * played) ends right after `subsong` — reading the rest would desynchronize the
 * whole file. `flags` bit 2 adds 64 bytes of padding after the entries.
 *
 * If the structural parse fails for any reason the buffer falls back to a
 * bounded string-recovery scan, so an unrecognised future revision degrades to
 * "paths without metadata" rather than to an empty playlist.
 */

const FPL_MAGIC = Buffer.from('e1a09c91f83c7742852c3bcc1401d3f2', 'hex')

const FLAG_HAS_METADATA = 0x01
const FLAG_HAS_PADDING = 0x04

const MAX_TRACKS = 200_000
const MAX_META_BYTES = 8 * 1024 * 1024

const AUDIO_EXTENSION =
  /\.(?:flac|mp3|m4a|m4b|mp4|aac|wav|wave|aiff|aif|aifc|ape|wv|mpc|tak|tta|ogg|oga|opus|dsf|dff|wma|alac|amr|ac3|dts|mka|w64|caf)$/i

const WINDOWS_PATH =
  /[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n\0]{1,255}[\\/]){0,40}[^\\/:*?"<>|\r\n\0]{1,255}/g
const UNC_PATH = /\\\\[^\\/\r\n\0]{1,64}[\\/][^\r\n\0]{1,1024}?(?=[\0\r\n]|$)/g

class StructuralError extends Error {}

/** Bounds-checked little-endian cursor over the playlist buffer. */
class Cursor {
  constructor(buffer, offset = 0) {
    this.buffer = buffer
    this.offset = offset
  }

  need(bytes) {
    if (this.offset + bytes > this.buffer.length) {
      throw new StructuralError(`文件在第 ${this.offset} 字节处意外结束`)
    }
  }

  u32() {
    this.need(4)
    const value = this.buffer.readUInt32LE(this.offset)
    this.offset += 4
    return value
  }

  s32() {
    this.need(4)
    const value = this.buffer.readInt32LE(this.offset)
    this.offset += 4
    return value
  }

  u64() {
    this.need(8)
    const value = this.buffer.readBigUInt64LE(this.offset)
    this.offset += 8
    return value
  }

  f64() {
    this.need(8)
    const value = this.buffer.readDoubleLE(this.offset)
    this.offset += 8
    return value
  }

  f32() {
    this.need(4)
    const value = this.buffer.readFloatLE(this.offset)
    this.offset += 4
    return value
  }

  skip(bytes) {
    this.need(bytes)
    this.offset += bytes
  }
}

/** Reads a NUL-terminated UTF-8 string out of the metadata pool. */
function readPoolString(pool, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset >= pool.length) return ''
  let end = pool.indexOf(0, offset)
  if (end === -1) end = pool.length
  return pool.subarray(offset, end).toString('utf8').trim()
}

function toEntries(records) {
  return records.map((record) => ({
    path: record.path,
    title: record.title ?? '',
    artist: record.artist ?? '',
    album: record.album ?? '',
    durationSeconds: record.durationSeconds ?? null,
    remote: /^(?:https?|rtmp|rtsp|mms):\/\//i.test(record.path),
    line: record.index + 1
  }))
}

/**
 * @param {Buffer} buffer
 * @returns {Array<object>} raw track records
 */
function parseStructural(buffer) {
  if (buffer.length < 24) throw new StructuralError('文件过小')
  if (!buffer.subarray(0, 16).equals(FPL_MAGIC)) {
    throw new StructuralError('不是 FPL 格式')
  }

  const header = new Cursor(buffer, 16)
  const metaSize = header.u32()
  if (metaSize <= 0 || metaSize > MAX_META_BYTES || 20 + metaSize + 4 > buffer.length) {
    throw new StructuralError('元数据区长度无效')
  }
  const pool = buffer.subarray(20, 20 + metaSize)

  const cursor = new Cursor(buffer, 20 + metaSize)
  const trackCount = cursor.u32()
  if (trackCount > MAX_TRACKS) throw new StructuralError('曲目数量超出上限')

  const records = []
  for (let index = 0; index < trackCount; index++) {
    const flags = cursor.s32()
    const fileNameOffset = cursor.u32()
    const path = readPoolString(pool, fileNameOffset)
    cursor.u32() // subsong index — only meaningful for multi-song files

    if ((flags & FLAG_HAS_METADATA) === 0) {
      // A stream that was never played. The remaining track fields are absent.
      records.push({ index, path, durationSeconds: null })
      continue
    }

    cursor.u64() // file size
    cursor.u64() // last-modified time in Windows ticks
    const duration = cursor.f64()
    cursor.f32() // replaygain album
    cursor.f32() // replaygain track
    cursor.f32() // replaygain peak album
    cursor.f32() // replaygain peak track

    const entryCount = cursor.u32()
    if (entryCount > 1_000_000 || cursor.offset + entryCount * 4 > buffer.length) {
      throw new StructuralError('键值索引长度无效')
    }
    const words = new Array(entryCount)
    for (let word = 0; word < entryCount; word++) words[word] = cursor.u32()

    const metadata = readMetadata(pool, words)
    const durationSeconds = Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null

    records.push({
      index,
      path,
      title: metadata.title ?? '',
      artist: metadata.artist ?? '',
      album: metadata.album ?? '',
      durationSeconds
    })

    if ((flags & FLAG_HAS_PADDING) !== 0) cursor.skip(64)
  }

  return records
}

/**
 * The entry table is three header words followed by primary key/value offsets,
 * a spacer, and finally the secondary key/value offsets.
 */
function readMetadata(pool, words) {
  const metadata = {}
  if (words.length < 3) return metadata

  const primaryKeyCount = words[0]
  const secondaryKeyCount = words[1]
  const secondaryKeysOffset = words[2]

  const nameOffsets = new Map()
  for (let i = 0; i < primaryKeyCount; i++) {
    const id = words[3 + i * 2]
    const nameOffset = words[3 + i * 2 + 1]
    if (Number.isInteger(id) && Number.isInteger(nameOffset)) nameOffsets.set(id, nameOffset)
  }

  const valueBase = 3 + primaryKeyCount * 2 + 1
  let lastOffset = null
  for (let i = 0; i < primaryKeyCount; i++) {
    // foobar2000 tolerates gaps in the key id sequence by repeating the previous
    // key; mirroring that keeps discontiguous playlists readable.
    lastOffset = nameOffsets.get(i) ?? lastOffset
    const valueOffset = words[valueBase + i]
    if (lastOffset == null || valueOffset === undefined) continue
    const key = readPoolString(pool, lastOffset).toLowerCase()
    const value = readPoolString(pool, valueOffset)
    if (key && !(key in metadata)) metadata[key] = value
  }

  // Secondary keys are addressed relative to the start of the entry table.
  const secondaryBase = secondaryKeysOffset + 3
  for (let i = 0; i < secondaryKeyCount; i++) {
    const keyOffset = words[secondaryBase + i * 2]
    const valueOffset = words[secondaryBase + i * 2 + 1]
    if (keyOffset === undefined || valueOffset === undefined) break
    const key = readPoolString(pool, keyOffset).toLowerCase()
    const value = readPoolString(pool, valueOffset)
    if (key && !(key in metadata)) metadata[key] = value
  }

  return metadata
}

function collectMatches(text, pattern, sink, offsetFor) {
  pattern.lastIndex = 0
  let match
  while ((match = pattern.exec(text)) !== null) {
    const candidate = match[0].trim()
    if (!AUDIO_EXTENSION.test(candidate)) continue
    if (candidate.includes('\0')) continue
    sink.push({ value: candidate, offset: offsetFor(match.index) })
  }
}

/**
 * Recovery scan used only when the structural parse fails.
 *
 * UTF-16 is scanned at both byte alignments: a single odd-length field
 * elsewhere in the file shifts the whole stream by one byte, and without the
 * second pass every path after that field would decode to garbage.
 */
function recoverPaths(bytes) {
  const sink = []
  const formats = [
    { label: 'utf-16le', alignments: [0, 1], scale: 2 },
    { label: 'utf-8', alignments: [0], scale: 1 }
  ]

  for (const format of formats) {
    for (const alignment of format.alignments) {
      if (alignment >= bytes.length) continue
      let text
      try {
        text = new TextDecoder(format.label, { fatal: false, ignoreBOM: true }).decode(
          bytes.subarray(alignment)
        )
      } catch {
        continue
      }
      const offsetFor = (index) => alignment + index * format.scale
      collectMatches(text, WINDOWS_PATH, sink, offsetFor)
      collectMatches(text, UNC_PATH, sink, offsetFor)
    }
  }

  sink.sort((left, right) => left.offset - right.offset)

  const seen = new Set()
  const result = []
  for (const item of sink) {
    const key = item.value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item.value)
  }
  return result
}

/**
 * @param {Uint8Array} bytes raw `.fpl` contents
 * @param {{ splitArtistTitle?: boolean }} [options]
 * @returns {{ entries: Array<object>, warnings: string[] }}
 */
export function parseFpl(bytes, options = {}) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? [])
  const warnings = []

  if (source.length === 0) return { entries: [], warnings: ['文件为空'] }

  try {
    const records = parseStructural(source)
    const split = options.splitArtistTitle !== false
    const entries = toEntries(records).map((entry) => {
      if (!split || entry.artist || !entry.title) return entry
      // foobar2000 stores artist and title separately, but a hand-made playlist
      // may only carry a combined title.
      const index = entry.title.indexOf(' - ')
      if (index <= 0) return entry
      return {
        ...entry,
        artist: entry.title.slice(0, index).trim(),
        title: entry.title.slice(index + 3).trim()
      }
    })

    const unplayable = entries.filter((entry) => !entry.path).length
    if (unplayable > 0) warnings.push(`有 ${unplayable} 条记录没有文件路径，已跳过`)
    return { entries: entries.filter((entry) => entry.path), warnings }
  } catch (error) {
    if (!(error instanceof StructuralError)) throw error
    warnings.push(`结构化解析失败（${error.message}），改用路径扫描恢复`)
  }

  const recovered = recoverPaths(source)
  if (recovered.length === 0) {
    warnings.push(
      '未能从该 FPL 中恢复出任何音频路径。请在 foobar2000 中改用「文件 → 保存歌单为…」导出为 m3u8 后重试。'
    )
    return { entries: [], warnings }
  }

  warnings.push(`已按文件顺序恢复 ${recovered.length} 条路径；标题与时长将取自文件名。`)
  return {
    entries: toEntries(recovered.map((path, index) => ({ index, path }))),
    warnings
  }
}

export const __internal = { parseStructural, recoverPaths, FPL_MAGIC, StructuralError }
