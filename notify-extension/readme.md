# 消息通知 扩展

NodeGet Dashboard 扩展,为「消息通知」提供图形化配置面板(对齐 Komari 通知)。

扩展 iframe 内即是完整界面(**不再跳转** worker 的 `/ui`),鉴权方式**和 Docker / 流量监控插件一致**:用安装时按 `app.json.limits` 创建的 NodeGet Token(经 iframe hash 传入),调 `js-worker_run`(`run_type=call`)触发 `notify-worker` 的 `onCall`,再轮询 `js-result_query` 取结果。**不再使用 worker 的 `route_secret`**。

所需权限(`app.json.limits` 已声明,安装时确认):

- `JsWorker::RunDefinedJsWorker` — 运行 worker
- `JsResult::Read` — 读执行结果
- Scope:`JsWorker(notify-worker)`

> ⚠️ `WORKER_NAME` 默认 `notify-worker`,须与 worker 的**脚本名**一致(不是 route_name)。改了脚本名要同步 `resources/assets/main.js` 顶部的 `WORKER_NAME` 与 `app.json` 的 scope。

## 为什么仍需要 worker

通知是**有状态 + 定时**的功能:90 秒判离线、同轮合并、失败重试、到期每天一次、流量阶梯报警,都靠 `notify-worker` 的 `onCron` 周期性跑 + KV 存状态。扩展只是它的配置面板,无法脱离 worker 独立工作(这点和 Docker 那种"即时无状态"插件不同)。本次重构去掉的是对 worker `/ui` 页面的依赖,不是去掉 worker。

## 前置:部署 notify-worker

worker 文件在上级目录 `../notify-worker.js`。**单文件**,在面板里部署即可:

1. Dashboard → **JS Worker** → 新建,名称 `notify-worker`。
2. 把 `notify-worker.js` 全文贴进代码框,点**保存代码**。
3. **环境变量** 加一条 `token` = 你的 NodeGet Token(需含读 agent/动态摘要 + KV 读写权限;cron 触发还需 `JsWorker::RunDefinedJsWorker`)。这是 **NodeGet 平台 Token,不是 Telegram bot token**。
4. Dashboard → **定时任务** 新建一个任务,脚本 `notify-worker`,cron 建议 `0 */2 * * * *`(每 2 分钟检测一次)。**必须有这个定时任务**,否则不会检测/推送。

## 安装扩展

1. NodeGet Dashboard → **扩展管理** → 安装。
2. 选本 `notify-extension` 文件夹,或 `notify-extension.zip`。
3. 装后「应用扩展」区出现「消息通知」入口(全局,一套配置管所有节点)。

## 使用

- **开启通知**:总开关,关闭后定时检测不发送。
- **Telegram 设置**:填 Bot Token(@BotFather 获取)、Chat ID(数字 id 或 @频道名)、可选话题 ID、请求端点(被墙可填反代)。
- **通知事件**:勾选 离线 / 上线 / 到期 / 流量超额。同轮多台离线/恢复**合并成一条**;到期**每天提醒一次**(临期后每天叮,续费即停);流量从 80% 起每 +5% 报一档。
- **消息模板**:变量 `{{emoji}}` `{{event}}` `{{client}}`(节点名) `{{time}}`(CST) `{{type}}`。
- **发送测试**:验证 Telegram 配置通不通。**立即检测**:手动跑一轮(会先保存当前配置)。
- 顶部状态条显示「上次检测 N 分钟前 · 发出 X 条」;显示「尚未运行」= 定时任务没配或没跑。

## 安全

- **bot_token 打码**:面板不回显明文 token,只显示尾巴提示(如 `12345…wXyz`);保存时 token **留空 = 保留原值**,重填非空才覆盖。
- **token 鉴权**:装进 board(登录后台),用安装时创建的细粒度专属 Token,经 iframe hash 传入;**不碰公开站,无需密码门**。Telegram 凭证写在 worker 的 KV(经 token RPC),不进 URL/日志。

> 流量超额事件需已部署 `traffic-billing-worker`(notify 经 `inlineCall` 读它的告警节点)。
