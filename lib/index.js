/**
 * dsh-session-log-repair — host half.
 *
 * Repairs a DSH JSONL session log the loader refuses:
 *   - a seq collision in the committed region: two writers appended different
 *     events under the same `seq` values (a stalled writer resuming after
 *     another process committed a crash repair);
 *   - a trailing record without its closing newline inside an otherwise
 *     complete frame, which the loader reports as a torn JSONL record.
 * The first signature also reaches the loader's generic torn-record message
 * when no later `turn/end` escalates it to the specific seq-gap message, so
 * both are detected and repaired from the decoded rows rather than the text.
 *
 * Repair rule — the surviving chain: start from the maximal dense run that
 * reaches the end of the file (the writer that produced the rest of the log),
 * then walk backwards. A row ending exactly where the chain starts joins it; a
 * row whose range reaches into the chain duplicates it and is dropped; a real
 * gap stops the walk and the remaining rows must form a dense prefix, otherwise
 * the repair is refused. The decision never depends on guessing which rows are
 * synthetic, so it also holds when both competing versions are real writes.
 *
 * Reading uses the running backend (`ctx.sessionPersistence.readRaw`), so the
 * bytes come from the host's own frame decoder; row expansion uses the host's
 * `decodeStorageRecord`. Writing re-frames the repaired plaintext with Node's
 * zstd (frame 1 is exactly the header line, the remainder is one frame), and
 * the result is re-loaded through the backend before the call returns.
 *
 * Surfaces: model tools (`dsh_session_log_repair_*`), the `/dsh-session-log-repair`
 * command, and the fenced HTTP route `/dsh-session-log-repair/api` used by the
 * browser half.
 */

import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

export const name = 'dsh-session-log-repair'
export const inject = ['tools']

const API_PATH = '/dsh-session-log-repair/api'
const API_BODY_LIMIT = 1 << 20
const SCAN_CONCURRENCY = 4
const INTERRUPTED_TOOL_RESULT_PREFIX = 'interrupted-tool-result-'
const SEQ_GAP = /seq gap in committed region/
/**
 * The loader's generic message for a complete frame that contains a record it
 * could not consume: a trailing record without its newline, an unparsable row,
 * or a seq regression that no later `turn/end` escalated to the specific
 * `seq gap` message. Only the first and third are repairable.
 */
const TORN_RECORD = /complete frame contains a torn JSONL record/
const LOG_FILES = ['session.jsonl.zstd', 'session.jsonl']
/** The skill that ships inside this package: doctrine plus the offline scripts. */
const SKILL_DIR = fileURLToPath(new URL('../skill/', import.meta.url))
const SKILL_FILE = join(SKILL_DIR, 'SKILL.md')

/* ───────────────────────────── host package resolution ─────────────────── */

/** DSH home: the launcher's `$DSH_HOME`, else `~/.dsh`. */
function dshHome() {
  const configured = process.env.DSH_HOME
  return typeof configured === 'string' && configured.trim().length > 0
    ? configured.trim()
    : join(homedir(), '.dsh')
}

/**
 * Resolve a host package the way the host itself does: the DSH profile's
 * `node_modules` first, so the plugin always shares the host's own instances,
 * then a plain import for a checkout that carries its own `node_modules`.
 * @param specifier - bare package specifier to load.
 * @returns the loaded module namespace.
 */
