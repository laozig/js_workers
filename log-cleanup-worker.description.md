# 日志清理 · `log-cleanup`

对所有(或指定)`Agent` 下发 `execute`,把 NodeGet 日志 **truncate 到 0**(清空内容、保留文件),等价于 `: > /var/log/nodeget-agent/app.log`。每台 Agent 各自在本机执行。

默认清两个路径:`/var/log/nodeget-agent/app.log`、`/var/log/nodeget-server/app.log`(后者只在 Server 同机装了 Agent 的机器上存在,其它机器标 `absent` 跳过)。

> ⚠️ **破坏性操作**,日志清空不可恢复。启用定时前确认无需保留。

---

## 环境变量 `env`

| 键 | 必填 | 说明 |
|---|---|---|
| `token` | ✅ | NodeGet 平台 `Token`,需覆盖 `Task::Create(execute)`、`Task::Read`、Agent 列表、KV 读写。 |

## 单文件状态

`cleaned` 已清空(`freed`=字节数) · `kept` 小于 `min_bytes` 未清 · `absent` 文件不存在 · `denied` Agent 进程无写权限。

---

## onCall / onInlineCall + HTTP 路由

基址 `/nodeget/worker-route/log-cleanup`。

| `action` | HTTP | 参数 | 说明 |
|---|---|---|---|
| `clean` | `GET /run`、`GET/POST /clean` | `{uuids?, log_paths?, min_bytes?}` | 立即清理(默认全部 Agent) |
| `install_crons` | `GET/POST /install` | `{uuids?, persist_targets?}` | 给每台 Agent 装本地定时 cron 并立即清一次(**推荐**) |
| `get_config`/`set_config` | `GET/POST /config` | `{config:{...}}` | 读 / 写配置 |
| `list_targets` | `GET /targets` | — | 列 Agent |
| `get_last` | `GET /last` | — | 上次清理结果 |

---

## 配置模型(全局 KV,key `log_cleanup_config`)

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `onCron` 是否执行(关掉则定时跳过,手动仍可用) |
| `log_paths` | 见上 | 要清理的文件列表 |
| `target_uuids` | `[]` | 留空=跟随全部 Agent;非空=锁定子集(清理动作不回写) |
| `min_bytes` | `0` | 仅清大于该字节数的文件(如只清 >50MB) |
| `timeout_ms` | `20000` | 单台 blocking 超时 |
| `cron_expression` | `0 0 4 * * *` | 定时表达式(6 段),默认每天 04:00 |

---

## 定时清理(两种方式,二选一,别同时用)

**方式 A:自助安装(推荐)** —— 部署后访问一次 `GET /install`,worker 用 `crontab_create` 给每台 Agent 装本地 cron(名 `log_cleanup_truncate`,按 `cron_expression`)并立即清一次。之后各机自主定时,无需手动建 Server 任务。新机器再 `/install` 一次纳入。改时间/阈值:先 `POST /config`,再 `/install`。

**方式 B:Server 定时任务** —— 平台「定时任务」建 Server 任务,`cron_type` 选 `js_worker` 指向本 worker,`onCron` 对全部 Agent 跑一次 blocking 清理(`enabled:false` 时跳过)。

```bash
BASE="https://<你的站点域名>"   # 以你当前站点入口域名为准

curl -sS --max-time 120 "$BASE/nodeget/worker-route/log-cleanup/run"        # 立即清全部
curl -sS --max-time 120 "$BASE/nodeget/worker-route/log-cleanup/install"    # 装自助定时(方式 A)
# 只清 >50MB:POST /clean -d '{"min_bytes":52428800}';只清指定机:-d '{"uuids":[...]}'
```

---

## 返回结构(`clean` / `GET /run`)

顶层 `ok / time / target_count / ok_count / failed_count / total_freed / total_freed_human`,外加 `agents[]`,每台含 `uuid / name / ok / freed / files[]`(每个文件 `{file, freed, status}`)。

## 推荐步骤

1. 新建 `JS Worker`,粘贴 `log-cleanup-worker.js`,保存。
2. `route_name = log-cleanup`,`env` 填 `token`。
3. 先 `GET /run` 试跑,确认 `ok_count` / `total_freed_human` 符合预期;出现 `denied` 说明 Agent 进程对该日志无写权限,需提权或改属主。
4. 满意后访问一次 `GET /install`,自动给所有机器装好每日定时清理(方式 A)。
