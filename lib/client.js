/**
 * dsh-session-log-repair — browser half.
 *
 * Served by the host at /plugins/dsh-session-log-repair/client.js and consumed by
 * the client module loader, so this file is wrapped in the
 * `window.__ModuleLoader__.load` factory form and only requires seed modules
 * (react / react-dom). Exports the cordis client plugin face.
 *
 * Surfaces:
 * - `sidebar.footer.action` — a persistent "session repair" button, rendered
 *   while the "show in menu" preference (default on) is enabled;
 * - `settings.section` — the host "Settings → Session log repair" page: the
 *   "show in menu" switch plus the entry into the repair dialog;
 * - `shell.overlay` — the repair dialog: scan every stored session, repair one
 *   session, or repair every repairable session in one click.
 *
 * All host work goes through the fenced HTTP route /dsh-session-log-repair/api, so
 * nothing lands in the conversation as a command node.
 */
window.__ModuleLoader__.load({ id: 'dsh-session-log-repair', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

var React = require('react')
var createPortal = require('react-dom').createPortal
var useState = React.useState
var useEffect = React.useEffect
var useCallback = React.useCallback
var useRef = React.useRef
var useSyncExternalStore = React.useSyncExternalStore
var h = React.createElement

var PLUGIN_ID = 'dsh-session-log-repair'
var API_PATH = '/dsh-session-log-repair/api'
var FOOTER_SLOT = 'sidebar.footer.action'
var OVERLAY_SLOT = 'shell.overlay'
var SECTION_SLOT = 'settings.section'

/* ─────────────────────────────── locale ───────────────────────────────── */

var DICT = {
  zh: {
    button: '会话修复',
    title: '会话日志修复',
    subtitle: '扫描本机会话日志，修复 seq 冲突导致的“历史加载失败”。',
    scan: '重新扫描',
    scanning: '扫描中…',
    repair: '修复',
    repairAll: '一键修复全部',
    repairing: '修复中…',
    close: '关闭',
    summary: function (total, corrupt, ms) { return '共 ' + total + ' 个会话，损坏 ' + corrupt + ' 个（' + ms + ' ms）' },
    none: '未找到会话日志。',
    empty: '全部会话都能正常加载。',
    backup: '备份',
    dropped: function (n) { return '丢弃 ' + n + ' 行重复/合成行' },
    result: function (before, after) { return before + ' → ' + after + ' 事件' },
    clean: '无 seq 冲突',
    failed: '失败',
    status: {
      ok: '正常',
      corrupt: 'seq 冲突',
      unreadable: '无法解析',
      torn: '尾部不完整',
      live: '运行中',
      missing: '缺失',
    },
    done: function (n) { return '已修复 ' + n + ' 个会话' },
    hint: '修复只保留与日志末尾相连的写入者链，重叠的旧版本行会被丢弃；原文件会先备份。',
    showInMenu: '在菜单中显示',
    showInMenuDesc: '开启后，在宿主侧栏底部显示「会话修复」入口按钮',
    openPlugin: '打开会话修复',
  },
  en: {
    button: 'Session repair',
    title: 'Session log repair',
    subtitle: 'Scan stored session logs and repair the seq collisions behind "history failed to load".',
    scan: 'Rescan',
    scanning: 'Scanning…',
    repair: 'Repair',
    repairAll: 'Repair all',
    repairing: 'Repairing…',
    close: 'Close',
    summary: function (total, corrupt, ms) { return total + ' session(s), ' + corrupt + ' corrupt (' + ms + ' ms)' },
    none: 'No session log found.',
    empty: 'Every session loads normally.',
    backup: 'backup',
    dropped: function (n) { return n + ' duplicate/synthetic row(s) dropped' },
    result: function (before, after) { return before + ' → ' + after + ' events' },
    clean: 'no seq collision',
    failed: 'failed',
    status: {
      ok: 'ok',
      corrupt: 'seq collision',
      unreadable: 'unreadable',
      torn: 'torn tail',
      live: 'running',
      missing: 'missing',
    },
    done: function (n) { return n + ' session(s) repaired' },
    hint: 'Repair keeps the writer chain that reaches the end of the log and drops the overlapping older version. The original file is backed up first.',
    showInMenu: 'Show in menu',
    showInMenuDesc: 'When on, a session repair entry button appears at the bottom of the host sidebar',
    openPlugin: 'Open session repair',
  },
}

var lang = 'zh'
function setLang(next) { lang = next === 'zh' ? 'zh' : 'en' }
function t(key) {
  var table = DICT[lang] || DICT.en
  var value = table[key]
  if (value === undefined) value = DICT.en[key]
  if (typeof value === 'function') return value.apply(null, Array.prototype.slice.call(arguments, 1))
  return value === undefined ? key : value
}

/* ──────────────────────────── local preferences ────────────────────────── */

// "Show in menu" preference: pure client-side view state persisted in
// localStorage. Default ON — the sidebar footer entry is this plugin's existing
// entry and must not disappear on upgrade; only an explicit stored '0' turns it
// off. Both the host settings section page and the repair dialog render the same
// store, so toggling one updates the other immediately.
var PREF_KEY = 'dsh-session-log-repair.show-in-menu'

/** Read the persisted switch (default ON: only an explicit '0' means off). */
function readPref() {
  if (typeof localStorage === 'undefined') return true
  try { return localStorage.getItem(PREF_KEY) !== '0' } catch (error) { return true }
}

var prefValue = readPref()
var prefListeners = new Set()

function emitPref() { prefListeners.forEach(function (listener) { listener() }) }

// useSyncExternalStore-compatible source. The third argument (getServerSnapshot)
// is required by react-dom/server, which the client smoke test uses to render
// these components to static markup.
var showInMenuStore = {
  getSnapshot: function () { return prefValue },
  subscribe: function (listener) {
    prefListeners.add(listener)
    return function () { prefListeners.delete(listener) }
  },
  /** Write the switch and persist it; a no-op when the value is unchanged. */
  set: function (next) {
    if (next === prefValue) return
    prefValue = next
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(PREF_KEY, next ? '1' : '0')
    } catch (error) { /* localStorage unavailable (private mode): keep the in-session value */ }
    emitPref()
  },
}

/* ─────────────────────────────── styles ───────────────────────────────── */

var STYLE_ID = 'dshsr-styles'
function injectStyles() {
  if (document.getElementById(STYLE_ID) !== null) return
  var style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    // Footer action entry, geometry copied from the host sidebar settings trigger
    // and the sibling footer entries (dsh-jenkins / dsh-listen-npm / dsh-get-balance):
    // 42px tall, 12px radius, no border, hover fill; the rail variant is a 36px circle.
    '.dshsr-footer-group{width:100%;min-width:0;position:relative}',
    '.dshsr-footer-rail-group{width:auto;display:flex;flex-direction:column;align-items:center}',
    '.dshsr-footer-btn{box-sizing:border-box;cursor:pointer;width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);background:transparent;border:none;border-radius:12px;flex:none;align-items:center;gap:8px;margin:4px -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}',
    '.dshsr-footer-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
    '.dshsr-footer-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#1668e3);outline-offset:-2px}',
    '.dshsr-footer-btn-rail{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;margin:8px 0 10px;padding:0}',
    // 28px round badge mirrors .dshj-footer-logo: brand-tinted glass disc with a white glyph.
    '.dshsr-footer-logo{height:28px;width:28px;flex:none;display:flex;align-items:center;justify-content:center;border-radius:50%;background:linear-gradient(135deg,color-mix(in srgb,#3b82f6 78%,transparent),color-mix(in srgb,#22c55e 78%,transparent));color:#fff;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);pointer-events:none}',
    '.dshsr-footer-logo svg{display:block;width:16px;height:16px}',
    '.dshsr-footer-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    // The host lays the footer action list out as a flex row, which squeezes several
    // plugin entries (each 100% wide here) into one line. Stack them instead — but
    // scope the rule to THIS plugin's own entry so it can never match host DOM that
    // does not contain it; :where() drops specificity to 0 so the host always wins.
    // This is the only declaration in this stylesheet without the dshsr- prefix.
    ':where(div:has(> [data-slot="sidebar.footer.action"] > .dshsr-footer-group)){flex-direction:column}',
    '@supports not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))){.dshsr-footer-logo{background:linear-gradient(135deg,#3b82f6,#22c55e)}}',
    // Dialog palette follows dsh-get-balance (.dshb-backdrop / .dshb-modal):
    // rgba(0,0,0,.32) + blur(12px) saturate(1.2) scrim, 78% bg-layer-1 glass panel,
    // border-l2 hairline, 14px radius, the same drop shadow. The host defines only
    // the --dsw-alias-* family (no --dsw-color-*), so the previous
    // var(--dsw-color-surface,#1b1b1f) fell back to a near-black panel with
    // inherited dark text on a light theme — unreadable.
    '.dshsr-backdrop{position:fixed;inset:0;z-index:2400;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.32);-webkit-backdrop-filter:blur(12px) saturate(1.2);backdrop-filter:blur(12px) saturate(1.2)}',
    '.dshsr-modal{width:min(880px,100%);max-height:min(80vh,760px);display:flex;flex-direction:column;overflow:hidden;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,#ddd);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 78%,transparent);color:var(--dsw-alias-label-primary,#222);box-shadow:0 16px 48px rgba(0,0,0,.28);-webkit-backdrop-filter:blur(24px) saturate(1.5);backdrop-filter:blur(24px) saturate(1.5)}',
    '@supports not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))){.dshsr-modal{background:var(--dsw-alias-bg-layer-1,#fff)}}',
    '.dshsr-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid var(--dsw-alias-border-l1,#eee)}',
    '.dshsr-title{font-size:15px;font-weight:600;margin:0}',
    '.dshsr-sub{margin:6px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary,#888);line-height:1.5;max-width:62ch}',
    '.dshsr-actions{display:flex;gap:8px;flex:0 0 auto}',
    '.dshsr-btn{padding:6px 12px;border:1px solid var(--dsw-alias-border-l2,#ccc);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#222);font:inherit;font-size:13px;cursor:pointer}',
    '.dshsr-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}',
    '.dshsr-btn:disabled{opacity:.5;cursor:default}',
    '.dshsr-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#1668e3));color:var(--dsw-alias-label-primary-foreground,#fff)}',
    '.dshsr-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#1668e3))}',
    '.dshsr-body{flex:1;overflow:auto;padding:6px 0 12px}',
    '.dshsr-summary{padding:10px 18px;font-size:12px;color:var(--dsw-alias-label-secondary,#888)}',
    '.dshsr-row{display:flex;align-items:center;gap:10px;padding:9px 18px;border-top:1px solid var(--dsw-alias-border-l1,#eee);font-size:13px}',
    '.dshsr-row-id{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dshsr-badge{flex:0 0 auto;padding:2px 8px;border-radius:999px;font-size:11px;border:1px solid transparent}',
    // Status badges use the host state tokens at 14% tint, the same recipe as
    // dsh-get-balance .dshb-history-result / .dshb-log-live-tag.
    '.dshsr-badge-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2a7d3c) 14%,transparent);color:var(--dsw-alias-state-success-primary,#2a7d3c)}',
    '.dshsr-badge-bad{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d33) 14%,transparent);color:var(--dsw-alias-state-error-primary,#d33)}',
    '.dshsr-badge-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b8860b) 14%,transparent);color:var(--dsw-alias-state-warn-primary,#b8860b)}',
    '.dshsr-badge-muted{background:color-mix(in srgb,var(--dsw-alias-label-secondary,#888) 14%,transparent);color:var(--dsw-alias-label-secondary,#888)}',
    '.dshsr-detail{padding:0 18px 12px 30px;font-size:12px;color:var(--dsw-alias-label-secondary,#888);line-height:1.7}',
    '.dshsr-detail code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
    '.dshsr-error{color:var(--dsw-alias-state-error-primary,#d33)}',
    '.dshsr-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;border-top:1px solid var(--dsw-alias-border-l1,#eee);font-size:12px;color:var(--dsw-alias-label-tertiary,#999)}',
    // "Show in menu" preference row (host settings section page top + repair
    // dialog body top, the same component and store). Tokens mirror the sibling
    // plugins (dsh-jenkins .dshj-pref / .dshj-switch).
    '.dshsr-settings{display:flex;flex-direction:column;gap:12px}',
    '.dshsr-pref{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 60%,transparent)}',
    '.dshsr-pref-text{min-width:0;display:flex;flex-direction:column;gap:2px}',
    '.dshsr-pref-label{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#222)}',
    '.dshsr-pref-desc{font-size:12px;color:var(--dsw-alias-label-secondary,#888)}',
    // Switch: same geometry and palette as dsh-get-balance .dshb-switch
    // (label-primary 42% track, solid #16a34a when on, 18px thumb with hairline ring).
    '.dshsr-switch{position:relative;display:inline-block;width:40px;height:22px;padding:0;border:none;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#222) 42%,transparent);cursor:pointer;flex:none;transition:background-color .2s}',
    '.dshsr-switch:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#222) 55%,transparent)}',
    '.dshsr-switch:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#1668e3) 18%,transparent)}',
    '.dshsr-switch-on{background:#16a34a}',
    '.dshsr-switch-on:hover{background:#117f39}',
    '.dshsr-switch-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:inset 0 0 0 1px rgba(0,0,0,.06),0 1px 4px rgba(0,0,0,.35);transition:left .2s cubic-bezier(.25,.8,.35,1)}',
    '.dshsr-switch-on .dshsr-switch-knob{left:20px}',
    // "Open plugin" button row on the host settings section page.
    '.dshsr-pref-open{display:flex;gap:8px}',
    // The preference row inside the dialog body (the body itself has no
    // horizontal padding, so the row carries it).
    '.dshsr-pref-row{padding:10px 18px 2px}',
    '@supports not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))){.dshsr-pref{background:var(--dsw-alias-bg-base,#fff)}}',
  ].join('\n')
  document.head.appendChild(style)
}

