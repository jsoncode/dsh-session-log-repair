#!/usr/bin/env node
/**
 * Verify a repaired DSH session log the way a cold history load reads it:
 * decode every zstd frame with the host primitives, scan it through the real
 * `SessionLogScanner`, then fold the registered projections and pure surface
 * folds over the recovered events.
 *
 * A log that only passes the scanner but breaks a projection still fails to
 * render history, so this script is the acceptance gate after a repair.
 *
 * Usage:
 *   node --import tsx/esm verify-repaired-session.mjs --file <session.jsonl.zstd> [--host-root <dir>] [--json]
 *
 * Exit codes: 0 = loads and folds cleanly, 1 = refused (with the failing fold named).
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { installHostResolver } from './host-resolver.mjs'

function parseArgs(argv) {
  const out = { json: false, file: undefined, hostRoot: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') out.json = true
    else if (arg === '--file') out.file = argv[++i]
    else if (arg === '--host-root') out.hostRoot = argv[++i]
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (out.file === undefined) throw new Error('--file <session.jsonl.zstd> is required')
  return out
}

const args = parseArgs(process.argv.slice(2))
const logPath = resolve(args.file)
const hostRoot = resolve(args.hostRoot ?? process.env.DSH_HOST_ROOT ?? 'D:\\workspace\\custom\\deepseek-harness')
// Retry workspace-internal bare imports (e.g. `zod`) against pnpm's hoisted dir.
installHostResolver(join(hostRoot, 'node_modules', '.pnpm', 'node_modules'))
const load = async (...segments) => import(pathToFileURL(join(hostRoot, ...segments)).href)

const { scanZstdFrames, decompressZstdFrame } = await load('packages', 'session', 'session-persistence-jsonl', 'src', 'zstd.ts')
const { scanLog } = await load('packages', 'session', 'session-persistence-jsonl', 'src', 'format.ts')
const surface = await load('packages', 'core', 'session', 'src', 'surface.ts')
const requestHeader = await load('packages', 'core', 'session', 'src', 'request-header.ts')

/* ----------------------------------------------------------- 1. decode --- */

const bytes = readFileSync(logPath)
const { frames, tornStart } = scanZstdFrames(bytes)
if (frames.length === 0) throw new Error('no complete zstd frame found')
if (tornStart !== undefined) throw new Error(`incomplete final frame at byte ${tornStart}`)
const plaintexts = []
for (const range of frames) plaintexts.push(await decompressZstdFrame(bytes.subarray(range.start, range.end)))

let scanned
try {
  scanned = scanLog(Buffer.concat(plaintexts))
} catch (error) {
  console.error(`[refused] session log does not scan: ${error.message}`)
  process.exit(1)
}
const events = scanned.events
for (let i = 0; i < events.length; i += 1) {
  if (events[i].seq !== i) { console.error(`[refused] non-dense seq at event ${i}: ${events[i].seq}`); process.exit(1) }
}

/* --------------------------------------------------------- 2. folds ----- */

