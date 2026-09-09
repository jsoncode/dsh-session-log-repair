/**
 * dsh-session-repair — host package resolution for the test scripts.
 *
 * The tests must load the *same* host instances the running host uses, and they
 * must also run on a clean checkout (CI) where no DSH profile exists. Resolution
 * therefore tries, in order:
 *   1. every DSH profile's `package.json` (the running host's own copy);
 *   2. this package's own `package.json` (the devDependencies).
 *
 * `lib/index.js` resolves host packages in the same order at runtime, so a
 * local `node_modules` can never shadow the copy the host already loaded.
 */

import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Absolute path of this package (the repo root). */
export const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** This package's own `package.json`, the last-resort resolution base. */
export const packageBase = join(packageDir, 'package.json')

/**
 * Resolution bases in preference order.
 * @returns absolute `package.json` paths usable with `createRequire`.
 */
export function hostBases() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const profiles = join(home, 'profiles')
  const bases = []
  try {
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (entry.isDirectory()) bases.push(join(profiles, entry.name, 'package.json'))
    }
  } catch { /* no DSH home here: fall through to this package */ }
  bases.push(join(profiles, 'package.json'))
  bases.push(packageBase)
  return bases
}

/**
 * Return a `require` bound to the first base that can resolve every specifier.
 * @param specifiers - bare specifiers that must all resolve from one base.
 * @returns the bound `require` function.
 */
export function hostRequire(...specifiers) {
  const failures = []
  for (const base of hostBases()) {
    try {
      const require = createRequire(base)
      for (const specifier of specifiers) require.resolve(specifier)
      return require
    } catch (cause) {
      failures.push(`${base}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  throw new Error(`cannot resolve ${specifiers.map(value => `"${value}"`).join(', ')} from any host base:\n`
    + failures.map(line => `  ${line}`).join('\n'))
}

/**
 * Resolve a specifier to an absolute path.
 * @param specifier - bare specifier to resolve.
 * @returns the resolved absolute path.
 */
export function hostResolve(specifier) {
  return hostRequire(specifier).resolve(specifier)
}

/**
 * Import a host package namespace.
 * @param specifier - bare specifier to import.
 * @returns the module namespace.
 */
export async function hostImport(specifier) {
  return import(pathToFileURL(hostResolve(specifier)).href)
}
