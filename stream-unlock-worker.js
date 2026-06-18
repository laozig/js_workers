/**
 * stream-unlock-worker v3.0
 *
 * Agent 定时任务编排器：
 * - 在每个 Agent 上创建定时 `execute` 任务
 * - Agent 本机发起 YouTube Premium / Netflix 探测
 * - 结果先落到 `/tmp/stream-unlock/*.json`
 * - `cat` 输出结果后自动删除文件
 * - 服务端统一通过 `task_query` 聚合结果
 *
 * 入口:
 *   onCall / onInlineCall:
 *     list_targets / get_config / set_config / install_crons / list_crons / get_results
 *   onRoute:
 *     GET  /targets /config /crons /results
 *     POST /config /install
 *   onCron:
 *     自动 install_crons + get_results
 *
 * env:
 *   token:        NodeGet 平台 Token
 */

var NS = "global";
var CFG_KEY = "stream_unlock_agent_config";
var STATE_KEY = "stream_unlock_agent_state";

var DEFAULT_CFG = {
  enabled: true,
  cron_prefix: "stream_unlock",
  cron_expression: "0 0 0,12 * * *",
  target_uuids: [],
  bootstrap_on_install: true,
  bootstrap_timeout_ms: 30000,
  enable_youtube: true,
  enable_netflix: true,
  enable_ipv4: true,
  enable_ipv6: true,
  user_agent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  accept_language: "en",
  youtube_url: "https://www.youtube.com/premium",
  youtube_cookies:
    "YSC=BiCUU3-5Gdk; CONSENT=YES+cb.20220301-11-p0.en+FX+700; GPS=1; VISITOR_INFO1_LIVE=4VwPMkB7W5A; PREF=tz=Asia.Shanghai; _gcl_au=1.1.1809531354.1646633279",
  netflix_title_a: "81280792",
  netflix_title_b: "70143836",
  result_dir: "/tmp/stream-unlock",
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

function randomId() {
  return Date.now() + Math.floor(Math.random() * 1000000);
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

async function rpc(method, params) {
  var response = await nodeget(method, params);
  if (response && response.error)
    throw new Error("RPC " + method + ": " + JSON.stringify(response.error));
  return response ? response.result : undefined;
}

async function rpcBatch(items) {
  if (!items || !items.length) return [];
  var response = await nodeget(items);
  return response && response.result ? response.result : response;
}

function normalizeCfg(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: raw.enabled !== false,
    cron_prefix: String(raw.cron_prefix || DEFAULT_CFG.cron_prefix),
    cron_expression: String(raw.cron_expression || DEFAULT_CFG.cron_expression),
    target_uuids: Array.isArray(raw.target_uuids)
      ? uniq(raw.target_uuids.map(String))
      : [],
    bootstrap_on_install: raw.bootstrap_on_install !== false,
    bootstrap_timeout_ms: Math.max(
      5000,
      Math.min(
        120000,
        Number(raw.bootstrap_timeout_ms || DEFAULT_CFG.bootstrap_timeout_ms),
      ),
    ),
    enable_youtube: raw.enable_youtube !== false,
    enable_netflix: raw.enable_netflix !== false,
    enable_ipv4: raw.enable_ipv4 !== false,
    enable_ipv6: raw.enable_ipv6 !== false,
    user_agent: String(raw.user_agent || DEFAULT_CFG.user_agent),
    accept_language: String(raw.accept_language || DEFAULT_CFG.accept_language),
    youtube_url: String(raw.youtube_url || DEFAULT_CFG.youtube_url),
    youtube_cookies: String(raw.youtube_cookies || DEFAULT_CFG.youtube_cookies),
    netflix_title_a: String(raw.netflix_title_a || DEFAULT_CFG.netflix_title_a),
    netflix_title_b: String(raw.netflix_title_b || DEFAULT_CFG.netflix_title_b),
    result_dir: String(raw.result_dir || DEFAULT_CFG.result_dir),
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
    last_install: (value && Number(value.last_install)) || 0,
    last_query: (value && Number(value.last_query)) || 0,
    managed_names: Array.isArray(value && value.managed_names)
      ? value.managed_names
      : [],
    target_uuids: Array.isArray(value && value.target_uuids)
      ? value.target_uuids
      : [],
    last_result: (value && value.last_result) || null,
    cached_results:
      value && value.cached_results && typeof value.cached_results === "object"
        ? value.cached_results
        : {},
    last_bootstrap: (value && Number(value.last_bootstrap)) || 0,
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

function hasCachedBootstrapResults(state) {
  var cached = state && state.cached_results;
  if (!cached || typeof cached !== "object") return false;
  for (var uuid in cached) {
    if (!Object.prototype.hasOwnProperty.call(cached, uuid)) continue;
    var rows = cached[uuid];
    if (!rows || typeof rows !== "object") continue;
    for (var cronSource in rows) {
      if (Object.prototype.hasOwnProperty.call(rows, cronSource)) return true;
    }
  }
  return false;
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

async function listTargets(token, onlyUuids) {
  var uuids =
    Array.isArray(onlyUuids) && onlyUuids.length
      ? uniq(onlyUuids.map(String))
      : await listAgentUuids(token);
  var names = await getNameMap(token, uuids);
  return uuids.map(function (uuid) {
    return {
      uuid: uuid,
      name:
        typeof names.get(uuid) === "string" && names.get(uuid)
          ? names.get(uuid)
          : uuid.slice(0, 8),
    };
  });
}

function cronName(prefix, service, family, part) {
  return prefix + "_" + service + "_" + family + (part ? "_" + part : "");
}

function getAllManagedNames(prefix) {
  return [
    cronName(prefix, "youtube", "ipv4"),
    cronName(prefix, "youtube", "ipv6"),
    cronName(prefix, "netflix", "ipv4", "a"),
    cronName(prefix, "netflix", "ipv4", "b"),
    cronName(prefix, "netflix", "ipv6", "a"),
    cronName(prefix, "netflix", "ipv6", "b"),
  ];
}

function makeExecuteTask(cmd, args) {
  return {
    task: {
      execute: {
        cmd: cmd,
        args: args,
      },
    },
  };
}

function buildYoutubeExecuteScript() {
  return [
    "set -eu",
    'job="$1"',
    'family_flag="$2"',
    'url="$3"',
    'cookie="$4"',
    'ua="$5"',
    'lang="$6"',
    'result_dir="$7"',
    'mkdir -p "$result_dir"',
    'file="$result_dir/$job.json"',
    "ts=$(( $(date +%s) * 1000 ))",
    'body="$(curl -fsSL --max-time 20 $family_flag -A "$ua" -H "Accept-Language: $lang" -b "$cookie" "$url" 2>/dev/null || true)"',
    'status="bad"',
    'region="n/a"',
    'case "$body" in',
    '  *"www.google.cn"*) status="cn"; region="CN" ;;',
    '  *"Premium is not available in your country"*) status="noprem" ;;',
    '  *"ad-free"*)',
    '    region="$(printf \'%s\' "$body" | grep -o \'"contentRegion":"[^"]*"\' | head -n1 | cut -d\'"\' -f4)"',
    '    [ -n "$region" ] || region="n/a"',
    '    status="yes"',
    "    ;;",
    "esac",
    'printf \'{"service":"youtube","status":"%s","region":"%s","timestamp":%s}\\n\' "$status" "$region" "$ts" > "$file"',
    'cat "$file"',
    'rm -f "$file"',
  ].join("\n");
}

function buildNetflixExecuteScript() {
  return [
    "set -eu",
    'job="$1"',
    'family_flag="$2"',
    'url="$3"',
    'ua="$4"',
    'lang="$5"',
    'part="$6"',
    'result_dir="$7"',
    'mkdir -p "$result_dir"',
    'file="$result_dir/$job.json"',
    "ts=$(( $(date +%s) * 1000 ))",
    'body="$(curl -fsSL --max-time 20 $family_flag -A "$ua" -H "Accept-Language: $lang" "$url" 2>/dev/null || true)"',
    'if [ -z "$body" ]; then',
    '  printf \'{"service":"netflix","part":"%s","error":"empty response","region":"n/a","timestamp":%s}\\n\' "$part" "$ts" > "$file"',
    "else",
    "  blocked=false",
    "  if printf '%s' \"$body\" | grep -q 'Oh no!'; then blocked=true; fi",
    '  loc="$(curl -fsL --max-time 10 $family_flag -A "$ua" -H "Accept-Language: $lang" -o /dev/null -w \'%{url_effective}\' "$url" 2>/dev/null || true)"',
    '  region="$(printf \'%s\' "$loc" | sed -n \'s#https\\?://www\\.netflix\\.com/\\([a-z][a-z]\\)\\(-[a-z][a-z]\\)\\?/.*#\\1#p\' | tr \'a-z\' \'A-Z\')"',
    '  [ -n "$region" ] || region="n/a"',
    '  printf \'{"service":"netflix","part":"%s","blocked":%s,"region":"%s","timestamp":%s}\\n\' "$part" "$blocked" "$region" "$ts" > "$file"',
    "fi",
    'cat "$file"',
    'rm -f "$file"',
  ].join("\n");
}

function buildCronSpecs(cfg, uuids) {
  var specs = [];
  if (!uuids.length) return specs;
  var families = [];
  if (cfg.enable_ipv4) families.push({ label: "ipv4", flag: "-4" });
  if (cfg.enable_ipv6) families.push({ label: "ipv6", flag: "-6" });

  for (var i = 0; i < families.length; i++) {
    var family = families[i];

    if (cfg.enable_youtube) {
      var ytName = cronName(cfg.cron_prefix, "youtube", family.label);
      specs.push({
        name: ytName,
        cron_expression: cfg.cron_expression,
        cron_type: {
          agent: [
            uuids,
            makeExecuteTask("sh", [
              "-lc",
              buildYoutubeExecuteScript(),
              "sh",
              ytName,
              family.flag,
              cfg.youtube_url,
              cfg.youtube_cookies,
              cfg.user_agent,
              cfg.accept_language,
              cfg.result_dir,
            ]),
          ],
        },
      });
    }

    if (cfg.enable_netflix) {
      var nfAName = cronName(cfg.cron_prefix, "netflix", family.label, "a");
      var nfBName = cronName(cfg.cron_prefix, "netflix", family.label, "b");
      specs.push({
        name: nfAName,
        cron_expression: cfg.cron_expression,
        cron_type: {
          agent: [
            uuids,
            makeExecuteTask("sh", [
              "-lc",
              buildNetflixExecuteScript(),
              "sh",
              nfAName,
              family.flag,
              "https://www.netflix.com/title/" +
                encodeURIComponent(cfg.netflix_title_a),
              cfg.user_agent,
              cfg.accept_language,
              "a",
              cfg.result_dir,
            ]),
          ],
        },
      });
      specs.push({
        name: nfBName,
        cron_expression: cfg.cron_expression,
        cron_type: {
          agent: [
            uuids,
            makeExecuteTask("sh", [
              "-lc",
              buildNetflixExecuteScript(),
              "sh",
              nfBName,
              family.flag,
              "https://www.netflix.com/title/" +
                encodeURIComponent(cfg.netflix_title_b),
              cfg.user_agent,
              cfg.accept_language,
              "b",
              cfg.result_dir,
            ]),
          ],
        },
      });
    }
  }

  return specs;
}

function buildBootstrapSpecs(cfg, uuids) {
  var cronSpecs = buildCronSpecs(cfg, uuids);
  return cronSpecs.map(function (spec) {
    return {
      name: spec.name,
      uuid_list: uuids,
      task_type: spec.cron_type.agent[1].task,
    };
  });
}

function isManagedCron(name, prefix) {
  return String(name || "").indexOf(prefix + "_") === 0;
}

async function getAllCrons(token) {
  var rows = await rpc("crontab_get", { token: token });
  return Array.isArray(rows) ? rows : [];
}

function mergeCachedTaskResult(cache, uuid, cronSource, taskRow) {
  if (!cache[uuid]) cache[uuid] = {};
  cache[uuid][cronSource] = {
    success: !(taskRow && taskRow.success === false),
    timestamp: (taskRow && taskRow.timestamp) || Date.now(),
    error_message: (taskRow && taskRow.error_message) || null,
    execute: getExecuteOutput(taskRow),
  };
}

function cachedTaskRow(state, cronSource, uuid) {
  var cached =
    state &&
    state.cached_results &&
    state.cached_results[uuid] &&
    state.cached_results[uuid][cronSource];
  if (!cached) return null;
  return {
    success: cached.success !== false,
    timestamp: cached.timestamp || null,
    error_message: cached.error_message || null,
    task_event_result: {
      execute: cached.execute || "",
    },
  };
}

function pickLatestTask(taskRow, cachedRow) {
  if (!taskRow) return cachedRow || null;
  if (!cachedRow) return taskRow;
  var taskTs = Number(taskRow.timestamp || 0);
  var cachedTs = Number(cachedRow.timestamp || 0);
  return cachedTs >= taskTs ? cachedRow : taskRow;
}

async function runBootstrapTasks(token, cfg, targetUuids) {
  if (!cfg.bootstrap_on_install) {
    return {
      ok: true,
      skipped: true,
      reason: "bootstrap disabled",
      cached_results: {},
    };
  }

  var specs = buildBootstrapSpecs(cfg, targetUuids);
  if (!specs.length) {
    return {
      ok: true,
      skipped: true,
      reason: "no bootstrap specs",
      cached_results: {},
    };
  }

  var cachedResults = {};
  var failedCount = 0;
  var jobs = [];

  for (var i = 0; i < specs.length; i++) {
    var spec = specs[i];
    for (var j = 0; j < spec.uuid_list.length; j++) {
      jobs.push(
        (function (item, uuid) {
          return rpc("task_create_task_blocking", {
            token: token,
            target_uuid: uuid,
            timeout_ms: cfg.bootstrap_timeout_ms,
            task_type: item.task_type,
          })
            .then(function (taskRow) {
              mergeCachedTaskResult(cachedResults, uuid, item.name, taskRow);
              return taskRow;
            })
            .catch(function (e) {
              failedCount++;
              mergeCachedTaskResult(cachedResults, uuid, item.name, {
                success: false,
                timestamp: Date.now(),
                error_message: String(e && e.message ? e.message : e),
                task_event_result: { execute: "" },
              });
              return null;
            });
        })(spec, spec.uuid_list[j]),
      );
    }
  }

  await Promise.all(jobs);
  return {
    ok: failedCount === 0,
    skipped: false,
    task_count: specs.length,
    job_count: jobs.length,
    failed_count: failedCount,
    cached_results: cachedResults,
  };
}

async function resolveTargetUuids(token, explicitUuids, cfg) {
  if (Array.isArray(explicitUuids) && explicitUuids.length)
    return uniq(explicitUuids.map(String));
  if (cfg && Array.isArray(cfg.target_uuids) && cfg.target_uuids.length)
    return uniq(cfg.target_uuids.map(String));
  return await listAgentUuids(token);
}

async function installCrons(token, params) {
  var cfg = await getCfg(token);
  var prevState = await getState(token);
  var targetUuids = await resolveTargetUuids(
    token,
    params && params.uuids,
    cfg,
  );
  if (!targetUuids.length) return { ok: false, error: "no target agents" };

  // 只有显式指定 uuids（主动限定子集）时才持久化目标列表；
  // 自动解析出的全量目标不写回，保持 target_uuids 为空，使每轮都跟随当前全部 Agent。
  var explicitUuids =
    Array.isArray(params && params.uuids) && params.uuids.length
      ? uniq(params.uuids.map(String))
      : null;
  if (explicitUuids && (!params || params.persist_targets !== false)) {
    cfg.target_uuids = explicitUuids;
    await setCfg(token, cfg);
  }

  var specs = buildCronSpecs(cfg, targetUuids);
  var wanted = Object.create(null);
  for (var i = 0; i < specs.length; i++) wanted[specs[i].name] = true;

  var existing = await getAllCrons(token);
  var existingMap = Object.create(null);
  for (var j = 0; j < existing.length; j++)
    existingMap[existing[j].name] = existing[j];

  var batch = [];
  for (var k = 0; k < specs.length; k++) {
    var spec = specs[k];
    batch.push({
      jsonrpc: "2.0",
      method: existingMap[spec.name] ? "crontab_edit" : "crontab_create",
      params: {
        token: token,
        name: spec.name,
        cron_expression: spec.cron_expression,
        cron_type: spec.cron_type,
      },
      id: randomId(),
    });
    batch.push({
      jsonrpc: "2.0",
      method: "crontab_set_enable",
      params: {
        token: token,
        name: spec.name,
        enable: true,
      },
      id: randomId(),
    });
  }

  var allNames = getAllManagedNames(cfg.cron_prefix);
  for (var m = 0; m < allNames.length; m++) {
    var staleName = allNames[m];
    if (wanted[staleName]) continue;
    if (!existingMap[staleName]) continue;
    batch.push({
      jsonrpc: "2.0",
      method: "crontab_set_enable",
      params: {
        token: token,
        name: staleName,
        enable: false,
      },
      id: randomId(),
    });
  }

  await rpcBatch(batch);

  var shouldBootstrap = false;
  if (params && params.bootstrap_now === true) shouldBootstrap = true;
  else if (params && params.bootstrap_now === false) shouldBootstrap = false;
  else if (params && params.bootstrap_if_missing)
    shouldBootstrap = !prevState.last_install;

  var bootstrap = {
    ok: true,
    skipped: true,
    reason: "bootstrap not requested",
    cached_results: prevState.cached_results || {},
  };
  if (shouldBootstrap) {
    bootstrap = await runBootstrapTasks(token, cfg, targetUuids);
  }

  await setState(token, {
    last_install: Date.now(),
    last_query: prevState.last_query || 0,
    managed_names: specs.map(function (item) {
      return item.name;
    }),
    target_uuids: targetUuids,
    last_result: prevState.last_result || null,
    cached_results: bootstrap.cached_results || prevState.cached_results || {},
    last_bootstrap: shouldBootstrap
      ? Date.now()
      : prevState.last_bootstrap || 0,
  });

  return {
    ok: true,
    installed: specs.map(function (item) {
      return item.name;
    }),
    target_uuids: targetUuids,
    cron_expression: cfg.cron_expression,
    bootstrap: {
      ok: bootstrap.ok,
      skipped: bootstrap.skipped,
      reason: bootstrap.reason || null,
      task_count: bootstrap.task_count || 0,
      job_count: bootstrap.job_count || 0,
      failed_count: bootstrap.failed_count || 0,
    },
  };
}

async function listCrons(token, cfg) {
  cfg = cfg || (await getCfg(token));
  var crons = await getAllCrons(token);
  return {
    ok: true,
    items: crons.filter(function (item) {
      return isManagedCron(item.name, cfg.cron_prefix);
    }),
  };
}

function getExecuteOutput(taskRow) {
  var out =
    taskRow && taskRow.task_event_result && taskRow.task_event_result.execute;
  return typeof out === "string" ? out : "";
}

function parseExecuteJson(taskRow) {
  if (!taskRow) return null;
  if (taskRow.success === false) {
    return {
      status: "bad",
      region: "n/a",
      timestamp: taskRow.timestamp || null,
      error: taskRow.error_message || "task failed",
    };
  }
  var out = getExecuteOutput(taskRow);
  if (!out)
    return {
      status: "bad",
      region: "n/a",
      timestamp: taskRow.timestamp || null,
      error: "empty stdout",
    };
  var trimmed = out.trim();
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
      return JSON.parse(line);
    } catch (e) {}
  }
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    return {
      status: "bad",
      region: "n/a",
      timestamp: taskRow.timestamp || null,
      error: "invalid json stdout",
      raw: out.slice(-300),
    };
  }
}

async function queryLatestTask(token, cronSource, uuid) {
  var rows = await rpc("task_query", {
    token: token,
    task_data_query: {
      condition: [
        { cron_source: cronSource },
        { uuid: uuid },
        { type: "execute" },
        { limit: 5 },
      ],
    },
  });
  if (!Array.isArray(rows) || !rows.length) return null;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (row && row.success !== null && row.success !== undefined) return row;
    if (row && row.task_event_result) return row;
    if (row && row.error_message) return row;
  }
  return rows[0];
}

