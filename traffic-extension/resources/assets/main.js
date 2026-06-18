// 流量监控扩展 · token 鉴权（和 Docker 插件一致）
// 用 hash 里的 NodeGet token 调 js-worker_run（run_type=call）触发 worker 的 onCall，
// 再轮询 js-result_query 取结果。不再使用 worker 的 HTTP 路由 / route_secret。
// 安装时按 app.json.limits 创建的 Token 需含：JsWorker::RunDefinedJsWorker + JsResult::Read，scope=traffic-billing-worker。

const WORKER_NAME = "traffic-billing-worker"; // worker 脚本名（不是 route_name）
const RPC_URL = window.location.origin + "/nodeget/rpc";

function parseHash() {
  const h = window.location.hash;
  const q = h.startsWith("#?") ? h.slice(2) : h.slice(1);
  const p = new URLSearchParams(q);
  return { token: p.get("token") || "", node: p.get("node") || "", theme: p.get("theme") || "dark" };
}
const { token, node, theme } = parseHash();
document.documentElement.setAttribute("data-theme", theme === "light" ? "light" : "dark");
window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "theme-change")
    document.documentElement.setAttribute("data-theme", e.data.theme === "light" ? "light" : "dark");
});

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const rowsEl = $("rows");
const summaryEl = $("summary");
const bannerEl = $("banner");
const cfgModal = $("cfgmodal");
const cfgError = $("cfg-error");
const confirmModal = $("confirmmodal");
const confirmMsg = $("confirm-msg");
const viewAll = $("view-all");
const viewSingle = $("view-single");
const isNode = !!node;

if (node) $("scope-label").textContent = "· 节点 " + node.slice(0, 12);
if (isNode) {
  viewAll.classList.add("hidden");
  viewSingle.classList.remove("hidden");
  $("search").style.display = "none";
}

// ---- 工具 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function showBanner(m) { bannerEl.textContent = m; bannerEl.classList.remove("hidden"); }
function clearBanner() { bannerEl.textContent = ""; bannerEl.classList.add("hidden"); }
const MODE_LABEL = { outbound: "出网 ↑", inbound: "入网 ↓", both: "双向 ↕" };

// ---- RPC：js-worker_run（异步）+ js-result_query 轮询 ----
let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: ++rpcId }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const d = await res.json();
  if (d.error) throw new Error(d.error.message || "RPC error");
  return d.result;
}

async function call(action, extra) {
  const run = await rpc("js-worker_run", {
    token,
    js_script_name: WORKER_NAME,
    run_type: "call",
    params: Object.assign({ action }, extra || {}),
  });
  const id = run && run.id;
  if (id == null) throw new Error("js-worker_run 未返回 id");
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(350);
    const rows = await rpc("js-result_query", { token, query: { condition: [{ id }] } });
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row && row.finish_time != null) {
      if (row.error_message) throw new Error(row.error_message);
      return row.result;
    }
  }
  throw new Error("worker 执行超时（20s）");
}

function showConfirm(msg) {
  return new Promise((resolve) => {
    confirmMsg.textContent = msg;
    confirmModal.classList.remove("hidden");
    const done = (v) => { confirmModal.classList.add("hidden"); $("confirm-ok").onclick = null; $("confirm-cancel").onclick = null; resolve(v); };
    $("confirm-ok").onclick = () => done(true);
    $("confirm-cancel").onclick = () => done(false);
  });
}

// ---- 数据 / 渲染 ----
let nodes = [];
let loaded = false;
let lastSig = null;

function pctClass(p) { return p == null ? "" : (p >= 95 ? "crit" : (p >= 80 ? "warn" : "")); }

function renderSummary(list) {
  const monitored = list.filter((n) => n.enabled);
  const usedGb = monitored.reduce((s, n) => s + (Number(n.used_gb) || 0), 0);
  const alerting = list.filter((n) => n.percent != null && n.percent >= 80).length;
  const cards = [
    { k: "节点总数", v: String(list.length) },
    { k: "已监控", v: String(monitored.length) },
    { k: "本期合计", v: usedGb.toFixed(2) + " GB" },
    { k: "触发告警", v: String(alerting), warn: alerting > 0 },
  ];
  summaryEl.innerHTML = cards.map((c) =>
    `<div class="sumcard"><div class="k">${c.k}</div><div class="v${c.warn ? " warn" : ""}">${c.v}</div></div>`).join("");
}

