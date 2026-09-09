#!/usr/bin/env node
/**
 * Repair a DSH JSONL session log whose committed region contains a seq
 * collision: two writers appended different events under the same `seq` values.
 *
 * Typical cause: a live writer stalls (LLM retry backoff, hung tool), another
 * process resumes/inspects the same session, sees an open turn and commits
 * synthetic repair events (interrupted tool result, `step/end`,
 * `turn/end{interrupted}`, `session/end-seed`), then the original writer wakes up
 * with its counter still behind the file and appends its real events on top.
 *
 * The loader (`SessionLogScanner`) requires every committed event row to carry
 * `seq === events.length` and refuses the whole log on the first violation, so a
 * single collision makes the session unloadable ("历史加载失败").
 *
 * Two loader messages reach this tool:
 *   - `seq gap in committed region at line N (expected X, got Y)` when the
 *     colliding row or a later row carries `turn/end`;
 *   - `complete frame contains a torn JSONL record` otherwise, and also when a
 *     record's newline never landed inside an otherwise complete frame. The
 *     second case needs only the trailing partial record removed.
 *
 * Repair rule: the surviving tail is the maximal dense run that reaches the end
 * of the file — it belongs to the writer that produced the rest of the log. Every
 * earlier row whose seq range reaches into that tail's start seq duplicates it
 * and is dropped; the rows before them must form a dense prefix. Repair synthesis
 * is classified only for reporting; the decision uses tail continuity, which also
 * holds when both competing versions are real live writes.
 *
 * Usage:
 *   node --import tsx/esm repair-session-log.mjs --file <session.jsonl.zstd>            # dry run
 *   node --import tsx/esm repair-session-log.mjs --file <session.jsonl.zstd> --apply    # write
 *
 * Options:
 *   --file <path>       session log to repair (required)
 *   --apply             actually rewrite the file (default: dry run, nothing written)
 *   --backup-dir <dir>  where the pre-repair copy goes (default: <cwd>/.session-backups/<id>-<ts>)
 *   --host-root <dir>   deepseek-harness checkout (default: $DSH_HOST_ROOT or D:\workspace\custom\deepseek-harness)
 *   --json              print the machine-readable report as JSON
 *
 * Exit codes: 0 = ok (dry run: repairable; apply: repaired+verified), 1 = refused/failed.
 */

import {
  copyFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/* ------------------------------------------------------------------ args --- */

function parseArgs(argv) {
  const out = { apply: false, json: false, file: undefined, backupDir: undefined, hostRoot: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') out.apply = true
    else if (arg === '--json') out.json = true
    else if (arg === '--file') out.file = argv[++i]
    else if (arg === '--backup-dir') out.backupDir = argv[++i]
    else if (arg === '--host-root') out.hostRoot = argv[++i]
    else if (arg === '--help' || arg === '-h') {
      console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0])
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  if (out.file === undefined) throw new Error('--file <session.jsonl.zstd> is required')
  return out
}

const args = parseArgs(process.argv.slice(2))
const logPath = resolve(args.file)
const hostRoot = resolve(args.hostRoot ?? process.env.DSH_HOST_ROOT ?? 'D:\\workspace\\custom\\deepseek-harness')

/* ------------------------------------------- host primitives (real code) --- */

const host = (...segments) => pathToFileURL(join(hostRoot, ...segments)).href
let zstd
let format
let session
try {
  zstd = await import(host('packages', 'session', 'session-persistence-jsonl', 'src', 'zstd.ts'))
  format = await import(host('packages', 'session', 'session-persistence-jsonl', 'src', 'format.ts'))
  session = await import(host('packages', 'core', 'session', 'src', 'index.ts'))
} catch (error) {
  throw new Error(
    `cannot load host primitives from "${hostRoot}"; pass --host-root or set DSH_HOST_ROOT `
    + `(run with: node --import tsx/esm). cause: ${error.message}`,
  )
}
const { scanZstdFrames, decompressZstdFrame, compressZstdFrame } = zstd
const { scanLog } = format
const { decodeStorageRecord } = session

/* --------------------------------------------------------------- helpers --- */

const fail = (message) => { console.error(`\n[refused] ${message}`); process.exit(1) }

/** Expand one storage row into its events using the host decoder. */
function rowEvents(row, fileLine) {
  try {
    return decodeStorageRecord(row)
  } catch (error) {
    fail(`unparsable committed event row at file line ${fileLine}: ${error.message}`)
  }
}

/**
 * Split one frame's plaintext into complete JSONL records. Only the last
 * complete frame may end mid-record: a later frame would have continued that
 * record, so there a missing newline is a record split across frames, which this
 * tool does not reconstruct.
 * @param plaintext - the frame's decompressed bytes.
 * @param frameIndex - frame ordinal, for diagnostics.
 * @param isLast - whether this is the last complete frame in the file.
 * @returns the frame's complete records.
 */
function frameLines(plaintext, frameIndex, isLast) {
  if (plaintext.length === 0) return []
  let bytes = plaintext
  if (bytes[bytes.length - 1] !== 0x0A) {
    if (!isLast) {
      fail(`frame ${frameIndex} does not end on a line boundary and a later frame follows; `
        + 'this log splits a record across frames, which this tool does not reconstruct')
    }
    const lastNewline = bytes.lastIndexOf(0x0A)
    if (lastNewline === -1) fail(`frame ${frameIndex} has no complete record`)
    tornBytes = bytes.length - lastNewline - 1
    bytes = bytes.subarray(0, lastNewline + 1)
  }
  const lines = bytes.toString('utf8').split('\n')
  lines.pop()
  return lines
}

/** Classify a row for the report only; the repair decision never uses this. */
function classify(events) {
  if (events.some(event => event.type === 'session/end-seed')) return 'resume-marker'
  if (events.some(event => event.type === 'turn/end' && event.data?.reason?.kind === 'interrupted')) return 'repair-closer'
  if (events.some(event => event.type === 'tool/result'
    && String(event.data?.message?.id ?? '').startsWith('interrupted-tool-result-'))) return 'repair-tool-result'
  return 'live'
}

/** Write bytes durably to a temp sibling, then atomically publish over the target. */
function publishAtomically(target, bytes) {
  const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, target)
}

