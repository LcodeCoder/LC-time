import { applySettingsToTab } from './debugger.js'

const reloadsInProgress = new Set()
export const isReloadInProgress = (tabId) => reloadsInProgress.has(tabId)

export const reloadWithSettings = async (tabId) => {
  const before = await applySettingsToTab(tabId, { resume: true })
  if (!before.ok && !before.prepared) return before
  // The pre-reload result alone does not prove that the new document kept it.
  let finish
  let timer
  const completed = new Promise((resolve) => { finish = resolve })
  const onUpdated = (id, changes) => {
    if (id === tabId && changes.status === 'complete') finish(true)
  }
  const onRemoved = (id) => { if (id === tabId) finish(false) }
  chrome.tabs.onUpdated.addListener(onUpdated)
  chrome.tabs.onRemoved.addListener(onRemoved)
  try {
    timer = setTimeout(() => finish(false), 12000)
    reloadsInProgress.add(tabId)
    await chrome.tabs.reload(tabId)
    if (!await completed) {
      return { tabId, ok: false, code: 'loading', message: '网页仍在加载或已关闭；加载完成后会自动核验时区。' }
    }
    // Do not resume a new cancellation that happened during the reload.
    return await applySettingsToTab(tabId)
  } finally {
    reloadsInProgress.delete(tabId)
    clearTimeout(timer)
    chrome.tabs.onUpdated.removeListener(onUpdated)
    chrome.tabs.onRemoved.removeListener(onRemoved)
  }
}