/* ───────────────────────────────── rpc ────────────────────────────────── */

/** One host call over the fenced HTTP route, with the command channel as fallback. */
function makeRun(ctx) {
  return async function run(sessionId, op) {
    try {
      var response = await fetch(API_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ sessionId: sessionId || '' }, op)),
      })
      if (response.ok) {
        var envelope = await response.json().catch(function () { return null })
        if (envelope !== null && envelope.ok === true && envelope.value !== undefined) return envelope.value
      }
    } catch (error) { /* route absent (older host): fall through to the command channel */ }
    try {
      var execution = await ctx.remote.commands.execute(sessionId || '', '/' + PLUGIN_ID + ' ' + JSON.stringify(op))
      var value = execution && execution.ok === true ? execution.value : undefined
      var text = value && value.result && typeof value.result.text === 'string' ? value.result.text : null
      if (text === null) return { ok: false, error: 'no result from command channel' }
      try { return JSON.parse(text) } catch (error) { return { ok: false, error: String(text).slice(0, 200) } }
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) }
    }
  }
}

/* ─────────────────────────────── components ───────────────────────────── */

var STATUS_CLASS = {
  ok: 'dshsr-badge-ok',
  corrupt: 'dshsr-badge-bad',
  unreadable: 'dshsr-badge-bad',
  torn: 'dshsr-badge-warn',
  live: 'dshsr-badge-muted',
  missing: 'dshsr-badge-muted',
}

