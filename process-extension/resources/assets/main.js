// 进程管理器 · NodeGet 扩展（纯前端，无 worker；和 Docker 管理器同构）
// board 内 iframe，hash 携带 token/node/theme；同源 HTTP JSON-RPC 调 task_create_task_blocking
// 下发 execute(sh -c) 到目标 Agent，取 stdout 解析渲染。三 tab：进程(ps/kill)、systemd、pm2。

// ---- hash 参数 ----
function parseHashParams() {
  const hash = window.location.hash;
  const query = hash.startsWith("#?") ? hash.slice(2) : hash.slice(1);
  const p = new URLSearchParams(query);
  return { token: p.get("token") || "", node: p.get("node") || "", theme: p.get("theme") || "dark" };
}
const { token, node, theme } = parseHashParams();
document.documentElement.setAttribute("data-theme", theme === "light" ? "light" : "dark");
window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "theme-change")
    document.documentElement.setAttribute("data-theme", e.data.theme === "light" ? "light" : "dark");
});

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const bannerEl = $("banner");
const infoEl = $("info-summary");
const procRows = $("proc-rows");
const sdRows = $("sd-rows");
const pm2Rows = $("pm2-rows");
const portRows = $("port-rows");
const logModal = $("logmodal"), logTitle = $("log-title"), logBody = $("log-body");
const confirmModal = $("confirmmodal"), confirmMsg = $("confirm-msg"), confirmOk = $("confirm-ok"), confirmCancel = $("confirm-cancel");

$("node-label").textContent = node ? node.slice(0, 12) : "—";

// ---- 工具 ----
const RPC_URL = window.location.origin + "/nodeget/rpc";
const RE_PID = /^\d+$/;                          // PID / pm2 id：纯数字，天然无注入
const RE_UNIT = /^[a-zA-Z0-9@._:-]+$/;           // systemd 服务名
const RE_PM2 = /^[a-zA-Z0-9_.-]+$/;              // pm2 名称（动作只用 id，这个仅作显示兜底）

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function showBanner(msg) { bannerEl.textContent = msg; bannerEl.classList.remove("hidden"); }
function clearBanner() { bannerEl.textContent = ""; bannerEl.classList.add("hidden"); }
function notFound(text) { return /command not found|not found|No such file/i.test(text); }

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params: Object.assign({ token }, params), id: ++rpcId }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "RPC error");
  return data.result;
}
// 在目标 Agent 执行 shell（合并 stderr），返回 stdout
async function sh(script, timeoutMs) {
  if (!node) throw new Error("未指定节点：本插件仅支持节点级路由（从某台机器的「进程」页进入）");
  const row = await rpc("task_create_task_blocking", {
    target_uuid: node,
    task_type: { execute: { cmd: "sh", args: ["-c", script] } },
    timeout_ms: timeoutMs || 20000,
  });
  if (row && row.success === false) throw new Error(row.error_message || "任务执行失败");
  const out = row && row.task_event_result && row.task_event_result.execute;
  return typeof out === "string" ? out : "";
}

function showConfirm(msg, danger) {
  confirmMsg.innerHTML = (danger ? '<div class="danger">⚠️ 高危操作，不可撤销</div>' : "") + "<div>" + escapeHtml(msg) + "</div>";
  confirmModal.classList.remove("hidden");
  return new Promise((resolve) => {
    const done = (v) => { confirmModal.classList.add("hidden"); confirmOk.onclick = null; confirmCancel.onclick = null; resolve(v); };
    confirmOk.onclick = () => done(true);
    confirmCancel.onclick = () => done(false);
  });
}
function openLog(title) {
  logTitle.textContent = title;
  logBody.textContent = "加载中…";
  logModal.classList.remove("hidden");
}

// ===================== 进程（ps / kill）=====================
let procData = [];
let procLoaded = false;
let procSig = null;
let sortKey = "cpu";   // cpu | mem
let sortDir = -1;       // -1 desc, 1 asc
let procFilter = "user"; // user | sys | all（默认隐藏内核线程噪声，直接看用户态进程）