async function loadHostPackage(specifier) {
  const profiles = join(dshHome(), 'profiles')
  const bases = []
  try {
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (entry.isDirectory()) bases.push(join(profiles, entry.name, 'package.json'))
    }
  } catch { /* no profiles directory: the plain import below is the fallback */ }
  bases.push(join(profiles, 'package.json'))
  for (const base of bases) {
    try {
      const resolved = createRequire(base).resolve(specifier)
      return await import(pathToFileURL(resolved).href)
    } catch { /* try the next profile root, then the plugin's own node_modules */ }
  }
  try {
    return await import(specifier)
  } catch (error) {
    throw new Error(
      `cannot resolve "${specifier}" (host package); `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/* ────────────────────────────────── log codec ──────────────────────────── */

/** Report-only label for one row's events. */
function classify(events) {
  for (const event of events) {
    if (event.type === 'session/end-seed') return 'resume-marker'
    if (event.type === 'turn/end' && event.data?.reason?.kind === 'interrupted') return 'repair-closer'
    if (event.type === 'tool/result'
      && String(event.data?.message?.id ?? '').startsWith(INTERRUPTED_TOOL_RESULT_PREFIX)) return 'repair-tool-result'
  }
  return 'live'
}

/**
 * Split decoded log text into its header line and event rows, expanding each
 * row through the host decoder so packed chunk rows report their real seq range.
 * @param content - decoded JSONL text (no torn final frame).
 * @param decodeStorageRecord - the host row expander.
 * @returns the header line and one entry per committed row.
 */
function parseLog(content, decodeStorageRecord) {
  const headerEnd = content.indexOf('\n')
  if (headerEnd === -1) throw new Error('session log has no header line')
  const header = content.slice(0, headerEnd)
  const lines = content.slice(headerEnd + 1).split('\n')
  const rows = []
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    if (raw === '') {
      if (index === lines.length - 1) continue
      throw new Error(`file line ${index + 2} is empty`)
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (cause) {
      throw new Error(`file line ${index + 2} is not valid JSON: ${cause.message}`)
    }
    let events
    try {
      events = decodeStorageRecord(parsed)
    } catch (cause) {
      throw new Error(`file line ${index + 2} is not a valid storage record: ${cause.message}`)
    }
    if (events.length === 0) throw new Error(`file line ${index + 2} expands to zero events`)
    rows.push({
      index: rows.length,
      fileLine: index + 2,
      raw,
      type: parsed.type,
      base: events[0].seq,
      end: events[events.length - 1].seq,
      count: events.length,
      time: events[0].time,
      lastTime: events[events.length - 1].time,
      kind: classify(events),
    })
  }
  for (let index = 0; index < rows.length - 1; index += 1) {
    if (rows[index].type === 'step/end' && rows[index + 1].kind === 'repair-closer'
      && rows[index].time === rows[index + 1].time) {
      rows[index].kind = 'repair-closer'
    }
  }
  return { header, rows }
}

/**
 * Drop a trailing record that has no closing newline. A writer killed between
 * the record bytes and the newline leaves one inside an otherwise complete
 * frame, and the loader refuses the whole log for it. The bytes were never a
 * committed event, so removing them cannot lose an event.
 * @param content - decoded plaintext of the log's complete frames.
 * @returns the content ending at the last newline plus the dropped byte count.
 */
function dropTornTail(content) {
  if (content === '' || content.endsWith('\n')) return { content, tornBytes: 0 }
  const lastNewline = content.lastIndexOf('\n')
  if (lastNewline === -1) throw new Error('session log has no complete record')
  const tail = content.slice(lastNewline + 1)
  // `readRaw` returns decoded text; report the dropped size in bytes so the
  // number matches the file, not its UTF-16 length.
  return { content: content.slice(0, lastNewline + 1), tornBytes: Buffer.byteLength(tail, 'utf8') }
}

/** Verify a rebuilt log is dense from seq 0 and report its size. */
function verifyDense(content, decodeStorageRecord) {
  const { rows } = parseLog(content, decodeStorageRecord)
  let expected = 0
  for (const row of rows) {
    if (row.base !== expected) {
      throw new Error(`rebuilt log is not dense at file line ${row.fileLine}: `
        + `expected seq ${expected}, got ${row.base}`)
    }
    expected += row.count
  }
  return { events: expected, maxSeq: expected - 1, rows: rows.length }
}

/**
 * Decide which rows survive.
 * @param rows - parsed rows in file order.
 * @returns kept rows, dropped rows, and the seq where the surviving chain starts.
 */
function planRepair(rows) {
  if (rows.length === 0) throw new Error('session log has no committed events')
  let tailStart = rows.length - 1
  let tailSeq = rows[tailStart].base
  while (tailStart - 1 >= 0 && rows[tailStart - 1].end === tailSeq - 1) {
    tailStart -= 1
    tailSeq = rows[tailStart].base
  }
  if (tailStart === 0) {
    return { kept: rows, dropped: [], chainStart: tailSeq, tailStartsAtSeq: tailSeq, survivor: rows[0], clean: true }
  }
  let chainStart = tailSeq
  const dropped = []
  let gapIndex = -1
  for (let index = tailStart - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row.end === chainStart - 1) {
      chainStart = row.base
      continue
    }
    if (row.end >= chainStart) {
      if (row.base < chainStart) {
        throw new Error(`file line ${row.fileLine} spans seqs ${row.base}..${row.end} across the `
          + `surviving chain start ${chainStart}; refusing to guess`)
      }
      dropped.push(row)
      continue
    }
    gapIndex = index
    break
  }
  if (gapIndex >= 0) {
    let expected = 0
    for (const row of rows.slice(0, gapIndex + 1)) {
      if (row.base !== expected) {
        throw new Error(`log is not dense at file line ${row.fileLine}: expected seq ${expected}, `
          + `got ${row.base} (this plugin repairs seq collisions only; a missing row needs different recovery)`)
      }
      expected += row.count
    }
    if (expected !== chainStart) {
      throw new Error(`prefix ends at seq ${expected - 1} but the surviving chain starts at ${chainStart}`)
    }
  } else if (chainStart !== 0) {
    throw new Error(`surviving chain starts at seq ${chainStart}, not 0; refusing to guess`)
  }
  const droppedIndexes = new Set(dropped.map(row => row.index))
  return {
    kept: rows.filter(row => !droppedIndexes.has(row.index)),
    dropped,
    chainStart,
    tailStartsAtSeq: tailSeq,
    survivor: rows[tailStart],
    clean: dropped.length === 0,
  }
}

/** Rebuild JSONL text from the header and kept rows. */
function buildContent(header, keptRows) {
  if (keptRows.length === 0) return `${header}\n`
  return `${header}\n${keptRows.map(row => row.raw).join('\n')}\n`
}

/**
 * Encode repaired JSONL text in the backend's physical layout: frame 1 is
 * exactly the header line (the backend asserts this), the rest is one frame.
 * @param content - repaired JSONL text.
 * @param compression - the backend's configured encoding.
 * @returns the bytes to publish.
 */
function encodeLog(content, compression) {
  if (compression === 'none') return Buffer.from(content, 'utf8')
  if (typeof zstdCompressSync !== 'function') {
    throw new Error('this Node runtime has no zlib zstd support (need Node >= 22.15)')
  }
  const headerEnd = content.indexOf('\n')
  const headerLine = content.slice(0, headerEnd + 1)
  const body = content.slice(headerEnd + 1)
  const frames = [zstdCompressSync(Buffer.from(headerLine, 'utf8'))]
  if (body.length > 0) frames.push(zstdCompressSync(Buffer.from(body, 'utf8')))
  return Buffer.concat(frames)
}

/* ──────────────────────────────── filesystem ───────────────────────────── */

/** Cheap change detector for a log a live writer may be appending to. */
function stamp(path) {
  const info = statSync(path)
  return `${String(info.size)}:${String(Math.trunc(info.mtimeMs))}`
}

/** Write bytes durably to a sibling temp file, then atomically publish them. */
function publishAtomically(target, bytes) {
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, target)
}

