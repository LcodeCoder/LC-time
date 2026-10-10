import { effectiveLocale } from './language.js'

const families = ['standard', 'sansserif', 'serif', 'fixed']
const candidates = {
  Hans: { sans: ['PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC'], serif: ['Songti SC', 'SimSun', 'Noto Serif CJK SC'] },
  Hant: { sans: ['PingFang TC', 'Microsoft JhengHei', 'Noto Sans CJK TC'], serif: ['Songti TC', 'PMingLiU', 'Noto Serif CJK TC'] },
  Jpan: { sans: ['Hiragino Sans', 'Yu Gothic', 'Meiryo', 'Noto Sans CJK JP'], serif: ['Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif CJK JP'] },
  Kore: { sans: ['Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans CJK KR'], serif: ['AppleMyungjo', 'Batang', 'Noto Serif CJK KR'] },
  Arab: { sans: ['Geeza Pro', 'Tahoma', 'Noto Sans Arabic'], serif: ['Geeza Pro', 'Times New Roman', 'Noto Naskh Arabic'] },
  Hebr: { sans: ['Arial Hebrew', 'Arial', 'Noto Sans Hebrew'], serif: ['Times New Roman', 'Noto Serif Hebrew'] },
  Deva: { sans: ['Kohinoor Devanagari', 'Nirmala UI', 'Noto Sans Devanagari'], serif: ['Devanagari Sangam MN', 'Noto Serif Devanagari'] },
  Thai: { sans: ['Thonburi', 'Leelawadee UI', 'Noto Sans Thai'], serif: ['Thonburi', 'Noto Serif Thai'] },
}
const latin = { sans: ['Arial', 'Helvetica', 'Liberation Sans', 'Noto Sans'], serif: ['Times New Roman', 'Times', 'Liberation Serif', 'Noto Serif'] }
let queue = Promise.resolve()
let lastSignature
let lastResult
let installedFonts

globalThis.chrome?.fontSettings?.onFontChanged?.addListener(() => { lastSignature = undefined })

const updateFonts = async (settings) => {
  const locale = effectiveLocale(settings)
  const enabled = settings.configuration !== 'browserDefault' && settings.fontMode !== 'browser' && !!locale
  const signature = JSON.stringify([enabled, locale])
  if (signature === lastSignature) return lastResult
  lastSignature = undefined
  if (!chrome.fontSettings) throw new Error('字体权限尚未生效，请在扩展管理页重新加载 LC-time。')
  const { managedFontSettings = [] } = await chrome.storage.local.get('managedFontSettings')
  let entries = []
  let standard = null
  if (enabled) {
    installedFonts ||= await chrome.fontSettings.getFontList()
    const available = new Map(installedFonts.map(font => [font.fontId.toLowerCase(), font.fontId]))
    for (const font of installedFonts) available.set(font.displayName.toLowerCase(), font.fontId)
    const script = new Intl.Locale(locale).maximize().script
    const pick = (names) => names.map(name => available.get(name.toLowerCase())).find(Boolean)
    const choice = candidates[script] || latin
    const sans = pick(choice.sans)
    const serif = pick(choice.serif)
    const fixed = pick(['Menlo', 'Consolas', 'Liberation Mono', 'Noto Sans Mono', 'Courier New'])
    // If no matching script font is installed, retain the browser's own fallback.
    const fonts = { standard: sans, sansserif: sans, serif, fixed }
    standard = sans
    const scripts = ['Zyyy', script === 'Kore' ? 'Hang' : script]
    entries = [...new Set(scripts)].flatMap(script => families.filter(family => fonts[family]).map(genericFamily => ({ script, genericFamily, fontId: fonts[genericFamily] })))
    for (const entry of entries) {
      const current = await chrome.fontSettings.getFont({ script: entry.script, genericFamily: entry.genericFamily })
      if (['not_controllable', 'controlled_by_other_extensions'].includes(current.levelOfControl)) {
        throw new Error('默认字体被浏览器策略或其他字体扩展控制，请检查冲突。')
      }
    }
  }
  // Persist ownership before writes so a worker restart can still restore defaults.
  const allKeys = [...new Map([...managedFontSettings, ...entries].map(({ script, genericFamily }) => [`${script}:${genericFamily}`, { script, genericFamily }])).values()]
  await chrome.storage.local.set({ managedFontSettings: allKeys })
  const nextKeys = new Set(entries.map(entry => `${entry.script}:${entry.genericFamily}`))
  for (const key of managedFontSettings) {
    if (!nextKeys.has(`${key.script}:${key.genericFamily}`)) await chrome.fontSettings.clearFont(key)
  }
  for (const entry of entries) {
    await chrome.fontSettings.setFont(entry)
    const actual = await chrome.fontSettings.getFont({ script: entry.script, genericFamily: entry.genericFamily })
    if (actual.fontId !== entry.fontId) throw new Error('默认字体设置未成功应用，请检查其他字体扩展。')
  }
  await chrome.storage.local.set({ managedFontSettings: entries.map(({ script, genericFamily }) => ({ script, genericFamily })) })
  lastSignature = signature
  lastResult = { enabled, standard, message: enabled ? standard || '浏览器字体回退' : '浏览器默认字体' }
  return lastResult
}

export const applyFontSettings = (settings) => {
  const next = queue.catch(() => {}).then(() => updateFonts(settings))
  queue = next
  return next
}
