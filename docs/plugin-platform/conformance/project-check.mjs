import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const valueOf = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const fail = (message) => {
  process.stderr.write(`Plugin project check: FAIL: ${message}\n`)
  process.exit(1)
}
const readJSON = (path, label) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`${label} is not valid JSON: ${error?.message || error}`)
  }
}
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value)
const requireText = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label} is missing or too long`)
}
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])
const manifestPath = resolve(valueOf('--manifest', 'manifest.template.json'))
const marketPath = resolve(valueOf('--market', 'market-entry.template.json'))
const buildRoot = resolve(valueOf('--build-root', 'build'))
const requireBuild = args.includes('--require-build')
const conformanceRoot = dirname(fileURLToPath(import.meta.url))
const openAPIPath = resolve(conformanceRoot, '..', 'openapi-v1.yaml')

if (!existsSync(manifestPath)) fail(`manifest not found: ${manifestPath}`)
if (!existsSync(marketPath)) fail(`market entry not found: ${marketPath}`)
const manifest = readJSON(manifestPath, 'manifest')
const market = readJSON(marketPath, 'market entry')

if (manifest.schema_version !== 1) fail('manifest.schema_version must be 1')
if (!/^[a-z0-9](?:[a-z0-9.-]{1,126}[a-z0-9])$/.test(manifest.id || '') || String(manifest.id).includes('..')) fail('manifest.id is invalid')
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version || '')) fail('manifest.version must be SemVer')
requireText(manifest.name, 'manifest.name', 80)
requireText(manifest.description, 'manifest.description', 500)
requireText(manifest.default_locale, 'manifest.default_locale', 32)
requireText(manifest.publisher?.name, 'manifest.publisher.name', 100)
requireText(manifest.publisher?.key_id, 'manifest.publisher.key_id', 128)
requireText(manifest.compatibility?.dian115, 'manifest.compatibility.dian115', 80)
requireText(manifest.compatibility?.plugin_api, 'manifest.compatibility.plugin_api', 40)

if (!['process','wasm'].includes(manifest.runtime?.kind) || !['dian115:process@1','dian115:wasm@1'].includes(manifest.runtime?.protocol)) fail('runtime must be process or wasm with a supported protocol')
requireText(manifest.runtime?.entry, 'manifest.runtime.entry', 240)
if (manifest.ui?.mode !== 'federation') fail('ui.mode must be federation')
for (const field of ['entry', 'assets_root', 'module']) requireText(manifest.ui?.federation?.[field], `manifest.ui.federation.${field}`, 240)
if (!manifest.ui.federation.entry.startsWith(`${manifest.ui.federation.assets_root}/`)) fail('Federation entry must be below assets_root')

if (!isObject(manifest.permissions)) fail('manifest.permissions must be an object')
if ('capabilities' in manifest || 'account_access' in manifest || 'capabilities' in manifest.permissions || 'account_access' in manifest.permissions) {
  fail('legacy capabilities/account_access fields are not supported')
}
for (const [index, permission] of (manifest.permissions.apis || []).entries()) {
  if (!methods.has(permission?.method) || !String(permission?.path || '').startsWith('/api/')) fail(`permissions.apis[${index}] has an invalid method/path`)
  requireText(permission?.reason, `permissions.apis[${index}].reason`, 240)
}

if (!existsSync(openAPIPath)) fail(`public OpenAPI contract not found: ${openAPIPath}`)
const openAPI = readFileSync(openAPIPath, 'utf8')
if (new RegExp(`${['Direct', 'Response'].join('')}|与对应主项目接口一致`).test(openAPI)) fail('public OpenAPI still contains an opaque response placeholder')
const catalog = new Set()
const catalogPattern = /^    - method: (GET|HEAD|POST|PUT|PATCH|DELETE)\r?\n      path: (\/api\/\S+)$/gm
for (const match of openAPI.matchAll(catalogPattern)) catalog.add(`${match[1]} ${match[2]}`)
if (!catalog.size) fail('public OpenAPI Host API catalog could not be read')
for (const [index, permission] of (manifest.permissions.apis || []).entries()) {
  const key = `${permission.method} ${permission.path}`
  if (!catalog.has(key)) fail(`permissions.apis[${index}] is not in the public Host API catalog: ${key}`)
}
for (const [index, permission] of (manifest.permissions.network || []).entries()) {
  let url
  try { url = new URL(permission?.origin) } catch { fail(`permissions.network[${index}].origin is invalid`) }
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) fail(`permissions.network[${index}].origin must be an HTTP(S) origin`)
  const declaredMethods = permission.methods === undefined ? ['GET'] : permission.methods
  if (!Array.isArray(declaredMethods) || !declaredMethods.length || declaredMethods.some((method) => !methods.has(method))) fail(`permissions.network[${index}].methods is invalid`)
  if (!['system', 'direct', 'required'].includes(permission.proxy_mode || 'system')) fail(`permissions.network[${index}].proxy_mode is invalid`)
  requireText(permission?.reason, `permissions.network[${index}].reason`, 240)
}
if ((manifest.events || []).length > 64 || (manifest.jobs || []).length > 32) fail('manifest events/jobs exceed limits')

if (market.id !== manifest.id || market.version !== manifest.version) fail('market id/version do not match manifest')
const expectedTrust = manifest.runtime.kind === 'wasm' ? 'wasm-sandbox' : 'isolated-process'
if (JSON.stringify(market.runtime) !== JSON.stringify({ kind: manifest.runtime.kind, protocol: manifest.runtime.protocol, autostart: true, trust_level: expectedTrust })) fail('market runtime disclosure must match the manifest and include autostart: true')
if (JSON.stringify(market.permissions || {}) !== JSON.stringify(manifest.permissions || {})) fail('market permissions do not exactly match manifest')
if ('capabilities' in market || 'account_access' in market) fail('market entry uses removed permission fields')

const packageJSONPath = resolve(dirname(manifestPath), 'package.json')
if (existsSync(packageJSONPath)) {
  const packageJSON = readJSON(packageJSONPath, 'package.json')
  for (const dependency of ['vue', 'naive-ui', '@lucide/vue']) {
    if (!packageJSON.peerDependencies?.[dependency] || !packageJSON.devDependencies?.[dependency]) fail(`${dependency} must be a peerDependency and devDependency`)
  }
}

const viteConfigPath = resolve(dirname(manifestPath), 'vite.config.ts')
if (existsSync(viteConfigPath)) {
  const viteConfig = readFileSync(viteConfigPath, 'utf8')
  for (const dependency of ['vue', 'naive-ui', '@lucide/vue']) {
    const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const declaration = new RegExp(`["']?${escaped}["']?\\s*:\\s*\\{[^}]*singleton\\s*:\\s*true[^}]*generate\\s*:\\s*false`, 's')
    if (!declaration.test(viteConfig)) fail(`vite.config.ts must share ${dependency} as singleton with generate: false`)
  }
}

