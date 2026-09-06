# DIAN115 Process Runtime v1

本文是历史 `dian115:process@1` 线协议。新插件应使用 `dian115:wasm@1`；WASM 运行时仍复用本协议的 invocation、Host API、Telegram 和事件语义，但不需要 Linux 原生进程或 seccomp。

## 1. 启动环境

入口由 `runtime.entry` 指定，必须是当前宿主架构的静态 Linux ELF。宿主主服务在当前 Docker 容器内直接启动该入口作为伴生子进程；不创建插件容器，也不要求宿主机额外安装运行组件。启动前宿主会将进程根切换到 `/config/package/<plugin-id>/`，工作目录为私有根 `/`。该根只包含当前插件的 `package`、`data`、`tmp` 三个目录：其他插件、`/config`、Linux 系统目录和媒体挂载均不可见。宿主只设置以下环境：

| 变量 | 值 |
| --- | --- |
| `PATH` | 当前版本包内的 `runtime` 与 `bin` 目录；通过它启动的辅助进程继承相同私有根 |
| `HOME` | `/data` |
| `LANG` | `C.UTF-8` |
| `TZ` | `Asia/Shanghai` |
| `DIAN115_PLUGIN_ID` | Manifest 插件 ID |
| `DIAN115_PLUGIN_VERSION` | 当前安装版本 |
| `DIAN115_PLUGIN_PROTOCOL` | `dian115:process@1` |
| `DIAN115_PLUGIN_DATA` | `/data`；当前插件的持久化目录，可直接读写 |
| `DIAN115_PLUGIN_PACKAGE` | `/package/<当前版本目录>`；当前安装包，可直接读取并执行包内文件 |
| `TMPDIR` | `/tmp`；当前插件的临时目录，可直接读写 |
| `DIAN115_PLUGIN_FILESYSTEM` | `private-root` 表示已进入插件私有根；`host-api-only` 表示部署主动删除了 Docker 默认 chroot 能力，此时路径文件 syscall 会被拒绝，插件必须使用 Host API |

宿主不继承任意容器环境变量，不传数据库、Cookie、JWT、115、TMDB、Telegram、CD2 或代理秘密。

入口不得 daemonize、脱离进程组或把 stdout 用作日志。插件可以按需启动随包提供的辅助进程；辅助进程继承相同私有根、seccomp/no-new-privileges 限制和宿主进程组生命周期，可以访问当前插件的 `/package`、`/data`、`/tmp`，但不能访问其他路径或建立直连 socket。主进程退出后宿主终止整个进程组。

## 2. 帧格式

每条 JSON-RPC 消息使用 UTF-8 `Content-Length` 帧：

```text
Content-Length: <JSON 字节数>\r\n
Content-Type: application/json\r\n
\r\n
<JSON bytes>
```

接收方忽略除 `Content-Length` 外的帧 header，但 header 总大小不得超过 8192 字节。`Content-Length` 必须恰好出现一次，范围 1-16777216。JSON body 必须是单个合法对象。协议消息不得超过 16 MiB，以容纳 Base64 编码后的 8 MiB Host Call 正文。

JSON-RPC 对象只允许：

```json
{
  "jsonrpc": "2.0",
  "id": "string-id",
  "method": "method.name",
  "params": {},
  "result": {},
  "error": {"code": -32601, "message": "method not found", "data": {}}
}
```

`jsonrpc` 必须为 `2.0`。`id` 必须是 1-128 字符的 JSON string，数字/null ID 不受支持。请求包含 `method`；响应不包含 `method`，并包含 `result` 或 `error`。未知响应 ID 可能是已超时调用的迟到响应，宿主会忽略。

stdio 是全双工的。宿主可能并发发起最多 `runtime.max_concurrency` 个 invocation。插件处理 `runtime.invoke` 时可以同步发出 `host.call`，因此插件必须保持一个持续读取循环，把响应分发给等待者，并在独立 goroutine/task 中处理入站请求。串行“读一个请求、处理完再读”会在嵌套 Host Call 时死锁。

