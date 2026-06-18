# Docker 管理器 · NodeGet 扩展插件

通过 NodeGet 的 **Execute 任务**调用各 Agent 本机的 `docker` CLI，在 board 里远程管理容器/镜像。

> 来自官方扩展愿望清单（`docs/dev/extension`）的「Docker 管理器」。官方原话是"用 Request 任务请求 Docker Unix Socket"，但 `http_request` 任务的 `url` 是 `url::Url` + TCP 出口，**打不了 unix socket**；本插件改用 `execute + docker CLI`（docker CLI 本身就连 `/var/run/docker.sock`），与官方"进程/iptables 管理器用 Exec 任务"一致。

## 形态

NodeGet 扩展插件（`app.json` + `resources/`，board 内 iframe 加载）。装进 **board**（登录后台），安装时按 `app.json.limits` 创建专属 Token，iframe 把 token 传进 UI。**不依赖、也不碰公开的 StatusShow。**

## 阶段

- 阶段 1：只读监控 —— 列容器（`docker ps -a`）、查看日志（`docker logs`）、系统信息（`docker info`）。
- 阶段 2：启停 / 重启 —— `docker start/stop/restart/unpause` + 操作确认 + 自动刷新。
- **阶段 3（当前）完整管理**：
  - 容器：删除（`docker rm -f`）。
  - 镜像 tab：列出（`docker images`）、拉取（`docker pull`，超时 180s）、删除（`docker rmi`）。
  - 运行新容器：`docker run -d` 表单（镜像 / 名称 / 端口 / 卷 / 环境变量 / 重启策略 / 启动命令）。
  - 全部高危操作均二次确认。

容器操作按钮按状态显示：运行中 → 停止 / 重启 / 删除；已暂停 → 恢复 / 删除；其它 → 启动 / 删除。

### 注入防护（运行/拉取/删除）

所有用户输入在拼进 `sh -c` 前都经白名单校验，并用单引号包裹（单引号内禁出现 `' " 换行 反引号 $ \`，从而无法逃逸）：

| 字段 | 规则 |
|---|---|
| 镜像 | `^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$` |
| 容器名 | `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$` |
| 端口 | `[host_ip:]host:container[/tcp\|udp]` |
| 卷 / 环境变量 | 必含 `:` / `=`，且不含 `' " 换行 反引号 $ \` |
| 重启策略 | 固定下拉白名单 |
| 启动命令 | 仅允许 `字母数字 空格 _ - . = : / @` |
| 容器/镜像 id | `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$` |

任一字段不合法即拒绝执行并提示，不下发命令。

## 权限（`app.json.limits`）

```
permissions: task.create=execute, task.read=execute
scope: global
```

⚠️ `task.create=execute` 等于**目标 Agent 的任意命令执行权**——这是 docker CLI 的必需权限（NodeGet 的 execute 任务不区分读写）。即便阶段 1 只做"只读监控"，token 仍具备该权限。安装时 board 会让你确认。要收紧可把 scope 从 `global` 改为特定 `AgentUuid`。

## 工作原理

1. board 以 iframe 打开本插件：`.../static-worker-route/{UUID}/index.html#?token=key:secret&node={agent_uuid}&theme=dark`。
2. `main.js` 从 hash 解析 `token/node/theme`。
3. 同源 HTTP POST JSON-RPC 调 `task_create_task_blocking`：
   ```json
   { "method": "task_create_task_blocking",
     "params": { "token": "...", "target_uuid": "<node>",
       "task_type": { "execute": { "cmd": "sh", "args": ["-c", "docker ps -a --format '{{json .}}' 2>&1"] } },
       "timeout_ms": 20000 } }
   ```
4. 取 `result.task_event_result.execute`（stdout）解析渲染。

实现要点：
- 用 `sh -c "... 2>&1"` 包裹，**合并 stderr**，docker 报错（守护进程不可达 / 无权限）能显示出来。
- 容器 id / 名称经白名单 `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$` 校验后才拼进命令，防 shell 注入；渲染一律 HTML 转义防 XSS。

## 安装

1. 打包：把本目录打成 zip（包含 `app.json` 和 `resources/`）。
2. 在 board 的「扩展/插件安装」界面选该 zip / 文件夹。
3. 确认创建 Token 的权限提示。
4. 到某台机器的节点页，打开「Docker」tab。

## 前提

- 目标 Agent 已安装 `docker` CLI，且 Agent 进程用户能访问 `/var/run/docker.sock`（root 或 `docker` 组）。
- 需要 NodeGet **board**（管理后台）。

## 目录

```
docker-extension/
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
