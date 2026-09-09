# dsh-session-log-repair

<p align="center">
  <img src="assets/logo.svg" alt="dsh-session-log-repair logo" width="120" />
</p>

**dsh-session-log-repair** is a DeepSeek Harness (DSH) plugin that repairs session
logs whose **committed region has a `seq` collision** or a **torn trailing
record** — the failures behind the Web GUI's `历史加载失败` / `failed to observe
session … corrupt session log: seq gap in committed region …` and `corrupt
Zstandard session log: complete frame contains a torn JSONL record`.

- **One-click repair** — a footer button opens a dialog that scans every stored
  session and repairs the corrupt ones, with per-session and repair-all actions
- **Safe by construction** — refuses sessions that are live in this process,
  re-checks the file (size + mtime) before publishing, backs up the original,
  publishes atomically, then re-loads through the host backend
- **Four surfaces** — Web GUI dialog, three model tools, the
  `/dsh-session-log-repair` command, and a fenced HTTP route
- **Ships its own skill** — installing the plugin registers the
  `dsh-session-log-repair` skill (diagnosis doctrine + an offline script
  toolkit that works even when DSH will not boot)
- **Bilingual UI** — follows the host interface language (中文 / English)
- **No build step** — the host half is plain ESM, the browser half is a
  hand-written `__ModuleLoader__` bundle

[中文文档](README.zh.md)

## What it repairs

A DSH session log is JSONL packed as concatenated zstd frames. The loader
requires every committed row to continue the previous row's `seq` range. When
one session is held by two writers — typically a run stalled in an LLM-retry
backoff while another process resumed the same session and committed a crash
repair — the woken writer appends with a stale counter and two different rows
claim the same `seq` values. The loader then refuses the whole log and the
session cannot be opened.

Two loader messages are repaired:

| Loader message | What it means |
|---|---|
| `corrupt session log: seq gap in committed region at line N (expected X, got Y)` | a colliding row, and a later row carries `turn/end` |
| `corrupt Zstandard session log: complete frame contains a torn JSONL record` | the colliding row has no later `turn/end` (the scanner records the issue without escalating it), **or** a record's newline never landed inside an otherwise complete frame |

Repair keeps the **surviving chain** and drops the overlapping older version:

1. a trailing record without its newline is removed first — it never became an
   event, so no event is lost;
2. walk back from the end of the file to find the maximal dense run that reaches
   it (the writer that produced the rest of the log);
3. extend the chain backwards: a row ending exactly where the chain starts joins
   it, a row whose range reaches into the chain duplicates it and is dropped;
4. a real gap stops the walk, and the remaining rows must form a dense prefix —
   otherwise the repair is refused instead of guessed;
5. rows the plugin classifies as synthetic (`turn/end` with
   `reason.kind: 'interrupted'`, its `step/end`, `interrupted-tool-result-*`, a
   `session/end-seed` resume marker) are only ever dropped because they overlap
   the chain, never because of their label.

The decision never depends on guessing which version is "the repair", so it also
holds when both competing versions are real writes. `seq` values are never
renumbered: the repaired log keeps the surviving writer's numbering.

Two cases are deliberately refused: a **real gap** (`got > expected`) and a
**structurally incomplete final frame**, which the loader recovers by itself.

## Features

- **Footer entry** (`sidebar.footer.action`): a **会话修复 / Session repair**
  button opens the repair dialog (`shell.overlay`). It lists every stored
  session as `ok` / `corrupt` / `unreadable` / `torn` / `live`, and offers
  per-session **修复** plus **一键修复全部**. The entry keeps the host sidebar
  geometry — 42px row, 12px radius, 28px round badge, 36px circle in the rail —
  so it lines up with the sibling footer entries and the settings trigger.
- **Host settings page** (`settings.section`): **Settings → Session log repair**
  carries the **在菜单中显示 / Show in menu** switch (default on) plus an **Open
  session repair** button. Turning the switch off hides the footer entry — which
  then renders nothing, not a placeholder — and this page remains the way back
  into the dialog. The same switch also sits at the top of the dialog body; both
  read one preference source, so either one updates the other immediately.
- **Model tools**: `dsh_session_log_repair_scan`, `dsh_session_log_repair_apply`
  (`session` / `all` / `dryRun` / `force`), `dsh_session_log_repair_verify`.
- **Command**: `/dsh-session-log-repair {"op":"scan|repair|verify|status", …}`.
- **HTTP route**: `POST /dsh-session-log-repair/api`, fenced to loopback/trusted
  hosts with a same-origin marker, answering `{"ok":true,"value":…}`.
- **Bundled skill**: `dsh-session-log-repair`, registered into `ctx.skills` on
  boot (`source: bundled`) — see [Bundled skill](#bundled-skill).
- **Config**: optional `backupRoot` / `sessionsRoot` overrides on the plugin's
  own patch row.

## Structure

```
├── lib/index.js          # Host half (plain ESM): codec, planner, ops, tools, route, skill
├── lib/client.js         # Browser half: __ModuleLoader__ factory (footer button + dialog)
├── skill/SKILL.md        # Bundled skill body: triage, container contract, algorithm
├── skill/scripts/        # Offline toolkit (runs without a host): scan / repair / verify
├── scripts/host-smoke.mjs    # Host-half integration test (real backend, synthetic corrupt log)
├── scripts/client-smoke.mjs  # Browser-half render test (module-loader face, both slots)
├── scripts/install-smoke.mjs # Installer regression test (duplicate entry id, idempotence)
├── scripts/install.mjs       # Install / uninstall into a DSH profile
├── scripts/host-resolve.mjs  # Host-package resolution shared by the tests
├── cordis.patch.yml      # Bundle patch: inserts this package's loader row
├── package.json          # dsh.bundle + dsh.client(web) manifests + peer/dev dependencies
├── .github/workflows/    # ci.yml (tests) + release.yml (tag → GitHub Release)
├── README.md             # This file (English)
└── README.zh.md          # 中文文档
```

## Installation

```sh
# Local checkout (what this repo is for)
dsh plugin --profile web add ./dsh-session-log-repair

