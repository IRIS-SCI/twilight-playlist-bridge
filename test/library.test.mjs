import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  buildSettingsForm,
  configFromForm,
  DEFAULT_CONFIG,
  normalizeConfig,
  parseDirectoryList
} from '../lib/config.mjs'
import { createPlaylistFileProvider } from '../lib/provider.mjs'
import { fileForPlaylistId, playlistIdForFile } from '../lib/library.mjs'
import { contentTypeFor, parseRangeHeader } from '../lib/proxy.mjs'
import { extensionOf, normalizeExtensions, scanPlaylistFiles } from '../lib/scan.mjs'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

async function makeWorkspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plfile-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

async function writeFile(target, contents) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, contents)
}

function makeProvider(config, t) {
  const provider = createPlaylistFileProvider({ getConfig: () => config, logger: silentLogger })
  t.after(() => provider.proxy.stop())
  return provider
}

test('normalizeExtensions strips dots and de-duplicates', () => {
  assert.deepEqual(normalizeExtensions(['.m3u8', 'M3U', 'm3u8', '*.fpl']), ['m3u8', 'm3u', 'fpl'])
  assert.ok(normalizeExtensions([]).includes('xspf'))
  assert.ok(normalizeExtensions([]).includes('fplite'))
})

test('extensionOf handles dotless and multi-dot names', () => {
  assert.equal(extensionOf('a.b.m3u8'), 'm3u8')
  assert.equal(extensionOf('noext'), '')
  assert.equal(extensionOf('D:\\x\\y.FPL'), 'fpl')
})

test('parseDirectoryList accepts semicolons, pipes and newlines but keeps drive colons', () => {
  assert.deepEqual(parseDirectoryList('D:\\A; E:\\B'), ['D:\\A', 'E:\\B'])
  assert.deepEqual(parseDirectoryList('D:\\A|E:\\B\nF:\\C'), ['D:\\A', 'E:\\B', 'F:\\C'])
  assert.deepEqual(parseDirectoryList('"D:\\with space"'), ['D:\\with space'])
  assert.deepEqual(parseDirectoryList(''), [])
})

test('normalizeConfig clamps and defaults every field', () => {
  const config = normalizeConfig({ playlistDirs: 'D:\\a', recursive: 'true', maxPlaylists: 99999 })
  assert.deepEqual(config.playlistDirs, ['D:\\a'])
  assert.equal(config.recursive, true)
  assert.equal(config.maxPlaylists, 2000)
  assert.equal(config.encoding, 'auto')
  assert.deepEqual(normalizeConfig(null), { ...DEFAULT_CONFIG })
})

test('buildSettingsForm produces a host-valid settings-form DTO', () => {
  const form = buildSettingsForm(normalizeConfig({ playlistDirs: 'D:\\a' }), 'notice text')
  assert.equal(form.kind, 'settings-form')
  assert.equal(form.submitCommand, 'plfile.settings.save')
  assert.equal(form.resetCommand, 'plfile.settings.reset')
  assert.ok(form.fields.length <= 40)
  for (const field of form.fields) {
    assert.match(field.key, /^[A-Za-z0-9_.:-]{1,80}$/)
    assert.ok(field.label.length <= 100)
    assert.ok(!field.description || field.description.length <= 200)
  }
  assert.ok(form.notice.length <= 500)
  const dirs = form.fields.find((field) => field.key === 'playlistDirs')
  assert.equal(dirs.value, 'D:\\a')
})

test('configFromForm parses the string values the host submits', () => {
  const config = configFromForm({
    playlistDirs: 'D:\\lists; E:\\more',
    recursive: 'true',
    extensions: 'm3u8; fpl',
    encoding: 'gb18030',
    skipMissing: 'false'
  })
  assert.deepEqual(config.playlistDirs, ['D:\\lists', 'E:\\more'])
  assert.equal(config.recursive, true)
  assert.deepEqual(config.extensions, ['m3u8', 'fpl'])
  assert.equal(config.encoding, 'gb18030')
  assert.equal(config.skipMissing, false)
})

test('playlistIdForFile round-trips non-ASCII paths', () => {
  const file = 'D:\\音乐\\我的歌单.m3u8'
  const id = playlistIdForFile(file)
  assert.ok(id.startsWith('plfile:'))
  assert.equal(fileForPlaylistId(id), file)
  assert.equal(fileForPlaylistId('ncm:123'), null)
})

