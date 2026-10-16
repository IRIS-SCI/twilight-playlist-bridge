# 歌单文件桥接 · Twilight Echo 插件

�?*任意播放�?*导出的歌单文件直接读�?Twilight Echo —�?foobar2000、VLC、Winamp�?AIMP、MusicBee、PotPlayer、Windows Media Player 等等，几十个歌单不用在播放器里再整理一遍：
歌单文件改了，播放器里跟着变�?
- 插件 ID：`com.github.pxasen.playlist-bridge`
- 类型：`provider` + `ui`
- 最低宿主版本：Twilight Echo `1.3.0`
- 依赖�?*�?*。只�?Node 内置模块，安装时不需�?npm install�?
---

## 1. 支持的格�?
| 格式 | 常见来源 |
| --- | --- |
| `.m3u8` | foobar2000、VLC、MusicBee、AIMP、PotPlayer（UTF-8 文本歌单�?|
| `.m3u` | 同上，但编码通常是系�?ANSI（中�?Windows 上是 GBK，已自动识别�?|
| `.pls` | Shoutcast / Icecast 工具、Winamp |
| `.xspf` | VLC 的原生格式，Quod Libet、Clementine |
| `.wpl` | Windows Media Player |
| `.asx` / `.wax` | Windows Media 元文�?|
| `.fpl` | foobar2000 自有二进制歌单（�?§5�?|
| `.fplite` | foobar2000 2.x 的新歌单格式（见 §5�?|

解析细节�?
- `#EXTM3U`、`#EXTINF:<�?,<标题>`，只�?*第一个逗号**切分（标题里带逗号很常见）�?- 兼容 `#EXTART` / `#EXTALB`，遇到未知的 `#` 指令一律忽略�?- 路径支持绝对路径、相对路径（相对歌单文件自身所在目录）、`file://` URI�?  UNC 共享、正反斜杠混用，以及 `%20` 这类转义�?- �?`#EXT-X-` 指令�?`.m3u8` 会被识别�?**HLS 流媒体清�?*并跳过，不当成歌单�?- 网络流条目（`http(s)://`、`rtmp://` 等）会保留，可以直接当网络电台播放�?
---

## 2. 它做了什么（以及为什么这样做�?
安装启用后，音乐库的**音源切换�?*里会多出一个「歌单文件」�?你指定的目录下每个歌单文件对应里面一个歌单，点开就是那个歌单的曲目，可以直接播放�?
歌单�?*实时读取文件**的，不是一次性导入的快照。在原来的播放器里改了歌单，
回到 Twilight Echo 刷新一下就是最新的�?
### 关于「直接导入成本地歌单�?
这一条受宿主 API 限制，需要说清楚�?
- 插件 API（`@twilight-echo/plugin-api`）只暴露 `events` / `player` / `providers` /
  `ui` / `themes` / `overlay`�?*没有任何写本地音乐库、写用户歌单、写播放队列的方�?*�?  `library:write` 这个权限 token 存在，但宿主没有把它接到任何 API 上�?- 插件规范也明确禁止插�?`import` 宿主内部模块，所以绕过网关去直接�?  `playlists.json` 是违规的，而且会和宿主的版本号乐观锁打架、有损坏歌单的风险�?
所�?*纯插件无法把曲目写进本地歌单**；`provider` 是唯一一条「让这些歌单在播放器�?出现并且能播」的路。如果你要的是「点一下真的变�?Twilight Echo 里的本地歌单」，
那需要在主仓库加一个插�?API（例�?`twilight.library.importPlaylist(...)`）—�?那是宿主侧的改动，不是插件能覆盖的范围�?
---

## 3. 安装

### �?`.tep` 安装（普通用户）

1. 下载 `com.github.pxasen.playlist-bridge-1.0.2.tep`
2. Twilight Echo �?**扩展中心** �?「从本地安装�?(.tep)�?3. 确认权限并启�?
### 从文件夹安装（开发）

设置 �?常规 �?开发者选项 �?打开**开发者模�?*�?扩展中心右上角出现「从文件夹安装（开发）」，选中本目录即可�?
---

## 4. 配置