const runtimePath = resolve(buildRoot, manifest.runtime.entry)
const federationPath = resolve(buildRoot, manifest.ui.federation.entry)
if (requireBuild || existsSync(buildRoot)) {
  if (!existsSync(runtimePath) || !statSync(runtimePath).isFile()) fail(`runtime build is missing: ${runtimePath}`)
  const elf = readFileSync(runtimePath)
  if (manifest.runtime.kind === 'wasm') {
    if (elf.length < 8 || !elf.subarray(0, 8).equals(Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))) fail('runtime build is not a valid WebAssembly module')
  } else {
    if (elf.length < 64 || elf[0] !== 0x7f || elf.subarray(1, 4).toString('ascii') !== 'ELF') fail('runtime build is not an ELF executable')
    if (elf[4] !== 2 || elf[5] !== 1) fail('runtime ELF must be 64-bit little-endian')
    const machine = elf.readUInt16LE(18)
    if (![0x3e, 0xb7].includes(machine)) fail(`runtime ELF architecture ${machine} is not amd64 or arm64`)
    const phoff = Number(elf.readBigUInt64LE(32))
    const phentsize = elf.readUInt16LE(54)
    const phnum = elf.readUInt16LE(56)
    for (let index = 0; index < phnum; index += 1) {
      if (elf.readUInt32LE(phoff + index * phentsize) === 3) fail('runtime ELF is dynamically linked (PT_INTERP present)')
    }
  }
  if (!existsSync(federationPath) || !statSync(federationPath).isFile()) fail(`Federation entry is missing: ${federationPath}`)
  const remoteEntry = readFileSync(federationPath, 'utf8')
  if (!remoteEntry.includes('AppPage') && manifest.ui.federation.module === './AppPage') fail('Federation entry does not expose ./AppPage')
}

process.stdout.write(`Plugin project check: PASS (${manifest.id}@${manifest.version})\n`)