function parsePsAux(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^USER\s+PID/i.test(line)) continue;
    const p = line.split(/\s+/);
    if (p.length < 11) continue;
    const pid = p[1];
    if (!RE_PID.test(pid)) continue;
    const cmd = p.slice(10).join(" ");
    out.push({
      user: p[0], pid, cpu: parseFloat(p[2]) || 0, mem: parseFloat(p[3]) || 0,
      rss: parseInt(p[5], 10) || 0, stat: p[7], cmd,
      sys: /^\[.*\]$/.test(cmd),   // 内核线程（[kworker] 等）归为「系统」；root-VPS 上按用户名/UID 无法区分，内核线程才是噪声大头
    });
  }
  return out;
}
function rssHuman(kb) {
  if (kb >= 1048576) return (kb / 1048576).toFixed(1) + "G";
  if (kb >= 1024) return (kb / 1024).toFixed(0) + "M";
  return kb + "K";
}
function sortedFilteredProc() {
  const q = $("proc-search").value.trim().toLowerCase();
  let list = procData.slice();
  if (procFilter === "user") list = list.filter((r) => !r.sys);
  else if (procFilter === "sys") list = list.filter((r) => r.sys);
  if (q) list = list.filter((r) => (r.cmd + " " + r.user + " " + r.pid).toLowerCase().includes(q));
  list.sort((a, b) => (a[sortKey] - b[sortKey]) * sortDir);
  return list;
}
function updateSegCounts() {
  const total = procData.length, sysN = procData.filter((r) => r.sys).length;
  const seg = $("proc-seg");
  if (!seg) return;
  seg.querySelector('[data-cnt="all"]').textContent = total;
  seg.querySelector('[data-cnt="user"]').textContent = total - sysN;
  seg.querySelector('[data-cnt="sys"]').textContent = sysN;
}
function renderProc() {
  const list = sortedFilteredProc();
  $("proc-count").textContent = list.length + " / " + procData.length + " 进程";
  updateSegCounts();
  // 结构签名：顺序 + pid + stat + cmd（不含波动的 cpu/mem/rss）。结构不变时只就地更新数字，避免闪烁。
  const sig = list.map((r) => r.pid + ":" + r.stat + ":" + r.cmd).join("\n");
  if (sig === procSig && procLoaded) {
    for (const r of list) {
      const tr = procRows.querySelector('tr[data-pid="' + r.pid + '"]');
      if (!tr) continue;
      tr.querySelector('[data-cell="cpu"]').textContent = r.cpu.toFixed(1);
      tr.querySelector('[data-cell="mem"]').textContent = r.mem.toFixed(1);
      tr.querySelector('[data-cell="rss"]').textContent = rssHuman(r.rss);
    }
    return;
  }
  procSig = sig;
  if (!list.length) { procRows.innerHTML = '<tr><td colspan="8" class="muted center">没有匹配的进程</td></tr>'; return; }
  procRows.innerHTML = list.map((r) => {
    const nm = escapeHtml(r.cmd);
    return '<tr data-pid="' + r.pid + '">' +
      "<td>" + r.pid + "</td>" +
      "<td>" + escapeHtml(r.user) + "</td>" +
      '<td class="num" data-cell="cpu">' + r.cpu.toFixed(1) + "</td>" +
      '<td class="num" data-cell="mem">' + r.mem.toFixed(1) + "</td>" +
      '<td class="num" data-cell="rss">' + rssHuman(r.rss) + "</td>" +
      "<td>" + escapeHtml(r.stat) + "</td>" +
      '<td class="cmd">' + nm + "</td>" +
      '<td><div class="row-actions">' +
        '<button class="btn btn-sm" data-kill="term" data-pid="' + r.pid + '">结束</button>' +
        '<button class="btn btn-sm btn-danger" data-kill="kill" data-pid="' + r.pid + '">强制</button>' +
      "</div></td></tr>";
  }).join("");
  updateSortArrows();
}
function updateSortArrows() {
  document.querySelectorAll("th.sortable").forEach((th) => {
    const k = th.getAttribute("data-sort");
    th.innerHTML = th.textContent.replace(/[ ▲▼]+$/, "") + (k === sortKey ? (sortDir < 0 ? ' <span class="arr">▼</span>' : ' <span class="arr">▲</span>') : "");
  });
}
async function loadProc(silent) {
  if (!procLoaded) procRows.innerHTML = '<tr><td colspan="8" class="muted center">加载中…</td></tr>';
  try {
    const out = await sh("ps aux 2>&1", 20000);
    if (notFound(out)) { showBanner("无法列出进程：" + out.trim().slice(0, 200)); return; }
    procData = parsePsAux(out);
    if (!procData.length && out.trim()) { showBanner("ps 输出无法解析：\n" + out.trim().slice(0, 200)); return; }
    clearBanner();
    renderProc();
    procLoaded = true;
    infoEl.textContent = procData.length + " 进程";
  } catch (e) {
    showBanner("加载失败：" + (e && e.message ? e.message : String(e)));
    if (!procLoaded) procRows.innerHTML = '<tr><td colspan="8" class="muted center">—</td></tr>';
  }
}
async function killPid(pid, force, nameHint) {
  if (!RE_PID.test(pid)) { showBanner("非法 PID"); return; }
  const proc = procData.find((r) => r.pid === pid);
  const nm = proc ? proc.cmd : (nameHint || "");
  const label = force ? "强制结束 (kill -9)" : "结束 (SIGTERM)";
  const msg = label + ' 进程 PID ' + pid + (nm ? "（" + nm.slice(0, 70) + "）" : "") + " ？";
  if (!(await showConfirm(msg, force))) return;
  clearBanner();
  try {
    const out = await sh("kill " + (force ? "-9 " : "") + "'" + pid + "' 2>&1");
    const t = out.trim();
    if (t && /No such process|not permitted|Operation not permitted|denied/i.test(t)) showBanner("结束失败：" + t.slice(0, 200));
  } catch (e) { showBanner("结束失败：" + (e && e.message ? e.message : String(e))); }
  await refreshActive(true);
}