# Then restart the host so the bundle layer mounts
dsh --profile web --dump-config   # verify the layer: exactly one dsh-session-log-repair row
dsh --profile web                 # start
```

The equivalent installer in this repo performs the same three edits, then proves
the result by composing the profile through the host's own loader:

```sh
node scripts/install.mjs --profile web            # install + verify
node scripts/install.mjs --profile web --uninstall
```

**One plugin, one enablement mechanism.** Do not also add an insert row to the
profile's `cordis.patch.yml`: the bundle layer already inserts the same entry id,
and two rows sharing one id abort the boot with
`duplicate loader entry id: dsh-session-log-repair`. The installer strips any such
row it finds (keeping the user layer a valid YAML array), then composes the
profile through the host's loader to prove exactly one row remains.

A bundle-layer row mounts during the initial tree load, before the webserver
service exists, so the plugin reaches `webServer`, `commands`, and `skills`
through `ctx.inject([…])` instead of a one-shot `ctx.get` — otherwise the route
would be silently skipped on every boot.

Restart the host so the bundle layer mounts, and refresh the browser page for
the client bundle.

## Use

**Web GUI** — click **会话修复 / Session repair** in the sidebar footer. The
dialog scans every stored session, lists anything that cannot load, and offers
per-session **修复** plus **一键修复全部**.

**Model tools**

| Tool | Purpose |
| --- | --- |
| `dsh_session_log_repair_scan` | scan every stored log and report `ok` / `corrupt` / `unreadable` / `torn` / `live` |
| `dsh_session_log_repair_apply` | repair one session (`session`), every repairable session (`all: true`), or preview (`dryRun: true`) |
| `dsh_session_log_repair_verify` | re-load through the host backend to confirm a repair |

**Command** — `/dsh-session-log-repair {"op":"scan"}`, plus `repair` / `verify` /
`status` with the same JSON fields.

**HTTP** — `POST /dsh-session-log-repair/api` with `{"op":"…"}`; the response is
`{"ok":true,"value":…}`. The route is fenced to loopback/trusted hosts with a
same-origin marker.

## Safety

- Reads go through the running backend (`sessionPersistence.readRaw`), so the
  bytes come from the host's own frame decoder; rows are expanded with the
  host's `decodeStorageRecord`.
- A session that is **live in this process** is refused (and skipped by scan);
  `force: true` overrides that deliberately.
- The log is re-checked for changes (size + mtime) after planning and before
  publishing, so a concurrently writing process aborts the repair.
- The original file is copied to
  `$DSH_HOME/session-repair-backups/<id>-<timestamp>/<id>.jsonl.zstd.orig`
  before anything is written.
- The repaired bytes are written to a sibling temp file, fsynced, and renamed
  over the log (atomic publish).
- After publishing, the log is re-loaded through the backend itself; a mismatch
  is reported instead of assumed.
- The repair is idempotent: a clean log is never rewritten.

## Bundled skill

Installing the plugin also activates the **`dsh-session-log-repair` skill**: the
host half registers it into `ctx.skills` (source `bundled`, resource base
`skill/`), so it appears in the model's skill catalog and loads through the
`skill` tool — no separate `~/.agents/skills` install.

`skill/SKILL.md` is the doctrine (symptom triage, the log container contract,
root-cause fingerprints, the surviving-chain rule, host-side hardening
proposals, source index). `skill/scripts/` holds the offline toolkit, which runs
**without a running host** — the path to use when DSH itself will not boot:

```sh
cd <deepseek-harness checkout>
node --import tsx/esm <plugin>/skill/scripts/repair-all-sessions.mjs --dry-run
```

| Script | Purpose |
| --- | --- |
| `skill/scripts/scan-sessions.mjs` | read-only scan of `~/.dsh/sessions` |
| `skill/scripts/repair-all-sessions.mjs` | scan + repair every unheld session (`--dry-run`, `--backup-dir`) |
| `skill/scripts/repair-session-log.mjs` | one session: diagnose, `--apply` to write |
| `skill/scripts/verify-repaired-session.mjs` | re-load through the real loader and projections |
| `skill/scripts/host-resolver.mjs` | bare-dependency resolution fallback for the pnpm layout |

## Configuration

Optional plugin config, added to this package's own `cordis.patch.yml` row (the
bundle layer), never to the profile's user patch:

```yaml
- insert:
    - id: dsh-session-log-repair
      name: dsh-session-log-repair
      config:
        backupRoot: D:/backups/session-repair   # default $DSH_HOME/session-repair-backups/<id>-<ts>
        sessionsRoot: D:/other/sessions         # default: the backend's configured root