function usageCell(n) {
  if (n.quota_gb) {
    const pct = n.percent == null ? 0 : n.percent;
    const w = Math.min(100, pct);
    return `<div class="usage">
      <div class="txt">${(n.used_gb || 0).toFixed(2)} / ${n.quota_gb} GB<span class="pct">${pct}%</span></div>
      <div class="progress"><i class="${pctClass(pct)}" style="width:${w}%"></i></div></div>`;
  }
  return `<span class="muted">${(n.used_gb || 0).toFixed(2)} GB · 不限额</span>`;
}

function renderRows() {
  const q = $("search").value.trim().toLowerCase();
  let list = nodes.slice();
  if (q) list = list.filter((n) => (n.name + " " + n.uuid).toLowerCase().includes(q));
  if (!list.length) { rowsEl.innerHTML = '<tr><td colspan="6" class="muted center">没有节点</td></tr>'; return; }
  rowsEl.innerHTML = list.map((n) => {
    const badge = n.enabled ? '<span class="badge on">监控中</span>' : '<span class="badge off">未开启</span>';
    return "<tr>" +
      `<td class="name">${escapeHtml(n.name)}</td>` +
      `<td>${badge}</td>` +
      `<td>${usageCell(n)}</td>` +
      `<td class="muted">${MODE_LABEL[n.mode] || n.mode || "—"}</td>` +
      `<td class="muted">每月 ${n.billing_day} 号</td>` +
      `<td><div class="row-actions"><button class="btn btn-sm" data-cfg="${escapeHtml(n.uuid)}">配置</button></div></td>` +
      "</tr>";
  }).join("");
}

// ---- 单机视图 ----
function usageBig(n) {
  if (n.quota_gb) {
    const pct = n.percent == null ? 0 : n.percent;
    const w = Math.min(100, pct);
    return `<div class="big-num">${(n.used_gb || 0).toFixed(2)} <span class="unit">/ ${n.quota_gb} GB</span> <span class="big-pct ${pctClass(pct)}">${pct}%</span></div>
      <div class="progress big"><i class="${pctClass(pct)}" style="width:${w}%"></i></div>`;
  }
  return `<div class="big-num">${(n.used_gb || 0).toFixed(2)} <span class="unit">GB</span></div><div class="muted" style="margin-top:4px">不限额 · 仅统计用量</div>`;
}

function renderSingle() {
  const n = nodes.find((x) => x.uuid === node);
  if (!n) {
    $("sg-name").textContent = node.slice(0, 12);
    $("sg-badge").innerHTML = '<span class="badge off">无数据</span>';
    $("sg-usage").innerHTML = '<span class="muted">该节点暂无记账数据（可能未开启监控，或 worker 尚未审计一轮）</span>';
    $("sg-meta").textContent = "";
    return;
  }
  $("sg-name").textContent = n.name;
  $("sg-badge").innerHTML = n.enabled ? '<span class="badge on">监控中</span>' : '<span class="badge off">未开启</span>';
  $("sg-usage").innerHTML = usageBig(n);
  let meta = `计费方向：${MODE_LABEL[n.mode] || n.mode || "—"} ｜ 起算日：每月 ${n.billing_day} 号`;
  if (n.remaining_gb != null) meta += ` ｜ 剩余 ${n.remaining_gb} GB`;
  $("sg-meta").textContent = meta;
}

async function doReset(uuid, name) {
  if (!(await showConfirm(`确定重置 “${name || uuid}” 的本期已用量为 0 吗？`))) return;
  try {
    const r = await call("reset_node", { uuid });
    if (r && r.ok === false) throw new Error(r.error || "重置失败");
    load(true);
  } catch (e) {
    showBanner("重置失败：" + (e && e.message ? e.message : String(e)));
  }
}

