/**
 * dsh-session-repair — host-half integration test.
 *
 * Runs the real plugin against the real persistence backend and a throwaway
 * sessions root: builds a synthetic corrupt log (a stale writer re-appending a
 * block), then drives apply() → the registered tools and the fenced HTTP route.
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
const { JsonlSessionPersistence } = await hostImport('@deepseek-ai/dsh-session-persistence-jsonl')

const fail = (message) => { throw new Error(`HOST-SMOKE FAILED: ${message}`) }
const expect = (condition, message) => { if (!condition) fail(message) }

/**
 * A minimal clean log with the same shape the host writes: a header line plus
 * one committed event per line. The event types mirror a real resumed session.
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
    ['turn/end', { reason: { kind: 'completed' } }],
  ]
  const lines = [JSON.stringify(header)]
  events.forEach(([type, data], seq) => {
    lines.push(JSON.stringify({ type, seq, time: createdAt + seq, data }))
  })
  return `${lines.join('\n')}\n`
}

/**
 * Corrupt a clean log the way the real incidents looked: a stalled writer
 * resumes and re-appends a block whose seqs collide with the committed tail.
 * The tail block (seqs 4,5) then becomes the surviving chain, so the earlier
 * rows 4,5 are the duplicates a correct repair must drop.
 * @param clean - clean JSONL text (header + 6 rows).
 * @param createdAt - timestamp used to keep the appended rows plausible.
 * @returns the corrupted JSONL text.
 */
function buildStaleTail(clean, createdAt) {
  const stale = [
    { type: 'turn/start', seq: 4, time: createdAt + 100, data: { turn: 1 } },
    { type: 'turn/end', seq: 5, time: createdAt + 101, data: { reason: { kind: 'completed' } } },
  ]
  return `${clean}${stale.map(event => JSON.stringify(event)).join('\n')}\n`
}

/**
 * Reseed a real corrupt log: copy it into the throwaway root, read it through
 * the backend, then rewrite the header id so the fixture has a fresh identity.
 * @param file - path to the real corrupt log.
 * @param id - the fixture session id.
 * @returns the fixture JSONL text.
 */
