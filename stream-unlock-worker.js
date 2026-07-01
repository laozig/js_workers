/**
 * stream-unlock-worker v4.1
 *
 * 流媒体解锁结果聚合器：
 * - 不管理 cron 任务，由用户手动创建定时任务（指定每台机器）
 * - 通过 `task_query` 按 cron_source 查询所有 Agent 的任务结果
 * - 自动从结果中发现 Agent UUID，无需配置 target_uuids
 * - 支持 cleared_at 时间戳过滤老数据
 *
 * 路由（全部 GET）:
 *   /targets           列出所有 Agent
 *   /config            读取配置
 *   /run               立即执行一次探测（阻塞等待结果）
 *   /results           查询结果（query params: uuids 逗号分隔）
 *
 * onCall / onInlineCall:
 *   list_targets / get_config / run_once / get_results
 *
 * onCron:
 *   直接 queryResults（绕过缓存，始终查询最新数据）
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
  // cron_source 映射：逻辑名 -> 平台上的实际 cron 任务名
  cron_source_map: {
    youtube_ipv4: "YouTube IPv4",
    youtube_ipv6: "YouTube IPv6",
    netflix_ipv4_a: "Netflix IPv4 Part A",
    netflix_ipv4_b: "Netflix IPv4 Part B",
    netflix_ipv6_a: "Netflix IPv6 Part A",
    netflix_ipv6_b: "Netflix IPv6 Part B",
  },
  enable_youtube: true,
  enable_netflix: true,
  enable_ipv4: true,
  enable_ipv6: true,
  user_agent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  accept_language: "en",
  youtube_url: "https://www.youtube.com/premium",
  youtube_cookies:
    "YSC=BiCUU3-5Gdk; SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgJnPpwY; GPS=1; VISITOR_INFO1_LIVE=4VwPMkB7W5A; PREF=tz=Asia.Shanghai",
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

function normalizeCfg(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: raw.enabled !== false,
    cron_prefix: String(raw.cron_prefix || DEFAULT_CFG.cron_prefix),
    cron_source_map: (raw.cron_source_map && typeof raw.cron_source_map === "object")
      ? raw.cron_source_map
      : DEFAULT_CFG.cron_source_map,
    enable_youtube: raw.enable_youtube !== false,
    enable_netflix: raw.enable_netflix !== false,
    enable_ipv4: raw.enable_ipv4 !== false,
    enable_ipv6: raw.enable_ipv6 !== false,
    user_agent: String(raw.user_agent || DEFAULT_CFG.user_agent),
    accept_language: String(raw.accept_language || DEFAULT_CFG.accept_language),
    youtube_url: String(raw.youtube_url || DEFAULT_CFG.youtube_url),
    youtube_cookies: (function () {
      var v = String(raw.youtube_cookies || DEFAULT_CFG.youtube_cookies);
      return v.indexOf("SOCS=") >= 0 ? v : DEFAULT_CFG.youtube_cookies;
    })(),
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

async function getState(token) {
  var value = await rpc("kv_get_value", {
    token: token,
    namespace: NS,
    key: STATE_KEY,
  });
  return {
    last_query: (value && Number(value.last_query)) || 0,
    last_result: (value && value.last_result) || null,
    cleared_at: (value && Number(value.cleared_at)) || 0,
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

function buildYoutubeExecuteScript(curlTimeout) {
  var maxTime = curlTimeout || 20;
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
    'body="$(curl -sSL --max-time ' + maxTime + ' $family_flag -A "$ua" -H "Accept-Language: $lang" -b "$cookie" "$url" 2>/dev/null || true)"',
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

function buildNetflixExecuteScript(curlTimeout) {
  var maxTime = curlTimeout || 20;
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
    "raw=\"$(curl -sSL --max-time " + maxTime + " $family_flag -A \"$ua\" -H \"Accept-Language: $lang\" -w '\\n%{url_effective}' \"$url\" 2>/dev/null || true)\"",
    'loc="$(printf \'%s\\n\' "$raw" | tail -n1)"',
    'body="$(printf \'%s\\n\' "$raw" | sed \'$d\')"',
    'if [ -z "$body" ]; then',
    '  printf \'{"service":"netflix","part":"%s","error":"empty response","region":"n/a","timestamp":%s}\\n\' "$part" "$ts" > "$file"',
    "else",
    "  blocked=false",
    "  if printf '%s' \"$body\" | grep -q 'Oh no!'; then blocked=true; fi",
    '  region="$(printf \'%s\' "$loc" | sed -n \'s#https\\?://www\\.netflix\\.com/\\([a-z][a-z]\\)\\(-[a-z][a-z]\\)\\?/.*#\\1#p\' | tr \'a-z\' \'A-Z\')"',
    '  [ -n "$region" ] || region="n/a"',
    '  printf \'{"service":"netflix","part":"%s","blocked":%s,"region":"%s","timestamp":%s}\\n\' "$part" "$blocked" "$region" "$ts" > "$file"',
    "fi",
    'cat "$file"',
    'rm -f "$file"',
  ].join("\n");
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

/**
 * 按 cron_source 查询所有 Agent 的任务，返回 { uuid -> taskRow } 映射。
 * 不指定 uuid，让 task_query 返回所有命中的行。
 * @param {number} [since] - 只保留 timestamp >= since 的结果
 */