// ===================== systemd =====================
let sdData = [];
let sdLoaded = false;
let sdSig = null;

function sdBadge(active) {
  const a = (active || "").toLowerCase();
  if (a === "active") return "on";
  if (a === "failed") return "crit";
  if (a === "activating" || a === "deactivating" || a === "reloading") return "warn";
  return "off";
}
function parseUnits(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const p = line.split(/\s+/);
    if (p.length < 4) continue;
    const unit = p[0];
    if (!/\.service$/.test(unit)) continue;
    out.push({ unit, load: p[1], active: p[2], sub: p[3], desc: p.slice(4).join(" ") });
  }
  return out;
}
function sortedFilteredSd() {
  const q = $("sd-search").value.trim().toLowerCase();
  let list = sdData.slice();
  if (q) list = list.filter((s) => (s.unit + " " + s.desc).toLowerCase().includes(q));
  list.sort((a, b) => a.unit.localeCompare(b.unit));
  return list;
}
function renderSystemd() {
  const list = sortedFilteredSd();
  const sig = list.map((s) => [s.unit, s.active, s.sub].join("|")).join("\n");
  if (sig === sdSig && sdLoaded) return;
  sdSig = sig;
  if (!list.length) { sdRows.innerHTML = '<tr><td colspan="4" class="muted center">没有匹配的服务</td></tr>'; return; }
  sdRows.innerHTML = list.map((s) => {
    const u = escapeHtml(s.unit);
    const running = s.active === "active";
    const b = (act, label, extra) => '<button class="btn btn-sm ' + (extra || "") + '" data-sd="' + act + '" data-unit="' + u + '">' + label + "</button>";
    let ops = running ? b("stop", "停止", "btn-danger") + b("restart", "重启") : b("start", "启动");
    ops += b("enable", "开机启用") + b("disable", "禁用") + b("logs", "日志") + b("status", "状态");
    return "<tr>" +
      '<td class="name">' + u + "</td>" +
      '<td><span class="badge ' + sdBadge(s.active) + '">' + escapeHtml(s.active) + "</span> " +
        '<span class="muted">' + escapeHtml(s.sub) + "</span></td>" +
      '<td class="muted">' + escapeHtml(s.desc) + "</td>" +
      '<td><div class="row-actions">' + ops + "</div></td></tr>";
  }).join("");
}
async function loadSystemd(silent) {
  if (!sdLoaded) sdRows.innerHTML = '<tr><td colspan="4" class="muted center">加载中…</td></tr>';
  try {
    const out = await sh("systemctl list-units --type=service --all --no-pager --no-legend --plain 2>&1", 20000);
    if (notFound(out) || /Failed to connect to bus|Failed to get D-Bus/i.test(out)) {
      showBanner("本机无 systemd 或无法连接：" + out.trim().slice(0, 200));
      if (!sdLoaded) sdRows.innerHTML = '<tr><td colspan="4" class="muted center">—</td></tr>';
      return;
    }
    clearBanner();
    sdData = parseUnits(out);
    renderSystemd();
    sdLoaded = true;
  } catch (e) {
    showBanner("加载失败：" + (e && e.message ? e.message : String(e)));
    if (!sdLoaded) sdRows.innerHTML = '<tr><td colspan="4" class="muted center">—</td></tr>';
  }
}
const SD_LABEL = { start: "启动", stop: "停止", restart: "重启", enable: "开机启用", disable: "禁用" };
async function sdAction(op, unit) {
  if (!RE_UNIT.test(unit)) { showBanner("非法服务名"); return; }
  if (op === "logs") {
    openLog("日志 · " + unit);
    try { logBody.textContent = (await sh("journalctl -u '" + unit + "' -n 200 --no-pager 2>&1", 20000)).trim() || "（无日志，或本机无 journald）"; }
    catch (e) { logBody.textContent = "加载失败：" + (e && e.message ? e.message : String(e)); }
    return;
  }
  if (op === "status") {
    openLog("状态 · " + unit);
    try { logBody.textContent = (await sh("systemctl status '" + unit + "' --no-pager -n 50 2>&1", 15000)).trim() || "（无输出）"; }
    catch (e) { logBody.textContent = "加载失败：" + (e && e.message ? e.message : String(e)); }
    return;
  }
  const label = SD_LABEL[op] || op;
  if (!(await showConfirm("确定" + label + '服务 "' + unit + '" 吗？', op === "stop"))) return;
  clearBanner();
  try {
    const out = await sh("systemctl " + op + " '" + unit + "' 2>&1", 30000);
    const t = out.trim();
    if (t && /Failed|denied|not permitted|Interactive authentication required/i.test(t)) showBanner(label + "失败：" + t.slice(0, 240));
  } catch (e) { showBanner(label + "失败：" + (e && e.message ? e.message : String(e))); }
  await loadSystemd(true);
}