function parseYouTubeTask(taskRow) {
  var row = parseExecuteJson(taskRow);
  if (!row) return { status: "pending", region: "n/a", timestamp: null };
  return {
    status: row.status || "bad",
    region: row.region || "n/a",
    timestamp: row.timestamp || taskRow.timestamp || null,
    error: row.error || null,
  };
}

function parseNetflixTasks(taskA, taskB) {
  if (!taskA && !taskB)
    return { status: "pending", region: "n/a", timestamp: null };
  if (!taskA || !taskB)
    return {
      status: "pending",
      region: "n/a",
      timestamp:
        (taskA && taskA.timestamp) || (taskB && taskB.timestamp) || null,
    };
  var rowA = parseExecuteJson(taskA);
  var rowB = parseExecuteJson(taskB);
  if (!rowA || !rowB) {
    return {
      status: "bad",
      region: "n/a",
      timestamp:
        Math.max(Number(taskA.timestamp || 0), Number(taskB.timestamp || 0)) ||
        null,
      error: "invalid execute result",
    };
  }
  if (rowA.error || rowB.error) {
    return {
      status: "bad",
      region: "n/a",
      timestamp:
        Math.max(Number(taskA.timestamp || 0), Number(taskB.timestamp || 0)) ||
        null,
      error: (rowA.error || "") + (rowB.error ? " | " + rowB.error : ""),
    };
  }
  var region = rowB.region || rowA.region || "n/a";
  var blockedA = rowA.blocked === true;
  var blockedB = rowB.blocked === true;
  if (blockedA && blockedB)
    return {
      status: "org",
      region: region,
      timestamp:
        Math.max(Number(rowA.timestamp || 0), Number(rowB.timestamp || 0)) ||
        null,
    };
  if (!blockedA || !blockedB)
    return {
      status: "yes",
      region: region,
      timestamp:
        Math.max(Number(rowA.timestamp || 0), Number(rowB.timestamp || 0)) ||
        null,
    };
  return {
    status: "no",
    region: "n/a",
    timestamp:
      Math.max(Number(rowA.timestamp || 0), Number(rowB.timestamp || 0)) ||
      null,
  };
}

