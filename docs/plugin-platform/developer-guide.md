# DIAN115 plugin developer guide

This guide takes a plugin from source to an installable package. It is self-contained and does not require the main project's source code. Normative details are linked at each step; use the [black-box conformance tools](conformance/README.md) for local runtime validation.

## 1. Architecture

A plugin has one supervised local runtime (WASM recommended; legacy Linux process remains supported) and one mandatory Vue page:

```text
Vue Federation page (trusted same-origin iframe)
  -> getState / invokeAction
  -> DIAN115 runtime bridge
  -> runtime.invoke over framed JSON-RPC
  -> plugin WASM reactor (or legacy process)
  -> host.call
  -> approved DIAN115 handler or host HTTP/HTTPS Broker
```

The page is signed publisher code loaded in an iframe with a host bridge. It can use normal browser features, including images, `localStorage`, `sessionStorage`, IndexedDB, popups and ordinary `fetch`/XHR requests. It can also access same-origin browser state, so installing a plugin means trusting its publisher. The page is never given raw Bot, 115, TMDB, proxy or CD2 credentials by the plugin bridge, and it has no direct filesystem access. Privileged and background work should stay in the local runtime so it remains covered by plugin permissions, audit, proxy and retry behavior.

The local runtime is started directly by the main service in the current Docker container. It must not listen on a port, create another plugin container, daemonize, or require a remote callback. WASM modules do not receive a filesystem mount or start helper processes. Legacy process packages use the private `/config/package/<plugin-id>/` root and inherit the seccomp/no-new-privileges policy. Host files, watches, network, Telegram and notifications remain mediated by approved Host APIs.

To start a helper shipped in the package, execute it below the path in `DIAN115_PLUGIN_PACKAGE`, for example `$DIAN115_PLUGIN_PACKAGE/runtime/helper`. It must be a static Linux ELF and remain inside the package directory. Helpers inherit the same private root and are terminated with the main plugin process group.

## 2. Start from the complete sample

Copy [`examples/complete-plugin`](examples/complete-plugin/README.md), then change:

- the plugin ID, name, version, publisher and compatibility range in `manifest.template.json`;
- the Go runtime behavior in `runtime/main.go`;
- the Vue page in `src/AppPage.vue`;
- the exact local APIs in `permissions.apis`;
- optional per-origin proxy preferences in `permissions.network`;
- declared event topics and scheduled jobs.

Build the UI with the same framework packages as the host:

```text
vue
naive-ui
@lucide/vue
```

They must be Federation singletons with `generate: false`. Do not bundle a private copy. The package must expose the module named by `ui.federation.module`, normally `./AppPage`.

For the recommended WASM runtime, build a reactor module:

```bash
CGO_ENABLED=0 GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -trimpath -ldflags="-s -w" -o build/runtime/plugin.wasm ./runtime
```

WASM is architecture independent. Legacy process packages use `GOARCH=amd64` or `arm64`; a ZIP with an ELF `PT_INTERP` segment is rejected.

## 3. Define the signed Manifest

The UI and runtime are both required:

```json
{
  "schema_version": 1,
  "id": "example.media-helper",
  "name": "Media helper",
  "version": "1.0.0",
  "description": "Queries media and creates host tasks.",
  "default_locale": "en-US",
  "publisher": {
    "name": "Example publisher",
    "key_id": "ed25519:REPLACED_BY_PACKAGER"
  },
  "compatibility": {
    "dian115": ">=3.8.51 <4.0.0",
    "plugin_api": "^2.0"
  },
  "runtime": {
    "kind": "wasm",
    "entry": "runtime/plugin.wasm",
    "protocol": "dian115:wasm@1"
  },
  "permissions": {
    "apis": [
      {
        "method": "GET",
        "path": "/api/tmdb/search",
        "reason": "Search for media selected in the plugin page"
      }
    ],
    "network": [
      {
        "origin": "http://127.0.0.1:8080",
        "methods": ["GET", "POST"],
        "proxy_mode": "system",
        "reason": "Call a local companion service"
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
  ]
}
```

