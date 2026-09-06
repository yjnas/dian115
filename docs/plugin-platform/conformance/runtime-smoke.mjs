import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const valueOf = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const runtimePath = resolve(valueOf('--runtime', 'build/runtime/plugin'))
const timeoutMs = Math.max(1000, Number(valueOf('--timeout-ms', '5000')) || 5000)
const verbose = args.includes('--verbose')
const exerciseManifest = args.includes('--exercise-manifest')
const expectHostCall = args.includes('--expect-host-call')
const expectTelegram = args.includes('--expect-telegram')
const actionID = String(valueOf('--action', '')).trim()
const actionInput = JSON.parse(valueOf('--action-input', '{}'))
const manifestArgument = String(valueOf('--manifest', '')).trim()

let manifest = null
if (manifestArgument) {
  const manifestPath = resolve(manifestArgument)
  if (!existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestPath}`)
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
}

if (!existsSync(runtimePath)) throw new Error(`runtime not found: ${runtimePath}`)
if (manifest?.runtime?.kind === 'wasm') throw new Error('runtime-smoke.mjs covers legacy process only; use the DIAN115 WASM worker harness for wasm packages')
if (process.platform !== 'linux') throw new Error('runtime-smoke.mjs must run on Linux, WSL, or a Linux container')

const child = spawn(runtimePath, [], {
  cwd: resolve('.'),
  env: {
    DIAN115_PLUGIN_FILESYSTEM: 'private-root',
    DIAN115_PLUGIN_PACKAGE: '/package/runtime',
    DIAN115_PLUGIN_DATA: '/data',
    TMPDIR: '/tmp',
    PATH: '/usr/bin:/bin',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buffer = Buffer.alloc(0)
let nextID = 1
const pending = new Map()
const hostCalls = []
let telegramRegistration = { commands: [], keywords: [] }
const exitPromise = new Promise((resolvePromise, rejectPromise) => {
  child.once('error', rejectPromise)
  child.once('exit', (code, signal) => {
    if (code === 0 && !signal) resolvePromise()
    else rejectPromise(new Error(`runtime exited with code=${code} signal=${signal}`))
  })
})

function frame(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([
    Buffer.from(`Content-Length: ${payload.length}\r\nContent-Type: application/json\r\n\r\n`),
    payload,
  ])
}

function send(message) {
  child.stdin.write(frame(message))
}

function handle(message) {
  if (verbose && message.method) process.stderr.write(`[runtime] ${message.method}\n`)
  if (message.method) {
    if (message.method === 'host.telegram.register') {
      const commands = Array.isArray(message.params?.commands) ? message.params.commands : []
      const keywords = Array.isArray(message.params?.keywords) ? message.params.keywords : []
      if (commands.length > 3 || keywords.length > 3 || commands.length + keywords.length === 0) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32003, message: 'invalid Telegram registration in smoke host' } })
      } else {
        telegramRegistration = { commands, keywords }
        send({ jsonrpc: '2.0', id: message.id, result: telegramRegistration })
      }
    } else if (message.method === 'host.telegram.list') {
      send({ jsonrpc: '2.0', id: message.id, result: telegramRegistration })
    } else if (message.method === 'host.telegram.unregister') {
      telegramRegistration = { commands: [], keywords: [] }
      send({ jsonrpc: '2.0', id: message.id, result: telegramRegistration })
    } else if (message.method === 'host.log') {
      send({ jsonrpc: '2.0', id: message.id, result: { accepted: true } })
    } else if (message.method === 'host.ui.invalidate') {
      send({ jsonrpc: '2.0', id: message.id, result: { accepted: true } })
    } else if (message.method === 'host.call') {
      if (!message.params || typeof message.params.path !== 'string' || typeof message.params.method !== 'string') {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'invalid host.call params' } })
        return
      }
      hostCalls.push(message.params)
      send({ jsonrpc: '2.0', id: message.id, result: { status: 200, headers: {}, body_base64: '' } })
    } else {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not provided by smoke host' } })
    }
    return
  }
  const waiter = pending.get(String(message.id))
  if (!waiter) return
  pending.delete(String(message.id))
  if (message.error) waiter.reject(new Error(`${message.error.code}: ${message.error.message}`))
  else waiter.resolve(message.result)
}

function parseFrames() {
  while (true) {
    const separator = buffer.indexOf(Buffer.from('\r\n\r\n'))
    if (separator < 0) return
    const headers = buffer.subarray(0, separator).toString('ascii').split('\r\n')
    const line = headers.find((value) => /^content-length:/i.test(value))
    const length = line ? Number(line.split(':', 2)[1].trim()) : NaN
    if (!Number.isInteger(length) || length <= 0 || length > 256 * 1024) throw new Error('invalid runtime response frame')
    const start = separator + 4
    if (buffer.length < start + length) return
    const payload = buffer.subarray(start, start + length)
    buffer = buffer.subarray(start + length)
    handle(JSON.parse(payload.toString('utf8')))
  }
}

child.stdout.on('data', (chunk) => {
  try {
    buffer = Buffer.concat([buffer, chunk])
    parseFrames()
  } catch (error) {
    child.kill('SIGTERM')
    process.stderr.write(`Plugin runtime smoke: FAIL: ${error?.message || error}\n`)
    process.exitCode = 1
  }
})
child.stderr.on('data', (chunk) => {
  if (verbose) process.stderr.write(chunk)
})
child.on('error', (error) => {
  for (const waiter of pending.values()) waiter.reject(error)
})

function request(method, params) {
  const id = `smoke-${nextID++}`
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectPromise(new Error(`timeout waiting for ${method}`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      reject: (error) => {
        clearTimeout(timer)
        rejectPromise(error)
      },
    })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} did not return an object`)
  return value
}

