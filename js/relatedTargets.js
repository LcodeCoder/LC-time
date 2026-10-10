import { SETTINGS_KEYS, applyLanguage, effectiveLocale } from './language.js'

const roots = new Map()
const standalone = new Map()
const filter = ['iframe', 'worker', 'service_worker'].map(type => ({ type, exclude: false })).concat({ exclude: true })
const send = (target, method, params = {}) => chrome.debugger.sendCommand(target, method, params)
const enabled = settings => settings.configuration !== 'browserDefault' && !!(settings.timezone || settings.locale)
const coverageKey = tabId => `lc-time-coverage:${tabId}`
const origin = url => { try { const u = new URL(url); return /^https?:\/\//.test(u.origin) ? u.origin : null } catch { return null } }
let scanTimer
let scanning
let transition = Promise.resolve()
let signature
const entries = () => [...roots.values()].flatMap(root => [...root.children.values()]).concat([...standalone.values()].flatMap(entry => [entry, ...entry.children.values()]))

const publish = async tabId => {
  const root = roots.get(tabId)
  if (!root?.active) return
  const relevant = [...root.children.values(), ...[...standalone.values()].filter(entry => entry.owners.has(tabId)).flatMap(entry => [entry, ...entry.children.values()])].filter(entry => entry.active)
  await chrome.storage.session.set({ [coverageKey(tabId)]: {
    checked: relevant.filter(entry => entry.status?.ok).length,
    pending: relevant.filter(entry => !entry.status).length,
    errors: relevant.filter(entry => entry.status && !entry.status.ok).map(entry => ({ type: entry.type, message: entry.status.message })),
  } })
}
const publishAll = () => Promise.all([...roots.keys()].map(publish))
const configureAutoAttach = target => send(target, 'Target.setAutoAttach', {
  autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter,
})

const applyRegion = async (entry, settings) => {
  const timezone = settings.timezone?.trim() || ''
  await send(entry.target, 'Emulation.setTimezoneOverride', { timezoneId: timezone })
  await applyLanguage(entry.target, effectiveLocale(settings))
  if (entry.type === 'iframe') {
    if (Number.isFinite(settings.lat) && Number.isFinite(settings.lon)) {
      await send(entry.target, 'Emulation.setGeolocationOverride', { latitude: settings.lat, longitude: settings.lon, accuracy: 1 })
    } else await send(entry.target, 'Emulation.clearGeolocationOverride')
  }
  const read = await send(entry.target, 'Runtime.evaluate', {
    expression: 'Intl.DateTimeFormat().resolvedOptions().timeZone', returnByValue: true,
  })
  const expected = new Intl.DateTimeFormat('en', timezone ? { timeZone: timezone } : {}).resolvedOptions().timeZone
  if (read.exceptionDetails || read.result?.value !== expected) throw new Error(`后台或内嵌环境时区未一致，目标 ${expected}。`)
}

const updateEntry = entry => {
  // Capture the barrier now: a region transition waits for earlier operations,
  // while newly created targets wait for that transition (without a queue cycle).
  const barrier = transition
  const next = (entry.task || Promise.resolve()).catch(() => {}).then(async () => {
    const release = () => send(entry.target, 'Runtime.runIfWaitingForDebugger').catch(() => {})
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; release() }, 5000)
    try {
      await barrier
      if (!entry.active || entry.blocked) return
      const settings = await chrome.storage.local.get(SETTINGS_KEYS)
      if (!enabled(settings)) return
      if (entry.standalone && !entry.owned) {
        await chrome.debugger.attach(entry.target, '1.3')
        entry.owned = true
        const { targetInfo } = await send(entry.target, 'Target.getTargetInfo')
        entry.type = targetInfo.type
      }
      if (!entry.active) return
      // Reissuing setAutoAttach during navigation can detach a provisional OOPIF.
      if (!entry.configured) { await configureAutoAttach(entry.target); entry.configured = true }
      await applyRegion(entry, settings)
      if (entry.active) entry.status = timedOut
        ? { ok: false, message: '后台环境准备超时，已放行页面；请刷新后重试核验。' }
        : { ok: true }
    } catch (error) {
      if (entry.active) entry.status = { ok: false, message: error.message }
    } finally {
      clearTimeout(timer)
      if (entry.owned) await release()
      await publishAll()
    }
  })
  entry.task = next
  return next
}

const releaseEntry = async entry => {
  entry.active = false
  for (const child of entry.children.values()) child.active = false
  await entry.task?.catch(() => {})
  if (entry.owned) await chrome.debugger.detach(entry.target).catch(() => {})
}

// chrome.debugger prohibits Target.setDiscoverTargets/getTargets. Its public
// getTargets API exposes standalone shared/service workers. Restrict discovery
// to the origins of pages/frames that this extension already owns.
export const scanRelatedWorkers = () => {
  if (scanning) return scanning
  scanning = (async () => {
    if (!roots.size) return
    const targets = await chrome.debugger.getTargets()
    const known = new Set(entries().filter(entry => !entry.standalone).map(entry => entry.targetId))
    const origins = new Map([...roots].map(([tabId, root]) => [tabId, new Set([
      origin(targets.find(target => target.tabId === tabId)?.url),
      ...[...root.children.values()].map(entry => origin(targets.find(target => target.id === entry.targetId)?.url || entry.url)),
    ].filter(Boolean))]))
    const candidates = targets.filter(target => target.type === 'worker' && origin(target.url) && !known.has(target.id))
    const updates = []
    for (const target of candidates) {
      const owners = new Set([...origins].filter(([, values]) => values.has(origin(target.url))).map(([tabId]) => tabId))
      if (!owners.size) continue
      let entry = standalone.get(target.id)
      if (!entry) {
        entry = { target: { targetId: target.id }, targetId: target.id, type: 'worker', url: target.url, active: true, owned: false, standalone: true, children: new Map(), owners }
        standalone.set(target.id, entry)
        updates.push(updateEntry(entry))
      } else entry.owners = owners
    }
    for (const [id, entry] of standalone) {
      const stillExists = targets.some(target => target.id === id)
      const relevant = [...origins.values()].some(values => values.has(origin(entry.url)))
      if (!stillExists || !relevant) {
        standalone.delete(id)
        await releaseEntry(entry)
      }
    }
    await Promise.all(updates)
    await publishAll()
  })().catch(console.error).finally(() => { scanning = null })
  return scanning
}

