/**
 * Booking Service
 *
 * 独立 HTTP 预约服务
 * - 同一时间只处理一个预约
 * - 通过 platform adapter 执行实际预约
 * - 预约成功后记录到 storage
 * - 提供预约数据查询 API
 *
 * API:
 *   POST /api/book            { platform, slot }
 *   GET  /api/booked           -> 全部预约记录
 *   GET  /api/booked/schedule  -> 未开始预约（按时间排序）
 *   POST /api/booked/disable-reminder  { uid }
 *   DELETE /api/booked/:uid
 *   GET  /status               -> { busy, currentTask }
 */
require('@tennis-bot/config/loadEnv')()
const http = require('http')
const { loadPlatform } = require('@tennis-bot/platform')
const FileStorage = require('@tennis-bot/storage/file/FileStorage')
const { parseSlotDayKey, parseSlotStartDateTimeSafe } = require('@tennis-bot/utils')
const ConfigManager = require('@tennis-bot/config')
const path = require('path')

const DATA_DIR = process.env.BOOKING_DATA_DIR || path.resolve(__dirname, '../../data')
const PORT = process.env.BOOKING_PORT || 4000
const MONITOR_HOST = process.env.MONITOR_HOST || ''

const storage = new FileStorage(DATA_DIR)
const config = new ConfigManager(DATA_DIR)

// 配置加载：跨服模式从 Monitor API 获取，本地模式从文件加载
async function loadConfig() {
  if (MONITOR_HOST) {
    console.log(`[booking-service] 跨服模式，从 Monitor 拉取配置: ${MONITOR_HOST}`)
    try {
      const data = await fetchConfigFromMonitor()
      config.loadFromData(data)
      console.log(`[booking-service] 配置加载完成，平台: ${Object.keys(config.getAllPlatforms()).join(', ')}`)
    } catch (e) {
      console.error(`[booking-service] 从 Monitor 拉取配置失败，回退本地文件:`, e.message)
      config.load()
    }
  } else {
    console.log('[booking-service] 本地模式，从文件加载配置')
    config.load()
  }
}

function fetchConfigFromMonitor() {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/status', MONITOR_HOST)
    const req = http.get(url.href, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          resolve(parsed.config)
        } catch { reject(new Error('解析失败')) }
      })
    })
    req.on('error', reject)
  })
}

let busy = false
let currentTask = null

// ========================
// Helpers
// ========================
function getFutureSlots(slots) {
  const now = Date.now()
  return slots.filter(s => {
    const start = parseSlotStartDateTimeSafe(s)
    return start && start.getTime() > now
  })
}

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

async function handleBook(body) {
  if (busy) {
    return { success: false, message: 'Busy' }
  }

  const { platform: platformName, slot } = body
  if (!platformName || !slot) {
    return { success: false, message: '缺少参数 platform 或 slot' }
  }

  const adapter = loadPlatform(platformName)
  if (!adapter) {
    return { success: false, message: `平台 ${platformName} 未找到` }
  }

  const platformConfig = config.getPlatform(platformName)
  if (platformConfig.enabled === false) {
    return { success: false, message: `平台 ${platformName} 未启用` }
  }

  busy = true
  currentTask = { platform: platformName, slot }

  try {
    const result = await adapter.book(slot, platformConfig)

    if (result.success) {
      const bookedSlots = await storage.getBookedSlots()
      const ucode = slot.ucode || `${slot.place}_${slot.court}_${slot.date}_${slot.time}`
      const exists = bookedSlots.some(s => s.uid === slot.uid || s.ucode === ucode)
      if (!exists) {
        bookedSlots.push({
          uid: slot.uid || ucode,
          ucode,
          platform: platformName,
          place: slot.place,
          court: slot.court,
          date: slot.date,
          time: slot.time,
          dateDisplay: slot.dateDisplay || '',
          reminderEnabled: true,
          bookedAt: Date.now(),
          create: new Date().toLocaleString()
        })
        await storage.saveBookedSlots(bookedSlots)
      }
    }

    return result
  } catch (e) {
    return { success: false, message: e.message }
  } finally {
    busy = false
    currentTask = null
  }
}

