/**
 * Module-resolution helper for the repair/verify scripts.
 *
 * The host checkout's pnpm layout only links some workspace dependencies into
 * each package's `node_modules`, so importing host sources directly can fail on
 * a bare specifier that the workspace build resolves through tsconfig paths
 * (for example `zod`). The resolver retries only those failed bare specifiers
 * against pnpm's hoisted directory.
 *
 * Import `installHostResolver` and call it before importing host sources.
 */

import { createRequire, register, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

/** Bare specifiers worth retrying; relative/node:/file:/# never are. */
function isRetryable(specifier) {
  return !(specifier.startsWith('.') || specifier.startsWith('node:') || specifier.startsWith('file:')
    || specifier.startsWith('data:') || specifier.startsWith('#'))
}

function fallbackUrl(specifier, fallbackRequire, originalError) {
  if (!isRetryable(specifier)) throw originalError
  let resolved
  try {
    resolved = fallbackRequire.resolve(specifier)
  } catch {
    throw originalError
  }
  return { url: pathToFileURL(resolved).href, shortCircuit: true }
}

/**
 * Install the fallback resolver for subsequent imports in this process.
 * @param fallbackDir - directory whose `node_modules` resolution is tried second.
 * @returns the mechanism used, for logging.
 */
export function installHostResolver(fallbackDir) {
  const fallbackRequire = createRequire(join(fallbackDir, 'noop.cjs'))
  if (typeof registerHooks === 'function') {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        try {
          return nextResolve(specifier, context)
        } catch (error) {
          return fallbackUrl(specifier, fallbackRequire, error)
        }
      },
    })
    return 'registerHooks'
  }
  process.env.DSH_RESOLVE_FALLBACK = fallbackDir
  register(new URL('./host-resolver.mjs', import.meta.url))
  return 'register'
}

/** Hook entry used only by the legacy out-of-thread `register()` path. */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    const fallbackRequire = createRequire(join(process.env.DSH_RESOLVE_FALLBACK ?? '.', 'noop.cjs'))
    return fallbackUrl(specifier, fallbackRequire, error)
  }
}