插件收到未知方法应返回 `-32601`；参数类型/字段错误返回 `-32602`。单个业务错误不应关闭帧读取循环。无法解析帧、JSON-RPC 结构错误或 stdout 混入普通文本会使宿主关闭进程。

## 3. 生命周期

### 3.1 初始化

进程启动后的第一个宿主请求：

```json
{
  "jsonrpc": "2.0",
  "id": "h:1",
  "method": "runtime.initialize",
  "params": {
    "protocol": "dian115:process@1",
    "plugin_id": "example.complete-plugin",
    "plugin_version": "1.0.0",
    "installation_id": 42,
    "locale": "zh-CN",
    "timezone": "Asia/Shanghai"
  }
}
```

成功响应：

```json
{
  "jsonrpc": "2.0",
  "id": "h:1",
  "result": {
    "ready": true,
    "protocol": "dian115:process@1"
  }
}
```

`protocol` 可省略；填写时必须匹配。`ready` 必须为 `true`。插件可在处理初始化期间使用全双工通道调用 `host.log` 或 `host.telegram.register`，但必须在 `startup_timeout_ms` 内响应初始化。失败会终止该进程并进入重启策略。

### 3.2 调用超时与并发

- 前台 `state`、`action` 和 Telegram event 使用 `timeout_ms`，默认 30 秒；
- 后台 scheduled job 和普通 event 使用 `background_timeout_ms`，默认 5 分钟；
- `max_concurrency` 默认 4，范围 1-16；
- 超时后宿主认为进程不健康并终止它，随后按失败策略重启。

插件应尊重 invocation context，自行停止已取消工作。由于进程被终止前可能已产生外部副作用，写操作必须使用稳定幂等 key。

### 3.3 关闭

宿主有意停止时发送：

```json
{
  "jsonrpc": "2.0",
  "id": "h:9",
  "method": "runtime.shutdown",
  "params": {"reason": "host_stop"}
}
```

插件应停止接受新工作、刷新持久状态并返回任意 JSON object result。超过 `shutdown_timeout_ms` 后宿主向整个进程组发送终止信号，再等待同一时长，最后强制结束。

### 3.4 退出与重启

正常退出码 0、宿主有意停止或宿主退出不会自动重启。非零意外退出或启动失败使用 `1s, 2s, 4s, 8s, 16s` 退避，最多 5 次；超过后状态为 `failed`，需要管理员操作。连续运行至少 1 分钟后，重启计数重置。

可见运行状态包括 `starting`、`running`、`backoff`、`failed` 和 `stopped`，并可能显示 PID、启动/退出时间、重启次数、退出码和脱敏错误。

