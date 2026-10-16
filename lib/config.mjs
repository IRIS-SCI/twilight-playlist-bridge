/**
 * Plugin configuration: normalization, the separator-tolerant directory list,
 * and the `settings-form` DTO the host renders in 设置 → 扩展.
 *
 * The host renders `text` fields as single-line inputs, so every directory list
 * is a `;`-separated string rather than a textarea.
 */

import os from 'node:os'
import path from 'node:path'

import { DEFAULT_EXTENSIONS, normalizeExtensions, SCAN_LIMITS } from './scan.mjs'
import { SUPPORTED_ENCODINGS } from './decode.mjs'

export const CONFIG_KEY = 'config'

export const DEFAULT_CONFIG = {
  /** Folders scanned for playlist files. */
  playlistDirs: [],
  /** Extra roots used to re-attach a moved library path (drive-letter repair). */
  searchRoots: [],
  extensions: [...DEFAULT_EXTENSIONS],
  recursive: false,
  encoding: 'auto',
  /** Split an `Artist - Title` EXTINF value into two fields. */
  splitArtistTitle: true,
  /** Drop entries whose file is missing instead of showing them as unplayable. */
  skipMissing: true,
  /** Serve audio over a loopback HTTP server instead of handing over the path. */
  proxyPlayback: false,
  maxPlaylists: 500
}

export const DIRECTORY_SEPARATORS = /[;\n\r|]+/

const WINDOWS_ENV_VAR = /%([^%\\/;]+)%/g

/**
 * Expands the two path shorthands people actually type: `%APPDATA%`-style
 * Windows environment variables and a leading `~` for the home directory.
 *
 * Unknown variables are left untouched rather than blanked, so a literal
 * `%` in a folder name does not silently turn into an empty path.
 */
export function expandDirectoryEntry(entry) {
  let value = String(entry ?? '').trim()
  if (!value) return ''

  value = value.replace(WINDOWS_ENV_VAR, (match, name) => {
    // Windows environment lookups are case-insensitive in Node.
    const resolved = process.env[name] ?? process.env[name.toUpperCase()]
    return typeof resolved === 'string' && resolved ? resolved : match
  })

  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    const home = os.homedir()
    if (home) value = value === '~' ? home : path.join(home, value.slice(2))
  }

  return value
}

/** `D:\A;D:\B` -> `['D:\\A', 'D:\\B']`, keeping Windows drive colons intact. */
export function parseDirectoryList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => expandDirectoryEntry(item)).filter(Boolean)
  }
  return String(value ?? '')
    .split(DIRECTORY_SEPARATORS)
    .map((item) => expandDirectoryEntry(item.replace(/^"(.*)"$/, '$1')))
    .filter(Boolean)
}

export function formatDirectoryList(list) {
  return (Array.isArray(list) ? list : []).join('; ')
}

function normalizeBoolean(value, fallback) {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return fallback
}

