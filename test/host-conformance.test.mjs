/**
 * Conformance test against the real Twilight Echo host code.
 *
 * Instead of re-implementing the host's rules, this loads the host's own
 * validators from a Twilight Echo checkout and runs the plugin's real
 * `activate()` against them:
 *
 *   - `validatePluginManifest`      (src/main/plugins/manifest.ts)
 *   - `isCompatibleTwilightRange`   (src/main/plugins/versionRange.ts)
 *   - `normalizeUiContribution`     (src/main/plugins/themeContribution.ts)
 *   - `normalizePluginSettingsForm` (src/renderer/.../pluginSettingsForm.ts)
 *
 * The checkout is located via `TWILIGHT_ECHO_SRC`, or as a sibling/parent of
 * this plugin. When no checkout is present the suite is skipped rather than
 * failed, so the plugin's own unit tests still run standalone.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function isHostCheckout(candidate) {
  try {
    await fs.access(path.join(candidate, 'src', 'main', 'plugins', 'manifest.ts'))
    return true
  } catch {
    return false
  }
}

async function findHostSource() {
  const candidates = [
    process.env.TWILIGHT_ECHO_SRC,
    path.resolve(pluginRoot, '..'),
    path.resolve(pluginRoot, '..', 'Twilight_Echo'),
    path.resolve(pluginRoot, '..', '..', 'Twilight_Echo')
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (await isHostCheckout(candidate)) return candidate
  }
  return null
}

const hostSource = await findHostSource()
const skip = hostSource ? false : 'no Twilight Echo checkout found (set TWILIGHT_ECHO_SRC)'

async function loadHostModule(relativePath) {
  return await import(pathToFileURL(path.join(hostSource, relativePath)).href)
}

function createFakeContext(storagePath, storedSettings = {}) {
  const commands = new Map()
  const contributions = []
  const notifications = []
  const providers = []

  const context = {
    apiVersion: 3,
    storagePath,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    settings: {
      async get(key) {
        return storedSettings[key]
      },
      async set() {},
      async delete() {}
    },
    twilight: {
      events: { on: () => () => {} },
      player: {},
      providers: {
        async register(provider) {
          providers.push(provider)
        }
      },
      ui: {
        async register(contribution) {
          contributions.push(contribution)
        },
        onCommand(command, handler) {
          commands.set(command, handler)
          return () => commands.delete(command)
        },
        async notify(notice) {
          notifications.push(notice)
        }
      },
      themes: {}
    }
  }

  return { context, commands, contributions, notifications, providers }
}

async function withPlugin(run, storedSettings = {}) {
  const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'plfile-conformance-'))
  const harness = createFakeContext(storagePath, storedSettings)
  const plugin = await import(pathToFileURL(path.join(pluginRoot, 'index.mjs')).href)
  try {
    await plugin.activate(harness.context)
    await run(harness)
  } finally {
    await plugin.deactivate()
    await fs.rm(storagePath, { recursive: true, force: true })
  }
}

test('manifest and engines range are accepted by the host', { skip }, async () => {
  const { validatePluginManifest, isCompatibleTwilightRange } = await loadHostModule(
    'src/main/plugins/manifest.ts'
  )
  const raw = JSON.parse(await fs.readFile(path.join(pluginRoot, 'plugin.json'), 'utf-8'))
  const manifest = validatePluginManifest(raw)
  assert.equal(manifest.id, raw.id)

  const appVersion = JSON.parse(await fs.readFile(path.join(hostSource, 'package.json'), 'utf-8'))
    .version
  assert.equal(
    isCompatibleTwilightRange(manifest.engines.twilightEcho, appVersion),
    true,
    `host ${appVersion} must satisfy ${manifest.engines.twilightEcho}`
  )
})

test('activate registers a host-valid UI contribution and settings form', { skip }, async () => {
  const { normalizeUiContribution } = await loadHostModule('src/main/plugins/themeContribution.ts')
  const { normalizePluginSettingsForm } = await loadHostModule(
    'src/renderer/src/components/settings-page/pluginSettingsForm.ts'
  )
  const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, 'plugin.json'), 'utf-8'))

  await withPlugin(async (harness) => {
    assert.equal(harness.contributions.length, 1)
    const contribution = normalizeUiContribution(
      manifest.type,
      manifest.permissions,
      harness.contributions[0]
    )
    assert.equal(contribution.kind, 'settingsPanel')
    assert.equal(contribution.autoLoad, true)
    assert.ok(contribution.command)

    // The command the contribution points at must actually be registered, or the
    // host would fail the panel with "UI command 未注册".
    const handler = harness.commands.get(contribution.command)
    assert.equal(typeof handler, 'function')

    const signal = new AbortController().signal
    const result = await handler({ source: 'settingsPanel', panelId: contribution.id }, { signal })
    const form = normalizePluginSettingsForm(result)
    assert.ok(form, 'host must accept the settings-form DTO')

    // The host routes a command only if some registered contribution declares
    // it (manager.ts:720). Anything the renderer can invoke must therefore be
    // the command of a contribution — this is the check that the real
    // "UI command 未注册: plfile.settings.save" failure was missing.
    const routable = new Set(
      harness.contributions.map((entry) => entry.command).filter(Boolean)
    )
    for (const command of [contribution.command, form.submitCommand, form.resetCommand]) {
      assert.ok(
        routable.has(command),
        `host cannot route "${command}": no UI contribution declares it`
      )
      assert.ok(harness.commands.has(command), `no handler registered for "${command}"`)
    }

    // Submitting must stay well inside the host's 5 s command budget.
    const started = Date.now()
    const saved = await harness.commands.get(form.submitCommand)(
      { playlistDirs: 'D:\\Music\\playlists', recursive: 'false' },
      { signal }
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2000, `settings save took ${elapsed}ms`)
    assert.equal(typeof saved.message, 'string')
    assert.ok(normalizePluginSettingsForm(saved.form))

    // Reset arrives with no payload at all.
    const reset = await harness.commands.get(form.resetCommand)({ signal })
    assert.equal(reset.message, '已恢复默认设置')
    assert.ok(normalizePluginSettingsForm(reset.form))
  })
})

test('a fresh install announces where to configure it', { skip }, async () => {
  // Without this the plugin looks inert after install: the provider stays
  // invisible until a folder is set, and the panel is buried in the settings.
  await withPlugin(async (harness) => {
    assert.equal(harness.notifications.length, 1)
    const notice = harness.notifications[0]
    assert.match(notice.message, /插件设置/)
    assert.match(notice.message, /我的音乐库/)
    assert.ok(notice.durationMs >= 2500 && notice.durationMs <= 30000)
  })
})

test('a successful scan tells the user where the playlists appear', { skip }, async () => {
  // The playlists land under a sidebar group that is collapsed by default, so
  // the location hint is the only thing that makes them findable.
  const listsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plfile-lists-'))
  try {
    await fs.writeFile(path.join(listsDir, '星际穿越OST.m3u8'), '#\nD:\\Music\\a.flac\n')

    await withPlugin(
      async (harness) => {
        // The initial scan is deliberately deferred so activation stays inside
        // the host's 5 s budget; wait for it to land.
        await new Promise((resolve) => setTimeout(resolve, 600))
        const located = harness.notifications.find((notice) =>
          notice.message.includes('我的音乐库')
        )
        assert.ok(located, `expected a location hint, got ${JSON.stringify(harness.notifications)}`)
        assert.match(located.message, /已索引 1 个歌单文件/)
        assert.match(located.message, /流媒体音乐/)
        assert.match(located.message, /我的音乐库/)
      },
      { config: { playlistDirs: [listsDir], extensions: ['m3u8'] } }
    )
  } finally {
    await fs.rm(listsDir, { recursive: true, force: true })
  }
})

test('the registered provider satisfies the host library/playlist contract', { skip }, async () => {
  await withPlugin(async (harness) => {
    assert.equal(harness.providers.length, 1)
    const provider = harness.providers[0]

    assert.equal(provider.id, 'plfile')
    // `library` is what puts the provider in the 音乐库 source switcher, and the
    // host only allows it when the manifest declares library:read.
    assert.ok(provider.capabilities.includes('library'))
    assert.ok(provider.capabilities.includes('playlist'))
    assert.ok(provider.capabilities.includes('playbackUrl'))

    // `login` looks wrong for a plugin that never logs in, but it is load
    // bearing: the host gates its external-provider state refresh on this
    // capability (StreamingPage.vue:3561), and without that refresh
    // `state.loggedIn` stays false and the library never loads
    // (StreamingPage.vue:1703). Do not remove it without re-reading those two
    // lines.
    assert.ok(provider.capabilities.includes('login'))
    assert.equal(provider.ui.authType, 'settings')

    // host.ts copies every function-valued method into the handler table, so
    // these keys are exactly what the host will call.
    for (const method of [
      'checkLogin',
      'getProfile',
      'fetchUserLibrary',
      'fetchPlaylistTracks',
      'getPlaybackUrl'
    ]) {
      assert.equal(typeof provider[method], 'function', `${method} must be a function`)
    }

    const login = await provider.checkLogin()
    assert.equal(login.loggedIn, true)

    const library = await provider.fetchUserLibrary(false)
    assert.ok(library && typeof library === 'object')
    assert.ok(Array.isArray(library.playlists))
    assert.ok('likedPlaylist' in library)
  })
})

/**
 * The host gates several API calls on manifest permissions, and install runs a
 * *trial activation* — so a missing permission does not merely disable a
 * feature, it makes the whole plugin fail to install. `providers.register`
 * requiring `network` is the non-obvious one: a purely local provider still has
 * to declare it (manager.ts:1573).
 *
 * The required pairs are read out of the host source rather than hard-coded, so
 * this guard follows the host instead of drifting from it.
 */
