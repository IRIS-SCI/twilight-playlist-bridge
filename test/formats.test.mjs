import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { parseFpl, __internal } from '../lib/fpl.mjs'
import {
  fpliteGuidFromFile,
  nameFromFpliteIndex,
  parseFplite,
  readFpliteIndex
} from '../lib/fplite.mjs'
import { parseAsx, parseWpl, parseXspf, decodeEntities } from '../lib/xmlplaylist.mjs'
import { parsePlaylistText } from '../lib/library.mjs'
import { percentDecodedVariant } from '../lib/paths.mjs'

const FPL_MAGIC = Buffer.from('e1a09c91f83c7742852c3bcc1401d3f2', 'hex')

function u32(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0)
  return buffer
}

/**
 * Builds a real `.fpl` byte stream following the reverse-engineered layout:
 * magic, metadata pool, track count, then per-track records whose string fields
 * are offsets into the pool.
 */
function buildFpl(tracks) {
  const poolParts = []
  const poolOffsets = new Map()
  const addString = (value) => {
    if (poolOffsets.has(value)) return poolOffsets.get(value)
    const offset = poolParts.reduce((total, part) => total + part.length, 0)
    poolParts.push(Buffer.from(`${value}\0`, 'utf8'))
    poolOffsets.set(value, offset)
    return offset
  }

  const records = tracks.map((track) => {
    const primary = (track.meta ?? []).map(([key, value]) => [addString(key), addString(value)])
    const secondary = (track.secondary ?? []).map(([key, value]) => [
      addString(key),
      addString(value)
    ])
    return {
      flags: track.flags ?? 0x01,
      fileNameOffset: addString(track.path),
      duration: track.duration ?? 0,
      primary,
      secondary,
      padding: track.padding === true
    }
  })

  const pool = Buffer.concat(poolParts)
  const chunks = [FPL_MAGIC, u32(pool.length), pool, u32(records.length)]

  for (const record of records) {
    const primaryKeyCount = record.primary.length
    const secondaryKeyCount = record.secondary.length

    // entries = [Kp, Ks, Kso, (kv, nameOff)*Kp, unk0, value*Kp, secondary*2Ks]
    const words = [primaryKeyCount, secondaryKeyCount, 0]
    record.primary.forEach(([nameOffset], index) => words.push(index, nameOffset))
    words.push(0) // unk0
    for (const [, valueOffset] of record.primary) words.push(valueOffset)
    words[2] = primaryKeyCount * 3 + 1 // Kso, in words
    for (const [keyOffset, valueOffset] of record.secondary) words.push(keyOffset, valueOffset)

    const header = Buffer.alloc(56)
    header.writeInt32LE(record.flags, 0)
    header.writeUInt32LE(record.fileNameOffset, 4)
    header.writeUInt32LE(0, 8) // subsong
    if ((record.flags & 0x01) === 0) {
      chunks.push(header.subarray(0, 12))
      continue
    }
    header.writeUInt32LE(1234, 12) // file size
    header.writeDoubleLE(record.duration, 28)
    header.writeUInt32LE(words.length, 52) // keys_dex (entry count)
    chunks.push(header, u32(primaryKeyCount), u32(secondaryKeyCount), u32(words[2]))
    for (const word of words.slice(3)) chunks.push(u32(word))
    if (record.padding) chunks.push(Buffer.alloc(64))
  }

  return Buffer.concat(chunks)
}

test('parseFpl reads a structurally valid v1 playlist', () => {
  const buffer = buildFpl([
    {
      path: 'D:\\Music\\Creep.flac',
      duration: 238.4,
      meta: [
        ['title', 'Creep'],
        ['artist', 'Radiohead'],
        ['album', 'Pablo Honey']
      ]
    },
    { path: 'D:\\Music\\Two.mp3', duration: 100, meta: [['title', 'Two'], ['artist', 'Someone']] }
  ])

  const { entries, warnings } = parseFpl(buffer)
  assert.deepEqual(warnings, [])
  assert.equal(entries.length, 2)

  assert.equal(entries[0].path, 'D:\\Music\\Creep.flac')
  assert.equal(entries[0].title, 'Creep')
  assert.equal(entries[0].artist, 'Radiohead')
  assert.equal(entries[0].album, 'Pablo Honey')
  assert.equal(entries[0].durationSeconds, 238)

  assert.equal(entries[1].title, 'Two')
  assert.equal(entries[1].durationSeconds, 100)
})

