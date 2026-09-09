/**
 * dsh-session-log-repair — self test (development only).
 *
 * Round-trips the pure repair planner over a real corrupt log:
 * decode frames (host source) → parse rows → plan → rebuild → re-encode with
 * Node zstd → decode again (host source) → scanLog must accept the result and
 * the repaired log must contain the surviving writer's rows.
 *
 * Run from the DSH checkout so `tsx` resolves:
 *   cd <deepseek-harness> && node --import tsx/esm <plugin>/scripts/selftest.mts <corrupt.jsonl.zstd>
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { __internals } from '../lib/index.js'

const hostRoot = process.env.DSH_HOST_ROOT ?? 'D:\\workspace\\custom\\deepseek-harness'
const profileRoot = process.env.DSH_PROFILE_ROOT ?? join(process.env.DSH_HOME ?? 'C:\\Users\\13485\\.dsh', 'profiles')
const load = async (...segments) => import(pathToFileURL(join(hostRoot, ...segments)).href)

const { scanZstdFrames, decompressZstdFrame } = await load('packages', 'session', 'session-persistence-jsonl', 'src', 'zstd.ts')
const { scanLog } = await load('packages', 'session', 'session-persistence-jsonl', 'src', 'format.ts')
const sessionModule = await import(pathToFileURL(createRequire(join(profileRoot, 'web', 'package.json')).resolve('@deepseek-ai/dsh-session')).href)
const decodeStorageRecord = sessionModule.decodeStorageRecord

const file = process.argv[2]
if (file === undefined) throw new Error('usage: selftest.mts <corrupt.jsonl.zstd>')
const bytes = readFileSync(file)
const { frames, tornStart } = scanZstdFrames(bytes)
if (tornStart !== undefined) throw new Error('torn final frame')
const parts = []
for (const range of frames) parts.push(await decompressZstdFrame(bytes.subarray(range.start, range.end)))
const content = Buffer.concat(parts).toString('utf8')

const { header, rows } = __internals.parseLog(content, decodeStorageRecord)
console.log(`rows ${rows.length}, events ${rows.reduce((total, row) => total + row.count, 0)}`)

let loadError
try { scanLog(Buffer.from(content)) } catch (error) { loadError = error.message }
console.log(`original load: ${loadError ?? 'ok (not corrupt?)'}`)

const plan = __internals.planRepair(rows)
console.log(`tail starts at ${plan.tailStartsAtSeq}, chain starts at ${plan.chainStart}, dropped ${plan.dropped.length}`)
for (const row of plan.dropped) {
  console.log(`  dropped ${row.kind.padEnd(18)} line ${row.fileLine} ${row.type} seq ${row.base}..${row.end} time ${row.time}`)
}

const rebuilt = __internals.buildContent(header, plan.kept)
const verified = __internals.verifyDense(rebuilt, decodeStorageRecord)
console.log(`rebuilt: ${verified.events} events, max seq ${verified.maxSeq}, ${verified.rows} rows`)

const encoded = __internals.encodeLog(rebuilt, 'zstd')
const recheck = scanZstdFrames(encoded)
if (recheck.tornStart !== undefined) throw new Error('re-encoded layout is not clean')
const reParts = []
for (const range of recheck.frames) reParts.push(await decompressZstdFrame(encoded.subarray(range.start, range.end)))
const decoded = Buffer.concat(reParts).toString('utf8')
if (decoded !== rebuilt) throw new Error('re-encoded bytes do not round-trip')
const scanned = scanLog(Buffer.from(decoded))
console.log(`repaired load: ok, ${scanned.events.length} events, max seq ${scanned.events.length - 1}`)
if (scanned.events.length !== verified.events) throw new Error('scanLog count mismatch')
const frame1 = await decompressZstdFrame(encoded.subarray(recheck.frames[0].start, recheck.frames[0].end))
if (frame1.toString('utf8') !== `${header}\n`) throw new Error('frame 1 is not exactly the header line')
console.log('frame 1: header line only ✓')
console.log('SELFTEST OK')