test('manifest declares every permission the host requires for the APIs it calls', { skip }, async () => {
  const managerSource = await fs.readFile(
    path.join(hostSource, 'src', 'main', 'plugins', 'manager.ts'),
    'utf-8'
  )
  const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, 'plugin.json'), 'utf-8'))

  // this.requirePermission(<pluginId>, '<permission>', '<capability>')
  const requirementPattern =
    /this\.requirePermission\(\s*[\w.]+\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g
  const requirements = new Map()
  for (const match of managerSource.matchAll(requirementPattern)) {
    requirements.set(match[2], match[1])
  }
  assert.ok(requirements.size > 0, 'expected to find permission gates in the host source')

  // Everything this plugin actually calls during activate() / a command.
  const capabilitiesUsed = [
    'providers.register',
    '注册 library Provider 能力',
    'ui.notify'
  ]

  for (const capability of capabilitiesUsed) {
    const permission = requirements.get(capability)
    assert.ok(permission, `host source no longer gates "${capability}"; update this test`)
    assert.ok(
      manifest.permissions.includes(permission),
      `plugin calls "${capability}" but does not declare "${permission}" — install would fail`
    )
  }

  // normalizeUiContribution additionally requires ui:inject for any contribution.
  assert.ok(manifest.permissions.includes('ui:inject'))
})
