import test from 'node:test'
import assert from 'node:assert/strict'
import { fakeFontSettings } from './helpers/fontSettings.mjs'

let caseId = 0
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn) } })
const profile = { configuration: 'ipAddress', timezone: 'America/Los_Angeles', locale: 'en-US', lat: 0, lon: 0 }

async function setup() {
  const local = { ...profile }
  const session = {}
  const owners = new Map()
  const zones = new Map()
  const locales = new Map()
  const languages = new Map()
  const calls = []
  const tabs = [{ id: 1, url: 'https://one.example/' }, { id: 2, url: 'https://two.example/' }]
  const onDetach = event()
  const harness = { local, session, owners, zones, calls, tabs, onDetach, readback: null, failure: null }
  globalThis.chrome = {
    fontSettings: fakeFontSettings(),
    storage: {
      local: { get: async () => ({ ...local }), set: async (data) => { Object.assign(local, data) } },
      session: {
        get: async (key) => ({ [key]: session[key] }),
        set: async (data) => { Object.assign(session, data) },
        remove: async (key) => { delete session[key] },
      },
    },
    tabs: { query: async () => tabs, get: async (id) => tabs.find(t => t.id === id), onRemoved: event() },
    debugger: {
      getTargets: async () => tabs.map(tab => ({ tabId: tab.id, url: tab.url, attached: owners.has(tab.id) })),
      attach: async ({ tabId }) => {
        calls.push({ command: 'attach', tabId })
        if (owners.has(tabId)) throw new Error('Another debugger is already attached')
        owners.set(tabId, 'ours')
      },
      detach: async ({ tabId }) => {
        calls.push({ command: 'detach', tabId })
        if (owners.get(tabId) !== 'ours') throw new Error('Debugger is not attached')
        owners.delete(tabId)
        zones.delete(tabId)
      },
      sendCommand: async ({ tabId }, command, params) => {
        calls.push({ command, tabId, params })
        if (owners.get(tabId) !== 'ours') throw new Error('Debugger is not attached')
        if (harness.failure === command) throw new Error('Timezone override is already in effect')
        if (command === 'Emulation.setTimezoneOverride') zones.set(tabId, params.timezoneId || Intl.DateTimeFormat().resolvedOptions().timeZone)
        if (command === 'Emulation.setLocaleOverride') locales.set(tabId, params.locale)
        if (command === 'Emulation.setUserAgentOverride') languages.set(tabId, params.acceptLanguage?.split(','))
        if (command === 'Runtime.evaluate' && params.expression.startsWith('JSON.stringify')) return { result: { value: JSON.stringify({ language: languages.get(tabId)?.[0], languages: languages.get(tabId), locale: new Intl.DateTimeFormat(locales.get(tabId)).resolvedOptions().locale }) } }
        if (command === 'Runtime.evaluate') return { result: { value: params.expression === '0' ? 0 : harness.readback || zones.get(tabId) } }
        return {}
      },
      onDetach,
    },
  }
  const manager = await import(`../js/debugger.js?test=${caseId++}`)
  return { ...harness, manager, setFailure(command) { harness.failure = command }, setReadback(zone) { harness.readback = zone } }
}

test('saved settings update every page and repeated application does not detach sessions', async () => {
  const h = await setup()
  const first = await h.manager.applySettingsToAllTabs()
  assert.ok(first.every(result => result.ok))
  h.local.timezone = 'Asia/Tokyo'
  const second = await h.manager.applySettingsToAllTabs()
  assert.ok(second.every(result => result.ok && result.timezone === 'Asia/Tokyo'))
  assert.equal(h.calls.filter(call => call.command === 'attach').length, 2)
  assert.equal(h.calls.filter(call => call.command === 'detach').length, 0)
  assert.deepEqual([...h.zones.values()], ['Asia/Tokyo', 'Asia/Tokyo'])
  assert.ok(h.calls.some(call => call.command === 'Emulation.setGeolocationOverride' && call.params.latitude === 0 && call.params.longitude === 0))
})

test('another debugger being attached is a failure, not a reason to silently skip the tab', async () => {
  const h = await setup()
  h.owners.set(1, 'other')
  const result = await h.manager.applySettingsToTab(1)
  assert.equal(result.ok, false)
  assert.match(result.message, /占用/)
  assert.equal(h.owners.get(1), 'other')
  assert.equal(h.calls.filter(call => call.command === 'detach').length, 0)
})

test('default settings release only sessions owned by this extension', async () => {
  const h = await setup()
  await h.manager.applySettingsToTab(1)
  h.owners.set(2, 'other')
  h.local.configuration = 'browserDefault'
  await h.manager.applySettingsToAllTabs()
  assert.equal(h.owners.has(1), false)
  assert.equal(h.owners.get(2), 'other')
  assert.deepEqual(h.calls.filter(call => call.command === 'detach').map(call => call.tabId), [1])
})

test('command failures and mismatched page values never report applied success', async () => {
  const h = await setup()
  h.setFailure('Emulation.setTimezoneOverride')
  const failed = await h.manager.applySettingsToTab(1)
  assert.equal(failed.ok, false)
  assert.match(failed.message, /覆盖/)
  h.setFailure(null)
  h.setReadback('Asia/Shanghai')
  const mismatch = await h.manager.applySettingsToTab(1)
  assert.equal(mismatch.ok, false)
  assert.match(mismatch.message, /Asia\/Shanghai/)
  h.setReadback(null)
  assert.equal((await h.manager.applySettingsToTab(1)).ok, true)
})

test('a canceled connection is respected until an explicit retry', async () => {
  const h = await setup()
  await h.manager.applySettingsToTab(1)
  h.owners.delete(1)
  for (const listener of h.onDetach.listeners) listener({ tabId: 1 }, 'canceled_by_user')
  const paused = await h.manager.applySettingsToTab(1)
  assert.equal(paused.code, 'paused')
  assert.equal(h.owners.has(1), false)
  const retried = await h.manager.applySettingsToTab(1, { resume: true })
  assert.equal(retried.ok, true)
  assert.equal(h.owners.get(1), 'ours')
})

test('serialized work reads the latest settings and does not restore an old snapshot', async () => {
  const h = await setup()
  const first = h.manager.applySettingsToTab(1)
  h.local.timezone = 'Europe/Berlin'
  const second = h.manager.applySettingsToTab(1)
  h.local.timezone = 'Asia/Tokyo'
  const last = h.manager.applySettingsToTab(1)
  await Promise.all([first, second, last])
  assert.equal(h.zones.get(1), 'Asia/Tokyo')
  assert.equal(h.calls.filter(call => call.command === 'attach').length, 1)
})

test('a canceled session remains paused while a navigation temporarily hides the target URL', async () => {
  const h = await setup()
  await h.manager.applySettingsToTab(1)
  h.owners.delete(1)
  for (const listener of h.onDetach.listeners) listener({ tabId: 1 }, 'canceled_by_user')
  h.tabs[0].url = ''
  assert.equal((await h.manager.applySettingsToTab(1)).code, 'paused')
  h.tabs[0].url = 'https://one.example/'
  assert.equal((await h.manager.applySettingsToTab(1, { resume: true })).ok, true)
})