插件更新的文件提交与初始化不是回滚事务。更新语义详见 [插件包格式](package-format-v1.md#6-安装更新和回滚语义)。

## 4. `runtime.invoke` 通用信封

所有业务调用使用：

```json
{
  "jsonrpc": "2.0",
  "id": "h:2",
  "method": "runtime.invoke",
  "params": {
    "envelope": {
      "op": "action",
      "invocation_id": "inv_0123456789abcdef",
      "payload": {}
    },
    "background": false
  }
}
```

`op` 为 `state`、`action`、`job` 或 `event`。`invocation_id` 在逻辑调用中稳定；宿主对不确定投递重试时复用同一 ID 和完全相同的 envelope。插件必须以该 ID 做幂等去重。相同 ID 如果对应不同请求，宿主拒绝为 `invocation_conflict`；正在执行时重入为 `invocation_in_progress`。

除 `host.call` 外，插件对 `runtime.invoke` 返回的业务 result 必须是一个不超过 256 KiB 的 JSON object，不能包含尾随 JSON。`host.call` 可承载 8 MiB 正文，详见 [Host Call v2](host-call-v2.md)。为了防止运行时把秘密或宿主路径传到 UI/日志，宿主递归拒绝：

- key 为 `cid`、`file_id`、`database_id`、`absolute_path`、`raw_path`、`password`、`client_secret`、`webhook_secret`、`access_token`、`refresh_token`、`authorization`；
- 任意包含 `cookie` 的 key；
- 以 `_token` 或 `_secret` 结尾的 key；
- 任意绝对 POSIX、UNC 或 Windows drive path string。

以 `_ref` 结尾的 opaque reference 字段允许返回。插件应返回稳定 opaque ref，不要返回宿主原始 ID、凭据或绝对路径。

## 5. State 调用

请求 payload：

```json
{
  "op": "state",
  "invocation_id": "state_main",
  "payload": {
    "view": "main",
    "if_none_match": "\"state-v7\""
  }
}
```

`view` 长度 1-80，格式为字母/数字段，以 `.`、`_`、`-` 分隔，默认页面使用 `main`。`if_none_match` 为空或一个强 ETag，禁止 weak ETag、列表和控制字符。

有新状态时必须返回：

```json
{
  "state_version": "state-v8",
  "etag": "\"state-v8\"",
  "state": {
    "status": "ready",
    "processed": 12
  }
}
```

规则：

- `state_version` 必须是有效 1-80 字符 runtime identifier；
- `state` 必须存在，可以是任意合法 JSON 值，但完整 result 仍受安全字段规则限制；
- `etag` 可省略，宿主会生成 `"<state_version>"`；
- 填写时必须是强 ETag，且去掉双引号后与 `state_version` 完全相同。

若请求 ETag 与当前状态相同，可返回：

```json
{
  "not_modified": true,
  "etag": "\"state-v8\""
}
```

只有请求确实带同一个合法强 ETag 时才允许 `not_modified=true`；否则宿主返回 `runtime_protocol_error`。宿主也会在完整状态响应的 ETag 等于请求时转换为前端 304。

## 6. Action 调用

请求：

```json
{
  "op": "action",
  "invocation_id": "inv_0123456789abcdef",
  "payload": {
    "id": "send-test",
    "input": {"message": "hello"},
    "context": {
      "locale": "zh-CN",
      "timezone": "Asia/Shanghai"
    }
  }
}
```

`payload.id` 和 invocation ID 使用 runtime identifier 格式；action invocation ID 必须以 `inv_` 开头。`input` 缺省为 `{}`，并受安全 JSON 规则约束。

响应必须含以下状态之一：

```json
{"status":"succeeded","message":"done","refresh":true}
{"status":"failed","message":"business operation failed","code":"upstream_rejected"}
{"status":"accepted","job_ref":"job_opaque_ref"}
{"status":"skipped","message":"nothing to do"}
```

允许额外安全字段，宿主只固定校验 `status` 枚举。`failed` 是插件业务结果，仍以成功 JSON-RPC response 返回；协议/传输错误才使用 JSON-RPC error。

## 7. Scheduled job 调用

Manifest job：

```json
{
  "id": "refresh",
  "handler": "refresh",
  "default_schedule": "*/15 * * * *",
  "allow_overlap": false
}
```

投递：

```json
{
  "op": "job",
  "invocation_id": "inv_0123456789abcdef",
  "payload": {
    "id": "refresh",
    "handler": "refresh",
    "scheduled_for": "2026-08-22T08:00:00Z",
    "trigger": "schedule",
    "attempt": 1
  }
}
```

`trigger` 为 `schedule` 或 `manual`。当前 envelope 的 `attempt` 固定为 `1`；重试保持原 envelope 和 invocation ID，不用该字段推断 delivery ledger 次数。

job 结果只能是：

```json
{"status":"accepted","job_ref":"refresh_20260822"}
{"status":"skipped","message":"previous run still active"}
```

耗时工作可以在进程内继续，但宿主将 `accepted` 视为本次 job 调用已完成。若需要让宿主持久跟踪具体进度，应把状态写入安装实例级 KV，并由 `state` 暴露安全摘要。

## 8. 普通 Event 调用

Manifest 必须声明普通 topic：

```json
"events": ["files.changed"]
```

投递：

```json
{
  "op": "event",
  "invocation_id": "evt_0123456789abcdef",
  "payload": {
    "id": "evt_0123456789abcdef",
    "topic": "files.changed",
    "occurred_at": "2026-08-22T08:00:00.123Z",
    "data": {
      "watch_ref": "fw_0123456789abcdef",
      "backend": "local",
      "added": ["movie/file.mkv"],
      "removed": [],
      "modified": [],
      "truncated": false,
      "resync_required": false
    }
  }
}
```

event ID 必须以 `evt_` 开头。成功可返回任意安全 JSON object，推荐：

```json
{"accepted":true}
```

目录监控投递失败会按稳定 ID 重试；超过重试上限进入 dead letter。插件可通过 watch retry/resync Host API 恢复。`truncated` 或 `resync_required` 为 true 时不要假设变化列表完整，应主动读取当前目录或请求重建基线。

## 9. Telegram Event

Telegram 命令/关键词匹配使用同一个 `op=event`，但 topic 固定为 `telegram.message`，不需要写入 Manifest `events`：

```json
{
  "op": "event",
  "invocation_id": "evt_0123456789abcdef",
  "payload": {
    "id": "evt_0123456789abcdef",
    "topic": "telegram.message",
    "occurred_at": "2026-08-22T08:00:00Z",
    "data": {
      "match": {"type": "command", "value": "media_helper"},
      "message": {
        "message_id": 42,
        "message_thread_id": 7,
        "chat_id": -100123,
        "chat_type": "supergroup",
        "user_id": 10001,
        "text": "/media_helper status"
      }
    }
  }
}
```

`match.type` 为 `command` 或 `keyword`。消息只包含最小投影；没有 Bot Token、原始 Update、用户名或附件。

响应必须严格符合：

```json
{
  "handled": true,
  "reply": {
    "format": "html",
    "text": "<b>Media helper</b> is ready",
    "image_url": "https://cdn.example.com/status.png",
    "buttons": [
      [{"text": "Open help", "url": "https://example.com/help"}]
    ]
  }
}
```

- `handled=false` 时宿主忽略 `reply`；
- `handled=true` 可以不回复；
- `format` 为 `plain`（默认）或 `html`；
- text 最多 4000 字符；text 和 `image_url` 至少一个非空；
- 图片和按钮必须是绝对 HTTPS URL；
- 最多 8 行按钮，每行 1-4 个，每个按钮文本 1-64 字符；
- 不支持插件 callback data；
- 不允许未知字段、尾随 JSON 或不安全控制字符。

Telegram event 使用 15 秒总超时。分发失败时宿主将其视为插件通道已匹配但处理失败，不会再让其他插件接管同一消息。

## 10. 插件调用宿主的方法

### 10.1 `host.call`

完整定义见 [Host Call v2](host-call-v2.md)。成功返回 `{status, headers, body_base64}`。参数/权限/调度错误返回 JSON-RPC `-32001`。

### 10.2 `host.log`

```json
{
  "jsonrpc": "2.0",
  "id": "p:log:1",
  "method": "host.log",
  "params": {
    "level": "info",
    "message": "任务完成",
    "fields": {"job_ref": "job_01", "count": 12}
  }
}
```

成功 result：`{"accepted":true}`。level 为 `debug`、`info`、`warn`/`warning` 或 `error`，空值按 `info`。message 必需且最多 8 KiB；fields 是安全 JSON，最多 8 KiB。宿主对常见 secret 名和敏感 URL 再脱敏。

stderr 每行也以 `info` 写入插件日志；扫描行最大 64 KiB，最终单条截断为 8 KiB。stdout 绝不能写日志。

每安装实例日志最多 5000 条、4 MiB、保留 14 天；达到任一限制从最旧记录裁剪。

### 10.3 `host.ui.invalidate`

```json
{
  "jsonrpc": "2.0",
  "id": "p:ui:1",
  "method": "host.ui.invalidate",
  "params": {}
}
```

成功 result 为 `{"accepted":true}`。当前宿主把它作为刷新提示；插件仍应让 action result 带足够信息，并让下一次 `state` 返回新 `state_version`。

### 10.4 Telegram 注册

注册或原子替换：

```json
{
  "jsonrpc": "2.0",
  "id": "p:tg:1",
  "method": "host.telegram.register",
  "params": {
    "commands": [
      {"command": "media_helper", "description": "打开媒体助手"}
    ],
    "keywords": [
      {"keyword": "媒体助手", "match": "prefix"}
    ]
  }
}
```

约束：

- 至少 1 个命令或关键词；
- 每插件最多 3 个命令、3 个关键词；
- 命令会去掉开头 `/` 并转小写，最终匹配 `[a-z][a-z0-9_]{0,31}`；
- description 1-80 个安全字符；
- 关键词去除首尾空白，长度 2-80，match 为 `exact`、`prefix`、`contains`；
- 同插件内不能重复；关键词跨插件按忽略大小写判冲突；
- 宿主保留命令、其他插件冲突或全局插件命令超过 64 时返回 `-32003`，旧注册不变；
- 进程 generation 已失效时返回 `-32004`；
- 其他参数错误返回 `-32602`。

查询：

```json
{"jsonrpc":"2.0","id":"p:tg:2","method":"host.telegram.list","params":{}}
```

注销：

```json
{"jsonrpc":"2.0","id":"p:tg:3","method":"host.telegram.unregister","params":{}}
```

两者都返回 `{commands:[...], keywords:[...]}`。禁用、更新、卸载和进程 generation 替换时宿主自动注销；每次初始化应重新注册。

宿主所有内置消息处理器优先。只有宿主未处理且命中注册项的消息才选择一个插件；未匹配消息不会广播给插件。

## 11. 沙箱与文件边界

启动 helper 先校验包内入口和当前插件私有根，再使用生产环境标准 Docker 已有的 `SYS_CHROOT` 能力执行 chroot；随后在不改变 UID 的情况下清空进程全部 capability，应用 `no_new_privs` 和 seccomp 系统调用过滤，最后启动入口。该流程不修改 Compose、不创建插件容器，不要求挂载、网络管理或宿主额外服务。生产 Compose 保持现状即可：默认能力可用时运行在 `private-root`；如果部署方显式删掉 `SYS_CHROOT`，则自动降级为 `host-api-only`，插件仍可运行 JSON-RPC、网络 Broker、TG、通知和业务 Host API，但所有路径文件 syscall 都被拒绝。只有 mandatory seccomp、入口校验或进程设置本身失败时，插件才不会启动。无论哪种模式，宿主文件均只能通过 Host API 操作。

插件可以直接使用普通文件 API 访问 `/package`、`/data`、`/tmp`；这些目录只对应当前插件。版本包为只读，`data` 在更新和容器重启后保留，`tmp` 只用于插件私有临时文件。`/config`、其他插件目录、Linux 系统目录、媒体挂载和宿主其他路径不在私有根中。文件 Host API 仍用于访问宿主文件服务，并继续校验路径、解析后的符号链接目标和权限。直接 socket、挂载/命名空间、ptrace、BPF、内核模块和 fanotify 等逃逸面被拒绝。辅助进程可以存在，但同样不能绕过私有根或影响宿主其他进程。

如果 `DIAN115_PLUGIN_FILESYSTEM=host-api-only`，这是宿主检测到当前容器没有可用的默认 chroot 能力后的安全降级：插件仍正常运行 JSON-RPC、网络 Broker、TG、通知和业务 Host API，但所有路径文件 syscall 都返回 `EPERM`。宿主不会为了插件修改 Compose 或增加 capability。

插件不得把真实宿主路径写入日志、runtime result 或 UI。插件自己的文件状态可直接保存在 `/data`，小型结构化状态也可继续通过 `/api/plugin-runtime/storage/:key` 使用安装实例级 KV。网络请求、宿主目录监控、TG、通知和所有 DIAN115 操作均通过 Host API/Broker 完成。