test('scanPlaylistFiles respects recursion, extensions and missing roots', async (t) => {
  const root = await makeWorkspace(t)
  await writeFile(path.join(root, 'top.m3u8'), 'x')
  await writeFile(path.join(root, 'notes.txt'), 'x')
  await writeFile(path.join(root, 'vlc.xspf'), 'x')
  await writeFile(path.join(root, 'sub', 'deep.m3u'), 'x')
  await writeFile(path.join(root, 'node_modules', 'ignored.m3u8'), 'x')

  const flat = await scanPlaylistFiles([root], { extensions: ['m3u8', 'xspf'] })
  assert.deepEqual(
    flat.files.map((file) => path.basename(file)),
    ['top.m3u8', 'vlc.xspf']
  )

  const recursive = await scanPlaylistFiles([root], { extensions: ['m3u8', 'm3u'], recursive: true })
  assert.deepEqual(
    recursive.files.map((file) => path.basename(file)).sort(),
    ['deep.m3u', 'top.m3u8']
  )

  const missing = await scanPlaylistFiles([path.join(root, 'nope')])
  assert.equal(missing.files.length, 0)
  assert.equal(missing.warnings.length, 1)
})

test('provider exposes playlists and resolves tracks end to end', async (t) => {
  const root = await makeWorkspace(t)
  const music = path.join(root, 'music')
  const lists = path.join(root, 'lists')

  await writeFile(path.join(music, 'one.flac'), 'fake')
  await writeFile(path.join(music, 'two.mp3'), 'fake')
  await writeFile(
    path.join(lists, '我的歌单.m3u8'),
    [
      '#EXTM3U',
      '#EXTINF:238,Radiohead - Creep',
      path.join(music, 'one.flac'),
      '#EXTINF:200,Nobody - Gone',
      path.join(music, 'missing.flac'),
      '#EXTINF:100,Relative - Song',
      path.join('..', 'music', 'two.mp3')
    ].join('\r\n')
  )

  const config = normalizeConfig({ playlistDirs: lists, skipMissing: true })
  const provider = makeProvider(config, t)
  const registration = provider.providerRegistration()

  const library = await registration.fetchUserLibrary()
  assert.equal(library.playlists.length, 1)
  assert.equal(library.playlists[0].name, '我的歌单')
  assert.equal(library.playlists[0].trackCount, 3)

  const tracks = await registration.fetchPlaylistTracks(library.playlists[0].id)
  assert.equal(tracks.length, 2)
  assert.equal(tracks[0].title, 'Creep')
  assert.equal(tracks[0].artist, 'Radiohead')
  assert.equal(tracks[0].duration, 238)
  assert.equal(tracks[0].filePath, path.join(music, 'one.flac'))
  assert.equal(tracks[0].source, 'plfile')
  // Relative entry resolved against the playlist's own directory.
  assert.equal(tracks[1].filePath, path.join(music, 'two.mp3'))
  // Provider track ids must carry the provider prefix.
  assert.ok(tracks.every((track) => track.id.startsWith('plfile:')))
  assert.equal(new Set(tracks.map((track) => track.id)).size, tracks.length)
})

test('playlists from different players all load', async (t) => {
  const root = await makeWorkspace(t)
  const music = path.join(root, 'music')
  const lists = path.join(root, 'lists')
  for (const name of ['a.flac', 'b.mp3', 'c.wav']) {
    await writeFile(path.join(music, name), 'fake')
  }

  await writeFile(path.join(lists, 'winamp.m3u8'), `#EXTM3U\n#EXTINF:10,A - a\n${path.join(music, 'a.flac')}\n`)
  await writeFile(
    path.join(lists, 'vlc.xspf'),
    `<trackList><track><location>${path.join(music, 'b.mp3')}</location><title>B</title></track></trackList>`
  )
  await writeFile(
    path.join(lists, 'wmp.wpl'),
    `<smil><body><seq><media src="${path.join(music, 'c.wav')}" /></seq></body></smil>`
  )
  await writeFile(path.join(lists, 'shoutcast.pls'), `[playlist]\nFile1=${path.join(music, 'a.flac')}\n`)

  const config = normalizeConfig({ playlistDirs: lists })
  const provider = makeProvider(config, t)
  const registration = provider.providerRegistration()

  const { playlists } = await registration.fetchUserLibrary()
  assert.equal(playlists.length, 4)

  for (const playlist of playlists) {
    const tracks = await registration.fetchPlaylistTracks(playlist.id)
    assert.equal(tracks.length, 1, `${playlist.name} should yield one track`)
  }
})

