/** Render smoke test for the browser half (development only). */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('D:/workspace/custom/dsh-jenkins/package.json')
const React = require('react')
const server = require('react-dom/server')
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
