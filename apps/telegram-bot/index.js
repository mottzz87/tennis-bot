/**
 * Telegram Bot
 *
 * 独立的 Telegram 交互服务
 * - 处理所有用户命令和按钮回调
 * - 通过 HTTP API 与 Monitor Service 和 Booking Service 通信
 * - 管理预约提醒
 *
 * 不执行扫描、不执行预约、不管理预约数据
 */
require('dotenv').config()
const http = require('http')
const { spawn } = require('child_process')
const path = require('path')
const TelegramBot = require('node-telegram-bot-api')
const { formatSlotText, formatReminderButtonLabel, escapeMarkdown } = require('@tennis-bot/notifier')
const { parseSlotStartDateTimeSafe, parseSlotDayKey, formatCourt, formatTimeDisplay } = require('@tennis-bot/utils')

const MONITOR_HOST = process.env.MONITOR_HOST || 'http://localhost:3000'
const BOOKING_HOST = process.env.BOOKING_HOST || 'http://localhost:4000'

// Bot Token 解析：优先 BOT_TOKEN，回退到第一个 <PLATFORM>_BOT_TOKEN
function resolveBotToken() {
  if (process.env.BOT_TOKEN) return process.env.BOT_TOKEN
  for (const key of Object.keys(process.env)) {
    if (key.endsWith('_BOT_TOKEN') && process.env[key]) {
      console.log(`[telegram-bot] 使用 ${key} 作为 polling token`)
      return process.env[key]
    }
  }
  return null
}

function resolveChatId() {
  if (process.env.CHAT_ID) return process.env.CHAT_ID
  for (const key of Object.keys(process.env)) {
    if (key.endsWith('_CHAT_ID') && process.env[key]) {
      console.log(`[telegram-bot] 使用 ${key} 作为 ADMIN_ID`)
      return process.env[key]
    }
  }
  return null
}

const BOT_TOKEN = resolveBotToken()
if (!BOT_TOKEN) {
  console.error('[telegram-bot] 未找到 BOT_TOKEN，请在 .env 中配置 BOT_TOKEN 或 <PLATFORM>_BOT_TOKEN')
  process.exit(1)
}

const ADMIN_ID = Number(resolveChatId())
if (!ADMIN_ID) {
  console.error('[telegram-bot] 未找到 CHAT_ID，请在 .env 中配置 CHAT_ID 或 <PLATFORM>_CHAT_ID')
  process.exit(1)
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true })

// ========================
// HTTP Helpers
// ========================
function httpRequest(host, method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, host)
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' }
    }
    const req = http.request(opts, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }) }
        catch { resolve({ status: res.statusCode, data }) }
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

function monitorApi(method, path, body) {
  return httpRequest(MONITOR_HOST, method, path, body)
}

function bookingApi(method, path, body) {
  return httpRequest(BOOKING_HOST, method, path, body)
}

// 平台配置缓存
let _platformsCache = null
async function getPlatformConfig(platformName) {
  if (!_platformsCache) {
    try {
      const res = await monitorApi('GET', '/api/status')
      _platformsCache = res.data?.config?.platforms || {}
    } catch {
      return {}
    }
  }
  return _platformsCache[platformName] || {}
}

// ========================
// Auth
// ========================
function isAdmin(msg) {
  return msg.from.id === ADMIN_ID
}

// ========================
// 状态
// ========================
let remindedSet = new Set()
let reminderIndex = {}
let lastBookedReminderAt = 0

// ========================
// Panel / Formatting
// ========================
function buildPanelKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📊 系统状态', callback_data: 'quick_status' },
        { text: '📈 抢场统计', callback_data: 'quick_stats' }
      ],
      [
        { text: '📅 预约日程', callback_data: 'quick_schedule' },
        { text: '📚 预约记录', callback_data: 'quick_booked' },
      ],
      [
        { text: '⏸️ 暂停监控', callback_data: 'quick_pause' },
        { text: '▶️ 恢复监控', callback_data: 'quick_resume' }
      ],
      [
        { text: '⬆️ 自动更新', callback_data: 'quick_update' }
      ]
    ]
  }
}

const TG_BTN_MAX = 64

function formatToggleButtonLabel(d, platformConfig) {
  const meta = platformConfig.PLACE_MAP?.[d.place] || {}
  const placeShort = (meta.short || d.place || '').trim()
  const court = String(formatCourt(d.court) || '').toUpperCase()
  const t = formatTimeDisplay(d.time || `${d.start}-${d.end}`)
  const date = d.dateDisplay || d.date
  const bell = d.reminderEnabled === false ? '🔕' : '🔔'
  const s = `${bell} ${meta.emoji || '🎾'} ${placeShort} ${court} · ${date} ${t}`
  return Array.from(s).length > TG_BTN_MAX ? Array.from(s).slice(0, TG_BTN_MAX - 1).join('') + '…' : s
}

