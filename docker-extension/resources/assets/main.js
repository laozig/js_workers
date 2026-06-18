// Docker 管理器 · 阶段 3（容器 + 镜像 + 运行）
// 运行环境：board 内 iframe，URL hash 携带 token / node / theme。
// 通过同源 HTTP JSON-RPC 调 task_create_task_blocking，下发 execute(docker CLI) 到目标 Agent。

// ---- hash 参数（参考 board demo-extension/main.js）----
function parseHashParams() {
  const hash = window.location.hash;
  const query = hash.startsWith("#?") ? hash.slice(2) : hash.slice(1);
  const params = new URLSearchParams(query);
  return {
    token: params.get("token") || "",
    node: params.get("node") || "",
    theme: params.get("theme") || "dark",
  };
}

const { token, node, theme } = parseHashParams();
document.documentElement.setAttribute("data-theme", theme === "light" ? "light" : "dark");
window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "theme-change") {
    document.documentElement.setAttribute("data-theme", e.data.theme === "light" ? "light" : "dark");
  }
});

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const rowsEl = $("rows");
const imgRowsEl = $("img-rows");
const bannerEl = $("banner");
const infoEl = $("info-summary");
const nodeLabel = $("node-label");
const logModal = $("logmodal");
const logTitle = $("log-title");
const logBody = $("log-body");
const confirmModal = $("confirmmodal");
const confirmMsg = $("confirm-msg");
const confirmOk = $("confirm-ok");
const confirmCancel = $("confirm-cancel");
const runModal = $("runmodal");
const runError = $("run-error");

nodeLabel.textContent = node ? node.slice(0, 12) : "—";

