# 消息通知 · `notify`

NodeGet 事件通知(对齐 Komari):节点**离线/上线、到期提醒、流量超额**,通过 Telegram Bot 推送。完全在边缘端运行,不改探针 agent。配置面板由 `notify-extension`(token 鉴权 iframe)经 `onCall` 读写——**无内置 `/ui`、无 `route_secret`**。

---

## 环境变量(env)

| 键 | 必填 | 说明 |
|---|---|---|
| `token` | ✅ | NodeGet 平台 Token,需含「读 agent / 动态摘要 + KV 读写」;cron 触发还需 `JsWorker::RunDefinedJsWorker`。⚠️ **不是** Telegram bot token。 |

> Telegram 的 `bot_token` / `chat_id` 不在 env,在配置面板里填(存 KV);`bot_token` 经 `get_config` 返回时始终**打码**。

## 定时任务(必须)

新建 JsWorker 定时任务 → 脚本 `notify-worker` → cron 建议 `0 */2 * * * *`(每 2 分钟,6 段格式)。
> ⚠️ 没有定时任务则**不检测离线 / 上线 / 到期**(只有手动「立即检测」会跑)。

## onCall / onInlineCall(`params.action`,供扩展经 `js-worker_run` 调用)

| action | 参数 | 说明 |
|---|---|---|
| `get_config` | — | 读配置(`bot_token` 打码)+ 运行状态 |
| `set_config` | `{config:{...}}` | 改配置(`bot_token` 留空 = 保留原值,不覆盖) |
| `test` | — | 发一条测试消息 |
| `run` | — | 立即检测并推送一轮 |
| `get_state` | — | 读运行状态(`last_run` / `last_sent` 等) |

> 已移除内置 `/ui` 与 HTTP 路由(`onRoute`):配置改由 `notify-extension` 用 NodeGet Token 调上面的 `onCall`(`js-worker_run` → 轮询 `js-result_query`),与 Docker / 流量监控插件一致。

## 配置模型(全局 KV,key `notify_config`)

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关,关闭则 onCron 不发送 |
| `bot_token` / `chat_id` | — | Telegram 凭证(chat_id 可填 @频道名) |
| `message_thread_id` | — | 可选,超级群话题 |
| `endpoint` | `https://api.telegram.org/bot` | 被墙可填反代 |
| `template` | `{{emoji}} {{event}}…` | 消息模板 |
| `events` | offline/online/expire 开,traffic 关 | 四类事件开关 |
| `expire_days` | `7` | 到期提前提醒天数(1–90) |

## 事件说明

- **离线 / 上线**:90 秒无上报判离线;同一轮多台离线/恢复**合并成一条**;发送失败下轮重试。
- **到期**:`metadata_expire_time` 距今 ≤ N 天(默认 7),**每天提醒一次**(跨天重发,续费即停)。
- **流量超额**:经 `inlineCall` 读 `traffic-billing-worker` 的告警节点,**80% 起每 +5% 档位报一次**;需勾选该事件且已部署 traffic-billing。

## 消息模板变量

`{{emoji}}` `{{event}}` `{{client}}`(节点名) `{{time}}`(CST) `{{type}}`
