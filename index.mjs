/**
 * 歌单文件桥接 — Twilight Echo plugin entry point.
 *
 * A UI-only plugin: a settings panel that scans playlist files written by any
 * player and imports them into the player's own local playlists. It registers
 * no provider and plays nothing itself.
 *
 * Timing rules this file obeys (from src/main/plugins/manager.ts):
 *  - `activate` is killed after 5 s, so the initial scan is fire-and-forget;
 *  - UI commands are killed after 5 s AND stop the plugin host on timeout, so no
 *    command handler ever scans — they read the last published snapshot.
 */

import {
  buildSettingsForm,
  configFromForm,
  CONFIG_KEY,
  DEFAULT_CONFIG,
  normalizeConfig
} from './lib/config.mjs'
import { createPlaylistLibrary } from './lib/library.mjs'

/**
 * One command serves load, save, reset and the import button.
 *
 * The host resolves a command's owner by scanning *registered UI contributions*
 * for one whose `command` matches, and rejects anything else with
 * "UI command 未注册" (manager.ts:720). Calling `ui.onCommand` for a name that
 * no contribution declares is therefore useless — the renderer can never reach
 * it. Since a plugin only gets one settings panel, all operations share the
 * command that panel declares and are told apart by their arguments.
 */
const SETTINGS_COMMAND = 'plfile.settings'

/** Host cap for a playlist name; longer names reject the whole import batch. */
const MAX_IMPORT_NAME_LENGTH = 80

/** Remembers that the "point me at a folder" hint has already been shown. */
const SETUP_ANNOUNCED_KEY = 'setupAnnounced'

/** @type {ReturnType<typeof createPlaylistLibrary> | null} */
let runtime = null
let disposers = []
let refreshTimer = null
let setupAnnounced = false

/** Persisted config, kept in memory so command handlers never await a read. */
let currentConfig = { ...DEFAULT_CONFIG }

function formatTime(iso) {
  if (!iso) return '尚未扫描'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '尚未扫描'
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}

function statusNotice(config, status) {
  if (config.playlistDirs.length === 0) {
    return '还没有设置歌单文件夹。填入存放歌单的目录后保存，例如 D:\\Music\\playlists。多个目录用分号分隔。'
  }
  const lines = [`已索引 ${status.fileCount} 个歌单文件 · 上次扫描 ${formatTime(status.lastRefreshAt)}`]
  if (status.refreshing) lines.push('正在后台扫描…')
  if (status.truncated) lines.push('结果已达数量上限，部分歌单未列出。')
  if (status.lastError) lines.push(`上次扫描出错：${status.lastError}`)
  for (const warning of status.warnings.slice(0, 2)) lines.push(warning)
  return lines.join(' ')
}

function buildForm() {
  const status = runtime?.status() ?? {
    fileCount: 0,
    refreshing: false,
    lastRefreshAt: null,
    lastError: null,
    warnings: [],
    truncated: false
  }
  return buildSettingsForm(currentConfig, statusNotice(currentConfig, status))
}

async function loadConfig(context) {
  try {
    const raw = await context.settings.get(CONFIG_KEY)
    currentConfig = normalizeConfig(raw)
  } catch (error) {
    context.logger.warn(`读取配置失败，已使用默认值：${error?.message ?? error}`)
    currentConfig = normalizeConfig(DEFAULT_CONFIG)
  }
  try {
    setupAnnounced = (await context.settings.get(SETUP_ANNOUNCED_KEY)) === true
  } catch {
    setupAnnounced = false
  }
  return currentConfig
}

/**
 * A freshly installed plugin otherwise looks like it did nothing at all: it
 * shows no playlists until a folder is configured, and the settings panel is
 * buried under 设置 → 系统与关于. Say so once, out loud.
 */
function announceSetupIfNeeded(context) {
  if (setupAnnounced || currentConfig.playlistDirs.length > 0) return
  setupAnnounced = true
  context.settings
    .set(SETUP_ANNOUNCED_KEY, true)
    .catch((error) => context.logger.warn(`记录引导状态失败：${error?.message ?? error}`))

  void notify(context, {
    kind: 'info',
    message:
      '歌单文件桥接已启用。下一步：设置 → 系统与关于 → 插件设置 → 歌单文件桥接，填入存放歌单的文件夹，再点「立即导入为本地歌单」。',
    durationMs: 15000
  })
}

/** Background scan. Never awaited by a command handler. */
function scheduleRefresh(context, { immediate = true } = {}) {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
  const run = () => {
    refreshTimer = null
    runtime
      ?.refresh(currentConfig)
      .then((snapshot) => {
        if (!snapshot) return
        const total = snapshot.files.length
        context.logger.info(`后台扫描完成，共 ${total} 个歌单文件`)
        // Only nag when the user has actually pointed us somewhere; a fresh
        // install already explains itself in the settings panel.
        if (total === 0 && currentConfig.playlistDirs.length > 0) {
          void notify(context, {
            kind: 'warning',
            message: '没有在指定目录找到歌单文件，请检查「歌单文件夹」和扩展名设置。'
          })
        }
      })
      .catch((error) => {
        context.logger.error(`后台扫描失败：${error?.message ?? error}`)
      })
  }
  // A short delay keeps activation well inside the 5 s activation budget even
  // when the configured folders live on a slow or sleeping drive.
  refreshTimer = setTimeout(run, immediate ? 50 : 300)
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref()
}

async function notify(context, notice) {
  try {
    if (typeof context.twilight.ui.notify === 'function') {
      await context.twilight.ui.notify(notice)
    }
  } catch (error) {
    context.logger.warn(`提示发送失败：${error?.message ?? error}`)
  }
}

