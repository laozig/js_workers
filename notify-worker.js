/**
 * notify-worker v1.2
 *
 * NodeGet 事件通知(对齐 Komari 通知功能):节点离线/上线、到期提醒、流量超限,
 * 通过 Telegram Bot 推送。配置由 notify-extension(token 鉴权 iframe)经 onCall 读写。
 *   v1.2:移除内置 /ui 与 route_secret —— 配置面板改由 notify-extension 用 NodeGet Token
 *         调 onCall(get_config/set_config/test/run)完成;onRoute 已删除。
 *   v1.1:bot_token 打码回显 · 发送失败下轮重试 · 离线/恢复同轮合并一条 ·
 *         到期每天提醒一次 · 记录 last_run
 *
 * ── 事件 ─────────────────────────────────────────────────────────
 *   offline  节点离线(动态摘要超过 OFFLINE_MS 无上报;同轮多台合并一条)
 *   online   节点从离线恢复(同轮多台合并一条)
 *   expire   metadata_expire_time 距今 <= expire_days 天(每天提醒一次,跨天重发,续费即停)
 *   traffic  流量超配额(经 inlineCall 读 traffic-billing-worker;从 80% 起每 +5% 档报一次)
 *
 * ── 存储(global 命名空间) ───────────────────────────────────────
 *   notify_config : { enabled, channel, bot_token, chat_id, message_thread_id,
 *                     endpoint, template, events:{offline,online,expire,traffic}, expire_days }
 *   notify_state  : { offline:[uuid...], expire_dates:{uuid:"YYYY-MM-DD"...}, traffic:{uuid:level...},
 *                     last_run, last_sent, last_note }
 *
 * ── 入口 ─────────────────────────────────────────────────────────
 *   onCron        → 检测事件并推送(需配定时任务,建议每 2 分钟一次)
 *   onCall        → action: get_config / set_config / test / run / get_state(供扩展经 js-worker_run 调用)
 *   onInlineCall  → 同 onCall
 *
 * env: {
 *   "token": "<NodeGet 平台 Token(读 agent/kv 权限);注意:不是 Telegram bot token>"
 * }
 * 注:bot_token 经 get_config 返回时始终打码(只给尾巴提示);set_config 留空 bot_token = 保留原值。
 */

var NS = "global";
var CFG_KEY = "notify_config";
var STATE_KEY = "notify_state";
var NAME_KEY = "metadata_name";
var EXPIRE_KEY = "metadata_expire_time";
var OFFLINE_MS = 90000;            // 90s 无上报视为离线
var TRAFFIC_WORKER = "traffic-billing-worker";

var DEFAULT_CFG = {
  enabled: false,
  channel: "telegram",
  bot_token: "",
  chat_id: "",
  message_thread_id: "",
  endpoint: "https://api.telegram.org/bot",
  template: "{{emoji}} {{event}}\n服务器：{{client}}\n时间：{{time}}",
  events: { offline: true, online: true, expire: true, traffic: false },
  expire_days: 7,
};

var EMOJI = { offline: "🔴", online: "🟢", expire: "⏰", traffic: "📊", test: "✅" };
var EVENT_TEXT = { offline: "节点离线", online: "节点恢复在线", expire: "即将到期", traffic: "流量超配额", test: "测试通知" };

// ─── 工具 ───────────────────────────────────────────────────────────

// bot_token 打码:回显只给提示尾巴,绝不吐明文
function maskToken(t) {
  t = String(t || "");
  if (!t) return "";
  return t.length <= 8 ? "****" : t.slice(0, 5) + "…" + t.slice(-4);
}
function maskCfg(cfg) {
  return { ...cfg, bot_token: "", bot_token_set: !!cfg.bot_token, bot_token_hint: maskToken(cfg.bot_token) };
}
async function rpc(method, params) {
  const r = await nodeget(method, params);
  if (r && r.error) throw new Error(`RPC ${method}: ${JSON.stringify(r.error)}`);
  return r ? r.result : undefined;
}
function nowCST() {
  return new Date(Date.now() + 8 * 3600000).toISOString().replace("T", " ").slice(0, 19);
}
function nowDateCST() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); // YYYY-MM-DD(东八区)
}
// 解析到期时间:支持 ISO 日期串(如 "2026-06-19")、毫秒、秒 时间戳
function parseExpireMs(raw) {
  if (raw == null || raw === "") return NaN;
  if (typeof raw === "number") return raw > 1e11 ? raw : raw * 1000;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) { const n = Number(s); return n > 1e11 ? n : n * 1000; }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}
