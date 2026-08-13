/**
 * Monitor Service
 *
 * 定时扫描服务
 * - 使用 platform adapter 获取空位
 * - 使用 core 进行过滤、比较
 * - 有变化时通过 Telegram 推送通知
 * - AUTO_BOOK 时调用 booking-service HTTP API
 *
 * HTTP API:
 *   GET  /api/status
 *   POST /api/run           body: { platforms?: string[] }（省略则全平台扫描）
 *   POST /api/pause
 *   POST /api/resume
 *   GET  /api/places
 *   POST /api/places/toggle   { platform, place }
 *   GET  /api/stats
 *   GET  /api/log?n=50
 *   GET  /api/slot/:ucode
 *   GET  /api/schedule-status
 *
 * 自身不执行任何 Playwright 预约操作
 * 不处理 Telegram 用户交互（由 telegram-bot 处理）
 */
require('@tennis-bot/config/loadEnv')()
const fs = require('fs')
const path = require('path')
const http = require('http')
const TelegramBot = require('node-telegram-bot-api')
const { loadPlatform } = require('@tennis-bot/platform')
const FileStorage = require('@tennis-bot/storage/file/FileStorage')
const ConfigManager = require('@tennis-bot/config')
const core = require('@tennis-bot/core')
const { formatSlotText, escapeMarkdown } = require('@tennis-bot/notifier')
const { createTrace, parseSlotStartDateTimeSafe, parseSlotDayKey, formatDateDisplayFromIso, slotToken } = require('@tennis-bot/utils')

const DATA_DIR = process.env.MONITOR_DATA_DIR || path.resolve(__dirname, '../../data')
const PORT = process.env.MONITOR_PORT || 3000
const BOOKING_HOST = process.env.BOOKING_HOST || 'http://localhost:4000'

const storage = new FileStorage(DATA_DIR)
const config = new ConfigManager(DATA_DIR)
config.load()

// ========================
// Telegram Bot（仅发送，不 polling）
// Bot 延迟初始化，支持每个平台独立的 Bot Token
// 优先级: <PLATFORM>_BOT_TOKEN > BOT_TOKEN
// ========================
let _defaultBot = null

function getDefaultBot() {
  if (!process.env.BOT_TOKEN) return null
  if (!_defaultBot) {
    _defaultBot = new TelegramBot(process.env.BOT_TOKEN, { polling: false })
  }
  return _defaultBot
}

// ========================
// 状态
// ========================
let currentData = []           // 各平台 union（供 API/bot 读取）
let currentVersion = 0
let currentSlotMap = new Map()
let autoBookedDayKeys = new Set()   // 跨平台去重，保持全局
let autoBookedUIDs = new Set()      // 跨平台去重，保持全局
let logBuffer = []

// 每个平台独立的运行时状态；平台之间彻底隔离，平台内部用 scanning 防重叠
const runtime = {}
for (const name of config.getPlatformNames()) {
  runtime[name] = {
    timer: null,          // 本平台 scheduler timer（null = 未武装）
    scanning: false,      // 本平台扫描/auto-book 进行中（防同平台重叠）
    firstRun: true,       // 本平台是否首次扫描（PUSH_ON_INIT 按平台独立处理）
    autoBooking: false,   // 本平台 auto-book 进行中 → 只暂停本平台
    paused: false,        // 本平台暂停
    nextRunAt: null,
    pendingManual: false, // 手动全量扫描请求在任务进行中时排队，结束后立即执行
    lastCycleStartAt: null, // 上一轮扫描周期的启动时间（周期起点调度用）
    lastSet: new Set()    // 只含本平台的 uid（diff 基线）
  }
}

// ========================
// 日志
// ========================
function getLogFile() {
  const date = new Date().toISOString().slice(0, 10)
  return path.join(DATA_DIR, '..', 'logs', `runtime-${date}.log`)
}

