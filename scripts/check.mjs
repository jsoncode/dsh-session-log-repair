/**
 * dsh-session-repair — syntax gate.
 *
 * Runs `node --check` over every shipped `.js` / `.mjs` source file (the host
 * half, the browser half, the test scripts, and the bundled skill's offline
 * toolkit). TypeScript fixtures (`*.mts`) are excluded: they need `tsx` and a
 * harness checkout.
 *
 * Usage: node scripts/check.mjs
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

import { packageDir } from './host-resolve.mjs'

/** Relative paths of every checkable source file. */
function sources() {
  const files = ['lib/index.js', 'lib/client.js']
  for (const dir of ['scripts', join('skill', 'scripts')]) {
    for (const entry of readdirSync(join(packageDir, dir))) {
      if (entry.endsWith('.js') || entry.endsWith('.mjs')) files.push(join(dir, entry))
    }
  }
  return files
}

let failed = 0
for (const file of sources()) {
  const result = spawnSync(process.execPath, ['--check', join(packageDir, file)], { encoding: 'utf8' })
  if (result.status === 0) {
    console.log(`  ok    ${relative('.', file)}`)
  } else {
    failed += 1
    console.error(`  FAIL  ${relative('.', file)}\n${result.stderr.trim()}`)
  }
}
if (failed > 0) throw new Error(`${failed} file(s) failed the syntax check`)
console.log(`CHECK OK — ${sources().length} files`)