// 还剩几天(按东八区零点对齐,与前端展示口径一致;负数=已过期;null=无有效到期时间)
function expireDaysLeft(raw) {
  const exp = parseExpireMs(raw);
  if (!Number.isFinite(exp)) return null;
  const DAY = 86400000, off = 8 * 3600000;
  return Math.floor((exp + off) / DAY) - Math.floor((Date.now() + off) / DAY);
}

// ─── 配置 / 状态 ────────────────────────────────────────────────────

function normalizeCfg(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  const ev = raw.events && typeof raw.events === "object" ? raw.events : {};
  let ed = Number(raw.expire_days);
  if (!(ed >= 1 && ed <= 90)) ed = 7;
  return {
    enabled: raw.enabled === true,
    channel: "telegram",
    bot_token: String(raw.bot_token || ""),
    chat_id: String(raw.chat_id || ""),
    message_thread_id: String(raw.message_thread_id || ""),
    endpoint: String(raw.endpoint || DEFAULT_CFG.endpoint),
    template: String(raw.template || DEFAULT_CFG.template),
    events: {
      offline: ev.offline !== false,
      online: ev.online !== false,
      expire: ev.expire !== false,
      traffic: ev.traffic === true,
    },
    expire_days: Math.trunc(ed),
  };
}
async function getCfg(token) {
  const v = await rpc("kv_get_value", { token, namespace: NS, key: CFG_KEY });
  return normalizeCfg(v);
}
async function setCfg(token, cfg) {
  await rpc("kv_set_value", { token, namespace: NS, key: CFG_KEY, value: cfg });
}
async function getState(token) {
  const v = await rpc("kv_get_value", { token, namespace: NS, key: STATE_KEY });
  return {
    offline: Array.isArray(v && v.offline) ? v.offline : [],
    expired: Array.isArray(v && v.expired) ? v.expired : [],
    expire_dates: (v && v.expire_dates && typeof v.expire_dates === "object") ? v.expire_dates : {}, // uuid→上次提醒日期(CST),用于每天提醒
    traffic: (v && v.traffic && typeof v.traffic === "object" && !Array.isArray(v.traffic)) ? v.traffic : {}, // uuid→已报最高档位(%),阶梯报警
    last_run: (v && Number(v.last_run)) || 0,   // 上次 onCron/检测时间(ms),0=从未运行
    last_sent: (v && Number(v.last_sent)) || 0, // 上次发出条数
    last_note: (v && v.last_note) || "",        // 上次跳过原因(未开启/未配置…)
  };
}
async function setState(token, st) {
  await rpc("kv_set_value", { token, namespace: NS, key: STATE_KEY, value: st });
}

// ─── Telegram 发送 + 模板 ───────────────────────────────────────────

function render(tpl, ctx) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, function (_, k) {
    return ctx[k] != null ? String(ctx[k]) : "";
  });
}
async function sendTelegram(cfg, text) {
  if (!cfg.bot_token || !cfg.chat_id) return { ok: false, error: "missing bot_token / chat_id" };
  const base = (cfg.endpoint || DEFAULT_CFG.endpoint).replace(/\/$/, "");
  const url = base + cfg.bot_token + "/sendMessage";
  const body = { chat_id: cfg.chat_id, text };
  if (cfg.message_thread_id) body.message_thread_id = cfg.message_thread_id;
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    return d && d.ok ? { ok: true } : { ok: false, error: (d && d.description) || ("HTTP " + r.status) };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}
function notify(cfg, type, client, extra) {
  const text = render(cfg.template, {
    emoji: EMOJI[type] || "", event: (EVENT_TEXT[type] || type) + (extra ? " " + extra : ""),
    client: client || "", time: nowCST(), type,
  });
  return sendTelegram(cfg, text);
}
// 聚合:同一轮多台离线/恢复合并成一条消息(单台时与原来一致)
function groupClient(names) {
  const n = names.length;
  return n <= 6 ? names.join("、") : names.slice(0, 6).join("、") + " 等 " + n + " 台";
}
function notifyGroup(cfg, type, names) {
  const n = names.length;
  return notify(cfg, type, groupClient(names), n > 1 ? "（共 " + n + " 台）" : "");
}

