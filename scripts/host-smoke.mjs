/**
 * dsh-session-log-repair — host-half integration test.
 *
 * Runs the real plugin against the real persistence backend and a throwaway
 * sessions root: builds a synthetic corrupt log (a stale writer re-appending a
 * block), then drives apply() → the registered tools and the fenced HTTP route.
 *
 * Is host-generation-aware: it works against BOTH the legacy host (dsh < 0.1.5,
 * where `JsonlSessionPersistence` is a named export and the backend exposes
 * `readRaw(id)`/`loadStored(id)`) and the format-aware host (dsh >= 0.1.5,
 * where it is a default-only export and the backend is handle-based —
 * `open(id,'read')` → `read()`/`close()` — and reports corruption through
 * `SessionPersistenceCorruptionError`). The repair fixtures are written as
 * legacy-format v0 JSONL (which the format-aware host migrates on read), so a
 * single seed path covers both generations.
 *
 * Usage (plain Node; host packages resolve from the DSH profile, else from this
 * package's devDependencies):
 *   node scripts/host-smoke.mjs [real-corrupt.jsonl.zstd]
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename, resolve } from 'node:path'

import { __internals } from '../lib/index.js'
import { hostImport } from './host-resolve.mjs'

/** Optional argv[2]: exercise a real corrupt log instead of the synthetic one. */
const realLog = process.argv[2]

const { Context } = await hostImport('@deepseek-ai/cordis')
const persistenceModule = await hostImport('@deepseek-ai/dsh-session-persistence-jsonl')
// 0.1.5 exports the backend class as default-only; older releases also named it.
const JsonlSessionPersistence = persistenceModule.JsonlSessionPersistence ?? persistenceModule.default

const fail = (message) => { throw new Error(`HOST-SMOKE FAILED: ${message}`) }
const expect = (condition, message) => { if (!condition) fail(message) }

/**
 * A minimal CLEAN log written in the legacy v0 shape the host reads (both the
 * legacy loader and the format-aware v0→v3 migration accept this vocabulary).
 * @param id - session id for the header.
 * @param cwd - workspace path recorded in the header.
 * @param createdAt - header timestamp in milliseconds.
 * @returns the JSONL text of a clean, loadable session log.
 */
function buildCleanLog(id, cwd, createdAt) {
  const header = { type: 'session', version: 0, id, createdAt, cwd, delegationDepth: 0, agentPreset: 'standard' }
  const events = [
    ['permission/preset', { preset: 'danger-full-access' }],
    ['sandbox/mode', { mode: 'danger-full-access' }],
    ['approval/policy', { policy: 'never' }],
    ['session/end-seed', {}],
    ['turn/start', { turn: 1 }],
    ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
  ]
  const lines = [JSON.stringify(header)]
  events.forEach(([type, data], seq) => {
    lines.push(JSON.stringify({ type, seq, time: createdAt + seq, data }))
  })
  return `${lines.join('\n')}\n`
}

/** A record truncated before its newline: the torn-tail signature. */
const TORN_FRAGMENT = '{"type":"turn/start","seq":6,"time":1'

/**
 * Corrupt a clean log the way the real incidents looked: a stalled writer
 * resumes and re-appends a block whose seqs collide with the committed tail.
 * The tail block (seqs 4,5) then becomes the surviving chain, so the earlier
 * rows 4,5 are the duplicates a correct repair must drop.
 */