test('parseFpl stops at subsong for tracks without metadata', () => {
  // flags bit 0 clear: a stream that was never played. Reading the rest of the
  // record would desynchronize every following track.
  const buffer = buildFpl([
    { path: 'http://stream.example/live', flags: 0x00 },
    { path: 'D:\\Music\\After.flac', duration: 42, meta: [['title', 'After']] }
  ])

  const { entries } = parseFpl(buffer)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].path, 'http://stream.example/live')
  assert.equal(entries[0].remote, true)
  assert.equal(entries[0].durationSeconds, null)
  assert.equal(entries[1].title, 'After')
})

test('parseFpl skips the 64-byte padding block when flags bit 2 is set', () => {
  const buffer = buildFpl([
    { path: 'D:\\Music\\A.flac', flags: 0x01 | 0x04, padding: true, meta: [['title', 'A']] },
    { path: 'D:\\Music\\B.flac', duration: 10, meta: [['title', 'B']] }
  ])

  assert.deepEqual(
    parseFpl(buffer).entries.map((entry) => entry.title),
    ['A', 'B']
  )
})

test('parseFpl reads secondary keys', () => {
  const buffer = buildFpl([
    { path: 'D:\\Music\\S.flac', duration: 5, secondary: [['album', 'Secondary Album']] }
  ])
  assert.equal(parseFpl(buffer).entries[0].album, 'Secondary Album')
})

test('parseFpl falls back to path recovery instead of throwing', () => {
  const junk = Buffer.from('not an fpl file at all', 'utf8')
  const { entries, warnings } = parseFpl(junk)
  assert.equal(entries.length, 0)
  assert.match(warnings.join(' '), /结构化解析失败|m3u8/)
})

test('parseFpl survives a truncated track table', () => {
  const buffer = buildFpl([{ path: 'D:\\Music\\A.flac', duration: 1, meta: [['title', 'A']] }])
  assert.doesNotThrow(() => parseFpl(buffer.subarray(0, buffer.length - 8)))
})

test('parseFplite reads foobar2000 2.x text playlists', () => {
  const text = [
    '\uFEFFfile://E:\\CloudMusic\\Artist - Track.flac',
    'file://E:\\Music\\album.dsf\t1',
    'cdda://E:\\Track01.cda',
    '',
    '# a comment'
  ].join('\n')

  const { entries, warnings } = parseFplite(new TextEncoder().encode(text))
  assert.equal(entries.length, 2)
  assert.equal(entries[0].path, 'file://E:\\CloudMusic\\Artist - Track.flac')
  // The subsong suffix must be stripped from the location.
  assert.equal(entries[1].path, 'file://E:\\Music\\album.dsf')
  assert.match(warnings.join(' '), /cdda/)
})

test('fplite names come from the sibling index.txt', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fplite-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const guid = '7F9B1053-2F5A72E841C2'
  await fs.writeFile(
    path.join(root, 'index.txt'),
    `\uFEFF${guid}:默认列表\nOTHER-GUID:Another List\n`,
    'utf8'
  )
  const file = path.join(root, `playlist-${guid}.fplite`)
  await fs.writeFile(file, '\uFEFFfile://E:\\a.flac\n', 'utf8')

  assert.equal(fpliteGuidFromFile(file), guid)
  const names = await readFpliteIndex(root)
  assert.equal(names.get(guid.toLowerCase()), '默认列表')
  assert.equal(nameFromFpliteIndex(file, names), '默认列表')
  assert.equal(nameFromFpliteIndex(path.join(root, 'playlist-UNKNOWN.fplite'), names), null)
})