function RepairIcon() {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': 'true' },
    h('path', {
      d: 'M4 10.6 8.2 14.8 16 5.6',
      stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round', strokeLinejoin: 'round',
    }),
  )
}

/**
 * "Show in menu" switch row, driven by showInMenuStore. Rendered twice from the
 * same store: at the top of the host "Settings → Session log repair" section page
 * and at the top of the repair dialog body.
 */
function ShowInMenuToggle() {
  var on = useSyncExternalStore(
    showInMenuStore.subscribe,
    showInMenuStore.getSnapshot,
    showInMenuStore.getSnapshot,
  )
  return h('div', { className: 'dshsr-pref' },
    h('div', { className: 'dshsr-pref-text' },
      h('div', { className: 'dshsr-pref-label' }, t('showInMenu')),
      h('div', { className: 'dshsr-pref-desc' }, t('showInMenuDesc')),
    ),
    h('button', {
      type: 'button',
      role: 'switch',
      'aria-checked': on,
      'aria-label': t('showInMenu'),
      className: 'dshsr-switch' + (on ? ' dshsr-switch-on' : ''),
      onClick: function () { showInMenuStore.set(!on) },
    }, h('span', { className: 'dshsr-switch-knob' })),
  )
}

/**
 * Host "Settings → Session log repair" section page. It carries the "show in
 * menu" toggle plus the only way back into the plugin once the sidebar footer
 * entry is hidden. `close` is the host-provided owner prop that closes the
 * settings dialog — it runs first so the repair dialog never stacks on top of it.
 */
