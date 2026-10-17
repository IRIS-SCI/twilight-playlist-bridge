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
import { createPlaylistLibrary, fileForPlaylistId, playlistIdForFile } from '../lib/library.mjs'
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

function makeLibrary() {
  return createPlaylistLibrary({ logger: silentLogger })
}

/** Scans and returns the materialized track list for the nth playlist. */
async function readPlaylist(library, config, index = 0) {
  const { playlists } = await library.listPlaylists(config)
  assert.ok(playlists[index], `expected at least ${index + 1} playlist(s)`)
  const detail = await library.getPlaylistTracks(playlists[index].id, config)
  return { playlists, detail }
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

test('parseDirectoryList expands environment variables and ~', () => {
  const key = 'PLFILE_TEST_DIR'
  process.env[key] = 'E:\\Expanded'
  try {
    assert.deepEqual(parseDirectoryList(`%${key}%\\playlists`), ['E:\\Expanded\\playlists'])
    assert.deepEqual(parseDirectoryList(`%${key.toLowerCase()}%\\x`), ['E:\\Expanded\\x'])
  } finally {
    delete process.env[key]
  }

  // An unknown variable must stay literal rather than collapsing to an empty
  // path, so a stray `%` in a folder name is not silently swallowed.
  assert.deepEqual(parseDirectoryList('%NO_SUCH_VAR_XYZ%\\a'), ['%NO_SUCH_VAR_XYZ%\\a'])
  assert.deepEqual(parseDirectoryList('~'), [os.homedir()])
})

test('normalizeConfig clamps and defaults every field', () => {
  const config = normalizeConfig({ playlistDirs: 'D:\\a', recursive: 'true', maxPlaylists: 99999 })
  assert.deepEqual(config.playlistDirs, ['D:\\a'])
  assert.equal(config.recursive, true)
  assert.equal(config.maxPlaylists, 2000)
  assert.equal(config.encoding, 'auto')
  assert.deepEqual(normalizeConfig(null), { ...DEFAULT_CONFIG })
})

test('the plugin exposes no playback configuration', () => {
  // The plugin only imports playlists; it never serves audio, so the proxy
  // playback setting must be gone from both the form and the config.
  const form = buildSettingsForm(normalizeConfig({}), '')
  const keys = form.fields.map((field) => field.key)
  assert.ok(!keys.includes('proxyPlayback'))
  assert.ok(!('proxyPlayback' in DEFAULT_CONFIG))
  assert.ok(keys.includes('importNow'))
})

test('buildSettingsForm produces a host-valid settings-form DTO', () => {
  const form = buildSettingsForm(normalizeConfig({ playlistDirs: 'D:\\a' }), 'notice text')
  assert.equal(form.kind, 'settings-form')
  assert.equal(form.submitCommand, 'plfile.settings')
  assert.equal(form.resetCommand, 'plfile.settings')
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

test('a playlist resolves to tracks with paths and metadata', async (t) => {
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
  const library = makeLibrary()
  const { playlists, detail } = await readPlaylist(library, config)

  assert.equal(playlists.length, 1)
  assert.equal(playlists[0].name, '我的歌单')
  assert.equal(playlists[0].trackCount, 3)

  assert.equal(detail.tracks.length, 2)
  assert.equal(detail.tracks[0].title, 'Creep')
  assert.equal(detail.tracks[0].artist, 'Radiohead')
  assert.equal(detail.tracks[0].duration, 238)
  assert.equal(detail.tracks[0].filePath, path.join(music, 'one.flac'))
  assert.equal(detail.missing, 1)
  // Relative entry resolved against the playlist's own directory.
  assert.equal(detail.tracks[1].filePath, path.join(music, 'two.mp3'))
  assert.ok(detail.tracks.every((track) => track.id.startsWith('plfile:')))
})

test('playlists written by different players all parse', async (t) => {
  const root = await makeWorkspace(t)
  const music = path.join(root, 'music')
  const lists = path.join(root, 'lists')
  for (const name of ['a.flac', 'b.mp3', 'c.wav']) {
    await writeFile(path.join(music, name), 'fake')
  }

  await writeFile(
    path.join(lists, 'winamp.m3u8'),
    `#EXTM3U\n#EXTINF:10,A - a\n${path.join(music, 'a.flac')}\n`
  )
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
  const library = makeLibrary()
  const { playlists } = await library.listPlaylists(config)
  assert.equal(playlists.length, 4)

  for (const playlist of playlists) {
    const detail = await library.getPlaylistTracks(playlist.id, config)
    assert.equal(detail.tracks.length, 1, `${playlist.name} should yield one track`)
  }
})

test('a bare-path playlist with no EXTINF still yields real titles', async (t) => {
  const root = await makeWorkspace(t)
  const music = path.join(root, 'Interstellar')
  const lists = path.join(root, 'lists')
  const names = [
    '01. Hans Zimmer - Dreaming of the Crash.flac',
    '02. Hans Zimmer - Cornfield Chase.flac',
    '27. Hans Zimmer - Tick-Tock.flac'
  ]
  for (const name of names) await writeFile(path.join(music, name), 'fake')

  const body = names.map((name) => path.join(music, name)).join('\r\n')
  await writeFile(path.join(lists, '星际穿越OST.m3u8'), `\uFEFF#\r\n${body}\r\n`)

  const config = normalizeConfig({ playlistDirs: lists })
  const library = makeLibrary()
  const { playlists, detail } = await readPlaylist(library, config)

  assert.equal(playlists[0].name, '星际穿越OST')
  assert.deepEqual(
    detail.tracks.map((track) => [track.title, track.artist]),
    [
      ['Dreaming of the Crash', 'Hans Zimmer'],
      ['Cornfield Chase', 'Hans Zimmer'],
      ['Tick-Tock', 'Hans Zimmer']
    ]
  )
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
  const library = makeLibrary()
  const { playlists, detail } = await readPlaylist(library, config)
  assert.equal(playlists[0].name, '默认列表')
  assert.equal(detail.tracks[0].filePath, path.join(music, 'a.flac'))
})

test('skipping missing files can be disabled', async (t) => {
  const root = await makeWorkspace(t)
  const lists = path.join(root, 'lists')
  await writeFile(path.join(lists, 'a.m3u'), 'D:\\nope\\gone.flac')

  const config = normalizeConfig({ playlistDirs: lists, skipMissing: false })
  const library = makeLibrary()
  const { detail } = await readPlaylist(library, config)
  assert.equal(detail.tracks.length, 1)
  assert.equal(detail.tracks[0].filePath, 'D:\\nope\\gone.flac')
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
  const library = makeLibrary()
  const { detail } = await readPlaylist(library, config)
  assert.equal(detail.tracks.length, 2)
  assert.notEqual(detail.tracks[0].id, detail.tracks[1].id)
})

test('moved library roots are repaired through searchRoots', async (t) => {
  const root = await makeWorkspace(t)
  const lists = path.join(root, 'lists')
  const relocated = path.join(root, 'relocated')
  await writeFile(path.join(relocated, 'Album', 'x.flac'), 'fake')
  await writeFile(path.join(lists, 'moved.m3u'), 'D:\\Music\\Album\\x.flac')

  const config = normalizeConfig({ playlistDirs: lists, searchRoots: relocated })
  const library = makeLibrary()
  const { detail } = await readPlaylist(library, config)
  assert.equal(detail.tracks.length, 1)
  assert.equal(detail.tracks[0].filePath, path.join(relocated, 'Album', 'x.flac'))
})

test('percent-encoded file:// entries fall back to the decoded path', async (t) => {
  const root = await makeWorkspace(t)
  const lists = path.join(root, 'lists')
  const music = path.join(root, 'My Music')
  await writeFile(path.join(music, 'a.flac'), 'fake')
  await writeFile(path.join(lists, 'escaped.m3u8'), `file:///${path.join(music, 'a.flac')}\n`)

  const config = normalizeConfig({ playlistDirs: lists })
  const library = makeLibrary()
  const { detail } = await readPlaylist(library, config)
  assert.equal(detail.tracks.length, 1)
  assert.equal(detail.tracks[0].filePath, path.join(music, 'a.flac'))
})

test('reading many playlists keeps working without retaining every track list', async (t) => {
  // The bulk import builds each playlist with `keep: false`; that path must
  // still produce complete results on every read.
  const root = await makeWorkspace(t)
  const music = path.join(root, 'music')
  const lists = path.join(root, 'lists')
  await writeFile(path.join(music, 'a.flac'), 'fake')

  for (let index = 0; index < 20; index++) {
    await writeFile(path.join(lists, `list${index}.m3u`), path.join(music, 'a.flac'))
  }

  const config = normalizeConfig({ playlistDirs: lists })
  const library = makeLibrary()
  const { playlists } = await library.listPlaylists(config)
  assert.equal(playlists.length, 20)

  for (const playlist of playlists) {
    const detail = await library.getPlaylistTracks(playlist.id, config, { keep: false })
    assert.equal(detail.tracks.length, 1)
  }

  const again = await library.getPlaylistTracks(playlists[0].id, config, { keep: false })
  assert.equal(again.tracks.length, 1)
})
