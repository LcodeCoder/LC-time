import test from 'node:test'
import assert from 'node:assert/strict'
import { effectiveLocale, languageList, localeForTimezone } from '../js/language.js'
import { applyFontSettings } from '../js/fonts.js'
import { fakeFontSettings } from './helpers/fontSettings.mjs'

test('timezone selection replaces stale language while custom and IP profiles preserve their chosen language', () => {
  assert.equal(effectiveLocale({ configuration: 'zone:Asia/Tokyo', timezone: 'Asia/Tokyo', locale: 'en-US' }), 'ja-JP')
  assert.equal(effectiveLocale({ configuration: 'custom', timezone: 'Asia/Tokyo', locale: 'fr-FR' }), 'fr-FR')
  assert.equal(effectiveLocale({ configuration: 'ipAddress', timezone: 'America/Toronto', locale: 'fr-CA' }), 'fr-CA')
  assert.equal(localeForTimezone('Asia/Calcutta'), 'hi-IN')
  assert.equal(localeForTimezone('America/Los_Angeles'), 'en-US')
  assert.deepEqual(languageList('zh-TW'), ['zh-TW', 'zh'])
  assert.throws(() => effectiveLocale({ configuration: 'custom', locale: 'bad_locale' }), RangeError)
})

test('font changes use installed fonts and restore the user defaults when switched off', async () => {
  const local = {}
  const api = fakeFontSettings()
  api.defaults.set('Zyyy:standard', 'My original font')
  globalThis.chrome = {
    fontSettings: api,
    storage: { local: { get: async () => ({ ...local }), set: async (data) => Object.assign(local, data) } },
  }
  await applyFontSettings({ configuration: 'zone:Asia/Tokyo', timezone: 'Asia/Tokyo' })
  assert.equal((await api.getFont({ genericFamily: 'standard' })).fontId, 'Hiragino Sans')
  assert.equal((await api.getFont({ genericFamily: 'standard', script: 'Jpan' })).fontId, 'Hiragino Sans')
  await applyFontSettings({ configuration: 'zone:America/Los_Angeles', timezone: 'America/Los_Angeles' })
  assert.equal((await api.getFont({ genericFamily: 'standard' })).fontId, 'Arial')
  assert.equal(api.overrides.has('Jpan:standard'), false, 'previous script overrides are released')
  await applyFontSettings({ configuration: 'zone:America/Los_Angeles', timezone: 'America/Los_Angeles', fontMode: 'browser' })
  assert.equal((await api.getFont({ genericFamily: 'standard' })).fontId, 'My original font')
  assert.equal(api.overrides.size, 0)
  assert.deepEqual(local.managedFontSettings, [])
})