/* ------------------------------------------------------------ 1. decode --- */

const original = readFileSync(logPath)
const { frames, tornStart } = scanZstdFrames(original)
if (frames.length === 0) fail('no complete zstd frame found; not a DSH session log')
if (tornStart !== undefined) {
  fail(`the log has an incomplete final frame at byte ${tornStart}; open or resume the session once so the `
    + 'writer flushes a complete frame, then rerun (this tool repairs complete frames only)')
}

/** Bytes dropped from the end of the last complete frame (a record without its newline). */
let tornBytes = 0

const plaintexts = []
for (const range of frames) plaintexts.push(await decompressZstdFrame(original.subarray(range.start, range.end)))

if (plaintexts[0].length === 0 || plaintexts[0][plaintexts[0].length - 1] !== 0x0A
  || plaintexts[0].subarray(0, -1).includes(0x0A)) {
  fail('frame 1 is not exactly one header line; this log was not produced by the JSONL backend')
}
const headerLine = plaintexts[0].toString('utf8')

/** Every event row in file order, with the seq range it covers. */
const rows = []
let fileLine = 1
for (let index = 1; index < plaintexts.length; index += 1) {
  for (const line of frameLines(plaintexts[index], index, index === plaintexts.length - 1)) {
    fileLine += 1
    let parsed
    try { parsed = JSON.parse(line) } catch (error) {
      fail(`unparsable JSON at file line ${fileLine}: ${error.message}`)
    }
    const events = rowEvents(parsed, fileLine)
    if (events.length === 0) fail(`row at file line ${fileLine} expands to zero events`)
    rows.push({
      index: rows.length,
      frame: index,
      fileLine,
      line,
      type: parsed.type,
      events,
      base: events[0].seq,
      end: events[events.length - 1].seq,
      count: events.length,
      time: events[0].time,
      lastTime: events[events.length - 1].time,
      kind: classify(events),
    })
  }
}

/* --------------------------------------------- 2. the surviving tail -------- */

// Report-only refinement: a `step/end` that shares its timestamp with the repair
// closer that follows it is part of the same synthetic pair.
for (let i = 0; i < rows.length - 1; i += 1) {
  if (rows[i].type === 'step/end' && rows[i + 1].kind === 'repair-closer' && rows[i].time === rows[i + 1].time) {
    rows[i].kind = 'repair-closer'
  }
}

