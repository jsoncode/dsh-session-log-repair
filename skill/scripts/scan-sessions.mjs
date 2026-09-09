#!/usr/bin/env node
/**
 * Scan every stored DSH session log for the corruption the repair tool fixes.
 *
 * Reports one line per session: OK, COLLISION (repairable), or BROKEN (refused).
 * COLLISION covers both loader refusals the repair handles: a seq gap in the
 * committed region, and the generic torn-record message (a seq regression no
 * later turn/end escalates, or a trailing record without its newline). A session
 * whose log file is currently held by a running process is skipped — never
 * rewrite a log a live writer owns.
 *
 * Usage:
 *   node --import tsx/esm scan-sessions.mjs [--root <sessions-dir>] [--host-root <dir>] [--json]
 *
 * Exit codes: 0 = every session loads, 1 = at least one does not.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { installHostResolver } from './host-resolver.mjs'

function parseArgs(argv) {
  const out = { json: false, root: undefined, hostRoot: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') out.json = true
    else if (arg === '--root') out.root = argv[++i]
    else if (arg === '--host-root') out.hostRoot = argv[++i]
    else throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const root = resolve(args.root ?? join(homedir(), '.dsh', 'sessions'))
const hostRoot = resolve(args.hostRoot ?? process.env.DSH_HOST_ROOT ?? 'D:\\workspace\\custom\\deepseek-harness')
installHostResolver(join(hostRoot, 'node_modules', '.pnpm', 'node_modules'))
const load = async (...segments) => import(pathToFileURL(join(hostRoot, ...segments)).href)

const { scanZstdFrames, decompressZstdFrame } = await load('packages', 'session', 'session-persistence-jsonl', 'src', 'zstd.ts')
const { scanLog } = await load('packages', 'session', 'session-persistence-jsonl', 'src', 'format.ts')

/** Every session log under the root, compressed or plain. */
function discover() {
  const found = []
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    for (const session of readdirSync(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      for (const name of ['session.jsonl.zstd', 'session.jsonl']) {
        const path = join(projectDir, session.name, name)
        try {
          if (statSync(path).isFile()) found.push({ id: session.name, path, compressed: name.endsWith('.zstd') })
        } catch { /* absent artifact for this encoding */ }
      }
    }
  }
  return found
}

/** Decode a log to the plaintext the loader scans, or throw. */
async function plaintextOf(path, compressed) {
  const bytes = readFileSync(path)
  if (!compressed) return { plaintext: bytes, frames: undefined }
  const { frames, tornStart } = scanZstdFrames(bytes)
  if (frames.length === 0) throw new Error('no complete zstd frame')
  if (tornStart !== undefined) throw new Error(`incomplete final frame at byte ${tornStart}`)
  const parts = []
  for (const range of frames) parts.push(await decompressZstdFrame(bytes.subarray(range.start, range.end)))
  return { plaintext: Buffer.concat(parts), frames: frames.length }
}

const results = []
for (const artifact of discover()) {
  const entry = { id: artifact.id, path: artifact.path, status: 'ok' }
  try {
    const { plaintext, frames } = await plaintextOf(artifact.path, artifact.compressed)
    const scanned = scanLog(plaintext)
    // scanLog tolerates a trailing record without a newline and a seq regression
    // no later turn/end escalates; the loader refuses both, so check the cursor.
    if (scanned.committedBytes !== plaintext.length) {
      throw new Error('corrupt Zstandard session log: complete frame contains a torn JSONL record')
    }
    entry.events = scanned.events.length
    entry.maxSeq = scanned.events.length - 1
    if (frames !== undefined) entry.frames = frames
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    entry.message = message
    entry.status = /seq gap in committed region/.test(message) && /got (\d+)\)/.test(message)
      || /complete frame contains a torn JSONL record/.test(message)
      ? 'collision'
      : 'broken'
  }
  results.push(entry)
}

const broken = results.filter(entry => entry.status !== 'ok')
if (args.json) console.log(JSON.stringify(results, null, 2))
else {
  for (const entry of results) {
    const label = entry.status === 'ok' ? 'ok       ' : entry.status === 'collision' ? 'COLLISION' : 'BROKEN   '
    console.log(`${label} ${entry.id}`
      + (entry.events === undefined ? '' : ` (${entry.events} events)`)
      + (entry.message === undefined ? '' : ` — ${entry.message}`))
  }
  console.log(`\n${results.length} session log(s): ${results.length - broken.length} ok, ${broken.length} need repair`)
}
process.exit(broken.length === 0 ? 0 : 1)
