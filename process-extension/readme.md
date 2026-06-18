# 进程管理器 · NodeGet 扩展插件

通过 NodeGet 的 **Execute 任务**调用各 Agent 本机的 `ps` / `kill` / `systemctl` / `pm2`，在 board 里远程管理**系统进程、systemd 服务、pm2 进程**。

> 来自官方扩展愿望清单的「进程管理器 — 灵活运用 Exec 任务执行 `ps`、`kill` 命令」。与 `docker-manager` 同构:纯前端扩展、无 worker、token 鉴权、`task_create_task_blocking` 下发 `execute`。

> ⚠️ **无防呆**:本插件可结束**任意**进程,**包括 nodeget-agent / nodeget-server 自身**。杀掉 Agent 进程会**立即断开该机器与面板的连接,且无法再从面板恢复**——只能登录机器手动重启 Agent。`systemctl stop` 关键服务、`kill -9` 同理。请看清 PID/服务名再操作。

## 形态

NodeGet 扩展插件（`app.json` + `resources/`，board 内 iframe 加载）。装进 **board**(登录后台),安装时按 `app.json.limits` 创建专属 Token,iframe 把 token 传进 UI。**不依赖、也不碰公开的 StatusShow,无需 worker。**

节点级路由:在某台机器的节点页打开「进程」tab,管理**该机**。

## 三个 tab

| tab | 列表命令 | 动作 |
|---|---|---|
| **进程** | `ps aux`（前端按 CPU%/内存% 排序、搜索、用户/系统 筛选） | 结束 `kill <pid>`、强制 `kill -9 <pid>`（单独红按钮，二次确认） |
| **端口** | `ss -tulpn`（无则回退 `netstat -tulpn`） | 列监听端口 → 进程/PID；可直接结束占用某端口的进程 |
| **日志** | `tail -n N <绝对路径>` | 看任意日志文件：输入路径直接 tail（含常用快捷：syslog / nodeget-agent / nginx 等）；路径做注入校验 |
| **systemd** | `systemctl list-units --type=service --all` | start / stop / restart / enable / disable；**日志 `journalctl -u`**；状态 `systemctl status` |
| **pm2** | `pm2 jlist`（JSON） | restart / stop / start / delete；**日志（直接 tail `pm_out/err_log_path` 文件，不用 `pm2 logs --nostream`）** |

- 进程表 CPU/内存/RSS **就地刷新**(每 15s),进程集合与排序不变时不重建 DOM,无闪烁。
- **用户 / 系统 / 全部 筛选**(带实时计数,默认「用户」):内核线程(`[kworker]`、`[ksoftirqd]` 等,常占进程总数的 70%+)归「系统」隐藏,「用户」只看用户态进程。⚠️ 这些 NodeGet agent 多为 **root 单用户 VPS**(几乎全部进程 UID=0),按用户名/UID 区分"系统/用户"会让"用户"组为空、毫无意义——所以这里按 **内核线程 vs 用户态** 切分,这才是去噪的实际有效维度。
- systemd 无 systemd 的机器 → 提示「本机无 systemd」;pm2 未安装 → 提示「未检测到 pm2」。
- 命令以 `sh -c "... 2>&1"` 下发,**合并 stderr**,权限不足/服务不存在等报错会原样显示。

## 注入防护

所有动态值拼进 `sh -c` 前都经白名单校验,字符串值用单引号包裹:

| 字段 | 规则 |
|---|---|
| PID / pm2 id | `^\d+$`（纯数字，天然无注入） |
| systemd 服务名 | `^[a-zA-Z0-9@._:-]+$` |
| pm2 名称（仅显示兜底，动作只用数字 id） | `^[a-zA-Z0-9_.-]+$` |

任一不合法即拒绝,不下发命令;渲染一律 HTML 转义防 XSS。

## 权限（`app.json.limits`）

```
permissions: task.create=execute, task.read=execute
scope: global
```

⚠️ `task.create=execute` 等于**目标 Agent 的任意命令执行权**(NodeGet 的 execute 任务不分读写)——这是 `kill`/`systemctl`/`pm2` 的必需权限,安装时 board 会让你确认。要收紧可把 scope 从 `global` 改为特定 `AgentUuid`。

## 工作原理

1. board 以 iframe 打开:`.../static-worker-route/{UUID}/index.html#?token=key:secret&node={agent_uuid}&theme=dark`。
2. `main.js` 从 hash 解析 `token/node/theme`。
3. 同源 HTTP POST JSON-RPC 调 `task_create_task_blocking`:
   ```json
   { "method": "task_create_task_blocking",
     "params": { "token": "...", "target_uuid": "<node>",
       "task_type": { "execute": { "cmd": "sh", "args": ["-c", "ps aux 2>&1"] } },
       "timeout_ms": 20000 } }
   ```
4. 取 `result.task_event_result.execute`(stdout)前端解析渲染。

## 安装

1. 打包:把本目录打成 zip(含 `app.json` 和 `resources/`),或用 `process-manager-extension.zip`。
2. board 的「扩展管理 → 安装」选该 zip / 文件夹。
3. 确认创建 Token 的权限提示。
4. 到某台机器的节点页,打开「进程」tab。

## 前提

- Agent 进程需 **root** 才能 kill 他用户进程 / 用 `systemctl` 控制服务;非 root 时相应命令报 `denied`,UI 原样显示。
- pm2 列的是 **Agent 运行用户**的 pm2 守护进程;若 pm2 装在别的用户下,这里看不到。
- 需要 NodeGet **board**(管理后台)。

## 目录

```
process-extension/
├── app.json
├── readme.md
└── resources/
    ├── index.html
    └── assets/
        ├── main.js
        ├── style.css
        ├── icon.svg
        └── route-icon.svg
```
