import locationsConfigurations from './locationsConfigurations.js'
import countryLocales from './countryLocales.js'
import { effectiveLocale, localeForTimezone } from './language.js'
import { browserTimeZone, getClockTime, isValidTimeZone } from './clock.js'

const $ = (id) => document.getElementById(id)
$('extensionVersion').textContent = `LC-time / ${chrome.runtime.getManifest().version}`
const configurationSelect = $('configuration')
const timeZoneInput = $('timeZone')
const localeInput = $('locale')
const latitudeInput = $('latitude')
const longitudeInput = $('longitude')
const ipToggle = $('ipTimezoneToggle')
const fontMode = $('fontMode')
let saveTimer
let savedConfiguration = 'browserDefault'
let activeZone = browserTimeZone()
let ipBusy = false
let activeTabId = null
let reloadBusy = false
let latestApplication
let coverage = null
const defaultProfile = { configuration: 'browserDefault', timezone: null, locale: null, lat: null, lon: null, fontMode: 'auto' }
let savedProfile = { ...defaultProfile }
let previousProfile = { ...defaultProfile }

const syncIpToggle = () => {
  const enabled = savedConfiguration === 'ipAddress'
  ipToggle.checked = enabled
  ipToggle.disabled = ipBusy
  ipToggle.setAttribute('aria-busy', String(ipBusy))
  configurationSelect.disabled = ipBusy || enabled
  ;[timeZoneInput, localeInput, latitudeInput, longitudeInput].forEach((input) => { input.disabled = ipBusy || enabled })
  fontMode.disabled = ipBusy
  $('reloadButton').disabled = ipBusy || reloadBusy
  $('ipToggleHint').textContent = ipBusy ? '正在获取 IP 时区…' : enabled ? '已开启，关闭后恢复之前的时区' : '开启后自动获取时区'
}

const showProfile = (profile) => {
  configurationSelect.value = profile.configuration || 'browserDefault'
  if (!configurationSelect.value) configurationSelect.value = 'custom'
  setInputs(profile.timezone, profile.locale, profile.lat, profile.lon)
  fontMode.value = profile.fontMode || 'auto'
  showCustomField()
}

Object.entries(locationsConfigurations).forEach(([key, location]) => {
  $('locationsOptGroup').appendChild(new Option(`${location.name} · ${location.timezone}`, key))
})
const timezones = [...new Set(['UTC', ...Intl.supportedValuesOf('timeZone')])].sort()
timezones.forEach((zone) => $('timezonesOptGroup').appendChild(new Option(zone, `zone:${zone}`)))

const setStatus = (message, state = '') => {
  $('saveStatus').textContent = message
  $('saveStatus').dataset.state = state
}

const showApplicationStatus = (result) => {
  latestApplication = result
  const partial = result?.ok && coverage?.errors?.length > 0
  if (result?.font) $('fontHint').textContent = `当前默认字体：${result.font}。网站指定的字体优先。`
  const applied = result?.ok && ['applied', 'default'].includes(result.code) && !(result.code === 'applied' && coverage?.pending > 0)
  const unavailable = ['unsupported', 'discarded'].includes(result?.code)
  const checking = !result || result.code === 'loading' || (result.code === 'applied' && coverage?.pending > 0)
  $('applicationState').dataset.state = partial ? 'error' : applied ? 'applied' : unavailable || checking ? 'pending' : 'error'
  $('applicationStateText').textContent = partial ? '部分应用' : applied ? '已应用' : unavailable ? '不适用' : checking ? '待核验' : '未应用'
  $('reloadLabel').textContent = partial ? '重试并刷新网页' : !applied && !unavailable && !checking ? '恢复并刷新网页' : '刷新当前网页'

  if (partial) {
    setStatus(`主页已应用；部分内嵌或后台环境未通过：${coverage.errors[0].message}`, 'error')
  } else if (result?.code === 'applied' && coverage?.pending > 0) {
    setStatus('主页已应用，正在核验内嵌与后台环境。')
  } else if (!result) {
    setStatus('设置已保存，请在需要修改时区的网页中打开扩展。')
  } else if (result.code === 'unsupported' || result.code === 'discarded' || result.code === 'loading') {
    setStatus(result.message)
  } else if (!result.ok) {
    setStatus(`设置已保存；${result.message || '网页未成功应用，请点击刷新重试。'}`, 'error')
  } else {
    setStatus(result.message || '设置已保存并应用，刷新网页可更新检测结果。', 'saved')
  }
}