// ---- 工具 ----
const RPC_URL = window.location.origin + "/nodeget/rpc";
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;            // 容器/镜像 id、容器名
const RE_IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/;        // 镜像引用 repo[:tag][@digest]
const RE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const RE_PORT = /^(\d{1,3}(\.\d{1,3}){3}:)?\d{1,5}:\d{1,5}(\/(tcp|udp))?$/;
const RESTARTS = ["", "unless-stopped", "always", "on-failure"];
// 单引号包裹下，禁这些字符即可阻断逃逸/注入
const noDanger = (v) => !/['"\n\r`$\\]/.test(v);

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
function splitLines(s) {
  return String(s || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}
function showBanner(msg) { bannerEl.textContent = msg; bannerEl.classList.remove("hidden"); }
function clearBanner() { bannerEl.textContent = ""; bannerEl.classList.add("hidden"); }

let rpcId = 0;
// 静默刷新状态：仅首次显示“加载中”，且仅当数据签名变化时才重建 DOM（消除定时刷新闪烁）
let containersLoaded = false;
let imagesLoaded = false;
let lastSig = null;
let lastImgSig = null;
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

// 在目标 Agent 上执行 shell（合并 stderr），返回 stdout
async function dockerSh(script, timeoutMs) {
  if (!node) throw new Error("未指定节点：本插件仅支持节点级路由（请从某台机器的 Docker 页进入）");
  const row = await rpc("task_create_task_blocking", {
    target_uuid: node,
    task_type: { execute: { cmd: "sh", args: ["-c", script] } },
    timeout_ms: timeoutMs || 20000,
  });
  if (row && row.success === false) throw new Error(row.error_message || "任务执行失败");
  const out = row && row.task_event_result && row.task_event_result.execute;
  return typeof out === "string" ? out : "";
}

function dockerFatal(text) {
  return /Cannot connect to the Docker daemon|permission denied|command not found|not found: docker/i.test(text);
}
function parseJsonLines(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ===================== 容器 =====================
function stateClass(state, status) {
  const s = (state || "").toLowerCase();
  if (s === "running") return "running";
  if (s === "paused") return "paused";
  if (s === "exited" || s === "dead") return "exited";
  if (!state) {
    if (/^up/i.test(status || "")) return "running";
    if (/^exited/i.test(status || "")) return "exited";
    if (/paused/i.test(status || "")) return "paused";
  }
  return "other";
}

function opsFor(cls, opKey, name) {
  if (!opKey) return "";
  const nm = escapeHtml(name);
  const b = (act, label, extra) =>
    `<button class="btn btn-sm ${extra}" data-act="${act}" data-id="${escapeHtml(opKey)}" data-name="${nm}">${label}</button>`;
  let ops = "";
  if (cls === "running") ops = b("stop", "停止", "btn-danger") + b("restart", "重启", "");
  else if (cls === "paused") ops = b("unpause", "恢复", "");
  else ops = b("start", "启动", "");
  return ops + b("rm", "删除", "btn-danger");
}

function renderRows(list) {
  // 签名只取关键字段（忽略 Status 的“Up X 分钟”时间增长），未变则不动 DOM
  const sig = list.map((c) => {
    const name = (c.Names || c.Name || "").replace(/^\//, "");
    const id = c.ID || c.Id || "";
    return [id, name, c.State || "", c.Image || "", c.Ports || ""].join("|");
  }).join("\n");
  if (sig === lastSig) return;
  lastSig = sig;
  if (!list.length) { rowsEl.innerHTML = '<tr><td colspan="6" class="muted center">没有容器</td></tr>'; return; }
  rowsEl.innerHTML = list.map((c) => {
    const name = (c.Names || c.Name || "").replace(/^\//, "");
    const cls = stateClass(c.State, c.Status);
    const id = c.ID || c.Id || "";
    const opKey = SAFE_ID.test(id) ? id : (SAFE_ID.test(name) ? name : "");
    const logBtn = opKey ? `<button class="btn btn-sm" data-log="${escapeHtml(opKey)}" data-name="${escapeHtml(name)}">日志</button>` : "";
    return "<tr>" +
      `<td class="name">${escapeHtml(name) || "—"}</td>` +
      `<td class="img">${escapeHtml(c.Image || "")}</td>` +
      `<td><span class="badge ${cls}">${escapeHtml(c.State || cls)}</span></td>` +
      `<td class="muted">${escapeHtml(c.Status || "")}</td>` +
      `<td class="ports">${escapeHtml(c.Ports || "")}</td>` +
      `<td><div class="row-actions">${opsFor(cls, opKey, name)}${logBtn}</div></td>` +
      "</tr>";
  }).join("");
}

async function loadInfo() {
  try {
    const out = await dockerSh("docker info --format '{{json .}}' 2>&1");
    const obj = parseJsonLines(out)[0];
    if (!obj) { infoEl.textContent = ""; return; }
    infoEl.textContent = `v${obj.ServerVersion || "?"} · 运行 ${obj.ContainersRunning ?? "?"}/${obj.Containers ?? "?"} · 镜像 ${obj.Images ?? "?"}`;
  } catch { infoEl.textContent = ""; }
}

async function refresh(silent) {
  const btn = $("refresh");
  if (!silent) btn.disabled = true;
  if (!containersLoaded) rowsEl.innerHTML = '<tr><td colspan="6" class="muted center">加载中…</td></tr>';
  try {
    const out = await dockerSh("docker ps -a --format '{{json .}}' 2>&1");
    if (dockerFatal(out)) {
      showBanner("Docker 不可用：" + out.trim().slice(0, 300) +
        "\n（请确认目标机器已装 docker，且 Agent 进程有访问 /var/run/docker.sock 的权限）");
      if (!containersLoaded) rowsEl.innerHTML = '<tr><td colspan="6" class="muted center">—</td></tr>';
      return;
    }
    clearBanner();
    renderRows(parseJsonLines(out));
    containersLoaded = true;
    loadInfo();
  } catch (e) {
    showBanner("加载失败：" + (e && e.message ? e.message : String(e)));
    if (!containersLoaded) rowsEl.innerHTML = '<tr><td colspan="6" class="muted center">—</td></tr>';
  } finally {
    if (!silent) btn.disabled = false;
  }
}

async function showLogs(idOrName, name) {
  if (!SAFE_ID.test(idOrName)) { showBanner("非法的容器标识"); return; }
  logTitle.textContent = "日志 · " + (name || idOrName);
  logBody.textContent = "加载中…";
  logModal.classList.remove("hidden");
  try {
    const out = await dockerSh(`docker logs --tail 200 --timestamps '${idOrName}' 2>&1`);
    logBody.textContent = out.trim() || "（无输出）";
  } catch (e) {
    logBody.textContent = "加载失败：" + (e && e.message ? e.message : String(e));
  }
}

function showConfirm(msg) {
  return new Promise((resolve) => {
    confirmMsg.textContent = msg;
    confirmModal.classList.remove("hidden");
    const done = (v) => { confirmModal.classList.add("hidden"); confirmOk.onclick = null; confirmCancel.onclick = null; resolve(v); };
    confirmOk.onclick = () => done(true);
    confirmCancel.onclick = () => done(false);
  });
}

const OP_CMD = { start: "start", stop: "stop", restart: "restart", unpause: "unpause", rm: "rm -f" };
const OP_LABEL = { start: "启动", stop: "停止", restart: "重启", unpause: "恢复", rm: "删除" };

async function dockerAction(op, id, name) {
  if (!SAFE_ID.test(id)) { showBanner("非法的容器标识"); return; }
  const label = OP_LABEL[op] || op;
  const msg = op === "rm"
    ? `确定删除容器 “${name || id}” 吗？此操作不可逆（运行中会被强制移除）。`
    : `确定要${label}容器 “${name || id}” 吗？`;
  if (!(await showConfirm(msg))) return;
  clearBanner();
  try {
    const out = await dockerSh(`docker ${OP_CMD[op]} '${id}' 2>&1`, op === "rm" ? 30000 : 20000);
    if (dockerFatal(out) || /Error response from daemon|No such container|Cannot/i.test(out)) {
      showBanner(`${label}失败：` + out.trim().slice(0, 300));
    }
  } catch (e) {
    showBanner(`${label}失败：` + (e && e.message ? e.message : String(e)));
  }
  await refresh(true);
}

// ===================== 镜像 =====================
function renderImageRows(list) {
  const sig = list.map((m) => [m.ID || m.Id || "", m.Repository || "", m.Tag || "", m.Size || ""].join("|")).join("\n");
  if (sig === lastImgSig) return;
  lastImgSig = sig;
  if (!list.length) { imgRowsEl.innerHTML = '<tr><td colspan="5" class="muted center">没有镜像</td></tr>'; return; }
  imgRowsEl.innerHTML = list.map((m) => {
    const repo = m.Repository || "<none>";
    const tag = m.Tag || "";
    const id = m.ID || m.Id || "";
    const size = m.Size || "";
    const key = SAFE_ID.test(id) ? id : "";
    const del = key ? `<button class="btn btn-sm btn-danger" data-rmi="${escapeHtml(key)}" data-name="${escapeHtml(repo + ":" + tag)}">删除</button>` : "";
    return "<tr>" +
      `<td class="name">${escapeHtml(repo)}</td>` +
      `<td class="muted">${escapeHtml(tag)}</td>` +
      `<td class="img">${escapeHtml(id)}</td>` +
      `<td class="muted">${escapeHtml(size)}</td>` +
      `<td><div class="row-actions">${del}</div></td>` +
      "</tr>";
  }).join("");
}

async function refreshImages(silent) {
  if (!imagesLoaded) imgRowsEl.innerHTML = '<tr><td colspan="5" class="muted center">加载中…</td></tr>';
  try {
    const out = await dockerSh("docker images --format '{{json .}}' 2>&1");
    if (dockerFatal(out)) {
      showBanner("Docker 不可用：" + out.trim().slice(0, 300));
      if (!imagesLoaded) imgRowsEl.innerHTML = '<tr><td colspan="5" class="muted center">—</td></tr>';
      return;
    }
    clearBanner();
    renderImageRows(parseJsonLines(out));
    imagesLoaded = true;
  } catch (e) {
    showBanner("加载失败：" + (e && e.message ? e.message : String(e)));
    if (!imagesLoaded) imgRowsEl.innerHTML = '<tr><td colspan="5" class="muted center">—</td></tr>';
  }
}

async function dockerPull() {
  const image = $("pull-input").value.trim();
  if (!image) return;
  if (!RE_IMAGE.test(image)) { showBanner("镜像名非法"); return; }
  if (!(await showConfirm(`拉取镜像 “${image}”？大镜像可能耗时较久。`))) return;
  const btn = $("pull-btn");
  btn.disabled = true;
  clearBanner();
  try {
    const out = await dockerSh(`docker pull '${image}' 2>&1`, 180000);
    if (dockerFatal(out) || /Error|not found|denied|manifest unknown|no such host/i.test(out)) {
      showBanner("拉取失败：" + out.trim().slice(-400));
    } else {
      $("pull-input").value = "";
      refreshImages(true);
    }
  } catch (e) {
    showBanner("拉取失败：" + (e && e.message ? e.message : String(e)));
  } finally {
    btn.disabled = false;
  }
}

async function dockerRmi(id, name) {
  if (!SAFE_ID.test(id)) { showBanner("非法的镜像标识"); return; }
  if (!(await showConfirm(`确定删除镜像 “${name || id}” 吗？此操作不可逆。`))) return;
  clearBanner();
  try {
    const out = await dockerSh(`docker rmi '${id}' 2>&1`, 60000);
    if (dockerFatal(out) || /Error|conflict|being used|No such/i.test(out)) {
      showBanner("删除失败：" + out.trim().slice(0, 400));
    }
  } catch (e) {
    showBanner("删除失败：" + (e && e.message ? e.message : String(e)));
  }
  refreshImages(true);
}

// ===================== 运行新容器 =====================
// 校验所有字段并构造 docker run 命令；非法即抛错。值经白名单校验 + 单引号包裹，阻断 shell 注入。
function buildRunScript(f) {
  const errs = [];
  const image = (f.image || "").trim();
  if (!image) errs.push("镜像必填");
  else if (!RE_IMAGE.test(image)) errs.push("镜像名非法：" + image);

  const name = (f.name || "").trim();
  if (name && !RE_NAME.test(name)) errs.push("容器名非法：" + name);

  const ports = splitLines(f.ports);
  for (const p of ports) if (!RE_PORT.test(p)) errs.push("端口映射非法：" + p);

  const vols = splitLines(f.vols);
  for (const v of vols) if (!v.includes(":") || !noDanger(v)) errs.push("卷映射非法：" + v);

  const envs = splitLines(f.env);
  for (const e of envs) if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(e) || !noDanger(e)) errs.push("环境变量非法：" + e);

  const restart = f.restart || "";
  if (!RESTARTS.includes(restart)) errs.push("重启策略非法");

  const cmd = (f.cmd || "").trim();
  if (cmd && !/^[A-Za-z0-9 _.\-=:/@]+$/.test(cmd)) errs.push("启动命令含非法字符（仅允许字母数字与 空格 _ - . = : / @）");

  if (errs.length) throw new Error(errs.join("；"));

  const q = (v) => `'${v}'`;
  const parts = ["docker", "run", "-d"];
  if (name) parts.push("--name", q(name));
  if (restart) parts.push("--restart", q(restart));
  for (const p of ports) parts.push("-p", q(p));
  for (const v of vols) parts.push("-v", q(v));
  for (const e of envs) parts.push("-e", q(e));
  parts.push(q(image));
  let script = parts.join(" ");
  if (cmd) script += " " + cmd; // cmd 已限定字符集，空格拆词
  return script + " 2>&1";
}

function openRun() {
  ["run-image", "run-name", "run-ports", "run-vols", "run-env", "run-cmd"].forEach((id) => ($(id).value = ""));
  $("run-restart").value = "";
  runError.classList.add("hidden");
  runModal.classList.remove("hidden");
}

async function submitRun() {
  runError.classList.add("hidden");
  let script;
  try {
    script = buildRunScript({
      image: $("run-image").value, name: $("run-name").value,
      ports: $("run-ports").value, vols: $("run-vols").value,
      env: $("run-env").value, restart: $("run-restart").value, cmd: $("run-cmd").value,
    });
  } catch (e) {
    runError.textContent = "参数错误：" + (e && e.message ? e.message : String(e));
    runError.classList.remove("hidden");
    return;
  }
  const btn = $("run-submit");
  btn.disabled = true;
  try {
    const out = await dockerSh(script, 180000);
    if (dockerFatal(out) || /Error|Conflict|No such image|invalid|denied|not found/i.test(out)) {
      runError.textContent = "运行失败：" + out.trim().slice(-400);
      runError.classList.remove("hidden");
      return;
    }
    runModal.classList.add("hidden");
    switchTab("containers");
  } catch (e) {
    runError.textContent = "运行失败：" + (e && e.message ? e.message : String(e));
    runError.classList.remove("hidden");
  } finally {
    btn.disabled = false;
  }
}

// ===================== Tab / 自动刷新 =====================
let currentTab = "containers";
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.getAttribute("data-tab") === tab));
  $("view-containers").classList.toggle("hidden", tab !== "containers");
  $("view-images").classList.toggle("hidden", tab !== "images");
  refreshActive(false);
}
function refreshActive(silent) { currentTab === "images" ? refreshImages(silent) : refresh(silent); }
function anyModalOpen() {
  return !logModal.classList.contains("hidden")
    || !confirmModal.classList.contains("hidden")
    || !runModal.classList.contains("hidden");
}
function autoRefresh() { if (!document.hidden && !anyModalOpen()) refreshActive(true); }

// ===================== 事件 =====================
$("refresh").addEventListener("click", () => refreshActive(false));
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.getAttribute("data-tab"))));

