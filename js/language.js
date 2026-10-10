import countryLocales from './countryLocales.js'
import timezoneCountries from './timezoneCountries.js'

export const SETTINGS_KEYS = ['configuration', 'timezone', 'locale', 'lat', 'lon', 'fontMode']

const canonicalZone = (zone) => {
  try { return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone } catch { return zone }
}
const canonicalCountries = new Map(Object.entries(timezoneCountries).map(([zone, country]) => [canonicalZone(zone), country]))

export const localeForTimezone = (zone) => {
  const country = timezoneCountries[zone] || canonicalCountries.get(canonicalZone(zone))
  return countryLocales[country] || 'en-US'
}

export const effectiveLocale = (settings) => {
  if (settings.configuration === 'browserDefault') return ''
  const inferred = settings.timezone ? localeForTimezone(settings.timezone) : ''
  const locale = settings.configuration?.startsWith('zone:') ? inferred : settings.locale?.trim() || inferred
  return locale ? Intl.getCanonicalLocales(locale)[0] : ''
}

export const languageList = (locale) => [...new Set([locale, new Intl.Locale(locale).language])]

let identity
const nativeIdentity = async () => {
  if (!identity) {
    const value = { userAgent: navigator.userAgent }
    if (navigator.userAgentData) {
      const { uaFullVersion, ...metadata } = await navigator.userAgentData.getHighEntropyValues([
        'architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'wow64', 'formFactors', 'uaFullVersion',
      ])
      if (uaFullVersion) metadata.fullVersion = uaFullVersion
      value.userAgentMetadata = metadata
    }
    identity = value
  }
  return identity
}

export const applyLanguage = async (debuggee, locale) => {
  const target = typeof debuggee === 'number' ? { tabId: debuggee } : debuggee
  const params = locale
    ? { ...await nativeIdentity(), acceptLanguage: languageList(locale).join(',') }
    : { userAgent: '' }
  // Keep the browser's actual UA and client hints while changing language only.
  await chrome.debugger.sendCommand(target, 'Emulation.setUserAgentOverride', params)
  try {
    await chrome.debugger.sendCommand(target, 'Emulation.setLocaleOverride', { locale })
  } catch (error) {
    // Several native targets can share a renderer's locale. Accept an existing
    // override only if the readback below proves it is the requested value.
    if (!locale || !/locale override is already in effect/i.test(error.message)) throw error
  }
  if (!locale) return
  const actual = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: 'JSON.stringify({language:navigator.language,languages:navigator.languages,locale:Intl.DateTimeFormat().resolvedOptions().locale})',
    returnByValue: true,
  })
  if (actual.exceptionDetails || typeof actual.result?.value !== 'string') throw new Error('无法核验网页语言。')
  const observed = JSON.parse(actual.result.value)
  const expectedLocale = new Intl.DateTimeFormat(locale).resolvedOptions().locale
  if (observed.language !== locale || JSON.stringify(observed.languages) !== JSON.stringify(languageList(locale)) || observed.locale !== expectedLocale) {
    throw new Error(`网页语言未一致：${observed.language} / ${observed.locale}，目标 ${locale}。`)
  }
}
