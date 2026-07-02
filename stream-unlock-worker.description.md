# 流媒体检测 · `stream-unlock`

结果聚合器。用户手动在平台创建定时任务（指定每台机器），worker 通过 `task_query` 按 `cron_source` 查询所有 Agent 的任务结果，自动发现 Agent UUID 并聚合返回。支持 `cron_source_map` 自定义任务名映射。

---

## 环境变量 `env`

| 键 | 必填 | 说明 |
|---|---|---|
| `token` | ✅ | NodeGet 平台 `Token`，至少覆盖 `Task::Read(execute)`、`Task::Create(execute)`、`JsWorker::RunDefinedJsWorker`。 |

## 部署

1. 新建 `JS Worker`，粘贴 `stream-unlock-worker.js`，保存。
2. 设置 `route_name = stream-unlock`，`env` 填 `token`。
3. 创建 **Server 定时任务**：类型选 `JS Worker`，目标选本 worker，cron 填 `0 */5 * * * *`（每 5 分钟缓存一次结果）。
4. 在平台手动创建 6 个 Agent 定时任务（见下方创建任务指南）。
5. 访问 `GET /results` 查看聚合结果。

---

## 路由（全部 GET）

基础路径：`https://<域名>/nodeget/worker-route/stream-unlock`

| 路径 | 说明 |
|---|---|
| `/targets` | 列出所有 Agent |
| `/config` | 读取配置 |
| `/run` | 立即触发一次探测（阻塞等待，约 25-40 秒） |
| `/results` | 查询结果（query params: `uuids` 逗号分隔，可选） |

## onCall / onInlineCall（`params.action`）

| `action` | 参数 | 说明 |
|---|---|---|
| `list_targets` | — | 列出所有 Agent |
| `get_config` | — | 读配置与状态 |
| `run_once` | — | 立即触发探测 |
| `get_results` | `{uuids?}` | 聚合结果 |

---

## 配置模型（全局 KV，key `stream_unlock_agent_config`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `cron_prefix` | `stream_unlock` | cron 任务名前缀 |
| `cron_source_map` | 见下方 | 逻辑名 → 平台实际 cron 任务名映射 |
| `enable_youtube`/`enable_netflix` | `true` | 是否显示对应检测 |
| `enable_ipv4`/`enable_ipv6` | `true` | 是否显示对应协议 |
| `youtube_url`/`youtube_cookies` | — | YouTube 探测地址 / cookie |
| `netflix_title_a`/`netflix_title_b` | — | Netflix 双标题页 ID |
| `user_agent`/`accept_language` | — | 统一请求头 |
| `result_dir` | `/tmp/stream-unlock` | Agent 临时结果目录 |

### `cron_source_map` 默认值

```json
{
  "youtube_ipv4": "YouTube IPv4",
  "youtube_ipv6": "YouTube IPv6",
  "netflix_ipv4_a": "Netflix IPv4 Part A",
  "netflix_ipv4_b": "Netflix IPv4 Part B",
  "netflix_ipv6_a": "Netflix IPv6 Part A",
  "netflix_ipv6_b": "Netflix IPv6 Part B"
}
```

## 状态模型（全局 KV，key `stream_unlock_agent_state`）

| 字段 | 说明 |
|---|---|
| `last_query` | 最后一次查询时间戳 |
| `last_result` | 最后一次查询结果缓存（`onCron`/`/run` 写入，`/results` 在 6 分钟 TTL 内优先读取；全失败结果不会覆盖已有正常缓存） |

---

## 创建任务指南

在平台创建 6 个 Agent 定时任务：

- **任务类型**：Agent
- **执行命令**：`sh`
- **时间**：`0 0 0,12 * * *`

每个任务的**命令参数**为单行，完整复制代码块内容即可（整行是一个 `-c 'script'`，所有参数已硬编码）。

> ⚠️ 命令参数是**单行**，不要手动换行。复制后在平台里应该只占一行。

---

### 1. YouTube IPv4

