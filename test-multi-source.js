/**
 * MusicFree 多源插件自测
 *
 *   npm install && node test-multi-source.js
 *
 * 说明：本脚本会真的访问 QQ音乐 / 网易云 / Audiomack 的公开接口，需要联网。
 * 大部分用例不依赖账号；已下架/付费曲目相关用例失败属于正常业务限制。
 */
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const CryptoJS = require("crypto-js");
const cheerio = require("cheerio");

const PLUGIN_FILE = path.join(__dirname, "multi-source.js");

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];
const skips = [];

function ok(label, extra = "") {
  pass++;
  console.log(`  \x1b[32m✓\x1b[0m ${label}${extra ? "  " + extra : ""}`);
}
function no(label, extra = "") {
  fail++;
  failures.push(label);
  console.log(`  \x1b[31m✗\x1b[0m ${label}${extra ? "  " + extra : ""}`);
}
function assert(cond, label, extra = "") {
  cond ? ok(label, extra) : no(label, extra);
}
function skip(label, reason) {
  skipped++;
  skips.push(`${label}（${reason}）`);
  console.log(`  \x1b[33m-\x1b[0m ${label}  SKIP: ${reason}`);
}
function section(t) {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

/* ---------- 测试数据（固定的公开歌单/曲目，便于结果可复现） ---------- */
const SHARE_NETEASE =
  "听风吹花喜欢的音乐 听风吹花 https://music.163.com/m/playlist?id=79816281&creatorId=73766457";
const URL_QQ = "https://y.qq.com/n/ryqq/playlist/7707261125";
const URL_AM = "https://audiomack.com/audiomack-rnb/playlist/westbound";

/* ---------- 1. 模拟宿主环境加载插件 ---------- */
// 宿主在 plugin.ts 里设了全局 2s 超时；插件体被包成
// function(require, require, module, exports, console, env, URL, process)，env 是参数
axios.defaults.timeout = 2000;

const HOST_PACKAGES = { cheerio, "crypto-js": CryptoJS, axios, dayjs: require("dayjs") };

const USER_VARS = { search_source: "all", merge: "on", fallback: "on" };
const hostEnv = {
  getUserVariables: () => USER_VARS,
  get userVariables() {
    return USER_VARS;
  },
  appVersion: "0.6.0",
  os: "android",
  lang: "zh-CN",
};

function loadPluginAsHost(onRequire) {
  const code = fs.readFileSync(PLUGIN_FILE, "utf8");
  const mod = { exports: {} };
  const _require = name => {
    if (onRequire) onRequire(name);
    const pkg = HOST_PACKAGES[name];
    if (!pkg) throw new Error(`宿主未提供包: ${name}`);
    pkg.default = pkg;
    return pkg;
  };
  // eslint-disable-next-line no-new-func
  new Function(
    "require",
    "module",
    "exports",
    "console",
    "env",
    "URL",
    "process",
    code
  )(_require, mod, mod.exports, console, hostEnv, URL, process);
  return mod.exports;
}

/* ---------- 主流程 ---------- */
(async () => {
  section("1. 依赖与宿主沙箱");
  const required = new Set();
  let plugin;
  try {
    plugin = loadPluginAsHost(n => required.add(n));
    ok("插件可在宿主沙箱中加载");
  } catch (e) {
    no("插件加载失败", e.message);
    process.exit(1);
  }
  assert(
    [...required].every(n => n in HOST_PACKAGES),
    "只依赖宿主白名单内的包",
    `实际 require: ${[...required].join(", ")}`
  );
  assert(plugin.platform === "多源歌单", "platform 声明正确", plugin.platform);
  assert(
    ["search", "importMusicSheet", "getMediaSource", "getLyric"].every(
      k => typeof plugin[k] === "function"
    ),
    "能力函数齐全"
  );
  assert(
    Array.isArray(plugin.userVariables) && plugin.userVariables.every(v => v.key),
    "userVariables 声明合法",
    plugin.userVariables.map(v => v.key).join(", ")
  );

  section("2. Audiomack OAuth 签名（与官方 MusicFree 插件实现对齐的固定向量）");
  {
    const { amSign } = plugin._internal;
    // 这三个期望值是用官方打包产物 audiomack/index.js 的 getSignature 算出来的
    const vectors = [
      {
        path: "/search",
        params: {
          oauth_consumer_key: "audiomack-js",
          oauth_nonce: "FIXEDNONCE",
          oauth_signature_method: "HMAC-SHA1",
          oauth_timestamp: 1789139000,
          oauth_version: "1.0",
          limit: 20,
          page: 1,
          q: "Jay Chou",
          show: "music",
          sort: "popular",
        },
        expect: "7rewpKu4Sflpz04pt+/VkeIEe8w=",
      },
      {
        path: "/music/play/4889705",
        params: {
          oauth_consumer_key: "audiomack-js",
          oauth_nonce: "FIXEDNONCE",
          oauth_signature_method: "HMAC-SHA1",
          oauth_timestamp: 1789139000,
          oauth_version: "1.0",
          environment: "desktop-web",
          hq: true,
          section: "/search",
        },
        expect: "8qqVRAbwep81ndVxC6YVgyVs2ZQ=",
      },
      {
        path: "/playlist/77996620",
        params: {
          oauth_consumer_key: "audiomack-js",
          oauth_nonce: "FIXEDNONCE",
          oauth_signature_method: "HMAC-SHA1",
          oauth_timestamp: 1789139000,
          oauth_version: "1.0",
        },
        expect: "t1rx4fW+SwUaq4cArBy3gu8xS7Y=",
      },
    ];
    for (const v of vectors) {
      const got = amSign("GET", v.path, v.params);
      assert(got === v.expect, `签名 ${v.path}`, got === v.expect ? "" : `得到 ${got}`);
    }
  }

  section("3. 搜索：多源聚合与同曲合并");
  let amReachable = true;
  let merged = null;
  let raw = null;
  try {
    merged = await plugin.search("周杰伦 晴天", 1, "music");
    const srcs = [...new Set(merged.data.map(x => x.source))];
    assert(merged.data.length > 0, "搜索有结果", `${merged.data.length} 条`);
    assert(srcs.length >= 2, "命中多个平台", srcs.join(", "));

    const mergedItems = merged.data.filter(x => x.alts && x.alts.length);
    if (srcs.length >= 3) {
      assert(mergedItems.length > 0, "存在同曲合并条目", `${mergedItems.length} 条带备选`);
    } else {
      amReachable = false;
      skip("存在同曲合并条目", `只有 ${srcs.length} 个源可用（${srcs.join(",")}），无法验证跨源合并`);
    }
    assert(
      mergedItems.every(x => x.alts.every(a => a.source !== x.source)),
      "备选源均来自其它平台"
    );

    USER_VARS.merge = "off";
    raw = await plugin.search("周杰伦 晴天", 1, "music");
    USER_VARS.merge = "on";
    assert(
      merged.data.length < raw.data.length,
      "合并确实减少了重复",
      `${raw.data.length} → ${merged.data.length} 条`
    );
    assert(
      raw.data.every(x => !x.alts),
      "merge=off 时不产生备选字段"
    );
  } catch (e) {
    no("搜索用例异常", e.message);
  }

  section("4. 匹配规则（防翻唱 / 防伴奏）");
  {
    const { matchScore } = plugin._internal;
    const jay = { title: "晴天", artist: "周杰伦", duration: 269 };
    assert(
      matchScore(jay, { title: "晴天", artist: "周杰伦", duration: 269 }) >= 3,
      "同曲同艺人 命中"
    );
    assert(
      matchScore(jay, { title: "晴天(深情版)", artist: "Lucky小爱", duration: 279 }) === 0,
      "不同艺人的翻唱 被拦掉"
    );
    assert(
      matchScore(jay, { title: "晴天 (钢琴版)", artist: "纪钧瀚", duration: 238 }) === 0,
      "钢琴版 被拦掉"
    );
    assert(
      matchScore(
        { title: "如果寂寞了", artist: "郑晓填", duration: 207 },
        { title: "如果寂寞了（伴奏）", artist: "郑晓填", duration: 207 }
      ) === 0,
      "同艺人伴奏版 被拦掉"
    );
    assert(
      matchScore(
        { title: "你懂得", artist: "小沈阳 / 沈春阳", duration: 274 },
        { title: "你懂得", artist: "小沈阳、沈春阳", duration: 274 }
      ) >= 3,
      "艺人分隔符差异（/、&feat）仍能命中"
    );
  }

  section("5. 导入歌单");
  const imported = {};
  for (const [name, src] of [
    ["网易云（分享文本）", SHARE_NETEASE],
    ["QQ音乐", URL_QQ],
    ["Audiomack", URL_AM],
  ]) {
    try {
      const r = await plugin.importMusicSheet(src);
      imported[name] = r;
      const bad = r.filter(x => !x.id || !x.title || !x.source);
      assert(r.length > 0 && bad.length === 0, `导入 ${name}`, `${r.length} 首`);
    } catch (e) {
      if (name === "Audiomack") {
        amReachable = false;
        skip(`导入 ${name}`, e.message);
      } else {
        no(`导入 ${name}`, e.message);
      }
    }
  }
  {
    const ne = imported["网易云（分享文本）"] || [];
    assert(ne.length > 100, "「我喜欢的音乐」类歌单能翻全（>100 首）", `${ne.length} 首`);
    assert(new Set(ne.map(x => x.id)).size === ne.length, "导入结果无重复 id");
  }

  section("6. 播放地址");
  const playable = {};
  for (const [name, list] of Object.entries(imported)) {
    const pick = (list || []).find(x => !x.pay) || (list || [])[0];
    if (!pick) {
      no(`${name} 无可测曲目`);
      continue;
    }
    try {
      const s = await plugin.getMediaSource(pick, "standard");
      playable[name] = s;
      assert(s && s.url, `${name} 取到播放地址`, String(pick.title).slice(0, 20));
    } catch (e) {
      no(`${name} 取播放地址`, e.message);
    }
  }

  section("7. 跨平台换源");
  {
    const ne = imported["网易云（分享文本）"] || [];
    const target = ne.find(x => x.title === "体面") || ne[0];
    if (target) {
      try {
        const s = await plugin.getMediaSource(target, "standard");
        if (!amReachable && !(s && s.url)) {
          skip("已下架曲目能被换源救回", "可用源不足（Audiomack 不可达）");
        } else {
        assert(!!(s && s.url), "已下架曲目能被换源救回", `"${target.title}"`);
        if (s && s._fallbackFrom) {
          ok("确实走了换源", `→ ${s._fallbackFrom.source}`);
        }
        }
      } catch (e) {
        no("换源用例异常", e.message);
      }
    }
  }
  {
    // 关闭换源后不应再回退
    const ne = imported["网易云（分享文本）"] || [];
    const target = ne.find(x => x.title === "体面");
    if (target) {
      USER_VARS.fallback = "off";
      const s = await plugin.getMediaSource(target, "standard").catch(() => null);
      USER_VARS.fallback = "on";
      assert(!s || !s.url, "fallback=off 时不换源");
    }
  }

  section("8. 请求超时覆盖（宿主默认 2000；插件：搜索 7000 / 其余 12000，且不改宿主全局值）");
  {
    const seen = [];
    const realAxios = axios;
    function spy(config) {
      seen.push(config && config.timeout);
      return realAxios(config);
    }
    Object.assign(spy, realAxios, { defaults: realAxios.defaults });

    const saved = HOST_PACKAGES.axios;
    HOST_PACKAGES.axios = spy;
    try {
      const p2 = loadPluginAsHost();
      await p2.search("周杰伦", 1, "music");
      const uniq = [...new Set(seen)];
      // 搜索类请求 7000（避免单个慢源拖满），其余 12000；关键是宿主默认的 2000 不能漏进来
      const allowed = [7000, 12000];
      assert(
        seen.length > 0 && uniq.every(t => allowed.includes(t)),
        "插件请求都覆盖了自有超时（不含宿主默认 2000）",
        `实际 ${JSON.stringify(uniq)}`
      );
      assert(axios.defaults.timeout === 2000, "未篡改宿主 axios 全局默认值");
    } catch (e) {
      no("超时用例异常", e.message);
    } finally {
      HOST_PACKAGES.axios = saved;
    }
  }

  section("结果");
  console.log(`  通过 ${pass} 项，失败 ${fail} 项，跳过 ${skipped} 项`);
  if (skips.length) {
    console.log("  跳过清单（多为网络/平台限制，非插件问题）:");
    skips.forEach(f => console.log("   -", f));
  }
  if (failures.length) {
    console.log("  失败清单:");
    failures.forEach(f => console.log("   -", f));
  }
  console.log(
    "\n  注：QQ/网易云的付费曲目匿名拿不到播放地址、Audiomack 独家曲目返回 403，\n" +
      "      属于平台业务限制而非插件缺陷；插件会在这些情况下自动换源。"
  );
  process.exit(fail === 0 ? 0 : 1);
})();
