import test from 'node:test'
import assert from 'node:assert/strict'

let nextCase = 0
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn) }, emit(...args) { for (const fn of this.listeners) fn(...args) } })
const setup = async () => {
  const local = { configuration: 'zone:America/Los_Angeles', timezone: 'America/Los_Angeles' }
  const session = {}, calls = [], states = new Map(), attached = new Set()
  const onEvent = event(), onDetach = event()
  const targets = [{ tabId: 1, id: 'page', type: 'page', url: 'https://one.example/' }]
  let fail
  globalThis.chrome = {
    storage: {
      local: { get: async () => ({ ...local }) },
      session: { set: async values => Object.assign(session, values), remove: async key => { delete session[key] } },
    },
    debugger: {
      onEvent, onDetach, getTargets: async () => targets,
      attach: async target => { calls.push({ method: 'attach', target }); attached.add(target.targetId) },
      detach: async target => { calls.push({ method: 'detach', target }); attached.delete(target.targetId); onDetach.emit(target, 'target_closed') },
      sendCommand: async (target, method, params) => {
        calls.push({ target, method, params })
        if (fail === method && target.sessionId) throw new Error('Injected child failure')
        const key = JSON.stringify(target)
        if (!states.has(key)) states.set(key, {})
        const state = states.get(key)
        if (method === 'Emulation.setTimezoneOverride') state.zone = params.timezoneId
        if (method === 'Emulation.setLocaleOverride') state.locale = params.locale
        if (method === 'Emulation.setUserAgentOverride') state.languages = params.acceptLanguage.split(',')
        if (method === 'Target.getTargetInfo') return { targetInfo: { type: 'shared_worker' } }
        if (method === 'Runtime.evaluate') return { result: { value: params.expression.startsWith('JSON.stringify')
          ? JSON.stringify({ language: state.languages[0], languages: state.languages, locale: state.locale }) : state.zone } }
        return {}
      },
    },
  }
  const manager = await import(`../js/relatedTargets.js?test=${nextCase++}`)
  return { manager, local, calls, session, targets, onEvent, onDetach, attached, setFailure(value) { fail = value } }
}

test('child failures are visible, paused children are always released, and auto-attach is configured only once', async () => {
  const h = await setup()
  try {
    await h.manager.prepareRelatedTargets(1, h.local)
    await h.manager.updateRelatedTargets(1)
    await h.manager.prepareRelatedTargets(1, h.local)
    await h.manager.updateRelatedTargets(1)
    assert.equal(h.calls.filter(call => call.method === 'Target.setAutoAttach' && !call.target.sessionId).length, 1)
    h.setFailure('Emulation.setTimezoneOverride')
    h.onEvent.emit({ tabId: 1 }, 'Target.attachedToTarget', { sessionId: 'frame', targetInfo: { targetId: 'frame-id', type: 'iframe', url: 'https://two.example/' }, waitingForDebugger: true })
    await h.manager.updateRelatedTargets(1)
    assert.ok(h.calls.some(call => call.target.sessionId === 'frame' && call.method === 'Runtime.runIfWaitingForDebugger'))
    assert.match(h.session['lc-time-coverage:1'].errors[0].message, /Injected/)
    h.setFailure(null)
    await h.manager.updateRelatedTargets(1)
    assert.equal(h.session['lc-time-coverage:1'].checked, 1)
    assert.deepEqual(h.session['lc-time-coverage:1'].errors, [])
    assert.equal(h.calls.filter(call => call.method === 'Target.setAutoAttach' && call.target.sessionId === 'frame').length, 1)
    h.onEvent.emit({ tabId: 1, sessionId: 'frame' }, 'Target.attachedToTarget', { sessionId: 'nested', targetInfo: { targetId: 'nested-id', type: 'worker', url: 'https://two.example/worker.js' } })
    await h.manager.updateRelatedTargets(1)
    assert.equal(h.session['lc-time-coverage:1'].checked, 2)
  } finally { await h.manager.forgetRelatedTargets(1) }
  assert.equal(h.session['lc-time-coverage:1'], undefined)
})

test('standalone discovery stays within owned origins, respects cancel, explicitly retries, and releases owned workers', async () => {
  const h = await setup()
  h.targets.push(
    { id: 'shared', type: 'worker', url: 'https://one.example/shared.js' },
    { id: 'unrelated', type: 'worker', url: 'https://unrelated.example/worker.js' },
    { id: 'extension', type: 'worker', url: 'chrome-extension://other/worker.js' },
  )
  try {
    await h.manager.prepareRelatedTargets(1, h.local)
    await h.manager.updateRelatedTargets(1)
    assert.deepEqual([...h.attached], ['shared'])
    h.onDetach.emit({ targetId: 'shared' }, 'canceled_by_user')
    h.attached.delete('shared')
    await h.manager.scanRelatedWorkers()
    assert.equal(h.calls.filter(call => call.method === 'attach').length, 1)
    assert.match(h.session['lc-time-coverage:1'].errors[0].message, /取消/)
    await h.manager.updateRelatedTargets(1, { resume: true })
    assert.equal(h.calls.filter(call => call.method === 'attach').length, 2)
    assert.deepEqual([...h.attached], ['shared'])
  } finally { await h.manager.forgetRelatedTargets(1) }
  assert.equal(h.attached.size, 0)
  assert.deepEqual(h.calls.filter(call => call.method === 'detach').map(call => call.target.targetId), ['shared'])
})