const showCustomField = () => {
  $('customTimezoneField').hidden = configurationSelect.value !== 'custom'
}

const renderClock = () => {
  const valid = isValidTimeZone(activeZone)
  const time = valid ? getClockTime(activeZone) : { hours: '--', minutes: '--', seconds: '--', date: '请选择有效时区', offset: '—' }
  $('clockHours').textContent = time.hours
  $('clockMinutes').textContent = time.minutes
  $('clockSeconds').textContent = time.seconds
  $('clockDate').textContent = time.date
  $('clockZone').textContent = activeZone
  $('clockZone').title = activeZone
  $('clockOffset').textContent = time.offset
  $('clockSource').textContent = savedConfiguration === 'browserDefault' ? '浏览器默认时区' : savedConfiguration === 'ipAddress' ? '当前 IP 时区' : '所选时区'
}

const setInputs = (timezone, locale, lat, lon) => {
  timeZoneInput.value = timezone ?? ''
  localeInput.value = locale ?? ''
  latitudeInput.value = lat ?? ''
  longitudeInput.value = lon ?? ''
  timeZoneInput.removeAttribute('aria-invalid')
}

const saveToStorage = async (extraStorage = {}, { apply = true } = {}) => {
  const timezone = timeZoneInput.value.trim()
  if (timezone && !isValidTimeZone(timezone)) {
    timeZoneInput.setAttribute('aria-invalid', 'true')
    setStatus('时区无效，请输入例如 Asia/Shanghai；仍使用之前的设置。', 'error')
    return false
  }
  if (![latitudeInput, longitudeInput].every((input) => input.checkValidity())) {
    setStatus('纬度范围为 -90 至 90，经度范围为 -180 至 180。', 'error')
    return false
  }
  if (localeInput.value.trim()) {
    try { localeInput.value = Intl.getCanonicalLocales(localeInput.value.trim())[0] } catch {
      setStatus('语言区域无效，请输入例如 en-US、ja-JP 或 zh-CN。', 'error')
      return false
    }
  }
  timeZoneInput.removeAttribute('aria-invalid')
  const configuration = configurationSelect.value
  try {
    const profile = {
      configuration,
      timezone: timezone || null,
      locale: localeInput.value.trim() || null,
      lat: latitudeInput.value === '' ? null : Number(latitudeInput.value),
      lon: longitudeInput.value === '' ? null : Number(longitudeInput.value),
      fontMode: fontMode.value,
    }
    await chrome.storage.local.set({ ...profile, ...extraStorage })
    savedProfile = profile
    savedConfiguration = configuration
    activeZone = timezone || browserTimeZone()
    renderClock()
    syncIpToggle()
    if (!apply) return true
    showApplicationStatus(null)
    setStatus('已保存，正在应用到网页…')
    try {
      const response = await chrome.runtime.sendMessage({ type: 'apply-settings', tabId: activeTabId })
      showApplicationStatus(response?.current || (response?.ok === false ? response : null))
    } catch {
      showApplicationStatus({ ok: false, message: '无法连接后台，请在扩展管理页重新加载 LC-time。' })
    }
    return true
  } catch (error) {
    console.error('Error saving settings:', error)
    setStatus('保存失败，请重新打开扩展后重试。', 'error')
    return false
  }
}