// ─── agent 数据 ─────────────────────────────────────────────────────

async function listUuids(token) {
  const u = await rpc("agent-uuid_list_all", { token });
  return Array.isArray(u) ? u : [];
}
async function getMulti(token, uuids, key) {
  if (!uuids.length) return new Map();
  const rows = await rpc("kv_get_multi_value", { token, namespace_key: uuids.map((u) => ({ namespace: u, key })) });
  const m = new Map();
  for (const r of rows || []) m.set(r.namespace, r.value);
  return m;
}
async function getTimestamps(token, uuids) {
  if (!uuids.length) return new Map();
  const rows = await rpc("agent_dynamic_summary_multi_last_query", { token, uuids, fields: ["cpu_usage"] });
  const m = new Map();
  for (const r of rows || []) m.set(r.uuid, r.timestamp || 0);
  return m;
}

// ─── 核心:检测事件并推送 ───────────────────────────────────────────

async function runCheck(token, ctx) {
  const cfg = await getCfg(token);
  const st = await getState(token);
  st.last_run = Date.now();

  if (!cfg.enabled) { st.last_sent = 0; st.last_note = "通知未开启"; await setState(token, st); return { ok: true, skipped: "通知未开启" }; }
  if (!cfg.bot_token || !cfg.chat_id) { st.last_sent = 0; st.last_note = "未配置 bot_token / chat_id"; await setState(token, st); return { ok: true, skipped: "未配置 bot_token / chat_id" }; }

  const uuids = await listUuids(token);
  if (!uuids.length) { st.last_sent = 0; st.last_note = "无节点"; await setState(token, st); return { ok: true, sent: 0, note: "无节点" }; }

  const [tsMap, nameMap, expireMap] = await Promise.all([
    getTimestamps(token, uuids),
    getMulti(token, uuids, NAME_KEY),
    getMulti(token, uuids, EXPIRE_KEY),
  ]);
  const nameOf = (u) => {
    const n = nameMap.get(u);
    return (typeof n === "string" && n) ? n : u.slice(0, 8);
  };

  const now = Date.now();
  const sent = [];

  // 1) 离线/上线 —— 同一轮多台合并成一条;仅在通知成功时才并入状态,失败者整批下轮重试
  //    st.offline 语义:已就「离线」成功通知过、且仍被视作离线的节点集合
  const prevOffline = new Set(st.offline);
  const nowOffline = uuids.filter((u) => now - (tsMap.get(u) || 0) > OFFLINE_MS);
  const nowOfflineSet = new Set(nowOffline);
  const trackOff = cfg.events.offline || cfg.events.online;
  if (trackOff) {
    const nextOffline = [];
    const offlineNew = []; // 本轮新离线、需要通知的
    for (const u of nowOffline) {
      if (prevOffline.has(u)) { nextOffline.push(u); continue; }   // 之前已通知,保留
      if (cfg.events.offline) offlineNew.push(u);
      else nextOffline.push(u);                                    // 离线通知没开,但记录状态供「恢复」判定
    }
    if (offlineNew.length) {
      const r = await notifyGroup(cfg, "offline", offlineNew.map(nameOf));
      if (r.ok) { offlineNew.forEach((u) => nextOffline.push(u)); sent.push("offline×" + offlineNew.length); }
      // 失败:整批不记,下轮仍是「新离线」会重发
    }
    // 恢复在线:之前离线、现在在线、且仍在节点列表 → 合并成一条
    const recovered = [];
    for (const u of prevOffline) {
      if (nowOfflineSet.has(u)) continue;        // 还离线,上面已处理
      if (uuids.indexOf(u) < 0) continue;        // 节点已删除,丢弃
      if (cfg.events.online) recovered.push(u);
      // online 没开:正常移除(不 push)
    }
    if (recovered.length) {
      const r = await notifyGroup(cfg, "online", recovered.map(nameOf));
      if (r.ok) { sent.push("online×" + recovered.length); }       // 成功→正常移除
      else { recovered.forEach((u) => nextOffline.push(u)); }      // 失败→保留离线态,下轮重发恢复
    }
    st.offline = nextOffline;
  }

  // 2) 到期提醒(每天提醒一次:同一东八区日期内只发一次,跨天重发;续费出窗后清除;发送失败当天重试)
  if (cfg.events.expire) {
    const prevDates = st.expire_dates || {};
    const today = nowDateCST();
    const nextDates = {};
    for (const u of uuids) {
      const days = expireDaysLeft(expireMap.get(u));
      if (days == null) continue;
      if (days > cfg.expire_days) continue;                       // 不在窗口→不保留(含续费,出窗后再进窗可重发)
      if (prevDates[u] === today) { nextDates[u] = today; continue; } // 今天已发,跳过
      const r = await notify(cfg, "expire", nameOf(u), days >= 0 ? "剩 " + days + " 天" : "已过期");
      if (r.ok) { nextDates[u] = today; sent.push("expire:" + nameOf(u)); } // 成功→记今天
      // 失败:不记今天,同一天下轮会重试
    }
    st.expire_dates = nextDates;
    st.expired = Object.keys(nextDates); // 兼容旧字段
  }

  // 3) 流量超配额(读 traffic-billing-worker;从 80% 起每升 5% 档位报一次;失败下轮重试)
  if (cfg.events.traffic && ctx && ctx.inlineCall) {
    try {
      const prevLevels = st.traffic || {};
      const sum = await ctx.inlineCall(TRAFFIC_WORKER, { action: "get_summary" }, 20);
      const alerting = (sum && sum.alerting) || [];
      const nextLevels = {};
      for (const a of alerting) {
        const lvl = a.level != null ? a.level : 80;     // 当前档位(80/85/90…)
        const prev = prevLevels[a.uuid] || 0;           // 已报到的最高档
        if (lvl > prev) {
          const r = await notify(cfg, "traffic", a.name || a.uuid.slice(0, 8), (a.percent != null ? a.percent + "%" : lvl + "%"));
          if (r.ok) { nextLevels[a.uuid] = lvl; sent.push("traffic:" + (a.name || a.uuid.slice(0, 8)) + "@" + lvl + "%"); } // 升档→报并记新档
          else { nextLevels[a.uuid] = prev; }           // 失败→保留旧档,下轮重试
        } else {
          nextLevels[a.uuid] = prev;                    // 未升档→保留水位(小幅波动不重复报)
        }
      }
      st.traffic = nextLevels;                           // 不在 alerting(降回 80% 以下/重置)的节点自动清除,下次重新从 80% 报
    } catch (e) { /* traffic-billing 未装或调用失败,忽略,保留旧 traffic 状态 */ }
  }

  st.last_sent = sent.length;
  st.last_note = "";
  await setState(token, st);
  return { ok: true, sent: sent.length, events: sent };
}