// ========================
// Reminder helpers
// ========================
function getBookedReminderIntervalMs() {
  // Default 2 hours, read from env
  const hours = Number(process.env.BOOKED_REMINDER_INTERVAL_HOURS)
  if (Number.isFinite(hours) && hours > 0) return Math.floor(hours * 60 * 60 * 1000)
  return 2 * 60 * 60 * 1000
}

function getFutureBookedSlots(slots) {
  const now = Date.now()
  return slots.filter(s => {
    const start = parseSlotStartDateTimeSafe(s)
    return start && start.getTime() > now
  })
}

function eligibleForBookedSummary(s, intervalMs) {
  if (s.reminderEnabled === false) return false
  if (s.bookedAt == null) return true
  return Date.now() >= s.bookedAt + intervalMs
}

function registerReminderMessage(ucode, chatId, messageId) {
  if (!ucode || !chatId || !messageId) return
  if (!reminderIndex[ucode]) reminderIndex[ucode] = []
  reminderIndex[ucode].push({ chatId, messageId })
}

function pruneReminderIndexForUcode(ucode) {
  if (!ucode || !reminderIndex[ucode]) return
  delete reminderIndex[ucode]
}

async function deleteReminderMessagesByUcode(ucode) {
  const list = reminderIndex[ucode] || []
  if (list.length === 0) return 0
  const CONCURRENCY = 6
  let deleted = 0
  for (let i = 0; i < list.length; i += CONCURRENCY) {
    const chunk = list.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      chunk.map(item => bot.deleteMessage(item.chatId, String(item.messageId)))
    )
    deleted += results.filter(r => r.status === 'fulfilled').length
  }
  delete reminderIndex[ucode]
  return deleted
}

async function pushBookedReminder() {
  const res = await bookingApi('GET', '/api/booked/schedule')
  if (!res.data?.slots) return
  const future = res.data.slots.filter(s => eligibleForBookedSummary(s, getBookedReminderIntervalMs()))
  if (future.length === 0) return

  const grouped = new Map()
  for (const d of future) {
    const dayKey = d.date
    if (!grouped.has(dayKey)) grouped.set(dayKey, [])
    grouped.get(dayKey).push(d)
  }

  for (const [dayKey, list] of grouped.entries()) {
    list.sort((a, b) => {
      const ta = parseSlotStartDateTimeSafe(a)?.getTime() ?? 0
      const tb = parseSlotStartDateTimeSafe(b)?.getTime() ?? 0
      return ta - tb
    })
    const dayTitle = list[0].dateDisplay || dayKey
    const buttons = await Promise.all(list.map(async d => {
      const pc = await getPlatformConfig(d.platform)
      return [{
        text: formatReminderButtonLabel(d, pc),
        callback_data: `del_booked_${d.ucode}`
      }]
    }))
    const sent = await bot.sendMessage(
      ADMIN_ID,
      `📅 已预约提醒（${dayTitle}）\n━━━━━━━━━━━━━━\n`,
      { reply_markup: { inline_keyboard: buttons } }
    )
    for (const d of list) {
      registerReminderMessage(d.ucode, sent.chat.id, sent.message_id)
    }
  }
}

async function pushUpcomingReminder() {
  const res = await bookingApi('GET', '/api/booked/schedule')
  if (!res.data?.slots) return
  const future = res.data.slots.filter(s => s.reminderEnabled !== false)
  const now = Date.now()
  for (const d of future) {
    const start = parseSlotStartDateTimeSafe(d)
    if (!start) continue
    const diffMin = (start.getTime() - now) / 60000
    if (diffMin > 0 && diffMin <= 60) {
      if (remindedSet.has(d.uid)) continue
      remindedSet.add(d.uid)
      const pc = await getPlatformConfig(d.platform)
      const sent = await bot.sendMessage(
        ADMIN_ID,
        `⏰ *即将开始（1小时内）*\n━━━━━━━━━━━━━━\n${formatSlotText(d, pc, { style: 'detail' })}`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{
              text: formatReminderButtonLabel(d, pc),
              callback_data: `del_booked_${d.ucode}`
            }]]
          }
        }
      )
      registerReminderMessage(d.ucode, sent.chat.id, sent.message_id)
    }
  }
}

async function pushBookedReminderBySchedule() {
  const now = Date.now()
  if (now - lastBookedReminderAt < getBookedReminderIntervalMs()) return
  await pushBookedReminder()
  lastBookedReminderAt = now
}

// ========================
// Commands
// ========================
bot.setMyCommands([
  { command: 'run', description: '🚀 立即扫描' },
  { command: 'listplace', description: '📍 场地开关' },
  { command: 'schedule', description: '📅 预约日程' },
  { command: 'panel', description: '🎛️ 控制面板' },
  { command: 'config', description: '⚙️ 查看配置' },
  { command: 'log', description: '📋 查看日志' },
  { command: 'update', description: '⬆️ 自动更新' },
  { command: 'help', description: '❓ 帮助' }
])

