import { SETTINGS_KEYS, applyLanguage, effectiveLocale } from './language.js'
import { applyFontSettings } from './fonts.js'
import { prepareRelatedTargets, updateRelatedTargets, forgetRelatedTargets, releaseSharedTargets, restoreRelatedTargets } from './relatedTargets.js'

// Own each tab's session independently; serialize profile updates because
// locale ownership can be shared by several targets in the same renderer. An attached target may belong
// to DevTools or another extension, so getTargets().attached is not proof of success.
export { SETTINGS_KEYS }
const queues = new Map()
let profileQueue = Promise.resolve()
const pausedTabs = new Set()
const releasingTabs = new Set()
const statusKey = (tabId) => `lc-time-tab:${tabId}`
const pausedStatus = (tabId) => ({ tabId, ok: false, code: 'paused', message: '当前网页未应用：调试连接已取消。点击下方“恢复并刷新网页”重新启用；关闭顶部提示也会断开连接。' })

const storeStatus = async (tabId, status) => {
  const result = { tabId, ...status }
  await chrome.storage.session.set({ [statusKey(tabId)]: result })
  return result
}

export const getTabStatus = async (tabId) => {
  const data = await chrome.storage.session.get(statusKey(tabId))
  return data[statusKey(tabId)]
}

const serialize = (tabId, task) => {
  const previous = profileQueue
  const next = previous.catch(() => {}).then(task)
  profileQueue = next.catch(() => {})
  queues.set(tabId, next)
  next.finally(() => {
    if (queues.get(tabId) === next) queues.delete(tabId)
  }).catch(() => {})
  return next
}

const supportsOverrides = (url = '') => {
  try {
    const parsed = new URL(url)
    return ['http:', 'https:', 'file:'].includes(parsed.protocol) &&
      parsed.hostname !== 'chromewebstore.google.com' &&
      !(parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'))
  } catch {
    return false
  }
}

const isOurSession = async (tabId) => {
  try {
    // Chrome checks session ownership before executing this harmless expression.
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: '0', returnByValue: true,
    })
    return true
  } catch {
    return false
  }
}

const describeError = (error) => {
  const message = error?.message || String(error)
  if (/another debugger|already attached/i.test(message)) {
    return '调试连接被占用，请关闭此页面的开发者工具或冲突扩展，再点击刷新重试。'
  }
  if (/timezone.*already in effect|locale.*already in effect/i.test(message)) {
    return '已有其他时区或语言覆盖，请关闭开发者工具中的模拟设置或冲突扩展后重试。'
  }
  if (/cannot access|not allowed|restricted|permission/i.test(message)) {
    return '浏览器不允许修改此页面，请检查扩展权限或切换到普通网页。'
  }
  if (/no tab|no target|target closed|not attached|detached/i.test(message)) {
    return '页面连接已断开，请在网页加载完成后点击刷新重试。'
  }
  return `网页设置未成功应用：${message}`
}

const releaseTab = async (tabId) => {
  if (!await isOurSession(tabId)) return
  releasingTabs.add(tabId)
  try {
    await chrome.debugger.detach({ tabId })
  } finally {
    releasingTabs.delete(tabId)
  }
}

