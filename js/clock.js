// Shared by the popup and toolbar so both always use the same saved time zone.
export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

export const isValidTimeZone = (timeZone) => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone }).format()
    return true
  } catch {
    return false
  }
}

export const getClockTime = (timeZone = browserTimeZone(), now = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  }).formatToParts(now)
  const value = (type) => parts.find((part) => part.type === type)?.value
  return {
    hours: value('hour'), minutes: value('minute'), seconds: value('second'),
    offset: value('timeZoneName').replace('GMT', 'UTC'),
    date: new Intl.DateTimeFormat('zh-CN', {
      timeZone, month: 'long', day: 'numeric', weekday: 'long',
    }).format(now),
  }
}