function normalizeInteger(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/**
 * Accepts anything (persisted settings, form submissions, partial objects) and
 * always returns a complete, in-range config.
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const encoding = SUPPORTED_ENCODINGS.includes(source.encoding)
    ? source.encoding
    : DEFAULT_CONFIG.encoding

  return {
    playlistDirs: parseDirectoryList(source.playlistDirs),
    searchRoots: parseDirectoryList(source.searchRoots),
    extensions: normalizeExtensions(source.extensions ?? DEFAULT_CONFIG.extensions),
    recursive: normalizeBoolean(source.recursive, DEFAULT_CONFIG.recursive),
    encoding,
    splitArtistTitle: normalizeBoolean(source.splitArtistTitle, DEFAULT_CONFIG.splitArtistTitle),
    skipMissing: normalizeBoolean(source.skipMissing, DEFAULT_CONFIG.skipMissing),
    proxyPlayback: normalizeBoolean(source.proxyPlayback, DEFAULT_CONFIG.proxyPlayback),
    maxPlaylists: normalizeInteger(
      source.maxPlaylists,
      DEFAULT_CONFIG.maxPlaylists,
      1,
      SCAN_LIMITS.maxFiles
    )
  }
}

/** Values collected from the settings form arrive as strings. */
export function configFromForm(values) {
  const source = values && typeof values === 'object' ? values : {}
  return normalizeConfig({
    playlistDirs: parseDirectoryList(source.playlistDirs),
    searchRoots: parseDirectoryList(source.searchRoots),
    extensions: source.extensions,
    recursive: source.recursive,
    encoding: source.encoding,
    splitArtistTitle: source.splitArtistTitle,
    skipMissing: source.skipMissing,
    proxyPlayback: source.proxyPlayback
  })
}

const ENCODING_LABELS = {
  auto: '自动检测（推荐）',
  'utf-8': 'UTF-8',
  gb18030: 'GBK / GB18030（中文 ANSI）',
  big5: 'Big5（繁体中文）',
  shift_jis: 'Shift-JIS（日文）',
  'euc-kr': 'EUC-KR（韩文）',
  'windows-1252': 'Windows-1252（西欧）',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE'
}

/**
 * @param {object} config normalized config
 * @param {string} notice status line shown above the fields (max 500 chars)
 */
export function buildSettingsForm(config, notice = '') {
  return {
    kind: 'settings-form',
    submitCommand: 'plfile.settings.save',
    resetCommand: 'plfile.settings.reset',
    notice: String(notice ?? '').slice(0, 500),
    fields: [
      {
        key: 'playlistDirs',
        label: '歌单文件夹',
        type: 'text',
        required: true,
        group: '歌单来源',
        placeholder: 'D:\\Music\\playlists; %APPDATA%\\foobar2000-v2\\playlists-v2.0',
        description:
          '放歌单文件的目录，多个用分号分隔。任意播放器导出的歌单都行：foobar2000、VLC、MusicBee、AIMP、PotPlayer 等。',
        value: formatDirectoryList(config.playlistDirs)
      },
      {
        key: 'recursive',
        label: '包含子文件夹',
        type: 'toggle',
        group: '歌单来源',
        description: '递归扫描上面每个目录的子目录。',
        value: config.recursive ? 'true' : 'false'
      },
      {
        key: 'extensions',
        label: '扫描的扩展名',
        type: 'text',
        group: '歌单来源',
        placeholder: 'm3u8; m3u; pls; xspf; wpl; fpl; fplite',
        description: '用分号分隔，不要写点号。默认覆盖主流播放器的歌单格式。',
        value: config.extensions.join('; ')
      },
      {
        key: 'encoding',
        label: '文本编码',
        type: 'select',
        group: '解析',
        description:
          '多数播放器写 .m3u 时用系统 ANSI（中文即 GBK）。歌名乱码时手动指定。',
        value: config.encoding,
        options: SUPPORTED_ENCODINGS.map((value) => ({
          value,
          label: ENCODING_LABELS[value] ?? value
        }))
      },
      {
        key: 'splitArtistTitle',
        label: '拆分「艺术家 - 标题」',
        type: 'toggle',
        group: '解析',
        description: '把歌单里的 “Artist - Title” 拆成两个字段。',
        value: config.splitArtistTitle ? 'true' : 'false'
      },
      {
        key: 'skipMissing',
        label: '隐藏文件已丢失的曲目',
        type: 'toggle',
        group: '解析',
        description: '关闭后丢失的文件仍会列出，但无法播放。',
        value: config.skipMissing ? 'true' : 'false'
      },
      {
        key: 'proxyPlayback',
        label: '经本地代理播放',
        type: 'toggle',
        group: '播放',
        description:
          '默认直接把文件路径交给播放器；若提示「音频路径不在已授权目录内」，开启此项。',
        value: config.proxyPlayback ? 'true' : 'false'
      },
      {
        key: 'searchRoots',
        label: '路径修复目录',
        type: 'text',
        group: '播放',
        placeholder: 'E:\\Music',
        description: '歌单里的盘符或根目录变了时，用这些目录重新拼接路径。多个用分号分隔。',
        value: formatDirectoryList(config.searchRoots)
      }
    ]
  }
}
