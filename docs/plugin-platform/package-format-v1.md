# DIAN115 插件包格式 v1

本文定义 `.d115p` 的 ZIP 结构、Manifest、完整性清单、Ed25519 签名和市场索引。字段约束同时由本目录 JSON Schema 表达；本文负责跨文件规则和字节级签名规则。

## 1. ZIP 结构与限制

插件包是普通 ZIP，扩展名为 `.d115p`。最小结构：

```text
manifest.json
frontend/dist/assets/remoteEntry.js
runtime/plugin.wasm                 # WASM（推荐）
# 或 runtime/plugin                 # legacy process，二选一
integrity.json
signature.json
```

一个包只能声明一种运行时：`runtime.kind=wasm` 时必须提供 `runtime/plugin.wasm`，声明
`runtime.kind=process` 时才提供 `runtime/plugin`。两者不能同时作为入口；legacy process
仅用于兼容既有插件，新插件应选择 WASM。

可选文件包括 `frontend/icon.svg`、Federation 生成的其他 JS/CSS/字体和运行时所需的包内只读资源。

硬限制：

| 项目 | 限制 |
| --- | --- |
| 下载后的 ZIP | 32 MiB |
| 解压总大小 | 128 MiB |
| 单个成员 | 32 MiB |
| ZIP 成员数 | 1024 |
| `manifest.json`、`integrity.json`、`signature.json` | 各 256 KiB |
| 完整性清单成员数 | 最多 1022 |

成员路径必须是 NFC 规范化 UTF-8 包内相对路径，使用 `/`。禁止绝对路径、反斜杠、空段、`.`、`..`、重复 `/`、NUL、冒号、尾随点/空格和 Windows 设备名。大小写折叠后冲突的两个路径也会被拒绝。目录项不是必需的；只应打包普通文件。

legacy `process` 的 `runtime.entry` 必须包含执行位，并校验为当前 Linux 架构的静态 ELF。`wasm` 的入口是普通 `.wasm` 文件，校验 WASM magic、导出内存和 `dian115_alloc`/`dian115_handle` ABI；WASM 不需要执行位，也不要求 Linux 架构匹配。

## 2. `manifest.json`

顶层 `additionalProperties=false`。完整机器约束见 [manifest.schema.json](manifest.schema.json)。必需字段：

```text
schema_version
id
name
version
description
default_locale
publisher
compatibility
runtime
permissions
ui
```