// ===================== pm2 =====================
let pm2Loaded = false;
let pm2Sig = null;

function extractJsonArray(text) {
  const t = String(text || "").trim();
  try { return JSON.parse(t); } catch {}
  const i = t.indexOf("["), j = t.lastIndexOf("]");
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch {} }
  return null;
}
function pm2Badge(st) {
  const s = (st || "").toLowerCase();
  if (s === "online") return "on";
  if (s === "errored") return "crit";
  if (s === "stopping" || s === "launching" || s === "one-launch-status") return "warn";
  return "off";
}
function memHuman(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + "G";
  if (b >= 1048576) return (b / 1048576).toFixed(0) + "M";
  if (b >= 1024) return (b / 1024).toFixed(0) + "K";
  return b + "B";
}
function renderPm2(list) {
  const sig = list.map((p) => [p.id, p.name, p.status, p.restart].join("|")).join("\n");
  if (sig === pm2Sig && pm2Loaded) {
    for (const p of list) {
      const tr = pm2Rows.querySelector('tr[data-pm2="' + p.id + '"]');
      if (!tr) continue;
      tr.querySelector('[data-cell="cpu"]').textContent = p.cpu + "%";
      tr.querySelector('[data-cell="mem"]').textContent = memHuman(p.mem);
    }
    return;
  }
  pm2Sig = sig;
  if (!list.length) { pm2Rows.innerHTML = '<tr><td colspan="6" class="muted center">没有 pm2 进程</td></tr>'; return; }
  pm2Rows.innerHTML = list.map((p) => {
    const online = p.status === "online";
    const b = (act, label, extra) => '<button class="btn btn-sm ' + (extra || "") + '" data-pm2act="' + act + '" data-id="' + p.id + '" data-name="' + escapeHtml(p.name) + '">' + label + "</button>";
    let ops = online ? b("stop", "停止", "btn-danger") + b("restart", "重启") : b("start", "启动") + b("restart", "重启");
    ops += b("logs", "日志") + b("delete", "删除", "btn-danger");
    return '<tr data-pm2="' + p.id + '">' +
      '<td class="name">' + escapeHtml(p.name) + ' <span class="muted">#' + p.id + "</span></td>" +
      '<td><span class="badge ' + pm2Badge(p.status) + '">' + escapeHtml(p.status || "?") + "</span></td>" +
      '<td class="num" data-cell="cpu">' + p.cpu + "%</td>" +
      '<td class="num" data-cell="mem">' + memHuman(p.mem) + "</td>" +
      '<td class="num">' + p.restart + "</td>" +
      '<td><div class="row-actions">' + ops + "</div></td></tr>";
  }).join("");
}
async function loadPm2(silent) {
  if (!pm2Loaded) pm2Rows.innerHTML = '<tr><td colspan="6" class="muted center">加载中…</td></tr>';
  try {
    const out = await sh("pm2 jlist 2>&1", 20000);
    if (notFound(out)) { showBanner("未检测到 pm2（目标机器未安装，或不在 Agent 用户的 PATH 中）"); if (!pm2Loaded) pm2Rows.innerHTML = '<tr><td colspan="6" class="muted center">—</td></tr>'; return; }
    const arr = extractJsonArray(out);
    if (!Array.isArray(arr)) { showBanner("pm2 输出无法解析：\n" + out.trim().slice(0, 200)); return; }
    clearBanner();
    const list = arr.map((p) => {
      const env = p.pm2_env || {}, mon = p.monit || {};
      return { id: String(p.pm_id), name: p.name || "?", status: env.status || "?", cpu: Number(mon.cpu) || 0, mem: mon.memory || 0, restart: env.restart_time || 0 };
    }).filter((p) => RE_PID.test(p.id));
    renderPm2(list);
    pm2Loaded = true;
  } catch (e) {
    showBanner("加载失败：" + (e && e.message ? e.message : String(e)));
    if (!pm2Loaded) pm2Rows.innerHTML = '<tr><td colspan="6" class="muted center">—</td></tr>';
  }
}
const PM2_LABEL = { start: "启动", stop: "停止", restart: "重启", delete: "删除" };
async function pm2Action(op, id, name) {
  if (!RE_PID.test(id)) { showBanner("非法 pm2 id"); return; }
  if (op === "logs") {
    openLog("pm2 日志 · " + (name || id));
    try {
      // 直接 tail pm2 的日志文件，绕开 `pm2 logs --nostream` 在非 TTY 下只吐 [TAILING] 横幅、不出内容的问题
      const arr = extractJsonArray(await sh("pm2 jlist 2>&1"));
      const p = Array.isArray(arr) ? arr.find((x) => String(x.pm_id) === id) : null;
      const env = (p && p.pm2_env) || {};
      const okPath = (f) => typeof f === "string" && /^\/[^'\n]*$/.test(f);
      const err = env.pm_err_log_path, out = env.pm_out_log_path;
      let text;
      if (okPath(err) || okPath(out)) {
        const parts = [];
        if (okPath(err)) parts.push("echo '──────── stderr ────────'; tail -n 200 '" + err + "' 2>&1");
        if (okPath(out)) parts.push("echo '──────── stdout ────────'; tail -n 200 '" + out + "' 2>&1");
        text = (await sh(parts.join("; echo; "), 20000)).trim();
      } else {
        text = (await sh("pm2 logs '" + id + "' --lines 200 --nostream --raw 2>&1", 20000)).trim();
      }
      logBody.textContent = text || "（日志为空）";
    } catch (e) { logBody.textContent = "加载失败：" + (e && e.message ? e.message : String(e)); }
    return;
  }
  const label = PM2_LABEL[op] || op;
  if (!(await showConfirm("确定" + label + ' pm2 进程 "' + (name || id) + '" (#' + id + ") 吗？", op === "delete"))) return;
  clearBanner();
  try {
    const out = await sh("pm2 " + op + " '" + id + "' 2>&1", 30000);
    if (notFound(out)) showBanner(label + "失败：未检测到 pm2");
  } catch (e) { showBanner(label + "失败：" + (e && e.message ? e.message : String(e))); }
  await loadPm2(true);
}

// ===================== 端口 / 监听 =====================
let portsData = [];
let portsLoaded = false;
let portsSig = null;

// 兼容 ss 与 netstat 两种输出：每行抓 协议 / 第一个数字端口的本地地址 / 进程名+pid
function parseSockets(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(Netid|State|Proto|Active|recv)/i.test(line)) continue;
    const pm0 = line.match(/^(tcp6?|udp6?)\b/i);
    if (!pm0) continue;
    const proto = pm0[1].toLowerCase();
    let local = "", port = "";
    for (const t of line.split(/\s+/)) {
      const m = t.match(/^(.+):(\d+)$/);              // 第一个以 :数字端口 结尾的 token = 本地监听
      if (m) { local = m[1]; port = m[2]; break; }
    }
    if (!port) continue;
    let name = "", pid = "";
    let pm = line.match(/\("([^"]+)",pid=(\d+)/);     // ss: users:(("nginx",pid=1234,...))
    if (pm) { name = pm[1]; pid = pm[2]; }
    else { pm = line.match(/\b(\d+)\/(\S+)/); if (pm) { pid = pm[1]; name = pm[2]; } } // netstat: 1234/nginx
    out.push({ proto, local, port: Number(port), name, pid });
  }
  return out;
}
function sortedFilteredPorts() {
  const q = $("port-search").value.trim().toLowerCase();
  let list = portsData.slice();
  if (q) list = list.filter((s) => (s.port + " " + s.name + " " + s.local + " " + s.proto).toLowerCase().includes(q));
  list.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
  return list;
}
function renderPorts() {
  const list = sortedFilteredPorts();
  const sig = list.map((s) => [s.proto, s.local, s.port, s.pid, s.name].join("|")).join("\n");
  if (sig === portsSig && portsLoaded) return;
  portsSig = sig;
  if (!list.length) { portRows.innerHTML = '<tr><td colspan="5" class="muted center">没有监听端口</td></tr>'; return; }
  portRows.innerHTML = list.map((s) => {
    const k = RE_PID.test(s.pid)
      ? '<button class="btn btn-sm" data-kill="term" data-pid="' + s.pid + '" data-name="' + escapeHtml(s.name) + '">结束</button>' +
        '<button class="btn btn-sm btn-danger" data-kill="kill" data-pid="' + s.pid + '" data-name="' + escapeHtml(s.name) + '">强制</button>'
      : '<span class="muted">—</span>';
    return "<tr>" +
      "<td>" + escapeHtml(s.proto) + "</td>" +
      '<td class="cmd">' + escapeHtml(s.local || "*") + "</td>" +
      '<td class="num">' + s.port + "</td>" +
      '<td class="name">' + (escapeHtml(s.name) || "—") + (s.pid ? ' <span class="muted">#' + escapeHtml(s.pid) + "</span>" : "") + "</td>" +
      '<td><div class="row-actions">' + k + "</div></td></tr>";
  }).join("");
}
async function loadPorts(silent) {
  if (!portsLoaded) portRows.innerHTML = '<tr><td colspan="5" class="muted center">加载中…</td></tr>';
  try {
    const out = await sh("ss -tulpn 2>&1 || netstat -tulpn 2>&1", 20000);
    portsData = parseSockets(out);
    if (!portsData.length) {
      if (notFound(out)) { showBanner("未找到 ss / netstat（目标机器缺 iproute2 / net-tools）"); }
      else clearBanner();
      if (!portsLoaded) portRows.innerHTML = '<tr><td colspan="5" class="muted center">' + (notFound(out) ? "—" : "没有监听端口") + "</td></tr>";
      portsLoaded = true; return;
    }
    clearBanner();
    renderPorts();
    portsLoaded = true;
  } catch (e) {
    showBanner("加载失败：" + (e && e.message ? e.message : String(e)));
    if (!portsLoaded) portRows.innerHTML = '<tr><td colspan="5" class="muted center">—</td></tr>';
  }
}

