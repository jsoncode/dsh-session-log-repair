/**
 * dsh-session-log-repair — installer regression test (plain Node, no host needed).
 *
 * Reproduces the state that aborted a real boot:
 *   Error: dsh: plugin tree failed to load: ... duplicate loader entry id: dsh-session-log-repair
 * The profile carried a user-patch insert row AND a `dsh.profile.bundles` row for
 * the same plugin, so both patch layers inserted the same entry id. The
 * installer must collapse that to the bundle layer alone, keep the user layer a
 * valid (non-empty) YAML array, and stay idempotent.
 *
 * Usage: node scripts/install-smoke.mjs
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-session-log-repair'
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installer = join(packageDir, 'scripts', 'install.mjs')

function expect(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

/** Run the installer against a throwaway home and return its stdout. */
function runInstaller(home, ...args) {
  const result = spawnSync(process.execPath, [installer, '--home', home, '--profile', 'web', ...args], {
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`installer exited ${result.status}\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

/** Create a throwaway DSH home with a web profile in the pre-fix (broken) state. */
function makeBrokenProfile() {
  const home = mkdtempSync(join(tmpdir(), 'dshsr-install-'))
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { [PACKAGE_NAME]: `link:${packageDir.replace(/\\/g, '/')}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'live' } },
  }, null, 2)}\n`)
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    '# Your patch layer for this dsh profile, applied after every bundle layer:',
    '# a top-level YAML array of loader patch entries (id-targeted config',
    '# overrides, disables, and insert lists; `!!js` expressions allowed).',
    '',
    '# dsh-session-log-repair — one-click repair for session logs whose committed region',
    '# has a seq collision (Web GUI: "历史加载失败 / corrupt session log").',
    '- insert:',
    `    - id: ${PACKAGE_NAME}`,
    `      name: ${PACKAGE_NAME}`,
    '',
  ].join('\n'))
  return home
}

const home = makeBrokenProfile()
try {
  // ── install: migrate the user row into the bundle layer ────────────────
  const first = runInstaller(home, '--no-verify')
  expect(first.includes('manifest: added'), 'install must add the dependency + bundle row')
  expect(first.includes('user patch: removed'), 'install must strip the user patch row')
  const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
  expect(manifest.dsh.profile.bundles.includes(PACKAGE_NAME), 'bundle row must be present')
  expect(manifest.dependencies[PACKAGE_NAME] === `link:${packageDir.replace(/\\/g, '/')}`, 'link dependency must be present')
  const patch = readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  expect(!patch.includes(`id: ${PACKAGE_NAME}`), 'user patch must no longer insert the plugin')
  expect(!patch.includes(PACKAGE_NAME), 'user patch must not keep comments naming the plugin')
  expect(/^\[\]$/m.test(patch), 'user patch must stay a top-level YAML array')
  expect(patch.endsWith('[]\n'), 'user patch must end with the empty array')

  // ── idempotence ────────────────────────────────────────────────────────
  const second = runInstaller(home, '--no-verify')
  for (const line of ['link: unchanged', 'manifest: unchanged', 'user patch: unchanged']) {
    expect(second.includes(line), `second install must report "${line}"`)
  }

  // ── a comments-only user layer is not a YAML array: repair it ──────────
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), '# only a comment\n')
  const third = runInstaller(home, '--no-verify')
  expect(third.includes('user patch: removed'), 'install must normalize a comments-only user layer')
  const repaired = readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  expect(repaired.includes('[]'), 'normalized user layer must carry an explicit empty array')

  // ── uninstall removes both enablement halves ───────────────────────────
  const removed = runInstaller(home, '--uninstall', '--no-verify')
  expect(removed.includes('manifest: removed'), 'uninstall must remove the dependency and the bundle row')
  const after = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
  expect(!after.dsh.profile.bundles.includes(PACKAGE_NAME), 'bundle row must be gone')
  expect(after.dependencies[PACKAGE_NAME] === undefined, 'link dependency must be gone')
  expect(!existsSync(join(home, 'profiles', 'web', 'node_modules', PACKAGE_NAME)), 'node_modules link must be gone')
  expect(readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8').includes('[]'), 'user layer must remain a YAML array')

  console.log('INSTALL-SMOKE OK — migration, idempotence, empty-layer repair, uninstall')
} finally {
  rmSync(home, { recursive: true, force: true })
}