async function load(silent) {
  const btn = $("refresh");
  if (!silent) btn.disabled = true;
  if (!loaded) (isNode ? $("sg-usage") : rowsEl).innerHTML = isNode ? "加载中…" : '<tr><td colspan="6" class="muted center">加载中…</td></tr>';
  try {
    const data = await call("list");
    const list = (data && data.nodes) || [];
    const sig = list.map((n) => [n.uuid, n.enabled, n.used_gb, n.quota_gb, n.mode, n.billing_day, n.percent].join("|")).join("\n");
    if (sig !== lastSig) {
      lastSig = sig; nodes = list;
      if (isNode) renderSingle(); else { renderRows(); renderSummary(list); }
    }
    loaded = true;
    clearBanner();
  } catch (e) {
    showBanner("加载失败：" + (e && e.message ? e.message : String(e)) +
      "\n（确认已部署 " + WORKER_NAME + "、建了每 5 分钟定时任务，且本扩展安装时授予了 JsWorker 运行 + JsResult 读取权限）");
    if (!loaded && !isNode) rowsEl.innerHTML = '<tr><td colspan="6" class="muted center">—</td></tr>';
  } finally {
    if (!silent) btn.disabled = false;
  }
}

// ---- 配置 ----
let cfgUuid = null;
function openCfg(uuid) {
  const n = nodes.find((x) => x.uuid === uuid);
  if (!n) return;
  cfgUuid = uuid;
  $("cfg-title").textContent = "配置 · " + n.name;
  $("cfg-enabled").checked = !!n.enabled;
  $("cfg-mode").value = n.mode || "outbound";
  $("cfg-day").value = n.billing_day || 1;
  $("cfg-quota").value = n.quota_gb == null ? "" : n.quota_gb;
  cfgError.classList.add("hidden");
  cfgModal.classList.remove("hidden");
}

async function saveCfg() {
  cfgError.classList.add("hidden");
  const day = Number($("cfg-day").value);
  const quotaRaw = $("cfg-quota").value.trim();
  const quota = quotaRaw === "" ? null : Number(quotaRaw);
  if (!(day >= 1 && day <= 31)) { cfgError.textContent = "起算日需为 1–31"; cfgError.classList.remove("hidden"); return; }
  if (quota != null && !(quota >= 0)) { cfgError.textContent = "配额需 ≥ 0 或留空"; cfgError.classList.remove("hidden"); return; }
  const body = { uuid: cfgUuid, enabled: $("cfg-enabled").checked, billing_day: day, mode: $("cfg-mode").value, quota_gb: quota };
  const btn = $("cfg-save");
  btn.disabled = true;
  try {
    const r = await call("set_config", body);
    if (r && r.ok === false) throw new Error(r.error || "保存失败");
    cfgModal.classList.add("hidden");
    load(true);
  } catch (e) {
    cfgError.textContent = "保存失败：" + (e && e.message ? e.message : String(e));
    cfgError.classList.remove("hidden");
  } finally {
    btn.disabled = false;
  }
}

async function resetCurrent() {
  if (!cfgUuid) return;
  const n = nodes.find((x) => x.uuid === cfgUuid);
  cfgModal.classList.add("hidden");
  await doReset(cfgUuid, n ? n.name : cfgUuid);
}

async function auditNow() {
  const btn = $("audit");
  btn.disabled = true;
  clearBanner();
  try {
    await call("audit_now");
    await load(true);
  } catch (e) {
    showBanner("审计失败：" + (e && e.message ? e.message : String(e)));
  } finally {
    btn.disabled = false;
  }
}

// ---- 自动刷新（可见且无弹窗时，每 15s 静默）----
function anyModalOpen() {
  return !cfgModal.classList.contains("hidden") || !confirmModal.classList.contains("hidden");
}
function autoRefresh() { if (!document.hidden && !anyModalOpen()) load(true); }

// ---- 事件 ----
$("refresh").addEventListener("click", () => load(false));
$("audit").addEventListener("click", auditNow);
$("search").addEventListener("input", renderRows);
rowsEl.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-cfg]");
  if (b) openCfg(b.getAttribute("data-cfg"));
});
$("cfg-close").addEventListener("click", () => cfgModal.classList.add("hidden"));
$("cfg-cancel").addEventListener("click", () => cfgModal.classList.add("hidden"));
$("cfg-save").addEventListener("click", saveCfg);
$("cfg-reset").addEventListener("click", resetCurrent);
cfgModal.addEventListener("click", (e) => { if (e.target === cfgModal) cfgModal.classList.add("hidden"); });
$("sg-config").addEventListener("click", () => openCfg(node));
$("sg-reset").addEventListener("click", () => { const n = nodes.find((x) => x.uuid === node); doReset(node, n ? n.name : node); });

// ---- 启动 ----
if (!token) {
  showBanner("缺少 token：请通过 board 的扩展入口打开本页面。");
} else {
  load(false);
  setInterval(autoRefresh, 15000);
}