test('parseXspf reads VLC-style playlists with millisecond durations', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<playlist version="1" xmlns="http://xspf.org/ns/0/">
  <title>My List</title>
  <trackList>
    <track>
      <location>file:///D:/Music/01%20Creep.flac</location>
      <title>Creep</title>
      <creator>Radiohead</creator>
      <album>Pablo Honey</album>
      <duration>238400</duration>
    </track>
    <track>
      <location>D:\\Music\\Two.mp3</location>
      <title>Someone - Two</title>
    </track>
    <track><title>no location</title></track>
  </trackList>
</playlist>`

  const { entries, warnings } = parseXspf(xml)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].path, 'file:///D:/Music/01%20Creep.flac')
  assert.equal(entries[0].artist, 'Radiohead')
  assert.equal(entries[0].title, 'Creep')
  assert.equal(entries[0].album, 'Pablo Honey')
  assert.equal(entries[0].durationSeconds, 238)
  // No <creator>, so the combined title is split instead.
  assert.equal(entries[1].artist, 'Someone')
  assert.equal(entries[1].title, 'Two')
  assert.equal(warnings.length, 1)
})

test('parseXspf is not confused by <trackList> looking like <track>', () => {
  const xml = '<playlist><trackList><track><location>a.flac</location></track></trackList></playlist>'
  assert.equal(parseXspf(xml).entries.length, 1)
})

test('parseXspf decodes entities and CDATA', () => {
  const xml = `<trackList><track>
    <location><![CDATA[D:\\Music & Stuff\\a.flac]]></location>
    <title>Rock &amp; Roll &#65;</title>
  </track></trackList>`
  const { entries } = parseXspf(xml)
  assert.equal(entries[0].path, 'D:\\Music & Stuff\\a.flac')
  assert.equal(entries[0].title, 'Rock & Roll A')
})

test('parseWpl reads Windows Media Player playlists', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<smil>
  <head><title>My List</title></head>
  <body>
    <seq>
      <media src="D:\\Music\\a.flac" />
      <media src="D:\\Music\\b &amp; c.mp3"/>
    </seq>
  </body>
</smil>`

  const { entries } = parseWpl(xml)
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ['D:\\Music\\a.flac', 'D:\\Music\\b & c.mp3']
  )
})

test('parseWpl warns when there is nothing to read', () => {
  assert.match(parseWpl('<smil><body><seq/></body></smil>').warnings.join(' '), /WPL/)
})

test('parseAsx reads WMP metafiles', () => {
  const xml = `<asx version="3.0">
    <entry>
      <title>Song</title>
      <author>Someone</author>
      <ref href="D:\\Music\\a.flac" />
    </entry>
    <entry><ref href="https://stream.example/live" /></entry>
  </asx>`

  const { entries } = parseAsx(xml)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].path, 'D:\\Music\\a.flac')
  assert.equal(entries[0].title, 'Song')
  assert.equal(entries[0].artist, 'Someone')
  assert.equal(entries[1].remote, true)
})

test('parseAsx falls back to splitting a combined title when there is no author', () => {
  const xml = '<asx><entry><title>Someone - Song</title><ref href="a.flac"/></entry></asx>'
  const { entries } = parseAsx(xml)
  assert.equal(entries[0].artist, 'Someone')
  assert.equal(entries[0].title, 'Song')
})

test('decodeEntities resolves numeric references and keeps &amp;lt; literal', () => {
  assert.equal(decodeEntities('&amp;lt;'), '&lt;')
  assert.equal(decodeEntities('&#x4E2D;&#25991;'), '中文')
})

test('an HLS manifest is reported instead of being listed as tracks', () => {
  const manifest = ['#EXTM3U', '#EXT-X-TARGETDURATION:10', '#EXTINF:9.0,', 'seg1.ts'].join('\n')
  const parsed = parsePlaylistText(manifest, 'stream.m3u8')
  assert.equal(parsed.entries.length, 0)
  assert.match(parsed.warnings.join(' '), /HLS/)
})

test('parsePlaylistText dispatches on every supported extension', () => {
  assert.equal(parsePlaylistText('a.flac', 'x.m3u8').entries.length, 1)
  assert.equal(parsePlaylistText('[playlist]\nFile1=a.flac', 'x.pls').entries.length, 1)
  assert.equal(parsePlaylistText('<trackList><track><location>a</location></track></trackList>', 'x.xspf').entries.length, 1)
  assert.equal(parsePlaylistText('<smil><media src="a"/></smil>', 'x.wpl').entries.length, 1)
  assert.equal(parsePlaylistText('anything', 'x.txt').entries.length, 0)
})

test('percentDecodedVariant offers the escaped reading as a fallback', () => {
  assert.equal(percentDecodedVariant('D:\\My%20Music\\a.flac'), 'D:\\My Music\\a.flac')
  assert.equal(percentDecodedVariant('D:\\Music\\a.flac'), null)
  assert.equal(percentDecodedVariant('D:\\bad%zz\\a.flac'), null)
})

test('the structural error type stays internal', () => {
  assert.throws(() => __internal.parseStructural(Buffer.from('nope')), __internal.StructuralError)
})
