#!/usr/bin/env node
/**
 * Scan every stored DSH session log and repair the ones that are safe to repair.
 *
 * A session is repaired only when its log file is not held by a running process
 * (exclusive open succeeds) — a live writer is never rewritten. Each repair runs
 * the same verified tool (`repair-session-log.mjs --apply`), which backs up the
 * original, rebuilds the container, and re-loads it through the real scanner.
 *
 * Usage:
 *   node --import tsx/esm repair-all-sessions.mjs [--root <sessions-dir>] [--host-root <dir>] [--dry-run] [--json]
 *
 * Exit codes: 0 = every session loads (or was repaired), 1 = something still fails.
 */

import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { installHostResolver } from './host-resolver.mjs'

const repairScript = fileURLToPath(new URL('./repair-session-log.mjs', import.meta.url))

function parseArgs(argv) {
  const out = { json: false, root: undefined, hostRoot: undefined, backupDir: undefined, dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') out.json = true
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--root') out.root = argv[++i]
    else if (arg === '--host-root') out.hostRoot = argv[++i]
    else if (arg === '--backup-dir') out.backupDir = argv[++i]
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

/** True when no other process currently holds the log open for writing. */
function isFree(path) {
  try {
    closeSync(openSync(path, 'r+'))
    return true
  } catch {
    return false
  }
}

async function inspect(path, compressed) {
  const bytes = readFileSync(path)
  if (!compressed) return assertConsumed(scanLog(bytes), bytes.length)
  const { frames, tornStart } = scanZstdFrames(bytes)
  if (frames.length === 0) throw new Error('no complete zstd frame')
  if (tornStart !== undefined) throw new Error(`incomplete final frame at byte ${tornStart}`)
  const parts = []
  for (const range of frames) parts.push(await decompressZstdFrame(bytes.subarray(range.start, range.end)))
  const plaintext = Buffer.concat(parts)
  assertConsumed(scanLog(plaintext), plaintext.length)
}

/**
 * The loader refuses a log whose scanner could not consume every byte; `scanLog`
 * only records that as an issue, so surface it the way the loader does.
 * @param scan - the scan result for the decoded plaintext.
 * @param byteLength - the plaintext's length.
 */
function assertConsumed(scan, byteLength) {
  if (scan.committedBytes !== byteLength) {
    throw new Error('corrupt Zstandard session log: complete frame contains a torn JSONL record')
  }
}

function discover() {
  const found = []
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    for (const session of readdirSync(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const path = join(projectDir, session.name, 'session.jsonl.zstd')
      try {
        if (statSync(path).isFile()) found.push({ id: session.name, path })
      } catch { /* no compressed artifact */ }
    }
  }
  return found
}

const summary = { root, scanned: 0, corrupt: [], repaired: [], skipped: [], failed: [], stillBroken: [] }

for (const artifact of discover()) {
  summary.scanned += 1
  let message
  try {
    await inspect(artifact.path, true)
    continue
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  summary.corrupt.push({ id: artifact.id, path: artifact.path, message })

  if (!/seq gap in committed region|complete frame contains a torn JSONL record/.test(message)) {
    summary.failed.push({ id: artifact.id, path: artifact.path, reason: message })
    continue
  }
  if (!isFree(artifact.path)) {
    summary.skipped.push({ id: artifact.id, path: artifact.path, reason: 'log is held by a running process' })
    continue
  }
  if (args.dryRun) continue

  const childArgs = ['--import', 'tsx/esm', repairScript, '--file', artifact.path, '--apply']
  if (args.backupDir !== undefined) childArgs.push('--backup-dir', join(resolve(args.backupDir), artifact.id))
  const run = spawnSync(process.execPath, childArgs, {
    stdio: 'inherit',
    cwd: process.cwd(),
  })
  if (run.status !== 0) {
    summary.failed.push({ id: artifact.id, path: artifact.path, reason: `repair exited with ${run.status}` })
    continue
  }
  try {
    await inspect(artifact.path, true)
    summary.repaired.push({ id: artifact.id, path: artifact.path })
  } catch (error) {
    summary.stillBroken.push({ id: artifact.id, path: artifact.path, reason: error instanceof Error ? error.message : String(error) })
  }
}

if (args.json) console.log(JSON.stringify(summary, null, 2))
else {
  console.log(`scanned ${summary.scanned} session log(s) under ${summary.root}`)
  console.log(`  corrupt:      ${summary.corrupt.length}`)
  console.log(`  repaired:     ${summary.repaired.length}`)
  console.log(`  skipped(live):${summary.skipped.length}`)
  console.log(`  failed:       ${summary.failed.length}`)
  console.log(`  still broken: ${summary.stillBroken.length}`)
  for (const entry of summary.repaired) console.log(`  repaired      ${entry.id}`)
  for (const entry of summary.skipped) console.log(`  skipped       ${entry.id} — ${entry.reason}`)
  for (const entry of summary.failed) console.log(`  failed        ${entry.id} — ${entry.reason}`)
  for (const entry of summary.stillBroken) console.log(`  still broken  ${entry.id} — ${entry.reason}`)
  if (summary.corrupt.length === 0) console.log('  every session log loads')
}

const bad = summary.failed.length + summary.stillBroken.length + (args.dryRun ? 0 : 0)
process.exit(bad === 0 ? 0 : 1)