// ─── 入口 ───────────────────────────────────────────────────────────

async function dispatch(token, params, ctx) {
  if (!token) return { ok: false, error: "missing token in env" };
  const action = (params && params.action) || "get_config";
  if (action === "get_config") return { ok: true, config: maskCfg(await getCfg(token)), state: await getState(token) };
  if (action === "get_state") return { ok: true, state: await getState(token) };
  if (action === "set_config") {
    const incoming = params.config || params;
    const prev = await getCfg(token);
    const merged = { ...incoming };
    if (!incoming.bot_token) merged.bot_token = prev.bot_token; // 前端留空=保留原 token,不覆盖成空
    const cfg = normalizeCfg(merged);
    await setCfg(token, cfg);
    return { ok: true, config: maskCfg(cfg) };
  }
  if (action === "test") {
    const cfg = await getCfg(token);
    const r = await sendTelegram(cfg, render(cfg.template, { emoji: EMOJI.test, event: EVENT_TEXT.test, client: "NodeGet", time: nowCST(), type: "test" }));
    return r.ok ? { ok: true, sent: 1 } : { ok: false, error: r.error };
  }
  if (action === "run") return await runCheck(token, ctx);
  return { ok: false, error: "unknown action: " + action };
}

export default {
  async onCron(params, env, ctx) {
    const token = (env && env.token) || (params && params.token);
    if (!token) return { ok: false, error: "missing token in env" };
    try { return await runCheck(token, ctx); }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  },
  async onCall(params, env, ctx) {
    const token = (env && env.token) || (params && params.token);
    try { return await dispatch(token, params, ctx); }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  },
  async onInlineCall(params, env, ctx) {
    const token = (env && env.token) || (params && params.token);
    try { return await dispatch(token, params, ctx); }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  },
};
