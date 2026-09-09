/**
 * Render smoke test for the browser half.
 *
 * The bundle is a `window.__ModuleLoader__` factory: this harness plays the
 * module table (react / react-dom come from the host's seed at runtime) and
 * renders both slot components to static markup.
 *
 * Usage: node scripts/client-smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { hostBases, packageBase } from './host-resolve.mjs'

/**
 * Load a react/react-dom pair from one base. The browser bundle receives react
 * from the host's module seed, so the test only needs a *matching* pair: a
 * profile can hoist a react-dom that does not match its react, which
 * `react-dom/server` rejects outright.
 * @returns `{ React, server }` from a single base.
 */
function loadReactPair() {
  const failures = []
  for (const base of [packageBase, ...hostBases()]) {
    try {
      const require = createRequire(base)
      const React = require('react')
      const server = require('react-dom/server')
      const domVersion = require('react-dom/package.json').version
      if (React.version !== domVersion) {
        failures.push(`${base}: react ${React.version} does not match react-dom ${domVersion}`)
        continue
      }
      return { React, server, require, base }
    } catch (cause) {
      failures.push(`${base}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  throw new Error(`cannot load a matching react/react-dom pair:\n${failures.map(line => `  ${line}`).join('\n')}`)
}

const { React, server, require, base } = loadReactPair()
console.log('react pair:', base)
const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let registration
const fakeDocument = {
  head: { appendChild: () => {} },
  body: {},
  getElementById: () => null,
  createElement: () => ({ set id(value) {}, set textContent(value) {} }),
}
new Function('window', 'document', code)(
  { __ModuleLoader__: { load: (reg) => { registration = reg } } },
  fakeDocument,
)
const plugin = registration.factory((spec) => require(spec))

const captured = []
const ctx = {
  get(name) {
    if (name === 'slots') {
      return {
        inject: (slotName, fn) => fn(),
        register: (def, component) => { captured.push({ def, component }); return () => {} },
      }
    }
    if (name === 'remote') return { commands: { execute: async () => ({}) } }
    return undefined
  },
}
plugin.apply(ctx)
console.log('slots:', captured.map(entry => `${entry.def.name}#${entry.def.id}`).join(', '))

const footer = captured.find(entry => entry.def.name === 'sidebar.footer.action')
const overlay = captured.find(entry => entry.def.name === 'shell.overlay')
const wide = server.renderToStaticMarkup(React.createElement(footer.component, { wide: true }))
console.log('footer wide:', wide.slice(0, 140))
const rail = server.renderToStaticMarkup(React.createElement(footer.component, { wide: false }))
console.log('rail label present:', rail.includes('dshsr-footer-label'))

// The footer must forward the host session id through reportSession.
const reported = []
server.renderToStaticMarkup(React.createElement(footer.component, {
  wide: true,
  useSessions: (selector) => selector({ current: 'session-test' }),
  reportSession: (id) => reported.push(id),
}))
console.log('reported session:', JSON.stringify(reported))
const withoutHook = server.renderToStaticMarkup(React.createElement(footer.component, { wide: true }))
console.log('footer without useSessions renders:', withoutHook.includes('dshsr-footer-btn'))

const closed = server.renderToStaticMarkup(React.createElement(overlay.component, {}))
console.log('closed modal output:', JSON.stringify(closed))
