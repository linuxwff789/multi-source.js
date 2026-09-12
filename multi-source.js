/**
 * 多平台歌单导入插件（QQ音乐 + 网易云 + Audiomack）
 * MusicFree 插件协议：CommonJS 模块
 *
 * 设计要点：
 *  - 一个插件只有一个 platform，宿主 resetMediaItem 会把导入歌曲的 platform 强制改成它。
 *  - 所以平台区分不能靠 platform，必须自带 source 字段（"qq" | "netease" | "audiomack"）。
 *  - 歌曲 id 统一构造成 `${source}:${原生id}`，保证单主键下全局唯一、且能反解出源。
 */
const axios = require("axios");
const CryptoJS = require("crypto-js");

/**
 * 宿主在 plugin.ts 里设了 axios.defaults.timeout = 2000，对本插件这种
 * 「一次操作要打好几个平台的请求」来说太紧（尤其 audiomack 在国内访问常要 1-3s）。
 * 这里本地包一层，只给本插件的请求设更长的超时，**不去改宿主的全局默认值**。
 */
const REQ_TIMEOUT = 12000;
// 搜索是"谁慢谁拖累整轮"，单独给更短的超时：最坏情况只等这么久
const SEARCH_TIMEOUT = 7000;
const http = {
  get: (url, config) => axios({ method: "get", url, timeout: REQ_TIMEOUT, ...config }),
  post: (url, data, config) =>
    axios({ method: "post", url, data, timeout: REQ_TIMEOUT, ...config }),
  search: (url, config) =>
    axios({ method: "get", url, timeout: SEARCH_TIMEOUT, ...config }),
  searchPost: (url, data, config) =>
    axios({ method: "post", url, data, timeout: SEARCH_TIMEOUT, ...config }),
};

const QQ_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const NE_UA = QQ_UA;
const AM_UA = QQ_UA;

const QQ_HEADERS = { "User-Agent": QQ_UA, Referer: "https://y.qq.com/" };
const NE_HEADERS = { "User-Agent": NE_UA, Referer: "https://music.163.com/" };
const AM_HEADERS = {
  "User-Agent": AM_UA,
  origin: "https://audiomack.com",
  referer: "https://audiomack.com/",
};

const QQ_PAGE_SIZE = 1000;
// 换源命中时，把实际播放的来源挂在结果上（调试/展示用，宿主会忽略未知键）
const _FALLBACK_FROM = "_fallbackFrom";
// netease 的 c 参数有长度上限：300 个 id（编码后约 8K 字符）还行，
// 424 个（约 11.4K）会返回 code:400 "请求解析失败!"，所以留足余量用 100。
const NE_BATCH = 100;

/* ------------------------------ 通用工具 ------------------------------ */

/**
 * 取宿主注入的 env。
 * 宿主把插件体包成 function(require, require, module, exports, console, env, URL, process){...}，
 * 所以 env 是**包装函数的参数**、不是 global.env（官方插件全都直接用裸 env）。
 * typeof 判断可避免 env 未声明时抛 ReferenceError。
 */
function getEnv() {
  try {
    if (typeof env !== "undefined" && env) return env;
  } catch (e) {}
  try {
    if (typeof global !== "undefined" && global.env) return global.env;
  } catch (e) {}
  return null;
}

function getUserVariables() {
  try {
    const e = getEnv();
    return (e && e.getUserVariables && e.getUserVariables()) || {};
  } catch (e) {
    return {};
  }
}

function joinArtists(list) {
  if (!list) return "";
  return list
    .map(x => (typeof x === "string" ? x : x && (x.name || x.nickname)))
    .filter(Boolean)
    .join(" / ");
}

