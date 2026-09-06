import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const refIndex = args.indexOf('--ref')
const ref = refIndex >= 0 ? args[refIndex + 1] : ''
const command = ref ? ['ls-tree', '-r', '--name-only', ref] : ['ls-files']
const result = spawnSync('git', command, { encoding: 'utf8' })
if (result.status !== 0) throw new Error(result.stderr || `git ${command.join(' ')} failed`)

const files = result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
const alwaysForbidden = [
  /(?:^|\/)(?:node_modules|build|releases)(?:\/|$)/,
  /\.(?:pem|key)$/i,
  /\.d115p$/i,
]
const mainSourceForbidden = [
  /^cmd\//,
  /^internal\//,
  /^frontend\/src\//,
  /^frontend\/(?:package(?:-lock)?\.json|vite\.config\.(?:js|ts)|tsconfig.*\.json)$/,
  /^(?:go\.mod|go\.sum|Dockerfile|docker-compose\.ya?ml)$/,
  /^scripts\//,
  /^vendor\//,
  /^(?:dist|config|logs|tmp|temp|cache)\//,
]
const allowedPluginExample = /^docs\/plugin-platform\/examples\//
const violations = files.filter((file) => alwaysForbidden.some((pattern) => pattern.test(file)) || (!allowedPluginExample.test(file) && mainSourceForbidden.some((pattern) => pattern.test(file))))

const publicContractFiles = files.filter((file) => /^(?:docs\/plugin-platform|plugin-market)\//.test(file))
const textExtensions = new Set(['.css', '.go', '.html', '.js', '.json', '.md', '.mjs', '.ts', '.vue', '.yaml', '.yml'])
const obsoleteContractPatterns = [
  { pattern: /movie[\s-]?pilot/i, label: 'forbidden reference-project name' },
  { pattern: new RegExp(['Direct', 'Response'].join('')), label: 'opaque OpenAPI response placeholder' },
  { pattern: /与对应主项目接口一致/, label: 'private-source response placeholder' },
  { pattern: /opaque[- ]origin/i, label: 'removed opaque-origin UI model' },
  { pattern: /(?:declarative\s+UI|声明式\s*UI)/i, label: 'removed declarative UI model' },
  { pattern: /\/api\/pt\//i, label: 'removed PT plugin route' },
  { pattern: /[?&]query=Dune\b/, label: 'obsolete TMDB search parameter' },
]
const contentViolations = []
for (const file of publicContractFiles) {
  if (/^docs\/plugin-platform\/conformance\/(?:verify-public-surface|openapi-check|project-check)\.mjs$/.test(file)) continue
  const extension = file.slice(file.lastIndexOf('.')).toLowerCase()
  if (!textExtensions.has(extension)) continue
  let content
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    contentViolations.push(`${file}: cannot read public contract file (${error?.message || error})`)
    continue
  }
  for (const rule of obsoleteContractPatterns) {
    if (rule.pattern.test(content)) contentViolations.push(`${file}: ${rule.label}`)
  }
}

if (violations.length || contentViolations.length) {
  process.stderr.write('Public surface check failed. Main-project source, release material, or obsolete plugin contracts are tracked:\n')
  for (const file of violations) process.stderr.write(`- ${file}\n`)
  for (const violation of contentViolations) process.stderr.write(`- ${violation}\n`)
  process.exit(1)
}
process.stdout.write(`Public surface check passed: ${files.length} tracked files and ${publicContractFiles.length} plugin contract files inspected${ref ? ` at ${ref}` : ''}.\n`)