async function getResults(token, params) {
  var cfg = await getCfg(token);
  var state = await getState(token);
  var targetUuids = await resolveTargetUuids(
    token,
    params && params.uuids,
    cfg,
  );
  var targets = await listTargets(token, targetUuids);
  var items = [];

  for (var i = 0; i < targets.length; i++) {
    var target = targets[i];
    var youtubeIpv4 = null;
    var youtubeIpv6 = null;
    var netflixIpv4 = null;
    var netflixIpv6 = null;

    if (cfg.enable_youtube && cfg.enable_ipv4) {
      var yt4 = cronName(cfg.cron_prefix, "youtube", "ipv4");
      youtubeIpv4 = parseYouTubeTask(
        pickLatestTask(
          await queryLatestTask(token, yt4, target.uuid),
          cachedTaskRow(state, yt4, target.uuid),
        ),
      );
    }
    if (cfg.enable_youtube && cfg.enable_ipv6) {
      var yt6 = cronName(cfg.cron_prefix, "youtube", "ipv6");
      youtubeIpv6 = parseYouTubeTask(
        pickLatestTask(
          await queryLatestTask(token, yt6, target.uuid),
          cachedTaskRow(state, yt6, target.uuid),
        ),
      );
    }
    if (cfg.enable_netflix && cfg.enable_ipv4) {
      var nf4a = cronName(cfg.cron_prefix, "netflix", "ipv4", "a");
      var nf4b = cronName(cfg.cron_prefix, "netflix", "ipv4", "b");
      netflixIpv4 = parseNetflixTasks(
        pickLatestTask(
          await queryLatestTask(token, nf4a, target.uuid),
          cachedTaskRow(state, nf4a, target.uuid),
        ),
        pickLatestTask(
          await queryLatestTask(token, nf4b, target.uuid),
          cachedTaskRow(state, nf4b, target.uuid),
        ),
      );
    }
    if (cfg.enable_netflix && cfg.enable_ipv6) {
      var nf6a = cronName(cfg.cron_prefix, "netflix", "ipv6", "a");
      var nf6b = cronName(cfg.cron_prefix, "netflix", "ipv6", "b");
      netflixIpv6 = parseNetflixTasks(
        pickLatestTask(
          await queryLatestTask(token, nf6a, target.uuid),
          cachedTaskRow(state, nf6a, target.uuid),
        ),
        pickLatestTask(
          await queryLatestTask(token, nf6b, target.uuid),
          cachedTaskRow(state, nf6b, target.uuid),
        ),
      );
    }

    items.push({
      uuid: target.uuid,
      name: target.name,
      youtube: {
        ipv4: youtubeIpv4,
        ipv6: youtubeIpv6,
      },
      netflix: {
        ipv4: netflixIpv4,
        ipv6: netflixIpv6,
      },
    });
  }

  var result = {
    ok: true,
    generated_at: Date.now(),
    time: nowCST(),
    count: items.length,
    cron_expression: cfg.cron_expression,
    agents: items,
  };

  var state = await getState(token);
  state.last_query = Date.now();
  state.last_result = result;
  await setState(token, state);
  return result;
}

