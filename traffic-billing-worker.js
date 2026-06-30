/**
 * traffic-billing-worker v3.1.0
 *
 * 逐台 opt-in 的节点流量记账 + 可选配额告警 + 对外汇总接口。
 * 完全在 NodeGet 边缘端运行，不改探针任何代码。
 *
 *   v3.1.0:get_summary().alerting[] 增加用量、配额、重置日等字段;
 *          get_summary 支持 alert_threshold 参数,供 notify 流量模板使用。
 *
 * ── 与 v2 的关键区别 ──────────────────────────────────────────────
 *   · 没有默认配额。每台机器单独开启、单独配置。
 *   · 配置(config)与运行状态(ledger)分离存储：
 *       config: 该节点命名空间 key "traffic_billing_config"
 *               { enabled, billing_day, mode, quota_gb|null }
 *       ledger: 该节点命名空间 key "traffic_billing_ledger"
 *               { snapshot:{ last_total_tx, last_total_rx, last_boot_time,
 *                            current_period_start, accumulated_bytes,
 *                            alerts_triggered, last_update } }
 *   · onCron 只审计 enabled === true 的机器；未开启的机器完全不碰。
 *   · quota_gb 为 null/0 → 只记用量、不设配额、不告警。
 *
 * ── 数据源(已对照文档 + 实例核实) ───────────────────────────────
 *   agent_dynamic_summary_multi_last_query
 *     fields:["total_transmitted","total_received","boot_time"]
 *   total_* = u64 字节整机累计计数器(单调递增)。
 *   boot_time 单位不统一(部分探针是 uptime 式递增)，不可靠 → 重启判定只看
 *   计数器方向(curr<last 才算归零)。
 *
 * ── 入口 ─────────────────────────────────────────────────────────
 *   onCron       → 审计所有 enabled 机器
 *   onCall/onInlineCall → action: list / get_summary / get_config / set_config / audit_now
 *   onRoute      → GET /list /summary /config?uuid=  POST /config /audit /reset
 *
 * env: {
 *   "token":        "<拥有相应权限的 NodeGet Token(读 agent/动态摘要 + KV 读写)>",
 *   "route_secret": "<可选;设了后打开配置页 /ui 先出登录页需输入密钥(本机记住);读写配置接口无密钥 401;
 *                     数据接口 /list /summary 始终公开,供探针前端面板拉取>"
 * }
 * 注:route_secret 未设=全公开;设了=打开配置页先登录(密钥本机 localStorage 记住,扩展图标直接进),数据接口仍公开。
 */

// ─── 常量 ───────────────────────────────────────────────────────────

var CONFIG_KEY = "traffic_billing_config";
var LEDGER_KEY = "traffic_billing_ledger";
var NAME_KEY = "metadata_name";
var CST_OFFSET = 8 * 3600000;
var ALERT_THRESHOLDS = [0.8, 0.95];
var GiB = 1073741824;

// ─── 工具 ───────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*", // 允许 StatusShow 跨域(如部署到 Cloudflare Pages)拉取
    },
  });
}
function bytesToGB(b) {
  return Math.round((b / GiB) * 100) / 100;
}
// 私密链接鉴权:env.route_secret 未设→公开;设了→除公开数据接口(/list /summary,前端面板要拉)外,
// 其余(/ui /config /audit /reset)必须带 ?s=<secret>(或 ?secret= / x-route-secret 头),URL 不对一律拒绝。
function getSecret(request) {
  const u = new URL(request.url);
  return u.searchParams.get("s") || u.searchParams.get("secret") || request.headers.get("x-route-secret") || "";
}
function authed(request, env) {
  const want = env && env.route_secret ? String(env.route_secret) : "";
  return !want || getSecret(request) === want;
}

async function rpc(method, params) {
  const r = await nodeget(method, params);
  if (r && r.error) throw new Error(`RPC ${method}: ${JSON.stringify(r.error)}`);
  return r ? r.result : undefined;
}

// ─── 周期边界(按 CST 结算日) ───────────────────────────────────────

function periodStartFor(nowMs, billingDay) {
  const d = new Date(nowMs + CST_OFFSET);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  const day = d.getUTCDate();
  if (day < billingDay) {
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
  }
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const bd = Math.min(billingDay, daysInMonth);
  return Date.UTC(y, m, bd, 0, 0, 0, 0) - CST_OFFSET;
}
function nextPeriodStartFor(nowMs, billingDay) {
  const start = periodStartFor(nowMs, billingDay);
  const d = new Date(start + CST_OFFSET);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const bd = Math.min(billingDay, daysInMonth);
  return Date.UTC(y, m, bd, 0, 0, 0, 0) - CST_OFFSET;
}
function formatDateCST(ms) {
  return new Date(ms + CST_OFFSET).toISOString().slice(0, 10);
}

