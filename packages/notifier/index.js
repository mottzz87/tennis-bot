/**
 * Notifier — 通知格式化与发送
 *
 * 目前仅支持 Telegram，但通过抽象保持良好的接口，
 * 未来可扩展 LINE / Discord 等。
 */
const { formatCourt, formatTimeDisplay, formatDateDisplayFromIso } = require('@tennis-bot/utils')

function formatSlotText(d, platformConfig, options = {}) {
  const { showBike = false, style = 'compact' } = options
  const meta = platformConfig.PLACE_MAP?.[d.place] || {}
  const placeShort = meta.short || d.place
  const emoji = meta.emoji || '🎾'
  const bike = showBike && meta.bike ? ` ${meta.bike}` : ''
  const courtDisplay = String(formatCourt(d.court) || '').toUpperCase()

  let shortDate = d.dateDisplay
  if (!shortDate && /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '').trim())) {
    shortDate = formatDateDisplayFromIso(d.date)
  }
  if (!shortDate) {
    const dateMatch = String(d.date || '').match(/(\d+)年(\d+)月(\d+)日（(.)）/)
    shortDate = dateMatch ? `${dateMatch[2]}.${dateMatch[3]}（${dateMatch[4]}）` : d.date
  }

  const shortTime = formatTimeDisplay(d.time || `${d.start}-${d.end}`)

  if (style === 'detail') {
    return `${emoji} ${placeShort}｜${courtDisplay}\n📅 ${shortDate} ⏰ ${shortTime}${bike}`
  }
  return `${emoji} ${placeShort} ${formatCourt(d.court)} ${shortDate} ${shortTime}${bike}`
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
  const t = formatTimeDisplay(d.time || `${d.start}-${d.end}`)
  const em = meta.emoji || '🎾'
  const s = `🔕 ${em} ${placeShort} ${court} · ${t}`
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