async function runOnce(token, params) {
  var installParams = Object.assign({}, params || {});
  installParams.bootstrap_if_missing = true;
  await installCrons(token, installParams);
  return await getResults(token, params || {});
}

async function maybeBootstrap(token, params) {
  var state = await getState(token);
  if (!state || !state.last_install) {
    return await runOnce(token, params || {});
  }
  if (state.last_bootstrap > 0 || hasCachedBootstrapResults(state)) return null;
  var installParams = Object.assign({ bootstrap_now: true }, params || {});
  await installCrons(token, installParams);
  return await getResults(token, params || {});
}

async function dispatch(token, params, ctx) {
  if (!token) return { ok: false, error: "missing token in env" };
  var action = (params && params.action) || "get_results";

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
  if (action === "install_crons") {
    var installParams = Object.assign({ bootstrap_now: true }, params || {});
    return await installCrons(token, installParams);
  }
  if (action === "list_crons") return await listCrons(token);
  if (action === "get_results") {
    var bootstrap = await maybeBootstrap(token, params || {});
    if (bootstrap) return bootstrap;
    return await getResults(token, params || {});
  }

  return { ok: false, error: "unknown action: " + action };
}

export default {
  async onCron(params, env, ctx) {
    var token = env && env.token;
    try {
      return await runOnce(token, params || {});
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  },

  async onCall(params, env, ctx) {
    var token = env && env.token;
    try {
      return await dispatch(token, params || {}, ctx);
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  },

  async onInlineCall(params, env, ctx) {
    var token = env && env.token;
    try {
      return await dispatch(token, params || {}, ctx);
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
        return json(await dispatch(token, { action: "list_targets" }, ctx));
      if (method === "GET" && path.endsWith("/config"))
        return json(await dispatch(token, { action: "get_config" }, ctx));
      if (method === "POST" && path.endsWith("/config"))
        return json(
          await dispatch(
            token,
            { action: "set_config", config: await request.json() },
            ctx,
          ),
        );
      if (method === "POST" && path.endsWith("/install"))
        return json(
          await dispatch(
            token,
            Object.assign({ action: "install_crons" }, await request.json()),
            ctx,
          ),
        );
      if (method === "GET" && path.endsWith("/run"))
        return json(await dispatch(token, { action: "install_crons" }, ctx));
      if (method === "GET" && path.endsWith("/crons"))
        return json(await dispatch(token, { action: "list_crons" }, ctx));
      if (method === "GET" && path.endsWith("/results"))
        return json(await dispatch(token, { action: "get_results" }, ctx));
      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      return json(
        { ok: false, error: String(e && e.message ? e.message : e) },
        500,
      );
    }
  },
};
