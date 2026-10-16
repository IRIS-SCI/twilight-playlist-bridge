import test from 'node:test'
import assert from 'node:assert/strict'

import { decodePlaylistBuffer, detectDeclaredEncoding } from '../lib/decode.mjs'
import { parseExtInf, parseM3u, splitArtistTitle } from '../lib/m3u.mjs'
import { parsePls } from '../lib/pls.mjs'
import {
  isWindowsPath,
  pathKey,
  playlistNameFromFile,
  relocationCandidates,
  resolveEntryPath
} from '../lib/paths.mjs'

function bytes(text) {
  return new TextEncoder().encode(text)
}

test('decodePlaylistBuffer strips a UTF-8 BOM', () => {
  const buffer = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('#EXTM3U\nD:\\a.flac\n')])
  const result = decodePlaylistBuffer(buffer)
  assert.equal(result.encoding, 'utf-8')
  assert.ok(result.text.startsWith('#EXTM3U'))
})

test('decodePlaylistBuffer reads a UTF-16LE playlist with BOM', () => {
  const text = '#EXTM3U\nD:\\音乐\\一.flac\n'
  const buffer = new Uint8Array([0xff, 0xfe, ...Buffer.from(text, 'utf16le')])
  const result = decodePlaylistBuffer(buffer)
  assert.equal(result.encoding, 'utf-16le')
  assert.match(result.text, /音乐/)
})

test('decodePlaylistBuffer falls back to GB18030 for ANSI Chinese playlists', () => {
  // "中文.flac" encoded as GBK: D6 D0 CE C4 — invalid as strict UTF-8.
  const buffer = new Uint8Array([
    ...Buffer.from('#EXTM3U\nD:\\', 'latin1'),
    0xd6,
    0xd0,
    0xce,
    0xc4,
    ...Buffer.from('.flac\n', 'latin1')
  ])

  const result = decodePlaylistBuffer(buffer)
  assert.equal(result.encoding, 'gb18030')
  assert.match(result.text, /中文\.flac/)
})

test('decodePlaylistBuffer prefers strict UTF-8 over GB18030', () => {
  // gb18030 decodes almost anything, so it must not be tried first.
  const result = decodePlaylistBuffer(bytes('中文 UTF-8 歌单'))
  assert.equal(result.encoding, 'utf-8')
  assert.equal(result.text, '中文 UTF-8 歌单')
})

test('decodePlaylistBuffer honours an explicit encoding preference', () => {
  const buffer = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])
  const result = decodePlaylistBuffer(buffer, 'gb18030')
  assert.equal(result.encoding, 'gb18030')
  assert.equal(result.text, '中文')
})

test('detectDeclaredEncoding reads the XML declaration', () => {
  assert.equal(
    detectDeclaredEncoding(bytes('<?xml version="1.0" encoding="gb2312"?><playlist/>')),
    'gb18030'
  )
  assert.equal(detectDeclaredEncoding(bytes('<?xml version="1.0" encoding="UTF-8"?>')), 'utf-8')
  assert.equal(detectDeclaredEncoding(bytes('no declaration here')), null)
})

test('parseExtInf reads duration and title, tolerating -1 and attributes', () => {
  assert.deepEqual(parseExtInf('#EXTINF:180,Artist - Title'), {
    durationSeconds: 180,
    rawTitle: 'Artist - Title'
  })
  assert.deepEqual(parseExtInf('#EXTINF:-1,Live Stream'), {
    durationSeconds: null,
    rawTitle: 'Live Stream'
  })
  assert.deepEqual(parseExtInf('#EXTINF:12.7 tvg-id="x",Chan'), {
    durationSeconds: 13,
    rawTitle: 'Chan'
  })
})

test('splitArtistTitle only splits on a real separator', () => {
  assert.deepEqual(splitArtistTitle('Radiohead - Creep'), { artist: 'Radiohead', title: 'Creep' })
  assert.deepEqual(splitArtistTitle('Creep'), { artist: '', title: 'Creep' })
  assert.deepEqual(splitArtistTitle(' - leading'), { artist: '', title: '- leading' })
})

test('parseM3u reads foobar2000/Winamp tags and keeps commas in titles', () => {
  const text = [
    '#EXTM3U',
    '#EXTART:Radiohead',
    '#EXTALB:Pablo Honey',
    '#EXTINF:238,Radiohead - Creep',
    'D:\\Music\\Pablo Honey\\01 Creep.flac',
    '',
    '# a comment',
    '#EXTINF:-1,Some Radio',
    'https://stream.example/live'
  ].join('\r\n')

  const { entries } = parseM3u(text)
  assert.equal(entries.length, 2)

  assert.equal(entries[0].path, 'D:\\Music\\Pablo Honey\\01 Creep.flac')
  assert.equal(entries[0].artist, 'Radiohead')
  assert.equal(entries[0].title, 'Creep')
  assert.equal(entries[0].album, 'Pablo Honey')
  assert.equal(entries[0].durationSeconds, 238)
  assert.equal(entries[0].remote, false)

  assert.equal(entries[1].remote, true)
  assert.equal(entries[1].title, 'Some Radio')
})