const handleIpToggle = async () => {
  const enable = ipToggle.checked
  clearTimeout(saveTimer)
  ipBusy = true
  syncIpToggle()
  // Keep the requested visual state while the query is pending.
  ipToggle.checked = enable
  const originalProfile = { ...savedProfile }
  try {
    if (!enable) {
      showProfile(previousProfile)
      if (!await saveToStorage()) showProfile(originalProfile)
      return
    }
    setStatus('正在查询当前网络出口的时区…')
    // Keep the project's existing IP lookup service and settings mapping.
    const response = await fetch('http://ip-api.com/json?fields=status,message,countryCode,lat,lon,timezone,query', {
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) throw new Error(`IP lookup returned ${response.status}`)
    const data = await response.json()
    if (data.status !== 'success' || !data.timezone || !isValidTimeZone(data.timezone)) throw new Error(data.message || 'Invalid IP time zone')
    setInputs(data.timezone, countryLocales[data.countryCode] || localeForTimezone(data.timezone), data.lat, data.lon)
    configurationSelect.value = 'ipAddress'
    showCustomField()
    if (await saveToStorage({ previousProfile: originalProfile })) {
      previousProfile = originalProfile
    } else {
      showProfile(originalProfile)
    }
  } catch (error) {
    showProfile(originalProfile)
    setStatus('无法获取 IP 时区，已保留原设置，请重新开启开关重试。', 'error')
    console.error('Error fetching IP information:', error)
  } finally {
    ipBusy = false
    syncIpToggle()
  }
}

configurationSelect.addEventListener('change', async () => {
  clearTimeout(saveTimer)
  const configuration = configurationSelect.value
  showCustomField()
  if (configuration === 'custom') {
    timeZoneInput.focus()
    setStatus('输入 IANA 时区名称，修改后自动保存')
    return
  }
  if (configuration === 'browserDefault') {
    setInputs('', '', '', '')
  } else if (configuration.startsWith('zone:')) {
    timeZoneInput.value = configuration.slice(5)
    localeInput.value = localeForTimezone(timeZoneInput.value)
  } else {
    const location = locationsConfigurations[configuration]
    if (!location) return
    setInputs(location.timezone, location.locale, location.lat, location.lon)
  }
  await saveToStorage()
})

const handleInputChange = () => {
  configurationSelect.value = 'custom'
  showCustomField()
  clearTimeout(saveTimer)
  setStatus('正在保存…')
  saveTimer = setTimeout(saveToStorage, 300)
}
;[timeZoneInput, localeInput, latitudeInput, longitudeInput].forEach((input) => {
  input.addEventListener('input', handleInputChange)
  input.addEventListener('change', () => { clearTimeout(saveTimer); saveToStorage() })
})

fontMode.addEventListener('change', () => { clearTimeout(saveTimer); saveToStorage() })
ipToggle.addEventListener('change', handleIpToggle)
$('infoButton').addEventListener('click', () => chrome.tabs.create({ url: 'html/info.html' }))
$('reloadButton').addEventListener('click', async () => {
  if (reloadBusy) return
  clearTimeout(saveTimer)
  reloadBusy = true
  syncIpToggle()
  try {
    if (!await saveToStorage({}, { apply: false })) return
    showApplicationStatus({ ok: false, code: 'loading' })
    setStatus('正在恢复连接、刷新并核验网页…')
    const result = await chrome.runtime.sendMessage({ type: 'reload-with-settings', tabId: activeTabId })
    const state = await chrome.storage.session.get(`lc-time-coverage:${activeTabId}`)
    coverage = state[`lc-time-coverage:${activeTabId}`] || null
    showApplicationStatus(result)
  } catch {
    showApplicationStatus({ ok: false, message: '恢复失败，请关闭此页面的开发者工具或冲突扩展后重试。' })
  } finally {
    reloadBusy = false
    syncIpToggle()
  }
})

// Keep the open popup in sync with cancellations and navigation results.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || reloadBusy) return
  const change = changes[`lc-time-tab:${activeTabId}`]
  const coverageChange = changes[`lc-time-coverage:${activeTabId}`]
  if (coverageChange) coverage = coverageChange.newValue || null
  if (change || coverageChange) showApplicationStatus(change ? change.newValue : latestApplication)
})

try {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
  activeTabId = activeTab?.id ?? null
  const storage = await chrome.storage.local.get(['configuration', 'timezone', 'locale', 'lat', 'lon', 'fontMode', 'previousProfile'])
  savedProfile = Object.fromEntries(Object.entries(defaultProfile).map(([key, fallback]) => [key, storage[key] ?? fallback]))
  previousProfile = storage.previousProfile?.configuration !== 'ipAddress' && storage.previousProfile ? storage.previousProfile : { ...defaultProfile }
  savedConfiguration = savedProfile.configuration
  configurationSelect.value = savedConfiguration
  if (!configurationSelect.value) configurationSelect.value = 'custom'
  setInputs(storage.timezone, effectiveLocale(savedProfile), storage.lat, storage.lon)
  fontMode.value = savedProfile.fontMode
  activeZone = storage.timezone || browserTimeZone()
  showCustomField()
  renderClock()
  syncIpToggle()
  if (Number.isInteger(activeTabId)) {
    const result = await chrome.runtime.sendMessage({ type: 'check-current-tab', tabId: activeTabId })
    const state = await chrome.storage.session.get(`lc-time-coverage:${activeTabId}`)
    coverage = state[`lc-time-coverage:${activeTabId}`] || null
    showApplicationStatus(result)
  }
} catch (error) {
  setStatus('读取设置失败，请重新打开扩展。', 'error')
  console.error('Error loading settings:', error)
}
setInterval(renderClock, 1000)
chrome.runtime.sendMessage({ type: 'refresh-clock' }).catch(console.error)