// ===================== 日志文件（任意路径 tail）=====================
let logPath = "";
function validLogPath(p) { return /^\//.test(p) && !/['"\n\r`$\\]/.test(p); } // 绝对路径 + 禁注入字符（单引号包裹安全）
async function tailPath(path) {
  path = (path || "").trim();
  const errEl = $("log-err"), outEl = $("log-out");
  errEl.classList.add("hidden");
  if (!validLogPath(path)) { errEl.textContent = "路径需为绝对路径（/ 开头），且不含 ' \" 反引号 $ \\ 换行"; errEl.classList.remove("hidden"); return; }
  const n = Number($("log-lines").value) || 200;
  logPath = path;
  $("log-path").value = path;
  outEl.textContent = "加载中…";
  try {
    const out = await sh("tail -n " + n + " '" + path + "' 2>&1", 20000);
    outEl.textContent = out.replace(/\s+$/, "") || "（空文件 / 无输出）";
  } catch (e) { outEl.textContent = "加载失败：" + (e && e.message ? e.message : String(e)); }
}
function viewLog() { tailPath($("log-path").value); }

// ===================== Tab / 自动刷新 =====================
let currentTab = "proc";
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.getAttribute("data-tab") === tab));
  $("view-proc").classList.toggle("hidden", tab !== "proc");
  $("view-ports").classList.toggle("hidden", tab !== "ports");
  $("view-systemd").classList.toggle("hidden", tab !== "systemd");
  $("view-pm2").classList.toggle("hidden", tab !== "pm2");
  $("view-log").classList.toggle("hidden", tab !== "log");
  refreshActive(false);
}
function refreshActive(silent) {
  if (currentTab === "log") { if (!silent && logPath) tailPath(logPath); return; }
  if (currentTab === "ports") return loadPorts(silent);
  if (currentTab === "systemd") return loadSystemd(silent);
  if (currentTab === "pm2") return loadPm2(silent);
  return loadProc(silent);
}
function anyModalOpen() { return !logModal.classList.contains("hidden") || !confirmModal.classList.contains("hidden"); }
function autoRefresh() { if (!document.hidden && !anyModalOpen()) refreshActive(true); }