Only declare local APIs the process actually calls. Every `(method, path template)` must appear in [OpenAPI](openapi-v1.yaml). Paths are exact; declaring one parameter route does not authorize a static sibling. Write methods require an `Idempotency-Key` between 16 and 128 printable ASCII characters unless the endpoint's OpenAPI operation says it owns an equivalent idempotency mechanism.

`permissions.network` is not a website allowlist. A plugin can use the Broker for any HTTP/HTTPS origin, including localhost, loopback, container, host and LAN services. These declarations record a routing preference for a specific origin and method:

- `system`: use the host proxy-domain decision;
- `direct`: use a direct route only when no host proxy-domain rule matches;
- `required`: require a configured proxy even when no host rule matches.

The host rule always wins. An undeclared origin/method uses `system`.

See [Package format v1](package-format-v1.md) for every field and cross-file rule.

## 4. Implement the runtime protocol\n\nWASM plugins use the reactor ABI and broker imports described in [WASM runtime v1](wasm-runtime-v1.md). Legacy process plugins use the framed protocol below.

A legacy process reads and writes `Content-Length` framed JSON-RPC 2.0 on stdin/stdout. The channel is full duplex: while handling `runtime.invoke`, the process may send `host.call`, `host.log`, or a Telegram registration and wait for the response. Keep reading stdout responses concurrently or both sides can deadlock.

The host calls:

- `runtime.initialize` once after every process start;
- `runtime.invoke` with `op=state`, `action`, `job`, or `event`;
- `runtime.shutdown` before an intentional stop.

The runtime can call:

- `host.call` for approved local APIs or external HTTP/HTTPS services;
- `host.log` for structured installation-scoped logs;
- `host.ui.invalidate` to request a state refresh;
- `host.telegram.register`, `host.telegram.list`, and `host.telegram.unregister`.

The precise frames, payloads, response status enums, ETag requirements, retries and error codes are in [Process runtime v1](process-runtime-v1.md). Do not return an arbitrary JSON object for `state`, `action`, or `job`; the host validates each result.

### Plugin-owned files

Use the paths supplied by the host; never hard-code `/config/package` because that path exists only outside the private root:

```go
packageDir := os.Getenv("DIAN115_PLUGIN_PACKAGE") // /package/<current-release>
dataDir := os.Getenv("DIAN115_PLUGIN_DATA")       // /data
tempDir := os.Getenv("TMPDIR")                   // /tmp

template, err := os.ReadFile(filepath.Join(packageDir, "assets", "template.json"))
if err != nil { /* report initialization failure */ }

if err := os.MkdirAll(filepath.Join(dataDir, "cache"), 0o700); err != nil { /* handle */ }
if err := os.WriteFile(filepath.Join(dataDir, "cache", "index.json"), payload, 0o600); err != nil { /* handle */ }
```

The current release under `/package` is host-managed and read-only. `/data` persists across process restarts, container restarts and plugin updates. `/tmp` is private to the plugin but must not be treated as durable state. Absolute paths such as `/config`, `/etc`, `/proc`, media mounts and paths copied from another plugin do not resolve outside the private root. To access an administrator-approved host path, call the corresponding file Host API; do not try to translate it into a local path.

Read `DIAN115_PLUGIN_FILESYSTEM` during initialization. `private-root` is the normal mode. `host-api-only` means the deployment removed the Docker default chroot capability; in that mode all pathname filesystem syscalls are intentionally denied and plugin-owned files must also be stored through Host API storage.

## 5. Use Host Call

Local request:

```json
{
  "method": "GET",
  "path": "/api/tmdb/search?q=Dune&page=1",
  "headers": {"accept": "application/json"},
  "body_base64": ""
}
```

External request:

```json
{
  "method": "POST",
  "path": "http://127.0.0.1:8080/v1/items",
  "headers": {"content-type": "application/json"},
  "body_base64": "eyJuYW1lIjoiZXhhbXBsZSJ9"
}
```

Result:

```json
{
  "status": 200,
  "headers": {"content-type": ["application/json"]},
  "body_base64": "eyJvayI6dHJ1ZX0"
}
```

`body_base64` accepts padded or unpadded standard Base64 on requests. Responses use unpadded standard Base64. A process JSON-RPC frame may be up to 16 MiB, and the decoded Host Call request or response body may be up to 8 MiB. Use endpoint pagination even though normal payloads are no longer constrained to 256 KiB.