function registerCommand(context, command, handler) {
  const dispose = context.twilight.ui.onCommand(command, handler)
  if (typeof dispose === 'function') disposers.push(dispose)
}

/**
 * Mirror every scanned playlist into the player's own local playlists
 * (`音乐库 → 歌单`).
 *
 * Runs in the background so the settings command stays inside the host's 5 s
 * budget, and is safe to repeat: the importer de-duplicates by track id, so a
 * second pass only adds what is new.
 */
function mirrorToLocalPlaylists(context) {
  const library = context.twilight.library
  if (typeof library?.importPlaylists !== 'function') {
    void notify(context, {
      kind: 'warning',
      message: '当前版本的 Twilight Echo 不支持「导入为本地歌单」，升级播放器后再试。'
    })
    return
  }

  void (async () => {
    try {
      const { playlists } = await runtime.listPlaylists(currentConfig)
      const payload = []
      for (const summary of playlists) {
        // `keep: false` — the import only needs the paths; retaining every
        // playlist's materialized track list would hold the whole catalogue in
        // memory for the rest of the session.
        const detail = await runtime.getPlaylistTracks(summary.id, currentConfig, {
          keep: false
        })
        const paths = detail.tracks.map((track) => track.filePath).filter(Boolean)
        // An empty playlist would create an empty local playlist; skip it.
        // The host rejects (it does not truncate) names past 80 normalized
        // characters, and one bad name fails the entire batch — so clamp here.
        if (paths.length > 0) {
          payload.push({ name: summary.name.slice(0, MAX_IMPORT_NAME_LENGTH), paths })
        }
      }

      if (payload.length === 0) {
        await notify(context, {
          kind: 'warning',
          message: '没有可导入的曲目：歌单里没有解析出任何文件路径。'
        })
        return
      }

      await library.importPlaylists({ playlists: payload })
      context.logger.info(`已请求把 ${payload.length} 个歌单导入为本地歌单`)
    } catch (error) {
      const message = error?.message ?? String(error)
      context.logger.error(`导入为本地歌单失败：${message}`)
      await notify(context, { kind: 'error', message: `导入为本地歌单失败：${message}` })
    } finally {
      // Drop whatever the pass left behind; a one-off import has no reason to
      // keep the catalogue warm.
      runtime?.invalidateAll()
    }
  })()
}

/**
 * The settings-panel 「立即导入为本地歌单」 button.
 *
 * One press does all three steps: persist whatever the form currently shows,
 * rescan the folders, then import the batch — so the user does not have to save
 * first. Returns a refreshed form so the notice line reflects the new scan.
 */
async function runImportAction(context, payload) {
  if (payload?.values && typeof payload.values === 'object') {
    const next = configFromForm(payload.values)
    currentConfig = next
    context.settings
      .set(CONFIG_KEY, next)
      .catch((error) => context.logger.error(`保存配置失败：${error?.message ?? error}`))
    // A new config object, so the next list operation rescans the folders.
    runtime?.invalidateAll()
  }

  mirrorToLocalPlaylists(context)
  return {
    message: '正在后台扫描并导入，完成后会弹出结果提示。',
    form: buildForm()
  }
}

/** Persists a submitted settings form and kicks off a background rescan. */
async function applySettings(context, values) {
  const next = configFromForm(values)
  currentConfig = next
  // Persisting must not be able to blow the 5 s command budget.
  context.settings
    .set(CONFIG_KEY, next)
    .catch((error) => context.logger.error(`保存配置失败：${error?.message ?? error}`))

  runtime?.invalidateAll()
  scheduleRefresh(context, { immediate: true })

  const dirCount = next.playlistDirs.length
  return {
    message:
      dirCount === 0
        ? '已保存，但没有填写歌单文件夹，暂时不会出现任何歌单。'
        : `已保存 ${dirCount} 个目录，正在后台重新扫描。`,
    form: buildForm()
  }
}

async function resetSettings(context) {
  currentConfig = normalizeConfig(DEFAULT_CONFIG)
  await context.settings.set(CONFIG_KEY, currentConfig)
  runtime?.invalidateAll()
  scheduleRefresh(context, { immediate: true })
  return { message: '已恢复默认设置', form: buildForm() }
}

export async function activate(context) {
  runtime = createPlaylistLibrary({ logger: context.logger })

  await loadConfig(context)

  registerCommand(context, SETTINGS_COMMAND, async (...args) => {
    // The host appends its own context object as the final argument, so the
    // shape of the *first* argument is what distinguishes the calls:
    // absent = reset, `{ source: 'settingsPanel' }` = load,
    // `{ action: ... }` = a form button, a field map = save.
    const payload = args.length > 1 ? args[0] : undefined
    if (!payload || typeof payload !== 'object') return await resetSettings(context)
    if (payload.source === 'settingsPanel') return buildForm()
    if (payload.action === 'importNow') return await runImportAction(context, payload)
    return await applySettings(context, payload)
  })

  await context.twilight.ui.register({
    id: 'plfile-settings',
    kind: 'settingsPanel',
    title: '歌单文件桥接',
    description: '把任意播放器保存的 m3u8 / m3u / pls / xspf / wpl / fpl / fplite 歌单导入为本地歌单',
    icon: 'pi pi-list',
    command: SETTINGS_COMMAND,
    autoLoad: true
  })

  scheduleRefresh(context, { immediate: false })
  announceSetupIfNeeded(context)
  context.logger.info('歌单文件桥接已启动')
}

export async function deactivate() {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
  for (const dispose of disposers.splice(0)) {
    try {
      dispose()
    } catch {
      // The host may already have cleared its command table.
    }
  }
  runtime = null
}