async function reseedFromRealLog(file, id) {
  const seedId = basename(file).split('.')[0]
  const seedDir = join(sessionsRoot, '--fixture--', seedId)
  mkdirSync(seedDir, { recursive: true })
  copyFileSync(file, join(seedDir, 'session.jsonl.zstd'))
  const seedRaw = await persistence.readRaw(seedId)
  expect(seedRaw !== undefined, 'readRaw must find the seed copy')
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

const workRoot = mkdtempSync(join(tmpdir(), 'dsh-session-repair-'))
const sessionsRoot = join(workRoot, 'sessions')
const backupRoot = join(workRoot, 'backups')
mkdirSync(sessionsRoot, { recursive: true })
const rootContext = new Context()
// The backend's coordinator reads the live session store during construction.
if (typeof rootContext.provide === 'function') rootContext.provide('sessions', { list: () => [], get: () => undefined })
else rootContext.sessions = { list: () => [], get: () => undefined }
const persistence = new JsonlSessionPersistence(rootContext, { root: sessionsRoot, compression: 'zstd' })

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
  const fixtureDir = join(sessionsRoot, projectKey(String(header.cwd)), fixtureId)
  mkdirSync(fixtureDir, { recursive: true })
  const fixtureFile = join(fixtureDir, 'session.jsonl.zstd')
  writeFileSync(fixtureFile, __internals.encodeLog(fixtureContent, 'zstd'))

  let seedError
  try { await persistence.loadStored(fixtureId) } catch (error) { seedError = error.message }
  expect(seedError !== undefined && /seq gap in committed region/.test(seedError), `fixture must be corrupt, got: ${seedError}`)
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
  // Optional services arrive through `ctx.inject`; every name must be one this
  // host provides, otherwise the plugin would silently skip a registration.
  ctx.inject = (deps, callback) => {
    const missing = deps.filter(name => services[name] === undefined)
    expect(missing.length === 0, `smoke host must provide injected services: ${missing.join(', ')}`)
    callback(ctx)
  }
  const plugin = await import('../lib/index.js')
  await plugin.apply(ctx, { backupRoot })

  expect(tools.length === 3, `expected 3 tools, got ${tools.length}`)
  expect(tools.map(tool => tool.name).join(',') === 'dsh_session_repair_scan,dsh_session_repair_apply,dsh_session_repair_verify', 'tool names')
  expect(commands.length === 1 && commands[0].name === 'dsh-session-repair', 'command registered')
  expect(routes.length === 1 && routes[0].path === '/dsh-session-repair/api', 'API route registered')
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
  const scanText = await callTool('dsh_session_repair_scan', {})
  expect(scanText.includes(fixtureId), 'scan must list the fixture')
  expect(scanText.includes('corrupt'), 'scan must label the fixture corrupt')
  console.log('scan tool:\n' + scanText.split('\n').map(line => '  ' + line).join('\n'))

  const dryText = await callTool('dsh_session_repair_apply', { session: fixtureId, dryRun: true })
  expect(dryText.includes('[dry run]'), 'dry run must be labelled')
  expect(!dryText.includes('backup:'), 'dry run must not publish a backup')
  console.log('dry run tool:\n' + dryText.split('\n').map(line => '  ' + line).join('\n'))

  const applyText = await callTool('dsh_session_repair_apply', { session: fixtureId })
  expect(applyText.includes('✓'), `repair must succeed: ${applyText}`)
  expect(applyText.includes('→ 6 events (max seq 5)'), `repair must report 6 dense events: ${applyText}`)
  expect(applyText.includes('dropped 2 row(s)'), `repair must report the 2 dropped duplicates: ${applyText}`)
  console.log('repair tool:\n' + applyText.split('\n').map(line => '  ' + line).join('\n'))

  const backups = existsSync(backupRoot) ? readdirSync(backupRoot, { recursive: true }) : []
  expect(backups.some(entry => String(entry).endsWith('.orig')), 'a backup file must exist')
  const verifyText = await callTool('dsh_session_repair_verify', { session: fixtureId })
  expect(verifyText.includes('✓'), `verify must pass: ${verifyText}`)
  expect(verifyText.includes('6 events'), `verify must report 6 events: ${verifyText}`)
  console.log('verify tool: ' + verifyText.split('\n')[0])

  // Idempotence: a second repair on the now-clean log must change nothing.
  const againText = await callTool('dsh_session_repair_apply', { session: fixtureId })
  expect(againText.includes('无冲突') || againText.includes('clean'), `second repair must be a no-op: ${againText}`)
  const sizeAfter = readFileSync(fixtureFile).length

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
  expect(statusEnvelope.value.api === '/dsh-session-repair/api', 'status must report the API path')
  expect(statusEnvelope.value.tools.length === 3, 'status must report all three tools as registered')
  expect(statusEnvelope.value.root === resolve(sessionsRoot), 'status must report the backend root')
  console.log('route status: ' + JSON.stringify(statusEnvelope.value))

  const scanResponse = await invoke({ body: JSON.stringify({ op: 'scan' }) })
  const scanEnvelope = JSON.parse(scanResponse.body)
  expect(scanEnvelope.value.total === 1, `scan must see 1 session, got ${scanEnvelope.value.total}`)
  expect(scanEnvelope.value.corrupt === 0, 'scan must find nothing corrupt after repair')

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
  app.provide('sessionPersistence', persistence)
  app.provide('sessions', { get: () => undefined, list: () => [] })
  const fiberRoutes = []
  app.provide('webServer', {
    register: (route) => {
      fiberRoutes.push(route)
      return () => { const index = fiberRoutes.indexOf(route); if (index >= 0) fiberRoutes.splice(index, 1) }
    },
  })
  app.provide('webRuntime', { trustedHosts: [] })
  const fiberCommands = []
  app.provide('commands', {
    register: (command) => {
      fiberCommands.push(command)
      return () => { const index = fiberCommands.indexOf(command); if (index >= 0) fiberCommands.splice(index, 1) }
    },
  })
  const fiberTools = []
  app.provide('tools', {
    register: (definition) => {
      fiberTools.push(definition)
      return () => { const index = fiberTools.indexOf(definition); if (index >= 0) fiberTools.splice(index, 1) }
    },
    get: (name) => fiberTools.find(tool => tool.name === name),
  })
  const fiberSkills = []
  app.provide('skills', {
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
  // A bundle-layer row mounts during the initial tree load, before the
  // webserver and skill registries are registered. Each registration must wait
  // for its service instead of being skipped — the bug that left a booted host
  // without /api and without the skill.
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
  expect(bootRoutes.length === 1 && bootRoutes[0].path === '/dsh-session-repair/api', 'parked route must register once webServer appears')
  expect(bootSkills.length === 1 && bootSkills[0].name === 'dsh-session-log-repair', 'parked skill must register once skills appears')
  console.log('boot order: route + skill parked, then registered when their services appeared')

  console.log('\nHOST-SMOKE OK')
} finally {
  rmSync(workRoot, { recursive: true, force: true })
}
