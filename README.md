# MusicFree 插件：多源歌单（QQ音乐 + 网易云 + Audiomack）

一个 MusicFree 插件，把 **QQ音乐 / 网易云音乐 / Audiomack** 三个平台的歌单导入、搜索、播放聚合在一起，
并在原生源放不了的时候自动跨平台换源。

开发依据：[maotoumao/MusicFree](https://github.com/maotoumao/MusicFree) 的插件协议与宿主源码
（`src/core/pluginManager/plugin.ts`、`src/pages/searchPage/hooks/useSearch.ts`、`src/utils/mediaUtils.ts`）。

## 插件地址

在 MusicFree 里「我的 → 插件 → 从 URL 安装插件」，直接填下面这条：

```
https://raw.githubusercontent.com/linuxwff789/multi-source.js/main/multi-source.js
```

国内访问 `raw.githubusercontent.com` 不稳定时，用 jsDelivr 镜像（内容相同）：

```
https://cdn.jsdelivr.net/gh/linuxwff789/multi-source.js@main/multi-source.js
```

> 也可以把 `multi-source.js` 下载到手机后用「从本地安装」选择该文件。

## 特性


- **搜索**：一次查询并行打三个平台，结果按源轮流交错；同一首歌跨平台重复时自动合并成一条
- **导入歌单**：粘贴分享文本 / 链接 / 歌单 ID 即可，插件按域名自动分发
  - QQ音乐：`y.qq.com` 歌单地址、分享链接、纯歌单 ID
  - 网易云：`music.163.com` 地址、`163cn.tv` 短链、纯歌单 ID（整段分享文本直接粘）
  - Audiomack：`audiomack.com/<artist>/playlist/<slug>`、纯数字歌单 ID
- **播放**：原生源拿不到地址时自动换源（优先用搜索时合并进来的备选源，没有再实时搜）
- **歌词**：QQ / 网易云（Audiomack 无公开歌词接口）

## 安装到 MusicFree

1. 打开 MusicFree → 「我的」→「插件」→「从 URL 安装插件」
2. 填入插件文件直链：

   ```
   https://raw.githubusercontent.com/linuxwff789/multi-source.js/main/multi-source.js
   ```

3. 安装后进入插件设置，按需填写下面的配置项，然后启用。

也可以把 `multi-source.js` 下载到手机后，用「从本地安装」选择该文件。

## 配置项

| key | 说明 | 默认 |
| --- | --- | --- |
| `search_source` | 搜索源：`all` / `qq` / `netease` / `audiomack` | `all` |
| `fallback` | 跨平台换源开关 `on` / `off` | `on` |
| `merge` | 搜索结果同曲合并去重 `on` / `off` | `on` |
| `qq_cookie` | QQ音乐 Cookie（可选，用于 VIP 歌曲） | 空 |
| `ne_cookie` | 网易云 Cookie（可选，用于 VIP 歌曲） | 空 |

## 本地验证

```bash
npm install
node test-multi-source.js
```

测试会**真的访问三个平台的公开接口**，需要联网。用例覆盖：宿主沙箱加载、OAuth 签名固定向量、
多源搜索与合并、匹配规则（防翻唱/防伴奏）、三源歌单导入、播放地址、换源、请求超时覆盖。
网络不通或平台限制导致的用例会标 `SKIP` 而非 `FAIL`。

## 实现要点

### 为什么歌曲 id 要带平台前缀

宿主每次拿到插件返回值都会执行 `resetMediaItem(_, this.plugin.name)`，把 `platform` 字段**强制改写成插件名**。
所以一个插件聚合多个平台时，`platform` 无法用来区分来源，只能自带字段：

```js
id:      `qq:0039MnYb0qxYhV` / `ne:407862139` / `am:104577726`   // 单主键下全局唯一且可反解
source:  "qq" | "netease" | "audiomack"                          // 分发主依据
songmid / mediaMid / nid / amid                                  // 各平台原生 id，避免每次切字符串
```

宿主侧唯一键是 `platform + "@" + id`，platform 被统一后，唯一性完全靠 id 前缀。

### 三源接口（均为公开接口，无需登录）

| 用途 | QQ音乐 | 网易云 | Audiomack |
| --- | --- | --- | --- |
| 搜索 | `c.y.qq.com/soso/fcgi-bin/client_search_cp` | `music.163.com/api/search/get` | `/v1/search`（OAuth 签名） |
| 歌单详情 | `musicu.fcg` → `music.srfDissInfo.DissInfo/CgiGetDiss` | `api/v6/playlist/detail` | `/v1/playlist/{id}`（OAuth 签名） |
| 播放地址 | `musicu.fcg` → `vkey.GetVkeyServer/CgiGetVkey` | `api/song/enhance/player/url/v1` | `/v1/music/play/{id}`（OAuth 签名） |
| 歌词 | `lyric/fcgi-bin/fcg_query_lyric_new.fcg` | `api/song/lyric` | 无 |

踩过的坑都写在代码注释里了，主要有：

- **网易云 `c`/`ids` 参数有长度上限**：批量歌曲详情一次传 300 个 id（编码后约 8K 字符）正常，
  424 个（约 11.4K）会返回 `code:400 "请求解析失败!"` 且 HTTP 仍是 200 —— 不检查 `code` 就会静默丢歌。
  `/api/song/detail?ids=` 更糟：424 个只回 201 个，静默截断。所以批量用 100，并做折半重试。
- **「我喜欢的音乐」(`specialType: 5`) 等歌单，`tracks` 只是预览**：实测一个 430 首的歌单只内联 6 首，
  真实列表要以 `trackIds` 为准并按其顺序输出。
- **网易云不登录也能放 VIP 曲**：`url/v1` 带上 `Cookie: os=pc; appver=8.9.70;`，
  接口会把 VIP 曲按"客户端免费用户"返回 128k 地址；裸请求是 `code:-110`。
  代价是 `level` 被忽略、恒定 128k，要更高音质需要自备 cookie。
- **有条目但无 url 时不要退到 `outer/url`**：它会 302 到 `/404` 返回 HTML 页面，
  等于把网页当音频丢给播放器。应直接返回 `null`。
- **QQ音乐旧的歌单接口已废弃**：`qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg` 现在返回
  `{"code":0,"subcode":4000,"msg":"check privacy error!"}`，改用 `musicu.fcg` 的 `CgiGetDiss`。
- **Audiomack 官方插件取歌单的方式已失效**：它靠首页 `script#__NEXT_DATA__` 取 buildId 再拼
  `/_next/data/...json`，而站点已迁移到 Next.js App Router，首页不再有 `__NEXT_DATA__`。
  本插件改用播放页 RSC 流里的 `{"music":{"id":...}}` 提数字 id，再走开放 API。
- Audiomack 的公开 API 需要 OAuth1(HMAC-SHA1) 签名，consumer key/secret 从其前端 bundle 提取，
  实现与原官方插件逐字节一致（测试里有固定向量校验）。
- URL 里的 slug **不唯一**，且 URL 的 artist slug 与 API 返回的 `artist.url_slug` 不一定相同，
  所以只能用页面里提取的 id，不能拿搜索按 slug 反查。

### 宿主环境适配

- 宿主把插件体包成 `function(require, require, module, exports, console, env, URL, process){...}`，
  **`env` 是包装函数的参数而不是 `global.env`**，取用户变量要用裸 `env`。
- 宿主在 `plugin.ts` 里设了 `axios.defaults.timeout = 2000`，对跨平台请求太紧。
  插件内部包了一层 `http.get/http.post`，只给自己的请求设超时（搜索 7000ms，其余 12000ms），
  **不修改宿主的全局默认值**。
- `require` 只能拿到宿主白名单：`cheerio / crypto-js / axios / dayjs / big-integer / qs / he / webdav`。
  本插件只用到 `axios` 和 `crypto-js`，无需额外打包。

### 同曲合并与换源

- 合并：按归一化标题分桶，桶内用「标题一致 **且艺人重合**」判定，每组只出一条，其余挂到 `primary.alts`。
  主条目优先选非 VIP 且稳定源（`netease > qq > audiomack`）。
- 匹配规则（合并与换源共用）：
  - 双方**都有艺人但艺人不重合 → 直接淘汰**。否则"标题 + 时长"就能凑够阈值，会把翻唱放出来。
  - 版本标记拦截：`伴奏 / 纯伴奏 / 消音 / instrumental / off vocal / karaoke` 等命中即淘汰
    （标题归一化会剃掉括号内容，`如果寂寞了（伴奏）` 会被剃成 `如果寂寞了` 从而满分误命中）。
    `Live / Remix / DJ版` 不拦，那些只是不同演绎。
  - 艺人串分隔符做了兼容：`A / B`、`A、B`、`A, B`、`A&B`、`A feat. B` 都能对上。

## 实测

| 项目 | 结果 |
| --- | --- |
| 网易云分享文本导入（430 首歌单） | 430 首（= trackCount），无重复，封面/时长齐全 |
| QQ音乐歌单导入 | 66 首 |
| Audiomack 歌单导入 | 24 首 |
| 多源搜索「周杰伦 晴天」 | 45 条 → 合并后 38 条，同曲 8 条重复并成 1 条 |
| 「Taylor Swift Love Story」 | 跨 3 源合并（主 netease + 备选 audiomack,qq） |
| 歌单抽样 30 首播放 | 原生 26 / 换源救回 2 / 仍失败 2（93%） |

那 2 首失败是**正确的拒绝**：`你懂得`（QQ 有满分匹配但是 VIP，匿名拿不到地址）、
`如果寂寞了`（只有伴奏版，被版本标记拦掉）。放宽匹配能到 100%，但会放出翻唱/伴奏。

## 已知限制

- 只支持公开歌单；私密歌单需登录后才有权限
- 不填 cookie 时，网易云 VIP 曲最高 128k；QQ音乐 VIP 曲匿名完全拿不到地址（`result=104003`）
- Audiomack 有相当比例曲目是 Audiomack+ 独家，返回 403，插件会自动换源
- 换源后 UI 上显示的仍是原平台的标题/封面 —— `musicItem` 由宿主传入，插件无法修改
- 三源都是非官方公开接口，随时可能变动；本仓库不保证长期可用

## 免责声明

- 本插件仅供**学习与技术研究**使用，请勿用于任何商业用途。
- 插件使用各平台**公开可访问**的接口，不包含破解、不绕过付费墙、不提供 VIP 内容；
  付费/独家曲目在匿名状态下拿不到地址时会如实返回失败或换源。
- 所有音乐版权归各自权利人所有，请在能力范围内支持正版。
- 参考：MusicFree 官方插件仓库因收到告知函，已移除网易云/QQ音乐等国内源插件。
  若你要公开分发本插件，请自行评估合规风险。

## 说明

- `plugin._internal` 是调试用的内部函数导出（签名、匹配等），宿主会忽略未知键，
  测试脚本依赖它做固定向量校验；不需要可直接删除该行。

## License

MIT
