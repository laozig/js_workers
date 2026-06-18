// 消息通知扩展 · token 鉴权（和 Docker / 流量监控插件一致）
// 用 hash 里的 NodeGet token 调 js-worker_run（run_type=call）触发 notify-worker 的 onCall，
// 再轮询 js-result_query 取结果。不再跳转 worker 的 /ui，也不用 route_secret。
// 安装时按 app.json.limits 创建的 Token 需含：JsWorker::RunDefinedJsWorker + JsResult::Read，scope=notify-worker。

const WORKER_NAME = "notify-worker"; // worker 脚本名（不是 route_name）
const RPC_URL = window.location.origin + "/nodeget/rpc";

function parseHash() {
  const h = window.location.hash;
  const q = h.startsWith("#?") ? h.slice(2) : h.slice(1);
  const p = new URLSearchParams(q);
  return { token: p.get("token") || "", theme: p.get("theme") || "dark" };
}
const { token, theme } = parseHash();
document.documentElement.setAttribute("data-theme", theme === "light" ? "light" : "dark");
window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "theme-change")
    document.documentElement.setAttribute("data-theme", e.data.theme === "light" ? "light" : "dark");
});

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const bannerEl = $("banner");
const toastEl = $("toast");
const EVENTS = ["offline", "online", "expire", "traffic"];

function showBanner(m) { bannerEl.textContent = m; bannerEl.classList.remove("hidden"); }
function clearBanner() { bannerEl.textContent = ""; bannerEl.classList.add("hidden"); }
let toastTimer = null;
function toast(m, kind) {
  toastEl.textContent = m;
  toastEl.className = "toast show" + (kind ? " " + kind : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = "toast" + (kind ? " " + kind : ""); }, 2400);
}

// ---- RPC：js-worker_run（异步）+ js-result_query 轮询 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    await sleep(350);
    const rows = await rpc("js-result_query", { token, query: { condition: [{ id }] } });
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row && row.finish_time != null) {
      if (row.error_message) throw new Error(row.error_message);
      return row.result;
    }
  }
  throw new Error("worker 执行超时（25s）");
}

// ---- 表单填充 / 收集 ----
function syncEventRow(ev) {
  const row = $("ev_" + ev + "_row");
  if (row) row.classList.toggle("on", $("ev_" + ev).checked);
}
function fill(c) {
  c = c || {};
  $("enabled").checked = !!c.enabled;
  $("template").value = c.template || "";
  $("bot_token").value = "";
  $("bot_token").placeholder = c.bot_token_set
    ? "已配置 " + (c.bot_token_hint || "") + "，留空不修改"
    : "123456:ABC-DEF...";
  $("chat_id").value = c.chat_id || "";
  $("message_thread_id").value = c.message_thread_id || "";
  $("endpoint").value = c.endpoint || "https://api.telegram.org/bot";
  const ev = c.events || {};
  $("ev_offline").checked = ev.offline !== false;
  $("ev_online").checked = ev.online !== false;
  $("ev_expire").checked = ev.expire !== false;
  $("ev_traffic").checked = ev.traffic === true;
  $("expire_days").value = c.expire_days || 7;
  EVENTS.forEach(syncEventRow);
}
function collect() {
  return {
    enabled: $("enabled").checked,
    channel: "telegram",
    bot_token: $("bot_token").value.trim(), // 留空 = 保留原 token（worker 端处理）
    chat_id: $("chat_id").value.trim(),
    message_thread_id: $("message_thread_id").value.trim(),
    endpoint: $("endpoint").value.trim(),
    template: $("template").value,
    events: {
      offline: $("ev_offline").checked,
      online: $("ev_online").checked,
      expire: $("ev_expire").checked,
      traffic: $("ev_traffic").checked,
    },
    expire_days: Number($("expire_days").value) || 7,
  };
}

// ---- 状态条 ----
function fmtAgo(ms) {
  if (!ms) return null;
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return s + " 秒前";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  return Math.floor(s / 86400) + " 天前";
}
function showStatus(st) {
  const el = $("status"), tx = $("status-text");
  if (!st) { el.className = "statusbar idle"; tx.textContent = "—"; return; }
  const ago = fmtAgo(st.last_run);
  if (!ago) {
    el.className = "statusbar warn";
    tx.textContent = "尚未运行过检测 —— 请在「定时任务」配置 notify-worker（建议 cron 0 */2 * * * *）";
  } else {
    el.className = "statusbar";
    tx.textContent = "上次检测 " + ago + " · 发出 " + (st.last_sent || 0) + " 条" + (st.last_note ? " · " + st.last_note : "");
  }
}

// ---- 加载 / 保存 / 测试 / 检测 ----
async function load() {
  try {
    const d = await call("get_config");
    if (!d || d.ok === false) throw new Error((d && d.error) || "加载失败");
    fill(d.config);
    showStatus(d.state);
    clearBanner();
  } catch (e) {
    showBanner("加载失败：" + (e && e.message ? e.message : String(e)) +
      "\n（确认已部署 " + WORKER_NAME + "，且本扩展安装时授予了 JsWorker 运行 + JsResult 读取权限）");
    $("status").className = "statusbar idle";
    $("status-text").textContent = "—";
  }
}
async function save() {
  const btn = $("save");
  btn.disabled = true;
  try {
    const d = await call("set_config", { config: collect() });
    if (!d || d.ok === false) throw new Error((d && d.error) || "保存失败");
    fill(d.config); // 回填打码后的最新配置
    toast("已保存", "ok");
    return true;
  } catch (e) {
    toast("保存失败：" + (e && e.message ? e.message : String(e)), "err");
    return false;
  } finally {
    btn.disabled = false;
  }
}
async function testSend() {
  if (!(await save())) return;
  const btn = $("test");
  btn.disabled = true;
  toast("发送中…");
  try {
    const d = await call("test");
    toast(d && d.ok ? "测试消息已发送 ✅" : "发送失败：" + ((d && d.error) || ""), d && d.ok ? "ok" : "err");
  } catch (e) {
    toast("发送失败：" + (e && e.message ? e.message : String(e)), "err");
  } finally {
    btn.disabled = false;
  }
}
async function runNow() {
  if (!(await save())) return;
  const btn = $("run");
  btn.disabled = true;
  toast("检测中…");
  try {
    const d = await call("run");
    if (d && d.ok) {
      toast(d.skipped ? "已跳过：" + d.skipped : "已检测 · 发出 " + (d.sent || 0) + " 条", "ok");
      await load();
    } else {
      toast("检测失败：" + ((d && d.error) || ""), "err");
    }
  } catch (e) {
    toast("检测失败：" + (e && e.message ? e.message : String(e)), "err");
  } finally {
    btn.disabled = false;
  }
}

// ---- 事件绑定 ----
$("save").addEventListener("click", save);
$("test").addEventListener("click", testSend);
$("run").addEventListener("click", runNow);
EVENTS.forEach((ev) => $("ev_" + ev).addEventListener("change", () => syncEventRow(ev)));

// ---- 启动 ----
if (!token) {
  showBanner("缺少 token：请通过 board 的扩展入口打开本页面。");
} else {
  load();
}