// 统一 24 小时制时间戳：YYYY-MM-DD HH:mm:ss
function formatLogTs(d = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// 耗时展示：ms → "6s" / "4m31s"
function formatDuration(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(s % 60).padStart(2, '0')}s`
}

function setupConsoleLogging() {
  if (console._log) return
  console._log = console.log
  console.log = (...args) => {
    const msg = `[${formatLogTs()}] ` +
      args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : a).join(' ')
    console._log(...args)
    logBuffer.push(msg)
    if (logBuffer.length > 200) logBuffer.shift()
    const logFile = getLogFile()
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    fs.appendFileSync(logFile, msg + '\n')
  }
}

function cleanOldLogs(days = 30) {
  const dir = path.resolve(DATA_DIR, '..', 'logs')
  if (!fs.existsSync(dir)) return
  const files = fs.readdirSync(dir)
  const now = Date.now()
  files.forEach(file => {
    const match = file.match(/runtime-(\d{4}-\d{2}-\d{2})\.log/)
    if (!match) return
    const fileDate = new Date(match[1]).getTime()
    if ((now - fileDate) / (1000 * 60 * 60 * 24) > days) {
      fs.unlinkSync(`${dir}/${file}`)
    }
  })
}

setupConsoleLogging()

// ========================
// Load saved state
// ========================
async function loadState() {
  autoBookedUIDs = await storage.getAutoBooked()

  // lastSet 支持两种格式：新 {platform:[uid,...]}；旧扁平 [uid,...]（一次性迁移为按平台分区）
  const raw = await storage.getLastSets()
  let partitioned = raw
  if (Array.isArray(raw)) {
    partitioned = {}
    for (const uid of raw) {
      const name = getPlatformNameByPlace(String(uid).split('_')[0])
      if (!name) continue
      if (!partitioned[name]) partitioned[name] = []
      partitioned[name].push(uid)
    }
    await storage.saveLastSets(partitioned)
    console.log(`[monitor] lastSet.json 已迁移为按平台格式: ${Object.keys(partitioned).join(', ') || '（空）'}`)
  }
  for (const name of config.getPlatformNames()) {
    runtime[name].lastSet = new Set(Array.isArray(partitioned?.[name]) ? partitioned[name] : [])
  }
}

// ========================
// 持久化 helpers
// ========================
function saveLastSets() {
  const map = {}
  for (const [name, st] of Object.entries(runtime)) {
    map[name] = [...st.lastSet]
  }
  storage.saveLastSets(map)
}

function saveAutoBooked() {
  storage.saveAutoBooked(autoBookedUIDs)
}

// ========================
// 通知 — 支持每个平台独立的 Bot Token 和 Chat ID
// 环境变量命名规范:
//   <PLATFORM>_BOT_TOKEN  — 平台专属 Bot Token（可选，默认使用 BOT_TOKEN）
//   <PLATFORM>_CHAT_ID    — 平台专属 Chat ID （可选，默认使用 CHAT_ID）
// 例如: ICHIKAWA_BOT_TOKEN, ICHIKAWA_CHAT_ID
// ========================
const _platformBots = new Map()

function getPlatformBotToken(platformName) {
  const key = `${platformName.toUpperCase()}_BOT_TOKEN`
  return process.env[key] || null
}

function getPlatformChatId(platformName) {
  const key = `${platformName.toUpperCase()}_CHAT_ID`
  return process.env[key] || process.env.CHAT_ID || null
}

function getBotForPlatform(platformName) {
  const token = getPlatformBotToken(platformName)
  if (token) {
    if (_platformBots.has(token)) return _platformBots.get(token)
    const b = new TelegramBot(token, { polling: false })
    _platformBots.set(token, b)
    return b
  }
  return getDefaultBot()
}

function getPlatformConfig(place) {
  for (const name of config.getPlatformNames()) {
    const pc = config.getPlatform(name)
    if (pc.PLACE_MAP?.[place]) return pc
  }
  return {}
}

function getPlatformNameByPlace(place) {
  for (const name of config.getPlatformNames()) {
    const pc = config.getPlatform(name)
    if (pc.PLACE_MAP?.[place]) return name
  }
  return null
}

/**
 * 获取生效的扫描间隔（秒）：平台显式设置的 INTERVAL > global.INTERVAL > 45
 */
function getPlatformInterval(name) {
  return config.getEffective('INTERVAL', name) || 45
}

/**
 * 获取生效的最大随机抖动（秒）
 */
function getEffectiveJitter() {
  return config.getEffective('JITTER_MAX') || 45
}

// 激活平台：enabled && 有 TARGET_PLACE && adapter 可加载
function activePlatformNames() {
  return config.getPlatformNames().filter(name => {
    const pc = config.getPlatform(name)
    if (pc.enabled === false) return false
    if (!pc.TARGET_PLACE?.length) return false
    if (!loadPlatform(name)) return false
    return true
  })
}

function isRunning() {
  return Object.values(runtime).some(s => s.timer != null)
}

function isAutoBooking() {
  return Object.values(runtime).some(s => s.autoBooking)
}

// 展示用最小生效间隔（/api/status.interval 兼容字段）
function getEffectiveInterval() {
  const names = activePlatformNames()
  if (names.length === 0) return config.global.INTERVAL || 45
  return Math.min(...names.map(getPlatformInterval))
}

/**
 * 每平台独立 scheduler：递归 setTimeout（非 setInterval），同平台绝不重叠。
 * await scanPlatform → finally → schedulePlatform，扫描变慢也不会堆积任务。
 *
 * INTERVAL 语义 = 目标启动间隔（周期起点），不是扫描结束后额外等待时间：
 *   下一轮启动时间 = 本轮启动时间 + INTERVAL + 随机抖动；
 *   若扫描耗时超过周期，则结束即立即重启（不堆积、不排队），实际频率始终有下限。
 *
 * 不在这里打印心跳日志（每轮都打会刷屏），下次启动时间通过 /api/status.nextRunAt 查看。
 */
function schedulePlatform(name) {
  const st = runtime[name]
  if (!st || st.timer) return
  const baseMs = getPlatformInterval(name) * 1000
  const jitterMaxMs = getEffectiveJitter() * 1000
  const jitter = Math.floor(Math.random() * (jitterMaxMs + 1))
  const periodMs = baseMs + jitter
  const now = Date.now()
  st.nextRunAt = Math.max((st.lastCycleStartAt || now) + periodMs, now)
  st.timer = setTimeout(() => {
    st.timer = null
    st.lastCycleStartAt = Date.now()
    scanPlatform(name).finally(() => {
      // paused 防 /pause 之后又武装；!st.timer 防重复 timer
      if (!st.paused && !st.timer) schedulePlatform(name)
    })
  }, Math.max(st.nextRunAt - now, 0))
}

/**
 * 向指定平台发送"暂无可预约"提示（跳过没有 Bot Token 的平台）
 */
async function sendNoSlotsMessageFor(name) {
  const pc = config.getPlatform(name)
  if (pc.enabled === false) return
  const b = getBotForPlatform(name)
  const chatId = getPlatformChatId(name)
  if (!b || !chatId) return
  await b.sendMessage(
    chatId,
    `📭 *暂无可预约*\n━━━━━━━━━━━━━━\n可以稍后再试 /run`,
    { parse_mode: 'Markdown' }
  )
}

function groupSlotsByPlatform(slots) {
  const map = new Map()
  for (const s of slots) {
    const p = s.platform || 'default'
    if (!map.has(p)) map.set(p, [])
    map.get(p).push(s)
  }
  return map
}

// 场地优先级：PLACE_MAP.priority 越小越靠前（未配置按 999 排最后）
function placePriority(d) {
  const pc = getPlatformConfig(d.place)
  const p = pc.PLACE_MAP?.[d.place]?.priority
  return Number.isFinite(p) ? p : 999
}

function sortSlots(list) {
  return list.slice().sort((a, b) => {
    const pa = placePriority(a), pb = placePriority(b)
    if (pa !== pb) return pa - pb
    const ta = `${a.date || ''} ${a.start || a.time || ''}`
    const tb = `${b.date || ''} ${b.start || b.time || ''}`
    return ta < tb ? -1 : ta > tb ? 1 : 0
  })
}

// 每条消息最多放的内联按钮数：避免 Telegram "reply markup is too long"
const MAX_INLINE_BUTTONS = 10

function placeMeta(place) {
  const pc = getPlatformConfig(place)
  return pc.PLACE_MAP?.[place] || {}
}
function placeShort(place) { return placeMeta(place).short || place }
function placeEmoji(place) { return placeMeta(place).emoji || '🎾' }

// "查看空位"按钮对应的推送快照：点击只显示本次推送的 slot，而不是场地当前全部空位
const pushSnapshots = new Map()
const PUSH_SNAPSHOT_TTL = 30 * 60 * 1000
function storePushSnapshot({ platform, place, slots }) {
  const token = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const now = Date.now()
  pushSnapshots.set(token, { platform, place, slots, ts: now })
  for (const [k, v] of pushSnapshots) {
    if (now - v.ts > PUSH_SNAPSHOT_TTL) pushSnapshots.delete(k)
  }
  return token
}

// 分批发送 book 按钮（每批 MAX_INLINE_BUTTONS 个）
async function sendBookButtons(bot, chatId, slots, header) {
  for (let i = 0; i < slots.length; i += MAX_INLINE_BUTTONS) {
    const part = slots.slice(i, i + MAX_INLINE_BUTTONS)
    const buttons = part.map(d => ({
      text: formatSlotText(d, getPlatformConfig(d.place)),
      callback_data: `book_${slotToken(d.ucode)}`
    }))
    const h = i === 0 ? header : `${header}\n（第 ${i / MAX_INLINE_BUTTONS + 1} 页）`
    await bot.sendMessage(chatId, h, { reply_markup: { inline_keyboard: buttons.map(b => [b]) } })
  }
}

// slot 的显示组标签：
//   有 group → 该组；配置了 COURT_GROUPS 但未命中任何组 → "其他"；未配置 → ''（不分组）
function sectionGroupOf(d, platformConfig) {
  if (d.group) return d.group
  if (platformConfig?.COURT_GROUPS?.[d.place]) return '其他'
  return ''
}

// 是否周末（土/日）
function isWeekend(d) {
  const m = String(d.dateDisplay || '').match(/[（(]([月火水木金土日])[）)]/)
  if (m) return m[1] === '土' || m[1] === '日'
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(d.date || ''))) {
    const [y, mo, day] = String(d.date).split('-').map(Number)
    const w = new Date(y, mo - 1, day).getDay()
    return w === 0 || w === 6
  }
  return false
}

// 周末在前，周末/平日各自按 日期+时间 先后
function sortWeekendFirst(list) {
  return list.slice().sort((a, b) => {
    const wa = isWeekend(a) ? 0 : 1
    const wb = isWeekend(b) ? 0 : 1
    if (wa !== wb) return wa - wb
    const ta = `${a.date || ''} ${a.start || a.time || ''}`
    const tb = `${b.date || ''} ${b.start || b.time || ''}`
    return ta < tb ? -1 : ta > tb ? 1 : 0
  })
}

// 场地摘要一行：场地名出现一次，组计数内联（"🎯 西葛西（硬地 ×3 ・ 人工芝 ×13）"），无组只显示场地
function placeSummaryLine(place, slots, platformConfig) {
  const counts = new Map()
  for (const d of slots) {
    const g = sectionGroupOf(d, platformConfig)
    counts.set(g, (counts.get(g) || 0) + 1)
  }
  const cfgGroups = platformConfig?.COURT_GROUPS?.[place]
  const labels = cfgGroups
    ? [...cfgGroups.map(g => g.group), '其他', ''].filter(g => counts.has(g))
    : [''].filter(g => counts.has(g))
  const base = `${placeEmoji(place)} ${placeShort(place)}`
  if (labels.length === 1 && labels[0] === '') return `${base} ×${counts.get('')}`
  return `${base}（${labels.map(g => g ? `${g} ×${counts.get(g)}` : `其他 ×${counts.get(g)}`).join(' ・ ')}）`
}

async function sendTelegram(data, version, title = '🆕 可预约（点击直接预约）') {
  const grouped = groupSlotsByPlatform(data)

  for (const [platform, slots] of grouped) {
    const maxPush = config.getEffective('MAX_PUSH', platform) || 100
    const botInstance = getBotForPlatform(platform)
    const chatId = getPlatformChatId(platform)
    if (!botInstance || !chatId) {
      console.log(`[通知] ${platform} 未配置 Bot Token 或 Chat ID，跳过`)
      continue
    }
    const platformConfig = config.getPlatform(platform)
    const list = sortSlots(slots).slice(0, maxPush)

    // 按场地分组（空位多的场地一个"查看空位"按钮；场地内硬地/人工芝在摘要行内联）
    const byPlace = new Map()
    for (const d of list) {
      if (!byPlace.has(d.place)) byPlace.set(d.place, [])
      byPlace.get(d.place).push(d)
    }
    const places = [...byPlace.keys()]

    // 单场地且空位少 → 直接全部 book 按钮（周末在前，保持一键预约）
    if (places.length === 1 && list.length <= MAX_INLINE_BUTTONS) {
      await sendBookButtons(botInstance, chatId, sortWeekendFirst(list), title)
      continue
    }

    // 多场地 → 两级导航：第一个场地直接给 book 按钮（周末在前），其余场地：
    //   空位少（≤ MAX_INLINE_BUTTONS）→ 直接铺 book 按钮；空位多 → "查看空位"按钮（点击只显示本次推送的 slot）
    const firstPlace = places[0]
    const firstSlots = sortWeekendFirst(byPlace.get(firstPlace))
    await sendBookButtons(
      botInstance,
      chatId,
      firstSlots,
      `${title}\n━━━━━━━━━━━━━━\n${placeEmoji(firstPlace)} ${placeShort(firstPlace)}（${byPlace.get(firstPlace).length} 个）`
    )

    const rest = places.slice(1)
    for (const p of rest.filter(p => byPlace.get(p).length <= MAX_INLINE_BUTTONS)) {
      const pSlots = byPlace.get(p)
      await sendBookButtons(
        botInstance,
        chatId,
        sortWeekendFirst(pSlots),
        `${title}\n━━━━━━━━━━━━━━\n${placeEmoji(p)} ${placeShort(p)}（${pSlots.length} 个）`
      )
    }

    const collapsed = rest.filter(p => byPlace.get(p).length > MAX_INLINE_BUTTONS)
    if (collapsed.length > 0) {
      const restRows = collapsed.map(p => placeSummaryLine(p, byPlace.get(p), platformConfig))
      const restButtons = collapsed.map(p => [{
        text: `🔍 ${placeShort(p)}（${byPlace.get(p).length}）查看空位`,
        callback_data: `viewplace_${storePushSnapshot({ platform, place: p, slots: byPlace.get(p) })}`
      }])
      await botInstance.sendMessage(
        chatId,
        `${title}\n━━━━━━━━━━━━━━\n${restRows.join('\n')}`,
        { reply_markup: { inline_keyboard: restButtons } }
      )
    }
  }
}

async function sendRemovedTelegram(data) {
  const grouped = groupSlotsByPlatform(data)

  for (const [platform, slots] of grouped) {
    const botInstance = getBotForPlatform(platform)
    const chatId = getPlatformChatId(platform)
    if (!botInstance || !chatId) {
      console.log(`[通知] ${platform} 未配置 Bot Token 或 Chat ID，跳过`)
      continue
    }
    const maxPush = config.getEffective('MAX_PUSH', platform) || 100
    const msg = sortSlots(slots).slice(0, maxPush)
      .map(d => `⚠️ 已被预约\n${formatSlotText(d, getPlatformConfig(d.place))}`)
      .join('\n\n')
    for (const part of core.splitForTelegram(msg)) {
      await botInstance.sendMessage(chatId, part)
    }
  }
}

// ========================
// 调用 booking-service
// ========================
async function callBookingService(slotData, platformName) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ platform: platformName, slot: slotData })
    const req = http.request(`${BOOKING_HOST}/api/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { resolve({ success: false, message: data }) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ========================
// 手动扫描（Telegram /run、POST /api/run）
// ========================
// 语义：用户主动触发 → 当前配置范围全量扫描并推送（不受 AUTO_BOOK 过滤限制），
// 不更新全局 diff 状态（lastSet/currentData），避免手动 /run 干扰定时扫描的去重与减少通知。
//
// 与定时扫描共用 scanning 守卫：若当前正在扫描/auto-book，不丢弃请求，
// 而是置 pendingManual，当前任务结束后立即执行一次手动全量扫描。
async function runManualScan(platformName) {
  const st = runtime[platformName]
  const platformConfig = config.getPlatform(platformName)
  st.scanning = true
  try {
    const adapter = loadPlatform(platformName)
    if (!adapter) return
    const slots = await adapter.fetchSlots(platformConfig)
    console.log(`[手动] ${platformName} 获取 ${slots.length} 个空位`)

    const enriched = slots.map(s => {
      const time = s.time || `${s.start}-${s.end}`
      const dateDisplay = s.dateDisplay || formatDateDisplayFromIso(s.date)
      const ucode = core.buildUcode({ ...s, time, dateDisplay }, platformConfig)
      const uid = `${s.place}_${s.court}_${s.date}_${time}`
      return { ...s, time, dateDisplay, ucode, uid }
    })
    const filtered = core.filterSlotsByConfig(enriched, platformConfig)

    if (filtered.length > 0) {
      await sendTelegram(filtered, Date.now())
    } else {
      const b = getBotForPlatform(platformName)
      const chatId = getPlatformChatId(platformName)
      if (b && chatId) {
        await b.sendMessage(
          chatId,
          `📭 *暂无可预约*\n━━━━━━━━━━━━━━\n可以稍后再试 /run`,
          { parse_mode: 'Markdown' }
        )
      }
    }
  } catch (e) {
    console.log(`[手动] ${platformName} 扫描失败:`, e.message)
  } finally {
    st.scanning = false
    await drainPendingManual(platformName)
  }
}

// 手动请求入口：正在扫描/auto-book 则排队，否则立即执行全量扫描
async function requestManualScan(platformName) {
  const st = runtime[platformName]
  if (!st) return
  const platformConfig = config.getPlatform(platformName)
  if (platformConfig.enabled === false) return
  const adapter = loadPlatform(platformName)
  if (!adapter) return
  if (!platformConfig.TARGET_PLACE?.length) return

  if (st.scanning || st.autoBooking) {
    st.pendingManual = true
    console.log(`[手动] ${platformName} 当前任务进行中，手动全量扫描已排队（结束后立即执行）`)
    return
  }
  await runManualScan(platformName)
}

// 当前任务结束后，若期间有手动请求 → 立即执行一次手动全量扫描（不丢弃用户请求）
async function drainPendingManual(platformName) {
  const st = runtime[platformName]
  if (!st || !st.pendingManual) return
  st.pendingManual = false
  console.log(`[手动] ${platformName} 执行排队的手动全量扫描`)
  await runManualScan(platformName)
}

// ========================
// 扫描（单平台）
// ========================

/**
 * 自动预约：只针对当前扫描到的平台（st.autoBooking 守卫，只暂停本平台）。
 * 语义保持原样：需 global.AUTO_BOOK=true，平台显式 false 可关闭。
 */
async function autoBookPlatform(name, added, platformConfig, trace) {
  const st = runtime[name]
  if (config.global.AUTO_BOOK !== true || st.autoBooking) return
  if ('AUTO_BOOK' in platformConfig && !platformConfig.AUTO_BOOK) {
    console.log(`[MONITOR][${name.toUpperCase()}][${trace}] AUTO_BOOK ${name} 已关闭`)
    return
  }
  const autoCandidates = core.filterSlotsAuto(added, platformConfig)
  if (autoCandidates.length === 0) {
    console.log(`[MONITOR][${name.toUpperCase()}][${trace}] AUTO_BOOK 无匹配项`)
    return
  }

  const now = Date.now()
  const validCandidates = autoCandidates.filter(d => {
    const startDate = parseSlotStartDateTimeSafe(d)
    if (!startDate) return false
    const diffMin = (startDate.getTime() - now) / 60000
    if (diffMin < 20) return false
    const dayKey = parseSlotDayKey(d)
    if (dayKey && autoBookedDayKeys.has(dayKey)) return false
    if (autoBookedUIDs.has(d.uid)) return false
    return true
  })

  if (validCandidates.length === 0) {
    console.log(`[MONITOR][${name.toUpperCase()}][${trace}] AUTO_BOOK 筛选后无候选`)
    return
  }

  const targets = core.autoPickTargets(validCandidates, autoBookedUIDs, autoBookedDayKeys)
  if (targets.length === 0) return

  console.log(
    `[MONITOR][${name.toUpperCase()}][${trace}] AUTO_BOOK 准备预约 ${targets.length} 个：`,
    targets.map(d => `${d.place} ${d.time}`).join(' · ')
  )

  st.autoBooking = true
  try {
    const bookedFees = new Map()
    for (const target of targets) {
      const result = await callBookingService(target, name)
      if (result.success) {
        if (result.fee?.total != null) bookedFees.set(target.ucode, result.fee.total)
        const dayKey = parseSlotDayKey(target)
        if (dayKey) autoBookedDayKeys.add(dayKey)
        autoBookedUIDs.add(target.uid)
        saveAutoBooked()
      }
    }

    const abBot = getBotForPlatform(name)
    const abChat = getPlatformChatId(name)
    if (!abBot || !abChat) {
      console.log(`[AUTO_BOOK] ${name} 未配置 Bot Token，跳过通知`)
    } else {
      await abBot.sendMessage(
        abChat,
        `🎉 *自动预约成功！*\n━━━━━━━━━━━━━━\n` +
        targets.map(d => formatSlotText(
          bookedFees.has(d.ucode) ? { ...d, totalFee: bookedFees.get(d.ucode) } : d,
          getPlatformConfig(d.place),
          { showBike: true, showFee: true, style: 'detail' }
        )).join('\n\n'),
        { parse_mode: 'Markdown' }
      )
    }

    // 预约成功后只强制重扫本平台
    setTimeout(() => scanPlatform(name, { forcePush: true }), 1000)
  } catch (e) {
    for (const d of targets) {
      autoBookedUIDs.add(d.uid)
    }
    saveAutoBooked()
    const abBot = getBotForPlatform(name)
    const abChat = getPlatformChatId(name)
    if (abBot && abChat) {
      await abBot.sendMessage(
        abChat,
        `❌ *自动预约失败*\n━━━━━━━━━━━━━━\n` +
        targets.map(d => formatSlotText(d, getPlatformConfig(d.place), { style: 'detail' })).join('\n\n') +
        `\n\n🧨 ${escapeMarkdown(e.message)}`,
        { parse_mode: 'Markdown' }
      )
    }
  } finally {
    st.autoBooking = false
  }
}

/**
 * 扫描单个平台：
 * - st.scanning/st.autoBooking 守卫防同平台重叠（auto-book 进行中只暂停本平台）
 * - 只更新本平台在 lastSet / currentData / currentSlotMap 里的切片
 * - firstRun / PUSH_ON_INIT / diff / auto-book 全部平台内隔离
 * - 异常只记日志，不影响本平台下个周期与其它平台
 */
async function scanPlatform(name, options = {}) {
  const { forcePush = false } = options
  const trace = createTrace()
  const st = runtime[name]
  if (!st) return
  if (st.scanning || st.autoBooking) {
    console.log(`[MONITOR][${name.toUpperCase()}][${trace}] SKIP 扫描/auto-book 进行中，跳过`)
    return
  }
  const platformConfig = config.getPlatform(name)
  if (platformConfig.enabled === false) return
  const adapter = loadPlatform(name)
  if (!adapter) return
  if (!platformConfig.TARGET_PLACE?.length) return

  st.scanning = true
  const scanStart = Date.now()
  try {
    const slots = await adapter.fetchSlots(platformConfig)

    const enriched = slots.map(s => {
      const time = s.time || `${s.start}-${s.end}`
      const dateDisplay = s.dateDisplay || formatDateDisplayFromIso(s.date)
      const ucode = core.buildUcode({ ...s, time, dateDisplay }, platformConfig)
      const uid = `${s.place}_${s.court}_${s.date}_${time}`
      return { ...s, platform: name, time, dateDisplay, ucode, uid }
    })
    const filtered = core.filterSlotsByConfig(enriched, platformConfig)

    // 合并全局状态：先删本平台旧切片再并入（同步块，await 之间原子）
    const newMap = new Map(currentSlotMap)
    for (const key of [...newMap.keys()]) {
      if (newMap.get(key).platform === name) newMap.delete(key)
    }
    for (const d of filtered) newMap.set(d.ucode, d)
    currentSlotMap = newMap
    currentData = currentData.filter(s => s.platform !== name).concat(filtered)
    currentVersion = Date.now()

    const currentUids = new Set(filtered.map(d => d.uid))

    // 本平台首次运行：PUSH_ON_INIT 独立处理
    if (st.firstRun) {
      st.firstRun = false
      console.log(`[MONITOR][${name.toUpperCase()}][${trace}] 首次运行 ${filtered.length} 空位 · ${formatDuration(Date.now() - scanStart)}`)
      if (config.getEffective('PUSH_ON_INIT', name) !== false) {
        if (filtered.length > 0) {
          await sendTelegram(filtered, currentVersion)
        } else {
          await sendNoSlotsMessageFor(name)
        }
      }
      st.lastSet = currentUids
      saveLastSets()
      return
    }

    const added = filtered.filter(d => !st.lastSet.has(d.uid))
    const removedUids = [...st.lastSet].filter(k => !currentUids.has(k))
    const removed = removedUids.map(k => {
      const [place, court, date, time] = k.split('_')
      return { platform: name, place, court, date, time, uid: k }
    })

    core.recordStats('added', added)
    core.recordStats('removed', removed)

    if (added.length === 0 && removed.length === 0) {
      if (forcePush) {
        console.log(`[MONITOR][${name.toUpperCase()}][${trace}] FORCE_PUSH 强制推送 ${filtered.length}`)
        if (filtered.length > 0) {
          await sendTelegram(filtered, currentVersion)
        } else {
          await sendNoSlotsMessageFor(name)
        }
      } else {
        console.log(`[MONITOR][${name.toUpperCase()}][${trace}] ${filtered.length} 空位 无变化 · ${formatDuration(Date.now() - scanStart)}`)
      }
      return
    }

    console.log(`[MONITOR][${name.toUpperCase()}][${trace}] ${filtered.length} 空位 DIFF +${added.length} -${removed.length} · ${formatDuration(Date.now() - scanStart)}`)

    st.lastSet = currentUids
    saveLastSets()

    if (added.length > 0) {
      if (config.getEffective('NOTIFY_ADDED', name) !== false) {
        console.log(`[MONITOR][${name.toUpperCase()}][${trace}] PUSH 发送新增通知 ${added.length}`)
        await sendTelegram(added, currentVersion, '✨ 有新场地！点击直接预约')
      }
      await autoBookPlatform(name, added, platformConfig, trace)
    }

    if (removed.length > 0 && config.getEffective('NOTIFY_REMOVED', name) !== false) {
      // console.log(`[MONITOR][${name.toUpperCase()}][${trace}] PUSH 发送减少通知 ${removed.length}`)
      await sendRemovedTelegram(removed)
    }
  } catch (e) {
    console.log(`[MONITOR][${name.toUpperCase()}][${trace}] 扫描失败:`, e.message)
  } finally {
    st.scanning = false
    // 期间有手动请求 → 结束后立即执行手动全量扫描（不丢弃）
    await drainPendingManual(name)
  }
}

// ========================
// HTTP API
// ========================
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      try { resolve(JSON.parse(body)) } catch { reject(new Error('Invalid JSON')) }
    })
    req.on('error', reject)
  })
}