// The tail is the maximal dense run that reaches the file end. The writer that
// produced it also produced the rows immediately before it, so an earlier row
// whose range reaches the tail's first seq is a duplicate of tail content.
let tailStart = rows.length - 1
let S = rows[tailStart].base
while (tailStart - 1 >= 0 && rows[tailStart - 1].end === S - 1) {
  tailStart -= 1
  S = rows[tailStart].base
}
if (tailStart === 0 && tornBytes === 0) {
  console.log(`[clean] no seq collision: ${rows.length} rows, ${rows.reduce((t, r) => t + r.count, 0)} events, `
    + `max seq ${rows[rows.length - 1].end}`)
  process.exit(0)
}

// Walk backwards from the tail, extending the survivor chain while a row ends
// exactly where the chain starts; a row that reaches into the chain duplicates
// it and is dropped; a row that ends before the chain leaves a real gap.
let chainStart = S
const dropped = []
let stopIndex = -1
for (let i = tailStart - 1; i >= 0; i -= 1) {
  const row = rows[i]
  if (row.end === chainStart - 1) { chainStart = row.base; continue }
  if (row.end >= chainStart) {
    // A row that starts inside the chain and ends outside it would lose unique
    // events if dropped; that needs a human, not a heuristic.
    if (row.base < chainStart) {
      fail(`file line ${row.fileLine} spans seqs ${row.base}..${row.end} across the survivor chain start ${chainStart}; `
        + 'refusing to guess')
    }
    dropped.push(row)
    continue
  }
  stopIndex = i
  break
}

// Anything the backward walk did not reach must still form a dense prefix.
if (stopIndex >= 0) {
  let expected = 0
  for (const row of rows.slice(0, stopIndex + 1)) {
    if (row.base !== expected) {
      fail(`log is not dense at file line ${row.fileLine}: expected seq ${expected}, got ${row.base} `
        + '(this tool repairs seq collisions only; a missing row needs different recovery)')
    }
    expected += row.count
  }
  if (expected !== chainStart) {
    fail(`prefix ends at seq ${expected - 1} but the survivor chain starts at ${chainStart}; refusing to guess`)
  }
} else if (chainStart !== 0) {
  fail(`survivor chain starts at seq ${chainStart}, not 0; refusing to guess`)
}

if (dropped.length === 0 && tornBytes === 0) {
  console.log(`[clean] no seq collision: ${rows.length} rows, ${rows.reduce((t, r) => t + r.count, 0)} events, `
    + `max seq ${rows[rows.length - 1].end}`)
  process.exit(0)
}
if (dropped.length > 512) fail(`collision involves ${dropped.length} rows; too large to resolve safely`)

const droppedIndexes = new Set(dropped.map(row => row.index))
const keptRows = rows.filter(row => !droppedIndexes.has(row.index))

/* ------------------------------------------------------------ 3. rebuild --- */

const keptPlaintext = `${headerLine}${keptRows.map(row => row.line).join('\n')}\n`

// Preserve the container layout: header frame first, then one frame per original
// event frame that still has rows. Emptied frames are dropped entirely.
const perFrame = new Map()
for (const row of keptRows) {
  if (!perFrame.has(row.frame)) perFrame.set(row.frame, [])
  perFrame.get(row.frame).push(row.line)
}
const segments = [headerLine]
for (const frameIndex of [...perFrame.keys()].sort((a, b) => a - b)) {
  segments.push(`${perFrame.get(frameIndex).join('\n')}\n`)
}
const rebuiltFrames = []
for (const segment of segments) rebuiltFrames.push(await compressZstdFrame(segment))
const repaired = Buffer.concat(rebuiltFrames)

/* ------------------------------------------------------------ 4. verify --- */

let originalError
const originalPlaintext = Buffer.concat(plaintexts)
try {
  const scan = scanLog(originalPlaintext)
  // scanLog tolerates a trailing record without a newline; the loader does not.
  originalError = scan.committedBytes === originalPlaintext.length
    ? undefined
    : 'corrupt Zstandard session log: complete frame contains a torn JSONL record'
} catch (error) { originalError = error.message }

let loaded
try { loaded = scanLog(Buffer.from(keptPlaintext)) } catch (error) {
  fail(`repaired log still fails to load: ${error.message}`)
}
const events = loaded.events
const keptCount = keptRows.reduce((total, row) => total + row.count, 0)
if (events.length !== keptCount) fail(`repaired event count ${events.length} != kept count ${keptCount}`)
for (let i = 0; i < events.length; i += 1) {
  if (events[i].seq !== i) fail(`repaired log is not dense at event ${i} (seq ${events[i].seq})`)
}
if (loaded.committedBytes !== Buffer.byteLength(keptPlaintext)) fail('repaired log contains trailing bytes after the last record')