External access supports only `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, and `DELETE`. `OPTIONS`, `CONNECT`, and `TRACE` are not part of the contract. HTTP/HTTPS transport, DNS, redirects, target resolution and proxy selection are performed by the host. Details and HTTP security warnings are in [Host Call v2](host-call-v2.md).

### Read host-configured Emby data

The backend process can read Emby without receiving the server URL or API Key. Declare only the operations it uses:

```json
{
  "apis": [
    {"method":"GET","path":"/api/plugin-host/emby/instances","reason":"Let the user select an Emby instance"},
    {"method":"GET","path":"/api/plugin-host/emby/libraries","reason":"List available media libraries"},
    {"method":"GET","path":"/api/plugin-host/emby/items","reason":"Search safe media metadata"},
    {"method":"GET","path":"/api/plugin-host/emby/items/:id","reason":"Read one selected media item"}
  ]
}
```

At runtime, call `GET /api/plugin-host/emby/instances`, let the user choose an `id`, and pass it as `proxy_id` to the other calls. When only one instance exists or the host has a valid default, `proxy_id` may be omitted. An instance with `id: 0` represents legacy single-instance configuration and must be used by omitting `proxy_id`, not by sending zero.

```json
{"method":"GET","path":"/api/plugin-host/emby/items?proxy_id=2&type=Movie&q=Dune&limit=20&offset=0"}
```

The item result includes IDs, titles, overview, year, rating, genres, provider IDs, series/episode numbers, dates and image-presence hints. It intentionally excludes the Emby URL, API Key, filesystem paths, media sources, user data, sessions, devices and logs. There are no Emby mutations in the plugin catalog. See the five `PluginEmby*` operations and exact schemas in [OpenAPI](openapi-v1.yaml), and use `offset`/`limit` pagination up to 50 items per call.

## 6. Telegram

Send an active notification through the approved local API `POST /api/notifications/plugin`. The host uses its Bot configuration and recipient policy; the plugin cannot select an arbitrary chat ID or obtain the Bot Token.

Register incoming routes at runtime, normally while handling `runtime.initialize`:

```json
{
  "jsonrpc": "2.0",
  "id": "p:telegram:1",
  "method": "host.telegram.register",
  "params": {
    "commands": [
      {"command": "media_helper", "description": "Open media helper"}
    ],
    "keywords": [
      {"keyword": "media helper", "match": "prefix"}
    ]
  }
}
```

Each installation may register at most 3 commands and 3 keywords. Registration atomically replaces the installation's previous set. Reserved host commands, conflicts with another plugin, or the global 64-plugin-command limit return JSON-RPC `-32003`; the previous registration remains active and installation is not affected.

Host parsing always runs first. Only a message the host did not handle and that matches a registered route is delivered as `event` topic `telegram.message`. Unmatched messages never reach plugins.

## 7. Directory watches

Declare the event topic in `events`, then approve the exact watch APIs your runtime uses. Creating a host path watch:

```json
{
  "source": {"kind": "host_path", "path": "/media/incoming"},
  "event_topic": "files.changed",
  "recursive": true,
  "interval_seconds": 30
}
```

Creating a 115 watch:

```json
{
  "source": {
    "kind": "115",
    "account": {"mode": "backup", "id": 12},
    "cid": "0"
  },
  "event_topic": "files.changed",
  "recursive": false,
  "interval_seconds": 60
}
```

The interval is 5 to 86400 seconds and each plugin can have at most 32 watches. A `backup_pool` selector is resolved once and persisted as one concrete account. The first scan creates a baseline and emits no mass-added event. Later deliveries preserve a stable event ID for retries. Full request/response schemas are in [OpenAPI](openapi-v1.yaml).

## 8. Build the UI

The remote Vue component receives:

- `api` and `hostApi`: the same frozen bridge;
- `installationId`, `pluginId`;
- `runtime`, `runtimeState`;
- `navKey="main"`;
- `themeContract="dian115-theme-v1"`.

The bridge provides only `getState(view)`, `invokeAction(action, input)`, and `refresh()`. The component may emit `action`, `refresh`, or `close`. Use Naive UI for controls and `@lucide/vue` for icons. Style with the stable `--dian-*` variables so light/dark and configured host themes update without remounting.

The page runs as trusted same-origin publisher code without an iframe `sandbox` attribute or an extra UI CSP. It may render packaged, HTTP, HTTPS, `data:` and `blob:` images; use browser storage; open HTTP/HTTPS pages; and make ordinary browser requests subject to the browser's normal CORS, mixed-content and popup rules. Values sent through the bridge must still be JSON-serializable. See [Vue Federation UI v1](ui-federation-v1.md) for the exact TypeScript contract, trust model, theme table and popup sequence.

The host resets the Federation document to a full-width, zero-margin `html/body/#plugin-sandbox-root` baseline and applies `border-box` sizing. Do not add a fixed body `max-width` or minimum width; make the component root `width: 100%; max-width: 100%; min-width: 0`. A desktop browser can still provide a narrow iframe when the host sidebar is open, so switch multi-column layouts to one column around 900-1000px and allow toolbars to wrap. Global CSS imported only by a standalone preview entry is not loaded for the Federation component.

