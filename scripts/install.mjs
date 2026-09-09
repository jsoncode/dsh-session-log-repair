/**
 * dsh-session-log-repair — installer (host-side, no build step).
 *
 * Enables the plugin exactly the way `dsh plugin --profile web install <dir>`
 * does, so the desktop app's plugin page and this script agree:
 *
 *   1. `<profile>/node_modules/dsh-session-log-repair` -> this package (junction)
 *   2. `<profile>/package.json` -> dependencies["dsh-session-log-repair"] = "link:<dir>"
 *      (the boot heals the profile's node_modules mirror from declared deps)
 *   3. `<profile>/package.json` -> dsh.profile.bundles += "dsh-session-log-repair"
 *      the boot then applies THIS package's own cordis.patch.yml, which inserts
 *      exactly one loader row.
 *
 * It also strips any insert row this plugin left in the profile's user patch
 * layer (`cordis.patch.yml`). Both layers insert the same entry id, and two
 * rows sharing one id abort the boot with
 * `duplicate loader entry id: dsh-session-log-repair` — which is exactly what
 * happened when the desktop app added the bundle row while the user patch row
 * was still present. One plugin, one enablement mechanism.
 *
 * Usage:
 *   node scripts/install.mjs [--profile web] [--home <dsh-home>] [--uninstall] [--no-verify]
 *
 * The installer never restarts a running host: refresh the browser page for the
 * client half, and restart the host process so the bundle layer mounts.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_NAME = 'dsh-session-log-repair'
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rowPattern = new RegExp(`id:\\s*${PACKAGE_NAME}\\b`)

/** Parse `--flag value` / `--flag` arguments. */
function parseArgs(argv) {
  const options = { profile: 'web', uninstall: false, verify: true }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') options.help = true
    else if (token === '--profile') options.profile = argv[++index]
    else if (token === '--home') options.home = argv[++index]
    else if (token === '--uninstall') options.uninstall = true
    else if (token === '--no-verify') options.verify = false
    else throw new Error(`unknown argument "${token}"`)
  }
  options.home = options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return options
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log([
    `Usage: node scripts/install.mjs [--profile <name>] [--home <dsh-home>] [--uninstall] [--no-verify]`,
    '',
    'Installs dsh-session-log-repair into a DSH profile the way',
    '`dsh plugin --profile <name> install <dir>` does: node_modules link, link:',
    'dependency, and a dsh.profile.bundles row (the bundle patch inserts the',
    'loader row). Any user-patch insert for this plugin is removed, because two',
    'rows sharing one entry id abort the boot.',
    '',
    '  --profile <name>  profile to edit (default: web)',
    '  --home <path>     DSH home (default: $DSH_HOME or ~/.dsh)',
    '  --uninstall       remove the link, dependency, and bundle row',
    '  --no-verify       skip composing the profile through the host loader',
  ].join('\n'))
  process.exit(0)
}
const profileDir = join(options.home, 'profiles', options.profile)
if (!existsSync(profileDir)) {
  throw new Error(`profile "${options.profile}" not found at ${profileDir}; run \`dsh web\` once to create it`)
}
const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME)
const manifestPath = join(profileDir, 'package.json')
const userPatchPath = join(profileDir, 'cordis.patch.yml')
const ownPatchPath = join(packageDir, 'cordis.patch.yml')

/** Read the profile manifest, tolerating a BOM. */
function readManifest() {
  return JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
}

/** Write the profile manifest back with the repo's 2-space + trailing newline shape. */
function writeManifest(manifest) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/**
 * Add or remove the dependency and the `dsh.profile.bundles` row.
 * @param remove - true to uninstall, false to install.
 * @returns a human-readable summary of what changed.
 */
function editManifest(remove) {
  const manifest = readManifest()
  const dependencies = manifest.dependencies = manifest.dependencies ?? {}
  const dsh = manifest.dsh = manifest.dsh ?? {}
  const profile = dsh.profile = dsh.profile ?? {}
  const bundles = profile.bundles = Array.isArray(profile.bundles) ? profile.bundles : []
  const changes = []

  if (remove) {
    if (dependencies[PACKAGE_NAME] !== undefined) {
      delete dependencies[PACKAGE_NAME]
      changes.push('dependency')
    }
    const index = bundles.indexOf(PACKAGE_NAME)
    if (index >= 0) {
      bundles.splice(index, 1)
      changes.push('bundle row')
    }
  } else {
    const specifier = `link:${packageDir.replace(/\\/g, '/')}`
    if (dependencies[PACKAGE_NAME] !== specifier) {
      dependencies[PACKAGE_NAME] = specifier
      changes.push('dependency')
    }
    if (!bundles.includes(PACKAGE_NAME)) {
      bundles.push(PACKAGE_NAME)
      changes.push('bundle row')
    }
  }

  // A name parked in pendingRemovals would delete the dependency at the next boot.
  if (Array.isArray(profile.pendingRemovals)) {
    const kept = profile.pendingRemovals.filter((name) => name !== PACKAGE_NAME)
    if (kept.length !== profile.pendingRemovals.length) {
      changes.push('pendingRemovals')
      if (kept.length === 0) delete profile.pendingRemovals
      else profile.pendingRemovals = kept
    }
  }

  if (changes.length === 0) return 'unchanged'
  writeManifest(manifest)
  return remove ? `removed ${changes.join(' + ')}` : `added ${changes.join(' + ')}`
}

/**
 * Remove every insert row for this plugin from the profile's user patch layer.
 * Always runs (install and uninstall): the bundle layer owns the row now, and a
 * leftover user row would duplicate its id.
 * @returns 'unchanged' or 'removed'.
 */