test('fplite playlists borrow their names from index.txt', async (t) => {
  const root = await makeWorkspace(t)
  const lists = path.join(root, 'lists')
  const music = path.join(root, 'music')
  await writeFile(path.join(music, 'a.flac'), 'fake')

  const guid = '7F9B1053-2F5A72E841C2'
  await writeFile(path.join(lists, 'index.txt'), `\uFEFF${guid}:默认列表\n`)
  await writeFile(
    path.join(lists, `playlist-${guid}.fplite`),
    `\uFEFFfile://${path.join(music, 'a.flac')}\n`
  )

  const config = normalizeConfig({ playlistDirs: lists })
  const provider = makeProvider(config, t)
  const registration = provider.providerRegistration()

  const { playlists } = await registration.fetchUserLibrary()
  assert.equal(playlists.length, 1)
  assert.equal(playlists[0].name, '默认列表')

  const tracks = await registration.fetchPlaylistTracks(playlists[0].id)
  assert.equal(tracks.length, 1)
  assert.equal(tracks[0].filePath, path.join(music, 'a.flac'))
})

test('skipping missing files can be disabled', async (t) => {
  const root = await makeWorkspace(t)
  const lists = path.join(root, 'lists')
  await writeFile(path.join(lists, 'a.m3u'), 'D:\\nope\\gone.flac')

  const config = normalizeConfig({ playlistDirs: lists, skipMissing: false })
  const provider = makeProvider(config, t)
  const registration = provider.providerRegistration()

  const { playlists } = await registration.fetchUserLibrary()
  const tracks = await registration.fetchPlaylistTracks(playlists[0].id)
  assert.equal(tracks.length, 1)
  assert.equal(tracks[0].filePath, 'D:\\nope\\gone.flac')
})

test('duplicate songs in one playlist get distinct ids', async (t) => {
  const root = await makeWorkspace(t)
  const music = path.join(root, 'music')
  const lists = path.join(root, 'lists')
  await writeFile(path.join(music, 'same.flac'), 'fake')
  await writeFile(
    path.join(lists, 'dupes.m3u'),
    [path.join(music, 'same.flac'), path.join(music, 'same.flac')].join('\n')
  )

  const config = normalizeConfig({ playlistDirs: lists })
  const provider = makeProvider(config, t)
  const registration = provider.providerRegistration()

  const { playlists } = await registration.fetchUserLibrary()
  const tracks = await registration.fetchPlaylistTracks(playlists[0].id)
  assert.equal(tracks.length, 2)
  assert.notEqual(tracks[0].id, tracks[1].id)
})

test('moved library roots are repaired through searchRoots', async (t) => {
  const root = await makeWorkspace(t)
  const lists = path.join(root, 'lists')
  const relocated = path.join(root, 'relocated')
  await writeFile(path.join(relocated, 'Album', 'x.flac'), 'fake')
  await writeFile(path.join(lists, 'moved.m3u'), 'D:\\Music\\Album\\x.flac')

  const config = normalizeConfig({ playlistDirs: lists, searchRoots: relocated })
  const provider = makeProvider(config, t)
  const registration = provider.providerRegistration()

  const { playlists } = await registration.fetchUserLibrary()
  const tracks = await registration.fetchPlaylistTracks(playlists[0].id)
  assert.equal(tracks.length, 1)
  assert.equal(tracks[0].filePath, path.join(relocated, 'Album', 'x.flac'))
})

test('percent-encoded file:// entries fall back to the decoded path', async (t) => {
  const root = await makeWorkspace(t)
  const lists = path.join(root, 'lists')
  const music = path.join(root, 'My Music')
  await writeFile(path.join(music, 'a.flac'), 'fake')
  await writeFile(path.join(lists, 'escaped.m3u8'), `file:///${path.join(music, 'a.flac')}\n`)

  const config = normalizeConfig({ playlistDirs: lists })
  const provider = makeProvider(config, t)
  const registration = provider.providerRegistration()

  const { playlists } = await registration.fetchUserLibrary()
  const tracks = await registration.fetchPlaylistTracks(playlists[0].id)
  assert.equal(tracks.length, 1)
  assert.equal(tracks[0].filePath, path.join(music, 'a.flac'))
})