export const applySettingsToTab = (tabId, { resume = false } = {}) => serialize(tabId, async () => {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (tab.discarded) return { tabId, ok: false, code: 'discarded', message: '页面休眠中，激活后应用设置。' }
    const previous = await getTabStatus(tabId)
    const settings = await chrome.storage.local.get(SETTINGS_KEYS)
    const fontResult = await applyFontSettings(settings).catch(error => ({ error }))
    if (settings.configuration !== 'browserDefault' && (pausedTabs.has(tabId) || previous?.code === 'paused') && !resume) return pausedStatus(tabId)
    // getTargets supplies URLs without requesting the additional tabs permission.
    const target = (await chrome.debugger.getTargets()).find((entry) => entry.tabId === tabId)
    const url = tab.pendingUrl || tab.url || target?.url || ''
    if (!supportsOverrides(url)) {
      return storeStatus(tabId, { ok: false, code: 'unsupported', message: '此页面不支持修改时区，请在普通网页中使用。' })
    }
    // Read inside the queue: a slow earlier update must never restore stale settings.
    const timezone = settings.timezone?.trim() || ''
    const locale = effectiveLocale(settings)
    const hasCoordinates = Number.isFinite(settings.lat) && Number.isFinite(settings.lon)
    const disabled = settings.configuration === 'browserDefault' || (!timezone && !locale && !hasCoordinates)
    if (disabled) {
      pausedTabs.delete(tabId)
      if (await isOurSession(tabId)) await restoreRelatedTargets(tabId)
      await forgetRelatedTargets(tabId)
      await releaseSharedTargets()
      await releaseTab(tabId)
      if (fontResult.error) throw fontResult.error
      return storeStatus(tabId, { ok: true, code: 'default', timezone: null, locale: null, font: fontResult.message, message: '已恢复浏览器默认设置；刷新网页可清除页面缓存的语言信息。' })
    }
    if (resume) pausedTabs.delete(tabId)
    if (timezone) new Intl.DateTimeFormat('en', { timeZone: timezone })
    if (!await isOurSession(tabId)) {
      await chrome.debugger.attach({ tabId }, '1.3')
    }
    await prepareRelatedTargets(tabId, settings)
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setTimezoneOverride', { timezoneId: timezone })
    await applyLanguage(tabId, locale)
    if (hasCoordinates) {
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setGeolocationOverride', {
        latitude: settings.lat, longitude: settings.lon, accuracy: 1,
      })
    } else {
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearGeolocationOverride')
    }
    // A saved value and an accepted command are not sufficient: read back the page.
    const actual = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: 'Intl.DateTimeFormat().resolvedOptions().timeZone', returnByValue: true,
    })
    if (actual.exceptionDetails || typeof actual.result?.value !== 'string') {
      throw new Error('无法读取当前网页时区，请刷新重试。')
    }
    const expected = new Intl.DateTimeFormat('en', timezone ? { timeZone: timezone } : {}).resolvedOptions().timeZone
    const observed = new Intl.DateTimeFormat('en', { timeZone: actual.result.value }).resolvedOptions().timeZone
    if (observed !== expected) {
      throw new Error(`网页仍为 ${actual.result.value}，目标为 ${expected}，请检查其他时区扩展。`)
    }
    if (pausedTabs.has(tabId)) return pausedStatus(tabId)
    await updateRelatedTargets(tabId, { resume })
    if (pausedTabs.has(tabId)) return pausedStatus(tabId)
    if (fontResult.error) throw new Error(`时区和语言已应用；${fontResult.error.message}`)
    return storeStatus(tabId, { ok: true, code: 'applied', timezone: actual.result.value, locale, font: fontResult.message, message: `当前网页已核验：${actual.result.value}${locale ? ' · ' + locale : ''}。` })
  } catch (error) {
    if (pausedTabs.has(tabId)) return pausedStatus(tabId)
    return storeStatus(tabId, { ok: false, code: 'error', message: describeError(error) })
  }
})

export const applySettingsToAllTabs = async (options = {}) => {
  const tabs = await chrome.tabs.query({})
  return Promise.all(tabs.filter((tab) => Number.isInteger(tab.id)).map((tab) => applySettingsToTab(tab.id, options)))
}

chrome.debugger.onDetach.addListener((source, reason) => {
  const { tabId } = source
  if (!Number.isInteger(tabId)) return
  if (releasingTabs.has(tabId)) return
  if (reason === 'canceled_by_user') {
    pausedTabs.add(tabId)
    // Respect Cancel. Navigation must not continually reopen the notification.
    storeStatus(tabId, pausedStatus(tabId)).catch(console.error)
  } else {
    storeStatus(tabId, { ok: false, code: 'disconnected', message: '页面连接已断开，加载网页后会重新尝试。' }).catch(console.error)
  }
})

chrome.tabs.onRemoved.addListener((tabId) => {
  pausedTabs.delete(tabId)
  forgetRelatedTargets(tabId).catch(console.error)
  chrome.storage.session.remove(statusKey(tabId)).catch(console.error)
})