function stripUserPatch() {
  if (!existsSync(userPatchPath)) return 'unchanged'
  const content = readFileSync(userPatchPath, 'utf8')

  const lines = content.split('\n')
  const kept = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() !== `- id: ${PACKAGE_NAME}`) {
      kept.push(line)
      index += 1
      continue
    }
    // Drop the row's own indented keys...
    index += 1
    while (index < lines.length && /^\s+\S/.test(lines[index]) && !/^\s*-\s+id:/.test(lines[index])) index += 1
    // ...then the `- insert:` header and its contiguous comment run above it.
    while (kept.length > 0) {
      const previous = kept[kept.length - 1].trim()
      if (previous === '' || (previous !== '- insert:' && !previous.startsWith('#'))) break
      kept.pop()
    }
  }
  const body = kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  // Comments alone are not a YAML array; append the explicit empty list.
  const hasRows = body.split('\n').some((line) => /^\s*-\s/.test(line) || line.trim() === '[]')
  const next = hasRows ? `${body}\n` : `${body}${body === '' ? '' : '\n'}[]\n`
  if (next === content) return 'unchanged'
  writeFileSync(userPatchPath, next, 'utf8')
  return 'removed'
}

/** Create or remove the profile node_modules link. */
function editLink(remove) {
  const existing = lstatSync(linkPath, { throwIfNoEntry: false })
  if (remove) {
    if (existing === undefined) return 'unchanged'
    rmSync(linkPath, { recursive: true, force: true })
    return 'removed'
  }
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || existing.isDirectory()) return 'unchanged'
    throw new Error(`${linkPath} exists and is not a link or directory; remove it by hand`)
  }
  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(packageDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  return 'created'
}

/**
 * Resolve the host's app-boot module the way the running host does: first as a
 * bare import, then through the profile's own manifest anchor.
 */
async function loadAppBoot() {
  try {
    return await import('@deepseek-ai/dsh-app-boot')
  } catch {
    const anchor = createRequire(manifestPath)
    return await import(pathToFileURL(anchor.resolve('@deepseek-ai/dsh-app-boot')).href)
  }
}

/**
 * Compose the profile with the host's own loader (`loadProfile` +
 * `composeEntries`, the code behind `dsh --dump-config`) and count our rows.
 * @returns the number of loader rows carrying this plugin's id.
 */
async function composeRowCount() {
  const { loadProfile, composeEntries } = await loadAppBoot()
  const profile = loadProfile('dsh', options.profile, manifestPath, options.home)
  const rows = composeEntries([profile.layers.flatMap((layer) => layer.patches), profile.patches])
  return rows.filter((row) => row.id === PACKAGE_NAME).length
}

/** Fail loud on any state that would break the next boot. */
function verify(installed) {
  const manifest = readManifest()
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const dependencies = manifest.dependencies ?? {}
  const ownRows = (readFileSync(ownPatchPath, 'utf8').match(rowPattern) ?? []).length
  const userRows = existsSync(userPatchPath)
    ? (readFileSync(userPatchPath, 'utf8').match(rowPattern) ?? []).length
    : 0
  const problems = []
  if (ownRows !== 1) problems.push(`${ownPatchPath} must insert exactly one row (found ${ownRows})`)
  if (installed) {
    if (!bundles.includes(PACKAGE_NAME)) problems.push('dsh.profile.bundles is missing the bundle row')
    if (dependencies[PACKAGE_NAME] === undefined) problems.push('dependencies is missing the link: entry')
    if (userRows !== 0) problems.push(`${userPatchPath} still inserts the plugin — that duplicates the bundle row`)
  } else {
    if (bundles.includes(PACKAGE_NAME)) problems.push('dsh.profile.bundles still lists the bundle row')
    if (dependencies[PACKAGE_NAME] !== undefined) problems.push('dependencies still lists the link: entry')
  }
  if (problems.length > 0) {
    throw new Error(`refusing to finish; fix these first:\n  - ${problems.join('\n  - ')}`)
  }
}

/** Compose the profile through the host loader and assert exactly one row. */
async function verifyComposition() {
  if (!options.verify) return
  let rows
  try {
    rows = await composeRowCount()
  } catch (error) {
    console.log(`compose: skipped (${error instanceof Error ? error.message : String(error)})`)
    return
  }
  if (rows !== 1) throw new Error(`composed profile has ${rows} "${PACKAGE_NAME}" rows; expected exactly 1`)
  console.log('compose: exactly 1 loader row (bundle layer)')
}

if (options.uninstall) {
  console.log(`link: ${editLink(true)}`)
  console.log(`manifest: ${editManifest(true)}`)
  console.log(`user patch: ${stripUserPatch()}`)
  verify(false)
  console.log(`\n${PACKAGE_NAME} disabled for profile "${options.profile}". Restart the host to drop it.`)
} else {
  console.log(`link: ${editLink(false)}`)
  console.log(`manifest: ${editManifest(false)}`)
  console.log(`user patch: ${stripUserPatch()}`)
  verify(true)
  await verifyComposition()
  console.log([
    '',
    `${PACKAGE_NAME} enabled for profile "${options.profile}" (${profileDir}).`,
    'Next:',
    '  - restart the host so the bundle layer mounts (a running process keeps its tree);',
    '  - refresh the browser page so the client bundle is picked up;',
    '  - check it: POST http://127.0.0.1:3080/dsh-session-log-repair/api with {"op":"status"}.',
    'Do not also add a row to cordis.patch.yml: that duplicates the entry id.',
  ].join('\n'))
}