完整示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/madbrolab/dian115/main/docs/plugin-platform/manifest.schema.json",
  "schema_version": 1,
  "id": "example.complete-plugin",
  "name": "完整插件示例",
  "version": "1.0.0",
  "description": "演示状态、动作、任务、事件、通知和主题界面。",
  "default_locale": "zh-CN",
  "publisher": {
    "name": "Example Publisher",
    "key_id": "ed25519:BASE64URL_SHA256_OF_RAW_PUBLIC_KEY",
    "url": "https://example.com",
    "email": "plugins@example.com"
  },
  "compatibility": {
    "dian115": ">=3.8.51 <4.0.0",
    "plugin_api": "^2.0"
  },
  "runtime": {
    "kind": "wasm",
    "entry": "runtime/plugin.wasm",
    "protocol": "dian115:wasm@1",
    "startup_timeout_ms": 10000,
    "shutdown_timeout_ms": 5000,
    "timeout_ms": 30000,
    "background_timeout_ms": 300000,
    "max_concurrency": 4,
    "restart_policy": "on-failure"
  },
  "permissions": {
    "apis": [
      {
        "method": "POST",
        "path": "/api/notifications/plugin",
        "reason": "发送用户主动触发的任务结果"
      }
    ],
    "network": [
      {
        "origin": "https://api.example.com",
        "methods": ["GET", "HEAD", "POST"],
        "proxy_mode": "system",
        "reason": "读取发布者服务数据"
      }
    ]
  },
  "ui": {
    "mode": "federation",
    "icon": "frontend/icon.svg",
    "federation": {
      "entry": "frontend/dist/assets/remoteEntry.js",
      "assets_root": "frontend/dist/assets",
      "module": "./AppPage"
    }
  },
  "events": ["files.changed"],
  "jobs": [
    {
      "id": "refresh",
      "handler": "refresh",
      "default_schedule": "*/15 * * * *",
      "allow_overlap": false
    }
  ],
  "homepage": "https://example.com/plugins/complete",
  "repository": "https://example.com/source/complete",
  "license": "MIT",
  "tags": ["example", "automation"]
}
```

### 2.1 身份与发布者

| 字段 | 规则 |
| --- | --- |
| `schema_version` | 固定为 `1` |
| `id` | 3-128 字符；小写字母/数字组成的段，以 `.` 或 `-` 分隔；发布后不可变 |
| `name` | 1-80 个字符 |
| `version` | SemVer |
| `description` | 1-500 个字符 |
| `default_locale` | BCP 47 形式，例如 `zh-CN` |
| `publisher.name` | 1-100 个字符 |
| `publisher.key_id` | `ed25519:` 加公钥原始 32 字节 SHA-256 的无填充 base64url |
| `publisher.url` / `email` | 可选 URI / email |

`signature.json.key_id`、`manifest.publisher.key_id` 和由 `signature.json.public_key` 计算出的 key ID 必须完全相同。升级应持续使用同一发布者密钥；更换发布者密钥会改变信任身份。

### 2.2 兼容性

`compatibility.dian115` 是宿主版本 SemVer 范围，`compatibility.plugin_api` 是插件 API 范围。它们必须非空。发布者应把实际验证过的最小宿主版本写入范围；不能用此字段绕过包、协议或权限校验。

### 2.3 运行时

`runtime.kind` 为 `wasm`（推荐）或 legacy `process`。对应协议分别是 `dian115:wasm@1` 与 `dian115:process@1`。`entry` 是完整性覆盖的包内相对路径。

WASM runtime 的 ABI、Host imports、配额和生命周期见 [WASM runtime v1](wasm-runtime-v1.md)。WASM 不得声明 `abi`、`health_path`、`event_path`、`action_path`、`state_path` 或 `job_path`；可选的 `memory_mb` 范围为 4–512 MiB。

| 字段 | 默认值 | 范围 |
| --- | ---: | ---: |
| `startup_timeout_ms` | 10000 | 1000-60000 |
| `shutdown_timeout_ms` | 5000 | 1000-60000 |
| `timeout_ms` | 30000 | 100-120000 |
| `background_timeout_ms` | 300000 | 1000-3600000 |
| `max_concurrency` | 4 | 1-16 |
| `restart_policy` | `on-failure` | 仅此值 |

不得提交旧运行时字段，如 `abi`、`memory_mb`、`health_path`、`event_path`、`action_path`、`state_path`、`job_path`。解码器拒绝未知字段。

### 2.4 权限

`permissions.apis` 必须存在，可以为空。每项是安装时展示并批准的精确 `(method, path template, reason)`：

```json
{"method":"GET","path":"/api/tmdb/search","reason":"搜索媒体"}
```

- 最多 128 项且不得重复；
- 方法和路径组合必须出现在 `openapi-v1.yaml` 的 Host API 目录；
- `reason` 为 1-240 个字符；
- 不能使用通配符扩大路径；
- 市场索引和包内 Manifest 必须完全一致。

`permissions.network` 可选，最多 64 个不重复 HTTP/HTTPS origin。它只是代理路由偏好，不限制插件可访问的地址：

```json
{
  "origin": "http://127.0.0.1:8080",
  "methods": ["GET", "POST"],
  "proxy_mode": "required",
  "reason": "该服务要求通过配置代理访问"
}
```

`origin` 只能包含小写/可规范化的 `http` 或 `https` scheme 与 authority，不能包含用户信息、路径、查询、片段或 `*`。可以使用 `localhost`、loopback、容器服务名、宿主名、局域网 IP 或公网域名。方法为 `GET`、`HEAD`、`POST`、`PUT`、`PATCH`、`DELETE`；省略时使用 `GET`。`proxy_mode` 省略时为 `system`。HTTP 不加密，携带秘密时必须确认目标可信。

宿主从这些公开声明派生内部能力开关。插件作者不得在 Manifest 或市场索引中提交旧的 `capabilities` 或 `account_access` 字段。

### 2.5 UI

`ui` 必须存在。当前唯一模式是：

```json
{
  "mode": "federation",
  "icon": "frontend/icon.svg",
  "federation": {
    "entry": "frontend/dist/assets/remoteEntry.js",
    "assets_root": "frontend/dist/assets",
    "module": "./AppPage"
  }
}
```

`entry` 必须位于 `assets_root/` 内，存在于 ZIP 且由完整性清单覆盖。`module` 省略时为 `./AppPage`，格式为 `./` 后跟 1-80 个字母/数字/下划线/连字符组成的暴露名。`icon` 可省略；填写时也必须存在并被完整性覆盖。

UI 加载失败只显示错误状态与重试，不会切换到其他 UI 协议。

### 2.6 事件与任务

`events` 可选，最多 64 个不重复 topic。topic 长度 3-80，只能由字母/数字段和 `.`、`_`、`-` 分隔符组成。目录监控的 `event_topic` 必须出现在这里。`telegram.message` 是运行时注册产生的专用通道，不需要写入 `events`。

`jobs` 可选，最多 32 项。每项的 `id` 和 `handler` 必须唯一；`id` 使用小写事件标识格式，`handler` 最多 128 个字母、数字、点、下划线或连字符。`allow_overlap` 默认 `false`。

`default_schedule` 使用 5 段数字 cron：分钟、小时、日、月、星期。支持 `*`、列表、升序范围和步长；不支持名称或第六段秒。分钟集合的最小间隔为 5 分钟。日和星期不能同时设为非 `*`。

## 3. `integrity.json`

格式见 [integrity.schema.json](integrity.schema.json)：

```json
{
  "schema_version": 1,
  "algorithm": "sha256",
  "files": [
    {
      "path": "frontend/dist/assets/remoteEntry.js",
      "size": 1234,
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    {
      "path": "manifest.json",
      "size": 2048,
      "sha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
    }
  ]
}
```

规则：

1. 列出 ZIP 中除 `integrity.json` 和 `signature.json` 外的每个文件，不能少也不能多。
2. 按 UTF-8 路径字节严格升序排列。
3. `size` 是文件原始字节数。
4. `sha256` 是文件原始字节的小写十六进制 SHA-256。
5. 不允许重复路径或大小写折叠冲突。

`manifest.json` 必须在清单中，因此 Manifest 本身也受完整性保护。

## 4. `signature.json`

格式见 [signature.schema.json](signature.schema.json)：

```json
{
  "schema_version": 1,
  "algorithm": "Ed25519",
  "canonicalization": "RFC8785-JCS",
  "domain": "DIAN115-PLUGIN-PACKAGE-V1",
  "key_id": "ed25519:BASE64URL_SHA256_OF_RAW_PUBLIC_KEY",
  "public_key": "UNPADDED_BASE64URL_RAW_32_BYTE_PUBLIC_KEY",
  "signature": "UNPADDED_BASE64URL_RAW_64_BYTE_SIGNATURE"
}
```

所有 base64url 字段均使用 RFC 4648 URL alphabet，不带 `=`。key ID 的计算：

```text
"ed25519:" + base64url_no_padding(SHA256(raw_32_byte_ed25519_public_key))
```

Ed25519 签名原文是以下字节的直接拼接：

```text
UTF8("DIAN115-PLUGIN-PACKAGE-V1")
0x00
RFC8785-JCS(parse(manifest.json))
0x00
RFC8785-JCS(parse(integrity.json))
```

不是文件原始空白格式的拼接，也不包含 `signature.json`。JSON 必须是合法 UTF-8、不能有重复对象键，并能按 RFC 8785 JCS 规范化。签名验证使用 `signature.json.public_key`；宿主同时验证 key ID 与 Manifest 发布者一致。

## 5. 市场 `index.json`

市场索引格式见本目录的 [market-index.schema.json](market-index.schema.json)。最小示例：

```json
{
  "schema_version": 1,
  "repository": {
    "id": "example.plugins",
    "name": "Example plugins",
    "homepage": "https://example.com/plugins"
  },
  "plugins": [
    {
      "id": "example.complete-plugin",
      "name": "完整插件示例",
      "version": "1.0.0",
      "description": "演示完整插件协议。",
      "author": "Example Publisher",
      "homepage": "https://example.com/plugins/complete",
      "package_url": "https://example.com/releases/example.complete-plugin-1.0.0.d115p",
      "sha256": "PACKAGE_FILE_SHA256_LOWERCASE_HEX",
      "runtime": {
        "kind": "process",
        "protocol": "dian115:process@1",
        "autostart": true,
        "trust_level": "isolated-process"
      },
      "permissions": {
        "apis": [],
        "network": []
      },
      "tags": ["example"]
    }
  ]
}
```

`package_url` 和 `icon_url` 可使用相对索引最终 URL 的相对引用，也可使用绝对 HTTPS URL。索引最多 2 MiB、1000 个插件版本项。同一 `id@version` 不能重复。

安装前会下载包并核对 `sha256`，然后比较：

- 索引 `id` / `version` 与 Manifest；
- 索引 runtime disclosure 与 Manifest runtime；
- 索引规范化后的 `permissions.apis/network` 与 Manifest 权限。

任何差异都会拒绝安装。索引不能通过额外字段授予包内未声明的权限。

## 6. 安装、更新和回滚语义

安装器先完成 ZIP、JSON、签名、完整性、Manifest、权限、UI 和运行时检查；legacy process 额外检查 ELF 架构和静态链接，WASM 检查模块 ABI，再提交安装记录和文件。权限或运行时披露变化会生成新的同意摘要，管理员必须重新确认。

插件文件统一保存在 `/config/package/<plugin-id>/`：签名版本包位于 `package/`，插件持久数据位于 `data/`，私有临时文件位于 `tmp/`。进程启动后只看到自己的这三个目录。更新保留 `data/`，先停止旧进程，再短暂打开只读 package 父目录并原子写入新版本；数据库提交失败会删除新版本并重新协调旧版本。若新进程 `runtime.initialize` 失败，新版本保持已安装并进入不健康、退避或失败状态；宿主不会自动恢复旧包。发布者应在发布前验证目标架构，并保留旧版本包供管理员显式降级。

禁用会停止新调用、任务和事件，注销 Telegram 路由并停止运行时 worker。卸载会删除该插件的整个 `/config/package/<plugin-id>/` 私有目录（包括 `package`、`data`、`tmp`）和安装记录；安装实例级 KV 的保留/删除以当前管理端卸载提示为准。插件不能自行读取其他安装的数据。

### 本地导入

管理员也可以在插件中心直接选择本地 `.d115p` 文件。宿主先把文件放入受控临时目录，执行与市场安装完全相同的 ZIP、Manifest、完整性、签名、权限、Federation UI、静态 ELF 和运行时检查，再返回短期导入令牌供管理员查看权限。

确认安装时，宿主会再次验证令牌有效期、包 SHA-256、`consent_digest` 和包内容，然后复用同一异步安装、替换和回滚流程。令牌 15 分钟后过期且只能使用一次；成功、失败、取消或过期都会清理暂存包。本地导入不会创建市场条目，也不会绕过任何权限确认；安装记录的来源名称为“本地导入”。

## 7. 可复现构包

完整样例的 `scripts/package.mjs` 展示：

- 生成或读取 Ed25519 PEM 私钥；
- 导出原始公钥并计算 key ID；
- 生成最终 Manifest；
- 遍历并排序所有待打包文件；
- 生成完整性清单；
- 按 JCS 构造签名原文；
- 设置 runtime ZIP 执行位；
- 输出 `.d115p` 和包 SHA-256。

私钥必须保存在源码和发布包之外。CI 应通过 secret 文件或密钥服务注入固定发布密钥，不能每个版本重新生成。
