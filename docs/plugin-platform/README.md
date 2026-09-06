# DIAN115 Plugin API v2

This directory is the complete public contract for third-party plugins. It is intentionally source-free: the main application's implementation is private and is never required for plugin development. The permanent publication boundary is defined in [publication-policy.md](publication-policy.md).
## Supported plugin shape

Every plugin is one signed `.d115p` ZIP containing both parts below:

- a statically linked Linux `process` runtime supervised by DIAN115 (legacy);
- a signed Vue 3 Module Federation page using the host-provided Vue 3, Naive UI, and `@lucide/vue` packages;
- a WASM reactor runtime (`dian115:wasm@1`) executed by the embedded container runtime. Native process packages remain supported only for migration.

The UI is mandatory. Packages without `ui.mode=federation`, a signed Federation entry, and a valid WASM or legacy process runtime are rejected. There is no remote runtime, extra plugin container, alternate UI format, or UI fallback protocol.

The Federation document receives a full-width, zero-margin `html/body/#plugin-sandbox-root` baseline with `border-box` sizing. Keep the plugin root fluid (`width: 100%; max-width: 100%; min-width: 0`); do not rely on preview-only global CSS or a fixed body width. A desktop browser may still have a narrow plugin viewport while the host sidebar is open, so responsive layouts must wrap or switch to one column around 900-1000px.

WASM is executed by the main service inside the current Docker container without inherited host descriptors, sockets, secrets, or preopened host paths. Host files, watches, HTTP requests and DIAN115 business operations continue through `host.call`. HTTP targets may be internet, LAN, host, container, loopback, or other locally reachable services.

## Authoritative files

Read these files in order:

1. [Developer guide](developer-guide.md): end-to-end workflow and capability overview.
2. [Package format v1](package-format-v1.md): Manifest, ZIP, integrity, signature, market index, installation and update rules.
3. [WASM runtime v1](wasm-runtime-v1.md): reactor ABI, broker imports, quotas, Telegram events and lifecycle. [Process runtime v1](process-runtime-v1.md) documents the legacy compatibility path.
4. [Host Call v2](host-call-v2.md): local Host APIs, external HTTP/HTTPS, local services, proxy precedence, credentials, limits and errors.
5. [Vue Federation UI v1](ui-federation-v1.md): build contract, component props, bridge API, trusted same-origin behavior and every stable theme variable.
6. [OpenAPI](openapi-v1.yaml): exact request and response schemas for every approved local Host API.
7. [Black-box conformance](conformance/README.md): runtime smoke testing and public-surface checks without main-project source.

Machine-readable schemas:

- [manifest.schema.json](manifest.schema.json)
- [integrity.schema.json](integrity.schema.json)
- [signature.schema.json](signature.schema.json)
- [market index schema](market-index.schema.json)

The complete sample is in [`examples/complete-plugin`](examples/complete-plugin/README.md). It contains a Go WASM reactor runtime, a Vue page, a Manifest template, packaging/signing code, and a market entry template.

## Compatibility and source of truth

`compatibility.dian115` is a SemVer range selected by the plugin publisher. `compatibility.plugin_api` must target Plugin API v2. The host still checks the signed package, market disclosure, platform, ELF architecture, UI and permissions at installation time.

For local Host APIs, the runtime catalog returned by `GET /api/plugin-center/v1/host-apis` and the `x-dian115-host-apis.entries` section in `openapi-v1.yaml` are the public compatibility contract. A host release must keep those two public lists identical; plugin authors do not need access to the private implementation. The black-box conformance materials describe how to validate a plugin against this contract.

## Security summary

- Install only packages signed by a publisher you trust. A native process remains publisher code even inside the host sandbox.
- The mandatory Vue page is trusted same-origin publisher code. It is not placed in an iframe sandbox or an extra CSP sandbox and may use browser storage, images, popups and ordinary browser requests. Administrators must treat installing a plugin as trusting both its signed UI and runtime; backend authorization remains authoritative for Host APIs.
- The package limit is 32 MiB compressed, 128 MiB expanded, 1024 ZIP members, and 32 MiB per member.
- WASM plugins have no inherited file descriptors, sockets, credentials, environment secrets or preopened host directories. The embedded interpreter enforces module memory and context time limits; network, storage, notifications, watches and DIAN115 operations are brokered Host API calls. Native process packages use the legacy Linux seccomp/chroot path and require process-risk consent.
- Legacy process packages are validated as static ELF before the seccomp filter. WASM packages do not start plugin executables or helper processes.
- `DIAN115_PLUGIN_DATA=/data`, `DIAN115_PLUGIN_PACKAGE=/package/...` and `TMPDIR=/tmp` are paths inside the plugin's private root. Use them for plugin-owned resources and persistent files. Use the approved file/watch APIs for host data; a host path is never exposed as a plugin-owned path.
- Brokered network access supports `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, and `DELETE` over HTTP and HTTPS. The host does not reject a target because it resolves to loopback, private, link-local, container, host or other non-public addresses.
- Host proxy-domain rules have higher priority than plugin routing preferences.
- Backend plugins can read host-configured Emby instances, aggregate statistics, libraries and safe media metadata through five explicit read-only Host APIs. Emby addresses, API Keys, paths, media sources, users, sessions, devices, logs and mutations remain private.
- Telegram registrations are runtime operations, not install-time declarations. Each plugin can register at most 3 commands and 3 keywords. Conflicts are rejected at registration and do not fail installation.
- Host message parsing always runs before plugin Telegram matching.
- File APIs validate the submitted path, normalized path, resolved symbolic-link target, and saved watch source. Linux system directories and `/config` remain protected.

## Local import

Administrators can import a plugin package directly from the Plugin Center's
"Repositories & development" tab. The flow is deliberately the same trust
boundary as a market install:

1. Select a `.d115p` file. The host stores it in a private, short-lived staging directory and returns a review token; the browser never receives a server filesystem path.
2. The host validates ZIP limits, `manifest.json`, `integrity.json`, Ed25519 signature, the declared runtime (WASM ABI or legacy static ELF), Federation UI, and permissions before showing the review dialog.
3. After the administrator accepts the displayed permissions and process risk, the token is submitted to install. The host re-checks the token, expiry, SHA-256, consent digest, and package before starting the normal asynchronous install operation.

The token expires after 15 minutes, is single-use, and is removed after install, cancellation, failure, or expiry. Local import does not create a market repository entry and does not bypass signature, integrity, UI, runtime, filesystem, network, Telegram, or permission checks. Installed records show `本地导入` as their source.

## Public-source boundary

The GitHub repository publishes plugin contracts and third-party examples only. Never publish the main project's `cmd/`, `internal/`, `frontend/src/`, build files, deployment files, generated release packages, or private signing keys. Run the public-surface check before every public commit; CI rejects violations. See [publication-policy.md](publication-policy.md).