// ========================
// Router
// ========================
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json')

  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const pathname = url.pathname

    // GET /status
    if (req.method === 'GET' && pathname === '/status') {
      return json(res, { busy, currentTask })
    }

    // POST /api/book
    if (req.method === 'POST' && pathname === '/api/book') {
      const body = await parseBody(req)
      const result = await handleBook(body)
      const status = result.success ? 200 : (result.message === 'Busy' ? 409 : 500)
      return json(res, result, status)
    }

    // GET /api/booked
    if (req.method === 'GET' && pathname === '/api/booked') {
      const slots = await storage.getBookedSlots()
      return json(res, { slots })
    }

    // GET /api/booked/schedule
    if (req.method === 'GET' && pathname === '/api/booked/schedule') {
      const all = await storage.getBookedSlots()
      const future = getFutureSlots(all).sort((a, b) => {
        const ta = parseSlotStartDateTimeSafe(a)?.getTime() ?? Infinity
        const tb = parseSlotStartDateTimeSafe(b)?.getTime() ?? Infinity
        return ta - tb
      })
      return json(res, { slots: future })
    }

    // POST /api/booked/disable-reminder
    if (req.method === 'POST' && pathname === '/api/booked/disable-reminder') {
      const { uid } = await parseBody(req)
      if (!uid) return json(res, { success: false, message: '缺少 uid' }, 400)
      const slots = await storage.getBookedSlots()
      let found = false
      const updated = slots.map(s => {
        if (s.uid === uid || s.ucode === uid) {
          found = true
          return { ...s, reminderEnabled: false }
        }
        return s
      })
      if (!found) return json(res, { success: false, message: '未找到' }, 404)
      await storage.saveBookedSlots(updated)
      return json(res, { success: true })
    }

    // POST /api/booked/toggle-reminder
    if (req.method === 'POST' && pathname === '/api/booked/toggle-reminder') {
      const { uid } = await parseBody(req)
      if (!uid) return json(res, { success: false, message: '缺少 uid' }, 400)
      const slots = await storage.getBookedSlots()
      let found = false
      let newState = false
      const updated = slots.map(s => {
        if (s.uid === uid || s.ucode === uid) {
          found = true
          newState = s.reminderEnabled === false
          return { ...s, reminderEnabled: newState }
        }
        return s
      })
      if (!found) return json(res, { success: false, message: '未找到' }, 404)
      await storage.saveBookedSlots(updated)
      return json(res, { success: true, reminderEnabled: newState })
    }

    // DELETE /api/booked/:uid
    if (req.method === 'DELETE' && pathname.startsWith('/api/booked/')) {
      const uid = decodeURIComponent(pathname.replace('/api/booked/', ''))
      if (!uid) return json(res, { success: false, message: '缺少 uid' }, 400)
      const slots = await storage.getBookedSlots()
      const filtered = slots.filter(s => s.uid !== uid && s.ucode !== uid)
      if (filtered.length === slots.length) {
        return json(res, { success: false, message: '未找到' }, 404)
      }
      await storage.saveBookedSlots(filtered)
      return json(res, { success: true })
    }

    // 向后兼容旧路径 /book
    if (req.method === 'POST' && pathname === '/book') {
      const body = await parseBody(req)
      const result = await handleBook(body)
      const status = result.success ? 200 : (result.message === 'Busy' ? 409 : 500)
      return json(res, result, status)
    }

    json(res, { success: false, message: 'Not found' }, 404)
  } catch (e) {
    json(res, { success: false, message: e.message }, 400)
  }
})

async function start() {
  await loadConfig()
  server.listen(PORT, () => {
    console.log(`[booking-service] 启动于 http://localhost:${PORT}`)
  })
}

start().catch(e => {
  console.error('[booking-service] 启动失败:', e)
  process.exit(1)
})
