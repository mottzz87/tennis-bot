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
const { createTrace, parseSlotStartDateTimeSafe, parseSlotDayKey, formatDateDisplayFromIso } = require('@tennis-bot/utils')

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
let currentData = []
let currentVersion = 0
let currentSlotMap = new Map()
let isFirstRun = true
let timer = null
let autoBooking = false
let autoBookedDayKeys = new Set()
let autoBookedUIDs = new Set()
let lastSet = new Set()
let logBuffer = []

// ========================
// 日志
// ========================
function getLogFile() {
  const date = new Date().toISOString().slice(0, 10)
  return path.join(DATA_DIR, '..', 'logs', `runtime-${date}.log`)
}

function setupConsoleLogging() {
  if (console._log) return
  console._log = console.log
  console.log = (...args) => {
    const msg = `[${new Date().toLocaleString()}] ` +
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
  lastSet = await storage.getLastSet()
  autoBookedUIDs = await storage.getAutoBooked()
}

// ========================
// 持久化 helpers
// ========================
function saveLastSet() {
  storage.saveLastSet(lastSet)
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
 * 获取生效的扫描间隔（秒）
 * 优先级：任意平台显式设置的 INTERVAL > global.INTERVAL > 45
 */
function getEffectiveInterval() {
  for (const name of config.getPlatformNames()) {
    const pc = config.getPlatform(name)
    if (pc && 'INTERVAL' in pc) return pc.INTERVAL
  }
  return config.global.INTERVAL || 45
}

/**
 * 获取生效的最大随机抖动（秒）
 */
function getEffectiveJitter() {
  return config.getEffective('JITTER_MAX') || 45
}

/**
 * 以递归 setTimeout 替代 setInterval，支持随机抖动
 */
function scheduleNext() {
  const baseMs = getEffectiveInterval() * 1000
  const jitterMaxMs = getEffectiveJitter() * 1000
  const jitter = Math.floor(Math.random() * (jitterMaxMs + 1))
  const delay = baseMs + jitter
  console.log(`[定时] 下次扫描: ${(baseMs/1000)}s + 随机 ${(jitter/1000).toFixed(1)}s = ${(delay/1000).toFixed(1)}s`)
  timer = setTimeout(() => {
    timer = null
    monitor().finally(() => {
      if (!timer) scheduleNext()
    })
  }, delay)
}

/**
 * 向所有已配置的平台发送"暂无可预约"提示
 * 跳过没有 Bot Token 的平台
 */
async function sendNoSlotsMessage() {
  for (const name of config.getPlatformNames()) {
    const pc = config.getPlatform(name)
    if (pc.enabled === false) continue
    const b = getBotForPlatform(name)
    const chatId = getPlatformChatId(name)
    if (!b || !chatId) continue
    await b.sendMessage(
      chatId,
      `📭 *暂无可预约*\n━━━━━━━━━━━━━━\n可以稍后再试 /run`,
      { parse_mode: 'Markdown' }
    )
  }
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

// 分批发送 book 按钮（每批 MAX_INLINE_BUTTONS 个）
async function sendBookButtons(bot, chatId, slots, header) {
  for (let i = 0; i < slots.length; i += MAX_INLINE_BUTTONS) {
    const part = slots.slice(i, i + MAX_INLINE_BUTTONS)
    const buttons = part.map(d => ({
      text: formatSlotText(d, getPlatformConfig(d.place)),
      callback_data: `book_${d.ucode}`
    }))
    const h = i === 0 ? header : `${header}\n（第 ${i / MAX_INLINE_BUTTONS + 1} 页）`
    await bot.sendMessage(chatId, h, { reply_markup: { inline_keyboard: buttons.map(b => [b]) } })
  }
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
    const list = sortSlots(slots).slice(0, maxPush)
    const byPlace = new Map()
    for (const d of list) {
      if (!byPlace.has(d.place)) byPlace.set(d.place, [])
      byPlace.get(d.place).push(d)
    }
    const places = [...byPlace.keys()]

    // 单场地且空位少 → 直接全部 book 按钮（保持一键预约）
    if (places.length === 1 && list.length <= MAX_INLINE_BUTTONS) {
      await sendBookButtons(botInstance, chatId, list, title)
      continue
    }

    // 多场地/空位多 → 两级导航：
    //   第一个（优先级最高）场地直接给 book 按钮，其余场地给"查看空位"按钮
    const firstPlace = places[0]
    const firstSlots = byPlace.get(firstPlace)
    await sendBookButtons(
      botInstance,
      chatId,
      firstSlots,
      `${title}\n━━━━━━━━━━━━━━\n${placeEmoji(firstPlace)} ${placeShort(firstPlace)}（${firstSlots.length} 个）`
    )

    const restRows = places.map(p =>
      `${placeEmoji(p)} ${placeShort(p)} ×${byPlace.get(p).length}`
    )
    const restButtons = places.slice(1).map(p => [{
      text: `🔍 ${placeShort(p)}（${byPlace.get(p).length}）查看空位`,
      callback_data: `viewplace_${platform}|${p}`
    }])
    if (restButtons.length > 0) {
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
// 手动单平台扫描
// ========================
// 只扫描指定平台并推送到该平台对应的 bot，不更新全局 diff 状态（lastSet/currentData），
// 避免手动 /run 干扰定时扫描的去重与减少通知。
async function runPlatformOnce(platformName) {
  const platformConfig = config.getPlatform(platformName)
  if (platformConfig.enabled === false) return
  const adapter = loadPlatform(platformName)
  if (!adapter) return
  if (!platformConfig.TARGET_PLACE?.length) return

  try {
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
  }
}

// ========================
// 扫描
// ========================
async function monitor(options = {}) {
  const { forcePush = false } = options
  const trace = createTrace()

  if (autoBooking) {
    console.log(`[${trace}] SKIP 正在自动预约，跳过`)
    return
  }

  // 扫描所有平台
  let allSlots = []
  let slotMap = new Map()

  for (const platformName of config.getPlatformNames()) {
    const platformConfig = config.getPlatform(platformName)
    if (platformConfig.enabled === false) continue
    const adapter = loadPlatform(platformName)
    if (!adapter) continue
    if (!platformConfig.TARGET_PLACE?.length) continue

    try {
      const slots = await adapter.fetchSlots(platformConfig)
      console.log(`[${trace}] ${platformName} 获取 ${slots.length} 个空位`)

      const enriched = slots.map(s => {
        const time = s.time || `${s.start}-${s.end}`
        const dateDisplay = s.dateDisplay || formatDateDisplayFromIso(s.date)
        const ucode = core.buildUcode({ ...s, time, dateDisplay }, platformConfig)
        const uid = `${s.place}_${s.court}_${s.date}_${time}`
        const enrichedSlot = { ...s, time, dateDisplay, ucode, uid }
        slotMap.set(ucode, enrichedSlot)
        return enrichedSlot
      })

      const filtered = core.filterSlotsByConfig(enriched, platformConfig)
      allSlots = allSlots.concat(filtered)
    } catch (e) {
      console.log(`[${trace}] ${platformName} 扫描失败:`, e.message)
    }
  }

  currentData = allSlots
  currentVersion = Date.now()
  currentSlotMap = slotMap

  console.log(`[${trace}] FILTER 过滤后: ${allSlots.length}条`)

  const currentUids = new Set(allSlots.map(d => d.uid))

  if (isFirstRun) {
    isFirstRun = false
    console.log(`[${trace}] 首次运行`)

    if (config.global.PUSH_ON_INIT !== false) {
      if (allSlots.length > 0) {
        await sendTelegram(allSlots, currentVersion)
      } else {
        await sendNoSlotsMessage()
      }
    }

    lastSet = currentUids
    saveLastSet()
    return
  }

  const added = allSlots.filter(d => !lastSet.has(d.uid))
  const removedUids = [...lastSet].filter(k => !currentUids.has(k))
  const removed = removedUids.map(k => {
    const [place, court, date, time] = k.split('_')
    return { platform: getPlatformNameByPlace(place) || undefined, place, court, date, time, uid: k }
  })

  core.recordStats('added', added)
  core.recordStats('removed', removed)
  console.log(`[${trace}] DIFF 新增:${added.length} 减少:${removed.length}`)

  if (added.length === 0 && removed.length === 0) {
    if (forcePush) {
      console.log(`[${trace}] FORCE_PUSH 强制推送 ${allSlots.length}`)
      if (allSlots.length > 0) {
        await sendTelegram(allSlots, currentVersion)
      } else {
        await sendNoSlotsMessage()
      }
    } else {
      console.log(`[${trace}] 无变化`)
    }
    return
  }

  lastSet = currentUids
  saveLastSet()

  if (added.length > 0) {
    if (config.global.NOTIFY_ADDED !== false) {
      console.log(`[${trace}] PUSH 发送新增通知 ${added.length}`)
      await sendTelegram(added, currentVersion, '✨ 有新场地！点击直接预约')
    }

    // Auto booking
    if (config.global.AUTO_BOOK && !autoBooking) {
      const platformGroups = {}
      for (const d of added) {
        if (!platformGroups[d.platform]) platformGroups[d.platform] = []
        platformGroups[d.platform].push(d)
      }

      for (const [platformName, platformAdded] of Object.entries(platformGroups)) {
        const platformConfig = config.getPlatform(platformName)
        // 平台级 AUTO_BOOK 可关闭（即使全局开启）
        if ('AUTO_BOOK' in platformConfig && !platformConfig.AUTO_BOOK) {
          console.log(`[${trace}] AUTO_BOOK ${platformName} 已关闭`)
          continue
        }
        const autoCandidates = core.filterSlotsAuto(platformAdded, platformConfig)
        if (autoCandidates.length === 0) {
          console.log(`[${trace}] AUTO_BOOK ${platformName} 无匹配项`)
          continue
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
          console.log(`[${trace}] AUTO_BOOK ${platformName} 筛选后无候选`)
          continue
        }

        const targets = core.autoPickTargets(validCandidates, autoBookedUIDs, autoBookedDayKeys)
        if (targets.length === 0) continue

        console.log(
          `[${trace}] AUTO_BOOK 准备预约 ${targets.length} 个：`,
          targets.map(d => `${d.place} ${d.time}`).join(' | ')
        )

        autoBooking = true
        try {
          for (const target of targets) {
            const result = await callBookingService(target, target.platform)
            if (result.success) {
              const dayKey = parseSlotDayKey(target)
              if (dayKey) autoBookedDayKeys.add(dayKey)
              autoBookedUIDs.add(target.uid)
              saveAutoBooked()
            }
          }

          const abBot = getBotForPlatform(platformName)
          const abChat = getPlatformChatId(platformName)
          if (!abBot || !abChat) {
            console.log(`[AUTO_BOOK] ${platformName} 未配置 Bot Token，跳过通知`)
          } else {
            await abBot.sendMessage(
              abChat,
              `🎉 *自动预约成功！*\n━━━━━━━━━━━━━━\n` +
              targets.map(d => formatSlotText(d, getPlatformConfig(d.place), { showBike: true, style: 'detail' })).join('\n\n'),
              { parse_mode: 'Markdown' }
            )
          }

          setTimeout(() => monitor({ forcePush: true }), 1000)
        } catch (e) {
          for (const d of targets) {
            autoBookedUIDs.add(d.uid)
          }
          saveAutoBooked()
          const abBot = getBotForPlatform(platformName)
          const abChat = getPlatformChatId(platformName)
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
          autoBooking = false
        }
      }
    }
  }

  if (removed.length > 0 && config.global.NOTIFY_REMOVED !== false) {
    console.log(`[${trace}] PUSH 发送减少通知 ${removed.length}`)
    await sendRemovedTelegram(removed)
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
      return json(res, {
        running: !!timer,
        scanning: false,
        autoBooking,
        slotCount: currentData.length,
        version: currentVersion,
        interval: getEffectiveInterval(),
        jitterMax: getEffectiveJitter(),
        config: {
          global: config.global,
          platforms: config.getAllPlatforms()
        }
      })
    }

    // POST /api/run   body: { platforms?: string[] }
    if (req.method === 'POST' && pathname === '/api/run') {
      const body = await parseBody(req).catch(() => null)
      const platforms = Array.isArray(body?.platforms) ? body.platforms : null
      if (platforms && platforms.length > 0) {
        ;(async () => {
          for (const p of platforms) await runPlatformOnce(p)
        })().catch(e => console.error('[/api/run] error:', e))
      } else {
        monitor({ forcePush: true }).catch(e => console.error('[/api/run] error:', e))
      }
      return json(res, { success: true, message: '扫描已触发' })
    }

    // POST /api/pause
    if (req.method === 'POST' && pathname === '/api/pause') {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      return json(res, { success: true, message: '已暂停' })
    }

    // POST /api/resume
    if (req.method === 'POST' && pathname === '/api/resume') {
      if (!timer) {
        scheduleNext()
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

    // GET /api/place/:platform/:place — 某场地当前空位（多场地推送的"查看空位"按钮）
    if (req.method === 'GET' && pathname.startsWith('/api/place/')) {
      const parts = decodeURIComponent(pathname.replace('/api/place/', '')).split('/')
      const platform = parts[0]
      const place = parts.slice(1).join('/')
      const slots = sortSlots((currentData || []).filter(s => s.platform === platform && s.place === place))
      return json(res, { success: true, slots })
    }

    // GET /api/slot/:ucode
    if (req.method === 'GET' && pathname.startsWith('/api/slot/')) {
      const ucode = decodeURIComponent(pathname.replace('/api/slot/', ''))
      const slot = currentSlotMap.get(ucode)
      if (!slot) {
        return json(res, { success: false, message: 'slot 已过期' }, 404)
      }
      return json(res, { success: true, slot })
    }

    // GET /api/schedule-status
    if (req.method === 'GET' && pathname === '/api/schedule-status') {
      return json(res, {
        running: !!timer,
        interval: getEffectiveInterval(),
        isFirstRun,
        autoBooking,
        lastScanVersion: currentVersion
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

  // 首次扫描
  await monitor()

  // 定时扫描（含随机抖动）
  scheduleNext()

  // 清理旧日志
  setInterval(() => cleanOldLogs(30), 24 * 60 * 60 * 1000)
}

start().catch(e => console.error('启动失败:', e))
