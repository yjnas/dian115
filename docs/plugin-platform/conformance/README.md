# 插件黑盒联调工具

这里的工具只依赖公开的插件运行时协议，不导入、不编译、也不读取 DIAN115 主项目源码。第三方作者可以用它在目标 Linux 容器或 CI 中验证 legacy process runtime 的基本生命周期；WASM runtime 则按 [WASM runtime v1](../wasm-runtime-v1.md) 的 reactor ABI 由宿主 worker harness 验证。

## 验证范围

`project-check.mjs` 会在构包前检查 Manifest、市场条目、权限格式、三项前端 singleton 依赖、Federation 入口，以及 WASM magic（或 legacy process 的静态 Linux ELF）。它只使用 Node.js 标准库：

```bash
node docs/plugin-platform/conformance/project-check.mjs \
  --manifest manifest.template.json \
  --market market-entry.template.json \
  --build-root build \
  --require-build
```

`openapi-check.mjs` 会核对公开 Host API 目录与全部 OpenAPI path operation，检查每项接口都有明确成功模型、400 错误体、写操作幂等键和可解析的组件引用：

```bash
node docs/plugin-platform/conformance/openapi-check.mjs
```

`runtime-smoke.mjs` 会：

1. 启动指定的 legacy process 静态 Linux ELF；
2. 发送 `runtime.initialize`，并处理插件在初始化期间发出的 `host.telegram.register`、`host.log` 和 `host.call`；
3. 发送完整 state 和带 ETag 的条件 state，校验两种响应；
4. 按参数调用 action，并可从 Manifest 调用首个 job 和 event；
5. 可校验初始化时的 Telegram 注册、Telegram event 和嵌套 Host Call；
6. 发送 `runtime.shutdown`，检查进程返回 JSON object 并正常退出。

它不会模拟主项目数据库、文件系统或管理员身份，也不会给插件额外权限。Host Call 的默认响应只用于让协议测试可以完成；业务接口仍必须在安装到实际宿主时按 OpenAPI 逐项声明和批准。

## 使用完整示例

在 `docs/plugin-platform/examples/complete-plugin/` 中（示例使用 WASM runtime；runtime-smoke 仅适用于 legacy process）：

```bash
npm ci
npm run build
npm run check
node ../../conformance/project-check.mjs --manifest manifest.template.json --market market-entry.template.json --build-root build --require-build
```

WASM 构建与 CPU 架构无关；legacy process 的 Linux ELF 联调必须在 WSL、Linux CI 或与宿主相同架构的容器中执行。

`runtime-smoke.mjs` 目前只驱动 legacy process 的 stdin/stdout 协议；WASM 插件应由宿主
worker harness 按 [WASM runtime v1](../wasm-runtime-v1.md) 执行同等调用。需要联调自有
legacy process 时，将静态 Linux ELF 放入构建目录后运行：

```bash
node ../../conformance/runtime-smoke.mjs --runtime build/runtime/plugin
```

## 联调自己的插件

```bash
node docs/plugin-platform/conformance/runtime-smoke.mjs --runtime ./build/runtime/plugin
```

上面的命令只适用于 `runtime.kind=process` 且入口为静态 Linux ELF 的包；WASM 入口
`runtime/plugin.wasm` 不应传给该工具。

可选参数：

```text
--timeout-ms <整数>       每个协议阶段的超时，默认 5000
--verbose                 输出收到的 JSON-RPC method 名
--manifest <JSON>         使用真实插件 ID/version，并为扩展测试读取 jobs/events
--exercise-manifest       调用 Manifest 中首个 job 和 event
--action <ID>             调用一个插件 action
--action-input <JSON>     action input，默认 {}
--expect-host-call        要求测试过程中至少出现一次 host.call
--expect-telegram         要求 runtime 注册 TG 路由并校验一次 telegram.message
```

工具只要求 runtime 使用标准输入/输出上的 `Content-Length` JSON-RPC 2.0。不要向 stdout 写日志；调试信息写 stderr，并确保所有入站请求都能在处理嵌套 Host Call 时继续被读取。

## UI 联调

UI 使用宿主同一套 Vue 3、Naive UI 和 `@lucide/vue` singleton。示例的 `npm run dev` 提供本地 mock bridge，可验证组件 props、主题变量、图片、浏览器存储、弹窗和错误状态；正式包作为同源可信发布者代码加载，不附加 iframe sandbox 或额外 UI CSP。宿主会提供零外边距、全宽的 `html/body/#plugin-sandbox-root` 和 `border-box` 基线，插件不要依赖预览入口的固定 body 宽度。弹窗仍受浏览器用户手势规则约束，普通浏览器请求仍受 CORS 和混合内容规则约束。所有 bridge 值必须可由 `JSON.stringify`/`JSON.parse` 完整往返。

## 通过标准

- runtime smoke 命令退出码为 `0`；
- OpenAPI contract check 通过，Manifest 中的每项 Host API 也通过 `project-check.mjs` 的目录核对；
- WASM 入口包含标准 magic；legacy process 入口是目标架构的静态 ELF 且没有 `PT_INTERP`；
- `.d115p` 由示例 `scripts/package.mjs` 生成并能通过包格式、完整性和签名校验；
- UI 暴露 Manifest 中声明的 Federation module，且所有静态资源进入签名包；
- Host API、网络路由、Telegram 注册和文件操作都与公开文档一致。

黑盒联调通过不等于插件获得了未声明权限；最终安装仍由宿主重新校验签名、Manifest、权限、静态 ELF、UI 和运行时状态。