装好后进 **设置 �?扩展 �?歌单文件桥接**�?
| 选项 | 说明 |
| --- | --- |
| **歌单文件�?* | 必填。放歌单文件的目录，多个�?*分号**分隔。支�?`%APPDATA%` 这类环境变量和开头的 `~`，所以可以直接填 `%APPDATA%\foobar2000-v2\playlists-v2.0` |
| 包含子文件夹 | 递归扫描 |
| 扫描的扩展名 | 默认覆盖上表所有格�?|
| 文本编码 | 默认自动检测；歌名乱码时手动指定（中文�?`GBK / GB18030`�?|
| 拆分「艺术家 - 标题�?| 把歌单里�?`Artist - Title` 拆成两个字段 |
| 隐藏文件已丢失的曲目 | 默认开 |
| 经本地代理播�?| 默认关，�?§6 |
| 路径修复目录 | 盘符或根目录变了时用它重新拼接路�?|

保存后后台重新扫描，提示行会显示扫描结果�?*扫描全程在后�?*，不阻塞设置界面�?
> 目录填在**单行文本�?*里（宿主只提供这种控件），所以多个目录用分号 `;` 分隔，不要换行�?
---

## 5. 关于 `.fpl` �?`.fplite`

### `.fpl`

二进制格式，foobar2000 官方明确表示**不打算让它可被其它软件读�?*
（[官方 FAQ](https://www.foobar2000.org/FAQ#other_questions)�?"The FPL format is not meant to be
interchangeable with other software�?*）。本插件的解析器基于社区逆向出来的格式文档实现，
参�?[rr-/fpl_reader](https://github.com/rr-/fpl_reader)（格式文档）�?[yellowcrescent/fplreader](https://github.com/yellowcrescent/fplreader)（C++ 原版实现�?�?[AkaBlur/fpl-tool](https://github.com/AkaBlur/fpl-tool)�?
能正确读出路径、标题、艺术家、专辑和时长，并处理了三个容易踩坑的地方�?
- `flags` �?0 位为 0 的记录（从未播放过的流媒体）**�?`subsong` 之后就结束了**�?  不特判的话后面所有曲目都会错位；
- `flags` �?2 位为 1 时，条目后面还有 64 字节填充�?- 主键索引可能出现空洞，需要沿用上一个键名�?
**但它仍然是逆向格式，fb2k 未来版本可能再次改变它�?* 解析失败时会退化成
「扫描文件里的路径字符串」，仍然能用，只是标题和时长取自文件名�?最稳的做法永远是：�?foobar2000 里用「文�?�?保存歌单为…」导出成 **m3u8**�?
### `.fplite`

纯文本、每行一�?`file://` 路径，fb2k 2.x 用户默认就有。代价是**文件里没有任何元数据**�?所以曲目名取自文件名。歌单名不在文件里，而在同目录的 `index.txt`（`<GUID>:<歌单�?`），
插件会读它，所以列表里显示的是你在 fb2k 里起的名字，而不�?`playlist-7F9B1053-…`�?
---

## 6. 播放：两种方�?
Twilight Echo 只允许播�?*已授权目�?*（音乐库目录、托管缓存目录）里的文件�?歌单里的文件如果在这些目录之外，直接播会失败并提示「音频路径不在已授权目录内」�?
1. **直接路径（默认）** —�?插件把绝对路径交给播放器�?   - 优点：引擎直接读原始文件，DSD、大码率 FLAC 走最原生的路径�?   - 前提：歌曲在音乐库目录里。本地播放器用户通常已经把音乐文件夹加进音乐库了�?2. **经本地代理播�?* —�?插件�?`127.0.0.1` 上起一个只读本�?HTTP 服务把文件流给播放器�?   - 用在歌单里的文件确实不在音乐库目录内的时候�?   - 只监听回环地址、随机端口；URL 里只有随�?token 不含路径；只能读取已索引过的文件�?     支持 Range 请求（可拖动进度条）�?   - Provider 规范明确支持回环地址播放，并在播放期间保持插件进程运行�?
**遇到「音频路径不在已授权目录内」就打开这个开�?*，或者把音乐文件夹加进音乐库�?
---

## 7. 编码

中文用户最常踩的坑：多数播放器�?`.m3u` 时用系统 ANSI（中�?Windows 上是 GBK），
�?`.m3u8` �?UTF-8。解码顺序：

1. BOM 优先（UTF-8 / UTF-16 LE / UTF-16 BE�?2. XML 声明里的 `encoding=`（`.xspf` / `.wpl` 自带�?3. **严格 UTF-8** —�?成功�?UTF-8
4. **GB18030** —�?GBK/GB2312 的超集，覆盖绝大多数中文老歌�?5. Big5 / Shift-JIS / EUC-KR
6. Windows-1252 兜底并在日志标记

关键点是**严格 UTF-8 必须排在 GB18030 前面**：GB18030 几乎什么字节都能解出来�?顺序反了会把正常�?UTF-8 歌单解成乱码�?
---

## 8. 已知限制

- **不能写入本地歌单**，原因见 §2�?- **`.fpl` 的元数据依赖逆向格式**，fb2k 大版本更新后可能需要跟着改�?- **`.fplite` / `.wpl` 没有元数�?*，曲目名取自文件名�?- **单次扫描上限**�?000 个歌单文件、每个歌�?20000 条、单个文�?8 MiB，达到上限会提示�?- **不支�?`.cue`**：cue 是「一张专辑一个文件」的分轨描述，不是歌单列表，
  而且 foobar2000 本身也无法把歌单导出�?cue（保存对话框只有 `*.fpl;*.m3u;*.m3u8`）�?  Twilight Echo 自身的音乐库扫描已经处理 cue�?- 歌单名撞车时�?`父目�?歌单名` 区分�?- 指向 CD 音轨（`cdda://`）的条目会被跳过并计数�?
---

## 9. 开�?
不需要安装任何依赖：

```bash
node --test          # 63 个测�?```

两类测试�?
- `test/parsers.test.mjs` / `test/formats.test.mjs` / `test/library.test.mjs` —�?  单元与集成测试，用临时目录构造真实歌单和音频文件，`.fpl` 用按格式文档
  构造的真实字节流验证�?- `test/host-conformance.test.mjs` —�?**一致性测�?*：加�?Twilight Echo 宿主�?  真实校验器（`validatePluginManifest`、`normalizeUiContribution`�?  `normalizePluginSettingsForm`），把插件真实的 `activate()` 跑一遍，确认 manifest�?  engines 范围、UI 扩展点、设置表�?DTO 都能被宿主接受，并检查设置保存耗时�?  找不到宿主源码时自动跳过；用 `TWILIGHT_ECHO_SRC` 指定�?
  ```bash
  TWILIGHT_ECHO_SRC=/path/to/Twilight_Echo node --test
  ```

打包�?
```bash
node ../Twilight_Echo/packages/create-twilight-plugin/bin/create-twilight-plugin.cjs pack .
# -> dist/com.github.pxasen.playlist-bridge-1.0.0.tep
```

### 源码结构

```
plugin.json          插件清单
index.mjs            入口：注�?provider、命令、设置面�?lib/
  decode.mjs         BOM / XML 声明 / UTF-8 / GB18030 编码探测
  m3u.mjs            m3u / m3u8
  pls.mjs            pls
  xspf/wpl/asx       xmlplaylist.mjs
  fpl.mjs            fpl（二进制结构性解�?+ 路径扫描兜底�?  fplite.mjs         fplite（含 index.txt 读取�?  paths.mjs          各种路径形态的归一化与修复
  scan.mjs           有界的目录扫�?  config.mjs         配置归一�?+ settings-form 生成
  library.mjs        歌单目录（缓存、解析、存在性检查）
  provider.mjs       MediaProvider 实现
  proxy.mjs          可选的回环音频代理
```

---

## 10. 发布到插件市�?
仓库需要满足：

- `plugin.json` �?`repository` 指向本仓库精确地址（不带尾部斜杠）
- �?`twilight-echo-plugin` topic，在最�?Release 附上唯一�?`.tep`
- 目录仓库约每 6 小时扫描一�?
详见主仓�?`docs/PLUGIN_README.md` �?14 节�?
---

## 11. 隐私与权�?
| 权限 | 用�?|
| --- | --- |
| `network` | **不是本插件要联网�?* 宿主把「注�?provider」这个动作本身用 `network` 权限兜底（`manager.ts:1573`：`requirePermission(pluginId, 'network', 'providers.register')`），不声明就无法注册音源，安装时的试运行也会直接失败。插件代码里没有任何网络调用�?|
| `filesystem:read` | 读取你指定目录下的歌单文件，并检查歌单引用的音频是否存在 |
| `settings` | 保存 §4 的配�?|
| `library:read` | 注册 `library` 能力�?provider 时宿主强制要�?|
| `ui:inject` | 注册设置面板 |

插件**不发起任何网络请�?*�?*不写任何文件**（回环代理是只读的）�?