async function queryAllTasksByCron(token, cronSource, since) {
  var rows = await rpc("task_query", {
    token: token,
    task_data_query: {
      condition: [
        { cron_source: cronSource },
        { type: "execute" },
        { limit: 200 },
      ],
    },
  });
  var map = Object.create(null);
  if (!Array.isArray(rows)) return map;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var uuid = row && row.uuid;
    if (!uuid) continue;
    // 过滤清除之前的老结果
    if (since && Number(row.timestamp || 0) < since) continue;
    // 每个 uuid 只保留最新一条有效结果
    if (!map[uuid]) {
      if (row.success !== null && row.success !== undefined) map[uuid] = row;
      else if (row.task_event_result) map[uuid] = row;
      else if (row.error_message) map[uuid] = row;
    }
  }
  return map;
}

function parseYouTubeTask(taskRow) {
  var row = parseExecuteJson(taskRow);
  if (!row) return { status: "pending", region: "n/a", timestamp: null };
  var out = {
    status: row.status || "bad",
    region: row.region || "n/a",
    timestamp: row.timestamp || taskRow.timestamp || null,
    error: row.error || null,
  };
  if (row.raw) out.raw = row.raw;
  return out;
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
  var ts =
    Math.max(Number(rowA.timestamp || 0), Number(rowB.timestamp || 0)) || null;
  if (blockedA && blockedB)
    return { status: "org", region: region, timestamp: ts };
  if (!blockedA && !blockedB)
    return { status: "yes", region: region, timestamp: ts };
  return { status: "no", region: region, timestamp: ts };
}

var CACHE_TTL_MS = 6 * 60 * 1000;

function hasUsableData(result) {
  if (!result || !result.agents || !result.agents.length) return false;
  for (var i = 0; i < result.agents.length; i++) {
    var a = result.agents[i];
    var services = [];
    if (a.youtube) {
      if (a.youtube.ipv4) services.push(a.youtube.ipv4);
      if (a.youtube.ipv6) services.push(a.youtube.ipv6);
    }
    if (a.netflix) {
      if (a.netflix.ipv4) services.push(a.netflix.ipv4);
      if (a.netflix.ipv6) services.push(a.netflix.ipv6);
    }
    for (var j = 0; j < services.length; j++) {
      var s = services[j].status;
      if (s && s !== "bad" && s !== "pending") return true;
    }
  }
  return false;
}

function usableCount(result) {
  if (!result || !result.agents || !result.agents.length) return 0;
  var n = 0;
  for (var i = 0; i < result.agents.length; i++) {
    var a = result.agents[i];
    var slots = [];
    if (a.youtube) { slots.push(a.youtube.ipv4, a.youtube.ipv6); }
    if (a.netflix) { slots.push(a.netflix.ipv4, a.netflix.ipv6); }
    for (var j = 0; j < slots.length; j++) {
      if (slots[j] && slots[j].status && slots[j].status !== "bad" && slots[j].status !== "pending") n++;
    }
  }
  return n;
}