bot.onText(/\/panel/, async (msg) => {
  if (!isAdmin(msg)) return

  await bot.sendMessage(
    msg.chat.id,
    '🎛️ *控制面板*\n━━━━━━━━━━━━━━\n选择操作：',
    {
      parse_mode: 'Markdown',
      reply_markup: buildPanelKeyboard()
    }
  )
})

bot.onText(/\/run/, async (msg) => {
  if (!isAdmin(msg)) return
  await bot.sendMessage(msg.chat.id, `🚀 *手动执行监控*\n━━━━━━━━━━━━━━\n⏳ 正在抓取最新数据...`, { parse_mode: 'Markdown' })
  await monitorApi('POST', '/api/run')
})

bot.onText(/\/pause/, async (msg) => {
  if (!isAdmin(msg)) return
  await monitorApi('POST', '/api/pause')
  await bot.sendMessage(msg.chat.id, '⏸️ *监控已暂停*\n━━━━━━━━━━━━━━\n不会再自动刷新')
})

bot.onText(/\/resume/, async (msg) => {
  if (!isAdmin(msg)) return
  await monitorApi('POST', '/api/resume')
  await bot.sendMessage(msg.chat.id, `▶️ *监控已恢复*\n━━━━━━━━━━━━━━\n每 ${process.env.MONITOR_INTERVAL || 45}s 执行一次`, { parse_mode: 'Markdown' })
})

bot.onText(/\/status/, async (msg) => {
  if (!isAdmin(msg)) return
  try {
    const mRes = await monitorApi('GET', '/api/status')
    const pRes = await monitorApi('GET', '/api/places')
    const status = mRes.data
    const places = pRes.data?.places || []

    const placeLines = places.map(p =>
      `${p.enabled ? '🟢' : '⚪'} ${p.emoji} ${p.short}`
    )

    const statusText =
      `📊 *系统状态*\n━━━━━━━━━━━━━━\n` +
      `📡 监控：${status.running ? '运行中' : '已暂停'}\n` +
      `🤖 自动预约：${status.autoBooking ? '进行中' : '空闲'}\n` +
      `📋 当前列表：${status.slotCount} 条\n\n` +
      `🏟️ *场地*\n━━━━━━━━━━━━━━\n${placeLines.join('\n') || '（无）'}\n\n` +
      `⏱️ 间隔 ${status.interval || 45}s`
    await bot.sendMessage(msg.chat.id, statusText, {
      parse_mode: 'Markdown',
      reply_markup: buildPanelKeyboard()
    })
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ 获取状态失败: ${e.message}`)
  }
})

bot.onText(/\/booked(?: (\d+))?/, async (msg, match) => {
  if (!isAdmin(msg)) return
  const limit = Math.max(1, Math.min(100, Number(match?.[1] || 15)))
  try {
    const res = await bookingApi('GET', '/api/booked')
    const slots = res.data?.slots || []
    if (slots.length === 0) {
      await bot.sendMessage(msg.chat.id, '📚 暂无历史预约记录')
      return
    }
    const list = slots.slice()
      .sort((a, b) => (new Date(b.create || 0).getTime() || 0) - (new Date(a.create || 0).getTime() || 0))
      .slice(0, limit)
    const buttons = await Promise.all(list.map(async d => {
      const pc = await getPlatformConfig(d.platform)
      const meta = pc.PLACE_MAP?.[d.place] || {}
      const placeShort = (meta.short || d.place || '').trim()
      const court = String(formatCourt(d.court) || '').toUpperCase()
      const t = formatTimeDisplay(d.time || `${d.start}-${d.end}`)
      const date = d.dateDisplay || d.date
      const bell = d.reminderEnabled === false ? '🔕' : '🔔'
      const info = `${bell} ${meta.emoji || '🎾'} ${placeShort} ${court} · ${date} ${t}`
      return [{ text: info, callback_data: `try_del_${d.ucode}` }]
    }))
    await bot.sendMessage(msg.chat.id,
      `📚 预约记录（最近 ${list.length}/${slots.length} 条）\n━━━━━━━━━━━━━━`,
      { reply_markup: { inline_keyboard: buttons } }
    )
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ 获取预约记录失败: ${e.message}`)
  }
})

