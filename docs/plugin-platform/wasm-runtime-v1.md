# DIAN115 WASM runtime v1

插件包可以声明 `runtime.kind: "wasm"` 与 `runtime.protocol: "dian115:wasm@1"`。宿主在 DIAN115 容器内使用 wazero interpreter 托管模块。模块没有宿主文件描述符、Socket、命令执行、环境密钥或预打开的宿主目录；需要文件、网络、通知、Telegram、状态和调度能力时，必须调用 Host API Broker。

## 模块 ABI

WASM 必须是 reactor（不能导出 `_start`），导出自己的线性内存 `memory`，以及以下函数：

```text
dian115_alloc(size: i32) -> i32
dian115_handle(ptr: i32, length: i32) -> i64
```

`dian115_alloc` 返回可写入请求的内存地址。`dian115_handle` 接收 JSON 请求，返回值高 32 位是响应地址、低 32 位是响应长度。请求和响应均受 16 MiB 宿主帧上限约束，地址必须位于 guest memory 内。模块应复用或回收自己的缓冲区，宿主不会把 guest 指针解释为宿主地址。

模块可选导入 `dian115.host_call(i32, i32) -> i32` 和 `dian115.host_read(i32, i32) -> i32`。前者提交 JSON-RPC Host API 请求并返回响应长度，后者把响应复制到 guest 提供的缓冲区；导入只能用于 `host.*` 方法。宿主会验证方法、安装权限、请求体、凭据引用、幂等键和输出大小。

## 调用封套

宿主调用模块时发送：

```json
{"method":"runtime.invoke","params":{"envelope":{"op":"action","invocation_id":"inv_x","payload":{}},"background":false}}
```

模块返回 JSON-RPC 封套：

```json
{"result":{"status":"succeeded"}}
```

或 `{"error":{"code":-32602,"message":"..."}}`。`op` 包括 `state`、`action`、`job` 和 `event`；事件的 topic 必须先在 manifest 声明并拥有 `events.subscribe` 能力。状态响应需要稳定的 `state_version` 和强 ETag，重复的 `invocation_id` 使用宿主持久化投递账本重放。

## 配额和生命周期

`memory_mb`（4–512 MiB）、`timeout_ms`、`background_timeout_ms`、`max_concurrency`（1–16）由 manifest 声明。超时会取消 guest context；崩溃按 `restart_policy: on-failure` 受监督重启，关闭时先发送 `runtime.shutdown`，超时后终止 worker。WASM worker 只读挂载插件 package，持久化数据通过 Host Storage 保存。

## Telegram 入站消息

插件在初始化时调用 `host.telegram.register` 注册最多 3 个命令和 3 个关键词。宿主先处理内置命令和已识别的链接，剩余文本按注册路由匹配一个插件，然后发送 `telegram.message` 事件。事件只包含 `update_id`、`date`、`message_id`、`message_thread_id`、`chat_id`、`chat_type`、`user_id` 和文本，以及脱敏的匹配信息；Bot Token、原始 Update、用户名和附件不会进入插件。插件可返回纯文本或 HTML 回复、HTTPS 图片和受限 URL 按钮，宿主会校验长度和格式。

当前公开的入站交互渠道是 Telegram。`/api/notifications/plugin` 是插件发起的出站通知接口，不会把系统通知伪装成用户入站消息；新增渠道必须先定义独立的脱敏事件投影、身份范围、幂等键和回复校验。

## 网络地址

manifest 中的 `permissions.network` 是安装时的用途和代理偏好说明，不是永久 allowlist。安装后插件页面可以通过 Host Storage 保存用户输入的 HTTP/HTTPS 地址并调用网络 Broker；未声明地址默认跟随宿主系统代理。Broker 仍执行 URL、重定向、凭据过滤、响应上限和审计，插件不能直接打开 Socket。用户应自行承担其添加的目标服务、凭据和数据风险。