async function queryResults(token, params) {
  var setup = await Promise.all([getCfg(token), getState(token)]);
  var cfg = setup[0];
  var state = setup[1];

  var csm = cfg.cron_source_map || {};
  var cronSources = [];
  if (cfg.enable_youtube && cfg.enable_ipv4 && csm.youtube_ipv4) cronSources.push(csm.youtube_ipv4);
  if (cfg.enable_youtube && cfg.enable_ipv6 && csm.youtube_ipv6) cronSources.push(csm.youtube_ipv6);
  if (cfg.enable_netflix && cfg.enable_ipv4) {
    if (csm.netflix_ipv4_a) cronSources.push(csm.netflix_ipv4_a);
    if (csm.netflix_ipv4_b) cronSources.push(csm.netflix_ipv4_b);
  }
  if (cfg.enable_netflix && cfg.enable_ipv6) {
    if (csm.netflix_ipv6_a) cronSources.push(csm.netflix_ipv6_a);
    if (csm.netflix_ipv6_b) cronSources.push(csm.netflix_ipv6_b);
  }

  var since = state.cleared_at || 0;
  var allMaps = await Promise.all(
    cronSources.map(function (name) { return queryAllTasksByCron(token, name, since); })
  );

  var uuidSet = Object.create(null);
  for (var m = 0; m < allMaps.length; m++) {
    for (var u in allMaps[m]) {
      if (Object.prototype.hasOwnProperty.call(allMaps[m], u)) uuidSet[u] = true;
    }
  }

  var filterUuids = null;
  if (params && Array.isArray(params.uuids) && params.uuids.length) {
    filterUuids = Object.create(null);
    for (var f = 0; f < params.uuids.length; f++) filterUuids[String(params.uuids[f])] = true;
  }

  var cronIndex = Object.create(null);
  for (var c = 0; c < cronSources.length; c++) cronIndex[cronSources[c]] = allMaps[c];

  var allUuids = Object.keys(uuidSet);
  if (filterUuids) allUuids = allUuids.filter(function (u) { return filterUuids[u]; });
  var names = await getNameMap(token, allUuids);

  var items = [];
  for (var i = 0; i < allUuids.length; i++) {
    var uuid = allUuids[i];
    var yt4 = null, yt6 = null, nf4 = null, nf6 = null;

    if (cfg.enable_youtube && cfg.enable_ipv4 && csm.youtube_ipv4) {
      yt4 = parseYouTubeTask(cronIndex[csm.youtube_ipv4] && cronIndex[csm.youtube_ipv4][uuid] || null);
    }
    if (cfg.enable_youtube && cfg.enable_ipv6 && csm.youtube_ipv6) {
      yt6 = parseYouTubeTask(cronIndex[csm.youtube_ipv6] && cronIndex[csm.youtube_ipv6][uuid] || null);
    }
    if (cfg.enable_netflix && cfg.enable_ipv4) {
      nf4 = parseNetflixTasks(
        csm.netflix_ipv4_a && cronIndex[csm.netflix_ipv4_a] && cronIndex[csm.netflix_ipv4_a][uuid] || null,
        csm.netflix_ipv4_b && cronIndex[csm.netflix_ipv4_b] && cronIndex[csm.netflix_ipv4_b][uuid] || null
      );
    }
    if (cfg.enable_netflix && cfg.enable_ipv6) {
      nf6 = parseNetflixTasks(
        csm.netflix_ipv6_a && cronIndex[csm.netflix_ipv6_a] && cronIndex[csm.netflix_ipv6_a][uuid] || null,
        csm.netflix_ipv6_b && cronIndex[csm.netflix_ipv6_b] && cronIndex[csm.netflix_ipv6_b][uuid] || null
      );
    }

    items.push({
      uuid: uuid,
      name: (typeof names.get(uuid) === "string" && names.get(uuid)) ? names.get(uuid) : uuid.slice(0, 8),
      youtube: { ipv4: yt4, ipv6: yt6 },
      netflix: { ipv4: nf4, ipv6: nf6 },
    });
  }

  var result = {
    ok: true,
    generated_at: Date.now(),
    time: nowCST(),
    count: items.length,
    agents: items,
  };

  state.last_query = Date.now();
  var cachedFresh = state.last_result && state.last_result.generated_at
    && (Date.now() - state.last_result.generated_at < CACHE_TTL_MS);
  if (!hasUsableData(state.last_result)) {
    state.last_result = result;
  } else if (hasUsableData(result)) {
    if (!cachedFresh || usableCount(result) >= usableCount(state.last_result)) {
      state.last_result = result;
    }
  }
  await setState(token, state);
  return result;
}

