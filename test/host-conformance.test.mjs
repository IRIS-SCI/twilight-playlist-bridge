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

function createFakeContext(storagePath, storedSettings = {}, options = {}) {
  const commands = new Map()
  const contributions = []
  const notifications = []
  const providers = []
  const playlistImports = []

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

  // `twilight.library` was added in Twilight Echo 1.4 (library.importPlaylists).
  // `options.libraryApi === false` emulates a host that predates it.
  if (options.libraryApi !== false) {
    context.twilight.library = {
      async importPlaylists(request) {
        playlistImports.push(request)
      }
    }
  }

  return { context, commands, contributions, notifications, providers, playlistImports }
}

async function withPlugin(run, storedSettings = {}, options = {}) {
  const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'plfile-conformance-'))
  const harness = createFakeContext(storagePath, storedSettings, options)
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
  // Without this the plugin looks inert after install: it shows nothing until a
  // folder is set, and the panel is buried in the settings.
  await withPlugin(async (harness) => {
    assert.equal(harness.notifications.length, 1)
    const notice = harness.notifications[0]
    assert.match(notice.message, /插件设置/)
    assert.match(notice.message, /立即导入为本地歌单/)
    assert.ok(notice.durationMs >= 2500 && notice.durationMs <= 30000)
  })
})

test('saving with 导入为本地歌单 mirrors the playlists through the host API', { skip }, async () => {
  const listsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plfile-import-'))
  try {
    const music = path.join(listsDir, 'music')
    await fs.mkdir(music, { recursive: true })
    await fs.writeFile(path.join(music, '01. Hans Zimmer - Dreaming of the Crash.flac'), 'x')
    await fs.writeFile(
      path.join(listsDir, '星际穿越OST.m3u8'),
      `#\n${path.join(music, '01. Hans Zimmer - Dreaming of the Crash.flac')}\n`
    )

    await withPlugin(
      async (harness) => {
        const handler = harness.commands.get('plfile.settings')
        // Exactly how the host invokes a `button` field: one press, carrying
        // the form's current draft values so no save is needed first.
        const saved = await handler(
          {
            action: 'importNow',
            values: { playlistDirs: listsDir }
          },
          { signal: new AbortController().signal }
        )
        assert.match(saved.message, /扫描并导入/)

        // The mirror runs in the background so the command stays inside the
        // host's 5 s budget; wait for it to reach the API.
        for (let attempt = 0; attempt < 40 && harness.playlistImports.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        assert.equal(harness.playlistImports.length, 1, 'expected exactly one batched import')

        const { playlists } = harness.playlistImports[0]
        assert.equal(playlists.length, 1)
        assert.equal(playlists[0].name, '星际穿越OST')
        assert.deepEqual(playlists[0].paths, [
          path.join(music, '01. Hans Zimmer - Dreaming of the Crash.flac')
        ])

        // Saving the form normally must NOT import — the button is the only
        // trigger, so an unrelated settings change stays cheap.
        await handler(
          { playlistDirs: listsDir },
          { signal: new AbortController().signal }
        )
        await new Promise((resolve) => setTimeout(resolve, 400))
        assert.equal(harness.playlistImports.length, 1, 'a plain save must not re-import')
      },
      { config: { playlistDirs: [listsDir], extensions: ['m3u8'] } }
    )
  } finally {
    await fs.rm(listsDir, { recursive: true, force: true })
  }
})

test('the import control is a real button in the settings form', { skip }, async () => {
  const { normalizePluginSettingsForm } = await loadHostModule(
    'src/renderer/src/components/settings-page/pluginSettingsForm.ts'
  )
  await withPlugin(async (harness) => {
    const form = normalizePluginSettingsForm(
      await harness.commands.get('plfile.settings')(
        { source: 'settingsPanel', panelId: 'plfile-settings' },
        { signal: new AbortController().signal }
      )
    )
    const action = form.fields.find((field) => field.key === 'importNow')
    assert.ok(action, 'the import action must be offered')
    assert.equal(action.type, 'button')
    assert.equal(action.value, '')
    // Buttons fall back to the form's submitCommand, which is the only command
    // the host can route for this plugin.
    assert.equal(action.command, '')
    assert.equal(form.submitCommand, 'plfile.settings')
  })
})

test('an older host without twilight.library is reported, not crashed on', { skip }, async () => {
  const listsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plfile-oldhost-'))
  try {
    const music = path.join(listsDir, 'music')
    await fs.mkdir(music, { recursive: true })
    await fs.writeFile(path.join(music, 'a.flac'), 'x')
    await fs.writeFile(path.join(listsDir, 'list.m3u8'), `${path.join(music, 'a.flac')}\n`)

    await withPlugin(
      async (harness) => {
        const saved = await harness.commands.get('plfile.settings')(
          { action: 'importNow', values: { playlistDirs: listsDir } },
          { signal: new AbortController().signal }
        )
        // The command itself must still succeed.
        assert.equal(typeof saved.message, 'string')

        for (let attempt = 0; attempt < 20 && harness.notifications.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        assert.ok(
          harness.notifications.some((notice) => notice.kind === 'warning'),
          `expected a warning notice, got ${JSON.stringify(harness.notifications)}`
        )
        assert.equal(harness.playlistImports.length, 0)
      },
      { config: { playlistDirs: [listsDir], extensions: ['m3u8'] } },
      { libraryApi: false }
    )
  } finally {
    await fs.rm(listsDir, { recursive: true, force: true })
  }
})

test('the plugin registers no provider', { skip }, async () => {
  // The plugin only imports playlists; registering a provider would make it
  // demand `network` + `library:read` and surface a redundant audio source.
  await withPlugin(async (harness) => {
    assert.deepEqual(harness.providers, [])
  })
})

/**
 * The host gates several API calls on manifest permissions, and install runs a
 * *trial activation* — so a missing permission does not merely disable a
 * feature, it makes the whole plugin fail to install.
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
  const capabilitiesUsed = ['ui.notify', 'library.importPlaylists']

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

  // A UI-only plugin that never registers a provider has no business asking for
  // these; keeping them would mislead users on the install prompt.
  assert.ok(!manifest.permissions.includes('network'))
  assert.ok(!manifest.permissions.includes('library:read'))
  assert.deepEqual(manifest.type, ['ui'])
})