function buildStaleTail(clean, createdAt) {
  const stale = [
    { type: 'turn/start', seq: 4, time: createdAt + 100, data: { turn: 1 } },
    { type: 'turn/end', seq: 5, time: createdAt + 101, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  return `${clean}${stale.map(event => JSON.stringify(event)).join('\n')}\n`
}

/** Signature 2: one stale row after the committed tail, with no `turn/end`. */
function buildHiddenSeqGap(clean, createdAt) {
  const stale = { type: 'sandbox/mode', seq: 3, time: createdAt + 100, data: { mode: 'read-only' } }
  return `${clean}${JSON.stringify(stale)}\n`
}

/** Signature 3: a record whose newline never landed inside an otherwise complete frame. */
function buildTornRecord(clean) {
  return `${clean}${TORN_FRAGMENT}`
}

/**
 * Reseed a real corrupt log: copy it into the throwaway root, read it through
 * the normalized raw read, then rewrite the header id so the fixture has a
 * fresh identity.
 */
async function reseedFromRealLog(file, id) {
  const seedId = basename(file).split('.')[0]
  const seedDir = join(sessionsRoot, '--fixture--', seedId)
  mkdirSync(seedDir, { recursive: true })
  const seedFile = join(seedDir, 'session.jsonl.zstd')
  copyFileSync(file, seedFile)
  const seedRaw = await normRaw(seedId, seedFile)
  expect(seedRaw !== undefined, 'raw read must find the seed copy')
  const newline = seedRaw.content.indexOf('\n')
  const header = JSON.parse(seedRaw.content.slice(0, newline))
  header.id = id
  rmSync(join(sessionsRoot, '--fixture--'), { recursive: true, force: true })
  return `${JSON.stringify(header)}\n${seedRaw.content.slice(newline + 1)}`
}

/** Mirror of the backend's project directory encoding. */
function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character === '/' || character === '\\' || character === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) {
      readable += character
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

const workRoot = mkdtempSync(join(tmpdir(), 'dsh-session-log-repair-'))
const sessionsRoot = join(workRoot, 'sessions')
const backupRoot = join(workRoot, 'backups')
mkdirSync(sessionsRoot, { recursive: true })
const rootContext = new Context()
try {
  rootContext.provide('sessions', { list: () => [], get: () => undefined })
} catch {
  /* legacy cordis: assign directly */
  rootContext.sessions = { list: () => [], get: () => undefined }
}

// The backend is constructed either way; the generation is detected on it.
const persistence = new JsonlSessionPersistence(rootContext, { root: sessionsRoot, compression: 'zstd' })
const LEGACY = typeof persistence.loadStored === 'function' && typeof persistence.readRaw === 'function'
console.log(`backend: ${LEGACY ? 'legacy (readRaw/loadStored)' : 'format (handle-based)'}`)

/**
 * Normalized read of one stored session's raw decoded text (for reseeding).
 * Legacy: `persistence.readRaw(id)`; format: decompress the raw file directly.
 */
async function normRaw(id, file) {
  if (LEGACY) return persistence.readRaw(id)
  const { zstdDecompressSync } = await import('node:zlib')
  const bytes = Buffer.from(readFileSync(file))
  const starts = []
  for (let i = 0; i + 4 <= bytes.byteLength; i += 1) {
    if (bytes[i] === 0x28 && bytes[i + 1] === 0xb5 && bytes[i + 2] === 0x2f && bytes[i + 3] === 0xfd) starts.push(i)
  }
  const parts = []
  for (let k = 0; k < starts.length; k += 1) {
    const s = starts[k]
    const e = k + 1 < starts.length ? starts[k + 1] : bytes.byteLength
    parts.push(Buffer.from(zstdDecompressSync(bytes.subarray(s, e))))
  }
  return { content: Buffer.concat(parts).toString('utf8') }
}

/**
 * Normalized read of one stored session's logical events.
 * Returns `{ events, tornMarker }` on success; throws the normalized error
 * otherwise (unwrapping `.cause` so the load-refusal message is the inner one).
 */
async function normLoad(id) {
  if (LEGACY) {
    const stored = await persistence.loadStored(id)
    if (stored === undefined) return undefined
    return { events: stored.events, tornMarker: stored.tornMarker }
  }
  const handle = await persistence.open(id, 'read')
  try {
    const result = await handle.read(0, Number.MAX_SAFE_INTEGER)
    const events = Array.isArray(result?.events) ? result.events : Array.isArray(result) ? result : []
    return { events, tornMarker: undefined }
  } finally {
    try {
      if (typeof handle.close === 'function') await handle.close()
    } catch { /* already closed */ }
  }
}

/** Normalize a backend-load failure to the inner message that names the kind. */
function innerMessage(cause) {
  const root = cause instanceof Error && cause.cause instanceof Error ? cause.cause : cause
  return root instanceof Error ? root.message : String(root)
}

try {
  // ── 1. Build the corrupt fixture through the real backend ──────────────
  const fixtureId = 'session-00000000-0000-4000-8000-00000000fixme'
  const createdAt = Date.now()
  const cwd = join(workRoot, 'workspace')
  mkdirSync(cwd, { recursive: true })
  const clean = buildCleanLog(fixtureId, cwd, createdAt)
  const fixtureContent = realLog === undefined
    ? buildStaleTail(clean, createdAt)
    : await reseedFromRealLog(realLog, fixtureId)
  const header = JSON.parse(fixtureContent.slice(0, fixtureContent.indexOf('\n')))
  const project = projectKey(String(header.cwd))
  const fixtureDir = join(sessionsRoot, project, fixtureId)
  mkdirSync(fixtureDir, { recursive: true })
  const fixtureFile = join(fixtureDir, 'session.jsonl.zstd')
  writeFileSync(fixtureFile, __internals.encodeLog(fixtureContent, 'zstd'))

  let seedError
  try { await normLoad(fixtureId) } catch (error) { seedError = innerMessage(error) }
  expect(seedError !== undefined && /seq gap/.test(seedError), `fixture must be corrupt, got: ${seedError}`)
  console.log(`fixture: ${fixtureId} — ${seedError}`)

  // ── 2. Mount the plugin on a fake context over the real backend ────────
  const tools = []
  const commands = []
  const routes = []
  const toolService = {
    register: (definition) => { tools.push(definition); return () => {} },
    get: (name) => tools.find(tool => tool.name === name),
  }
  const skills = []
  const skillService = {
    register: (skill) => { skills.push(skill); return () => {} },
    list: async () => skills.map(skill => ({ name: skill.name, source: skill.source, provider: skill.provider ?? 'runtime' })),
  }
  const services = {
    sessionPersistence: persistence,
    sessions: { get: () => undefined },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    webRuntime: { trustedHosts: [] },
    commands: { register: (command) => { commands.push(command); return () => {} } },
    tools: toolService,
    skills: skillService,
  }
  const ctx = {
    tools: toolService,
    logger: { warn: (...args) => console.log('[plugin warn]', ...args) },
    effect: (callback) => callback(),
    get: (name) => services[name],
  }
  ctx.inject = (deps, callback) => {
    const missing = deps.filter(name => services[name] === undefined)
    expect(missing.length === 0, `smoke host must provide injected services: ${missing.join(', ')}`)
    callback(ctx)
  }
  const plugin = await import('../lib/index.js')
  await plugin.apply(ctx, { backupRoot })

  expect(tools.length === 3, `expected 3 tools, got ${tools.length}`)
  expect(tools.map(tool => tool.name).join(',') === 'dsh_session_log_repair_scan,dsh_session_log_repair_apply,dsh_session_log_repair_verify', 'tool names')
  expect(commands.length === 1 && commands[0].name === 'dsh-session-log-repair', 'command registered')
  expect(routes.length === 1 && routes[0].path === '/dsh-session-log-repair/api', 'API route registered')
  expect(skills.length === 1, `expected 1 bundled skill, got ${skills.length}`)
  const skill = skills[0]
  expect(skill.name === 'dsh-session-log-repair', `skill name: ${skill.name}`)
  expect(skill.source === 'bundled', 'skill source must be bundled')
  expect(skill.description.length > 40 && skill.description.includes('corrupt session log'), 'skill description must carry the routing text')
  expect(skill.resourceBase.kind === 'directory' && existsSync(join(skill.resourceBase.path, 'scripts', 'repair-session-log.mjs')), 'skill resource base must expose the offline scripts')
  expect(!skill.content.startsWith('---'), 'skill body must not include frontmatter')
  expect(skill.content.includes('存活链') && skill.content.length > 5000, 'skill body must carry the doctrine')
  console.log(`mounted: ${tools.length} tools, ${commands.length} command, ${routes.length} route, 1 skill (${skill.name})`)

  const callTool = async (name, args) => {
    const tool = tools.find(candidate => candidate.name === name)
    expect(tool !== undefined, `tool ${name} missing`)
    expect(typeof tool.execute === 'function', `tool ${name} has no execute`)
    return tool.execute(args)
  }

  // ── 3. Tools ──────────────────────────────────────────────────────────
  const scanText = await callTool('dsh_session_log_repair_scan', {})
  expect(scanText.includes(fixtureId), 'scan must list the fixture')
  expect(scanText.includes('corrupt'), 'scan must label the fixture corrupt')
  console.log('scan tool:\n' + scanText.split('\n').map(line => '  ' + line).join('\n'))

  const dryText = await callTool('dsh_session_log_repair_apply', { session: fixtureId, dryRun: true })
  expect(dryText.includes('[dry run]'), 'dry run must be labelled')
  expect(!dryText.includes('backup:'), 'dry run must not publish a backup')
  console.log('dry run tool:\n' + dryText.split('\n').map(line => '  ' + line).join('\n'))

  const applyText = await callTool('dsh_session_log_repair_apply', { session: fixtureId })
  expect(applyText.includes('✓'), `repair must succeed: ${applyText}`)
  expect(applyText.includes('→ 6 events (max seq 5)'), `repair must report 6 dense events: ${applyText}`)
  expect(applyText.includes('dropped 2 row(s)'), `repair must report the 2 dropped duplicates: ${applyText}`)
  console.log('repair tool:\n' + applyText.split('\n').map(line => '  ' + line).join('\n'))

  const backups = existsSync(backupRoot) ? readdirSync(backupRoot, { recursive: true }) : []
  expect(backups.some(entry => String(entry).endsWith('.orig')), 'a backup file must exist')
  const verifyText = await callTool('dsh_session_log_repair_verify', { session: fixtureId })
  expect(verifyText.includes('✓'), `verify must pass: ${verifyText}`)
  expect(verifyText.includes('6 events'), `verify must report 6 events: ${verifyText}`)
  console.log('verify tool: ' + verifyText.split('\n')[0])

  // Idempotence: a second repair on the now-clean log must change nothing.
  const againText = await callTool('dsh_session_log_repair_apply', { session: fixtureId })
  expect(againText.includes('无冲突') || againText.includes('clean'), `second repair must be a no-op: ${againText}`)
  const sizeAfter = readFileSync(fixtureFile).length

  // ── 3b. The other two signatures of the same loader refusal ────────────
  const variants = [
    {
      id: 'session-00000000-0000-4000-8000-0000000000gap',
      label: 'seq regression with no later turn/end',
      content: buildHiddenSeqGap(buildCleanLog('session-00000000-0000-4000-8000-0000000000gap', cwd, createdAt), createdAt),
      events: 4,
      dropped: 3,
      tornBytes: 0,
      kindError: /seq gap|seq regression|torn JSONL record/,
      // The legacy loader refuses a backward seq; the format-aware host's v0
      // codec tolerates the trailing duplicate, so that host reads it cleanly.
      refuses: LEGACY,
    },
    {
      id: 'session-00000000-0000-4000-8000-0000000000torn',
      label: 'record without its closing newline',
      content: buildTornRecord(buildCleanLog('session-00000000-0000-4000-8000-0000000000torn', cwd, createdAt)),
      events: 6,
      dropped: 0,
      tornBytes: TORN_FRAGMENT.length,
      kindError: /torn JSONL record/,
      refuses: true,
    },
  ]
  for (const variant of variants) {
    const dir = join(sessionsRoot, project, variant.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl.zstd'), __internals.encodeLog(variant.content, 'zstd'))

    let before
    try { await normLoad(variant.id) } catch (error) { before = innerMessage(error) }

    if (variant.refuses) {
      // The host must refuse the corrupted log before the plugin can repair it.
      expect(before !== undefined && variant.kindError.test(before),
        `${variant.label}: loader must refuse, got: ${before}`)
      const scan = await callTool('dsh_session_log_repair_scan', { session: variant.id })
      expect(scan.includes(variant.id) && scan.includes('corrupt'),
        `${variant.label}: scan must list it as corrupt: ${scan}`)

      const preview = await callTool('dsh_session_log_repair_apply', { session: variant.id, dryRun: true })
      expect(preview.includes('[dry run]') && !preview.includes('backup:'), `${variant.label}: dry run must not publish`)

      const applied = await callTool('dsh_session_log_repair_apply', { session: variant.id })
      expect(applied.includes('✓'), `${variant.label}: repair must succeed: ${applied}`)
      expect(applied.includes(`→ ${variant.events} events`), `${variant.label}: expected ${variant.events} events: ${applied}`)
      expect(applied.includes(`dropped ${variant.dropped} row(s)`), `${variant.label}: expected ${variant.dropped} dropped rows: ${applied}`)
      if (variant.tornBytes > 0) {
        expect(applied.includes(`${variant.tornBytes}-byte torn tail`), `${variant.label}: must report the torn tail: ${applied}`)
      }

      const stored = await normLoad(variant.id)
      expect(stored !== undefined && stored.events.length === variant.events,
        `${variant.label}: backend must load ${variant.events} events, got ${stored?.events?.length}`)
      expect(stored.tornMarker === undefined, `${variant.label}: repaired log must not carry a torn marker`)
      const again = await callTool('dsh_session_log_repair_apply', { session: variant.id })
      expect(again.includes('无冲突') || again.includes('clean'), `${variant.label}: second repair must be a no-op: ${again}`)
      console.log(`variant ok: ${variant.label} — ${variant.events} events, ${variant.dropped} dropped row(s), ${variant.tornBytes} torn byte(s)`)
    } else {
      // The format-aware host tolerates a trailing duplicate: the session must
      // read cleanly and NOT be flagged corrupt (no false-positive repair).
      expect(before === undefined, `${variant.label}: format host must read it cleanly, got error: ${before}`)
      const clean = await normLoad(variant.id)
      expect(clean !== undefined && clean.events.length === 6,
        `${variant.label}: format host must load 6 events, got ${clean?.events?.length}`)
      const scan = await callTool('dsh_session_log_repair_scan', { session: variant.id })
      expect(/0 corrupt/.test(scan) && !scan.includes(`corrupt    ${variant.id}`),
        `${variant.label}: scan must NOT list it as corrupt: ${scan}`)
      console.log(`variant ok: ${variant.label} — format host reads the trailing duplicate cleanly (no repair needed)`)
    }
  }

  // ── 4. Fenced HTTP route ──────────────────────────────────────────────
  const invoke = async ({ method = 'POST', headers = {}, body = '' }) => {
    const chunks = body === '' ? [] : [Buffer.from(body)]
    const req = {
      method,
      headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin', ...headers },
      async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
    }
    const captured = { status: 0, headers: undefined, body: '' }
    const res = {
      writeHead: (status, responseHeaders) => { captured.status = status; captured.headers = responseHeaders },
      end: (payload) => { captured.body = payload === undefined ? '' : String(payload) },
    }
    await routes[0].handler(req, res)
    return captured
  }

  const statusResponse = await invoke({ body: JSON.stringify({ op: 'status' }) })
  expect(statusResponse.status === 200, `status route must answer 200, got ${statusResponse.status}`)
  const statusEnvelope = JSON.parse(statusResponse.body)
  expect(statusEnvelope.value.api === '/dsh-session-log-repair/api', 'status must report the API path')
  expect(statusEnvelope.value.tools.length === 3, 'status must report all three tools as registered')
  expect(statusEnvelope.value.root === resolve(sessionsRoot), 'status must report the backend root')
  console.log('route status: ' + JSON.stringify(statusEnvelope.value))

  const scanResponse = await invoke({ body: JSON.stringify({ op: 'scan' }) })
  const scanEnvelope = JSON.parse(scanResponse.body)
  expect(scanEnvelope.value.total === 3, `scan must see 3 sessions, got ${scanEnvelope.value.total}`)
  expect(scanEnvelope.value.corrupt === 0, 'scan must find nothing corrupt after repair')
  expect(scanEnvelope.value.sessions.every(session => session.status === 'ok'),
    `every repaired session must scan as ok: ${JSON.stringify(scanEnvelope.value.sessions)}`)

  const badBody = await invoke({ body: '{not json' })
  expect(badBody.status === 400, `malformed body must answer 400, got ${badBody.status}`)
  const wrongMethod = await invoke({ method: 'GET' })
  expect(wrongMethod.status === 405, `GET must answer 405, got ${wrongMethod.status}`)
  const crossSite = await invoke({ headers: { 'sec-fetch-site': 'cross-site' }, body: '{}' })
  expect(crossSite.status === 403, `cross-site must answer 403, got ${crossSite.status}`)
  const foreignHost = await invoke({ headers: { host: 'evil.example' }, body: '{}' })
  expect(foreignHost.status === 403, `foreign Host must answer 403, got ${foreignHost.status}`)
  const crossOrigin = await invoke({ headers: { origin: 'http://evil.example' }, body: '{}' })
  expect(crossOrigin.status === 403, `cross-origin must answer 403, got ${crossOrigin.status}`)
  console.log('route fences: 200/400/405/403 ×3 all correct')

  // ── 5. Command surface ────────────────────────────────────────────────
  const commandResult = await commands[0].handler({ rawInput: JSON.stringify({ op: 'verify', session: fixtureId }) })
  expect(commandResult.kind === 'success', `command must succeed: ${JSON.stringify(commandResult)}`)
  expect(JSON.parse(commandResult.text).verified === 1, 'command verify must pass')
  const commandError = await commands[0].handler({ rawInput: '{broken' })
  expect(commandError.kind === 'error', 'malformed command input must be an error')
  console.log('command surface: ok')

  expect(readFileSync(fixtureFile).length === sizeAfter, 'idempotent second repair must not rewrite the log')

  // ── 6. Real cordis fiber: every registration must leave with the plugin ─
  const app = new Context()
  const provide = (name, value) => { try { app.provide(name, value) } catch { app[name] = value } }
  provide('sessionPersistence', persistence)
  provide('sessions', { get: () => undefined, list: () => [] })
  const fiberRoutes = []
  provide('webServer', {
    register: (route) => {
      fiberRoutes.push(route)
      return () => { const index = fiberRoutes.indexOf(route); if (index >= 0) fiberRoutes.splice(index, 1) }
    },
  })
  provide('webRuntime', { trustedHosts: [] })
  const fiberCommands = []
  provide('commands', {
    register: (command) => {
      fiberCommands.push(command)
      return () => { const index = fiberCommands.indexOf(command); if (index >= 0) fiberCommands.splice(index, 1) }
    },
  })
  const fiberTools = []
  provide('tools', {
    register: (definition) => {
      fiberTools.push(definition)
      return () => { const index = fiberTools.indexOf(definition); if (index >= 0) fiberTools.splice(index, 1) }
    },
    get: (name) => fiberTools.find(tool => tool.name === name),
  })
  const fiberSkills = []
  provide('skills', {
    register: (skill) => {
      fiberSkills.push(skill)
      return () => { const index = fiberSkills.indexOf(skill); if (index >= 0) fiberSkills.splice(index, 1) }
    },
    list: async () => fiberSkills.map(skill => ({ name: skill.name, source: skill.source, provider: 'runtime' })),
  })
  const fiber = app.plugin(plugin)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(fiberRoutes.length === 1, `real fiber must register the route, got ${fiberRoutes.length}`)
  expect(fiberTools.length === 3, `real fiber must register 3 tools, got ${fiberTools.length}`)
  expect(fiberCommands.length === 1, `real fiber must register the command, got ${fiberCommands.length}`)
  expect(fiberSkills.length === 1 && fiberSkills[0].name === 'dsh-session-log-repair', 'real fiber must register the bundled skill')
  await fiber.dispose()
  expect(fiberRoutes.length === 0, 'dispose must remove the route (HMR safety)')
  expect(fiberTools.length === 0, 'dispose must remove the tools (HMR safety)')
  expect(fiberCommands.length === 0, 'dispose must remove the command (HMR safety)')
  expect(fiberSkills.length === 0, 'dispose must remove the skill (HMR safety)')
  console.log('real fiber: 3 tools + 1 command + 1 route + 1 skill registered and disposed cleanly')

  // ── 7. Boot order: services a bundle row needs do not exist yet ────────
  const bootRoutes = []
  const bootSkills = []
  const parked = []
  const late = {
    commands: { register: () => () => {} },
    tools: { register: () => () => {}, get: () => undefined },
    webServer: undefined,
    skills: undefined,
  }
  const lateCtx = {
    tools: late.tools,
    logger: { warn: () => {} },
    effect: (callback) => callback(),
    get: (name) => late[name],
    inject: (deps, callback) => {
      if (deps.every(name => late[name] !== undefined)) { callback(lateCtx); return }
      parked.push({ deps, callback })
    },
  }
  await plugin.apply(lateCtx, {})
  expect(bootRoutes.length === 0 && bootSkills.length === 0, 'nothing may register before its service exists')
  expect(parked.length === 2, `route and skill must park on their services, parked=${parked.length}`)
  late.webServer = { register: (route) => { bootRoutes.push(route); return () => {} } }
  late.skills = { register: (skill) => { bootSkills.push(skill); return () => {} } }
  for (const entry of parked.splice(0)) entry.callback(lateCtx)
  expect(bootRoutes.length === 1 && bootRoutes[0].path === '/dsh-session-log-repair/api', 'parked route must register once webServer appears')
  expect(bootSkills.length === 1 && bootSkills[0].name === 'dsh-session-log-repair', 'parked skill must register once skills appears')
  console.log('boot order: route + skill parked, then registered when their services appeared')

  console.log('\nHOST-SMOKE OK')
} finally {
  rmSync(workRoot, { recursive: true, force: true })
}