function invocation(op, invocationID, payload, background = false) {
  return request('runtime.invoke', {
    envelope: { op, invocation_id: invocationID, payload },
    background,
  })
}

try {
  const initialized = await request('runtime.initialize', {
    protocol: 'dian115:process@1',
    plugin_id: manifest?.id || 'conformance.runtime-smoke',
    plugin_version: manifest?.version || '1.0.0',
    installation_id: 1,
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
  })
  if (!initialized || initialized.ready !== true) throw new Error('runtime.initialize did not return ready=true')

  const state = await invocation('state', 'smoke-state-1', { view: 'main' })
  if (!state || typeof state.state_version !== 'string' || typeof state.etag !== 'string' || !state.state || typeof state.state !== 'object') {
    throw new Error('runtime state response does not match Plugin API v2')
  }

  const conditionalState = await invocation('state', 'smoke-state-2', { view: 'main', if_none_match: state.etag })
  assertObject(conditionalState, 'conditional state')
  if (conditionalState.not_modified !== true && typeof conditionalState.state_version !== 'string') {
    throw new Error('conditional state returned neither not_modified nor a complete state')
  }

  if (actionID) {
    const action = await invocation('action', 'inv_smoke_action_1', {
      id: actionID,
      input: actionInput,
      context: { locale: 'zh-CN', timezone: 'Asia/Shanghai' },
    })
    assertObject(action, 'action')
    if (!['succeeded', 'failed', 'accepted', 'skipped'].includes(action.status)) {
      throw new Error(`action returned invalid status ${JSON.stringify(action.status)}`)
    }
  }

  if (exerciseManifest) {
    const job = Array.isArray(manifest?.jobs) ? manifest.jobs[0] : null
    if (job) {
      const jobResult = await invocation('job', 'inv_smoke_job_1', {
        id: job.id,
        handler: job.handler,
        scheduled_for: new Date().toISOString(),
        trigger: 'manual',
        attempt: 1,
      }, true)
      assertObject(jobResult, 'job')
      if (!['accepted', 'skipped'].includes(jobResult.status)) throw new Error(`job returned invalid status ${JSON.stringify(jobResult.status)}`)
    }

    const topic = Array.isArray(manifest?.events) ? manifest.events[0] : ''
    if (topic) {
      assertObject(await invocation('event', 'evt_smoke_event_1', {
        id: 'evt_smoke_event_1',
        topic,
        occurred_at: new Date().toISOString(),
        data: { source: 'conformance-smoke' },
      }, true), 'event')
    }
  }

  if (expectTelegram) {
    if (telegramRegistration.commands.length + telegramRegistration.keywords.length === 0) {
      throw new Error('runtime did not register a Telegram command or keyword')
    }
    const command = telegramRegistration.commands[0]?.command || 'plugin_smoke'
    const telegram = await invocation('event', 'evt_smoke_telegram_1', {
      id: 'evt_smoke_telegram_1',
      topic: 'telegram.message',
      occurred_at: new Date().toISOString(),
      data: {
        match: { type: 'command', value: command },
        message: { message_id: 1, chat_id: -10001, chat_type: 'supergroup', user_id: 10001, text: `/${command}` },
      },
    }, true)
    assertObject(telegram, 'Telegram event')
    if (typeof telegram.handled !== 'boolean') throw new Error('Telegram event result is missing handled')
  }

  if (expectHostCall && hostCalls.length === 0) throw new Error('runtime did not issue the expected host.call')

  const shutdown = await request('runtime.shutdown', { reason: 'conformance-smoke' })
  assertObject(shutdown, 'runtime.shutdown')
  await Promise.race([exitPromise, new Promise((_, rejectPromise) => setTimeout(() => rejectPromise(new Error('runtime did not exit after shutdown')), timeoutMs))])
  process.stdout.write(`Plugin runtime smoke: PASS (host_calls=${hostCalls.length}, telegram_commands=${telegramRegistration.commands.length}, telegram_keywords=${telegramRegistration.keywords.length})\n`)
} catch (error) {
  child.kill('SIGTERM')
  process.stderr.write(`Plugin runtime smoke: FAIL: ${error?.message || error}\n`)
  process.exitCode = 1
}
