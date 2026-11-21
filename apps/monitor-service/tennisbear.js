// Tennis Bear 行程抓取（延迟自动抢的行程守卫用）
//
// 用的是公开个人页背后的只读接口（用户 2026-11-21 提供个人页并指出免登录）：
//   GET /api/v3/users/<id>/detail-page/organized-events/future    （主催）
//   GET /api/v3/users/<id>/detail-page/participated-events/future （参加）
// 无需任何账号密码；用户 ID 默认 861665，可用环境变量 TENNISBEAR_USER_ID 覆盖。
// 注意：列表可见性取决于用户在 Tennis Bear 的公开范围设置；若他日后把行程
// 设为非公开，这里会拿到空列表（守卫便只剩 bot 预约记录一个来源）。
//
// 事件字段（2026-11-21 实测）：
//   startDatetimeString: "2026-11-30T19:00:00.000+09:00"（开始时刻，JST）
//   datetimeForDisplay:  "11/30(月) 19:00-21:00"（含结束时间）
//   place.name:          场地名；eventTitle: 标题；callOff: true 表示已中止（排除）
// 任何失败（网络/非 2xx/结构异常/时间解析失败）都抛错：
// 调用方按「查不到就不抢」处理（失败安全），不做静默放行。

const https = require('https')

const BASE_HOST = 'www.tennisbear.net'
const DEFAULT_USER_ID = '861665'
const CACHE_TTL_MS = 5 * 60 * 1000

let cache = null // { at, events }

function requestJson(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: BASE_HOST,
      path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (tennis-bot monitor)',
        Accept: 'application/json'
      },
      timeout: 15000
    }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Tennis Bear 接口失败（HTTP ${res.statusCode}）: ${path}`))
        }
        try { resolve(JSON.parse(data)) } catch { reject(new Error(`Tennis Bear 接口返回非 JSON: ${path}`)) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('Tennis Bear 请求超时（15s）')))
    req.on('error', reject)
    req.end()
  })
}

// 把一个事件对象转成时间块；字段不全/时间对不上时抛错（失败安全）。
function eventToBlock(ev) {
  const startStr = typeof ev?.startDatetimeString === 'string' ? ev.startDatetimeString : ''
  const m = startStr.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2})/)
  if (!m) throw new Error('Tennis Bear 事件缺少可解析的 startDatetimeString')
  const dayKey = `${m[1]}-${m[2]}-${m[3]}`
  const start = Number(m[4]) * 60 + Number(m[5])
  const disp = typeof ev.datetimeForDisplay === 'string' ? ev.datetimeForDisplay : ''
  const r = disp.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/)
  if (!r) throw new Error('Tennis Bear 事件缺少可解析的 datetimeForDisplay')
  const dispStart = Number(r[1]) * 60 + Number(r[2])
  const end = Number(r[3]) * 60 + Number(r[4])
  if (dispStart !== start || end <= start) throw new Error('Tennis Bear 事件时间不一致')
  return {
    dayKey,
    start,
    end,
    venue: typeof ev.place?.name === 'string' ? ev.place.name : '',
    title: typeof ev.eventTitle === 'string' ? ev.eventTitle : '',
    source: 'bear'
  }
}

// 从主催+参加两个未来列表中提取某一天的时间块（已中止的活动排除）。
function extractBearBlocks(events, dayKey) {
  if (!Array.isArray(events)) throw new Error('Tennis Bear 列表结构异常（非数组）')
  const blocks = []
  const seen = new Set()
  for (const ev of events) {
    if (!ev || ev.callOff === true) continue
    const b = eventToBlock(ev)
    if (b.dayKey !== dayKey) continue
    const key = `${b.start}-${b.end}`
    if (seen.has(key)) continue
    seen.add(key)
    blocks.push({ start: b.start, end: b.end, venue: b.venue, title: b.title, source: 'bear' })
  }
  return blocks.sort((a, b) => a.start - b.start)
}

async function fetchAllEvents() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.events
  const userId = process.env.TENNISBEAR_USER_ID || DEFAULT_USER_ID
  const [organized, participated] = await Promise.all([
    requestJson(`/api/v3/users/${userId}/detail-page/organized-events/future`),
    requestJson(`/api/v3/users/${userId}/detail-page/participated-events/future`)
  ])
  if (!Array.isArray(organized) || !Array.isArray(participated)) {
    throw new Error('Tennis Bear 列表结构异常（非数组）')
  }
  const events = [...organized, ...participated]
  cache = { at: Date.now(), events }
  return events
}

// 取某一天（YYYY-MM-DD）的 Tennis Bear 行程时间块；全量列表 5 分钟缓存。
async function fetchBearDayBlocks(dayKey) {
  const events = await fetchAllEvents()
  return extractBearBlocks(events, dayKey)
}

module.exports = { fetchBearDayBlocks, extractBearBlocks }
