/**
 * log-cleanup-worker v1.0
 *
 * 清空（truncate）所有 Agent 上的 NodeGet 日志文件，保留文件本身。
 * 默认清理：
 *   /var/log/nodeget-agent/app.log
 *   /var/log/nodeget-server/app.log   （仅在该机器上存在时，通常是 Server 同机 Agent）
 *
 * 实现方式：对每台目标 Agent 下发 execute 任务执行 `: > file`（等价 truncate -s 0）。
 *   - 文件不存在 → absent（跳过）
 *   - 小于 min_bytes → kept（未清）
 *   - 无写权限    → denied
 *   - 已清空      → cleaned，并回报清掉的字节数
 *
 * 入口:
 *   onCron: 自动清理全部 Agent
 *   onCall / onInlineCall:
 *     clean / get_config / set_config / list_targets / get_last
 *   onRoute:
 *     GET  /run /clean /config /targets /last
 *     POST /clean /config
 *
 * env:
 *   token: NodeGet 平台 Token（需 Task::Create(execute)、Task::Read、Agent 列表、KV 读写权限）
 *
 * ⚠️ 破坏性操作：会清空日志内容。请确认日志无需保留再启用定时。
 */

var NS = "global";
var CFG_KEY = "log_cleanup_config";
var STATE_KEY = "log_cleanup_state";