function SettingsSection(props) {
  var close = typeof props.close === 'function' ? props.close : function () { /* host supplied no close */ }
  return h('div', { className: 'dshsr-settings' },
    h(ShowInMenuToggle),
    h('div', { className: 'dshsr-pref-open' },
      h('button', {
        type: 'button',
        className: 'dshsr-btn dshsr-btn-primary',
        onClick: function () { close(); props.onOpen() },
      }, t('openPlugin')),
    ),
  )
}

function FooterButton(props) {
  // The host hands the footer slot a stable `useSessions` selector hook and a
  // `reportSession` callback; the modal then reads the id from the ref, so no
  // hook is called conditionally anywhere else. The visibility preference is
  // subscribed first: every hook must run before the early return below.
  var visible = useSyncExternalStore(
    showInMenuStore.subscribe,
    showInMenuStore.getSnapshot,
    showInMenuStore.getSnapshot,
  )
  var sessionId = props.useSessions ? props.useSessions(function (state) { return state && state.current }) : undefined
  // The session id report is independent of visibility: the dialog and the
  // command channel both need it.
  if (props.reportSession && sessionId) props.reportSession(sessionId)
  // Hidden entry renders nothing at all (no placeholder), after every hook.
  if (!visible) return null
  var wide = props.wide === true
  return h('div', { className: 'dshsr-footer-group' + (wide ? '' : ' dshsr-footer-rail-group') },
    h('button', {
      type: 'button',
      className: 'dshsr-footer-btn' + (wide ? '' : ' dshsr-footer-btn-rail'),
      title: t('button'),
      'aria-label': t('button'),
      onClick: props.onOpen,
    },
      h('span', { className: 'dshsr-footer-logo' }, RepairIcon()),
      wide ? h('span', { className: 'dshsr-footer-label' }, t('button')) : null,
    ),
  )
}