```
-c 'ts=$(($(date +%s)*1000));body=$(curl -sSL --max-time 20 -4 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" -H "Accept-Language: en" -b "YSC=BiCUU3-5Gdk; SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgJnPpwY; GPS=1; VISITOR_INFO1_LIVE=4VwPMkB7W5A; PREF=tz=Asia.Shanghai" "https://www.youtube.com/premium" 2>/dev/null||true);s=bad;r=n/a;case "$body" in *www.google.cn*)s=cn;r=CN;;*"Premium is not available in your country"*)s=noprem;;*ad-free*)r=$(printf "%s" "$body"|tr "," "\n"|grep contentRegion|head -n1|tr -d "\""|cut -d: -f2);[ -n "$r" ]||r=n/a;s=yes;;esac;printf "{\"service\":\"youtube\",\"status\":\"%s\",\"region\":\"%s\",\"timestamp\":%s}\n" "$s" "$r" "$ts"'
```

---

### 2. YouTube IPv6

```
-c 'ts=$(($(date +%s)*1000));body=$(curl -sSL --max-time 20 -6 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" -H "Accept-Language: en" -b "YSC=BiCUU3-5Gdk; SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgJnPpwY; GPS=1; VISITOR_INFO1_LIVE=4VwPMkB7W5A; PREF=tz=Asia.Shanghai" "https://www.youtube.com/premium" 2>/dev/null||true);s=bad;r=n/a;case "$body" in *www.google.cn*)s=cn;r=CN;;*"Premium is not available in your country"*)s=noprem;;*ad-free*)r=$(printf "%s" "$body"|tr "," "\n"|grep contentRegion|head -n1|tr -d "\""|cut -d: -f2);[ -n "$r" ]||r=n/a;s=yes;;esac;printf "{\"service\":\"youtube\",\"status\":\"%s\",\"region\":\"%s\",\"timestamp\":%s}\n" "$s" "$r" "$ts"'
```

---

### 3. Netflix IPv4 Part A

```
-c 'ts=$(($(date +%s)*1000));raw=$(curl -sSL --max-time 20 -4 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" -H "Accept-Language: en" -w "\n%{url_effective}" "https://www.netflix.com/title/81280792" 2>/dev/null||true);loc=$(printf "%s\n" "$raw"|tail -n1);body=$(printf "%s\n" "$raw"|sed "\$d");if [ -z "$body" ];then printf "{\"service\":\"netflix\",\"part\":\"a\",\"error\":\"empty response\",\"region\":\"n/a\",\"timestamp\":%s}\n" "$ts";else blocked=false;if ! printf "%s" "$loc"|grep -q "/title/";then blocked=true;fi;r=$(printf "%s" "$loc"|sed -n "s#.*/\([a-z][a-z]\)\(-[a-z][a-z]\)\?/.*#\1#p"|tr a-z A-Z);[ -n "$r" ]||r=n/a;printf "{\"service\":\"netflix\",\"part\":\"a\",\"blocked\":%s,\"region\":\"%s\",\"timestamp\":%s}\n" "$blocked" "$r" "$ts";fi'
```

---

### 4. Netflix IPv4 Part B

```
-c 'ts=$(($(date +%s)*1000));raw=$(curl -sSL --max-time 20 -4 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" -H "Accept-Language: en" -w "\n%{url_effective}" "https://www.netflix.com/title/70143836" 2>/dev/null||true);loc=$(printf "%s\n" "$raw"|tail -n1);body=$(printf "%s\n" "$raw"|sed "\$d");if [ -z "$body" ];then printf "{\"service\":\"netflix\",\"part\":\"b\",\"error\":\"empty response\",\"region\":\"n/a\",\"timestamp\":%s}\n" "$ts";else blocked=false;if ! printf "%s" "$loc"|grep -q "/title/";then blocked=true;fi;r=$(printf "%s" "$loc"|sed -n "s#.*/\([a-z][a-z]\)\(-[a-z][a-z]\)\?/.*#\1#p"|tr a-z A-Z);[ -n "$r" ]||r=n/a;printf "{\"service\":\"netflix\",\"part\":\"b\",\"blocked\":%s,\"region\":\"%s\",\"timestamp\":%s}\n" "$blocked" "$r" "$ts";fi'
```