const recheck = scanZstdFrames(repaired)
if (recheck.tornStart !== undefined) fail('repaired frame layout is not clean')
if (!(await decompressZstdFrame(repaired.subarray(recheck.frames[0].start, recheck.frames[0].end))).equals(plaintexts[0])) {
  fail('repaired frame 1 is no longer the original header frame')
}

/* ------------------------------------------------------------- 5. report --- */

const describe = (row) => ({
  fileLine: row.fileLine, frame: row.frame, type: row.type, seq: [row.base, row.end], kind: row.kind, time: row.time,
})
const report = {
  file: logPath,
  collision: dropped.length === 0 ? undefined : {
    tailStartsAtSeq: S,
    survivorChainStartsAtSeq: chainStart,
    droppedSeqs: [Math.min(...dropped.map(row => row.base)), Math.max(...dropped.map(row => row.end))],
    droppedRows: dropped.length,
  },
  tornTailBytes: tornBytes,
  survivor: describe(rows[tailStart]),
  dropped: dropped.map(describe),
  bytes: { before: original.length, after: repaired.length },
  frames: { before: frames.length, after: recheck.frames.length },
  events: { before: rows.reduce((total, row) => total + row.count, 0), after: events.length, maxSeq: events.length - 1 },
  originalError,
  applied: false,
  backup: undefined,
}

if (!args.json) {
  console.log(`file            ${logPath}`)
  console.log(`original error  ${originalError ?? '(none reported by scanLog)'}`)
  console.log(`surviving tail  starts at seq ${S} with ${rows[tailStart].type} (time ${rows[tailStart].time})`)
  console.log(`frames          ${frames.length} -> ${recheck.frames.length}`)
  console.log(`events          ${report.events.before} -> ${events.length} (max seq ${events.length - 1})`)
  console.log(`bytes           ${original.length} -> ${repaired.length}`)
  if (tornBytes > 0) {
    console.log(`torn tail       ${tornBytes} byte(s) without a closing newline dropped from the last frame`)
  }
  console.log(`\ndropped (${dropped.length} rows duplicating the surviving writer's chain):`)
  for (const row of report.dropped) {
    console.log(`  ${row.kind.padEnd(18)} frame ${String(row.frame).padStart(5)} / file line ${row.fileLine}: `
      + `${row.type} seq ${row.seq[0]}..${row.seq[1]} time ${row.time}`)
  }
}

if (!args.apply) {
  if (args.json) console.log(JSON.stringify(report, null, 2))
  console.log('\n[dry run] nothing written. Re-run with --apply to repair (the app should be closed).')
  process.exit(0)
}

/* -------------------------------------------------------------- 6. apply --- */

const sessionId = loaded.meta?.id ?? 'session'
const backupDir = resolve(args.backupDir ?? join(process.cwd(), '.session-backups', `${sessionId}-${Date.now()}`))
mkdirSync(backupDir, { recursive: true })
const backupPath = join(backupDir, `${sessionId}.jsonl.zstd.orig`)
copyFileSync(logPath, backupPath)

const before = statSync(logPath)
if (before.size !== original.length) fail(`log changed while inspecting (size ${before.size} != ${original.length}); close the app and rerun`)

publishAtomically(logPath, repaired)

const after = readFileSync(logPath)
if (!after.equals(repaired)) fail('published bytes do not match the verified repair output')
// Final gate: decode the published file exactly like the backend does.
const afterScan = scanZstdFrames(after)
if (afterScan.tornStart !== undefined) fail('published file ends with an incomplete frame')
const afterPlaintext = []
for (const range of afterScan.frames) afterPlaintext.push(await decompressZstdFrame(after.subarray(range.start, range.end)))
scanLog(Buffer.concat(afterPlaintext))

report.applied = true
report.backup = backupPath
if (args.json) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`\n[repaired] ${logPath}`)
  console.log(`backup          ${backupPath}`)
  console.log(`events          ${events.length}, max seq ${events.length - 1}`)
  console.log('reload the session in DSH; history should load normally.')
}
process.exit(0)