```

## Development

Requirements: **Node ≥ 22.15 + pnpm 10** (the `packageManager` field pins the
pnpm version). The test scripts need host packages, which resolve from a DSH
profile first and from this package's devDependencies otherwise, so a clean
checkout works:

```sh
pnpm install       # devDependencies: @deepseek-ai/* host packages, react, react-dom
npm test           # syntax check + all three smoke tests
npm run test:host      # real backend + throwaway root: tools, route, fences, skill, fiber disposal
npm run test:client    # module-loader face, slot registration, render
npm run test:install   # installer migration (duplicate entry id) + idempotence + uninstall
npm run check          # node --check every source file
npm run publish:npm    # npm test, then npm publish --access public
```

`node scripts/host-smoke.mjs <real-corrupt.jsonl.zstd>` runs the same test
against a real corrupt log instead of the synthetic one it builds by default.
The plugin's own `scripts/` and the skill's `skill/scripts/` are separate
directories on purpose: the former drives this package, the latter is the
offline toolkit the skill body refers to.

## Automated publishing

| Workflow | Trigger | What it does |
| --- | --- | --- |
| [`ci.yml`](.github/workflows/ci.yml) | push to `master`, pull requests, manual | Node 26 → `pnpm install --frozen-lockfile` → `npm test` |
| [`release.yml`](.github/workflows/release.yml) | tag `v*` | same checks → `npm pack` → create a published GitHub Release with the tarball attached → `npm publish --provenance` through npm Trusted Publishing (OIDC) |

```sh
npm run release    # npm test && npm version patch && git push --follow-tags
```

The tag triggers `release.yml`, which publishes the GitHub Release **and** the
npm package. npm uses **Trusted Publishing** (OIDC, `id-token: write`) with no
long-lived token, matching `dsh-jenkins`.

First release needs a one-time bootstrap: npm only offers the Trusted Publishing
settings page for a package that already exists, so publish the first version
from your machine with `npm run publish:npm` (or `npm login && npm publish
--access public`), then add the trusted publisher on npmjs.com — repository
`jsoncode/dsh-session-log-repair`, workflow `release.yml`. Every tag after that
publishes automatically.

## Implementation notes

- The host half is plain ESM (`lib/index.js`), loaded through native Node ESM by
  the host — no bundler, no build artifacts to keep in sync.
- The browser half (`lib/client.js`) is a single `window.__ModuleLoader__.load`
  factory that exports `{ name, inject, apply }`; `react` / `react-dom` stay
  external and resolve from the host's module seed at runtime.
- Peer dependencies (`@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-tools`) are
  optional: the plugin works without them and reports `unsupported` when the
  backend is not the JSONL one.
- **Style isolation**: every rule in the injected stylesheet is scoped to `.dshsr-*`
  with one deliberate exception — `:where(div:has(> [data-slot="sidebar.footer.action"] > .dshsr-footer-group)){flex-direction:column}`,
  which stacks the host footer container (the host lays it out as a flex **row**, so
  several plugin entries would squeeze onto one line). It can only match a container
  that already holds **this plugin's own entry**, and `:where()` drops its specificity
  to 0 so the host can always override it. The style tag is marked `id="dshsr-styles"`;
  no other global selector, no `:root`/`body`/`*` rule, no body-style mutation.
- **Dialog palette**: the repair dialog follows dsh-get-balance — a `rgba(0,0,0,.32)`
  scrim with `blur(12px) saturate(1.2)`, a `color-mix(bg-layer-1 78%)` glass panel
  with a `border-l2` hairline and 14px radius, `border-l1` dividers, solid
  `button-primary-fill` for the primary action, and `state-success/error/warn`
  tokens for the `ok` / `corrupt` / `torn` badges. The host defines only the
  `--dsw-alias-*` family — the earlier `var(--dsw-color-surface,#1b1b1f)` resolved
  to a near-black panel with inherited dark text on the light theme.
- The official `deepseek-harness` project is **not modified**; everything uses
  existing services (`tools`, `commands`, `skills`, `webServer`) and slots
  (`sidebar.footer.action`, `shell.overlay`).

## License

MIT © jsoncode