// ─── 配置 ───────────────────────────────────────────────────────────

function normalizeConfig(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  let bd = Number(raw.billing_day);
  if (!(bd >= 1 && bd <= 31)) bd = 1;
  bd = Math.trunc(bd);
  const mode = ["outbound", "inbound", "both"].includes(raw.mode) ? raw.mode : "outbound";
  let q = Number(raw.quota_gb);
  const quota_gb = Number.isFinite(q) && q > 0 ? q : null; // null = 不限额
  return { enabled: raw.enabled === true, billing_day: bd, mode, quota_gb };
}
function normalizeAlertThreshold(raw) {
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 1 && n <= 200) return Math.trunc(n);
  return 80;
}

// ─── 运行状态(snapshot) ───────────────────────────────────────────

function defaultSnapshot(nowMs, billingDay) {
  return {
    last_total_tx: null,
    last_total_rx: null,
    last_boot_time: null,
    current_period_start: periodStartFor(nowMs, billingDay),
    accumulated_bytes: 0,
    alerts_triggered: {},
    last_update: nowMs,
  };
}
function normalizeSnapshot(raw, nowMs, billingDay) {
  const base = defaultSnapshot(nowMs, billingDay);
  if (raw && typeof raw === "object" && raw.snapshot) {
    return { ...base, ...raw.snapshot };
  }
  return base;
}

// ─── 增量(纯计数器方向，重启容错) ─────────────────────────────────

function deltaBytes(curr, last) {
  const c = Number(curr) || 0;
  if (last == null) return 0;
  const l = Number(last) || 0;
  const diff = c - l;
  return diff >= 0 ? diff : Math.max(0, c); // 回退=归零→计入当前值
}

// ─── KV ─────────────────────────────────────────────────────────────

async function getValue(token, namespace, key) {
  return await rpc("kv_get_value", { token, namespace, key });
}
async function setValue(token, namespace, key, value) {
  await rpc("kv_set_value", { token, namespace, key, value });
}
// 批量读多个 namespace 下同一 key → Map<namespace, value|null>
async function getMulti(token, uuids, key) {
  if (!uuids.length) return new Map();
  const rows = await rpc("kv_get_multi_value", {
    token,
    namespace_key: uuids.map((u) => ({ namespace: u, key })),
  });
  const map = new Map();
  for (const r of rows || []) map.set(r.namespace, r.value);
  return map;
}

async function listAgentUuids(token) {
  const u = await rpc("agent-uuid_list_all", { token });
  return Array.isArray(u) ? u : [];
}
async function fetchTraffic(token, uuids) {
  if (!uuids.length) return new Map();
  const rows = await rpc("agent_dynamic_summary_multi_last_query", {
    token, uuids, fields: ["total_transmitted", "total_received", "boot_time"],
  });
  const map = new Map();
  for (const r of rows || []) map.set(r.uuid, r);
  return map;
}

// ─── 单节点审计(snapshot + config + sample → snapshot|null) ──────────

function auditSnapshot(snap, config, sample, nowMs) {
  const rawTx = Number(sample.total_transmitted);
  const rawRx = Number(sample.total_received);
  if (!Number.isFinite(rawTx) || !Number.isFinite(rawRx)) return null; // 跳过

  // 周期重置
  const expected = periodStartFor(nowMs, config.billing_day);
  if (expected > (snap.current_period_start || 0)) {
    snap.current_period_start = expected;
    snap.accumulated_bytes = 0;
    snap.alerts_triggered = {};
  }

  // 增量累加
  if (snap.last_total_tx != null) {
    const dTx = deltaBytes(rawTx, snap.last_total_tx);
    const dRx = deltaBytes(rawRx, snap.last_total_rx);
    let inc = 0;
    if (config.mode === "outbound" || config.mode === "both") inc += dTx;
    if (config.mode === "inbound" || config.mode === "both") inc += dRx;
    snap.accumulated_bytes += inc;
  }
  snap.last_total_tx = rawTx;
  snap.last_total_rx = rawRx;
  snap.last_boot_time = sample.boot_time != null ? Number(sample.boot_time) : null;
  snap.last_update = nowMs;

  // 告警(仅在设了配额时)
  if (config.quota_gb && config.quota_gb > 0) {
    const quotaBytes = config.quota_gb * GiB;
    const ratio = snap.accumulated_bytes / quotaBytes;
    for (const t of ALERT_THRESHOLDS) {
      const k = String(t);
      if (ratio >= t && !snap.alerts_triggered[k]) snap.alerts_triggered[k] = true;
    }
  }
  return snap;
}

// ─── 视图 ───────────────────────────────────────────────────────────