bot.onText(/\/schedule/, async (msg) => {
  if (!isAdmin(msg)) return
  try {
    const res = await bookingApi('GET', '/api/booked/schedule')
    const slots = res.data?.slots || []
    if (slots.length === 0) {
      await bot.sendMessage(msg.chat.id, '📅 暂无未开始的预约')
      return
    }
    const buttons = await Promise.all(slots.map(async d => {
      const pc = await getPlatformConfig(d.platform)
      return [{
        text: formatToggleButtonLabel(d, pc),
        callback_data: `toggle_remind_${d.ucode}`
      }]
    }))
    await bot.sendMessage(msg.chat.id,
      `📅 预约日程（共 ${slots.length} 条）\n━━━━━━━━━━━━━━\n点击切换提醒状态`,
      { reply_markup: { inline_keyboard: buttons } }
    )
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ 获取预约日程失败: ${e.message}`)
  }
})

bot.onText(/\/listplace/, async (msg) => {
  if (!isAdmin(msg)) return
  try {
    const res = await monitorApi('GET', '/api/places')
    const places = res.data?.places || []
    const rows = places.map(p => ([
      { text: `${p.enabled ? '🟢' : '⚪'} ${p.emoji} ${p.short}`, callback_data: 'noop' },
      { text: p.enabled ? '⏸️ 关闭' : '▶️ 开启',
        callback_data: `${p.enabled ? 'disable' : 'enable'}|${p.platform}|${p.name}` }
    ]))
    await bot.sendMessage(msg.chat.id,
      `📍 *场地开关*\n━━━━━━━━━━━━━━\n右侧按钮开关监控（不删场地，立即生效）`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows }
      })
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ 获取场地列表失败: ${e.message}`)
  }
})

bot.onText(/\/stats/, async (msg) => {
  if (!isAdmin(msg)) return
  try {
    const res = await monitorApi('GET', '/api/stats')
    const parts = res.data?.parts || ['📊 暂无统计数据']
    for (let i = 0; i < parts.length; i++) {
      const prefix = parts.length > 1 ? `(${i + 1}/${parts.length}) ` : ''
      await bot.sendMessage(msg.chat.id, prefix + parts[i])
    }
    await bot.sendMessage(msg.chat.id, '👇 快捷操作', { reply_markup: buildPanelKeyboard() })
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ 获取统计失败: ${e.message}`)
  }
})

bot.onText(/\/log(?: (\d+))?/, async (msg, match) => {
  if (!isAdmin(msg)) return
  const n = Number(match[1] || 50)
  try {
    const res = await monitorApi('GET', `/api/log?n=${n}`)
    const lines = res.data?.lines || []
    const text = lines.join('\n')
    if (!text || text.length === 0) {
      await bot.sendMessage(msg.chat.id, '📜 暂无日志')
      return
    }
    if (text.length > 3500) {
      // Send as file if too long
      await bot.sendMessage(msg.chat.id, '📜 日志过长，直接发送...')
      // Just send truncate
      await bot.sendMessage(msg.chat.id, text.slice(-3500))
    } else {
      await bot.sendMessage(msg.chat.id, text)
    }
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ 获取日志失败: ${e.message}`)
  }
})

bot.onText(/\/config$/, async (msg) => {
  if (!isAdmin(msg)) return
  try {
    const res = await monitorApi('GET', '/api/status')
    const { global, platforms } = res.data?.config || { global: {}, platforms: {} }
    await bot.sendMessage(msg.chat.id, '⚙️ 当前配置：\n\n' + JSON.stringify({ global, platforms }, null, 2))
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ 获取配置失败: ${e.message}`)
  }
})

bot.onText(/\/set (\w+) (.+)/, async (msg, match) => {
  if (!isAdmin(msg)) return
  const key = match[1]
  let value = match[2]
  try {
    if (value === 'true') value = true
    else if (value === 'false') value = false
    else if (!isNaN(value)) value = Number(value)
    else if (value.startsWith('[')) value = JSON.parse(value)

    await monitorApi('POST', '/api/config/set', { key, value, platform: 'ichikawa' })
    await bot.sendMessage(msg.chat.id, `✅ 配置已更新\n━━━━━━━━━━━━━━\n${key} = ${JSON.stringify(value)}`)
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ 修改失败：${e.message || e}`)
  }
})

bot.onText(/\/addplace (.+?) (.+?) (.+?) (.+)/, async (msg, match) => {
  if (!isAdmin(msg)) return
  const [, name, short, emoji, bike] = match
  try {
    // Default to ichikawa platform
    await monitorApi('POST', '/api/places/add', { platform: 'ichikawa', name, short, emoji, bike })
    await bot.sendMessage(msg.chat.id,
      `✅ *已添加场地* ━━━━━━━━━━━━━━ ${emoji} ${short} 📍 ${name} 🚴 ${bike}`,
      { parse_mode: 'Markdown' })
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ 添加失败：${e.message}`)
  }
})

bot.onText(/\/removeplace (.+)/, async (msg, match) => {
  if (!isAdmin(msg)) return
  const name = match[1].trim()
  try {
    await monitorApi('POST', '/api/places/remove', { platform: 'ichikawa', name })
    await bot.sendMessage(msg.chat.id,
      `🗑️ *已删除场地* ━━━━━━━━━━━━━━ 📍 ${name}`,
      { parse_mode: 'Markdown' })
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ 删除失败：${e.message}`)
  }
})

