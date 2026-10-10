import { SETTINGS_KEYS, applyLanguage, effectiveLocale } from './language.js'
import { applyFontSettings } from './fonts.js'
import { prepareRelatedTargets, updateRelatedTargets, forgetRelatedTargets, releaseSharedTargets, restoreRelatedTargets } from './relatedTargets.js'

export { SETTINGS_KEYS }
// Locale ownership can be shared by targets in a renderer, so region changes
// remain serialized within a profile. Each tab keeps its own session/state.
let profileQueue = Promise.resolve()
const states = new Map()
const pausedTabs = new Set()
const releasingTabs = new Set()
const statusKey = tabId => `lc-time-tab:${tabId}`
const stateFor = tabId => {
  if (!states.has(tabId)) states.set(tabId, { generation: 0, stage: 'idle', writes: Promise.resolve(), closed: false })
  return states.get(tabId)
}
const pausedStatus = tabId => ({ tabId, ok: false, code: 'paused', message: '当前网页连接已断开，尚未恢复。点击“恢复并刷新网页”重试；仍然失败时可点击底部“诊断”。' })
const disconnectedStatus = tabId => ({ tabId, ok: false, code: 'disconnected', message: '页面连接已断开，加载完成后会重新核验。' })
const closedStatus = tabId => ({ tabId, ok: false, code: 'closed', message: '网页已关闭。' })
const rawStatus = async tabId => (await chrome.storage.session.get(statusKey(tabId)))[statusKey(tabId)]
const errorText = error => (error?.message || String(error)).replace(/\b(?:https?|file|chrome(?:-extension)?):\/\/[^\s"'<>]+/g, '[URL]').slice(0, 1000)

export const getTabStatus = async tabId => {
  await stateFor(tabId).writes
  return rawStatus(tabId)
}

// Serialize storage writes as well as commands. A late readback must not replace
// a newer detach event or recreate the status of a tab that has been removed.
const storeStatus = async (tabId, status, diagnostics = {}, generation = stateFor(tabId).generation) => {
  const state = stateFor(tabId)
  const write = state.writes.catch(() => {}).then(async () => {
    const previous = await rawStatus(tabId)
    if (state.closed || generation !== state.generation) return previous
    const checkedAt = new Date().toISOString()
    const detail = { ...previous?.diagnostics, ...diagnostics }
    const history = detail.history || []
    const entry = { at: checkedAt, code: status.code, stage: detail.stage, error: detail.error || undefined }
    if (status.code !== previous?.code || entry.error || status.code === 'paused' && detail.lastDetach?.at !== previous?.diagnostics?.lastDetach?.at) {
      detail.history = [...history, entry].slice(-10)
    }
    const result = { tabId, ...status, checkedAt, diagnostics: detail }
    await chrome.storage.session.set({ [statusKey(tabId)]: result })
    return result
  })
  state.writes = write.catch(() => {})
  const result = await write
  if (state.closed) return closedStatus(tabId)
  if (generation !== state.generation) return await getTabStatus(tabId) || disconnectedStatus(tabId)
  return result
}

const supportsOverrides = (url = '') => {
  try {
    const parsed = new URL(url)
    return ['http:', 'https:', 'file:'].includes(parsed.protocol) &&
      parsed.hostname !== 'chromewebstore.google.com' &&
      !(parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'))
  } catch { return false }
}

const ownedDocument = async tabId => {
  try {
    // Ownership is checked by Chrome. This command does not run page JavaScript,
    // so checking a session does not wait for a busy/paused page script.
    const result = await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree')
    return { owned: true, frame: result?.frameTree?.frame }
  } catch (error) {
    if (/not attached|no tab|no target|target closed|cannot access|restricted|permission/i.test(error.message)) return { owned: false }
    throw error
  }
}

const describeError = error => {
  const message = errorText(error)
  if (/another debugger|already attached/i.test(message)) return '调试连接被占用，请检查此页面的开发者工具或冲突扩展，再点击恢复。'
  if (/timezone.*already in effect|locale.*already in effect/i.test(message)) return '已有其他时区或语言覆盖，请关闭开发者工具中的模拟设置或冲突扩展后重试。'
  if (/cannot access|not allowed|restricted|permission/i.test(message)) return '浏览器不允许修改此页面，请检查扩展权限或切换到普通网页。'
  if (/no tab|no target|target closed|not attached|detached/i.test(message)) return '页面连接已断开，请在网页加载完成后点击恢复重试。'
  if (/timed out|timeout/i.test(message)) return '网页核验超时，请等待页面响应后重试；可复制诊断查看失败阶段。'
  return `网页设置未成功应用：${message}`
}

const releaseTab = async tabId => {
  if (!(await ownedDocument(tabId)).owned) return
  releasingTabs.add(tabId)
  try { await chrome.debugger.detach({ tabId }) } finally { releasingTabs.delete(tabId) }
}

export const applySettingsToTab = (tabId, { resume = false } = {}) => {
  const state = stateFor(tabId)
  const requestedGeneration = state.generation
  const task = async () => {
    if (state.closed) return closedStatus(tabId)
    const generation = state.generation
    // A detach after the retry was requested is a new event, not permission to
    // reconnect. In particular, respect a cancellation during recovery/reload.
    const retry = resume && requestedGeneration === generation
    state.active = true
    state.startedAt = new Date().toISOString()
    const diagnostics = { stage: 'settings', error: null, observedTimezone: null, owned: null, document: null }
    const current = () => !state.closed && state.generation === generation
    const step = async (stage, action) => {
      if (!current()) throw new Error('Session changed during application')
      state.stage = diagnostics.stage = stage
      const result = await action()
      if (!current()) throw new Error('Session changed during application')
      return result
    }
    const finish = status => storeStatus(tabId, status, diagnostics, generation)
    try {
      const tab = await step('settings', () => chrome.tabs.get(tabId))
      if (tab.discarded) return finish({ ok: false, code: 'discarded', message: '页面休眠中，激活后应用设置。' })
      const previous = await getTabStatus(tabId)
      const settings = await step('settings', () => chrome.storage.local.get(SETTINGS_KEYS))
      const timezone = settings.timezone?.trim() || ''
      const locale = effectiveLocale(settings)
      diagnostics.requested = { mode: settings.configuration, timezone, locale, fontMode: settings.fontMode || 'auto' }
      const hasCoordinates = Number.isFinite(settings.lat) && Number.isFinite(settings.lon)
      const disabled = settings.configuration === 'browserDefault' || (!timezone && !locale && !hasCoordinates)
      const fontResult = await step('fonts', () => applyFontSettings(settings).catch(error => ({ error })))
      const connection = await step('ownership', () => ownedDocument(tabId))
      diagnostics.owned = connection.owned
      const wasPaused = pausedTabs.has(tabId) || previous?.code === 'paused'
      if (!disabled && wasPaused && !retry && !connection.owned) return finish(pausedStatus(tabId))
      // Check the real session before trusting a stored pause; clear a requested
      // retry even if navigation currently hides the target URL.
      if (retry || connection.owned || disabled) {
        pausedTabs.delete(tabId)
        if (wasPaused) await finish({ ok: false, code: 'loading', message: '正在重新核验网页连接…' })
      }
      if (disabled) {
        await step('restore', async () => {
          if (connection.owned) await restoreRelatedTargets(tabId)
          await forgetRelatedTargets(tabId)
          await releaseSharedTargets()
          await releaseTab(tabId)
        })
        if (fontResult.error) throw fontResult.error
        diagnostics.owned = false
        return finish({ ok: true, code: 'default', timezone: null, locale: null, font: fontResult.message, message: '已恢复浏览器默认设置；刷新网页可清除页面缓存的语言信息。' })
      }
      // getTargets supplies URLs without the additional tabs permission.
      const targets = await step('target', () => chrome.debugger.getTargets())
      const target = targets.find(entry => entry.tabId === tabId)
      const url = tab.pendingUrl || tab.url || target?.url || ''
      if (!supportsOverrides(url)) {
        return finish(tab.status === 'loading' || !url
          ? { ok: false, code: 'loading', message: '正在等待网页导航，加载完成后会自动核验。' }
          : { ok: false, code: 'unsupported', message: '此页面不支持修改时区，请在普通网页中使用。' })
      }
      if (timezone) new Intl.DateTimeFormat('en', { timeZone: timezone })
      if (!connection.owned) await step('attach', () => chrome.debugger.attach({ tabId }, '1.3'))
      diagnostics.owned = true
      await step('prepare', () => prepareRelatedTargets(tabId, settings))
      await step('timezone', () => chrome.debugger.sendCommand({ tabId }, 'Emulation.setTimezoneOverride', { timezoneId: timezone }))
      await step('language', () => applyLanguage(tabId, locale))
      await step('geolocation', () => hasCoordinates
        ? chrome.debugger.sendCommand({ tabId }, 'Emulation.setGeolocationOverride', { latitude: settings.lat, longitude: settings.lon, accuracy: 1 })
        : chrome.debugger.sendCommand({ tabId }, 'Emulation.clearGeolocationOverride'))
      const before = await step('document', () => ownedDocument(tabId))
      const actual = await step('readback', () => chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: 'Intl.DateTimeFormat().resolvedOptions().timeZone', returnByValue: true, timeout: 2000, disableBreaks: true,
      }))
      if (actual.exceptionDetails || typeof actual.result?.value !== 'string') throw new Error('无法读取当前网页时区。')
      diagnostics.observedTimezone = actual.result.value
      const expected = new Intl.DateTimeFormat('en', timezone ? { timeZone: timezone } : {}).resolvedOptions().timeZone
      const observed = new Intl.DateTimeFormat('en', { timeZone: actual.result.value }).resolvedOptions().timeZone
      if (observed !== expected) throw new Error(`网页仍为 ${actual.result.value}，目标为 ${expected}，请检查其他时区扩展。`)
      await step('related-targets', () => updateRelatedTargets(tabId, { resume: retry }))
      if (fontResult.error) throw new Error(`时区和语言已应用；${fontResult.error.message}`)
      const after = await step('document', () => ownedDocument(tabId))
      const currentTab = await step('document', () => chrome.tabs.get(tabId))
      diagnostics.owned = after.owned
      diagnostics.document = { loading: currentTab.status === 'loading', supported: supportsOverrides(after.frame?.url), changed: before.frame?.loaderId !== after.frame?.loaderId }
      if (!after.owned) throw new Error('Debugger is not attached')
      if (diagnostics.document.loading || !diagnostics.document.supported || diagnostics.document.changed) {
        return finish({ ok: false, prepared: true, code: 'loading', message: '设置已发送，网页仍在导航；加载完成后会自动核验当前文档。' })
      }
      diagnostics.stage = state.stage = 'complete'
      return finish({ ok: true, code: 'applied', timezone: actual.result.value, locale, font: fontResult.message, message: `当前网页已核验：${actual.result.value}${locale ? ' · ' + locale : ''}。` })
    } catch (error) {
      if (state.closed) return closedStatus(tabId)
      if (!current()) return await getTabStatus(tabId) || disconnectedStatus(tabId)
      diagnostics.error = errorText(error)
      return finish({ ok: false, code: 'error', message: describeError(error) })
    } finally { state.active = false }
  }
  const next = profileQueue.catch(() => {}).then(task)
  profileQueue = next.catch(() => {})
  return next
}

export const applySettingsToAllTabs = async (options = {}) => {
  const tabs = await chrome.tabs.query({})
  return Promise.all(tabs.filter(tab => Number.isInteger(tab.id)).map(tab => applySettingsToTab(tab.id, options)))
}

export const getTabDiagnostics = async tabId => {
  const status = await getTabStatus(tabId)
  const coverage = (await chrome.storage.session.get(`lc-time-coverage:${tabId}`))[`lc-time-coverage:${tabId}`]
  let browser = { userAgent: navigator.userAgent }
  try {
    if (navigator.userAgentData) browser = { ...browser, ...await navigator.userAgentData.getHighEntropyValues(['fullVersionList', 'platformVersion']) }
  } catch { /* The reduced UA is still useful when client hints are unavailable. */ }
  let connection
  try {
    const current = await ownedDocument(tabId)
    connection = { owned: current.owned }
    if (current.owned) {
      const actual = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: 'JSON.stringify({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,language:navigator.language,languages:navigator.languages,locale:Intl.DateTimeFormat().resolvedOptions().locale,readyState:document.readyState})',
        returnByValue: true, timeout: 2000, disableBreaks: true,
      })
      if (actual.exceptionDetails || typeof actual.result?.value !== 'string') throw new Error('无法读取当前页面诊断。')
      connection.actual = JSON.parse(actual.result.value)
    }
  } catch (error) { connection = { ...connection, error: errorText(error) } }
  return {
    extension: { name: 'LC-time', version: chrome.runtime.getManifest().version },
    capturedAt: new Date().toISOString(), browser, connection,
    operation: { running: !!stateFor(tabId).active, stage: stateFor(tabId).stage, startedAt: stateFor(tabId).startedAt },
    status: status || { code: 'unknown', message: '此页面还没有核验记录。' },
    coverage: coverage ? { ...coverage, errors: coverage.errors?.map(entry => ({ type: entry.type, message: errorText(entry.message) })) } : null,
  }
}

chrome.debugger.onDetach.addListener((source, reason) => {
  const { tabId } = source
  if (!Number.isInteger(tabId) || source.sessionId || releasingTabs.has(tabId)) return
  const state = stateFor(tabId)
  if (state.closed) return
  state.generation++
  if (reason === 'canceled_by_user') pausedTabs.add(tabId)
  // This is Chrome's event classification, not proof of a particular user action.
  storeStatus(tabId, reason === 'canceled_by_user' ? pausedStatus(tabId) : disconnectedStatus(tabId), {
    stage: state.stage, owned: false, error: null,
    lastDetach: { reason, at: new Date().toISOString(), stage: state.stage },
  }).catch(console.error)
})

chrome.tabs.onRemoved.addListener(tabId => {
  const state = stateFor(tabId)
  state.closed = true
  state.generation++
  pausedTabs.delete(tabId)
  forgetRelatedTargets(tabId).catch(console.error)
  state.writes = state.writes.catch(() => {}).then(() => chrome.storage.session.remove(statusKey(tabId)))
  state.writes.catch(console.error)
  profileQueue.finally(() => { if (states.get(tabId) === state) states.delete(tabId) }).catch(() => {})
})