test('parseM3u splits EXTINF on the first comma only', () => {
  // A real title with a comma must not be truncated at it.
  const { entries } = parseM3u('#EXTINF:100,Artist - Walking Alone, in Trinity\nD:\\a.flac')
  assert.equal(entries[0].artist, 'Artist')
  assert.equal(entries[0].title, 'Walking Alone, in Trinity')
  assert.equal(entries[0].durationSeconds, 100)
})

test('parseM3u strips quotes some exporters add around paths', () => {
  const { entries } = parseM3u('#EXTINF:1,X\n"D:\\Music\\a.flac"')
  assert.equal(entries[0].path, 'D:\\Music\\a.flac')
})

test('parseM3u keeps the whole title when splitting is disabled', () => {
  const { entries } = parseM3u('#EXTINF:10,A - B\nD:\\x.flac', { splitArtistTitle: false })
  assert.equal(entries[0].title, 'A - B')
  assert.equal(entries[0].artist, '')
})

test('parseM3u does not carry EXTINF metadata past its own path', () => {
  const { entries } = parseM3u('#EXTINF:5,One\nD:\\a.flac\nD:\\b.flac')
  assert.equal(entries[0].title, 'One')
  assert.equal(entries[1].title, '')
  assert.equal(entries[1].durationSeconds, null)
})

test('parsePls reads entries in numeric order and skips ones without FileN', () => {
  const text = [
    '[playlist]',
    'File2=D:\\b.flac',
    'Title2=B - Two',
    'Length2=200',
    'File1=D:\\a.flac',
    'Title1=A - One',
    'Length1=100',
    'Title3=orphan',
    'NumberOfEntries=3',
    'Version=2'
  ].join('\n')

  const { entries, warnings } = parsePls(text)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].path, 'D:\\a.flac')
  assert.equal(entries[0].artist, 'A')
  assert.equal(entries[0].title, 'One')
  assert.equal(entries[0].durationSeconds, 100)
  assert.equal(entries[1].path, 'D:\\b.flac')
  assert.equal(warnings.length, 1)
})

test('parsePls tolerates a leading NumberOfEntries footer', () => {
  const text = ['[playlist]', 'NumberOfEntries=2', 'Version=2', 'File1=a.flac', 'File2=b.flac'].join(
    '\n'
  )
  const { entries } = parsePls(text)
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ['a.flac', 'b.flac']
  )
})

test('resolveEntryPath handles every path flavour', () => {
  assert.equal(resolveEntryPath('D:\\Music\\a.flac', 'C:\\lists'), 'D:\\Music\\a.flac')
  assert.equal(resolveEntryPath('D:/Music/a.flac', 'C:\\lists'), 'D:\\Music\\a.flac')
  assert.equal(resolveEntryPath('sub\\a.flac', 'D:\\lists'), 'D:\\lists\\sub\\a.flac')
  assert.equal(resolveEntryPath('sub/a.flac', 'D:\\lists'), 'D:\\lists\\sub\\a.flac')
  assert.equal(resolveEntryPath('../up.flac', 'D:\\lists\\deep'), 'D:\\lists\\up.flac')
  assert.equal(resolveEntryPath('/mnt/music/a.flac', '/home/me'), '/mnt/music/a.flac')
  assert.equal(resolveEntryPath('rel/a.flac', '/home/me'), '/home/me/rel/a.flac')
  assert.equal(resolveEntryPath('', 'D:\\lists'), null)
})

test('fb2k-style file:// URIs with backslashes resolve without URL escaping', () => {
  // fileURLToPath rejects these; the scheme must be stripped by hand.
  assert.equal(
    resolveEntryPath('file://E:\\CloudMusic\\战双帕弥什.flac', 'C:\\lists'),
    'E:\\CloudMusic\\战双帕弥什.flac'
  )
  assert.equal(resolveEntryPath('file:///D:/Music/a.flac', 'C:\\lists'), 'D:\\Music\\a.flac')
  assert.equal(resolveEntryPath('file:///home/me/a.flac', '/tmp'), '/home/me/a.flac')
  assert.equal(
    resolveEntryPath('file://\\\\server\\share\\a.flac', 'C:\\lists'),
    '\\\\server\\share\\a.flac'
  )
})

test('isWindowsPath distinguishes drive and UNC paths', () => {
  assert.equal(isWindowsPath('D:\\a'), true)
  assert.equal(isWindowsPath('\\\\server\\share'), true)
  assert.equal(isWindowsPath('/mnt/a'), false)
})

test('relocationCandidates re-attaches a moved library tail', () => {
  const candidates = relocationCandidates('D:\\Music\\Album\\x.flac', ['E:\\Music'])
  assert.ok(candidates.includes('E:\\Music\\Music\\Album\\x.flac'))
  assert.ok(candidates.includes('E:\\Music\\Album\\x.flac'))
  assert.deepEqual(relocationCandidates('/mnt/x.flac', ['E:\\Music']), [])
})

test('pathKey and playlistNameFromFile behave', () => {
  assert.equal(pathKey('D:/Music/A.FLAC'), 'd:\\music\\a.flac')
  assert.equal(playlistNameFromFile('D:\\lists\\My List.m3u8'), 'My List')
})
