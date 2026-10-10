import './toolbarClock.js'
import { SETTINGS_KEYS, applySettingsToTab, applySettingsToAllTabs, getTabDiagnostics } from './debugger.js'
import { isReloadInProgress, reloadWithSettings } from './reload.js'

const applyTab = (tabId, options) => applySettingsToTab(tabId, options).catch(console.error)
const applyAll = (options) => applySettingsToAllTabs(options).catch(console.error)

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') chrome.tabs.create({ active: true, url: 'html/info.html' })
  applyAll()
})
chrome.runtime.onStartup.addListener(() => applyAll())

// Keep sessions attached across saves and reloads. Only release our own sessions
// when the user restores browser defaults.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && SETTINGS_KEYS.some((key) => key in changes)) applyAll({ resume: true })
})

chrome.tabs.onCreated.addListener((tab) => applyTab(tab.id))
chrome.tabs.onActivated.addListener(({ tabId }) => applyTab(tabId))
chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (changes.status === 'loading' || changes.status === 'complete') applyTab(tabId)
})

const onNavigation = ({ tabId, frameId }) => {
  if (frameId === 0 && tabId >= 0) applyTab(tabId)
}
chrome.webNavigation.onBeforeNavigate.addListener(onNavigation)
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, transitionType }) => {
  // A deliberate page reload also retries a disconnected session. Merely
  // activating a paused tab still leaves it paused and does not reopen the banner.
  if (frameId === 0 && tabId >= 0) applyTab(tabId, { resume: transitionType === 'reload' && !isReloadInProgress(tabId) })
})
chrome.webNavigation.onCompleted.addListener(onNavigation)

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return
  if (message?.type === 'get-tab-diagnostics' && Number.isInteger(message.tabId)) {
    getTabDiagnostics(message.tabId).then(sendResponse, error => sendResponse({ error: error.message }))
    return true
  }
  if (message?.type === 'apply-settings') {
    applySettingsToAllTabs({ resume: true }).then((results) => {
      sendResponse({ ok: true, current: results.find((result) => result.tabId === message.tabId) })
    }, (error) => sendResponse({ ok: false, message: error.message }))
    return true
  }
  if (message?.type === 'check-current-tab' && Number.isInteger(message.tabId)) {
    applySettingsToTab(message.tabId).then(sendResponse, (error) => sendResponse({ ok: false, message: error.message }))
    return true
  }
  if (message?.type === 'reload-with-settings' && Number.isInteger(message.tabId)) {
    reloadWithSettings(message.tabId).then(sendResponse, (error) => sendResponse({ ok: false, message: error.message }))
    return true
  }
})
