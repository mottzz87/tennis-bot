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
require('@tennis-bot/config/loadEnv')()
const http = require('http')
const { spawn } = require('child_process')
const path = require('path')
const TelegramBot = require('node-telegram-bot-api')
const { formatSlotText, formatReminderButtonLabel, displayCourt, escapeMarkdown } = require('@tennis-bot/notifier')
const { parseSlotStartDateTimeSafe, parseSlotDayKey, formatTimeDisplay, toMinutes } = require('@tennis-bot/utils')
const readline = require('readline')

// 时段总小时数：优先 duration（分钟），缺省时按起止时间推算
function slotHours(d) {
  let minutes = Number(d.duration)
  if (!minutes || minutes <= 0) {
    const s = toMinutes(d.start)
    const e = toMinutes(d.end)
    if (e > s) minutes = e - s
  }
  return minutes > 0 ? minutes / 60 : 0
}

function hoursLabel(hours) {
  const h = Number(hours)
  if (!h || h <= 0) return ''
  return `${Number.isInteger(h) ? h : +h.toFixed(1)}h`
}

// 执行预约（book_ 与 confirm_book_ 共用）：取最新 slot → POST /api/book → 结果通知 → 触发重扫
async function doBook(bot, chatId, ucode) {
  try {
    const slotRes = await monitorApi('GET', `/api/slot/${encodeURIComponent(ucode)}`)
    if (!slotRes.data?.success || !slotRes.data?.slot) {
      await bot.sendMessage(chatId, '⚠️ 数据已过期，请重新获取')
      return
    }
    const raw = slotRes.data.slot
    const pc = await getPlatformConfig(raw.platform)
    const bookRes = await bookingApi('POST', '/api/book', { platform: raw.platform, slot: raw })
    if (bookRes.data?.success) {
      const shown = bookRes.data?.fee?.total != null ? { ...raw, totalFee: bookRes.data.fee.total } : raw
      await bot.sendMessage(
        chatId,
        `🎉 *预约成功！*\n━━━━━━━━━━━━━━\n${formatSlotText(shown, pc, { showBike: true, showFee: true, style: 'detail' })}`,
        { parse_mode: 'Markdown' }
      )
      // Trigger re-scan（只刷预约所在平台）
      await monitorApi('POST', '/api/run', { platforms: [raw.platform] })
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
}

const MONITOR_HOST = process.env.MONITOR_HOST || 'http://localhost:3000'
const BOOKING_HOST = process.env.BOOKING_HOST || 'http://localhost:4000'

// 收集所有 Bot Token：BOT_TOKEN + 所有 <PLATFORM>_BOT_TOKEN，去重
function collectBotTokens() {
  const tokens = []
  const add = t => { if (t && !tokens.includes(t)) tokens.push(t) }
  add(process.env.BOT_TOKEN)
  for (const key of Object.keys(process.env)) {
    if (key.endsWith('_BOT_TOKEN') && process.env[key]) add(process.env[key])
  }
  return tokens
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

const ADMIN_ID = Number(resolveChatId())
if (!ADMIN_ID) {
  console.error('[telegram-bot] 未找到 CHAT_ID，请在 .env 中配置 CHAT_ID 或 <PLATFORM>_CHAT_ID')
  process.exit(1)
}

// 每个 token 一个 TelegramBot 实例，全部 polling（这样每个 bot 里的命令都能用）
const botTokens = collectBotTokens()
if (botTokens.length === 0) {
  console.error('[telegram-bot] 未找到任何 Bot Token，请在 .env 中配置 BOT_TOKEN 或 <PLATFORM>_BOT_TOKEN')
  process.exit(1)
}

const botByToken = new Map()
for (const token of botTokens) {
  const b = new TelegramBot(token, { polling: true })
  b._token = token
  botByToken.set(token, b)
}
const bots = [...botByToken.values()]

// 平台推送/提醒用哪个 bot：优先 <PLATFORM>_BOT_TOKEN，否则回退到第一个 bot
function getBotForPlatform(platformName) {
  const key = `${String(platformName || '').toUpperCase()}_BOT_TOKEN`
  const token = process.env[key]
  if (token && botByToken.has(token)) return botByToken.get(token)
  return bots[0]
}

// 当前 bot 负责哪些平台：手动 /run 时只扫这些平台，各平台通知仍推送到各自 bot
async function getPlatformsForBot(bot) {
  try {
    const res = await monitorApi('GET', '/api/status')
    const names = Object.keys(res.data?.config?.platforms || {})
    return names.filter(p => getBotForPlatform(p) === bot)
  } catch {
    return []
  }
}

// 场地开关等列表按 bot 归属过滤：每个 bot 只显示自己绑定的平台场地。
// 通过 <PLATFORM>_BOT_TOKEN（或 BOT_TOKEN 兜底）判断场地归属哪个 bot；
// 一个 bot 绑定到唯一平台时过滤，绑定多个/无归属时显示全部（保持原行为）。
function filterPlacesByBot(places, bot) {
  const token = bot._token
  const own = (places || []).filter(p =>
    (process.env[`${String(p.platform || '').toUpperCase()}_BOT_TOKEN`] || process.env.BOT_TOKEN) === token
  )
  const platforms = [...new Set(own.map(p => p.platform))]
  if (platforms.length !== 1) return places || []
  return (places || []).filter(p => p.platform === platforms[0])
}

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

// 从 /api/status 获取全局配置
async function getGlobalConfig() {
  try {
    const res = await monitorApi('GET', '/api/status')
    return res.data?.config?.global || {}
  } catch {
    return {}
  }
}

// 第一个启用的平台（默认活动平台）
async function getActivePlatform() {
  const res = await monitorApi('GET', '/api/status')
  const platforms = res.data?.config?.platforms || {}
  const enabled = Object.entries(platforms).filter(([, pc]) => pc.enabled !== false)
  return enabled[0]?.[0] || null
}

// 解析可选的 "平台:" 前缀，返回 { platform, rest }
function splitPlatformArg(text) {
  const m = String(text || '').match(/^(\w+):(.*)$/s)
  if (m) return { platform: m[1], rest: m[2] }
  return { platform: null, rest: String(text || '') }
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
const TG_BTN_MAX = 64

function formatToggleButtonLabel(d, platformConfig) {
  const meta = platformConfig.PLACE_MAP?.[d.place] || {}
  const placeShort = (meta.short || d.place || '').trim()
  const court = displayCourt(d)
  const t = formatTimeDisplay(d.time || `${d.start}-${d.end}`)
  const date = d.dateDisplay || d.date
  const bell = d.reminderEnabled === false ? '🔕' : '🔔'
  const fee = d.totalFee ? ` 💰${d.totalFee}` : ''
  const s = `${bell} ${meta.emoji || '🎾'} ${placeShort} ${court} · ${date} ${t}${fee}`
  return Array.from(s).length > TG_BTN_MAX ? Array.from(s).slice(0, TG_BTN_MAX - 1).join('') + '…' : s
}

// ========================
// Reminder helpers
// ========================
async function getBookedReminderIntervalMs(platformName) {
  // 默认 2 小时，从配置读取（global + 平台配置合并，平台优先），不再从 env 取
  const globalCfg = await getGlobalConfig()
  const pc = platformName ? await getPlatformConfig(platformName) : {}
  const hours = Number({ ...globalCfg, ...pc }.BOOKED_REMINDER_INTERVAL_HOURS)
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

function registerReminderMessage(ucode, chatId, messageId, bot) {
  if (!ucode || !chatId || !messageId) return
  if (!reminderIndex[ucode]) reminderIndex[ucode] = []
  reminderIndex[ucode].push({ chatId, messageId, bot })
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
      chunk.map(item => (item.bot || bots[0]).deleteMessage(item.chatId, String(item.messageId)))
    )
    deleted += results.filter(r => r.status === 'fulfilled').length
  }
  delete reminderIndex[ucode]
  return deleted
}

async function pushBookedReminder() {
  const res = await bookingApi('GET', '/api/booked/schedule')
  if (!res.data?.slots) return
  // 每个平台独立读取提醒间隔（global + 平台配置合并），同一平台只请求一次
  const intervals = new Map()
  for (const p of [...new Set(res.data.slots.map(s => s.platform))]) {
    intervals.set(p, await getBookedReminderIntervalMs(p))
  }
  const future = res.data.slots.filter(s => eligibleForBookedSummary(s, intervals.get(s.platform)))
  if (future.length === 0) return

  // 全部平台合并为一条消息推送，不再按平台分开
  future.sort((a, b) => {
    const ta = parseSlotStartDateTimeSafe(a)?.getTime() ?? 0
    const tb = parseSlotStartDateTimeSafe(b)?.getTime() ?? 0
    return ta - tb
  })

  const CHUNK = 10
  const reminderBot = bots[0] // 跨平台合并后统一走默认 bot
  for (let i = 0; i < future.length; i += CHUNK) {
    const pageSlots = future.slice(i, i + CHUNK)
    const buttons = await Promise.all(pageSlots.map(async d => {
      const pc = await getPlatformConfig(d.platform)
      return [{ text: formatReminderButtonLabel(d, pc), callback_data: `del_booked_${d.ucode}` }]
    }))
    const h = `📅 已预约提醒（${future.length} 条）${i === 0 ? '' : `\n（第 ${i / CHUNK + 1} 页）`}`
    const sent = await reminderBot.sendMessage(ADMIN_ID, h, { reply_markup: { inline_keyboard: buttons } })
    for (const d of pageSlots) {
      registerReminderMessage(d.ucode, sent.chat.id, sent.message_id, reminderBot)
    }
  }
}

async function pushUpcomingReminder() {
  const res = await bookingApi('GET', '/api/booked/schedule')
  if (!res.data?.slots) return
  const future = res.data.slots.filter(s => s.reminderEnabled !== false)
  const now = Date.now()
  const imminent = future.filter(d => {
    const start = parseSlotStartDateTimeSafe(d)
    if (!start) return false
    const diffMin = (start.getTime() - now) / 60000
    return diffMin > 0 && diffMin <= 60 && !remindedSet.has(d.uid)
  })
  if (imminent.length === 0) return
  for (const d of imminent) remindedSet.add(d.uid)

  // 全部平台合并为一条消息推送，不再按平台分开
  imminent.sort((a, b) => {
    const ta = parseSlotStartDateTimeSafe(a)?.getTime() ?? 0
    const tb = parseSlotStartDateTimeSafe(b)?.getTime() ?? 0
    return ta - tb
  })

  const CHUNK = 10
  const reminderBot = bots[0] // 跨平台合并后统一走默认 bot
  for (let i = 0; i < imminent.length; i += CHUNK) {
    const pageSlots = imminent.slice(i, i + CHUNK)
    const lines = await Promise.all(pageSlots.map(async d => {
      const pc = await getPlatformConfig(d.platform)
      return formatSlotText(d, pc, { style: 'detail' })
    }))
    const buttons = await Promise.all(pageSlots.map(async d => {
      const pc = await getPlatformConfig(d.platform)
      return [{ text: formatReminderButtonLabel(d, pc), callback_data: `del_booked_${d.ucode}` }]
    }))
    const h = `⏰ *即将开始（1小时内）*\n━━━━━━━━━━━━━━\n${lines.join('\n\n')}${i === 0 ? '' : `\n（第 ${i / CHUNK + 1} 页）`}`
    const sent = await reminderBot.sendMessage(ADMIN_ID, h, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    })
    for (const d of pageSlots) {
      registerReminderMessage(d.ucode, sent.chat.id, sent.message_id, reminderBot)
    }
  }
}

async function pushBookedReminderBySchedule() {
  const now = Date.now()
  // 调度是全局定时器，无平台上下文：取默认活动平台的合并配置
  const intervalMs = await getBookedReminderIntervalMs(await getActivePlatform())
  if (now - lastBookedReminderAt < intervalMs) return
  await pushBookedReminder()
  lastBookedReminderAt = now
}

// ========================
// Quick actions（面板内联键盘 & 回复键盘托盘共用）
// ========================
async function quickRun(bot) {
  const platforms = await getPlatformsForBot(bot)
  await monitorApi('POST', '/api/run', { platforms })
}

async function quickStats(bot, chatId) {
  const res = await monitorApi('GET', '/api/stats')
  const parts = res.data?.parts || ['📊 暂无统计']
  for (const part of parts) await bot.sendMessage(chatId, part)
}

async function quickResume(bot, chatId) {
  await monitorApi('POST', '/api/resume')
  await bot.sendMessage(chatId, '▶️ 监控已恢复')
}

async function quickPause(bot, chatId) {
  await monitorApi('POST', '/api/pause')
  await bot.sendMessage(chatId, '⏸️ 监控已暂停')
}

async function quickStatus(bot, chatId) {
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
}

async function quickBooked(bot, chatId) {
  try {
    const res = await bookingApi('GET', '/api/booked')
    const slots = res.data?.slots || []
    if (slots.length === 0) {
      await bot.sendMessage(chatId, '📚 暂无预约记录')
      return
    }
    const list = slots.slice()
      .sort((a, b) => (parseSlotStartDateTimeSafe(b)?.getTime() || 0) - (parseSlotStartDateTimeSafe(a)?.getTime() || 0))
      .slice(0, 12)
    const buttons = await Promise.all(list.map(async d => {
      const pc = await getPlatformConfig(d.platform)
      const meta = pc.PLACE_MAP?.[d.place] || {}
      const placeShort = (meta.short || d.place || '').trim()
      const court = displayCourt(d)
      const t = formatTimeDisplay(d.time || `${d.start}-${d.end}`)
      const date = d.dateDisplay || d.date
      const bell = d.reminderEnabled === false ? '🔕' : '🔔'
      const fee = d.totalFee ? ` 💰${d.totalFee}` : ''
      const info = `${bell} ${meta.emoji || '🎾'} ${placeShort} ${court} · ${date} ${t}${fee}`
      return [{ text: info, callback_data: `try_del_${d.ucode}` }]
    }))
    await bot.sendMessage(chatId,
      `📚 预约记录（最近 ${list.length}/${slots.length} 条）\n━━━━━━━━━━━━━━`,
      { reply_markup: { inline_keyboard: buttons } }
    )
  } catch (e) {
    await bot.sendMessage(chatId, `❌ 获取预约记录失败: ${e.message}`)
  }
}

async function quickSchedule(bot, chatId) {
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
}

// ========================
// Commands
// ========================
function registerHandlers(bot) {
  bot.setMyCommands([
    { command: 'run', description: '🚀 立即扫描' },
    { command: 'listplace', description: '📍 场地开关' },
    { command: 'schedule', description: '📅 预约日程' },
    { command: 'panel', description: '🎛️ 控制面板' },
    { command: 'config', description: '⚙️ 查看配置' },
    { command: 'log', description: '📋 查看日志' },
    { command: 'help', description: '❓ 帮助' }
  ])

  // 每个 bot 各自的控制面板键盘实例（闭包），当前内容相同，后续可按平台各自定制
  const buildPanelKeyboard = () => ({
    inline_keyboard: [
      [
        { text: '📊 系统状态', callback_data: 'quick_status' },
        { text: '📈 抢场统计', callback_data: 'quick_stats' }
      ],
      [
        { text: '📅 预约日程', callback_data: 'quick_schedule' },
        { text: '📚 预约记录', callback_data: 'quick_booked' }
      ],
      [
        { text: '⏸️ 暂停监控', callback_data: 'quick_pause' },
        { text: '▶️ 恢复监控', callback_data: 'quick_resume' }
      ]
    ]
  })

  // 回复键盘托盘：输入区上方常驻按钮，点击直接把面板动作当文本发出
  const buildPanelTray = () => ({
    keyboard: [
      [{ text: '📊 系统状态' }, { text: '📈 抢场统计' }],
      [{ text: '📅 预约日程' }, { text: '📚 预约记录' }],
      [{ text: '⏸️ 暂停监控' }, { text: '▶️ 恢复监控' }]
    ],
    resize_keyboard: true
  })

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
    // 弹出输入区上方的常驻按钮托盘
    await bot.sendMessage(msg.chat.id, '👇 也可点击下方按钮直接操作', {
      reply_markup: buildPanelTray()
    })
  })

  // 托盘按钮点击 → 直接执行对应动作（无需走面板内联键盘）
  const trayActions = {
    '📊 系统状态': quickStatus,
    '📈 抢场统计': quickStats,
    '📅 预约日程': quickSchedule,
    '📚 预约记录': quickBooked,
    '⏸️ 暂停监控': quickPause,
    '▶️ 恢复监控': quickResume
  }
  bot.onText(/^(📊 系统状态|📈 抢场统计|📅 预约日程|📚 预约记录|⏸️ 暂停监控|▶️ 恢复监控)$/, async (msg) => {
    if (!isAdmin(msg)) return
    await trayActions[msg.text]?.(bot, msg.chat.id)
  })

  bot.onText(/\/run/, async (msg) => {
    if (!isAdmin(msg)) return
    await bot.sendMessage(msg.chat.id, `🚀 *手动执行监控*\n━━━━━━━━━━━━━━\n⏳ 正在抓取最新数据...`, { parse_mode: 'Markdown' })
    const platforms = await getPlatformsForBot(bot)
    await monitorApi('POST', '/api/run', { platforms })
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
        .sort((a, b) => (parseSlotStartDateTimeSafe(b)?.getTime() || 0) - (parseSlotStartDateTimeSafe(a)?.getTime() || 0))
        .slice(0, limit)
      const buttons = await Promise.all(list.map(async d => {
        const pc = await getPlatformConfig(d.platform)
        const meta = pc.PLACE_MAP?.[d.place] || {}
        const placeShort = (meta.short || d.place || '').trim()
        const court = displayCourt(d)
        const t = formatTimeDisplay(d.time || `${d.start}-${d.end}`)
        const date = d.dateDisplay || d.date
        const bell = d.reminderEnabled === false ? '🔕' : '🔔'
        const fee = d.totalFee ? ` 💰${d.totalFee}` : ''
        const info = `${bell} ${meta.emoji || '🎾'} ${placeShort} ${court} · ${date} ${t}${fee}`
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
      const places = filterPlacesByBot(res.data?.places || [], bot)
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
  
  bot.onText(/\/set (\S+) (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) return
    const { platform: argPlatform, rest: key } = splitPlatformArg(match[1])
    let value = match[2]
    try {
      if (value === 'true') value = true
      else if (value === 'false') value = false
      else if (!isNaN(value)) value = Number(value)
      else if (value.startsWith('[')) value = JSON.parse(value)
  
      // 未指定平台时：全局配置项写 global，其余写到默认活动平台
      let platform = argPlatform === 'global' ? undefined : argPlatform
      if (!platform) {
        const globalKeys = Object.keys(await getGlobalConfig())
        platform = globalKeys.includes(key) ? undefined : (await getActivePlatform())
      }
  
      const body = { key, value }
      if (platform) body.platform = platform
      await monitorApi('POST', '/api/config/set', body)
      const where = platform ? `（${platform}）` : '（全局）'
      await bot.sendMessage(msg.chat.id, `✅ 配置已更新 ${where}\n━━━━━━━━━━━━━━\n${key} = ${JSON.stringify(value)}`)
    } catch (e) {
      await bot.sendMessage(msg.chat.id, `❌ 修改失败：${e.message || e}`)
    }
  })
  
  bot.onText(/\/addplace (.+?) (.+?) (.+?) (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) return
    const { platform: argPlatform, rest: name } = splitPlatformArg(match[1])
    const [, , short, emoji, bike] = match
    try {
      const platform = argPlatform || (await getActivePlatform())
      if (!platform) throw new Error('未找到启用的平台，请先启用或加 平台: 前缀')
      await monitorApi('POST', '/api/places/add', { platform, name, short, emoji, bike })
      await bot.sendMessage(msg.chat.id,
        `✅ *已添加场地*（${platform}） ━━━━━━━━━━━━━━ ${emoji} ${short} 📍 ${name} 🚴 ${bike}`,
        { parse_mode: 'Markdown' })
    } catch (e) {
      await bot.sendMessage(msg.chat.id, `❌ 添加失败：${e.message}`)
    }
  })
  
  bot.onText(/\/removeplace (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) return
    const { platform: argPlatform, rest: name } = splitPlatformArg(match[1].trim())
    try {
      const platform = argPlatform || (await getActivePlatform())
      if (!platform) throw new Error('未找到启用的平台，请先启用或加 平台: 前缀')
      await monitorApi('POST', '/api/places/remove', { platform, name })
      await bot.sendMessage(msg.chat.id,
        `🗑️ *已删除场地*（${platform}） ━━━━━━━━━━━━━━ 📍 ${name}`,
        { parse_mode: 'Markdown' })
    } catch (e) {
      await bot.sendMessage(msg.chat.id, `❌ 删除失败：${e.message}`)
    }
  })
  
  bot.onText(/\/enableplace (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) return
    const { platform: argPlatform, rest: name } = splitPlatformArg(match[1].trim())
    try {
      const platform = argPlatform || (await getActivePlatform())
      if (!platform) throw new Error('未找到启用的平台，请先启用或加 平台: 前缀')
      const res = await monitorApi('POST', '/api/places/toggle', { platform, place: name })
      const placesRes = await monitorApi('GET', '/api/places')
      const place = (placesRes.data?.places || []).find(p => p.name === name)
      const meta = place || {}
      if (res.data?.enabled) {
        await bot.sendMessage(msg.chat.id,
          `✅ *已开启监控*（${platform}）\n━━━━━━━━━━━━━━\n${meta.emoji || ''} ${meta.short || name}\n📍 ${name}`,
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
    const { platform: argPlatform, rest: name } = splitPlatformArg(match[1].trim())
    try {
      const platform = argPlatform || (await getActivePlatform())
      if (!platform) throw new Error('未找到启用的平台，请先启用或加 平台: 前缀')
      const res = await monitorApi('POST', '/api/places/toggle', { platform, place: name })
      const placesRes = await monitorApi('GET', '/api/places')
      const place = (placesRes.data?.places || []).find(p => p.name === name)
      const meta = place || {}
      if (!res.data?.enabled) {
        await bot.sendMessage(msg.chat.id,
          `⏸️ *已关闭监控*（${platform}）\n━━━━━━━━━━━━━━\n${meta.emoji || ''} ${meta.short || name}\n📍 ${name}`,
          { parse_mode: 'Markdown' })
      } else {
        await bot.sendMessage(msg.chat.id, `⚠️ 操作完成，当前状态：${res.data?.enabled ? '开启' : '关闭'}`)
      }
    } catch (e) {
      await bot.sendMessage(msg.chat.id, `❌ 操作失败：${e.message}`)
    }
  })
  
  
  bot.onText(/\/help/, async (msg) => {
    if (!isAdmin(msg)) return
    const helpText =
      `🎾 网球场监控 · 帮助\n\n` +
      `【常用】\n` +
      `/panel  控制面板（下方按钮）\n` +
      `/run  立即扫描并推送\n` +
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
      `   全局项自动写 global，其余写默认活动平台\n` +
      `   指定平台：/set edogawa:TIME_FILTER [...]\n` +
      `/log  日志（/log 100）\n` +
      `/addplace · /removeplace  增删场地（默认活动平台）\n` +
      `/enableplace · /disableplace  启用/停用场地\n` +
      `   指定平台：/addplace edogawa:场地 短名 🎾 25分`
  
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
      await quickRun(bot)
      return
    }

    if (data === 'quick_stats') {
      await bot.answerCallbackQuery(query.id, { text: '📈 获取统计' })
      await quickStats(bot, chatId)
      return
    }

    if (data === 'quick_resume') {
      await bot.answerCallbackQuery(query.id, { text: '▶️ 恢复中' })
      await quickResume(bot, chatId)
      return
    }

    if (data === 'quick_pause') {
      await bot.answerCallbackQuery(query.id, { text: '⏸️ 暂停中' })
      await quickPause(bot, chatId)
      return
    }

    if (data === 'quick_status') {
      await bot.answerCallbackQuery(query.id, { text: '已生成' })
      await quickStatus(bot, chatId)
      return
    }

    if (data === 'quick_booked') {
      await bot.answerCallbackQuery(query.id, { text: '📚 …' })
      await quickBooked(bot, chatId)
      return
    }

    if (data === 'quick_schedule') {
      await bot.answerCallbackQuery(query.id, { text: '📅 …' })
      await quickSchedule(bot, chatId)
      return
    }
  
    if (data === 'quick_place') {
      await bot.answerCallbackQuery(query.id, { text: '📍 打开面板' })
      try {
        const res = await monitorApi('GET', '/api/places')
        const places = filterPlacesByBot(res.data?.places || [], bot)
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

    // --- View place（多场地推送里的"查看空位"按钮） ---
    if (data.startsWith('viewplace_')) {
      const rest = data.replace('viewplace_', '')
      const [platform, ...placeParts] = rest.split('|')
      const place = placeParts.join('|')
      await bot.answerCallbackQuery(query.id, { text: '🔍 加载中...' })
      try {
        const res = await monitorApi('GET', `/api/place/${encodeURIComponent(platform)}/${encodeURIComponent(place)}`)
        const slots = res.data?.slots || []
        if (slots.length === 0) {
          await bot.sendMessage(chatId, '📍 该场地当前暂无空位')
          return
        }
        const pc = await getPlatformConfig(platform)
        const CHUNK = 10
        for (let i = 0; i < slots.length; i += CHUNK) {
          const part = slots.slice(i, i + CHUNK)
          const buttons = part.map(d => [{
            text: formatSlotText(d, pc),
            callback_data: `book_${d.ucode}`
          }])
          const h = `📍 ${place}（${slots.length} 个）${i === 0 ? '' : `\n（第 ${i / CHUNK + 1} 页）`}`
          await bot.sendMessage(chatId, h, { reply_markup: { inline_keyboard: buttons } })
        }
      } catch (e) {
        await bot.sendMessage(chatId, `❌ 获取场地数据失败：${e.message}`)
      }
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
        const places = filterPlacesByBot(placesRes.data?.places || [], bot)
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

      try {
        const slotRes = await monitorApi('GET', `/api/slot/${encodeURIComponent(ucode)}`)
        if (!slotRes.data?.success || !slotRes.data?.slot) {
          await bot.answerCallbackQuery(query.id, { text: '⚠️ 数据已过期，请重新获取' })
          return
        }
        const raw = slotRes.data.slot
        const hours = slotHours(raw)
        const startDate = parseSlotStartDateTimeSafe(raw)
        const soon = !!(startDate && startDate.getTime() > Date.now() && startDate.getTime() - Date.now() <= 7 * 24 * 3600 * 1000)
        if (hours > 2 || soon) {
          // 时段多于 2h 或 7 天内 → 行内二次确认（不弹窗，替换原按钮）
          const reason = hours > 2 ? `该时段 ${hoursLabel(hours)}` : '7天内时段'
          const rows = query.message.reply_markup?.inline_keyboard || []
          const newRows = rows.map(row => {
            if (!row.some(btn => btn.callback_data === data)) return row
            return [
              { text: `✅ 确认预约${hours > 2 ? ` ${hoursLabel(hours)}` : ''}`, callback_data: `confirm_book_${ucode}` },
              { text: '❌ 取消', callback_data: `cancel_book_${ucode}` }
            ]
          })
          try {
            await bot.editMessageReplyMarkup({ inline_keyboard: newRows }, {
              chat_id: query.message.chat.id,
              message_id: query.message.message_id
            })
          } catch (e) {
            console.warn('[book] 更新确认按钮失败:', e.message)
          }
          await bot.answerCallbackQuery(query.id, { text: `🕐 ${reason}，请确认是否预约` })
          return
        }
        await bot.answerCallbackQuery(query.id, { text: '🚀 开始预约...' })
        await doBook(bot, chatId, ucode)
      } catch (e) {
        await bot.answerCallbackQuery(query.id, { text: '❌ 操作失败' })
      }
      return
    }

    // --- Confirm booking (>2h / 7天内 二次确认) ---
    if (data.startsWith('confirm_book_')) {
      const ucode = data.replace('confirm_book_', '')
      await bot.answerCallbackQuery(query.id, { text: '🚀 开始预约...' })
      await doBook(bot, chatId, ucode)
      return
    }

    // --- Cancel booking (>2h / 7天内 二次确认取消) ---
    if (data.startsWith('cancel_book_')) {
      const ucode = data.replace('cancel_book_', '')
      try {
        const slotRes = await monitorApi('GET', `/api/slot/${encodeURIComponent(ucode)}`)
        if (slotRes.data?.success && slotRes.data?.slot) {
          const pc = await getPlatformConfig(slotRes.data.slot.platform)
          const restore = [{ text: formatSlotText(slotRes.data.slot, pc), callback_data: `book_${ucode}` }]
          const rows = query.message.reply_markup?.inline_keyboard || []
          const newRows = rows.map(row =>
            row.some(b => b.callback_data === `confirm_book_${ucode}` || b.callback_data === `cancel_book_${ucode}`)
              ? restore
              : row
          )
          try {
            await bot.editMessageReplyMarkup({ inline_keyboard: newRows }, {
              chat_id: query.message.chat.id,
              message_id: query.message.message_id
            })
          } catch (e) {
            console.warn('[cancel_book] 恢复按钮失败:', e.message)
          }
        }
      } catch (e) {
        console.warn('[cancel_book] 恢复按钮失败:', e.message)
      }
      await bot.answerCallbackQuery(query.id, { text: '已取消' })
      return
    }

    await bot.answerCallbackQuery(query.id, { text: '⚠️ 无效操作' })
  })
}

// ========================
// 启动
// ========================
async function start() {
  for (const b of bots) registerHandlers(b)
  console.log(`[telegram-bot] 启动成功，开始 polling（${bots.length} 个 bot）`)

  // 定时提醒
  setInterval(pushBookedReminderBySchedule, 60 * 1000)
  setInterval(pushUpcomingReminder, 60 * 1000)
}

start().catch(e => console.error('启动失败:', e))
