import { browserTimeZone, getClockTime, isValidTimeZone } from './clock.js'

export const CLOCK_ALARM = 'lc-time-clock'
const digits = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
  '-': ['000', '000', '111', '000', '000'],
}

export const drawClockIcon = (hours, minutes, size) => {
  const canvas = new OffscreenCanvas(size, size)
  const ctx = canvas.getContext('2d')
  const scale = size / 16
  ctx.scale(scale, scale)
  ctx.fillStyle = '#22384e'
  ctx.beginPath()
  ctx.roundRect(0, 0, 16, 16, 2)
  ctx.fill()
  ctx.fillStyle = '#c9ecf5'
  ;[hours, minutes].forEach((text, row) => {
    Array.from(text).forEach((digit, column) => {
      digits[digit].forEach((pixels, y) => {
        Array.from(pixels).forEach((on, x) => {
          if (on === '1') ctx.fillRect(3 + column * 6 + x, 2 + row * 7 + y, 1, 1)
        })
      })
    })
  })
  return ctx.getImageData(0, 0, size, size)
}

let updateQueue = Promise.resolve()
export const updateToolbarClock = () => {
  // Serialize reads and rendering to prevent rapid profile switches from restoring an old icon.
  updateQueue = updateQueue.catch(() => {}).then(async () => {
    const { timezone } = await chrome.storage.local.get('timezone')
    const zone = timezone || browserTimeZone()
    const valid = isValidTimeZone(zone)
    const { hours, minutes, date, offset } = valid
      ? getClockTime(zone)
      : { hours: '--', minutes: '--' }
    const imageData = Object.fromEntries([16, 32, 48, 128].map((size) => [size, drawClockIcon(hours, minutes, size)]))
    await chrome.action.setIcon({ imageData })
    await chrome.action.setTitle({ title: valid
      ? `LC-time · ${hours}:${minutes} · ${zone}\n${date} · ${offset}\n上行为小时，下行为分钟`
      : 'LC-time · 时区无效，请打开弹窗重新选择',
    })
  })
  return updateQueue
}

export const ensureClockAlarm = async () => {
  const alarm = await chrome.alarms.get(CLOCK_ALARM)
  if (!alarm) {
    await chrome.alarms.create(CLOCK_ALARM, {
      when: Math.ceil((Date.now() + 1000) / 60000) * 60000,
      periodInMinutes: 1,
    })
  }
}

const refresh = () => updateToolbarClock().catch((error) => console.error('LC-time clock:', error))
const initialize = () => {
  ensureClockAlarm().catch((error) => console.error('LC-time alarm:', error))
  refresh()
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLOCK_ALARM) refresh()
})
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('timezone' in changes || 'configuration' in changes)) refresh()
})
chrome.runtime.onStartup.addListener(initialize)
chrome.runtime.onInstalled.addListener(initialize)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'refresh-clock') return
  updateToolbarClock().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }))
  return true
})
// Recreate the alarm when the service worker wakes after a browser restart.
initialize()