// ===================== 事件 =====================
$("refresh").addEventListener("click", () => refreshActive(false));
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.getAttribute("data-tab"))));
$("log-close").addEventListener("click", () => logModal.classList.add("hidden"));
logModal.addEventListener("click", (e) => { if (e.target === logModal) logModal.classList.add("hidden"); });
confirmModal.addEventListener("click", (e) => { if (e.target === confirmModal) confirmModal.classList.add("hidden"); });

$("proc-search").addEventListener("input", renderProc);
$("proc-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-filter]");
  if (!b) return;
  procFilter = b.getAttribute("data-filter");
  document.querySelectorAll("#proc-seg .seg-btn").forEach((x) => x.classList.toggle("active", x === b));
  procSig = null; renderProc();
});
$("sd-search").addEventListener("input", renderSystemd);
$("port-search").addEventListener("input", renderPorts);
document.querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", () => {
  const k = th.getAttribute("data-sort");
  if (k === sortKey) sortDir = -sortDir; else { sortKey = k; sortDir = -1; }
  procSig = null; renderProc();
}));
procRows.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-kill]");
  if (b) killPid(b.getAttribute("data-pid"), b.getAttribute("data-kill") === "kill");
});
sdRows.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-sd]");
  if (b) sdAction(b.getAttribute("data-sd"), b.getAttribute("data-unit"));
});
pm2Rows.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-pm2act]");
  if (b) pm2Action(b.getAttribute("data-pm2act"), b.getAttribute("data-id"), b.getAttribute("data-name"));
});
portRows.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-kill]");
  if (b) killPid(b.getAttribute("data-pid"), b.getAttribute("data-kill") === "kill", b.getAttribute("data-name"));
});
$("log-view").addEventListener("click", viewLog);
$("log-path").addEventListener("keydown", (e) => { if (e.key === "Enter") viewLog(); });
$("log-lines").addEventListener("change", () => { if (logPath) tailPath(logPath); });
$("log-quick").addEventListener("click", (e) => { const b = e.target.closest("button[data-path]"); if (b) tailPath(b.getAttribute("data-path")); });

// ===================== 启动 =====================
if (!token) {
  showBanner("缺少 token：请通过 board 的扩展入口打开本页面。");
  procRows.innerHTML = '<tr><td colspan="8" class="muted center">—</td></tr>';
} else {
  loadProc();
  setInterval(autoRefresh, 15000);
}
