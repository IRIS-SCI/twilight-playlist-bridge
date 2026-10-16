/**
 * The `plfile` MediaProvider.
 *
 * The plugin API deliberately exposes no way to write into the local library or
 * the playback queue, so a playlist cannot be "imported" into a user playlist
 * from a plugin. What a provider *can* do is present playlists as a source, so
 * that is what this does: every playlist file found in the configured folders
 * becomes one browsable playlist, always reflecting the file on disk — whoever
 * wrote it.
 */

import { createPlaylistLibrary, fileForPlaylistId, PROVIDER_ID } from './library.mjs'
import { createAudioProxy } from './proxy.mjs'

const PROFILE = {
  userId: `${PROVIDER_ID}-local`,
  nickname: '歌单文件',
  avatarUrl: null
}

const REMOTE_URL = /^https?:\/\//i
const AUDIO_EXTENSION =
  /\.(?:flac|mp3|m4a|m4b|mp4|aac|wav|wave|aiff|aif|ape|wv|mpc|tak|tta|ogg|oga|opus|dsf|dff|wma|alac|mka|caf)$/i

function playlistNotice(detail) {
  const parts = []
  if (detail.encoding) parts.push(`编码 ${detail.encoding}`)
  parts.push(`${detail.fileCount} 条`)
  if (detail.missing > 0) parts.push(`${detail.missing} 个文件缺失`)
  if (detail.unusable > 0) parts.push(`${detail.unusable} 条无有效路径`)
  if (detail.remote > 0) parts.push(`${detail.remote} 个网络流`)
  return parts.join('，')
}

export { AUDIO_EXTENSION }

/**
 * @param {{
 *   getConfig: () => object,
 *   logger?: object,
 *   onPlaylistRead?: (detail: object) => void
 * }} deps
 */
export function createPlaylistFileProvider(deps) {
  const { getConfig } = deps
  const logger = deps.logger ?? { info() {}, warn() {}, error() {} }
  const library = createPlaylistLibrary({ logger })
  const proxy = createAudioProxy({ logger })

  async function fetchUserLibrary(force = false) {
    const config = getConfig()
    if (force) library.invalidateAll()
    const { playlists } = await library.listPlaylists(config)
    return { likedPlaylist: null, playlists }
  }

  async function fetchPlaylistTracks(playlistId, force = false, context) {
    const config = getConfig()
    if (force) library.invalidate(playlistId)
    if (context?.signal?.aborted) throw new Error('已取消')

    const detail = await library.getPlaylistTracks(playlistId, config)
    if (detail.warnings.length > 0) {
      logger.warn(`歌单 ${playlistId} 有 ${detail.warnings.length} 条提示：${detail.warnings[0]}`)
    }
    deps.onPlaylistRead?.(detail)
    logger.info(`读取歌单 ${playlistId}：${playlistNotice(detail)}`)
    return detail.tracks
  }

  async function getPlaybackUrl(track) {
    const config = getConfig()
    const streamUrl = typeof track?.streamUrl === 'string' ? track.streamUrl.trim() : ''
    const origin = proxy.origin()

    // A real network entry (internet radio) is passed through untouched.
    if (REMOTE_URL.test(streamUrl) && !(origin && streamUrl.startsWith(origin))) {
      return streamUrl
    }

    const filePath = typeof track?.filePath === 'string' ? track.filePath.trim() : ''
    if (!filePath) return null

    if (!config.proxyPlayback) return filePath
    try {
      return await proxy.urlFor(filePath)
    } catch (error) {
      // Falling back to the plain path is strictly better than failing playback.
      logger.warn(`本地代理不可用，改用直接路径：${error?.message ?? error}`)
      return filePath
    }
  }

  function providerRegistration() {
    return {
      id: PROVIDER_ID,
      name: '歌单文件',
      capabilities: ['playlist', 'library', 'playbackUrl'],
      ui: {
        icon: 'pi pi-list',
        color: '#8a6cff',
        description: '读取任意播放器保存的 m3u8 / m3u / pls / xspf / wpl / fpl / fplite 歌单',
        // `authType` only accepts qr/oauth/cookie/settings, and anything else —
        // including omitting it — is coerced to 'qr' by the host
        // (providerRouting.ts:140). It is harmless here because this provider
        // does not declare the `login` capability, so the login page filters it
        // out (LoginPage.vue:100).
        streamingLibraryTab: true
      },
      checkLogin: async () => ({ loggedIn: true, profile: PROFILE }),
      getProfile: async () => PROFILE,
      fetchUserLibrary,
      fetchPlaylistTracks,
      getPlaybackUrl
    }
  }

  return {
    providerRegistration,
    library,
    proxy,
    describePlaylist: playlistNotice,
    fileForPlaylistId
  }
}