/* ──────────────────────────────── discovery ────────────────────────────── */

/** Sessions root: plugin config, else the backend's own configured root. */
function sessionsRoot(deps) {
  const configured = deps.config?.sessionsRoot
  if (typeof configured === 'string' && configured.trim().length > 0) return resolve(configured.trim())
  const root = deps.ctx.get('sessionPersistence')?.config?.root
  if (typeof root === 'string' && root.trim().length > 0) return root
  return join(dshHome(), 'sessions')
}

/** Every stored session log under the root. */
function discoverSessions(root) {
  const found = []
  let projects
  try {
    projects = readdirSync(root, { withFileTypes: true })
  } catch (cause) {
    // A host that never stored a session has no root directory yet: that is an
    // empty library, not a failure. Any other error (permissions, a file where
    // the directory should be) still fails loud.
    if (cause.code === 'ENOENT') return found
    throw new Error(`cannot read sessions root ${root}: ${cause.message}`)
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    let sessions
    try {
      sessions = readdirSync(join(root, project.name), { withFileTypes: true })
    } catch { continue }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      for (const fileName of LOG_FILES) {
        const file = join(root, project.name, session.name, fileName)
        if (!existsSync(file)) continue
        found.push({
          id: session.name,
          project: project.name,
          file,
          compression: fileName.endsWith('.zstd') ? 'zstd' : 'none',
        })
        break
      }
    }
  }
  return found
}

/** Resolve a user-supplied session reference: exact id, unique prefix, or unique substring. */
function matchSessions(all, reference) {
  const wanted = String(reference ?? '').trim()
  if (wanted.length === 0) throw new Error('session id is required')
  const exact = all.find(entry => entry.id === wanted)
  if (exact !== undefined) return [exact]
  const prefixed = all.filter(entry => entry.id.startsWith(wanted))
  if (prefixed.length === 1) return prefixed
  if (prefixed.length > 1) {
    throw new Error(`"${wanted}" matches ${prefixed.length} sessions; use a longer id`)
  }
  const contained = all.filter(entry => entry.id.includes(wanted))
  if (contained.length === 1) return contained
  if (contained.length > 1) {
    throw new Error(`"${wanted}" matches ${contained.length} sessions; use a longer id`)
  }
  throw new Error(`no stored session matches "${wanted}"`)
}