$("log-close").addEventListener("click", () => logModal.classList.add("hidden"));
logModal.addEventListener("click", (e) => { if (e.target === logModal) logModal.classList.add("hidden"); });

rowsEl.addEventListener("click", (e) => {
  const logBtn = e.target.closest("button[data-log]");
  if (logBtn) { showLogs(logBtn.getAttribute("data-log"), logBtn.getAttribute("data-name")); return; }
  const actBtn = e.target.closest("button[data-act]");
  if (actBtn) dockerAction(actBtn.getAttribute("data-act"), actBtn.getAttribute("data-id"), actBtn.getAttribute("data-name"));
});

imgRowsEl.addEventListener("click", (e) => {
  const rmiBtn = e.target.closest("button[data-rmi]");
  if (rmiBtn) dockerRmi(rmiBtn.getAttribute("data-rmi"), rmiBtn.getAttribute("data-name"));
});

$("pull-btn").addEventListener("click", dockerPull);
$("pull-input").addEventListener("keydown", (e) => { if (e.key === "Enter") dockerPull(); });

$("run-open").addEventListener("click", openRun);
$("run-close").addEventListener("click", () => runModal.classList.add("hidden"));
$("run-cancel").addEventListener("click", () => runModal.classList.add("hidden"));
$("run-submit").addEventListener("click", submitRun);
runModal.addEventListener("click", (e) => { if (e.target === runModal) runModal.classList.add("hidden"); });

// ===================== 启动 =====================
if (!token) {
  showBanner("缺少 token：请通过 board 的扩展入口打开本页面。");
  rowsEl.innerHTML = '<tr><td colspan="6" class="muted center">—</td></tr>';
} else {
  refresh();
  setInterval(autoRefresh, 15000);
}
