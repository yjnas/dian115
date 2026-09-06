import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import yazl from 'yazl'

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
const manifestTemplatePath = join(root, 'manifest.template.json')
const marketTemplatePath = join(root, 'market-entry.template.json')
const buildRoot = join(root, 'build')
const runtimePath = join(buildRoot, 'runtime', 'plugin.wasm')
const uiAssetsRoot = join(buildRoot, 'frontend', 'dist', 'assets')
const iconPath = join(root, 'frontend', 'icon.svg')
const releasesRoot = join(root, 'releases')
const keyPath = resolve(process.env.DIAN115_PLUGIN_SIGNING_KEY || join(root, 'developer-ed25519-private.pem'))
const generateKey = process.argv.includes('--generate-key')

function sha256(value) {
  return createHash('sha256').update(value).digest()
}

function base64url(value) {
  return Buffer.from(value).toString('base64url')
}

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JCS does not allow non-finite numbers')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
  }
  throw new Error(`JCS does not support ${typeof value}`)
}

function parseJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function loadPrivateKey() {
  if (!existsSync(keyPath)) {
    if (!generateKey) {
      throw new Error(`Signing key not found: ${keyPath}\nRun npm run package -- --generate-key once for local development, or set DIAN115_PLUGIN_SIGNING_KEY.`)
    }
    const pair = generateKeyPairSync('ed25519')
    mkdirSync(dirname(keyPath), { recursive: true })
    writeFileSync(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    process.stdout.write(`Generated development signing key: ${keyPath}\n`)
  }
  return createPrivateKey(readFileSync(keyPath))
}

function rawPublicKey(privateKey) {
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  if (spki.length < 32) throw new Error('Invalid Ed25519 SPKI public key')
  return spki.subarray(spki.length - 32)
}

function packagePath(localPath, prefix) {
  const value = relative(prefix, localPath).split(sep).join('/')
  if (!value || value.startsWith('../') || value.includes('/../')) throw new Error(`Unsafe package path: ${localPath}`)
  return value
}

function walk(directory) {
  const result = []
  for (const name of readdirSync(directory).sort()) {
    const full = join(directory, name)
    const info = statSync(full)
    if (info.isDirectory()) result.push(...walk(full))
    else if (info.isFile()) result.push(full)
  }
  return result
}

function assertWASM(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))) throw new Error('runtime/plugin.wasm is not a valid WebAssembly module')
}

function zipPackage(outputPath, files) {
  return new Promise((resolvePromise, rejectPromise) => {
    const zip = new yazl.ZipFile()
    const output = createWriteStream(outputPath, { mode: 0o644 })
    output.on('close', resolvePromise)
    output.on('error', rejectPromise)
    zip.outputStream.on('error', rejectPromise)
    zip.outputStream.pipe(output)
    for (const file of files) {
      zip.addBuffer(file.data, file.path, { mode: file.executable ? 0o100755 : 0o100644, mtime: new Date(0) })
    }
    zip.end()
  })
}

if (!existsSync(runtimePath)) throw new Error('Missing build/runtime/plugin.wasm; run npm run build first')
if (!existsSync(uiAssetsRoot)) throw new Error('Missing build/frontend/dist/assets; run npm run build first')

const privateKey = loadPrivateKey()
const publicKey = rawPublicKey(privateKey)
const keyID = `ed25519:${base64url(sha256(publicKey))}`
const manifest = parseJSON(manifestTemplatePath)
manifest.publisher.key_id = keyID
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

const runtimeBytes = readFileSync(runtimePath)
assertWASM(runtimeBytes)
const files = [
  { path: 'manifest.json', data: manifestBytes, executable: false },
  { path: 'frontend/icon.svg', data: readFileSync(iconPath), executable: false },
  { path: 'runtime/plugin.wasm', data: runtimeBytes, executable: false },
]

for (const localPath of walk(uiAssetsRoot)) {
  const path = `frontend/dist/assets/${packagePath(localPath, uiAssetsRoot)}`
  files.push({ path, data: readFileSync(localPath), executable: false })
}

files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
const integrity = {
  schema_version: 1,
  algorithm: 'sha256',
  files: files.map((file) => ({
    path: file.path,
    size: file.data.length,
    sha256: sha256(file.data).toString('hex'),
  })),
}
const integrityBytes = Buffer.from(`${JSON.stringify(integrity, null, 2)}\n`, 'utf8')
const signedMessage = Buffer.concat([
  Buffer.from('DIAN115-PLUGIN-PACKAGE-V1\0', 'utf8'),
  Buffer.from(canonicalize(manifest), 'utf8'),
  Buffer.from([0]),
  Buffer.from(canonicalize(integrity), 'utf8'),
])
const signature = {
  schema_version: 1,
  algorithm: 'Ed25519',
  canonicalization: 'RFC8785-JCS',
  domain: 'DIAN115-PLUGIN-PACKAGE-V1',
  key_id: keyID,
  public_key: base64url(publicKey),
  signature: base64url(sign(null, signedMessage, privateKey)),
}
const signatureBytes = Buffer.from(`${JSON.stringify(signature, null, 2)}\n`, 'utf8')

files.push({ path: 'integrity.json', data: integrityBytes, executable: false })
files.push({ path: 'signature.json', data: signatureBytes, executable: false })
files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))

mkdirSync(releasesRoot, { recursive: true })
const packageName = `${manifest.id}-${manifest.version}.d115p`
const outputPath = join(releasesRoot, packageName)
await zipPackage(outputPath, files)
const packageDigest = sha256(readFileSync(outputPath)).toString('hex')

const marketEntry = parseJSON(marketTemplatePath)
marketEntry.id = manifest.id
marketEntry.name = manifest.name
marketEntry.version = manifest.version
marketEntry.description = manifest.description
marketEntry.author = manifest.publisher.name
marketEntry.homepage = manifest.homepage
marketEntry.sha256 = packageDigest
marketEntry.runtime = {
  kind: manifest.runtime.kind,
  protocol: manifest.runtime.protocol,
  autostart: true,
  trust_level: manifest.runtime.kind === 'wasm' ? 'wasm-sandbox' : 'isolated-process',
}
marketEntry.permissions = manifest.permissions
marketEntry.tags = manifest.tags || []
writeFileSync(join(releasesRoot, 'market-entry.generated.json'), `${JSON.stringify(marketEntry, null, 2)}\n`)

process.stdout.write(`Package: ${outputPath}\n`)
process.stdout.write(`SHA-256: ${packageDigest}\n`)
process.stdout.write(`Publisher key ID: ${keyID}\n`)
process.stdout.write(`Market entry: ${join(releasesRoot, 'market-entry.generated.json')}\n`)