function SessionRow(props) {
  var session = props.session
  var outcome = props.outcome
  var badgeClass = STATUS_CLASS[session.status] || 'dshsr-badge-muted'
  var rows = [
    h('div', { className: 'dshsr-row', key: 'row' },
      h('span', { className: 'dshsr-badge ' + badgeClass }, t('status')[session.status] || session.status),
      h('span', { className: 'dshsr-row-id', title: session.id + '\n' + session.file }, session.id),
      session.events === undefined ? null : h('span', { className: 'dshsr-badge dshsr-badge-muted' }, session.events + ' events'),
      session.repairable && outcome === undefined
        ? h('button', {
          type: 'button',
          className: 'dshsr-btn dshsr-btn-primary',
          disabled: props.busy,
          onClick: function () { props.onRepair(session.id) },
        }, props.busy ? t('repairing') : t('repair'))
        : null,
    ),
  ]
  if (session.message !== undefined) {
    rows.push(h('div', { className: 'dshsr-detail dshsr-error', key: 'msg' }, session.message))
  }
  if (outcome !== undefined) {
    if (outcome.repaired === true) {
      rows.push(h('div', { className: 'dshsr-detail', key: 'done' },
        t('result', outcome.eventsBefore, outcome.eventsAfter) + ' · ' + t('dropped', outcome.dropped.length)
        + (outcome.backup === undefined ? '' : ' · ' + t('backup') + ': ' + outcome.backup)))
    } else if (outcome.clean === true) {
      rows.push(h('div', { className: 'dshsr-detail', key: 'clean' }, t('clean')))
    } else if (outcome.message !== undefined) {
      rows.push(h('div', { className: 'dshsr-detail dshsr-error', key: 'fail' }, t('failed') + ': ' + outcome.message))
    }
  }
  return h(React.Fragment, null, rows)
}

