import test from 'node:test'
import assert from 'node:assert/strict'
import { fakeFontSettings } from './helpers/fontSettings.mjs'

const event = () => ({
  listeners: new Set(),
  addListener(fn) { this.listeners.add(fn) },
  removeListener(fn) { this.listeners.delete(fn) },
  emit(...args) { for (const fn of this.listeners) fn(...args) },
})

test('refresh verifies the new document, reports cancellation or conflict, and cleans up listeners', async () => {
  const session = {}
  const updated = event()
  const removed = event()
  const detached = event()
  let connected = false
  let timezone = 'Asia/Shanghai'
  let reloadCount = 0
  let language = 'en-US'
  let languages = ['en-US', 'en']
  let scenario = 'success'
  let commandFailure = false
  let manager
  globalThis.chrome = {
    fontSettings: fakeFontSettings(),
    storage: {
      local: { get: async () => ({ configuration: 'ipAddress', timezone: 'America/Los_Angeles' }), set: async () => {} },
      session: {
        get: async (key) => ({ [key]: session[key] }),
        set: async (data) => Object.assign(session, data),
        remove: async (key) => { delete session[key] },
      },
    },
    tabs: {
      get: async () => ({ id: 1, url: 'https://test.example/' }),
      onUpdated: updated,
      onRemoved: removed,
      reload: async () => {
        reloadCount++
        assert.equal(manager.isReloadInProgress(1), true)
        if (scenario === 'cancel') {
          connected = false
          timezone = 'Asia/Shanghai'
          detached.emit({ tabId: 1 }, 'canceled_by_user')
        }
        if (scenario === 'conflict') commandFailure = true
        updated.emit(1, { status: 'complete' })
      },
    },
    debugger: {
      getTargets: async () => [{ tabId: 1, url: 'https://test.example/' }],
      attach: async () => { connected = true },
      onDetach: detached,
      sendCommand: async (_, command, params) => {
        if (!connected) throw Error('Debugger is not attached')
        if (command === 'Emulation.setTimezoneOverride') {
          if (commandFailure) throw Error('Timezone override is already in effect')
          timezone = params.timezoneId
        }
        if (command === 'Emulation.setUserAgentOverride') { languages = params.acceptLanguage.split(','); language = languages[0] }
        if (command === 'Runtime.evaluate' && params.expression.startsWith('JSON.stringify')) return { result: { value: JSON.stringify({ language, languages, locale: language }) } }
        if (command === 'Runtime.evaluate') return { result: { value: params.expression === '0' ? 0 : timezone } }
      },
    },
  }
  manager = await import('../js/reload.js')
  const removedBaseline = removed.listeners.size
  assert.equal((await manager.reloadWithSettings(1)).timezone, 'America/Los_Angeles')
  scenario = 'cancel'
  assert.equal((await manager.reloadWithSettings(1)).code, 'paused')
  assert.equal(connected, false, 'cancel during refresh must not be silently overridden')
  scenario = 'conflict'
  const conflict = await manager.reloadWithSettings(1)
  assert.equal(conflict.ok, false, 'pre-reload success is insufficient when new document fails')
  assert.match(conflict.message, /覆盖/)
  const previousReloads = reloadCount
  assert.equal((await manager.reloadWithSettings(1)).ok, false)
  assert.equal(reloadCount, previousReloads, 'do not reload if application failed beforehand')
  assert.equal(updated.listeners.size, 0)
  assert.equal(removed.listeners.size, removedBaseline)
  assert.equal(manager.isReloadInProgress(1), false)
})