export const prepareRelatedTargets = async (tabId, settings) => {
  let root = roots.get(tabId)
  if (!root) { root = { active: true, children: new Map() }; roots.set(tabId, root) }
  const nextSignature = JSON.stringify([settings.timezone, effectiveLocale(settings)])
  if (signature && signature !== nextSignature) {
    const current = entries().filter(entry => entry.active && entry.owned)
    const tasks = current.map(entry => entry.task?.catch(() => {}))
    const targets = [...roots.keys()].map(tabId => ({ tabId })).concat(current.map(entry => entry.target))
    transition = transition.catch(() => {}).then(async () => {
      await Promise.all(tasks)
      // Locale ownership is renderer-wide. Clear every owned target before a
      // new region is applied; never detach another debugger to take ownership.
      for (const target of targets) await send(target, 'Emulation.setLocaleOverride', { locale: '' }).catch(() => {})
    })
  }
  signature = nextSignature
  await transition
  if (!scanTimer) { scanTimer = setInterval(scanRelatedWorkers, 2000); scanTimer.unref?.() }
}

export const updateRelatedTargets = async (tabId, { resume = false } = {}) => {
  const root = roots.get(tabId)
  if (!root?.active) return
  if (!root.configured) { await configureAutoAttach({ tabId }); root.configured = true }
  await scanRelatedWorkers()
  if (resume) {
    await Promise.all([...standalone.values()].filter(entry => entry.active && !entry.owned && entry.owners.has(tabId)).map(entry => { entry.blocked = false; return updateEntry(entry) }))
  }
  const related = [...root.children.values(), ...[...standalone.values()].filter(entry => entry.owners.has(tabId)).flatMap(entry => [entry, ...entry.children.values()])]
  await Promise.all(related.filter(entry => entry.active && entry.owned).map(updateEntry))
  await publish(tabId)
}

// Clear native overrides while sessions are still addressable. Read languages
// before detaching so Chromium's cached FrozenArray can observe the reset.
export const restoreRelatedTargets = async tabId => {
  const root = roots.get(tabId)
  const current = [...(root?.children.values() || []), ...[...standalone.values()].flatMap(entry => [entry, ...entry.children.values()])].filter(entry => entry.active && entry.owned)
  await Promise.all(current.map(entry => entry.task?.catch(() => {})))
  for (const target of [...current.map(entry => entry.target), { tabId }]) {
    await send(target, 'Emulation.setUserAgentOverride', { userAgent: '' }).catch(() => {})
    await send(target, 'Emulation.setLocaleOverride', { locale: '' }).catch(() => {})
    await send(target, 'Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {})
    await send(target, 'Runtime.evaluate', { expression: 'navigator.languages', returnByValue: true }).catch(() => {})
  }
}

export const forgetRelatedTargets = async tabId => {
  const root = roots.get(tabId)
  if (root) {
    root.active = false
    for (const entry of root.children.values()) entry.active = false
    roots.delete(tabId)
  }
  await chrome.storage.session.remove(coverageKey(tabId))
  if (!roots.size) {
    clearInterval(scanTimer); scanTimer = null; signature = undefined
    await releaseSharedTargets()
  }
}

export const releaseSharedTargets = async () => {
  const current = [...standalone.values()]
  standalone.clear()
  await Promise.all(current.map(releaseEntry))
}

chrome.debugger.onEvent?.addListener((source, method, params) => {
  const root = roots.get(source.tabId) || standalone.get(source.targetId)
  if (method === 'Target.attachedToTarget') {
    const target = { ...source, sessionId: params.sessionId }
    if (!root?.active) { send(target, 'Runtime.runIfWaitingForDebugger').catch(() => {}); return }
    const entry = { target, parentSession: source.sessionId, targetId: params.targetInfo.targetId, url: params.targetInfo.url, type: params.targetInfo.type, active: true, owned: true }
    root.children.set(params.sessionId, entry)
    publishAll().catch(console.error)
    updateEntry(entry).catch(console.error)
  } else if (method === 'Target.detachedFromTarget' && root) {
    const removed = new Set([params.sessionId])
    // Descendant sessions disappear with their parent, sometimes without their
    // own detach events. Do not keep stale failures in the coverage display.
    let changed = true
    while (changed) {
      changed = false
      for (const [id, entry] of root.children) {
        if (removed.has(id) || removed.has(entry.parentSession)) {
          entry.active = false; root.children.delete(id); removed.add(id); changed = true
        }
      }
    }
    publishAll().catch(console.error)
  }
})

chrome.debugger.onDetach.addListener((source, reason) => {
  if (Number.isInteger(source.tabId)) forgetRelatedTargets(source.tabId).catch(console.error)
  const entry = standalone.get(source.targetId)
  if (entry) {
    if (reason === 'canceled_by_user') {
      entry.owned = false; entry.blocked = true
      entry.status = { ok: false, message: '后台调试连接被取消，请重新启用设置后刷新。' }
      for (const child of entry.children.values()) child.active = false
    } else { entry.active = false; standalone.delete(source.targetId) }
    publishAll().catch(console.error)
  }
})