function nodeView(uuid, name, config, snap, nowMs) {
  nowMs = nowMs || Date.now();
  const used = snap ? snap.accumulated_bytes || 0 : 0;
  const quotaBytes = config.quota_gb ? config.quota_gb * GiB : null;
  const percent = quotaBytes ? Math.round((used / quotaBytes) * 10000) / 100 : null;
  const nextReset = nextPeriodStartFor(nowMs, config.billing_day);
  const alerts = snap ? snap.alerts_triggered || {} : {};
  return {
    uuid,
    name: name || uuid.slice(0, 8),
    enabled: config.enabled,
    billing_day: config.billing_day,
    mode: config.mode,
    quota_gb: config.quota_gb,
    used_bytes: used,
    used_gb: bytesToGB(used),
    percent,
    remaining_gb: quotaBytes ? bytesToGB(Math.max(0, quotaBytes - used)) : null,
    alerts_triggered: alerts,
    current_period_start: snap ? snap.current_period_start : null,
    next_reset_time: nextReset,
    reset_day: formatDateCST(nextReset),
    last_update: snap ? snap.last_update : null,
  };
}

// ─── 核心:审计所有 enabled 机器 ───────────────────────────────────

async function auditAll(token) {
  const nowMs = Date.now();
  const uuids = await listAgentUuids(token);
  if (!uuids.length) return { ok: true, audited: 0, results: [] };

  const configMap = await getMulti(token, uuids, CONFIG_KEY);
  const enabled = uuids.filter((u) => {
    const c = configMap.get(u);
    return c && c.enabled === true;
  });
  if (!enabled.length) {
    return { ok: true, audited: 0, results: [], note: "no enabled node" };
  }

  const [trafficMap, ledgerMap] = await Promise.all([
    fetchTraffic(token, enabled),
    getMulti(token, enabled, LEDGER_KEY),
  ]);

  const results = [];
  for (const uuid of enabled) {
    const sample = trafficMap.get(uuid);
    if (!sample) { results.push({ uuid, skipped: "no traffic sample" }); continue; }
    try {
      const config = normalizeConfig(configMap.get(uuid));
      const snap = normalizeSnapshot(ledgerMap.get(uuid), nowMs, config.billing_day);
      const updated = auditSnapshot(snap, config, sample, nowMs);
      if (!updated) { results.push({ uuid, skipped: "invalid sample" }); continue; }
      await setValue(token, uuid, LEDGER_KEY, { snapshot: updated });
      results.push(nodeView(uuid, null, config, updated, nowMs));
    } catch (e) {
      results.push({ uuid, error: String(e && e.message ? e.message : e) });
    }
  }
  return { ok: true, audited: results.length, results };
}

// ─── 列表(所有机器，含未开启的，供 UI 展示) ──────────────────────

async function listAll(token) {
  const nowMs = Date.now();
  const uuids = await listAgentUuids(token);
  const [configMap, ledgerMap, nameMap] = await Promise.all([
    getMulti(token, uuids, CONFIG_KEY),
    getMulti(token, uuids, LEDGER_KEY),
    getMulti(token, uuids, NAME_KEY),
  ]);
  const nodes = uuids.map((uuid) => {
    const config = normalizeConfig(configMap.get(uuid));
    const rawLedger = ledgerMap.get(uuid);
    const snap = rawLedger && rawLedger.snapshot ? rawLedger.snapshot : null;
    const name = nameMap.get(uuid);
    return nodeView(uuid, typeof name === "string" ? name : null, config, snap, nowMs);
  });
  nodes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ok: true, count: nodes.length, nodes };
}

async function getSummary(token, params) {
  const alertThreshold = normalizeAlertThreshold(params && params.alert_threshold);
  const { nodes } = await listAll(token);
  const enabled = nodes.filter((n) => n.enabled);
  let used = 0, quota = 0;
  const alerting = [];
  for (const n of enabled) {
    used += n.used_bytes;
    if (n.quota_gb) quota += n.quota_gb * GiB;
    // 从指定阈值起每 5% 一个档位(如 80/85/90/95/100/105…),供 notify 做阶梯报警
    if (n.percent != null && n.percent >= alertThreshold) {
      const level = Math.floor((n.percent - alertThreshold) / 5) * 5 + alertThreshold;
      const hit = Object.keys(n.alerts_triggered || {}).filter((k) => n.alerts_triggered[k]);
      alerting.push({
        uuid: n.uuid,
        name: n.name,
        percent: n.percent,
        level,
        thresholds: hit,
        billing_day: n.billing_day,
        mode: n.mode,
        quota_gb: n.quota_gb,
        used_bytes: n.used_bytes,
        used_gb: n.used_gb,
        remaining_gb: n.remaining_gb,
        reset_day: n.reset_day,
        next_reset_time: n.next_reset_time,
        current_period_start: n.current_period_start,
        last_update: n.last_update,
      });
    }
  }
  return {
    ok: true,
    generated_at: Date.now(),
    enabled_count: enabled.length,
    total_count: nodes.length,
    total_used_gb: bytesToGB(used),
    total_quota_gb: quota ? bytesToGB(quota) : null,
    alert_threshold: alertThreshold,
    alerting,
    nodes: enabled,
  };
}