async function getResults(token, params) {
  var state = await getState(token);
  var cached = state.last_result;
  if (cached && cached.generated_at && hasUsableData(cached)) {
    if (Date.now() - cached.generated_at < CACHE_TTL_MS) return cached;
  }
  var fresh = await queryResults(token, params);
  if (hasUsableData(fresh)) return fresh;
  if (hasUsableData(cached)) return cached;
  return fresh;
}

async function runOnce(token, params) {
  var startTime = Date.now();
  var DEADLINE_MS = 23000;

  var setup = await Promise.all([getCfg(token), listAgentUuids(token)]);
  var cfg = setup[0];
  var targetUuids = setup[1];

  if (params && params.uuids) {
    var filter = typeof params.uuids === "string" ? params.uuids.split(",") : (Array.isArray(params.uuids) ? params.uuids : []);
    if (filter.length) {
      var filterSet = Object.create(null);
      for (var f = 0; f < filter.length; f++) { var fv = String(filter[f]).trim(); if (fv) filterSet[fv] = true; }
      targetUuids = targetUuids.filter(function (u) { return filterSet[u]; });
    }
  }

  if (!targetUuids.length) return { ok: false, error: "no agents found" };

  var curlTimeout = targetUuids.length > 10 ? 10 : 20;
  var rpcTimeout = targetUuids.length > 10 ? 13000 : 25000;

  var csm = cfg.cron_source_map || {};
  var taskDefs = [];

  if (cfg.enable_youtube) {
    if (cfg.enable_ipv4 && csm.youtube_ipv4)
      taskDefs.push({ key: "yt4", script: buildYoutubeExecuteScript(curlTimeout), args: [csm.youtube_ipv4, "-4", cfg.youtube_url, cfg.youtube_cookies, cfg.user_agent, cfg.accept_language, cfg.result_dir] });
    if (cfg.enable_ipv6 && csm.youtube_ipv6)
      taskDefs.push({ key: "yt6", script: buildYoutubeExecuteScript(curlTimeout), args: [csm.youtube_ipv6, "-6", cfg.youtube_url, cfg.youtube_cookies, cfg.user_agent, cfg.accept_language, cfg.result_dir] });
  }
  if (cfg.enable_netflix) {
    if (cfg.enable_ipv4) {
      if (csm.netflix_ipv4_a) taskDefs.push({ key: "nf4a", script: buildNetflixExecuteScript(curlTimeout), args: [csm.netflix_ipv4_a, "-4", "https://www.netflix.com/title/" + encodeURIComponent(cfg.netflix_title_a), cfg.user_agent, cfg.accept_language, "a", cfg.result_dir] });
      if (csm.netflix_ipv4_b) taskDefs.push({ key: "nf4b", script: buildNetflixExecuteScript(curlTimeout), args: [csm.netflix_ipv4_b, "-4", "https://www.netflix.com/title/" + encodeURIComponent(cfg.netflix_title_b), cfg.user_agent, cfg.accept_language, "b", cfg.result_dir] });
    }
    if (cfg.enable_ipv6) {
      if (csm.netflix_ipv6_a) taskDefs.push({ key: "nf6a", script: buildNetflixExecuteScript(curlTimeout), args: [csm.netflix_ipv6_a, "-6", "https://www.netflix.com/title/" + encodeURIComponent(cfg.netflix_title_a), cfg.user_agent, cfg.accept_language, "a", cfg.result_dir] });
      if (csm.netflix_ipv6_b) taskDefs.push({ key: "nf6b", script: buildNetflixExecuteScript(curlTimeout), args: [csm.netflix_ipv6_b, "-6", "https://www.netflix.com/title/" + encodeURIComponent(cfg.netflix_title_b), cfg.user_agent, cfg.accept_language, "b", cfg.result_dir] });
    }
  }

  var BATCH_SIZE = targetUuids.length > 10 ? targetUuids.length : 5;
  var results = Object.create(null);
  var skippedUuids = [];

  for (var batchStart = 0; batchStart < targetUuids.length; batchStart += BATCH_SIZE) {
    var elapsed = Date.now() - startTime;
    var remaining = DEADLINE_MS - elapsed;
    if (remaining < 3000) {
      for (var rem = batchStart; rem < targetUuids.length; rem++) skippedUuids.push(targetUuids[rem]);
      break;
    }
    var batchTimeout = Math.min(rpcTimeout, remaining - 2000);
    if (batchTimeout < 5000) batchTimeout = 5000;
    var batchUuids = targetUuids.slice(batchStart, batchStart + BATCH_SIZE);
    var jobs = [];
    var jobMeta = [];

    for (var t = 0; t < taskDefs.length; t++) {
      for (var u = 0; u < batchUuids.length; u++) {
        jobMeta.push({ uuid: batchUuids[u], key: taskDefs[t].key });
        jobs.push(
          rpc("task_create_task_blocking", {
            token: token,
            target_uuid: batchUuids[u],
            timeout_ms: batchTimeout,
            task_type: {
              execute: {
                cmd: "sh",
                args: ["-lc", taskDefs[t].script, "sh"].concat(taskDefs[t].args),
              },
            },
          }).catch(function (e) {
            return { success: false, error_message: String(e && e.message ? e.message : e) };
          })
        );
      }
    }

    var taskRows = await Promise.all(jobs);
    for (var i = 0; i < taskRows.length; i++) {
      var meta = jobMeta[i];
      var row = taskRows[i];
      if (!results[meta.uuid]) results[meta.uuid] = {};
      results[meta.uuid][meta.key] = row;
    }
  }

  for (var s = 0; s < skippedUuids.length; s++) {
    results[skippedUuids[s]] = results[skippedUuids[s]] || {};
    for (var sk = 0; sk < taskDefs.length; sk++) {
      results[skippedUuids[s]][taskDefs[sk].key] = { success: false, error_message: "skipped: time limit" };
    }
  }

  var allUuids = Object.keys(results);
  var names = await getNameMap(token, allUuids);

  var items = [];
  for (var j = 0; j < allUuids.length; j++) {
    var uuid = allUuids[j];
    var r = results[uuid];
    items.push({
      uuid: uuid,
      name: (typeof names.get(uuid) === "string" && names.get(uuid)) ? names.get(uuid) : uuid.slice(0, 8),
      youtube: {
        ipv4: r.yt4 ? parseYouTubeTask(r.yt4) : null,
        ipv6: r.yt6 ? parseYouTubeTask(r.yt6) : null,
      },
      netflix: {
        ipv4: (r.nf4a || r.nf4b) ? parseNetflixTasks(r.nf4a || null, r.nf4b || null) : null,
        ipv6: (r.nf6a || r.nf6b) ? parseNetflixTasks(r.nf6a || null, r.nf6b || null) : null,
      },
    });
  }

  var result = {
    ok: true,
    generated_at: Date.now(),
    time: nowCST(),
    count: items.length,
    agents: items,
  };
  if (skippedUuids.length) result.skipped = skippedUuids.length;

  var state = await getState(token);
  state.last_query = Date.now();
  if (hasUsableData(result) || !hasUsableData(state.last_result)) {
    state.last_result = result;
  }
  await setState(token, state);
  return result;
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
  if (action === "run_once") {
    return await runOnce(token, params || {});
  }
  if (action === "get_results") {
    return await getResults(token, params || {});
  }

  return { ok: false, error: "unknown action: " + action };
}