function json(res, data, status = 200) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json')

  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const pathname = url.pathname

    // GET /api/status
    if (req.method === 'GET' && pathname === '/api/status') {
      const platforms = {}
      for (const name of config.getPlatformNames()) {
        const st = runtime[name]
        platforms[name] = {
          interval: getPlatformInterval(name),
          nextRunAt: st.nextRunAt,
          scanning: st.scanning,
          paused: st.paused
        }
      }
      return json(res, {
        running: isRunning(),
        scanning: false,
        autoBooking: isAutoBooking(),
        slotCount: currentData.length,
        version: currentVersion,
        interval: getEffectiveInterval(),
        jitterMax: getEffectiveJitter(),
        platforms,
        config: {
          global: config.global,
          platforms: config.getAllPlatforms()
        }
      })
    }

    // POST /api/run   body: { platforms?: string[] }（省略则全平台手动扫描）
    // 手动扫描走 requestManualScan：正在扫描/auto-book 时排队，结束后立即执行，不丢弃请求
    if (req.method === 'POST' && pathname === '/api/run') {
      const body = await parseBody(req).catch(() => null)
      const platforms = Array.isArray(body?.platforms) ? body.platforms : null
      const names = platforms && platforms.length > 0 ? platforms : activePlatformNames()
      ;(async () => {
        for (const p of names) await requestManualScan(p)
      })().catch(e => console.error('[/api/run] error:', e))
      return json(res, { success: true, message: '扫描已触发' })
    }

    // POST /api/pause —— 暂停所有平台 scheduler，清理所有 timer
    if (req.method === 'POST' && pathname === '/api/pause') {
      for (const st of Object.values(runtime)) {
        st.paused = true
        if (st.timer) {
          clearTimeout(st.timer)
          st.timer = null
        }
      }
      return json(res, { success: true, message: '已暂停' })
    }

    // POST /api/resume —— 恢复所有平台 scheduler（不创建重复 timer）
    if (req.method === 'POST' && pathname === '/api/resume') {
      for (const name of activePlatformNames()) {
        const st = runtime[name]
        st.paused = false
        if (!st.timer) schedulePlatform(name)
      }
      return json(res, { success: true, message: '已恢复' })
    }

    // GET /api/places
    if (req.method === 'GET' && pathname === '/api/places') {
      const places = []
      for (const pname of config.getPlatformNames()) {
        const pc = config.getPlatform(pname)
        if (pc.enabled === false) continue
        for (const [name, v] of Object.entries(pc.PLACE_MAP || {})) {
          places.push({
            platform: pname,
            name,
            short: v.short,
            emoji: v.emoji,
            bike: v.bike || '',
            enabled: pc.TARGET_PLACE?.includes(name) || false
          })
        }
      }
      return json(res, { places })
    }

    // POST /api/places/toggle
    if (req.method === 'POST' && pathname === '/api/places/toggle') {
      const { platform, place } = await parseBody(req)
      if (!platform || !place) {
        return json(res, { success: false, message: '缺少 platform 或 place' }, 400)
      }
      const pc = config.getPlatform(platform)
      if (!pc.PLACE_MAP?.[place]) {
        return json(res, { success: false, message: '场地不存在' }, 404)
      }
      const enabled = pc.TARGET_PLACE?.includes(place)
      if (enabled) {
        pc.TARGET_PLACE = (pc.TARGET_PLACE || []).filter(p => p !== place)
      } else {
        pc.TARGET_PLACE = pc.TARGET_PLACE || []
        pc.TARGET_PLACE.push(place)
      }
      config.setPlatform(platform, 'TARGET_PLACE', pc.TARGET_PLACE)
      config.save()
      return json(res, { success: true, enabled: !enabled })
    }

    // POST /api/config/set
    if (req.method === 'POST' && pathname === '/api/config/set') {
      const { key, value, platform } = await parseBody(req)
      if (!key) return json(res, { success: false, message: '缺少 key' }, 400)
      if (platform) {
        config.setPlatform(platform, key, value)
      } else {
        if (!(key in config.global)) {
          return json(res, { success: false, message: `不存在配置项 ${key}` }, 400)
        }
        config.set(key, value)
      }
      config.save()
      return json(res, { success: true })
    }

    // POST /api/places/add
    if (req.method === 'POST' && pathname === '/api/places/add') {
      const { platform, name, short, emoji, bike } = await parseBody(req)
      if (!platform || !name) {
        return json(res, { success: false, message: '缺少 platform 或 name' }, 400)
      }
      const pc = config.getPlatform(platform)
      if (!pc.TARGET_PLACE?.includes(name)) {
        pc.TARGET_PLACE = pc.TARGET_PLACE || []
        pc.TARGET_PLACE.push(name)
      }
      pc.PLACE_MAP = pc.PLACE_MAP || {}
      pc.PLACE_MAP[name] = { short: short || name, emoji: emoji || '🎾', bike: bike || '' }
      config.setPlatform(platform, 'TARGET_PLACE', pc.TARGET_PLACE)
      config.setPlatform(platform, 'PLACE_MAP', pc.PLACE_MAP)
      config.save()
      return json(res, { success: true })
    }

    // POST /api/places/remove
    if (req.method === 'POST' && pathname === '/api/places/remove') {
      const { platform, name } = await parseBody(req)
      if (!platform || !name) {
        return json(res, { success: false, message: '缺少 platform 或 name' }, 400)
      }
      const pc = config.getPlatform(platform)
      if (!pc.PLACE_MAP?.[name]) {
        return json(res, { success: false, message: '场地不存在' }, 404)
      }
      pc.TARGET_PLACE = (pc.TARGET_PLACE || []).filter(p => p !== name)
      delete pc.PLACE_MAP[name]
      config.setPlatform(platform, 'TARGET_PLACE', pc.TARGET_PLACE)
      config.setPlatform(platform, 'PLACE_MAP', pc.PLACE_MAP)
      config.save()
      return json(res, { success: true })
    }

    // GET /api/stats
    if (req.method === 'GET' && pathname === '/api/stats') {
      const allPlaceMaps = {}
      for (const pname of config.getPlatformNames()) {
        const pc = config.getPlatform(pname)
        Object.assign(allPlaceMaps, pc.PLACE_MAP || {})
      }
      const report = core.buildStatsReport(allPlaceMaps)
      return json(res, { report, parts: core.splitForTelegram(report, 3800) })
    }

    // GET /api/log?n=50
    if (req.method === 'GET' && pathname === '/api/log') {
      const n = Math.min(200, Math.max(1, Number(url.searchParams.get('n')) || 50))
      return json(res, { lines: logBuffer.slice(-n) })
    }

    // GET /api/place/:platform/:place — 某场地当前空位（兼容旧推送按钮，周末在前）
    if (req.method === 'GET' && pathname.startsWith('/api/place/')) {
      const parts = decodeURIComponent(pathname.replace('/api/place/', '')).split('/')
      const platform = parts[0]
      const place = parts.slice(1).join('/')
      const slots = sortWeekendFirst((currentData || []).filter(s =>
        s.platform === platform && s.place === place
      ))
      return json(res, { success: true, slots })
    }

    // GET /api/push-snapshot/:token — 推送"查看空位"按钮对应的快照（只含本次推送的 slot，周末在前）
    if (req.method === 'GET' && pathname.startsWith('/api/push-snapshot/')) {
      const token = decodeURIComponent(pathname.replace('/api/push-snapshot/', ''))
      const snap = pushSnapshots.get(token)
      if (!snap) return json(res, { success: false, message: '该推送已过期，请等待下次推送' }, 404)
      return json(res, { success: true, platform: snap.platform, place: snap.place, slots: sortWeekendFirst(snap.slots) })
    }

    // GET /api/slot/:id（id 为完整 ucode 或 slotToken，按钮只传 token 以规避 callback_data 64 字节限制）
    if (req.method === 'GET' && pathname.startsWith('/api/slot/')) {
      const id = decodeURIComponent(pathname.replace('/api/slot/', ''))
      let slot = currentSlotMap.get(id)
      if (!slot) {
        for (const s of currentSlotMap.values()) {
          if (slotToken(s.ucode) === id) { slot = s; break }
        }
      }
      if (!slot) {
        return json(res, { success: false, message: 'slot 已过期' }, 404)
      }
      return json(res, { success: true, slot })
    }

    // GET /api/schedule-status
    if (req.method === 'GET' && pathname === '/api/schedule-status') {
      const platforms = {}
      for (const name of config.getPlatformNames()) {
        const st = runtime[name]
        platforms[name] = {
          interval: getPlatformInterval(name),
          nextRunAt: st.nextRunAt,
          scanning: st.scanning,
          paused: st.paused,
          firstRun: st.firstRun
        }
      }
      return json(res, {
        running: isRunning(),
        interval: getEffectiveInterval(),
        autoBooking: isAutoBooking(),
        lastScanVersion: currentVersion,
        platforms
      })
    }

    json(res, { success: false, message: 'Not found' }, 404)
  } catch (e) {
    json(res, { success: false, message: e.message }, 400)
  }
})

// ========================
// 启动
// ========================
async function start() {
  await loadState()
  cleanOldLogs(30)

  // HTTP API 服务
  server.listen(PORT, () => {
    console.log(`[monitor-service] HTTP API 启动于 http://localhost:${PORT}`)
  })

  // 各平台各自首次扫描（PUSH_ON_INIT 平台内独立处理）
  const names = activePlatformNames()
  console.log(`[monitor-service] 激活平台: ${names.map(n => `${n}(${getPlatformInterval(n)}s)`).join(', ') || '（无）'}`)
  for (const name of names) {
    await scanPlatform(name)
  }

  // 各平台独立定时器
  for (const name of names) {
    schedulePlatform(name)
  }

  // 清理旧日志
  setInterval(() => cleanOldLogs(30), 24 * 60 * 60 * 1000)
}

start().catch(e => console.error('启动失败:', e))
