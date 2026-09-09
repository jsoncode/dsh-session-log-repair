/**
 * dsh-session-repair — browser half.
 *
 * Served by the host at /plugins/dsh-session-repair/client.js and consumed by
 * the client module loader, so this file is wrapped in the
 * `window.__ModuleLoader__.load` factory form and only requires seed modules
 * (react / react-dom). Exports the cordis client plugin face.
 *
 * Surfaces:
 * - `sidebar.footer.action` — a persistent "session repair" button;
 * - `shell.overlay` — the repair dialog: scan every stored session, repair one
 *   session, or repair every repairable session in one click.
 *
 * All host work goes through the fenced HTTP route /dsh-session-repair/api, so
 * nothing lands in the conversation as a command node.
 */
window.__ModuleLoader__.load({ id: 'dsh-session-repair', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

var React = require('react')
var createPortal = require('react-dom').createPortal
var useState = React.useState
var useEffect = React.useEffect
var useCallback = React.useCallback
var useRef = React.useRef
var useSyncExternalStore = React.useSyncExternalStore
var h = React.createElement

var PLUGIN_ID = 'dsh-session-repair'
var API_PATH = '/dsh-session-repair/api'
var FOOTER_SLOT = 'sidebar.footer.action'
var OVERLAY_SLOT = 'shell.overlay'

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

/* ─────────────────────────────── styles ───────────────────────────────── */

var STYLE_ID = 'dshsr-styles'
function injectStyles() {
  if (document.getElementById(STYLE_ID) !== null) return
  var style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    '.dshsr-footer-btn{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:1px solid var(--dsw-color-border,rgba(127,127,127,.25));border-radius:10px;background:transparent;color:inherit;font:inherit;cursor:pointer;transition:background .15s ease}',
    '.dshsr-footer-btn:hover{background:var(--dsw-color-surface-hover,rgba(127,127,127,.12))}',
    '.dshsr-footer-btn svg{flex:0 0 auto}',
    '.dshsr-footer-label{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dshsr-backdrop{position:fixed;inset:0;z-index:2400;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.45)}',
    '.dshsr-modal{width:min(880px,100%);max-height:min(80vh,760px);display:flex;flex-direction:column;overflow:hidden;border-radius:14px;border:1px solid var(--dsw-color-border,rgba(127,127,127,.25));background:var(--dsw-color-surface,#1b1b1f);color:inherit;box-shadow:0 24px 64px rgba(0,0,0,.45)}',
    '.dshsr-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid var(--dsw-color-border,rgba(127,127,127,.2))}',
    '.dshsr-title{font-size:15px;font-weight:600;margin:0}',
    '.dshsr-sub{margin:6px 0 0;font-size:12px;opacity:.7;line-height:1.5;max-width:62ch}',
    '.dshsr-actions{display:flex;gap:8px;flex:0 0 auto}',
    '.dshsr-btn{padding:6px 12px;border:1px solid var(--dsw-color-border,rgba(127,127,127,.3));border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer}',
    '.dshsr-btn:hover:not(:disabled){background:var(--dsw-color-surface-hover,rgba(127,127,127,.12))}',
    '.dshsr-btn:disabled{opacity:.5;cursor:default}',
    '.dshsr-btn-primary{border-color:transparent;background:var(--dsw-color-accent,#3b82f6);color:#fff}',
    '.dshsr-btn-primary:hover:not(:disabled){filter:brightness(1.08)}',
    '.dshsr-body{flex:1;overflow:auto;padding:6px 0 12px}',
    '.dshsr-summary{padding:10px 18px;font-size:12px;opacity:.75}',
    '.dshsr-row{display:flex;align-items:center;gap:10px;padding:9px 18px;border-top:1px solid var(--dsw-color-border,rgba(127,127,127,.12));font-size:13px}',
    '.dshsr-row-id{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dshsr-badge{flex:0 0 auto;padding:2px 8px;border-radius:999px;font-size:11px;border:1px solid transparent}',
    '.dshsr-badge-ok{background:rgba(34,197,94,.16);color:#22c55e}',
    '.dshsr-badge-bad{background:rgba(239,68,68,.16);color:#ef4444}',
    '.dshsr-badge-warn{background:rgba(234,179,8,.18);color:#eab308}',
    '.dshsr-badge-muted{background:rgba(127,127,127,.16);opacity:.8}',
    '.dshsr-detail{padding:0 18px 12px 30px;font-size:12px;opacity:.72;line-height:1.7}',
    '.dshsr-detail code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
    '.dshsr-error{color:#ef4444}',
    '.dshsr-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;border-top:1px solid var(--dsw-color-border,rgba(127,127,127,.2));font-size:12px;opacity:.85}',
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
  return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    h('path', {
      d: 'M9.5 1.5 8 3l1.2 1.2-2.6 2.6L5.4 5.6 4 7l2.5 2.5L4 12l1.5 1.5 2.5-2.5L10.5 13.5 12 12l-1.2-1.2 2.6-2.6L14.6 9.4 16 8l-2.5-2.5',
      stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
    }),
  )
}

function FooterButton(props) {
  // The host hands the footer slot a stable `useSessions` selector hook and a
  // `reportSession` callback; the modal then reads the id from the ref, so no
  // hook is called conditionally anywhere else.
  var sessionId = props.useSessions ? props.useSessions(function (state) { return state && state.current }) : undefined
  if (props.reportSession && sessionId) props.reportSession(sessionId)
  return h('div', { className: 'dshsr-footer' },
    h('button', {
      type: 'button',
      className: 'dshsr-footer-btn',
      title: t('button'),
      'aria-label': t('button'),
      onClick: props.onOpen,
    },
      RepairIcon(),
      props.wide ? h('span', { className: 'dshsr-footer-label' }, t('button')) : null,
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

  var body = []
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