var DEFAULT_CFG = {
  enabled: true,
  log_paths: [
    "/var/log/nodeget-agent/app.log",
    "/var/log/nodeget-server/app.log",
  ],
  target_uuids: [], // 留空 = 每轮自动跟随全部 Agent
  min_bytes: 0, // 仅清大于该字节数的文件，0 = 总是清
  timeout_ms: 20000,
  cron_prefix: "log_cleanup", // 安装到 Agent 的 cron 名前缀
  cron_expression: "0 0 4 * * *", // 6 段(秒 分 时 日 月 周)：每天 04:00
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

function nowCST() {
  return new Date(Date.now() + 8 * 3600000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

function uniq(list) {
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var key = String(list[i]);
    if (seen[key]) continue;
    seen[key] = true;
    out.push(key);
  }
  return out;
}

function human(bytes) {
  bytes = Number(bytes) || 0;
  var units = ["B", "KiB", "MiB", "GiB", "TiB"];
  var i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i += 1;
  }
  return (i === 0 ? String(bytes) : bytes.toFixed(2)) + " " + units[i];
}

function isRecord(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

async function rpc(method, params) {
  var response = await nodeget(method, params);
  if (response && response.error)
    throw new Error("RPC " + method + ": " + JSON.stringify(response.error));
  return response ? response.result : undefined;
}

function normalizeCfg(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  var paths =
    Array.isArray(raw.log_paths) && raw.log_paths.length
      ? uniq(raw.log_paths.map(String).filter(Boolean))
      : DEFAULT_CFG.log_paths.slice();
  return {
    enabled: raw.enabled !== false,
    log_paths: paths,
    target_uuids: Array.isArray(raw.target_uuids)
      ? uniq(raw.target_uuids.map(String))
      : [],
    min_bytes: Math.max(0, Number(raw.min_bytes || 0) || 0),
    timeout_ms: Math.max(
      5000,
      Math.min(120000, Number(raw.timeout_ms || DEFAULT_CFG.timeout_ms)),
    ),
    cron_prefix: String(raw.cron_prefix || DEFAULT_CFG.cron_prefix),
    cron_expression: String(
      raw.cron_expression || DEFAULT_CFG.cron_expression,
    ),
  };
}

async function getCfg(token) {
  var value = await rpc("kv_get_value", {
    token: token,
    namespace: NS,
    key: CFG_KEY,
  });
  return normalizeCfg(value);
}

async function setCfg(token, cfg) {
  await rpc("kv_set_value", {
    token: token,
    namespace: NS,
    key: CFG_KEY,
    value: cfg,
  });
}

async function getState(token) {
  var value = await rpc("kv_get_value", {
    token: token,
    namespace: NS,
    key: STATE_KEY,
  });
  return {
    last_clean: (value && Number(value.last_clean)) || 0,
    last_result: (value && value.last_result) || null,
  };
}

async function setState(token, state) {
  await rpc("kv_set_value", {
    token: token,
    namespace: NS,
    key: STATE_KEY,
    value: state,
  });
}

async function listAgentUuids(token) {
  try {
    var first = await rpc("agent-uuid_list_all", { token: token });
    if (Array.isArray(first)) return first;
  } catch (e) {}
  var second = await rpc("nodeget-server_list_all_agent_uuid", {
    token: token,
  });
  if (Array.isArray(second)) return second;
  if (second && Array.isArray(second.uuids)) return second.uuids;
  return [];
}

async function getNameMap(token, uuids) {
  if (!uuids.length) return new Map();
  var rows = await rpc("kv_get_multi_value", {
    token: token,
    namespace_key: uuids.map(function (uuid) {
      return { namespace: uuid, key: "metadata_name" };
    }),
  });
  var map = new Map();
  for (var i = 0; i < (rows || []).length; i++) {
    map.set(rows[i].namespace, rows[i].value);
  }
  return map;
}

function nameOf(map, uuid) {
  var name = map.get(uuid);
  return typeof name === "string" && name ? name : uuid.slice(0, 8);
}

async function listTargets(token) {
  var uuids = await listAgentUuids(token);
  var names = await getNameMap(token, uuids);
  return uuids.map(function (uuid) {
    return { uuid: uuid, name: nameOf(names, uuid) };
  });
}

async function resolveTargetUuids(token, explicitUuids, cfg) {
  if (Array.isArray(explicitUuids) && explicitUuids.length)
    return uniq(explicitUuids.map(String));
  if (cfg && Array.isArray(cfg.target_uuids) && cfg.target_uuids.length)
    return uniq(cfg.target_uuids.map(String));
  return await listAgentUuids(token);
}

function buildCleanScript() {
  return [
    "set -u",
    'min="$1"; shift',
    "printf '{\"ok\":true,\"results\":['",
    "i=0",
    'for f in "$@"; do',
    "  [ $i -eq 0 ] || printf ','",
    "  i=1",
    '  if [ -f "$f" ]; then',
    '    sz=$(wc -c < "$f" 2>/dev/null || echo 0)',
    '    if [ "$sz" -ge "$min" ]; then',
    '      if : > "$f" 2>/dev/null; then',
    '        printf \'{"file":"%s","freed":%s,"status":"cleaned"}\' "$f" "$sz"',
    "      else",
    '        printf \'{"file":"%s","freed":0,"status":"denied"}\' "$f"',
    "      fi",
    "    else",
    '      printf \'{"file":"%s","freed":0,"status":"kept"}\' "$f"',
    "    fi",
    "  else",
    '    printf \'{"file":"%s","freed":0,"status":"absent"}\' "$f"',
    "  fi",
    "done",
    "printf ']}\\n'",
  ].join("\n");
}

function makeExecuteTask(cmd, args) {
  return { execute: { cmd: cmd, args: args } };
}

function getExecuteOutput(taskRow) {
  var out =
    taskRow && taskRow.task_event_result && taskRow.task_event_result.execute;
  return typeof out === "string" ? out : "";
}

function parseLastJson(text) {
  var trimmed = String(text || "").trim();
  if (!trimmed) return null;
  var lines = trimmed
    .split(/\r?\n/)
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean);
  for (var i = lines.length - 1; i >= 0; i--) {
    var line = lines[i];
    if (line[0] !== "{" || line[line.length - 1] !== "}") continue;
    try {
      var parsed = JSON.parse(line);
      if (isRecord(parsed)) return parsed;
    } catch (e) {}
  }
  return null;
}

function parseCleanResult(uuid, name, taskRow) {
  if (taskRow && taskRow.success === false) {
    return {
      uuid: uuid,
      name: name,
      ok: false,
      error: taskRow.error_message || "task failed",
      freed: 0,
      files: [],
    };
  }
  var parsed = parseLastJson(getExecuteOutput(taskRow));
  if (!parsed) {
    return {
      uuid: uuid,
      name: name,
      ok: false,
      error: "no/invalid output",
      freed: 0,
      files: [],
    };
  }
  var files = Array.isArray(parsed.results) ? parsed.results : [];
  var freed = 0;
  for (var i = 0; i < files.length; i++) freed += Number(files[i].freed) || 0;
  return { uuid: uuid, name: name, ok: true, freed: freed, files: files };
}

async function cleanLogs(token, params) {
  var cfg = await getCfg(token);
  var paths =
    Array.isArray(params && params.log_paths) && params.log_paths.length
      ? uniq(params.log_paths.map(String).filter(Boolean))
      : cfg.log_paths;
  var minBytes =
    params && params.min_bytes != null
      ? Math.max(0, Number(params.min_bytes) || 0)
      : cfg.min_bytes;

  var targetUuids = await resolveTargetUuids(token, params && params.uuids, cfg);
  if (!targetUuids.length) return { ok: false, error: "no target agents" };

  var names = await getNameMap(token, targetUuids);
  var taskType = makeExecuteTask(
    "sh",
    ["-lc", buildCleanScript(), "sh", String(minBytes)].concat(paths),
  );

  var results = [];
  var jobs = targetUuids.map(function (uuid) {
    return rpc("task_create_task_blocking", {
      token: token,
      target_uuid: uuid,
      timeout_ms: cfg.timeout_ms,
      task_type: taskType,
    })
      .then(function (row) {
        results.push(parseCleanResult(uuid, nameOf(names, uuid), row));
      })
      .catch(function (e) {
        results.push({
          uuid: uuid,
          name: nameOf(names, uuid),
          ok: false,
          error: String(e && e.message ? e.message : e),
          freed: 0,
          files: [],
        });
      });
  });

  await Promise.all(jobs);

  results.sort(function (a, b) {
    return String(a.name).localeCompare(String(b.name));
  });

  var totalFreed = 0;
  var okCount = 0;
  for (var i = 0; i < results.length; i++) {
    totalFreed += results[i].freed || 0;
    if (results[i].ok) okCount += 1;
  }

  var result = {
    ok: true,
    time: nowCST(),
    generated_at: Date.now(),
    log_paths: paths,
    min_bytes: minBytes,
    target_count: targetUuids.length,
    ok_count: okCount,
    failed_count: results.length - okCount,
    total_freed: totalFreed,
    total_freed_human: human(totalFreed),
    agents: results,
  };

  await setState(token, { last_clean: Date.now(), last_result: result });
  return result;
}

async function getAllCrons(token) {
  var rows = await rpc("crontab_get", { token: token });
  return Array.isArray(rows) ? rows : [];
}

function buildCronSpec(cfg, uuids) {
  var taskType = makeExecuteTask(
    "sh",
    ["-lc", buildCleanScript(), "sh", String(cfg.min_bytes)].concat(
      cfg.log_paths,
    ),
  );
  return {
    name: cfg.cron_prefix + "_truncate",
    cron_expression: cfg.cron_expression,
    cron_type: { agent: [uuids, { task: taskType }] },
  };
}

// 给每台目标 Agent 安装一条本地定时 cron(自助定时清理，无需手动建 Server 任务）。
async function installCrons(token, params) {
  var cfg = await getCfg(token);
  var targetUuids = await resolveTargetUuids(token, params && params.uuids, cfg);
  if (!targetUuids.length) return { ok: false, error: "no target agents" };

  // 只有显式 uuids 才持久化目标，不固化全量，自动跟随新机器。
  var explicit =
    Array.isArray(params && params.uuids) && params.uuids.length
      ? uniq(params.uuids.map(String))
      : null;
  if (explicit && (!params || params.persist_targets !== false)) {
    cfg.target_uuids = explicit;
    await setCfg(token, cfg);
  }

  var spec = buildCronSpec(cfg, targetUuids);
  var existing = await getAllCrons(token);
  var exists = existing.some(function (c) {
    return c && c.name === spec.name;
  });

  await rpc(exists ? "crontab_edit" : "crontab_create", {
    token: token,
    name: spec.name,
    cron_expression: spec.cron_expression,
    cron_type: spec.cron_type,
  });
  await rpc("crontab_set_enable", {
    token: token,
    name: spec.name,
    enable: true,
  });

  var bootstrap = null;
  if (params && params.bootstrap_now) bootstrap = await cleanLogs(token, params);

  return {
    ok: true,
    installed: spec.name,
    cron_expression: cfg.cron_expression,
    target_count: targetUuids.length,
    bootstrap: bootstrap,
  };
}

async function dispatch(token, params) {
  if (!token) return { ok: false, error: "missing token in env" };
  var action = (params && params.action) || "clean";

  if (action === "list_targets")
    return { ok: true, items: await listTargets(token) };
  if (action === "get_config")
    return {
      ok: true,
      config: await getCfg(token),
      state: await getState(token),
    };
  if (action === "set_config") {
    var incoming = params.config || params;
    var current = await getCfg(token);
    var next = normalizeCfg(Object.assign({}, current, incoming));
    await setCfg(token, next);
    return { ok: true, config: next };
  }
  if (action === "get_last") {
    var st = await getState(token);
    return { ok: true, last_clean: st.last_clean, last_result: st.last_result };
  }
  if (action === "install_crons") {
    var installParams = Object.assign({ bootstrap_now: true }, params || {});
    return await installCrons(token, installParams);
  }
  if (action === "clean") return await cleanLogs(token, params || {});

  return { ok: false, error: "unknown action: " + action };
}

export default {
  async onCron(params, env, ctx) {
    var token = env && env.token;
    try {
      var cfg = await getCfg(token);
      if (!cfg.enabled)
        return { ok: true, skipped: true, reason: "disabled" };
      return await cleanLogs(token, params || {});
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  },

  async onCall(params, env, ctx) {
    var token = env && env.token;
    try {
      return await dispatch(token, params || {});
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  },

  async onInlineCall(params, env, ctx) {
    var token = env && env.token;
    try {
      return await dispatch(token, params || {});
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  },

  async onRoute(request, env, ctx) {
    var token = env && env.token;
    if (!token) return json({ ok: false, error: "missing token in env" }, 500);

    var url = new URL(request.url);
    var path = url.pathname;
    var method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    try {
      if (method === "GET" && path.endsWith("/targets"))
        return json(await dispatch(token, { action: "list_targets" }));
      if (method === "GET" && path.endsWith("/config"))
        return json(await dispatch(token, { action: "get_config" }));
      if (method === "POST" && path.endsWith("/config"))
        return json(
          await dispatch(token, {
            action: "set_config",
            config: await request.json(),
          }),
        );
      if (method === "GET" && path.endsWith("/last"))
        return json(await dispatch(token, { action: "get_last" }));
      if (
        (method === "GET" && path.endsWith("/run")) ||
        (method === "GET" && path.endsWith("/clean"))
      )
        return json(await dispatch(token, { action: "clean" }));
      if (method === "POST" && path.endsWith("/clean"))
        return json(
          await dispatch(
            token,
            Object.assign({ action: "clean" }, await request.json()),
          ),
        );
      if (method === "GET" && path.endsWith("/install"))
        return json(await dispatch(token, { action: "install_crons" }));
      if (method === "POST" && path.endsWith("/install"))
        return json(
          await dispatch(
            token,
            Object.assign({ action: "install_crons" }, await request.json()),
          ),
        );
      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      return json(
        { ok: false, error: String(e && e.message ? e.message : e) },
        500,
      );
    }
  },
};
