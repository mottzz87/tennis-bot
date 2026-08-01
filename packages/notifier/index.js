/**
 * Notifier — 通知格式化与发送
 *
 * 目前仅支持 Telegram，但通过抽象保持良好的接口，
 * 未来可扩展 LINE / Discord 等。
 */
const { formatCourt, formatCourtShort, formatTimeDisplay, formatDateDisplayFromIso, toMinutes } = require('@tennis-bot/utils')

// 拼接序列的场地字母串（去掉小时数）："2HF" → "HF"，"3F" → "F"，"A2B" → "AB"
function courtSeqShort(courts) {
  return String(courts || '').replace(/\d+/g, '')
}

// 总小时数：优先 duration，缺省时由起止时间推算；返回 "2h" / "2.5h"，无则 ''
function hoursLabel(d) {
  let minutes = Number(d.duration)
  if (!minutes || minutes <= 0) {
    const s = toMinutes(d.start)
    const e = toMinutes(d.end)
    if (e > s) minutes = e - s
  }
  if (!minutes || minutes <= 0) return ''
  const h = minutes / 60
  return `${Number.isInteger(h) ? h : +h.toFixed(1)}h`
}

// 统一通知样式：🎯 西葛西 Ｇ面 8.14（金） 10-12 | 2h
// 拼接时段场地显示字母序列（HF/DB），单面显示短场地名（Ｇ面）
function formatSlotText(d, platformConfig, options = {}) {
  const { showBike = false, style = 'compact' } = options
  const meta = platformConfig.PLACE_MAP?.[d.place] || {}
  const placeShort = meta.short || d.place
  const emoji = meta.emoji || '🎾'
  const bike = showBike && meta.bike ? ` ${meta.bike}` : ''
  const courtDisplay = courtSeqShort(d.courts) || formatCourtShort(d.court)

  let shortDate = d.dateDisplay
  if (!shortDate && /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '').trim())) {
    shortDate = formatDateDisplayFromIso(d.date)
  }
  if (!shortDate) {
    const dateMatch = String(d.date || '').match(/(\d+)年(\d+)月(\d+)日（(.)）/)
    shortDate = dateMatch ? `${dateMatch[2]}.${dateMatch[3]}（${dateMatch[4]}）` : d.date
  }

  const shortTime = formatTimeDisplay(d.time || `${d.start}-${d.end}`)
  const hours = hoursLabel(d)
  const hoursPart = hours ? ` | ${hours}` : ''

  const line = `${emoji} ${placeShort} ${courtDisplay} • ${shortDate} ${shortTime}${hoursPart}${bike}`
  if (style === 'detail') {
    return `${emoji} ${placeShort} ${courtDisplay}\n📅 ${shortDate} ⏰ ${shortTime}${hoursPart}${bike}`
  }
  return line
}

const TG_INLINE_BTN_TEXT_MAX = 64

function truncateTelegramButtonText(s, max = TG_INLINE_BTN_TEXT_MAX) {
  const str = String(s || '')
  if (str.length <= max) return str
  const chars = Array.from(str)
  if (chars.length <= max) return str
  return chars.slice(0, max - 1).join('') + '…'
}

function formatReminderButtonLabel(d, platformConfig) {
  const meta = platformConfig.PLACE_MAP?.[d.place] || {}
  const placeShort = (meta.short || d.place || '').trim()
  const court = String(formatCourt(d.court) || '').toUpperCase()
  const date = d.dateDisplay || d.date
  const t = formatTimeDisplay(d.time || `${d.start}-${d.end}`)
  const em = meta.emoji || '🎾'
  const s = `🔕 ${em} ${placeShort} ${court} · ${date} ${t}`
  return truncateTelegramButtonText(s)
}

/**
 * 转义 Telegram Markdown 特殊字符
 */
function escapeMarkdown(text) {
  return String(text).replace(/[_*`\[]/g, '\\$&')
}

module.exports = {
  formatSlotText,
  formatReminderButtonLabel,
  escapeMarkdown
}