/* ──────────────────────────────────── ops ──────────────────────────────── */

/** The backend that owns the stored logs, or a loud refusal. */
function backend(deps) {
  const persistence = deps.ctx.get('sessionPersistence')
  if (persistence === undefined || typeof persistence.readRaw !== 'function') {
    throw new Error('session persistence backend is unavailable (no ctx.sessionPersistence.readRaw)')
  }
  return persistence
}

/** Live in this process? Rewriting such a log would fight the writer. */
function isLive(deps, id) {
  const store = deps.ctx.get('sessions')
  if (store === undefined || typeof store.get !== 'function') return false
  try {
    return store.get(id) !== undefined
  } catch { /* unknown id shape: treat as not live */
    return false
  }
}

/** Concurrency-bounded map. */
async function mapLimit(items, limit, run) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await run(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/** Validate one stored session through the backend and report its status. */
async function inspectSession(deps, entry) {
  const persistence = backend(deps)
  const base = {
    id: entry.id,
    project: entry.project,
    file: entry.file,
    compression: entry.compression,
  }
  try {
    const info = statSync(entry.file)
    base.bytes = info.size
    base.mtimeMs = Math.trunc(info.mtimeMs)
  } catch { /* the file may vanish mid-scan; loadStored reports it below */ }
  if (isLive(deps, entry.id)) return { ...base, status: 'live', repairable: false }
  try {
    const stored = await persistence.loadStored(entry.id)
    if (stored === undefined) return { ...base, status: 'missing', repairable: false }
    return {
      ...base,
      status: stored.tornMarker === undefined ? 'ok' : 'torn',
      repairable: false,
      events: stored.events.length,
      maxSeq: stored.events.length - 1,
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    const repairable = SEQ_GAP.test(message) || TORN_RECORD.test(message)
    return {
      ...base,
      status: repairable ? 'corrupt' : 'unreadable',
      repairable,
      // Two signatures reach the loader's generic torn-record message; the
      // repair path distinguishes them from the decoded rows.
      ...(repairable && !SEQ_GAP.test(message) ? { signature: 'torn-record' } : {}),
      message,
    }
  }
}

/** `scan` op: validate every stored session. */
async function opScan(deps) {
  const startedAt = Date.now()
  const root = sessionsRoot(deps)
  const entries = discoverSessions(root)
  const sessions = await mapLimit(entries, SCAN_CONCURRENCY, entry => inspectSession(deps, entry))
  const order = { corrupt: 0, unreadable: 1, torn: 2, live: 3, missing: 4, ok: 5 }
  sessions.sort((left, right) => (order[left.status] ?? 9) - (order[right.status] ?? 9)
    || left.id.localeCompare(right.id))
  return {
    ok: true,
    root,
    scannedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    total: sessions.length,
    corrupt: sessions.filter(session => session.status === 'corrupt').length,
    sessions,
  }
}

/** `repair` op: repair one session, or every repairable session. */
async function opRepair(deps, request, helpers) {
  const root = sessionsRoot(deps)
  const entries = discoverSessions(root)
  let targets
  if (request.session !== undefined && request.session !== '') {
    targets = matchSessions(entries, request.session)
  } else if (request.all === true) {
    const inspected = await mapLimit(entries, SCAN_CONCURRENCY, entry => inspectSession(deps, entry))
    targets = entries.filter((entry, index) => inspected[index].repairable)
    if (targets.length === 0) {
      return { ok: true, root, repaired: 0, dryRun: request.dryRun === true, results: [] }
    }
  } else {
    throw new Error('repair needs a session id or all: true')
  }
  const results = []
  for (const entry of targets) {
    try {
      results.push(await repairOne(deps, entry, request, helpers))
    } catch (cause) {
      results.push({
        id: entry.id,
        file: entry.file,
        repaired: false,
        message: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }
  return {
    ok: true,
    root,
    dryRun: request.dryRun === true,
    repaired: results.filter(result => result.repaired).length,
    results,
  }
}

/** Read, plan, rebuild, verify, and (unless dry-run) publish one session. */
async function repairOne(deps, entry, request, helpers) {
  const persistence = backend(deps)
  const { decodeStorageRecord } = helpers
  const dryRun = request.dryRun === true
  if (isLive(deps, entry.id) && request.force !== true) {
    throw new Error('session is live in this process; close it (or pass force) before repairing')
  }
  const raw = await persistence.readRaw(entry.id)
  if (raw === undefined) throw new Error('no stored artifact for this session')
  // `readRaw` decodes every complete frame, so a torn record that a writer left
  // inside one is still present here and must go before the rows are parsed.
  const trimmed = dropTornTail(raw.content)
  const { header, rows } = parseLog(trimmed.content, decodeStorageRecord)
  const plan = planRepair(rows)
  const before = rows.reduce((total, row) => total + row.count, 0)
  if (plan.clean && trimmed.tornBytes === 0) {
    return {
      id: entry.id,
      file: entry.file,
      repaired: false,
      clean: true,
      eventsBefore: before,
      message: 'no seq collision found',
    }
  }
  const content = buildContent(header, plan.kept)
  const verified = verifyDense(content, decodeStorageRecord)
  const bytes = encodeLog(content, entry.compression)
  const result = {
    id: entry.id,
    file: entry.file,
    repaired: false,
    dryRun,
    eventsBefore: before,
    eventsAfter: verified.events,
    maxSeq: verified.maxSeq,
    rowsAfter: verified.rows,
    tornBytes: trimmed.tornBytes,
    tailStartsAtSeq: plan.tailStartsAtSeq,
    chainStartsAtSeq: plan.chainStart,
    survivor: plan.clean ? undefined : describeRow(plan.survivor),
    dropped: plan.dropped.map(describeRow),
    bytes: { before: statSync(entry.file).size, after: bytes.length },
  }
  if (dryRun) return result

  const beforeStamp = stamp(entry.file)
  const backupDir = resolve(deps.config?.backupRoot
    ?? join(dshHome(), 'session-repair-backups', `${entry.id}-${String(Date.now())}`))
  mkdirSync(backupDir, { recursive: true })
  const backup = join(backupDir, `${entry.id}.jsonl${entry.compression === 'zstd' ? '.zstd' : ''}.orig`)
  copyFileSync(entry.file, backup)
  if (stamp(entry.file) !== beforeStamp) {
    throw new Error('log changed while planning the repair; a writer is active (backup kept at '
      + `${backup})`)
  }
  publishAtomically(entry.file, bytes)
  result.repaired = true
  result.backup = backup
  // Authoritative gate: reload the published bytes through the backend itself.
  const stored = await persistence.loadStored(entry.id)
  if (stored === undefined) throw new Error('published log is not readable through the backend')
  if (stored.events.length !== verified.events) {
    throw new Error(`backend loaded ${String(stored.events.length)} events, expected ${String(verified.events)}`)
  }
  result.events = stored.events.length
  result.lastEvent = lastEventOf(stored.events)
  return result
}

/** Compact row description for reports. */
function describeRow(row) {
  return {
    fileLine: row.fileLine,
    type: row.type,
    kind: row.kind,
    seq: [row.base, row.end],
    time: row.time,
  }
}

/** The final event's type and seq, for report tails. */
function lastEventOf(events) {
  if (events.length === 0) return undefined
  const last = events[events.length - 1]
  return { type: last.type, seq: last.seq }
}

/** `verify` op: load one session through the backend. */
async function opVerify(deps, request) {
  const root = sessionsRoot(deps)
  const entries = discoverSessions(root)
  const targets = request.session !== undefined && request.session !== ''
    ? matchSessions(entries, request.session)
    : entries
  const results = await mapLimit(targets, SCAN_CONCURRENCY, async (entry) => {
    try {
      const stored = await backend(deps).loadStored(entry.id)
      if (stored === undefined) return { id: entry.id, ok: false, message: 'no stored artifact' }
      return {
        id: entry.id,
        ok: true,
        events: stored.events.length,
        maxSeq: stored.events.length - 1,
        lastEvent: lastEventOf(stored.events),
        torn: stored.tornMarker !== undefined,
      }
    } catch (cause) {
      return { id: entry.id, ok: false, message: cause instanceof Error ? cause.message : String(cause) }
    }
  })
  return { ok: true, root, verified: results.filter(result => result.ok).length, total: results.length, results }
}

/** Dispatch one API/command request. */
async function runOp(deps, request, helpers) {
  const op = String(request?.op ?? '')
  if (op === 'scan') return opScan(deps)
  if (op === 'repair') return opRepair(deps, request, helpers)
  if (op === 'verify') return opVerify(deps, request)
  if (op === 'status') {
    const persistence = deps.ctx.get('sessionPersistence')
    const toolService = deps.ctx.get('tools')
    const skillService = deps.ctx.get('skills')
    const toolNames = ['dsh_session_log_repair_scan', 'dsh_session_log_repair_apply', 'dsh_session_log_repair_verify']
    return {
      ok: true,
      root: sessionsRoot(deps),
      backend: typeof persistence?.readRaw === 'function' ? 'jsonl' : 'unsupported',
      compression: persistence?.config?.compression ?? 'zstd',
      tools: typeof toolService?.get === 'function'
        ? toolNames.filter(toolName => toolService.get(toolName) !== undefined)
        : [],
      api: API_PATH,
      skill: await skillStatus(skillService),
    }
  }
  throw new Error(`unknown op "${op}" (expected scan | repair | verify | status)`)
}

/* ─────────────────────────────── HTTP route ────────────────────────────── */

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/** Browser trust fence for the API route: loopback/trusted host plus same-origin marker. */
function isTrustedApiRequest(headers, trustedHosts) {
  const raw = headers.host
  if (typeof raw !== 'string' || raw === '') return false
  const hostUrl = parseAuthority(raw)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/* ──────────────────────────────── skill ────────────────────────────────── */

/** Name the bundled skill registers under; the docs address it by this name. */
const SKILL_NAME = 'dsh-session-log-repair'

/**
 * Read the bundled `skill/SKILL.md`: YAML frontmatter supplies the routing
 * metadata, the remainder is the model-facing body. The frontmatter is a flat
 * `key: value` block, so a full YAML parser is not needed.
 * @returns the `ctx.skills.register()` input for the bundled skill.
 */
function loadBundledSkill() {
  const raw = readFileSync(SKILL_FILE, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (match === null) throw new Error(`${SKILL_FILE} has no YAML frontmatter`)
  const fields = {}
  for (const line of match[1].split('\n')) {
    const pair = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line.trim())
    if (pair !== null) fields[pair[1]] = pair[2].trim()
  }
  if (fields.name !== SKILL_NAME) {
    throw new Error(`${SKILL_FILE} declares skill name ${JSON.stringify(fields.name)}, expected ${JSON.stringify(SKILL_NAME)}`)
  }
  if (typeof fields.description !== 'string' || fields.description.length === 0) {
    throw new Error(`${SKILL_FILE} frontmatter needs a description`)
  }
  return {
    name: SKILL_NAME,
    description: fields.description,
    ...(fields.whenToUse === undefined ? {} : { whenToUse: fields.whenToUse }),
    source: 'bundled',
    // Relative paths in the body resolve against the directory that ships the
    // offline scripts, so the model can run them without knowing the install path.
    resourceBase: { kind: 'directory', path: SKILL_DIR },
    path: SKILL_FILE,
    content: raw.slice(match[0].length),
  }
}

/**
 * Report the skill's catalog state without failing `status` when the registry
 * is absent (a profile without the base skill rows).
 * @param skillService - the `skills` registry, when the host provides one.
 * @returns availability plus whether this skill won a catalog slot.
 */
async function skillStatus(skillService) {
  if (typeof skillService?.list !== 'function') return { available: false, registered: false }
  try {
    const summaries = await skillService.list()
    const found = summaries.find(summary => summary.name === SKILL_NAME)
    return found === undefined
      ? { available: true, registered: false }
      : { available: true, registered: true, name: found.name, source: found.source, provider: found.provider }
  } catch (cause) {
    return { available: true, registered: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/* ──────────────────────────────── plugin ───────────────────────────────── */

export async function apply(ctx, config) {
  const deps = { ctx, config: config ?? {} }
  const { defineTool, decodeStorageRecord } = await loadHostModules()
  const helpers = { decodeStorageRecord }

  const call = async (request) => {
    try {
      return { ok: true, value: await runOp(deps, request, helpers) }
    } catch (cause) {
      return { ok: true, value: { ok: false, error: cause instanceof Error ? cause.message : String(cause) } }
    }
  }

  // ─── HTTP route for the browser half (fenced) ─────────────────────────
  // `webServer` is optional AND may register after this plugin: a bundle-layer
  // row mounts during the initial tree load, before the webserver service
  // exists. `ctx.inject` waits for it, so a web profile gets the route while a
  // headless profile never runs this block.
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer')
    const webRuntime = webCtx.get('webRuntime')
    webCtx.effect(() => webServer.register({
      kind: 'exact',
      path: API_PATH,
      handler: async (req, res) => {
        if (!isTrustedApiRequest(req.headers, webRuntime?.trustedHosts ?? [])) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
          return
        }
        const chunks = []
        let total = 0
        for await (const chunk of req) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          total += buffer.length
          if (total > API_BODY_LIMIT) {
            writeJson(res, 413, { ok: false, error: { code: 'body-too-large', message: 'request body too large' } })
            return
          }
          chunks.push(buffer)
        }
        const text = Buffer.concat(chunks).toString('utf8')
        let request = { op: 'status' }
        if (text.trim().length > 0) {
          try {
            request = JSON.parse(text)
          } catch {
            writeJson(res, 400, { ok: false, error: { code: 'params-invalid', message: 'parameters must be JSON' } })
            return
          }
        }
        writeJson(res, 200, await call(request))
      },
    }), 'dsh-session-log-repair: API route')
  })

  // ─── Command surface (JSON ops, same as the route) ────────────────────
  ctx.inject(['commands'], (commandCtx) => {
    const commands = commandCtx.get('commands')
    commandCtx.effect(() => commands.register({
      name: 'dsh-session-log-repair',
      description: 'DSH 会话日志修复：扫描/修复 seq 冲突导致的“历史加载失败”。'
        + 'Scan and repair DSH session logs whose committed region has a seq collision. '
        + '参数为 JSON：{ "op": "scan|repair|verify|status", "session": "<id 或唯一前缀>", "all": true, "dryRun": true }。',
      input: { hint: '{"op":"scan"}' },
      recordInput: true,
      handler: async (invocation) => {
        const raw = (invocation.rawInput ?? '').trim()
        let request = { op: 'status' }
        if (raw.length > 0) {
          try {
            request = JSON.parse(raw)
          } catch {
            return { kind: 'error', text: JSON.stringify({ ok: false, code: 'params-invalid', error: 'parameters must be JSON' }) }
          }
        }
        const envelope = await call(request)
        return { kind: envelope.value.ok === false ? 'error' : 'success', text: JSON.stringify(envelope.value) }
      },
    }), 'dsh-session-log-repair: command')
  })

  // ─── Bundled skill (doctrine + offline scripts) ───────────────────────
  // The skill ships in this package, so installing the plugin also activates
  // it: `ctx.skills` merges this global-layer runtime entry into every agent's
  // catalog. `skills` is optional and, like `webServer`, may register after
  // this plugin.
  ctx.inject(['skills'], (skillCtx) => {
    const skills = skillCtx.get('skills')
    let skill
    try {
      skill = loadBundledSkill()
    } catch (cause) {
      // A missing or malformed bundled file is a packaging error; the tools and
      // route still work, so report it instead of failing the whole plugin.
      skillCtx.logger.warn(`dsh-session-log-repair: skill not registered — ${cause instanceof Error ? cause.message : String(cause)}`)
      return
    }
    skillCtx.effect(() => skills.register(skill), 'dsh-session-log-repair: skill')
  })

  // ─── Model tools ─────────────────────────────────────────────────────
  const text = () => ({
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  })

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dsh_session_log_repair_scan',
    description: '扫描本机所有 DSH 会话日志，列出可加载状态；seq 冲突（历史加载失败）的会话会被标为 corrupt。'
      + ' Scan every stored DSH session log and report which ones fail to load; a seq collision is reported as corrupt.',
    parameters: {},
    output: text(),
    async execute() {
      const report = await runOp(deps, { op: 'scan' }, helpers)
      if (report.total === 0) return `未找到会话日志（root: ${report.root}） / no session log found (root: ${report.root})`
      const bad = report.sessions.filter(session => session.status !== 'ok' && session.status !== 'live')
      const lines = [`root: ${report.root}`, `共 ${report.total} 个会话，损坏 ${report.corrupt} 个，耗时 ${report.durationMs} ms`
        + ` / ${report.total} session(s), ${report.corrupt} corrupt, ${report.durationMs} ms`]
      for (const session of bad) {
        lines.push(`  ${session.status.padEnd(10)} ${session.id}${session.message === undefined ? '' : ` — ${session.message}`}`)
      }
      return lines.join('\n')
    },
  })), 'dsh-session-log-repair: tool dsh_session_log_repair_scan')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dsh_session_log_repair_apply',
    description: '修复 DSH 会话日志的 seq 冲突与尾部不完整记录：保留与文件末尾相连的存活写入者链，丢弃重叠的旧版本行。'
      + ' Repair a DSH session log seq collision or a torn trailing record: keep the writer chain that reaches the end of the file and drop the overlapping older version. '
      + '默认只修一个会话（session），all=true 修全部可修复项，dryRun=true 只预览不写盘。',
    parameters: {
      session: { type: 'string', description: '会话 id 或唯一前缀 / session id or unique prefix (omit with all: true)' },
      all: { type: 'boolean', description: '修复所有可修复会话 / repair every repairable session' },
      dryRun: { type: 'boolean', description: '只预览，不写盘 / preview only, write nothing' },
      force: { type: 'boolean', description: '即使该会话在本进程内处于活动状态也修复（危险）/ repair even when live in this process (dangerous)' },
    },
    output: text(),
    async execute(args) {
      const report = await runOp(deps, {
        op: 'repair',
        session: args.session,
        all: args.all === true,
        dryRun: args.dryRun === true,
        force: args.force === true,
      }, helpers)
      const lines = [report.dryRun ? '[dry run]' : `修复 ${report.repaired} 个 / repaired ${report.repaired}`]
      for (const result of report.results) {
        if (result.message !== undefined && result.repaired !== true && result.clean !== true) {
          lines.push(`  ✗ ${result.id} — ${result.message}`)
          continue
        }
        if (result.clean === true) {
          lines.push(`  · ${result.id} 无冲突 / clean (${result.eventsBefore} events)`)
          continue
        }
        lines.push(`  ✓ ${result.id}: ${result.eventsBefore} → ${result.eventsAfter} events (max seq ${result.maxSeq})`
          + `，丢弃 ${result.dropped.length} 行 / dropped ${result.dropped.length} row(s)`
          + (result.tornBytes > 0
            ? `，丢弃尾部不完整记录 ${result.tornBytes} 字节 / dropped a ${result.tornBytes}-byte torn tail`
            : ''))
        for (const row of result.dropped) {
          lines.push(`      ${row.kind.padEnd(18)} line ${row.fileLine} ${row.type} seq ${row.seq[0]}..${row.seq[1]}`)
        }
        if (result.backup !== undefined) lines.push(`      backup: ${result.backup}`)
      }
      return lines.join('\n')
    },
  })), 'dsh-session-log-repair: tool dsh_session_log_repair_apply')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dsh_session_log_repair_verify',
    description: '用宿主真实加载路径复检会话日志能否加载（验收修复结果）。'
      + ' Re-load session logs through the host backend to confirm they are readable.',
    parameters: {
      session: { type: 'string', description: '会话 id 或唯一前缀；省略则复检全部 / session id or unique prefix; omit to verify every session' },
    },
    output: text(),
    async execute(args) {
      const report = await runOp(deps, { op: 'verify', session: args.session }, helpers)
      const lines = [`通过 ${report.verified}/${report.total} / ${report.verified}/${report.total} loadable`]
      for (const result of report.results) {
        if (result.ok) {
          lines.push(`  ✓ ${result.id}: ${result.events} events, last ${result.lastEvent?.type ?? '?'} seq ${result.lastEvent?.seq ?? '?'}`
            + (result.torn ? ' (torn tail recovered)' : ''))
        } else {
          lines.push(`  ✗ ${result.id} — ${result.message}`)
        }
      }
      return lines.join('\n')
    },
  })), 'dsh-session-log-repair: tool dsh_session_log_repair_verify')
}

/** Load the two host packages this plugin builds on. */
async function loadHostModules() {
  const [tools, session] = await Promise.all([
    loadHostPackage('@deepseek-ai/dsh-tools'),
    loadHostPackage('@deepseek-ai/dsh-session'),
  ])
  if (typeof tools.defineTool !== 'function') {
    throw new Error('@deepseek-ai/dsh-tools does not export defineTool')
  }
  if (typeof session.decodeStorageRecord !== 'function') {
    throw new Error('@deepseek-ai/dsh-session does not export decodeStorageRecord')
  }
  return { defineTool: tools.defineTool, decodeStorageRecord: session.decodeStorageRecord }
}

/** Exported for tests: the pure repair planner. */
export const __internals = { parseLog, planRepair, buildContent, encodeLog, verifyDense }