bot.onText(/\/enableplace (.+)/, async (msg, match) => {
  if (!isAdmin(msg)) return
  const name = match[1].trim()
  try {
    const res = await monitorApi('POST', '/api/places/toggle', { platform: 'ichikawa', place: name })
    const placesRes = await monitorApi('GET', '/api/places')
    const place = (placesRes.data?.places || []).find(p => p.name === name)
    const meta = place || {}
    if (res.data?.enabled) {
      await bot.sendMessage(msg.chat.id,
        `✅ *已开启监控*\n━━━━━━━━━━━━━━\n${meta.emoji || ''} ${meta.short || name}\n📍 ${name}`,
        { parse_mode: 'Markdown' })
    } else {
      await bot.sendMessage(msg.chat.id, `⚠️ 操作完成，当前状态：${res.data?.enabled ? '开启' : '关闭'}`)
    }
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ 操作失败：${e.message}`)
  }
})

bot.onText(/\/disableplace (.+)/, async (msg, match) => {
  if (!isAdmin(msg)) return
  const name = match[1].trim()
  try {
    const res = await monitorApi('POST', '/api/places/toggle', { platform: 'ichikawa', place: name })
    const placesRes = await monitorApi('GET', '/api/places')
    const place = (placesRes.data?.places || []).find(p => p.name === name)
    const meta = place || {}
    if (!res.data?.enabled) {
      await bot.sendMessage(msg.chat.id,
        `⏸️ *已关闭监控*\n━━━━━━━━━━━━━━\n${meta.emoji || ''} ${meta.short || name}\n📍 ${name}`,
        { parse_mode: 'Markdown' })
    } else {
      await bot.sendMessage(msg.chat.id, `⚠️ 操作完成，当前状态：${res.data?.enabled ? '开启' : '关闭'}`)
    }
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ 操作失败：${e.message}`)
  }
})

