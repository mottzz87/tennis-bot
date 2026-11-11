/**
 * Booking Service
 *
 * 独立 HTTP 预约服务
 * - 最多 BOOKING_MAX_CONCURRENT 个预约并行（默认 3），同一时段去重，网络类失败重试
 * - 通过 platform adapter 执行实际预约
 * - 预约成功后记录到 storage
 * - 提供预约数据查询 API
 *
 * API:
 *   POST /api/book            { platform, slot }       单时段（常规路径）
 *   POST /api/book            { platform, slots }      批量（放号窗口：单会话顺序抢）
 *   POST /api/book/prepare    { platform }             放号窗口预热：先登录+常驻 Home（单会话）
 *   GET  /api/booked           -> 全部预约记录
 *   GET  /api/booked/schedule  -> 未开始预约（按时间排序）
 *   POST /api/booked/disable-reminder  { uid }
 *   DELETE /api/booked/:uid
 *   GET  /status               -> { busy, activeCount, currentTasks, parkedCount, parkedSession, batchRunning }
 */
require('@tennis-bot/config/loadEnv')()
const http = require('http')
const { loadPlatform } = require('@tennis-bot/platform')
const FileStorage = require('@tennis-bot/storage/file/FileStorage')
const { parseSlotDayKey, parseSlotStartDateTimeSafe, slotToken, isReleaseWindow } = require('@tennis-bot/utils')
const ConfigManager = require('@tennis-bot/config')
const path = require('path')

const DATA_DIR = process.env.BOOKING_DATA_DIR || path.resolve(__dirname, '../../data')
const PORT = process.env.BOOKING_PORT || 4000
const MONITOR_HOST = process.env.MONITOR_HOST || ''

const storage = new FileStorage(DATA_DIR)
const config = new ConfigManager(DATA_DIR)

// uid 参数可能是完整 ucode/uid，也可能是 slotToken（按钮 callback_data 有 64 字节限制）
function matchBooked(s, id) {
  return s.uid === id || s.ucode === id || slotToken(s.ucode || s.uid) === id
}

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

let activeCount = 0
const activeTasks = new Map() // key -> { platform, slot, startedAt }
const MAX_CONCURRENT = Number(process.env.BOOKING_MAX_CONCURRENT) > 0 ? Number(process.env.BOOKING_MAX_CONCURRENT) : 3
const RETRYABLE_BOOKING_MESSAGE = /timeout|timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|net::ERR|navigation failed|50[0-9]/i

// 放号窗口预热会话（单会话：仅放号日 11:45 由 monitor 创建，抢场后或 30 分钟后销毁；
// 日常不保留登录会话，扫描仍走游客流程）
// 单点登录限制：同一账号只能有一个会话，多浏览器会互相顶掉，所以只常驻一个。
let parkedSession = null // { browser, context, page, homeUrl, deadlineMs, loginVerified, preparedAt, keepAliveTimer, expireTimer }
let preparing = false // 正在 prepare（防重复并发）
const PREPARED_TTL_MS = 30 * 60 * 1000 // 11:45 创建 → 约 12:15 过期
const PREPARED_KEEPALIVE_MS = 3 * 60 * 1000 // 每 3 分钟刷新一次 Home，保持会话新鲜
let batchRunning = false // 批量顺序抢进行中（防重复调用）

function parkSession(session) {
  const entry = { ...session }
  entry.keepAliveTimer = setInterval(() => {
    entry.page?.goto(entry.homeUrl, { waitUntil: 'domcontentloaded' })
      .then(() => console.log('[booking-service] 预热会话保活：刷新 Home'))
      .catch(e => console.log('[booking-service] 预热会话保活失败:', e.message))
  }, PREPARED_KEEPALIVE_MS)
  entry.expireTimer = setTimeout(() => {
    console.log('[booking-service] 预热会话过期，关闭')
    closeParkedSession()
  }, PREPARED_TTL_MS)
  parkedSession = entry
  console.log('[booking-service] 预热单会话已常驻 Home（保活 3 分钟，30 分钟后过期）')
}