/** 提取歌单 id：支持纯 id / URL / 整段分享文本 */
function pickId(urlLike, patterns) {
  const text = String(urlLike || "");
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

const QQ_ID_PATTERNS = [
  /[?&](?:disstid|id)=(\d{5,})/i,
  /\/playlist\/(\d{5,})/i,
  /\/taoge\/[^?]*\?[^#]*id=(\d{5,})/i,
  /^\s*(\d{5,})\s*$/,
];

const NE_ID_PATTERNS = [
  /[?&#](?:id|playlistId)=(\d{5,})/i,
  /\/playlist\/(\d{5,})/i,
  /^\s*(\d{5,})\s*$/,
];

/** 短链一般是 302/JS 跳转，跟一次再用正则兜底 */
async function resolveShortLink(url, headers, extraPatterns) {
  try {
    const res = await http.get(url, {
      headers,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    const finalUrl = (res.request && res.request.res && res.request.res.responseUrl) || "";
    let id = pickId(finalUrl, extraPatterns);
    if (id) return id;
    const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data || "");
    id = pickId(body, extraPatterns);
    return id || null;
  } catch (e) {
    return null;
  }
}

/* ------------------------------ QQ 音乐 ------------------------------ */

function qqAlbumCover(album) {
  const mid = (album && (album.pmid || album.mid)) || "";
  return mid ? `https://y.qq.com/music/photo_new/T002R300x300M000${mid}.jpg` : "";
}

function formatQQSong(s) {
  return {
    id: `qq:${s.mid}`,
    source: "qq",
    songmid: s.mid,
    // 播放要用的 media_mid（文件名里的 mid，和 songmid 不一定相同）
    mediaMid: (s.file && s.file.media_mid) || s.mid,
    title: s.name || s.title || "",
    artist: joinArtists(s.singer),
    album: (s.album && s.album.name) || "",
    duration: Number(s.interval) || 0,
    artwork: qqAlbumCover(s.album),
    // 付费/试听标记，宿主入库后可以用来提示
    pay: (s.pay && s.pay.pay_play) || 0,
  };
}

/** 现代接口 musicu.fcg CgiGetDiss（免登录可取公开歌单元数据） */
async function qqFetchPage(disstid, begin, cookie) {
  const body = {
    comm: { ct: 20, cv: 1846, uin: "0", format: "json" },
    req: {
      module: "music.srfDissInfo.DissInfo",
      method: "CgiGetDiss",
      param: {
        disstid: Number(disstid),
        dirid: 0,
        tag: 1,
        song_begin: begin,
        song_num: QQ_PAGE_SIZE,
        userinfo: 1,
        orderlist: 1,
        onlysonglist: 0,
        pic: 1,
        pic_size: 800,
      },
    },
  };
  const res = await http.post("https://u.y.qq.com/cgi-bin/musicu.fcg", body, {
    headers: {
      ...QQ_HEADERS,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  const data = (res.data && res.data.req && res.data.req.data) || {};
  return {
    dirinfo: data.dirinfo || {},
    songlist: data.songlist || [],
    total: Number(data.total_song_num) || 0,
  };
}

async function importQQ(urlLike) {
  const { qq_cookie } = getUserVariables();
  let disstid = pickId(urlLike, QQ_ID_PATTERNS);
  if (!disstid && /^https?:\/\//i.test(String(urlLike))) {
    disstid = await resolveShortLink(String(urlLike), QQ_HEADERS, QQ_ID_PATTERNS);
  }
  if (!disstid) return null;

  const first = await qqFetchPage(disstid, 0, qq_cookie);
  let songs = first.songlist.slice();

  const total = first.total || songs.length;
  while (songs.length < total && first.songlist.length > 0) {
    const next = await qqFetchPage(disstid, songs.length, qq_cookie);
    if (!next.songlist.length) break;
    songs = songs.concat(next.songlist);
  }

  if (!songs.length) return null;
  return songs.map(formatQQSong);
}

/* ------------------------------ 网易云音乐 ------------------------------ */

function neSongToItem(t) {
  // v6/playlist/detail 的 tracks 可能是 legacy(artists/album/duration) 也可能是新格式(ar/al/dt)
  const artists = t.ar || t.artists || [];
  const album = t.al || t.album || {};
  const durationMs = t.dt != null ? t.dt : t.duration;
  return {
    id: `ne:${t.id}`,
    source: "netease",
    nid: t.id,
    title: t.name || "",
    artist: joinArtists(artists),
    album: album.name || "",
    duration: Math.round((Number(durationMs) || 0) / 1000),
    artwork: album.picUrl || "",
    // fee: 0 免费 / 1 VIP / 4 购买专辑 / 8 低音质免费
    pay: t.fee,
  };
}

/** 单批拉取；失败（code!==200）就折半重试，避免长参数导致整批静默丢失 */
async function neFetchChunk(ids, cookie, depth = 0) {
  if (!ids.length) return [];
  try {
    const res = await http.get("https://music.163.com/api/v3/song/detail", {
      headers: { ...NE_HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
      params: { c: JSON.stringify(ids.map(id => ({ id }))) },
      validateStatus: () => true,
    });
    const body = res.data || {};
    const songs = Array.isArray(body.songs) ? body.songs : null;
    // code 正常即可信：songs 比 ids 少是正常的（歌曲被删/下架会被过滤）
    if (res.status === 200 && body.code === 200 && songs) return songs;
    console.log(`[NE] 批量详情 code=${body.code} status=${res.status} ids=${ids.length}，折半重试`);
  } catch (e) {
    console.log("[NE] 批量详情异常:", e.message);
  }
  if (ids.length === 1 || depth >= 6) return [];
  const mid = Math.ceil(ids.length / 2);
  return [
    ...(await neFetchChunk(ids.slice(0, mid), cookie, depth + 1)),
    ...(await neFetchChunk(ids.slice(mid), cookie, depth + 1)),
  ];
}

async function neBatchDetail(ids, cookie) {
  const out = [];
  for (let i = 0; i < ids.length; i += NE_BATCH) {
    out.push(...(await neFetchChunk(ids.slice(i, i + NE_BATCH), cookie)));
  }
  return out;
}


async function importNetease(urlLike) {
  const { ne_cookie } = getUserVariables();
  let pid = pickId(urlLike, NE_ID_PATTERNS);
  if (!pid && /^https?:\/\//i.test(String(urlLike))) {
    pid = await resolveShortLink(String(urlLike), NE_HEADERS, NE_ID_PATTERNS);
  }
  if (!pid) return null;

  const res = await http.post(
    "https://music.163.com/api/v6/playlist/detail",
    `id=${pid}&n=1000&s=0`,
    {
      headers: {
        ...NE_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        ...(ne_cookie ? { Cookie: ne_cookie } : {}),
      },
    },
  );
  const pl = (res.data && res.data.playlist) || {};
  const tracks = pl.tracks || [];
  const trackIds = (pl.trackIds || []).map(x => x.id);

  // 「我喜欢的音乐」(specialType=5) 等大歌单，tracks 只是前几首的预览，
  // 真实列表要以 trackIds 为准，缺的用批量详情补。
  const byId = new Map();
  tracks.forEach(t => byId.set(t.id, t));

  if (trackIds.length > tracks.length) {
    const missing = trackIds.filter(id => !byId.has(id));
    if (missing.length) {
      const extra = await neBatchDetail(missing, ne_cookie);
      extra.forEach(s => byId.set(s.id, s));
    }
  }

  // 按 trackIds 的顺序输出（歌单顺序），拿不到详情的跳过
  const order = trackIds.length ? trackIds : tracks.map(t => t.id);
  const songs = order.map(id => byId.get(id)).filter(Boolean);

  if (!songs.length) return null;
  return songs.map(neSongToItem);
}

/* ------------------------------ Audiomack ------------------------------ */
/**
 * Audiomack 的 API 需要 OAuth1(HMAC-SHA1) 签名，consumer key/secret 是从其前端
 * bundle 里提取的固定值（官方 MusicFree 插件同样用法）。
 * 注意：官方插件的 getMusicSheetInfo 靠爬 __NEXT_DATA__/_next/data 已经失效
 * （站点迁到 Next.js App Router 了），这里改成从播放页 RSC 流里提 id 再走 API。
 */
const AM_CONSUMER_KEY = "audiomack-js";
const AM_CONSUMER_SECRET = "f3ac5b086f3eab260520d8e3049561e6";

function amNonce(e = 10) {
  const n = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let r = "";
  for (let i = 0; i < e; i++) r += n.charAt(Math.floor(Math.random() * n.length));
  return r;
}

/** 与 OAuth1 规范一致的百分号编码（不依赖全局 escape） */
function amEncode(v) {
  if (v === undefined || v === null) return "";
  return encodeURIComponent(String(v))
    .replace(/[!'()]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/\*/g, "%2A");
}

/** 归一化参数：key 编码后排序，value 数组内部排序，逐个展开成 k=v 再用 & 连接 */
function amNormalizedParams(params) {
  const keys = Object.keys(params).map(amEncode).sort();
  const pairs = [];
  for (const k of keys) {
    const values = params[decodeURIComponent(k)];
    (Array.isArray(values) ? [...values].sort() : [values]).forEach(v =>
      pairs.push(`${k}=${amEncode(v)}`)
    );
  }
  return pairs.join("&");
}

function amSign(method, urlPath, params, secret = AM_CONSUMER_SECRET) {
  // 签名原文里的各段本身要被编码，故先还原再交给 amEncode
  const normd = amNormalizedParams(params);
  const base =
    amEncode(method.toUpperCase()) +
    "&" +
    amEncode("https://api.audiomack.com/v1" + urlPath.split("?")[0]) +
    "&" +
    amEncode(normd);
  return CryptoJS.HmacSHA1(base, secret + "&").toString(CryptoJS.enc.Base64);
}

async function amSignedGet(path, extra = {}, timeout = REQ_TIMEOUT) {
  const params = {
    oauth_consumer_key: AM_CONSUMER_KEY,
    oauth_nonce: amNonce(32),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.round(Date.now() / 1e3),
    oauth_version: "1.0",
    ...extra,
  };
  const oauth_signature = amSign("GET", path, params);
  const res = await http.get("https://api.audiomack.com/v1" + path, {
    headers: AM_HEADERS,
    params: { ...params, oauth_signature },
    timeout,
    // 403(独家/地区限制) 401(签名) 都不该抛异常，交给调用方判断
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    console.log(`[AM] ${path} -> HTTP ${res.status}`);
    return null;
  }
  return res.data;
}


/** 从播放页的 RSC 流里提歌单/专辑数字 id */
function amExtractMusicId(html) {
  const m = String(html).match(/\\"music\\":\{\\"id\\":(\d+)/);
  return m ? m[1] : null;
}

function formatAMSong(t) {
  return {
    id: `am:${t.id}`,
    source: "audiomack",
    amid: t.id,
    title: t.title || "",
    artist: t.artist || "",
    album: (t.album_details && t.album_details.title) || t.album || "",
    duration: Number(t.duration) || 0,
    artwork: t.image || t.image_base || "",
    // premium_user_only 是 "yes"/"no" 字符串，统一成 0/1
    pay: t.premium_user_only === "yes" || t.premium_user_only === 1 ? 1 : 0,
    url_slug: t.url_slug,
  };
}

async function importAudiomack(urlLike) {
  const text = String(urlLike || "");
  let pid = null;

  // 直接给数字 id
  const raw = text.match(/^\s*(\d{5,})\s*$/);
  if (raw) pid = raw[1];

  if (!pid && /audiomack\.com/i.test(text)) {
    const url = text.match(/https?:\/\/[^\s"'<>]+/i);
    if (url) {
      const res = await http.get(url[0], {
        headers: { "User-Agent": AM_UA },
        maxRedirects: 5,
        validateStatus: () => true,
      });
      if (typeof res.data === "string") pid = amExtractMusicId(res.data);
    }
  }
  if (!pid) return null;

  const data = await amSignedGet(`/playlist/${pid}`);
  const pl = data && data.results;
  if (!pl || !pl.tracks || !pl.tracks.length) return null;
  return pl.tracks.map(formatAMSong);
}

/* ------------------------------ 搜索（多源聚合） ------------------------------ */
/**
 * 宿主搜索流程（useSearch.ts）：
 *   没指定插件 -> PluginManager.getSearchablePlugins() -> forEach 并行调每个插件的 search
 *   结果按 plugin.hash 分开存 searchResults[type][hash]
 *   UI(resultSubPanel) 按插件开 Tab，Tab 标题 = platform
 * 所以：一个插件 = 一个 Tab。插件内部聚合 N 个源，结果都在同一个 Tab 里。
 */

const SEARCH_PAGE_SIZE = 20;

async function searchQQ(query, page) {
  const res = await http.search("https://c.y.qq.com/soso/fcgi-bin/client_search_cp", {
    headers: QQ_HEADERS,
    params: { p: page, n: SEARCH_PAGE_SIZE, w: query, format: "json", t: 0, new_json: 1 },
  });
  const song = ((res.data || {}).data || {}).song || {};
  const list = song.list || [];
  const total = Number(song.totalnum) || 0;
  return {
    data: list.map(formatQQSong),
    isEnd: !list.length || (total > 0 && total <= page * SEARCH_PAGE_SIZE),
  };
}

async function searchNetease(query, page) {
  const offset = (page - 1) * SEARCH_PAGE_SIZE;
  const res = await http.search("https://music.163.com/api/search/get", {
    headers: NE_HEADERS,
    params: { s: query, type: 1, offset, limit: SEARCH_PAGE_SIZE },
  });
  const result = (res.data || {}).result || {};
  const songs = result.songs || [];
  const total = Number(result.songCount) || 0;

  const data = songs.map(s => {
    const album = s.album || {};
    return {
      id: `ne:${s.id}`,
      source: "netease",
      nid: s.id,
      title: s.name || "",
      artist: joinArtists(s.artists),
      album: album.name || "",
      duration: Math.round((Number(s.duration) || 0) / 1000),
      // 搜索接口的 album 只有 picId，没有 picUrl，下面批量补
      artwork: album.picUrl || "",
      pay: s.fee,
    };
  });

  // 搜索结果缺封面，用 v3/song/detail 批量补 picUrl（一次请求）
  if (data.length && data.some(x => !x.artwork)) {
    try {
      const detail = await neBatchDetail(
        data.map(x => x.nid),
        null
      );
      const byId = {};
      detail.forEach(s => {
        const al = s.al || s.album || {};
        byId[s.id] = al.picUrl || "";
      });
      data.forEach(x => {
        if (!x.artwork && byId[x.nid]) x.artwork = byId[x.nid];
      });
    } catch (e) {
      /* 补封面失败不影响搜索 */
    }
  }

  return {
    data,
    isEnd: !songs.length || (total > 0 && offset + songs.length >= total),
  };
}


async function searchAudiomack(query, page) {
  const data = await amSignedGet(
    "/search",
    { q: query, show: "music", sort: "popular", limit: SEARCH_PAGE_SIZE, page },
    SEARCH_TIMEOUT
  );
  const r = (data && data.results) || {};
  const list = Array.isArray(r) ? r : r.music || [];
  return {
    data: list.map(formatAMSong),
    isEnd: list.length < SEARCH_PAGE_SIZE,
  };
}

/** 轮流取各源，避免某一源把列表头部霸屏 */
function interleave(lists) {
  const out = [];
  const max = Math.max(0, ...lists.map(l => l.length));
  for (let i = 0; i < max; i++) {
    for (const l of lists) {
      if (l[i]) out.push(l[i]);
    }
  }
  return out;
}

/* ------------------------------ 跨平台兜底（换源播放） ------------------------------ */
/**
 * 原生源拿不到播放地址时，去其它平台找同一首歌，用别的源的地址播。
 * 匹配靠「标题 + 艺人 + 时长」三重校验，避免放错歌。
 */

const FALLBACK_ORDER = {
  qq: ["netease", "audiomack"],
  netease: ["qq", "audiomack"],
  audiomack: ["netease", "qq"],
};

/** 归一化：去掉括号内容/标点/空格，便于比对 */
function normText(s) {
  return String(s || "")
    .replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]|【[^】]*】/g, "")
    .toLowerCase()
    .replace(/[\s\-_·、,，.。!！?？:：;；'"“”‘’~《》<>]/g, "");
}

/** 切分艺人串，兼容 "A / B"、"A, B"、"A&B"、"A、B" */
function splitArtists(s) {
  return String(s || "")
    .split(/[/,&、;；]|\s+feat\.?\s+|\s+ft\.?\s+/i)
    .map(normText)
    .filter(Boolean);
}

/**
 * 明确「不是同一录音」的标记。标题归一化会剃掉括号内容，
 * 于是「如果寂寞了（伴奏）」会和「如果寂寞了」变得一模一样，
 * 艺人又相同时就会满分命中，结果放出伴奏/消音版。这里单独拦一道。
 * （Live / Remix / DJ版 之类不拦，只是不同演绎，仍可接受）
 */
const VERSION_BLOCK =
  /伴奏|纯伴奏|消音|无人声|instrumental|off\s*vocal|offvocal|karaoke|カラオケ/i;

function isBlockedVersion(target, cand) {
  const t = String(target.title || "");
  const c = String(cand.title || "");
  return VERSION_BLOCK.test(c) && !VERSION_BLOCK.test(t);
}

/** 打分：标题命中 1 分，艺人重合 +2，时长接近 +3，时长差太多 -2；>=3 才认。
 *  关键规则：**双方都有艺人但艺人不重合 → 直接淘汰（0 分）**，
 *  否则会拿"标题+时长"凑够分，把翻唱/钢琴版当成原曲放出来。 */
function matchScore(target, cand) {
  const nt = normText(target.title);
  const nc = normText(cand.title);
  if (!nt || !nc) return 0;
  const titleOk = nt === nc || nc.includes(nt) || nt.includes(nc);
  if (!titleOk) return 0;
  if (isBlockedVersion(target, cand)) return 0;

  let score = 1;
  const aA = splitArtists(target.artist);
  const aB = splitArtists(cand.artist);
  const bothHaveArtists = aA.length > 0 && aB.length > 0;
  const artistOk =
    bothHaveArtists && aA.some(x => aB.some(y => x.includes(y) || y.includes(x)));
  if (artistOk) score += 2;
  // 都有艺人却对不上，说明是翻唱/同曲不同人 → 淘汰
  if (bothHaveArtists && !artistOk) return 0;

  if (target.duration && cand.duration) {
    const diff = Math.abs(target.duration - cand.duration);
    const tol = Math.max(5, Math.max(target.duration, cand.duration) * 0.08);
    score += diff <= tol ? 3 : -2;
  }
  return score;
}

/** 按 item.source 取播放地址（原生和兜底共用） */
async function getSourceBySource(item, quality, cookies = {}) {
  if (!item) return null;
  if (item.source === "qq") return await getQQMediaSource(item, quality, cookies.qq);
  if (item.source === "netease") return await getNEMediaSource(item, quality, cookies.ne);
  if (item.source === "audiomack") return await getAMMediaSource(item);
  return null;
}

async function searchOneSource(source, query, page = 1) {
  if (source === "qq") return (await searchQQ(query, page)).data;
  if (source === "netease") return (await searchNetease(query, page)).data;
  if (source === "audiomack") return (await searchAudiomack(query, page)).data;
  return [];
}

/** 换源结果缓存：记住 key -> 命中的候选曲，避免同一首歌反复搜（URL 会过期，只缓存 item） */
const _altCache = new Map();
const ALT_TTL = 30 * 60 * 1000;

function altCacheGet(key) {
  const v = _altCache.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > ALT_TTL) {
    _altCache.delete(key);
    return null;
  }
  return v.item;
}

function altCacheSet(key, item) {
  // 简单的容量控制，别让 Map 无限涨
  if (_altCache.size > 200) {
    const oldest = [..._altCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) _altCache.delete(oldest[0]);
  }
  _altCache.set(key, { item, ts: Date.now() });
}

/** 换源：按 FALLBACK_ORDER 依次找，每个源取分数最高的几个候选试 */
async function findAlternative(musicItem, quality, cookies) {
  const cacheKey = `${musicItem.source}:${musicItem.id}`;
  const cached = altCacheGet(cacheKey);
  if (cached) {
    const hit = await getSourceBySource(cached, quality, cookies).catch(() => null);
    if (hit && hit.url) return { ...hit, [_FALLBACK_FROM]: cached };
    _altCache.delete(cacheKey);
  }

  const order = FALLBACK_ORDER[musicItem.source] || [];
  // 先用「标题 + 艺人」精确搜，搜不到再退回只用标题
  const queries = [
    [musicItem.title, musicItem.artist].filter(Boolean).join(" "),
    String(musicItem.title || ""),
  ].filter((q, i, arr) => q && arr.indexOf(q) === i);
  if (!queries.length) return null;

  for (const query of queries) {
    for (const src of order) {
      let list = [];
      try {
        list = await searchOneSource(src, query);
      } catch (e) {
        console.log(`[换源] ${src} 搜索 "${query}" 失败:`, e.message);
        continue;
      }
      const ranked = list
        .map(x => ({ item: x, score: matchScore(musicItem, x) }))
        .filter(c => c.score >= 3)
        .sort((a, b) => b.score - a.score);

      for (const c of ranked.slice(0, 3)) {
        const url = await getSourceBySource(c.item, quality, cookies).catch(() => null);
        if (url && url.url) {
          console.log(
            `[换源] "${musicItem.title}" 播放失败 → 用 ${src} 的 "${c.item.title}" (score=${c.score}, ${c.item.duration}s, 查:"${query}")`
          );
          altCacheSet(cacheKey, c.item);
          return { ...url, [_FALLBACK_FROM]: c.item };
        }
      }
    }
  }
  return null;
}

/* ------------------------------ 搜索结果合并去重 ------------------------------ */
/**
 * 同一个曲子在不同平台会重复出现（周杰伦 晴天 在三个源里都有）。
 * 这里按「标题 + 艺人/时长」聚类，每组只留一条，其余挂到 primary.alts 上，
 * 播放时原生放不了就用 alts 里的备选源（见 getMediaSource）。
 * alts 是自定义字段，宿主入库是整对象 JSON.stringify，会保留。
 */

// 主条目优先选哪个源（越靠前越优先）；再优先非 VIP（可播概率高）
const MERGE_SOURCE_PRIORITY = ["netease", "qq", "audiomack"];

function mergePreferScore(item) {
  const p = MERGE_SOURCE_PRIORITY.indexOf(item.source);
  // 无专辑信息的条目多半是翻录/盗传（正版发行必有专辑名），降权
  return (item.pay === 1 ? 10 : 0) + (String(item.album || "").trim() ? 0 : 5) + (p < 0 ? 99 : p);
}

/** 合并判定：必须标题一致 **且艺人重合**（时长只用来排除离谱的）
 *  注意不能直接复用 matchScore —— 那个规则里"时长接近"单独就够阈值，
 *  会把不同歌手的同曲翻唱并成一条。 */
function sameTrack(a, b) {
  const nt = normText(a.title);
  const nc = normText(b.title);
  if (!nt || !nc) return false;
  if (!(nt === nc || nc.includes(nt) || nt.includes(nc))) return false;
  if (isBlockedVersion(a, b) || isBlockedVersion(b, a)) return false;

  const aA = splitArtists(a.artist);
  const aB = splitArtists(b.artist);
  const artistOk =
    aA.length && aB.length && aA.some(x => aB.some(y => x.includes(y) || y.includes(x)));
  if (!artistOk) return false;

  if (a.duration && b.duration) {
    // 容差 5s/5%：10% 会把 253s 的翻录版和 270s 正版(范特西)并成一组
    const diff = Math.abs(a.duration - b.duration);
    const tol = Math.max(5, Math.max(a.duration, b.duration) * 0.05);
    if (diff > tol) return false;
  }
  return true;
}

function mergeSameTracks(items) {
  const groups = [];
  for (const it of items) {
    const key = normText(it.title);
    let target = null;
    for (const g of groups) {
      if (g.key !== key) continue;
      if (g.members.some(m => sameTrack(m, it))) {
        target = g;
        break;
      }
    }
    if (target) target.members.push(it);
    else groups.push({ key, members: [it] });
  }

  return groups.map(g => {
    if (g.members.length === 1) return g.members[0];
    const sorted = g.members.slice().sort((a, b) => mergePreferScore(a) - mergePreferScore(b));
    const primary = sorted[0];

    // 备选只保留**其它源**的、每源最多一条（同源重复没有换源价值）
    const seenSrc = new Set([primary.source]);
    const alts = [];
    for (const m of sorted.slice(1)) {
      if (seenSrc.has(m.source)) continue;
      seenSrc.add(m.source);
      alts.push(m);
      if (alts.length >= 3) break;
    }

    const out = { ...primary, _mergedCount: g.members.length };
    if (alts.length) out.alts = alts;
    return out;
  });
}

/* ------------------------------ 插件导出 ------------------------------ */

module.exports = {
  platform: "多源歌单",
  version: "0.1.1",
  appVersion: ">=0.0",
  cacheControl: "no-cache",
  // id 已带 source 前缀，单主键即可全局唯一
  primaryKey: ["id"],
  // 声明后宿主会按类型筛选：搜索页只在「音乐」Tab 下出现本插件
  supportedSearchType: ["music"],
  defaultSearchType: "music",
  userVariables: [
    { key: "search_source", name: "搜索源：all / qq / netease / audiomack（默认 all）" },
    { key: "fallback", name: "跨平台换源：on / off（默认 on。原生源放不了时去别的平台找同一首歌）" },
    { key: "merge", name: "搜索结果合并去重：on / off（默认 on。同一首歌只显示一条，其余源作为备选）" },
    { key: "qq_cookie", name: "QQ音乐 Cookie（可选，用于 VIP 歌曲）" },
    { key: "ne_cookie", name: "网易云 Cookie（可选，用于 VIP 歌曲）" },
  ],
  hints: {
    importMusicSheet: [
      "QQ音乐：分享 → 复制链接，或直接粘贴歌单ID；网页版 y.qq.com 歌单地址均可",
      "网易云：分享 → 复制链接（含 163cn.tv 短链），或直接粘贴歌单ID",
      "Audiomack：粘贴歌单页地址 https://audiomack.com/<artist>/playlist/<slug>，或直接粘贴数字歌单ID",
      "只支持公开歌单；私密/付费内容需要对应平台登录后才能访问",
    ],
  },

  /**
   * 搜索：插件内部聚合三个源。
   * 注意宿主是按插件分 Tab 的，所以这三家的结果会出现在同一个 Tab 里，
   * 想分开就得拆成多个插件（每个插件一个 platform）。
   */
  async search(query, page, type) {
    if (type && type !== "music") {
      return { isEnd: true, data: [] };
    }
    const vars = getUserVariables();
    const which = String(vars.search_source || "all").trim().toLowerCase();

    const plan = [];
    if (which === "all" || which === "qq") plan.push(searchQQ(query, page));
    if (which === "all" || which === "netease" || which === "ne") plan.push(searchNetease(query, page));
    if (which === "all" || which === "audiomack" || which === "am") plan.push(searchAudiomack(query, page));
    if (!plan.length) return { isEnd: true, data: [] };

    const settled = await Promise.all(
      plan.map(p =>
        p.catch(e => {
          console.log("[search] 源失败:", e && e.message);
          return { data: [], isEnd: true };
        })
      )
    );

    const merged = interleave(settled.map(r => r.data || []));
    // 合并开关（默认开）：同一首歌在多个源出现时只留一条，备选源挂 alts
    const merge = String(vars.merge ?? "on").trim().toLowerCase();
    const noMerge = merge === "off" || merge === "false" || merge === "0";

    return {
      // 所有源都到头了才算 end，否则宿主就不给翻下一页了
      isEnd: settled.every(r => r.isEnd),
      data: noMerge ? merged : mergeSameTracks(merged),
    };
  },

  /** 导入歌单：按链接特征分发 */
  async importMusicSheet(urlLike) {
    const text = String(urlLike || "");
    const looksQQ = /qq\.com|qqmusic|qq\.cc/i.test(text);
    const looksNE = /163\.cn|163\.com|music\.163/i.test(text);
    const looksAM = /audiomack/i.test(text);

    if (looksAM) return (await importAudiomack(urlLike)) || [];
    if (looksQQ && !looksNE) return (await importQQ(urlLike)) || (await importNetease(urlLike)) || [];
    if (looksNE && !looksQQ) return (await importNetease(urlLike)) || (await importQQ(urlLike)) || [];

    // 没域名信息（纯 id 或纯文本），三家都试
    for (const fn of [importNetease, importQQ, importAudiomack]) {
      const r = await fn(urlLike).catch(() => null);
      if (r && r.length) return r;
    }
    return [];
  },

  /** 播放地址：先原生源，失败则按开关去别的平台换源 */
  async getMediaSource(musicItem, quality) {
    const vars = getUserVariables();
    const cookies = { qq: vars.qq_cookie, ne: vars.ne_cookie };

    // 1. 原生源
    const native = await getSourceBySource(musicItem, quality, cookies).catch(e => {
      console.log("[原生源] 异常:", e && e.message);
      return null;
    });
    if (native && native.url) return native;

    // 2. 换源（默认开，userVariables 里填 off 可关掉）
    const fb = String(vars.fallback ?? "on").trim().toLowerCase();
    if (fb === "off" || fb === "false" || fb === "0") return null;

    // 2a. 优先用搜索合并时挂上的备选源（同一首歌在别的平台的副本，不用再搜一遍）
    if (Array.isArray(musicItem.alts) && musicItem.alts.length) {
      for (const alt of musicItem.alts) {
        const r = await getSourceBySource(alt, quality, cookies).catch(() => null);
        if (r && r.url) {
          console.log(`[换源] "${musicItem.title}" 用搜索合并的备选源 ${alt.source}`);
          return { ...r, [_FALLBACK_FROM]: alt };
        }
      }
    }

    // 2b. 现场搜索换源
    return await findAlternative(musicItem, quality, cookies).catch(e => {
      console.log("[换源] 异常:", e && e.message);
      return null;
    });
  },

  /** 歌词：按 source 分发（Audiomack 无公开歌词接口） */
  async getLyric(musicItem) {
    try {
      if (musicItem.source === "qq") {
        const res = await http.get(
          "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg",
          {
            headers: QQ_HEADERS,
            params: {
              songmid: musicItem.songmid,
              format: "json",
              nobase64: 1,
              g_tk: 5381,
            },
          },
        );
        const lyric = (res.data && res.data.lyric) || "";
        return lyric ? { rawLrc: lyric } : null;
      }
      if (musicItem.source === "netease") {
        const res = await http.get("https://music.163.com/api/song/lyric", {
          headers: NE_HEADERS,
          params: { id: musicItem.nid, lv: 1, kv: 1, tv: -1 },
        });
        const lyric = (res.data && res.data.lrc && res.data.lrc.lyric) || "";
        return lyric ? { rawLrc: lyric } : null;
      }
    } catch (e) {
      return null;
    }
    return null;
  },
};

/* ------------------------------ 播放地址实现 ------------------------------ */

async function getQQMediaSource(musicItem, quality, cookie) {
  const mid = musicItem.songmid;
  if (!mid) return null;
  const res = await http.post(
    "https://u.y.qq.com/cgi-bin/musicu.fcg",
    {
      comm: { uin: "0", format: "json", ct: 24, cv: 0 },
      req: {
        module: "vkey.GetVkeyServer",
        method: "CgiGetVkey",
        param: {
          guid: "10000",
          songmid: [mid],
          songtype: [0],
          uin: "0",
          loginflag: 1,
          platform: "20",
        },
      },
    },
    {
      headers: {
        ...QQ_HEADERS,
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    },
  );
  const data = (res.data && res.data.req && res.data.req.data) || {};
  const info = (data.midurlinfo || [])[0] || {};
  if (!info.purl) {
    // 104003 = 需要登录 / 无权限（VIP、版权限制）
    console.log("[QQ] 无播放地址, result =", info.result);
    return null;
  }
  const sip = (data.sip || [])[0] || "";
  const host = sip.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return {
    url: `${sip.replace(/\/$/, "")}/${info.purl}`,
    headers: {
      "User-Agent": QQ_UA,
      Referer: "https://y.qq.com/",
      Host: host,
    },
  };
}

async function getNEMediaSource(musicItem, quality, cookie) {
  const level =
    quality === "super" ? "lossless" : quality === "high" ? "exhigh" : "standard";
  // 关键：不登录时带上 os=pc/appver，接口才会把 VIP 曲当"客户端免费用户"返回 128k 地址；
  // 裸请求对这些曲直接 code=-110。代价是最高只给 128k（level 会被忽略）。
  const BASE_COOKIE = "os=pc; appver=8.9.70;";
  const cookieHeader = cookie ? `${BASE_COOKIE} ${cookie}` : BASE_COOKIE;
  const res = await http.get(
    "https://music.163.com/api/song/enhance/player/url/v1",
    {
      headers: { ...NE_HEADERS, Cookie: cookieHeader },
      params: { ids: JSON.stringify([musicItem.nid]), level, encodeType: "mp3" },
      validateStatus: () => true,
    },
  );
  const data = (res.data && res.data.data) || [];
  const d = data[0];

  if (d && d.url) {
    return { url: d.url, headers: { "User-Agent": NE_UA, Referer: "https://music.163.com/" } };
  }

  // 有条目但没 url = 明确受限（-110 / VIP / 地区），
  // 这时千万别退到 outer/url —— 它会 302 到 /404，返回 HTML 页面，
  // 等于把网页当音频丢给播放器。直接返回 null 让宿主报"无法播放"。
  if (d) {
    console.log(
      `[NE] 无播放地址 code=${d.code} fee=${d.fee} level=${d.level}（VIP/版权/地区限制）`
    );
    return null;
  }

  // 连条目都没有（接口异常）才用外链兜底
  const outer = `https://music.163.com/song/media/outer/url?id=${musicItem.nid}.mp3`;
  return {
    url: outer,
    headers: { "User-Agent": NE_UA, Referer: "https://music.163.com/" },
  };
}


async function getAMMediaSource(musicItem) {
  const id = musicItem.amid || String(musicItem.id || "").split(":")[1];
  if (!id) return null;
  const data = await amSignedGet(`/music/play/${id}`, {
    environment: "desktop-web",
    hq: true,
    section: "/search",
  });
  if (!data || !data.signedUrl) {
    // Audiomack+ 独家 / 地区限制
    console.log("[AM] 无播放地址（可能是 Audiomack+ 独家曲目）");
    return null;
  }
  return { url: data.signedUrl };
}

/* 调试用：暴露内部函数（宿主会忽略未知键），不需要可删掉这段 */
module.exports._internal = {
  amSign, amEncode, amNormalizedParams, amExtractMusicId,
  getSourceBySource, matchScore, normText, mergeSameTracks, findAlternative,
};