bot.onText(/\/update/, async (msg) => {
  if (!isAdmin(msg)) return
  const chatId = msg.chat.id
  const scriptPath = path.resolve(__dirname, '../../scripts/update.sh')

  const statusMsg = await bot.sendMessage(
    chatId,
    '⬆️ *开始更新...*\n━━━━━━━━━━━━━━\n⏳ 准备中...',
    { parse_mode: 'Markdown' }
  )

  const lines = ['⬆️ *开始更新...*', '━━━━━━━━━━━━━━']

  function updateDisplay() {
    const display = lines.slice(-15).join('\n')
    bot.editMessageText(display, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'Markdown'
    }).catch(() => {})
  }

  const proc = spawn('/bin/bash', [scriptPath], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  proc.stdout.on('data', (data) => {
    const text = data.toString().trim()
    if (!text) return
    lines.push(text)
    // 转义 Markdown 特殊字符，Telegram 的 Markdown 模式下 * _ ` [ ] 需要转义
    updateDisplay()
  })

  proc.stderr.on('data', (data) => {
    const text = data.toString().trim()
    if (!text) return
    lines.push('⚠️ `' + text.replace(/`/g, '') + '`')
    updateDisplay()
  })

  proc.on('close', (code) => {
    if (code === 0) {
      lines.push('', '🎉 *更新成功*')
    } else {
      lines.push('', '❌ *更新失败*（退出码: ' + code + '）')
    }
    updateDisplay()
  })

  proc.on('error', (err) => {
    lines.push('', '❌ *脚本执行失败*：`' + (err.message || '').replace(/`/g, '') + '`')
    updateDisplay()
  })
})

bot.onText(/\/help/, async (msg) => {
  if (!isAdmin(msg)) return
  const helpText =
    `🎾 网球场监控 · 帮助\n\n` +
    `【常用】\n` +
    `/panel  控制面板（下方按钮）\n` +
    `/run  立即扫描并推送\n` +
    `/update  自动更新（git pull + pnpm install + pm2 restart）\n` +
    `/status  状态（含面板）\n` +
    `/listplace  场地开关\n` +
    `/booked  预约记录（可加条数，如 /booked 20）\n` +
    `/schedule  预约日程\n` +
    `/stats  抢场统计\n` +
    `/pause · /resume  暂停/恢复定时扫描\n\n` +
    `【说明】\n` +
    `推送里点按钮预约；过期消息会提示刷新。\n` +
    `取消提醒只关提醒，不删预约记录。\n\n` +
    `【高级】\n` +
    `/config  查看配置\n` +
    `/set KEY 值  修改（例：/set INTERVAL 45）\n` +
    `/log  日志（/log 100）\n` +
    `/addplace · /removeplace  增删场地\n` +
    `/enableplace · /disableplace  启用/停用场地`

  await bot.sendMessage(msg.chat.id, helpText, { reply_markup: buildPanelKeyboard() })
})

// ========================
// Callback Query Handler
// ========================
bot.on('callback_query', async (query) => {
  const data = query.data
  const chatId = query.message?.chat?.id || ADMIN_ID

  // --- Quick action buttons ---
  if (data === 'quick_run') {
    await bot.answerCallbackQuery(query.id, { text: '🚀 执行中...' })
    await monitorApi('POST', '/api/run')
    return
  }

  if (data === 'quick_stats') {
    await bot.answerCallbackQuery(query.id, { text: '📈 获取统计' })

    const res = await monitorApi('GET', '/api/stats')
    const parts = res.data?.parts || ['📊 暂无统计']

    for (const part of parts) {
      await bot.sendMessage(chatId, part)
    }

    return
  }

  if (data === 'quick_resume') {
    await bot.answerCallbackQuery(query.id, { text: '▶️ 恢复中' })

    await monitorApi('POST', '/api/resume')

    await bot.sendMessage(
      chatId,
      '▶️ 监控已恢复'
    )

    return
  }

  if (data === 'quick_pause') {
    await bot.answerCallbackQuery(query.id, { text: '⏸️ 暂停中' })

    await monitorApi('POST', '/api/pause')

    await bot.sendMessage(
      chatId,
      '⏸️ 监控已暂停'
    )

    return
  }

  if (data === 'quick_status') {
    await bot.answerCallbackQuery(query.id, { text: '已生成' })
    try {
      const mRes = await monitorApi('GET', '/api/status')
      const pRes = await monitorApi('GET', '/api/places')
      const status = mRes.data
      const places = pRes.data?.places || []

      const placeLines = places.map(p =>
        `${p.enabled ? '🟢' : '⚪'} ${p.emoji} ${p.short}`
      )
      const text =
        `📊 *系统状态*\n━━━━━━━━━━━━━━\n` +
        `📡 监控：${status.running ? '运行中' : '已暂停'}\n` +
        `🤖 自动预约：${status.autoBooking ? '进行中' : '空闲'}\n` +
        `📋 当前列表：${status.slotCount} 条\n\n` +
        `🏟️ *场地*\n━━━━━━━━━━━━━━\n${placeLines.join('\n') || '（无）'}\n\n` +
        `⏱️ 间隔 ${status.interval || 45}s`
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' })
    } catch (e) {
      await bot.sendMessage(chatId, `❌ 获取状态失败: ${e.message}`)
    }
    return
  }

  if (data === 'quick_update') {
    await bot.answerCallbackQuery(query.id, { text: '⬆️ 开始更新...' })
    // Reuse the /update command logic
    const scriptPath = path.resolve(__dirname, '../../scripts/update.sh')
    const statusMsg = await bot.sendMessage(
      chatId,
      '⬆️ *开始更新...*\n━━━━━━━━━━━━━━\n⏳ 准备中...',
      { parse_mode: 'Markdown' }
    )
    const lines = ['⬆️ *开始更新...*', '━━━━━━━━━━━━━━']
    const updateDisplay = () => {
      bot.editMessageText(lines.slice(-15).join('\n'), {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        parse_mode: 'Markdown'
      }).catch(() => {})
    }
    const proc = spawn('/bin/bash', [scriptPath], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    proc.stdout.on('data', d => { const t = d.toString().trim(); if (t) { lines.push(t); updateDisplay() } })
    proc.stderr.on('data', d => { const t = d.toString().trim(); if (t) { lines.push('⚠️ `' + t.replace(/`/g, '') + '`'); updateDisplay() } })
    proc.on('close', code => { lines.push('', code === 0 ? '🎉 *更新成功*' : '❌ *更新失败*（退出码: ' + code + '）'); updateDisplay() })
    proc.on('error', err => { lines.push('', '❌ *脚本执行失败*：`' + (err.message || '').replace(/`/g, '') + '`'); updateDisplay() })
    return
  }

  if (data === 'quick_booked') {
    await bot.answerCallbackQuery(query.id, { text: '📚 …' })
    try {
      const res = await bookingApi('GET', '/api/booked')
      const slots = res.data?.slots || []
      if (slots.length === 0) {
        await bot.sendMessage(chatId, '📚 暂无预约记录')
        return
      }
      const list = slots.slice()
        .sort((a, b) => (new Date(b.create || 0).getTime() || 0) - (new Date(a.create || 0).getTime() || 0))
        .slice(0, 12)
      const buttons = await Promise.all(list.map(async d => {
        const pc = await getPlatformConfig(d.platform)
        const meta = pc.PLACE_MAP?.[d.place] || {}
        const placeShort = (meta.short || d.place || '').trim()
        const court = String(formatCourt(d.court) || '').toUpperCase()
        const t = formatTimeDisplay(d.time || `${d.start}-${d.end}`)
        const date = d.dateDisplay || d.date
        const bell = d.reminderEnabled === false ? '🔕' : '🔔'
        const info = `${bell} ${meta.emoji || '🎾'} ${placeShort} ${court} · ${date} ${t}`
        return [{ text: info, callback_data: `try_del_${d.ucode}` }]
      }))
      await bot.sendMessage(chatId,
        `📚 预约记录（最近 ${list.length}/${slots.length} 条）\n━━━━━━━━━━━━━━`,
        { reply_markup: { inline_keyboard: buttons } }
      )
    } catch (e) {
      await bot.sendMessage(chatId, `❌ 获取预约记录失败: ${e.message}`)
    }
    return
  }

  if (data === 'quick_schedule') {
    await bot.answerCallbackQuery(query.id, { text: '📅 …' })
    try {
      const res = await bookingApi('GET', '/api/booked/schedule')
      const slots = res.data?.slots || []
      if (slots.length === 0) {
        await bot.sendMessage(chatId, '📅 暂无未开始的预约')
        return
      }
      const buttons = await Promise.all(slots.map(async d => {
        const pc = await getPlatformConfig(d.platform)
        return [{
          text: formatToggleButtonLabel(d, pc),
          callback_data: `toggle_remind_${d.ucode}`
        }]
      }))
      await bot.sendMessage(chatId,
        `📅 预约日程（共 ${slots.length} 条）\n━━━━━━━━━━━━━━\n点击切换提醒状态`,
        { reply_markup: { inline_keyboard: buttons } }
      )
    } catch (e) {
      await bot.sendMessage(chatId, `❌ 获取日程失败: ${e.message}`)
    }
    return
  }

  if (data === 'quick_place') {
    await bot.answerCallbackQuery(query.id, { text: '📍 打开面板' })
    try {
      const res = await monitorApi('GET', '/api/places')
      const places = res.data?.places || []
      const rows = places.map(p => ([
        { text: `${p.enabled ? '🟢' : '⚪'} ${p.emoji} ${p.short}`, callback_data: 'noop' },
        { text: p.enabled ? '⏸️ 关闭' : '▶️ 开启',
          callback_data: `${p.enabled ? 'disable' : 'enable'}|${p.platform}|${p.name}` }
      ]))
      await bot.sendMessage(chatId, '📍 场地开关\n点右侧开启/关闭监控（立即生效）', {
        reply_markup: { inline_keyboard: rows }
      })
    } catch (e) {
      await bot.sendMessage(chatId, `❌ 获取场地列表失败: ${e.message}`)
    }
    return
  }

  // --- Noop ---
  if (data === 'noop') {
    await bot.answerCallbackQuery(query.id, { text: 'ℹ️ 仅展示信息' })
    return
  }

  // --- Enable/Disable place toggle ---
  if (data.includes('|')) {
    const parts = data.split('|')
    const action = parts[0]
    const pname = parts[1]
    const name = parts[2]

    try {
      const res = await monitorApi('POST', '/api/places/toggle', { platform: pname, place: name })
      const enabled = res.data?.enabled

      // Refresh inline keyboard
      const placesRes = await monitorApi('GET', '/api/places')
      const places = placesRes.data?.places || []
      const newRows = places.map(p => ([
        { text: `${p.enabled ? '🟢' : '⚪'} ${p.emoji} ${p.short}`, callback_data: 'noop' },
        { text: p.enabled ? '⏸️ 关闭' : '▶️ 开启',
          callback_data: `${p.enabled ? 'disable' : 'enable'}|${p.platform}|${p.name}` }
      ]))

      await bot.editMessageReplyMarkup(
        { inline_keyboard: newRows },
        { chat_id: query.message.chat.id, message_id: query.message.message_id }
      )

      await bot.answerCallbackQuery(query.id, { text: enabled ? '✅ 已开启' : '⏸️ 已关闭' })
    } catch (e) {
      await bot.answerCallbackQuery(query.id, { text: `❌ 操作失败` })
    }
    return
  }

  // --- Toggle reminder (schedule) ---
  if (data.startsWith('toggle_remind_')) {
    const ucode = data.replace('toggle_remind_', '')
    try {
      const res = await bookingApi('POST', '/api/booked/toggle-reminder', { uid: ucode })
      if (!res.data?.success) {
        await bot.answerCallbackQuery(query.id, { text: '⚠️ 未找到对应预约' })
        return
      }
      const newBell = res.data.reminderEnabled ? '🔔' : '🔕'
      const rows = query.message.reply_markup?.inline_keyboard || []
      const newRows = rows.map(row => row.map(btn =>
        btn.callback_data === data
          ? { ...btn, text: btn.text.replace('🔔', newBell).replace('🔕', newBell) }
          : btn
      ))
      try {
        await bot.editMessageReplyMarkup({ inline_keyboard: newRows }, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id
        })
      } catch (e) {
        console.warn('[toggle_remind] 更新消息失败:', e.message)
      }
      await bot.answerCallbackQuery(query.id, { text: newBell === '🔔' ? '🔔 已开启提醒' : '🔕 已关闭提醒' })
    } catch (e) {
      await bot.answerCallbackQuery(query.id, { text: '❌ 操作失败' })
    }
    return
  }

  // --- Try delete record (first click) ---
  if (data.startsWith('try_del_')) {
    const ucode = data.replace('try_del_', '')
    const rows = query.message.reply_markup?.inline_keyboard || []
    const newRows = rows.map(row => row.map(btn =>
      btn.callback_data === data
        ? { text: '🗑️ 确认删除?', callback_data: `confirm_del_${ucode}` }
        : btn
    ))
    try {
      await bot.editMessageReplyMarkup({ inline_keyboard: newRows }, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id
      })
    } catch (e) {
      console.warn('[try_del] 更新消息失败:', e.message)
    }
    await bot.answerCallbackQuery(query.id, { text: '再点一次确认删除' })
    return
  }

  // --- Confirm delete record ---
  if (data.startsWith('confirm_del_')) {
    const ucode = data.replace('confirm_del_', '')
    try {
      const res = await bookingApi('DELETE', `/api/booked/${encodeURIComponent(ucode)}`)
      if (!res.data?.success) {
        await bot.answerCallbackQuery(query.id, { text: '⚠️ 未找到对应预约记录' })
        return
      }
      const rows = query.message.reply_markup?.inline_keyboard || []
      const idx = rows.findIndex(row => row.some(btn => btn.callback_data === data))
      const newRows = rows.filter((_, i) => i !== idx)
      try {
        if (newRows.length === 0) {
          await bot.editMessageText('🗑️ 预约记录已全部删除', {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
          })
        } else {
          await bot.editMessageReplyMarkup({ inline_keyboard: newRows }, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
          })
        }
      } catch (e) {
        console.warn('[confirm_del] 更新消息失败:', e.message)
      }
      await bot.answerCallbackQuery(query.id, { text: '🗑️ 已删除' })
    } catch (e) {
      await bot.answerCallbackQuery(query.id, { text: '❌ 删除失败' })
    }
    return
  }

  // --- Disable reminder ---
  if (data.startsWith('del_booked_')) {
    const key = data.replace('del_booked_', '')
    try {
      const res = await bookingApi('POST', '/api/booked/disable-reminder', { uid: key })
      if (!res.data?.success) {
        await bot.answerCallbackQuery(query.id, { text: '⚠️ 未找到对应预约记录' })
        return
      }
      const targetCb = `del_booked_${key}`
      const rows = query.message.reply_markup?.inline_keyboard || []
      const newRows = rows.filter(row => !row.some(btn => btn.callback_data === targetCb))
      try {
        if (newRows.length === 0) {
          await bot.editMessageText('🔕 本组预约提醒已全部关闭', {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
          })
        } else {
          await bot.editMessageReplyMarkup({ inline_keyboard: newRows }, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
          })
        }
      } catch (e) {
        console.warn('[del_booked] 更新消息失败:', e.message)
      }
      pruneReminderIndexForUcode(key)
      await bot.answerCallbackQuery(query.id, { text: '🔕 已关闭该条提醒' })
    } catch (e) {
      await bot.answerCallbackQuery(query.id, { text: '❌ 操作失败' })
    }
    return
  }

  // --- Book slot ---
  if (data.startsWith('book_')) {
    const ucode = data.replace('book_', '')

    // Check if already processing a booking
    // Look up slot from Monitor Service
    try {
      const slotRes = await monitorApi('GET', `/api/slot/${encodeURIComponent(ucode)}`)
      if (!slotRes.data?.success || !slotRes.data?.slot) {
        await bot.answerCallbackQuery(query.id, { text: '⚠️ 数据已过期，请重新获取' })
        return
      }

      const raw = slotRes.data.slot
      await bot.answerCallbackQuery(query.id, { text: '🚀 开始预约...' })

      const pc = await getPlatformConfig(raw.platform)
      const bookRes = await bookingApi('POST', '/api/book', { platform: raw.platform, slot: raw })
      if (bookRes.data?.success) {
        await bot.sendMessage(
          chatId,
          `🎉 *预约成功！*\n━━━━━━━━━━━━━━\n${formatSlotText(raw, pc, { showBike: true, style: 'detail' })}`,
          { parse_mode: 'Markdown' }
        )
        // Trigger re-scan
        await monitorApi('POST', '/api/run')
      } else {
        await bot.sendMessage(
          chatId,
          `❌ *预约失败*\n━━━━━━━━━━━━━━\n${formatSlotText(raw, pc, { style: 'detail' })}\n\n🧨 ${escapeMarkdown(bookRes.data?.message || '未知错误')}`,
          { parse_mode: 'Markdown' }
        )
      }
    } catch (e) {
      await bot.sendMessage(
        chatId,
        `❌ *预约失败*\n━━━━━━━━━━━━━━\n${escapeMarkdown(e.message)}`,
        { parse_mode: 'Markdown' }
      )
    }
    return
  }

  await bot.answerCallbackQuery(query.id, { text: '⚠️ 无效操作' })
})

// ========================
// 启动
// ========================
async function start() {
  console.log('[telegram-bot] 启动成功，开始 polling')

  // 定时提醒
  setInterval(pushBookedReminderBySchedule, 60 * 1000)
  setInterval(pushUpcomingReminder, 60 * 1000)
}

start().catch(e => console.error('启动失败:', e))