function RepairModal(props) {
  var open = props.useOpen()
  var store = useState({ phase: 'idle', report: null, error: null, busyId: null, busyAll: false, outcomes: {} })
  var state = store[0]
  var setState = store[1]
  // Props arrive fresh on every host render; a ref keeps the callbacks stable.
  var latest = useRef(props)
  latest.current = props

  var scan = useCallback(function () {
    setState(function (previous) { return Object.assign({}, previous, { phase: 'scanning', error: null }) })
    latest.current.run(latest.current.getSessionId(), { op: 'scan' }).then(function (report) {
      if (report && report.ok === false) {
        setState(function (previous) { return Object.assign({}, previous, { phase: 'idle', error: report.error || 'scan failed' }) })
        return
      }
      setState(function (previous) { return Object.assign({}, previous, { phase: 'idle', report: report, outcomes: {} }) })
    })
  }, [])

  useEffect(function () {
    if (open && state.report === null && state.phase === 'idle') scan()
  }, [open, state.report, state.phase, scan])

  var applyResult = useCallback(function (result) {
    setState(function (previous) {
      var outcomes = Object.assign({}, previous.outcomes)
      for (var index = 0; index < result.results.length; index += 1) {
        var entry = result.results[index]
        outcomes[entry.id] = entry
      }
      var report = previous.report
      if (report !== null) {
        report = Object.assign({}, report, {
          sessions: report.sessions.map(function (session) {
            var outcome = outcomes[session.id]
            if (outcome === undefined || outcome.repaired !== true) return session
            return Object.assign({}, session, {
              status: 'ok',
              repairable: false,
              events: outcome.eventsAfter,
              message: undefined,
            })
          }),
        })
      }
      return Object.assign({}, previous, {
        busyId: null,
        busyAll: false,
        outcomes: outcomes,
        report: report,
        error: result.ok === false ? (result.error || 'repair failed') : null,
      })
    })
  }, [setState])

  var repairOne = useCallback(function (id) {
    setState(function (previous) { return Object.assign({}, previous, { busyId: id, error: null }) })
    latest.current.run(latest.current.getSessionId(), { op: 'repair', session: id }).then(function (result) {
      if (result && result.ok === false) {
        setState(function (previous) { return Object.assign({}, previous, { busyId: null, error: result.error || 'repair failed' }) })
        return
      }
      applyResult(result)
    })
  }, [applyResult])

  var repairAll = useCallback(function () {
    setState(function (previous) { return Object.assign({}, previous, { busyAll: true, error: null }) })
    latest.current.run(latest.current.getSessionId(), { op: 'repair', all: true }).then(function (result) {
      if (result && result.ok === false) {
        setState(function (previous) { return Object.assign({}, previous, { busyAll: false, error: result.error || 'repair failed' }) })
        return
      }
      applyResult(result)
    })
  }, [applyResult])

  if (!open) return null

  var report = state.report
  var sessions = report === null ? [] : report.sessions
  var repairable = sessions.filter(function (session) { return session.repairable === true }).length

  // The dialog has no settings tab, so the "show in menu" switch sits at the top
  // of the body, above the session list.
  var body = [h('div', { className: 'dshsr-pref-row', key: 'pref' }, h(ShowInMenuToggle))]
  if (state.phase === 'scanning') {
    body.push(h('div', { className: 'dshsr-summary', key: 'scanning' }, t('scanning')))
  } else if (state.error !== null) {
    body.push(h('div', { className: 'dshsr-summary dshsr-error', key: 'error' }, state.error))
  }
  if (report !== null) {
    body.push(h('div', { className: 'dshsr-summary', key: 'summary' },
      t('summary', report.total, report.corrupt, report.durationMs) + ' · ' + report.root))
    if (report.total === 0) body.push(h('div', { className: 'dshsr-summary', key: 'none' }, t('none')))
    if (report.corrupt === 0 && state.phase !== 'scanning') {
      body.push(h('div', { className: 'dshsr-summary', key: 'empty' }, t('empty')))
    }
    for (var index = 0; index < sessions.length; index += 1) {
      var session = sessions[index]
      if (session.status === 'ok' && state.outcomes[session.id] === undefined) continue
      body.push(h(SessionRow, {
        key: session.id,
        session: session,
        outcome: state.outcomes[session.id],
        busy: state.busyId === session.id || state.busyAll,
        onRepair: repairOne,
      }))
    }
  }

  return createPortal(h('div', {
    className: 'dshsr-backdrop',
    onClick: function (event) { event.stopPropagation(); props.close() },
  }, h('div', {
    className: 'dshsr-modal',
    onClick: function (event) { event.stopPropagation() },
  },
    h('div', { className: 'dshsr-head' },
      h('div', null,
        h('h2', { className: 'dshsr-title' }, t('title')),
        h('p', { className: 'dshsr-sub' }, t('subtitle')),
        h('p', { className: 'dshsr-sub' }, t('hint')),
      ),
      h('div', { className: 'dshsr-actions' },
        h('button', { type: 'button', className: 'dshsr-btn', disabled: state.phase === 'scanning', onClick: scan },
          state.phase === 'scanning' ? t('scanning') : t('scan')),
        h('button', { type: 'button', className: 'dshsr-btn', onClick: props.close }, t('close')),
      ),
    ),
    h('div', { className: 'dshsr-body' }, body),
    h('div', { className: 'dshsr-foot' },
      h('span', null, report === null ? '' : (repairable > 0 ? repairable + ' × ' + t('status').corrupt : t('empty'))),
      h('button', {
        type: 'button',
        className: 'dshsr-btn dshsr-btn-primary',
        disabled: state.busyAll || repairable === 0,
        onClick: repairAll,
      }, state.busyAll ? t('repairing') : t('repairAll')),
    ),
  )), document.body)
}

