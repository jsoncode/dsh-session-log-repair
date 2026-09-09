/**
 * dsh-session-repair — build a synthetic corrupt session for end-to-end tests
 * (development only; never run against a real session id).
 *
 * Decodes a known-corrupt log, rewrites its header id, and stores it under the
 * sessions root as `<root>/<projectKey(cwd)>/<id>/session.jsonl.zstd`.
 *
 * Run from the DSH checkout:
 *   cd <deepseek-harness> && node --import tsx/esm <plugin>/scripts/make-corrupt-session.mts <corrupt.jsonl.zstd> <root>
 * Prints the new session id and its file path.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { __internals } from '../lib/index.js'

const hostRoot = process.env.DSH_HOST_ROOT ?? 'D:\\workspace\\custom\\deepseek-harness'
const load = async (...segments) => import(pathToFileURL(join(hostRoot, ...segments)).href)
const { scanZstdFrames, decompressZstdFrame } = await load('packages', 'session', 'session-persistence-jsonl', 'src', 'zstd.ts')

const [source, root] = process.argv.slice(2)
if (source === undefined || root === undefined) {
  throw new Error('usage: make-corrupt-session.mts <corrupt.jsonl.zstd> <sessions-root>')
}

const bytes = readFileSync(source)
const { frames } = scanZstdFrames(bytes)
const parts = []
for (const range of frames) parts.push(await decompressZstdFrame(bytes.subarray(range.start, range.end)))
const content = Buffer.concat(parts).toString('utf8')

const newline = content.indexOf('\n')
const header = JSON.parse(content.slice(0, newline))
const id = `session-${randomUUID()}`
header.id = id
const rewritten = `${JSON.stringify(header)}\n${content.slice(newline + 1)}`

// The backend locates a log by projectKey(cwd) + id, so the fixture must sit
// exactly where the header's own cwd points.
const dir = join(root, projectKey(String(header.cwd)), id)
mkdirSync(dir, { recursive: true })
const file = join(dir, 'session.jsonl.zstd')
writeFileSync(file, __internals.encodeLog(rewritten, 'zstd'))
console.log(id)
console.log(file)

/** Mirror of the backend's project directory encoding. */
function projectKey(cwd: string): string {
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
