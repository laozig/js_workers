# 流媒体检测 · `stream-unlock`

给目标 `Agent` 下发长期 `execute` 定时任务,Agent 本机 `curl -4/-6` 探测 `YouTube Premium` / `Netflix`,Server 端用 `task_query` 聚合每台最新结果。首次安装时用 `task_create_task_blocking` 补跑一次并缓存,所以前端能立刻读到数据。完全在边缘端运行,不改探针 agent。

---

## 环境变量 `env`

| 键 | 必填 | 说明 |
|---|---|---|
| `token` | ✅ | NodeGet 平台 `Token`,至少覆盖 `Crontab::Write/Delete`、`Task::Create(execute)`、`Task::Read(execute)`、`JsWorker::RunDefinedJsWorker`。 |

## 部署(普通用户只需这几步)

1. 新建 `JS Worker`,粘贴 `stream-unlock-worker.js`,保存。
2. 设置 `route_name = stream-unlock`,`env` 填 `token`。
3. 建一条 **Server 定时任务**,脚本指向本 worker,`Cron = 0 0 0,12 * * *`(6 段,一天两次)。
4. 首次访问 `GET /results` 会自动安装 Agent cron + 补跑一次;之后前端定期读 `/results` 即可。

> 前端主题直接读 `GET /results`,不要自己散查 `task_query`。

---

## onCall / onInlineCall(`params.action`)

| `action` | 参数 | 说明 |
|---|---|---|
| `list_targets` | — | 列出当前可见 `Agent` |
| `get_config` | — | 读配置与状态 |
| `set_config` | `{config:{...}}` | 保存配置 |
| `install_crons` | `{uuids?, persist_targets?, bootstrap_now?}` | 下发/更新 cron,可立刻补跑 |
| `list_crons` | — | 查看本 worker 管理的 cron |
| `get_results` | `{uuids?}` | 聚合结果;首次调用自动自举 |

## HTTP 路由(`/nodeget/worker-route/stream-unlock`)

| 方法 路径 | 说明 |
|---|---|
| `GET /results` | 聚合结果(前端读),首访自动自举 |
| `GET /run`、`POST /install` | 立即下发/更新 cron 并补跑一次 |
| `GET /targets`、`GET /crons` | 列 Agent / 查托管 cron |
| `GET /config`、`POST /config` | 读 / 写配置 |

---

## 立即重跑一次

不想等定时,马上刷新:`POST /install`(或浏览器打开 `GET /run`)会重装 cron 并对全部目标同步补跑,结果立即写缓存。

```bash
BASE="https://<你的站点域名>"   # 以你当前站点入口域名为准
curl -sS --max-time 150 "$BASE/nodeget/worker-route/stream-unlock/run"
curl -sS "$BASE/nodeget/worker-route/stream-unlock/results"   # 看 time 是否刷新
```

- 耗时约等于最慢机器(实测 16 台 ≈ 25–30s),客户端超时设 `120s` 以上。
- 只重跑部分机器:`POST /install` 带 `{"uuids":[...],"persist_targets":false}`。
- 偶发 `HTTP 500` 多为隧道抖动,重试一次即可。

> ⚠️ 触发用的是 worker **已部署的版本**。改了 `stream-unlock-worker.js` 要先重新部署再触发。

## 目标机器范围

`target_uuids` **留空 = 每轮自动跟随全部 `Agent`**(新机器自动纳入);非空 = 锁定子集。只有显式带 `uuids` 调用时才会写入该字段,自动解析的全量目标不回写。少了机器时清空即可:`POST /config {"target_uuids":[]}`。

---

## 配置模型(全局 KV,key `stream_unlock_agent_config`)

| 字段 | 默认 | 说明 |
|---|---|---|
| `cron_expression` | `0 0 0,12 * * *` | Agent 长期 cron(一天两次) |
| `target_uuids` | `[]` | 目标列表,留空跟随全部 |
| `bootstrap_on_install` | `true` | 安装时补跑一次 |
| `enable_youtube`/`enable_netflix` | `true` | 是否下发对应检测 |
| `enable_ipv4`/`enable_ipv6` | `true` | 是否下发对应协议 |
| `youtube_url`/`youtube_cookies` | — | YouTube 探测地址 / cookie |
| `netflix_title_a`/`netflix_title_b` | — | Netflix 双标题页 ID |
| `user_agent`/`accept_language` | — | 统一请求头 |
| `result_dir` | `/tmp/stream-unlock` | Agent 临时结果目录 |

---

## 结果状态语义

底层为每台机器生成 6 条采集 cron(`youtube_ipv4/ipv6`、`netflix_ipv4_a/b`、`netflix_ipv6_a/b`)。Netflix 的 `A/B` 是双标题页判定的**内部任务**,聚合后前端只显示 `Netflix IPv4` / `Netflix IPv6`,无需关心 A/B。

**YouTube**:`yes` 已解锁 · `noprem` 可访问但无 Premium · `cn` 命中中国页 · `bad` 异常 · `pending` 未完成。

**Netflix**:`yes` 任一标题页未阻断 · `org` 两页均被 `Oh no!` 拦(仅自制剧) · `no` 均无效 · `bad` 异常 · `pending` 未完成。

> 无 IPv6 出口的机器,其 `*IPv6` 项恒为 `bad`,属正常,前端可隐藏。

## 返回结构(`GET /results`)

```json
{
  "agents": [{
    "uuid": "…", "name": "…",
    "youtube": { "ipv4": {"status":"yes","region":"US","timestamp":0}, "ipv6": {…} },
    "netflix": { "ipv4": {…}, "ipv6": {…} }
  }]
}
```

`youtube/netflix` 的 `ipv4/ipv6` 已是合并后的最终单项结果。结果来源是 `task_query` 读 Agent 已完成的 `execute` 回包(`task_event_result.execute`),解析 `stdout` 最后一行 JSON(兼容 OpenWRT 等会打 banner 的系统)。

> 个别机器偶发 `pending` / 空 stdout,通常是该次任务还在跑,下一轮再查即可。