async function getConfig(token, uuid) {
  if (!uuid) return { ok: false, error: "missing uuid" };
  const raw = await getValue(token, uuid, CONFIG_KEY);
  return { ok: true, uuid, config: normalizeConfig(raw), exists: raw != null };
}

async function setConfig(token, params) {
  const uuid = params && params.uuid;
  if (!uuid) return { ok: false, error: "missing uuid" };

  const cur = normalizeConfig(await getValue(token, uuid, CONFIG_KEY));
  const next = { ...cur };
  if (params.enabled != null) next.enabled = params.enabled === true || params.enabled === "true";
  if (params.billing_day != null) {
    const bd = Number(params.billing_day);
    if (!(bd >= 1 && bd <= 31)) return { ok: false, error: "billing_day must be 1-31" };
    next.billing_day = Math.trunc(bd);
  }
  if (params.mode != null) {
    if (!["outbound", "inbound", "both"].includes(params.mode))
      return { ok: false, error: "mode must be outbound|inbound|both" };
    next.mode = params.mode;
  }
  if (params.quota_gb !== undefined) {
    const q = Number(params.quota_gb);
    next.quota_gb = params.quota_gb === null || params.quota_gb === "" || !(q > 0) ? null : q;
  }
  const config = normalizeConfig(next);
  await setValue(token, uuid, CONFIG_KEY, config);

  // 配置变更后清告警锁，让下轮按新配额重新评估
  const rawLedger = await getValue(token, uuid, LEDGER_KEY);
  if (rawLedger && rawLedger.snapshot) {
    rawLedger.snapshot.alerts_triggered = {};
    await setValue(token, uuid, LEDGER_KEY, rawLedger);
  }
  return { ok: true, uuid, config };
}

async function resetNode(token, uuid) {
  if (!uuid) return { ok: false, error: "missing uuid" };
  const raw = await getValue(token, uuid, LEDGER_KEY);
  if (raw && raw.snapshot) {
    raw.snapshot.accumulated_bytes = 0;
    raw.snapshot.alerts_triggered = {};
    // 保留 last_total_* 与 current_period_start:下轮按差值从当前起继续累计
    await setValue(token, uuid, LEDGER_KEY, raw);
  }
  return { ok: true, uuid };
}

async function dispatch(token, params) {
  if (!token) return { ok: false, error: "missing token in env" };
  const action = (params && params.action) || "get_summary";
  switch (action) {
    case "list": return await listAll(token);
    case "get_summary": return await getSummary(token, params);
    case "get_config": return await getConfig(token, params.uuid);
    case "set_config": return await setConfig(token, params);
    case "audit_now": return await auditAll(token);
    case "reset_node": return await resetNode(token, params.uuid);
    default: return { ok: false, error: `unknown action: ${action}` };
  }
}

// ─── 主入口 ─────────────────────────────────────────────────────────

export default {
  async onCron(params, env, ctx) {
    const token = (env && env.token) || (params && params.token);
    if (!token) return { ok: false, error: "missing token in env" };
    try { return await auditAll(token); }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  },

  async onCall(params, env, ctx) {
    const token = (env && env.token) || (params && params.token);
    try { return await dispatch(token, params); }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  },

  async onInlineCall(params, env, ctx) {
    const token = (env && env.token) || (params && params.token);
    try { return await dispatch(token, params); }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  },

  async onRoute(request, env, ctx) {
    const token = env && env.token;
    if (!token) return json({ ok: false, error: "missing token in env" }, 500);
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    // CORS 预检(跨域 POST /config 等)
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type,x-route-secret",
        },
      });
    }
    try {
      // /list /summary 公开（供 StatusShow 等只读拉取）；其余设了 route_secret 后需带密钥。
      // 注：扩展前端已改走 js-worker_run（onCall），不再依赖这些写路由。
      const isPublic = method === "GET" && (path.endsWith("/list") || path.endsWith("/summary"));
      if (!isPublic && !authed(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
      if (method === "GET" && path.endsWith("/list")) return json(await listAll(token));
      if (method === "GET" && path.endsWith("/summary")) return json(await getSummary(token, { alert_threshold: url.searchParams.get("alert_threshold") }));
      if (method === "GET" && path.endsWith("/config")) {
        return json(await getConfig(token, url.searchParams.get("uuid")));
      }
      if (method === "POST" && path.endsWith("/config")) {
        return json(await setConfig(token, await request.json()));
      }
      if (method === "POST" && path.endsWith("/audit")) return json(await auditAll(token));
      if (method === "POST" && path.endsWith("/reset")) return json(await resetNode(token, (await request.json()).uuid));
      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
    }
  },
};