export default {
  async onCron(params, env, ctx) {
    var token = env && env.token;
    try {
      return await queryResults(token, params || {});
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
          "access-control-allow-methods": "GET,OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    try {
      // GET /targets — 列出所有 Agent
      if (method === "GET" && path.endsWith("/targets"))
        return json(await dispatch(token, { action: "list_targets" }, ctx));

      // GET /config — 读取配置
      if (method === "GET" && path.endsWith("/config"))
        return json(await dispatch(token, { action: "get_config" }, ctx));

      // GET /run — 立即执行一次探测（阻塞等待结果）
      if (method === "GET" && path.endsWith("/run")) {
        var runParams = { action: "run_once" };
        if (url.searchParams.has("uuids"))
          runParams.uuids = url.searchParams.get("uuids").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
        return json(await dispatch(token, runParams, ctx));
      }

      // GET /results?uuids=a,b,c — 查询结果
      if (method === "GET" && path.endsWith("/results")) {
        var resultParams = {};
        if (url.searchParams.has("uuids"))
          resultParams.uuids = url.searchParams.get("uuids").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
        return json(await dispatch(token, Object.assign({ action: "get_results" }, resultParams), ctx));
      }

      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      return json(
        { ok: false, error: String(e && e.message ? e.message : e) },
        500,
      );
    }
  },
};