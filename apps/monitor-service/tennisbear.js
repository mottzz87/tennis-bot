// Tennis Bear 行程抓取（延迟自动抢的行程守卫用）
//
// - 邮箱登录端点 POST /api/v3/auth/login/email 已从官网前端包确认（2026-11-21）。
// - 登录响应的凭证形态（Set-Cookie / idToken 等字段）与行程列表接口的路径、
//   响应结构，需用真实账号在服务器上实测后定版：见 SCHEDULE_API_PATH 与
//   extractBearBlocks 的容错实现（先按常见字段名宽松提取，实测后收紧）。
// - 账号密码只从环境变量 TENNISBEAR_EMAIL / TENNISBEAR_PASSWORD 读（仓库根 .env）。
// - 任何失败都抛错：调用方按「查不到就不抢」处理（失败安全），不做静默放行。

const https = require('https')

const BASE_HOST = 'www.tennisbear.net'
const LOGIN_API_PATH = '/api/v3/auth/login/email'
// TODO(phase2): 用真实登录抓包确认「予定（主催・参加イベント一覧）」的接口后替换此路径
const SCHEDULE_API_PATH = '/api/v3/users/me/schedules'

const SESSION_TTL_MS = 30 * 60 * 1000
const DAY_CACHE_TTL_MS = 5 * 60 * 1000

let session = null // { headers: { Cookie?, Authorization? }, at }
const dayCache = new Map() // dayKey -> { at, blocks }

function requestJson(method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null
    const req = https.request({
      hostname: BASE_HOST,
      path,
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (tennis-bot monitor)',
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      },
      timeout: 15000
    }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(data) } catch { /* 非 JSON 响应按原文处理 */ }
        resolve({ status: res.statusCode, json, raw: data, headers: res.headers })
      })
    })
    req.on('timeout', () => req.destroy(new Error('Tennis Bear 请求超时（15s）')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function pickToken(json) {
  if (!json || typeof json !== 'object') return null
  const candidates = [json.idToken, json.token, json.accessToken, json.access_token, json.jwt,
    json.data?.idToken, json.data?.token, json.data?.accessToken, json.user?.idToken]
  for (const v of candidates) {
    if (typeof v === 'string' && v.length > 10) return v
  }
  return null
}

async function login(email, password) {
  const res = await requestJson('POST', LOGIN_API_PATH, { body: { email, password } })
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Tennis Bear 登录失败（HTTP ${res.status}）`)
  }
  const headers = {}
  const setCookie = res.headers['set-cookie']
  if (Array.isArray(setCookie) && setCookie.length > 0) {
    headers.Cookie = setCookie.map(c => String(c).split(';')[0]).join('; ')
  }
  const token = pickToken(res.json)
  if (token) headers.Authorization = `Bearer ${token}`
  if (!headers.Cookie && !headers.Authorization) {
    throw new Error('Tennis Bear 登录响应未包含可用凭证（cookie/token 均无）')
  }
  session = { headers, at: Date.now() }
  return session
}

async function getSession(email, password, force = false) {
  if (!force && session && Date.now() - session.at < SESSION_TTL_MS) return session
  return login(email, password)
}

// 从任意 JSON 结构中宽松提取某一天的活动时间块。
// 识别带日期+开始时间的事件对象；时间值兼容 ISO datetime、"HH:MM"、"H:MM"。
// 返回 [{ start, end, venue, title, source: 'bear' }]（start/end 为当日分钟数）。
function extractBearBlocks(json, dayKey) {
  const blocks = []
  const seen = new Set()

  const dateOf = (v) => {
    if (typeof v !== 'string') return null
    const m = v.match(/(\d{4})-(\d{2})-(\d{2})/)
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null
  }
  const minutesOf = (v) => {
    if (typeof v !== 'string') return null
    const dt = v.match(/[T ](\d{1,2}):(\d{2})/)
    if (dt) return Number(dt[1]) * 60 + Number(dt[2])
    const t = v.match(/^(\d{1,2}):(\d{2})/)
    return t ? Number(t[1]) * 60 + Number(t[2]) : null
  }
  const firstStr = (obj, keys) => {
    for (const k of keys) {
      if (typeof obj[k] === 'string' && obj[k]) return obj[k]
    }
    return null
  }

  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(visit); return }
    const dateStr = firstStr(node, ['date', 'eventDate', 'event_date', 'heldOn', 'held_on', 'day', 'startDate', 'start_date'])
    const startStr = firstStr(node, ['start', 'startAt', 'start_at', 'startTime', 'start_time', 'beginAt', 'begin_at', 'from'])
    const endStr = firstStr(node, ['end', 'endAt', 'end_at', 'endTime', 'end_time', 'finishAt', 'finish_at', 'to'])
    const eventDay = dateOf(dateStr) || dateOf(startStr)
    if (eventDay === dayKey && startStr) {
      const start = minutesOf(startStr)
      const end = minutesOf(endStr)
      if (start !== null && end !== null && end > start) {
        const key = `${start}-${end}`
        if (!seen.has(key)) {
          seen.add(key)
          blocks.push({
            start,
            end,
            venue: firstStr(node, ['venue', 'place', 'location', 'court', 'facility', 'placeName']) || '',
            title: firstStr(node, ['title', 'name', 'eventName']) || '',
            source: 'bear'
          })
        }
      }
    }
    Object.values(node).forEach(visit)
  }
  visit(json)
  return blocks.sort((a, b) => a.start - b.start)
}

async function fetchScheduleJson(email, password) {
  let s = await getSession(email, password)
  let res = await requestJson('GET', SCHEDULE_API_PATH, { headers: s.headers })
  if (res.status === 401 || res.status === 403) {
    s = await getSession(email, password, true)
    res = await requestJson('GET', SCHEDULE_API_PATH, { headers: s.headers })
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Tennis Bear 行程接口失败（HTTP ${res.status}）`)
  }
  if (!res.json) throw new Error('Tennis Bear 行程接口返回非 JSON')
  return res.json
}

// 取某一天（YYYY-MM-DD）的 Tennis Bear 行程时间块；5 分钟缓存，避免同一轮多次登录/请求。
async function fetchBearDayBlocks(dayKey) {
  const email = process.env.TENNISBEAR_EMAIL
  const password = process.env.TENNISBEAR_PASSWORD
  if (!email || !password) throw new Error('未配置 TENNISBEAR_EMAIL / TENNISBEAR_PASSWORD')
  const cached = dayCache.get(dayKey)
  if (cached && Date.now() - cached.at < DAY_CACHE_TTL_MS) return cached.blocks
  const json = await fetchScheduleJson(email, password)
  const blocks = extractBearBlocks(json, dayKey)
  dayCache.set(dayKey, { at: Date.now(), blocks })
  return blocks
}

module.exports = { fetchBearDayBlocks, extractBearBlocks }
