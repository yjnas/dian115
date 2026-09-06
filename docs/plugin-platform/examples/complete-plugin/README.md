# 完整插件示例

本目录是一个可以直接构建、签名和发布的插件，而不是只有 UI 的片段。它演示：

- 强制 Vue 3 Module Federation 页面；
- 宿主 singleton 的 Vue 3、Naive UI 和 `@lucide/vue`；
- `dian115-theme-v1` 主题变量；
- Go WASM reactor runtime（`dian115:wasm@1`）；
- 全双工 `Content-Length` JSON-RPC；
- `runtime.initialize`、state、action、job、普通 event、Telegram event 和 shutdown；
- `host.call` 发送插件通知、读写 Host Storage、访问本地 HTTP 服务和创建目录监控；
- 初始化时动态注册 1 个 Telegram 命令和 1 个关键词；示例遵守每个插件最多 3 个命令和 3 个关键词；
- 用户点击触发的 `window.open()` 外部弹窗、图片渲染和浏览器存储；
- 生成完整性清单、Ed25519 签名、正确 ZIP 执行位、包 SHA-256 和市场条目。

## 前置条件

- Node.js 20+
- npm
- Go 1.22+

WASM runtime 与宿主 CPU 架构无关；构建机可以是 Windows、macOS 或 Linux。

## 构建

```bash
npm install
npm run build
npm run check
```

本地预览 Vue 页面：

```bash
npm run dev
```

预览入口提供与宿主一致的 Naive UI Provider 和主题变量，并使用本地 mock bridge；正式包仍通过 Federation 加载 `./AppPage`。

示例页必须由宿主提供的 Vue 3、Naive UI 和 `@lucide/vue` singleton 渲染。插件 UI 可以使用普通浏览器 `fetch`，但它受 CORS、混合内容和页面生命周期约束；需要宿主代理、托管凭据、后台运行、审计或稳定重试的业务请求应调用 action 进入进程，再由 `host.call` 访问宿主或外部服务。

默认架构跟随当前 Node 架构，非 ARM64 默认生成 `amd64`。显式选择：

```bash
DIAN115_PLUGIN_GOARCH=arm64 npm run build:runtime
```

PowerShell：

```powershell
$env:DIAN115_PLUGIN_GOARCH = 'arm64'
npm run build:runtime
```

UI 输出到 `build/frontend/dist/assets`，runtime 输出到 `build/runtime/plugin.wasm`。构包脚本会再次检查 WASM magic、ABI 和完整性。

运行公开的 WASM package contract check：

```bash
node ../../conformance/project-check.mjs --manifest manifest.template.json --market market-entry.template.json --build-root build --require-build
```

该检查只使用公开 schema 和 Node.js 标准库，不读取主项目源码、数据库、配置或 Docker 构建上下文。WASM worker 的 Host Call、配额和取消语义由宿主集成测试验证。

## 首次本地签名

本地开发可生成一次 Ed25519 私钥：

```bash
npm run package -- --generate-key
```

它在本目录生成被 `.gitignore` 排除的 `developer-ed25519-private.pem`。之后直接：

```bash
npm run package
```

正式 CI 不应生成新密钥。把固定发布私钥作为 secret 文件注入，并设置：

```bash
DIAN115_PLUGIN_SIGNING_KEY=/secure/path/publisher-ed25519-private.pem npm run package
```

PowerShell：

```powershell
$env:DIAN115_PLUGIN_SIGNING_KEY = 'D:\secure\publisher-ed25519-private.pem'
npm run package
```

输出（示例模板的 URL 是占位地址；本插件包不自动上传任何仓库）：

```text
releases/example.complete-plugin-1.0.0.d115p
releases/market-entry.generated.json
```

脚本把公钥原始 32 字节的 SHA-256 编为 key ID，替换 Manifest 模板中的占位符，然后生成按 UTF-8 路径排序的完整性清单。签名原文严格为 domain、NUL、JCS Manifest、NUL、JCS integrity。私钥不会进入包。

## 发布前修改

至少修改：

1. `manifest.template.json` 中的 ID、名称、描述、版本、发布者、兼容范围、主页和仓库；
2. `market-entry.template.json` 中的包 URL；本地开发可使用 `https://example.invalid/...` 占位符，管理员也可以直接从插件中心导入 `.d115p`；
3. `vite.config.ts` 的 Federation name；
4. `runtime/main.go` 的 action/job/event 业务；
5. `src/AppPage.vue` 的界面；
6. Manifest 中准确的 Host API 和网络路由偏好。

如果删除 `create-watch` action，也应删除 `/api/plugin-runtime/watches` 权限和 `files.changed` event。如果新增 Host API，先确认它存在于 `../../openapi-v1.yaml` 的 Host API 目录。Host Storage 使用 `/api/plugin-runtime/storage/:key`，写入时带 `Idempotency-Key`，并在并发更新时使用响应的 `ETag` 发送 `If-Match`。

## 样例运行时说明

runtime 保持一个并发读取循环。每个宿主请求单独处理，因此初始化和 invocation 内可以调用宿主 RPC。state 使用 `state-vN` 与匹配强 ETag；action 返回四种合法状态之一；job 只返回 `accepted/skipped`；Telegram event 返回严格的 `handled/reply`。

测试通知用 action invocation ID 派生 `Idempotency-Key`。目录监控同样使用稳定 key，topic 已在 Manifest events 中声明。`storage-demo` 展示 Host Storage 的 GET/PUT；`fetch-local` 接受 `http://127.0.0.1:8080/health` 或其他 HTTP/HTTPS 地址，由宿主网络 Broker 发出，宿主代理域名规则优先，非 HTTPS 不会被平台拦截。宿主消息解析仍然优先；只有未被宿主处理且命中 `/plugin_example` 或“完整插件示例”的消息才进入该 runtime。

Telegram 路由在 `runtime.initialize` 中注册，而不是安装时写入 Manifest。注册被拒绝时只记录错误，插件仍可安装和运行；命令或关键词冲突不会覆盖宿主或其他插件。注册成功后，宿主最多将 3 个命令和 3 个关键词交给该插件，宿主没有处理的消息才会进入 `telegram.message` event。

外部 OAuth 或详情页必须在用户点击回调中同步调用 `window.open('about:blank', ...)`，再把 action 返回的 URL 写入弹窗的 `location`。后台定时任务不能打开弹窗；浏览器拦截时应保留复制 URL 或粘贴 code 的备用流程。

## 不要复制的占位信息

`example.com`、示例插件 ID、发布者名称和市场 URL 都是占位符。不要把开发私钥或 `releases/` 提交到源码仓库。正式发布时必须使用长期稳定的发布者密钥和真实 HTTPS 包地址。

插件开发只依赖 `docs/plugin-platform/` 的公开契约；主项目源码不会作为 SDK、联调包或发布附件提供。公共发布边界见 [`../../publication-policy.md`](../../publication-policy.md)。