test('getPlaybackUrl returns the plain path by default and passes streams through', async (t) => {
  const root = await makeWorkspace(t)
  const lists = path.join(root, 'lists')
  const music = path.join(root, 'music')
  await writeFile(path.join(music, 'a.flac'), 'fake')
  await writeFile(
    path.join(lists, 'mix.m3u'),
    [path.join(music, 'a.flac'), 'https://stream.example/live'].join('\n')
  )

  const config = normalizeConfig({ playlistDirs: lists })
  const provider = makeProvider(config, t)
  const registration = provider.providerRegistration()

  const { playlists } = await registration.fetchUserLibrary()
  const tracks = await registration.fetchPlaylistTracks(playlists[0].id)

  assert.equal(await registration.getPlaybackUrl(tracks[0]), path.join(music, 'a.flac'))
  assert.equal(await registration.getPlaybackUrl(tracks[1]), 'https://stream.example/live')
  assert.equal(provider.proxy.isRunning(), false)
})

test('proxy playback serves bytes with Range support', async (t) => {
  const root = await makeWorkspace(t)
  const lists = path.join(root, 'lists')
  const music = path.join(root, 'music')
  const payload = 'abcdefghij'
  await writeFile(path.join(music, 'a.flac'), payload)
  await writeFile(path.join(lists, 'a.m3u'), path.join(music, 'a.flac'))

  const config = normalizeConfig({ playlistDirs: lists, proxyPlayback: true })
  const provider = makeProvider(config, t)
  const registration = provider.providerRegistration()

  const { playlists } = await registration.fetchUserLibrary()
  const tracks = await registration.fetchPlaylistTracks(playlists[0].id)
  const url = await registration.getPlaybackUrl(tracks[0])

  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/audio\/[0-9a-f]{36}$/)
  // A path must never appear in the URL.
  assert.equal(url.includes('music'), false)
  assert.equal(provider.proxy.isRunning(), true)

  const full = await fetch(url)
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('accept-ranges'), 'bytes')
  assert.equal(await full.text(), payload)

  const ranged = await fetch(url, { headers: { Range: 'bytes=2-4' } })
  assert.equal(ranged.status, 206)
  assert.equal(ranged.headers.get('content-range'), 'bytes 2-4/10')
  assert.equal(await ranged.text(), 'cde')

  // Repeated resolution must reuse the same token rather than leaking new ones.
  assert.equal(await registration.getPlaybackUrl(tracks[0]), url)
})

test('proxy refuses unknown tokens and non-GET methods', async (t) => {
  const root = await makeWorkspace(t)
  const lists = path.join(root, 'lists')
  const music = path.join(root, 'music')
  await writeFile(path.join(music, 'a.flac'), 'fake')
  await writeFile(path.join(lists, 'a.m3u'), path.join(music, 'a.flac'))

  const config = normalizeConfig({ playlistDirs: lists, proxyPlayback: true })
  const provider = makeProvider(config, t)
  const registration = provider.providerRegistration()
  const { playlists } = await registration.fetchUserLibrary()
  const tracks = await registration.fetchPlaylistTracks(playlists[0].id)
  const url = await registration.getPlaybackUrl(tracks[0])
  const origin = new URL(url).origin

  assert.equal((await fetch(`${origin}/audio/deadbeef`)).status, 404)
  assert.equal((await fetch(`${origin}/`)).status, 404)
  assert.equal((await fetch(url, { method: 'POST' })).status, 405)
})

test('parseRangeHeader rejects malformed ranges', () => {
  assert.deepEqual(parseRangeHeader('bytes=0-4', 10), { start: 0, end: 4 })
  assert.deepEqual(parseRangeHeader('bytes=5-', 10), { start: 5, end: 9 })
  assert.deepEqual(parseRangeHeader('bytes=-3', 10), { start: 7, end: 9 })
  assert.deepEqual(parseRangeHeader('bytes=0-99', 10), { start: 0, end: 9 })
  assert.equal(parseRangeHeader('bytes=99-100', 10), null)
  assert.equal(parseRangeHeader('bytes=5-2', 10), null)
  assert.equal(parseRangeHeader('items=0-4', 10), null)
  assert.equal(parseRangeHeader(undefined, 10), null)
})

test('contentTypeFor maps the formats a music library actually holds', () => {
  assert.equal(contentTypeFor('a.flac'), 'audio/flac')
  assert.equal(contentTypeFor('a.FLAC'), 'audio/flac')
  assert.equal(contentTypeFor('a.dsf'), 'audio/x-dsf')
  assert.equal(contentTypeFor('a.unknown'), 'application/octet-stream')
})