// 取走预热会话（抢场时调用；取走后不再保活/过期，浏览器由抢场路径负责关闭）
function takeParkedSession() {
  const s = parkedSession
  if (!s) return null
  clearInterval(s.keepAliveTimer)
  clearTimeout(s.expireTimer)
  parkedSession = null
  return s
}

function closeParkedSession() {
  const s = takeParkedSession()
  if (s) s.browser?.close().catch(() => {})
}

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

// 放号窗口预热（ADDITIVE）：单会话先登录 + 常驻 Home。
// 幂等：已有预热会话时直接返回；正在 prepare 时返回 Duplicate。
// 仅放号日 11:45 由 monitor 调用一次；日常不调用。
async function handlePrepare(body) {
  const { platform: platformName } = body
  if (!platformName) {
    return { success: false, message: '缺少参数 platform' }
  }
  if (parkedSession) {
    return { success: true, message: '预热会话已存在', loginVerified: parkedSession.loginVerified ?? null, preparedAt: parkedSession.preparedAt }
  }
  if (preparing) {
    return { success: false, message: 'Duplicate' }
  }
  const adapter = loadPlatform(platformName)
  if (!adapter || typeof adapter.prepare !== 'function') {
    return { success: false, message: `平台 ${platformName} 不支持预热` }
  }
  const platformConfig = config.getMergedConfig(platformName)
  if (platformConfig.enabled === false) {
    return { success: false, message: `平台 ${platformName} 未启用` }
  }
  preparing = true
  try {
    const result = await adapter.prepare(platformConfig)
    if (!result.success) return result
    parkSession(result)
    return { success: true, message: '预热完成，单会话已常驻 Home', loginVerified: result.loginVerified ?? null, preparedAt: result.preparedAt }
  } catch (e) {
    return { success: false, message: e.message }
  } finally {
    preparing = false
  }
}

