/**
 * Playlist discovery.
 *
 * Everything here is bounded: a pathological root (a whole drive, a symlink
 * loop) must not turn into an unbounded walk inside the plugin host, and the
 * whole scan runs in the background so it never blocks a host command.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

/** Formats written by the players people actually use. */
export const DEFAULT_EXTENSIONS = [
  'm3u8',
  'm3u',
  'pls',
  'xspf',
  'wpl',
  'asx',
  'wax',
  'fpl',
  'fplite'
]

export const SCAN_LIMITS = {
  maxFiles: 2000,
  maxDepth: 6,
  maxVisited: 100_000,
  maxFileBytes: 8 * 1024 * 1024
}

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '$recycle.bin',
  'system volume information',
  '.git',
  '.svn',
  '.cache'
])

export function normalizeExtensions(values) {
  // Accepts the array form used by persisted config and the single-line
  // `m3u8; m3u` string the settings form submits.
  const list =
    typeof values === 'string'
      ? values.split(/[;,\s|]+/)
      : Array.isArray(values)
        ? values
        : DEFAULT_EXTENSIONS
  const seen = new Set()
  const result = []
  for (const value of list) {
    const extension = String(value ?? '')
      .trim()
      .replace(/^\*?\.?/, '')
      .toLowerCase()
    if (!extension || seen.has(extension)) continue
    seen.add(extension)
    result.push(extension)
  }
  return result.length > 0 ? result : [...DEFAULT_EXTENSIONS]
}

export function extensionOf(filePath) {
  const base = path.basename(filePath)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

async function statDirectory(target) {
  try {
    const info = await fs.stat(target)
    return info.isDirectory() ? target : null
  } catch {
    return null
  }
}

/**
 * @param {string[]} roots directories to search
 * @param {{ extensions?: string[], recursive?: boolean, signal?: AbortSignal }} [options]
 * @returns {Promise<{ files: string[], warnings: string[], truncated: boolean }>}
 */
export async function scanPlaylistFiles(roots, options = {}) {
  const extensions = new Set(normalizeExtensions(options.extensions))
  const recursive = options.recursive === true
  const signal = options.signal
  const warnings = []

  const files = []
  let visited = 0
  let truncated = false

  const queue = []
  for (const root of Array.isArray(roots) ? roots : []) {
    const trimmed = String(root ?? '').trim()
    if (!trimmed) continue
    const resolved = path.resolve(trimmed)
    const directory = await statDirectory(resolved)
    if (!directory) {
      warnings.push(`目录不存在或无法访问：${trimmed}`)
      continue
    }
    queue.push({ directory, depth: 0 })
  }

  while (queue.length > 0) {
    if (signal?.aborted) break
    if (files.length >= SCAN_LIMITS.maxFiles || visited >= SCAN_LIMITS.maxVisited) {
      truncated = true
      break
    }

    const current = queue.shift()
    if (current.depth > SCAN_LIMITS.maxDepth) {
      truncated = true
      continue
    }

    let entries
    try {
      entries = await fs.readdir(current.directory, { withFileTypes: true })
    } catch (error) {
      warnings.push(`无法读取目录 ${current.directory}：${error?.message ?? error}`)
      continue
    }

    for (const entry of entries) {
      visited += 1
      if (visited >= SCAN_LIMITS.maxVisited || files.length >= SCAN_LIMITS.maxFiles) {
        truncated = true
        break
      }

      const full = path.join(current.directory, entry.name)

      if (entry.isDirectory()) {
        if (!recursive) continue
        if (entry.name.startsWith('.')) continue
        if (SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) continue
        queue.push({ directory: full, depth: current.depth + 1 })
        continue
      }

      // Symlinked playlist files are followed; directory symlinks are not, which
      // is what keeps the walk acyclic.
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      if (!extensions.has(extensionOf(entry.name))) continue
      files.push(full)
    }
  }

  files.sort((left, right) =>
    path.basename(left).localeCompare(path.basename(right), 'zh-Hans-CN')
  )

  return { files, warnings, truncated }
}

/** Size guard shared by every reader so one huge file cannot stall the host. */
export async function readFileWithinLimit(filePath, maxBytes = SCAN_LIMITS.maxFileBytes) {
  const info = await fs.stat(filePath)
  if (!info.isFile()) throw new Error('不是普通文件')
  if (info.size > maxBytes) {
    throw new Error(`文件超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 上限`)
  }
  return await fs.readFile(filePath)
}