/** Projection units registered on `ctx.sessionProjections`. */
const projectionUnits = [
  ['turnBoundary', ['packages', 'core', 'agent-loop', 'src', 'index.ts'], 'turnBoundaryProjectionDefinition'],
  ['turnOutline', ['packages', 'session', 'session-turn-outline', 'src', 'projection.ts'], 'turnOutlineProjectionDefinition'],
  ['sessionStats', ['packages', 'session', 'session-stats', 'src', 'projection.ts'], 'sessionStatsProjectionDefinition'],
  ['title', ['packages', 'session', 'session-title', 'src', 'index.ts'], 'titleProjectionDefinition'],
  ['tokenUsage', ['packages', 'llm', 'token-meter', 'src', 'usage-projection.ts'], 'tokenUsageProjectionDefinition'],
  ['contextPressure', ['packages', 'llm', 'token-meter', 'src', 'usage-projection.ts'], 'contextPressureProjectionDefinition'],
  ['contextBreakdown', ['packages', 'llm', 'token-meter', 'src', 'breakdown-projection.ts'], 'contextBreakdownProjectionDefinition'],
  ['agentPreset', ['packages', 'preset', 'agent-presets', 'src', 'session.ts'], 'agentPresetProjectionDefinition'],
  ['planMode', ['packages', 'plan', 'plan-mode', 'src', 'index.ts'], 'planProjectionDefinition'],
  ['goal', ['packages', 'goal', 'goal', 'src', 'index.ts'], 'goalProjectionDefinition'],
  ['schedule', ['packages', 'schedule', 'schedule', 'src', 'projection.ts'], 'scheduleProjectionDefinition'],
  ['subagentTiming', ['packages', 'subagent', 'subagent', 'src', 'projection.ts'], 'subagentTimingProjectionDefinition'],
  ['subagentIdentity', ['packages', 'subagent', 'subagent', 'src', 'projection.ts'], 'subagentIdentityProjectionDefinition'],
  ['subagentModelSelection', ['packages', 'subagent', 'tool-subagent', 'src', 'model-selection-state.ts'], 'subagentModelSelectionProjectionDefinition'],
]

const results = []
const failures = []
const moduleCache = new Map()

for (const [label, segments, exportName] of projectionUnits) {
  const key = segments.join('/')
  try {
    if (!moduleCache.has(key)) moduleCache.set(key, await load(...segments))
    const definition = moduleCache.get(key)[exportName]
    if (definition === undefined) { results.push({ unit: label, status: 'absent' }); continue }
    let state = definition.init(scanned.meta, scanned.inheritedEventCount)
    for (const event of events) state = await definition.apply(state, event)
    if (definition.stateSchema !== undefined) definition.stateSchema.parse(state)
    if (definition.wire?.viewSchema !== undefined) definition.wire.viewSchema.parse(definition.wire.view(state))
    results.push({ unit: label, status: 'ok' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    results.push({ unit: label, status: 'FAILED', error: message })
    failures.push(`${label}: ${message}`)
  }
}

/** Pure folds the host exports directly over the recovered events. */
const pureFolds = [
  ['foldSurface', () => surface.foldSurface(events)],
  ['foldRequestHeader', () => requestHeader.foldRequestHeader(events)],
]

for (const [label, run] of pureFolds) {
  try {
    run()
    results.push({ unit: label, status: 'ok' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    results.push({ unit: label, status: 'FAILED', error: message })
    failures.push(`${label}: ${message}`)
  }
}

/* --------------------------------------------------------- 3. report ---- */

const summary = {
  file: logPath,
  frames: frames.length,
  events: events.length,
  maxSeq: events.length - 1,
  header: { id: scanned.meta.id, cwd: scanned.meta.cwd, createdAt: scanned.meta.createdAt },
  eventTypes: Object.fromEntries([...new Map(events.map(event => [event.type, 0]))].map(([type]) => [type, events.filter(event => event.type === type).length])),
  lastEvent: { type: events.at(-1)?.type, seq: events.at(-1)?.seq, time: events.at(-1)?.time },
  folds: results,
  failures,
}

if (args.json) console.log(JSON.stringify(summary, null, 2))
else {
  console.log(`file        ${logPath}`)
  console.log(`session     ${summary.header.id}`)
  console.log(`frames      ${frames.length}`)
  console.log(`events      ${events.length} (max seq ${summary.maxSeq})`)
  console.log(`last event  ${summary.lastEvent.type} seq ${summary.lastEvent.seq}`)
  console.log('\nfolds:')
  for (const result of results) {
    console.log(`  ${result.status === 'ok' ? 'ok  ' : result.status === 'absent' ? '--  ' : 'FAIL'} ${result.unit}`
      + (result.error === undefined ? '' : ` — ${result.error}`))
  }
}

if (failures.length > 0) {
  console.error(`\n[refused] ${failures.length} fold(s) failed: ${failures.join(' | ')}`)
  process.exit(1)
}
console.log('\n[ok] log scans and every checked fold completed.')
