function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeText(str) {
  if (!str) return ''
  return String(str)
    .toLowerCase()
    .replace(/　/g, ' ')
    .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, ' ')
    .trim()
}

function formatCourt(court) {
  if (!court) return ''
  court = court.replace(/　/g, ' ')
  court = court.replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
  const match = court.match(/第\s*(\d+)\s*コート/)
  if (!match) return court
  return `c${match[1]}`
}

function normalizeCourtAlias(str) {
  const s = normalizeText(str)
  let match = s.match(/(\d+)/)
  if (match) return `c${match[1]}`
  match = s.match(/([a-z])\s*(コート|court)/i)
  if (match) return `c${match[1].toLowerCase()}`
  return s
}

function parseSlotDayKey(d) {
  const dateStr = String(d.date).trim()
  const iso = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const m = dateStr.match(/(\d+)年(\d+)月(\d+)日/)
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]), day = Number(m[3])
  if (!y || !mo || !day) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseTimeSafe(timeStr) {
  if (!timeStr) return [0, 0]
  timeStr = timeStr.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  timeStr = timeStr.replace(/：/g, ':').replace(/～/g, '~')
  const start = timeStr.split(/[~\-]/)[0].trim()
  const [hStr = '0', mStr = '0'] = start.includes(':') ? start.split(':') : [start, '0']
  const h = Number(hStr), m = Number(mStr)
  if (Number.isNaN(h) || Number.isNaN(m)) return [0, 0]
  return [h, m]
}

function parseSlotStartDateTimeSafe(d) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(d.date).trim())) {
    const [h, m] = parseTimeSafe(String(d.time))
    return new Date(`${d.date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`)
  }
  const dayKey = parseSlotDayKey(d)
  if (!dayKey) return null
  const [hour, minute] = parseTimeSafe(String(d.time))
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null
  const [yStr, moStr, dayStr] = dayKey.split('-')
  return new Date(Number(yStr), Number(moStr) - 1, Number(dayStr), hour, minute, 0, 0)
}

function normalizeTimeRange(timeStr) {
  const raw = String(timeStr || '')
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/：/g, ':')
    .replace(/～/g, '~')
    .trim()
  if (/^\d{1,2}-\d{1,2}$/.test(raw)) return raw
  const [startRaw = '0', endRaw = '0'] = raw.split(/[~\-]/)
  const toHour = (s) => {
    const v = String(s || '').trim()
    if (!v) return '0'
    const h = Number(v.includes(':') ? v.split(':')[0] : v)
    return Number.isNaN(h) ? '0' : String(h)
  }
  return `${toHour(startRaw)}-${toHour(endRaw)}`
}

const WEEKDAY_JP = ['日', '月', '火', '水', '木', '金', '土']

function formatDateDisplayFromIso(iso) {
  const s = String(iso || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return ''
  const [y, mo, d] = s.split('-').map(Number)
  const dt = new Date(y, mo - 1, d)
  return `${mo}.${String(d).padStart(2, '0')}（${WEEKDAY_JP[dt.getDay()]}）`
}

function formatTimeDisplay(time) {
  const raw = String(time || '').trim()
  const parts = raw.split(/[~\-]/)
  if (parts.length === 2) {
    // 整点去掉 :00，非整点保留分钟（如 12:00-14:00 → 12-14，12:30-14:00 → 12:30-14）
    const fmt = p => {
      const m = String(p).trim().match(/^(\d{1,2})(?::(\d{2}))?$/)
      if (!m) return String(p).trim()
      const h = String(m[1]).padStart(2, '0')
      const mm = m[2]
      return mm === '00' || mm == null ? h : `${h}:${mm}`
    }
    return `${fmt(parts[0])}-${fmt(parts[1])}`
  }
  return raw.replace('~', '–')
}

function toMinutes(timeStr) {
  const t = String(timeStr).trim()
  if (t.includes(':')) {
    const [hour = 0, minute = 0] = t.split(':').map(Number)
    return hour * 60 + minute
  }
  const hour = Number(t)
  if (Number.isNaN(hour)) return 0
  return hour * 60
}

function createTrace() {
  return Math.random().toString(36).slice(2, 8)
}

async function clickByText(page, text) {
  await page.getByText(text, { exact: false }).first().click()
}

module.exports = {
  sleep,
  normalizeText,
  formatCourt,
  normalizeCourtAlias,
  parseSlotDayKey,
  parseTimeSafe,
  parseSlotStartDateTimeSafe,
  normalizeTimeRange,
  formatDateDisplayFromIso,
  formatTimeDisplay,
  toMinutes,
  createTrace,
  clickByText,
  WEEKDAY_JP
}