## 9. Package, sign and publish

The package root must contain:

```text
manifest.json
frontend/icon.svg                 # optional icon, UI itself is mandatory
frontend/dist/assets/...          # mandatory signed Federation assets
runtime/plugin.wasm                # recommended WASM reactor (or runtime/plugin for legacy process)
integrity.json
signature.json
```

`integrity.json` lists every ZIP member except itself and `signature.json`, sorted by UTF-8 path bytes. Sign this exact byte sequence with Ed25519:

```text
UTF8("DIAN115-PLUGIN-PACKAGE-V1")
0x00
RFC8785-JCS(manifest.json)
0x00
RFC8785-JCS(integrity.json)
```

Publish the `.d115p` on HTTPS and add one entry to a market `index.json`. The market runtime and permissions disclosure must exactly match the signed Manifest; the market SHA-256 must match the package bytes. The complete sample packager generates the key ID, integrity file, signature file, ZIP permissions, package SHA-256, and market entry values.

## 10. Local import behavior

An administrator may also select the finished `.d115p` from the Plugin Center. This is an installation path, not a second package format: the host performs the same archive, manifest, integrity, signature, runtime, Federation UI, and permission checks (including static ELF checks for legacy process packages) before presenting the consent dialog. The package must therefore be complete and signed even when it is not published in a market index.

The inspect endpoint is `POST /api/plugin-center/v1/imports/inspect` with a multipart field named `package`. A successful response contains `import_token`, `expires_at`, `file_name`, and the same plugin permission snapshot shown by a market install. The administrator then submits `POST /api/plugin-center/v1/imports/{token}/install` with `permissions_accepted: true`, the returned `consent_digest`, and `process_risk_accepted: true` for process plugins. The host revalidates every value and queues the normal `plugin_install` operation.

Import tokens are private, single-use, and expire after 15 minutes. The host deletes the staged file after the operation is accepted or rejected. No local package is uploaded to a repository, and the installed source is recorded as `本地导入`.

## 11. Release checklist

- UI is present, exposes the declared module, uses host singletons, and contains no unsigned remote scripts.
- UI bridge props, action inputs and results are JSON-serializable; no functions, DOM nodes, cyclic objects, `BigInt` or Vue proxy objects cross the bridge.
- Every UI asset and runtime file is covered by `integrity.json`.
- WASM runtime entry has the WASM magic and reactor exports; legacy process entry is a static ELF for the target architecture and has executable ZIP mode bits.
- Runtime handles full-duplex JSON-RPC and every required response contract.
- Every local Host API is declared exactly and appears in OpenAPI.
- Write calls use stable idempotency keys.
- Network calls use host-brokered HTTP/HTTPS, support local services, and tolerate proxy use and redirect revalidation.
- Filesystem requests never depend on Linux system paths or `/config`.
- Telegram registration stays within 3 commands and 3 keywords and handles conflicts.
- The publisher key is stable across upgrades and the private key is not shipped.
- Market metadata exactly matches the signed package.
- `node docs/plugin-platform/conformance/verify-public-surface.mjs` passes before public publication; no main-project source is included.