---

### 5. Netflix IPv6 Part A

```
-c 'ts=$(($(date +%s)*1000));raw=$(curl -sSL --max-time 20 -6 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" -H "Accept-Language: en" -w "\n%{url_effective}" "https://www.netflix.com/title/81280792" 2>/dev/null||true);loc=$(printf "%s\n" "$raw"|tail -n1);body=$(printf "%s\n" "$raw"|sed "\$d");if [ -z "$body" ];then printf "{\"service\":\"netflix\",\"part\":\"a\",\"error\":\"empty response\",\"region\":\"n/a\",\"timestamp\":%s}\n" "$ts";else blocked=false;if ! printf "%s" "$loc"|grep -q "/title/";then blocked=true;fi;r=$(printf "%s" "$loc"|sed -n "s#.*/\([a-z][a-z]\)\(-[a-z][a-z]\)\?/.*#\1#p"|tr a-z A-Z);[ -n "$r" ]||r=n/a;printf "{\"service\":\"netflix\",\"part\":\"a\",\"blocked\":%s,\"region\":\"%s\",\"timestamp\":%s}\n" "$blocked" "$r" "$ts";fi'
```

---

### 6. Netflix IPv6 Part B

```
-c 'ts=$(($(date +%s)*1000));raw=$(curl -sSL --max-time 20 -6 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" -H "Accept-Language: en" -w "\n%{url_effective}" "https://www.netflix.com/title/70143836" 2>/dev/null||true);loc=$(printf "%s\n" "$raw"|tail -n1);body=$(printf "%s\n" "$raw"|sed "\$d");if [ -z "$body" ];then printf "{\"service\":\"netflix\",\"part\":\"b\",\"error\":\"empty response\",\"region\":\"n/a\",\"timestamp\":%s}\n" "$ts";else blocked=false;if ! printf "%s" "$loc"|grep -q "/title/";then blocked=true;fi;r=$(printf "%s" "$loc"|sed -n "s#.*/\([a-z][a-z]\)\(-[a-z][a-z]\)\?/.*#\1#p"|tr a-z A-Z);[ -n "$r" ]||r=n/a;printf "{\"service\":\"netflix\",\"part\":\"b\",\"blocked\":%s,\"region\":\"%s\",\"timestamp\":%s}\n" "$blocked" "$r" "$ts";fi'
```

---

## 结果状态语义

**YouTube**：`yes` 已解锁 · `noprem` 可访问但无 Premium · `cn` 命中中国页 · `bad` 异常 · `pending` 未完成。

**Netflix**：通过最终 URL 是否包含 `/title/` 判断是否重定向。`yes` 两页均未重定向（完全解锁） · `org` 两页均被重定向到首页（仅自制剧） · `no` 一页未重定向、一页被重定向（异常） · `bad` 异常 · `pending` 未完成。

> 无 IPv6 出口的机器，其 `*IPv6` 项恒为 `bad`，属正常，前端可隐藏。

## 返回结构（`GET /results`）

```json
{
  "ok": true,
  "generated_at": 1782125901689,
  "time": "2026-06-22 18:58:21",
  "count": 3,
  "agents": [
    {
      "uuid": "...",
      "name": "...",
      "youtube": {
        "ipv4": {"status": "yes", "region": "SG", "timestamp": 0, "error": null},
        "ipv6": {"status": "bad", "region": "n/a", "timestamp": 0, "error": null}
      },
      "netflix": {
        "ipv4": {"status": "yes", "region": "SG", "timestamp": 0},
        "ipv6": {"status": "bad", "region": "n/a", "timestamp": 0, "error": "..."}
      }
    }
  ]
}
```
