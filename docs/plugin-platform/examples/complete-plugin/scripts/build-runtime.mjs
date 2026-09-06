import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'build', 'runtime', 'plugin.wasm')
mkdirSync(dirname(output), { recursive: true })
const result = spawnSync('go', ['build', '-buildmode=c-shared', '-trimpath', '-ldflags=-s -w', '-o', output, './runtime'], {
  cwd: root,
  env: { ...process.env, CGO_ENABLED: '0', GOOS: 'wasip1', GOARCH: 'wasm' },
  encoding: 'utf8',
  stdio: 'inherit',
})

if (result.error) throw result.error
if (result.status !== 0) throw new Error(`Go runtime build failed with exit code ${result.status}`)
process.stdout.write(`Built portable WASM runtime: ${output}\n`)
