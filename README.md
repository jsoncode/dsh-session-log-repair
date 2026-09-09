# dsh-session-repair

One-click repair for DSH session logs whose **committed region has a seq
collision** — the failure behind the Web GUI's `历史加载失败` /
`failed to observe session … corrupt session log: seq gap in committed region at
line N (expected X, got Y)`.

The plugin adds a footer button with a repair dialog, three model tools, a
`/dsh-session-repair` command, and a fenced HTTP route. No build step: the host
half is plain ESM and the browser half is a hand-written module-loader bundle.

## What it repairs

A DSH session log is JSONL packed as concatenated zstd frames. The loader
requires every committed row to continue the previous row's `seq` range. When
one session is held by two writers — typically a run stalled in an LLM-retry
backoff while another process resumed the same session and committed a crash
repair — the woken writer appends with a stale counter and two different rows
claim the same `seq` values. The loader then refuses the whole log and the
session cannot be opened.

Repair keeps the **surviving chain** and drops the overlapping older version:

1. walk back from the end of the file to find the maximal dense run that reaches
   it (the writer that produced the rest of the log);
2. extend the chain backwards: a row ending exactly where the chain starts joins
   it, a row whose range reaches into the chain duplicates it and is dropped;
3. a real gap stops the walk, and the remaining rows must form a dense prefix —
   otherwise the repair is refused instead of guessed;
4. rows the plugin classifies as synthetic (`turn/end` with
   `reason.kind: 'interrupted'`, its `step/end`, `interrupted-tool-result-*`, a
   `session/end-seed` resume marker) are only ever dropped because they overlap
   the chain, never because of their label.

The decision never depends on guessing which version is "the repair", so it also
holds when both competing versions are real writes. `seq` values are never
renumbered: the repaired log keeps the surviving writer's numbering.

## Install

```sh
node D:/workspace/custom/dsh-session-repair/scripts/install.mjs --profile web
```

The installer mirrors what `dsh plugin --profile web install <dir>` (and the
desktop app's plugin page) does, so both agree:

1. links this package into `<profile>/node_modules`;
2. adds a `link:` dependency to the profile manifest;
3. appends the package to `dsh.profile.bundles`.

The boot then applies this package's own `cordis.patch.yml`, which inserts the
loader row:

```yaml
- insert:
    - id: dsh-session-repair
      name: dsh-session-repair
```

**One plugin, one enablement mechanism.** Do not also add an insert row to the
profile's `cordis.patch.yml`: the bundle layer already inserts the same entry id,
and two rows sharing one id abort the boot with
`duplicate loader entry id: dsh-session-repair`. The installer strips any such
row it finds (keeping the user layer a valid YAML array), then composes the
profile through the host's own loader to prove exactly one row remains.

Restart the host so the bundle layer mounts, and refresh the browser page for
the client bundle. Remove everything with `… install.mjs --profile web
--uninstall`.

A bundle-layer row mounts during the initial tree load, before the webserver
service exists, so the plugin reaches `webServer`, `commands`, and `skills`
through `ctx.inject([…])` instead of a one-shot `ctx.get` — otherwise the route
would be silently skipped on every boot.

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
node --import tsx/esm D:/workspace/custom/dsh-session-repair/skill/scripts/repair-all-sessions.mjs --dry-run
```

| Script | Purpose |
| --- | --- |
| `skill/scripts/scan-sessions.mjs` | read-only scan of `~/.dsh/sessions` |
| `skill/scripts/repair-all-sessions.mjs` | scan + repair every unheld session (`--dry-run`, `--backup-dir`) |
| `skill/scripts/repair-session-log.mjs` | one session: diagnose, `--apply` to write |
| `skill/scripts/verify-repaired-session.mjs` | re-load through the real loader and projections |
| `skill/scripts/host-resolver.mjs` | bare-dependency resolution fallback for the pnpm layout |

## Use

**Web GUI** — click **会话修复 / Session repair** in the sidebar footer. The
dialog scans every stored session, lists anything that cannot load, and offers
per-session **修复** plus **一键修复全部**.

**Model tools**

| Tool | Purpose |
| --- | --- |
| `dsh_session_repair_scan` | scan every stored log and report `ok` / `corrupt` / `unreadable` / `torn` / `live` |
| `dsh_session_repair_apply` | repair one session (`session`), every repairable session (`all: true`), or preview (`dryRun: true`) |
| `dsh_session_repair_verify` | re-load through the host backend to confirm a repair |

**Command** — `/dsh-session-repair {"op":"scan"}`, or `repair` / `verify` /
`status` with the same JSON fields.

**HTTP** — `POST /dsh-session-repair/api` with `{"op":"…"}`; the response is
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

## Configuration

Optional plugin config, added to this package's own `cordis.patch.yml` row (the
bundle layer), never to the profile's user patch:

```yaml
- insert:
    - id: dsh-session-repair
      name: dsh-session-repair
      config:
        backupRoot: D:/backups/session-repair   # default $DSH_HOME/session-repair-backups/<id>-<ts>
        sessionsRoot: D:/other/sessions         # default: the backend's configured root
```

## Develop

```sh
node scripts/host-smoke.mjs     # real backend + throwaway root: tools, route, fences, skill, fiber disposal
node scripts/client-smoke.mjs   # module-loader face, slot registration, render
node scripts/install-smoke.mjs  # installer migration (duplicate entry id) + idempotence + uninstall
cd <deepseek-harness> && node --import tsx/esm scripts/selftest.mts <corrupt.jsonl.zstd>
```

`scripts/make-corrupt-session.mts` builds a corrupt fixture under a sessions
root (development only). `scripts/install.mjs --help` documents the installer
flags. The plugin's own `scripts/` and the skill's `skill/scripts/` are separate
directories on purpose: the former drives this package, the latter is the
offline toolkit the skill body refers to.