async function handleBook(body) {
  const { platform: platformName, slot } = body
  if (!platformName || !slot) {
    return { success: false, message: '缺少参数 platform 或 slot' }
  }
  const taskKey = slot.uid || slot.ucode || `${slot.place}_${slot.court}_${slot.date}_${slot.time}`
  if (activeTasks.has(taskKey)) {
    return { success: false, message: 'Duplicate' }
  }

  const adapter = loadPlatform(platformName)
  if (!adapter) {
    return { success: false, message: `平台 ${platformName} 未找到` }
  }

  if (activeCount >= MAX_CONCURRENT) {
    return { success: false, message: 'Busy' }
  }

  // 合并 global + 平台配置（平台优先），让 global 里的默认值（如 HUMAN_DELAY_MIN/MAX）对预约生效
  const platformConfig = config.getMergedConfig(platformName)
  if (platformConfig.enabled === false) {
    return { success: false, message: `平台 ${platformName} 未启用` }
  }

  // 放号窗口内临时改用 RELEASE_REMINDER 里的操作停顿（放号瞬间抢场用）；平台 adapter 在 book() 里读这几个值
  const rr = platformConfig.RELEASE_REMINDER
  if (isReleaseWindow(rr)) {
    if (rr.HUMAN_DELAY_MIN != null) platformConfig.HUMAN_DELAY_MIN = Number(rr.HUMAN_DELAY_MIN)
    if (rr.HUMAN_DELAY_MAX != null) platformConfig.HUMAN_DELAY_MAX = Number(rr.HUMAN_DELAY_MAX)
    if (rr.HUMAN_INPUT_EXTRA_MS != null) platformConfig.HUMAN_INPUT_EXTRA_MS = Number(rr.HUMAN_INPUT_EXTRA_MS)
    console.log(`[booking-service] 放号窗口内 ${platformName}，操作停顿临时改为 ${platformConfig.HUMAN_DELAY_MIN}/${platformConfig.HUMAN_DELAY_MAX}ms`)
  }

  activeCount += 1
  activeTasks.set(taskKey, { platform: platformName, slot, startedAt: Date.now() })

  try {
    let result
    // 网络类失败（超时/断连/5xx）重试最多 2 次（每次重试都是全新浏览器会话）；
    // 业务类失败（已被预约、未找到空闲时段等）立即返回，不重试。
    for (let attempt = 1; attempt <= 3; attempt++) {
      result = await adapter.book(slot, platformConfig)
      if (result.success) break
      if (attempt < 3 && RETRYABLE_BOOKING_MESSAGE.test(String(result.message || ''))) {
        console.log(`[booking-service] 预约重试 ${attempt}/2（${platformName} ${slot.place} ${slot.date} ${slot.time}）：${result.message}`)
        await new Promise(r => setTimeout(r, 1000))
        continue
      }
      break
    }

    if (result.success) {
      const bookedSlots = await storage.getBookedSlots()
      const ucode = slot.ucode || `${slot.place}_${slot.court}_${slot.date}_${slot.time}`
      const exists = bookedSlots.some(s => s.uid === slot.uid || s.ucode === ucode)
      if (!exists) {
        const fee = result.fee || null
        bookedSlots.push({
          uid: slot.uid || ucode,
          ucode,
          platform: platformName,
          place: slot.place,
          court: slot.court,
          courts: slot.courts || null,
          date: slot.date,
          time: slot.time,
          dateDisplay: slot.dateDisplay || '',
          reminderEnabled: true,
          facilityFee: fee?.facility ?? null,
          lightingFee: fee?.lighting ?? null,
          totalFee: fee?.total ?? null,
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
    activeCount -= 1
    activeTasks.delete(taskKey)
  }
}

// 放号窗口批量抢场（ADDITIVE）：monitor 一次发来全部锁定目标，单会话内按优先级
// 逐个抢（每批 1 个时段，一次申请只约一个；二合一申请全有全无，一个被抢整单作废）。仅在预热单会话存在时走本路径；
// 不存在时返回 noParkedSession，由 monitor 回退到常规并行路径。
// 不占并行池（单会话顺序抢）；同一时间只允许一个批量任务。
// 注意：批量调用可能耗时数分钟（逐批抢），HTTP 服务端超时已在 start() 里放宽。
async function handleBookBatch(body) {
  const { platform: platformName, slots } = body
  if (!platformName || !Array.isArray(slots) || slots.length === 0) {
    return { success: false, message: '缺少参数 platform 或 slots' }
  }
  if (batchRunning) {
    return { success: false, message: 'Duplicate' }
  }
  const adapter = loadPlatform(platformName)
  if (!adapter || typeof adapter.bookPrepared !== 'function') {
    return { success: false, message: `平台 ${platformName} 不支持批量预热抢场` }
  }
  const parked = takeParkedSession()
  if (!parked) {
    return { success: false, message: '预热会话不存在', noParkedSession: true }
  }
  const platformConfig = config.getMergedConfig(platformName)
  if (platformConfig.enabled === false) {
    await parked.browser?.close().catch(() => {})
    return { success: false, message: `平台 ${platformName} 未启用` }
  }

  // 放号窗口内临时改用 RELEASE_REMINDER 里的操作停顿（与单时段路径相同）
  const rr = platformConfig.RELEASE_REMINDER
  if (isReleaseWindow(rr)) {
    if (rr.HUMAN_DELAY_MIN != null) platformConfig.HUMAN_DELAY_MIN = Number(rr.HUMAN_DELAY_MIN)
    if (rr.HUMAN_DELAY_MAX != null) platformConfig.HUMAN_DELAY_MAX = Number(rr.HUMAN_DELAY_MAX)
    if (rr.HUMAN_INPUT_EXTRA_MS != null) platformConfig.HUMAN_INPUT_EXTRA_MS = Number(rr.HUMAN_INPUT_EXTRA_MS)
    console.log(`[booking-service] 放号窗口内 ${platformName}，操作停顿临时改为 ${platformConfig.HUMAN_DELAY_MIN}/${platformConfig.HUMAN_DELAY_MAX}ms`)
  }

  batchRunning = true
  try {
    const result = await adapter.bookPrepared(parked, slots, platformConfig)
    // 逐个记录成功的预约（与单时段路径相同的存储格式）
    const bookedSlots = await storage.getBookedSlots()
    let changed = false
    for (const r of result.results || []) {
      if (!r.success) continue
      const slot = r.slot
      const ucode = slot.ucode || `${slot.place}_${slot.court}_${slot.date}_${slot.time}`
      const exists = bookedSlots.some(s => s.uid === slot.uid || s.ucode === ucode)
      if (exists) continue
      const fee = r.fee || null
      bookedSlots.push({
        uid: slot.uid || ucode,
        ucode,
        platform: platformName,
        place: slot.place,
        court: slot.court,
        courts: slot.courts || null,
        date: slot.date,
        time: slot.time,
        dateDisplay: slot.dateDisplay || '',
        reminderEnabled: true,
        facilityFee: fee?.facility ?? null,
        lightingFee: fee?.lighting ?? null,
        totalFee: fee?.total ?? null,
        bookedAt: Date.now(),
        create: new Date().toLocaleString()
      })
      changed = true
    }
    if (changed) await storage.saveBookedSlots(bookedSlots)
    return result
  } catch (e) {
    return { success: false, message: e.message, results: slots.map(slot => ({ slot, success: false, message: e.message })) }
  } finally {
    batchRunning = false
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
      return json(res, {
        busy: activeCount > 0 || batchRunning, activeCount,
        currentTasks: [...activeTasks.values()].map(t => ({ platform: t.platform, place: t.slot?.place, date: t.slot?.date, time: t.slot?.time })),
        parkedCount: parkedSession ? 1 : 0,
        parkedSession: parkedSession ? { loginVerified: parkedSession.loginVerified ?? null, preparedAt: parkedSession.preparedAt } : null,
        batchRunning
      })
    }

    // POST /api/book
    if (req.method === 'POST' && pathname === '/api/book') {
      const body = await parseBody(req)
      // 批量调用（放号窗口：单会话顺序抢）：slots 数组；否则单时段常规路径
      if (Array.isArray(body.slots)) {
        const result = await handleBookBatch(body)
        const status = result.success ? 200 : (result.message === 'Duplicate' ? 409 : 500)
        return json(res, result, status)
      }
      const result = await handleBook(body)
      const status = result.success ? 200 : (result.message === 'Busy' || result.message === 'Duplicate' ? 409 : 500)
      return json(res, result, status)
    }

    // POST /api/book/prepare（放号窗口预热：先登录+常驻时间选择页）
    if (req.method === 'POST' && pathname === '/api/book/prepare') {
      const body = await parseBody(req)
      const result = await handlePrepare(body)
      const status = result.success ? 200 : (result.message === 'Duplicate' ? 409 : 500)
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
      let foundUcode = null
      const updated = slots.map(s => {
        if (matchBooked(s, uid)) {
          found = true
          foundUcode = s.ucode || s.uid
          return { ...s, reminderEnabled: false }
        }
        return s
      })
      if (!found) return json(res, { success: false, message: '未找到' }, 404)
      await storage.saveBookedSlots(updated)
      return json(res, { success: true, ucode: foundUcode })
    }

    // POST /api/booked/toggle-reminder
    if (req.method === 'POST' && pathname === '/api/booked/toggle-reminder') {
      const { uid } = await parseBody(req)
      if (!uid) return json(res, { success: false, message: '缺少 uid' }, 400)
      const slots = await storage.getBookedSlots()
      let found = false
      let newState = false
      const updated = slots.map(s => {
        if (matchBooked(s, uid)) {
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
      const filtered = slots.filter(s => !matchBooked(s, uid))
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
      const status = result.success ? 200 : (result.message === 'Busy' || result.message === 'Duplicate' ? 409 : 500)
      return json(res, result, status)
    }

    json(res, { success: false, message: 'Not found' }, 404)
  } catch (e) {
    json(res, { success: false, message: e.message }, 400)
  }
})

async function start() {
  await loadConfig()
  // 批量顺序抢一次调用可能耗时数分钟（逐批抢）：放宽 HTTP 服务端超时
  // （Node 默认 requestTimeout 300s，12:10 截止的整轮最长约 11 分钟）。
  server.requestTimeout = 15 * 60 * 1000
  server.headersTimeout = 120 * 1000
  server.listen(PORT, () => {
    console.log(`[booking-service] 启动于 http://localhost:${PORT}`)
  })
}

start().catch(e => {
  console.error('[booking-service] 启动失败:', e)
  process.exit(1)
})