/* ─────────────────────────────── plugin ───────────────────────────────── */

function createPlugin() {
  return {
    name: PLUGIN_ID,
    inject: ['slots', 'remote', 'remote.commands'],

    apply: function (ctx) {
      // Locale follows the host locale service when present.
      var locale = ctx.get('locale')
      if (locale !== undefined && typeof locale.getSnapshot === 'function') {
        var sync = function () {
          var active = locale.getSnapshot().active
          setLang(/^zh/i.test(active) ? 'zh' : 'en')
        }
        sync()
        if (typeof locale.subscribe === 'function') locale.subscribe(sync)
      }

      var slots = ctx.get('slots')
      if (slots === undefined) return
      injectStyles()

      var run = makeRun(ctx)
      var sessionRef = { current: '' }
      var openState = false
      var listeners = new Set()
      var emit = function () { listeners.forEach(function (listener) { listener() }) }
      var useOpen = function () {
        return useSyncExternalStore(function (listener) {
          listeners.add(listener)
          return function () { listeners.delete(listener) }
        }, function () { return openState }, function () { return openState })
      }
      var openModal = function () { openState = true; emit() }
      var closeModal = function () { openState = false; emit() }

      slots.inject(FOOTER_SLOT, function () {
        return slots.register({ name: FOOTER_SLOT, id: PLUGIN_ID, order: 30 }, function (props) {
          return h(FooterButton, {
            onOpen: openModal,
            wide: props.wide,
            useSessions: props.useSessions,
            reportSession: function (sessionId) {
              sessionRef.current = sessionId
              if (props.reportSession) props.reportSession(sessionId)
            },
          })
        })
      })

      slots.inject(SECTION_SLOT, function () {
        return slots.register({
          name: SECTION_SLOT,
          id: PLUGIN_ID,
          order: 44,
          // Thunk so the host re-reads the localized title on locale change.
          label: function () { return t('title') },
        }, function (props) {
          return h(SettingsSection, { onOpen: openModal, close: props.close })
        })
      })

      slots.inject(OVERLAY_SLOT, function () {
        return slots.register({ name: OVERLAY_SLOT, id: PLUGIN_ID, order: 120 }, function () {
          return h(RepairModal, {
            useOpen: useOpen,
            close: closeModal,
            run: run,
            getSessionId: function () { return sessionRef.current },
          })
        })
      })
    },
  }
}

var plugin = createPlugin()
exports.name = plugin.name
exports.inject = plugin.inject
exports.apply = plugin.apply

return module.exports
} });
