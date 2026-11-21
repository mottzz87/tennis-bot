const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const holidayJp = require('@holiday-jp/holiday_jp')

// ucode 可能超过 64 字节（含 CJK 场地名），不能直接塞进 Telegram callback_data（上限 64 字节）。
// 用固定长度 token 代替，服务端再按 token 反查原 ucode。
function slotToken(id) {
  return crypto.createHash('sha1').update(String(id || '')).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 12)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

// 模拟人输入：逐字敲入，每个字符带随机停顿，避免瞬间填满表单
async function humanType(locator, text, { minDelay = 40, maxDelay = 140 } = {}) {
  const s = String(text)
  if (!s) return
  await locator.click()
  // 先全选已有内容（登录页/预约表单一般为空，此步无副作用），防止默认值残留
  await locator.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  for (const ch of s) {
    await locator.pressSequentially(ch, { delay: randomInt(minDelay, maxDelay) })
  }
}

// 模拟人在两个操作之间的思考/移动停顿，区间由配置 HUMAN_DELAY_MIN / HUMAN_DELAY_MAX 控制
// HUMAN_INPUT_EXTRA_MS 是在输入框操作（逐字敲入）之后额外叠加的停顿，让输入场景更接近人手手感；登录页不叠加
let humanPauseMin = 300
let humanPauseMax = 900
let humanInputExtra = 300

function setHumanPauseRange(min, max, inputExtra) {
  const m = Number(min)
  const M = Number(max)
  if (Number.isFinite(m) && Number.isFinite(M) && m >= 0 && M >= m) {
    humanPauseMin = m
    humanPauseMax = M
  } else {
    humanPauseMin = 300
    humanPauseMax = 900
  }
  const e = Number(inputExtra)
  humanInputExtra = Number.isFinite(e) && e >= 0 ? e : 0
}

async function humanPause() {
  await sleep(randomInt(humanPauseMin, humanPauseMax))
}

// 输入框操作后的停顿：在基础区间上整体加 HUMAN_INPUT_EXTRA_MS
async function humanPauseAfterInput() {
  await sleep(randomInt(humanPauseMin + humanInputExtra, humanPauseMax + humanInputExtra))
}

function normalizeText(str) {
  if (!str) return ''
  return String(str)
    .toLowerCase()
    .replace(/　/g, ' ')
    .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, ' ')
    .trim()
}

function formatCourt(court) {
  if (!court) return ''
  court = court.replace(/　/g, ' ')
  court = court.replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
  const match = court.match(/第\s*(\d+)\s*コート/)
  if (!match) return court
  return `c${match[1]}`
}

// 短场地名："西葛西テニスＧ面" → "Ｇ面"；"Ａ面" → "Ａ面"；"第2コート" → "c2"
function formatCourtShort(court) {
  if (!court) return ''
  const s = String(court).replace(/　/g, ' ').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  const m = s.match(/([Ａ-Ｚ]|[A-Z])面/)
  if (m) return m[0]
  return formatCourt(s)
}

function normalizeCourtAlias(str) {
  const s = normalizeText(str)
  let match = s.match(/(\d+)/)
  if (match) return `c${match[1]}`
  match = s.match(/([a-z])\s*(コート|court)/i)
  if (match) return `c${match[1].toLowerCase()}`
  return s
}

function parseSlotDayKey(d) {
  const dateStr = String(d.date).trim()
  const iso = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const m = dateStr.match(/(\d+)年(\d+)月(\d+)日/)
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]), day = Number(m[3])
  if (!y || !mo || !day) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseTimeSafe(timeStr) {
  if (!timeStr) return [0, 0]
  timeStr = timeStr.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  timeStr = timeStr.replace(/：/g, ':').replace(/～/g, '~')
  const start = timeStr.split(/[~\-]/)[0].trim()
  const [hStr = '0', mStr = '0'] = start.includes(':') ? start.split(':') : [start, '0']
  const h = Number(hStr), m = Number(mStr)
  if (Number.isNaN(h) || Number.isNaN(m)) return [0, 0]
  return [h, m]
}

function parseSlotStartDateTimeSafe(d) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(d.date).trim())) {
    const [h, m] = parseTimeSafe(String(d.time))
    return new Date(`${d.date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`)
  }
  const dayKey = parseSlotDayKey(d)
  if (!dayKey) return null
  const [hour, minute] = parseTimeSafe(String(d.time))
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null
  const [yStr, moStr, dayStr] = dayKey.split('-')
  return new Date(Number(yStr), Number(moStr) - 1, Number(dayStr), hour, minute, 0, 0)
}

function normalizeTimeRange(timeStr) {
  const raw = String(timeStr || '')
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/：/g, ':')
    .replace(/～/g, '~')
    .trim()
  if (/^\d{1,2}-\d{1,2}$/.test(raw)) return raw
  const [startRaw = '0', endRaw = '0'] = raw.split(/[~\-]/)
  const toHour = (s) => {
    const v = String(s || '').trim()
    if (!v) return '0'
    const h = Number(v.includes(':') ? v.split(':')[0] : v)
    return Number.isNaN(h) ? '0' : String(h)
  }
  return `${toHour(startRaw)}-${toHour(endRaw)}`
}

const WEEKDAY_JP = ['日', '月', '火', '水', '木', '金', '土']

// 日本法定祝日（含振替休日/国民の休日）。数据表随包本地打包，不发起网络请求。
function isJapaneseHoliday(iso) {
  const s = String(iso || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, mo, d] = s.split('-').map(Number)
  return !!holidayJp.isHoliday(new Date(y, mo - 1, d))
}

// 是否周末（土/日）或日本祝日：星期取自 dateDisplay 或 ISO 日期，祝日以 ISO 日期查表为准
// （dateDisplay 可能是不带「祝」的旧数据，所以「祝」标记只作为补充，不能只看它）
function isWeekendOrHoliday(d) {
  const display = String(d?.dateDisplay || '')
  const s = String(d?.date || '').trim()
  const isoOk = /^\d{4}-\d{2}-\d{2}$/.test(s)
  const m = display.match(/[（(]([月火水木金土日])(祝?)[）)]/)
  let weekday = m ? m[1] : null
  if (!weekday && isoOk) {
    const [y, mo, day] = s.split('-').map(Number)
    weekday = WEEKDAY_JP[new Date(y, mo - 1, day).getDay()]
  }
  if (weekday === '土' || weekday === '日') return true
  if (m && m[2] === '祝') return true
  return isoOk ? isJapaneseHoliday(s) : false
}

// 祝日在星期后加「祝」标记（如 "9.22（火祝）"），供排序与展示识别
function formatDateDisplayFromIso(iso) {
  const s = String(iso || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return ''
  const [y, mo, d] = s.split('-').map(Number)
  const dt = new Date(y, mo - 1, d)
  const mark = holidayJp.isHoliday(dt) ? '祝' : ''
  return `${mo}.${String(d).padStart(2, '0')}（${WEEKDAY_JP[dt.getDay()]}${mark}）`
}

// JST 墙上时间拆分（服务器无时区设置，统一手动 +9h 后用 UTC 取值）
function jstParts(now = Date.now()) {
  const d = new Date(now + 9 * 3600 * 1000)
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes()
  }
}

function jstDateKey(now = Date.now()) {
  const p = jstParts(now)
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
}

function parseHHMM(str) {
  const m = String(str || '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return [h, mi]
}

// 平台配置 RELEASE_REMINDER → { day, remindMin, windowMin, openAt }；未配置或格式错误返回 null（= 不提醒）
function normalizeReleaseReminder(cfg) {
  if (!cfg || typeof cfg !== 'object') return null
  const day = Number(cfg.DAY)
  const remind = parseHHMM(cfg.REMIND_AT)
  if (!Number.isInteger(day) || day < 1 || day > 31 || !remind) return null
  const windowMin = Number(cfg.WINDOW_MINUTES)
  return {
    day,
    remindMin: remind[0] * 60 + remind[1],
    windowMin: Number.isFinite(windowMin) && windowMin > 0 ? windowMin : 40,
    openAt: String(cfg.OPEN_AT || '')
  }
}

// 是否处于放号窗口：JST 当月 DAY 日，[REMIND_AT, REMIND_AT + WINDOW_MINUTES)
function isReleaseWindow(cfg, now = Date.now()) {
  const r = normalizeReleaseReminder(cfg)
  if (!r) return false
  const p = jstParts(now)
  if (p.d !== r.day) return false
  const cur = p.h * 60 + p.mi
  return cur >= r.remindMin && cur < r.remindMin + r.windowMin
}

// 是否正好到放号提醒时刻（同一分钟）
function matchReleaseReminderMoment(cfg, now = Date.now()) {
  const r = normalizeReleaseReminder(cfg)
  if (!r) return false
  const p = jstParts(now)
  if (p.d !== r.day) return false
  return p.h * 60 + p.mi === r.remindMin
}

function formatTimeDisplay(time) {
  const raw = String(time || '').trim()
  const parts = raw.split(/[~\-]/)
  if (parts.length === 2) {
    // 整点去掉 :00，非整点保留分钟（如 12:00-14:00 → 12-14，12:30-14:00 → 12:30-14）
    const fmt = p => {
      const m = String(p).trim().match(/^(\d{1,2})(?::(\d{2}))?$/)
      if (!m) return String(p).trim()
      const h = String(m[1]).padStart(2, '0')
      const mm = m[2]
      return mm === '00' || mm == null ? h : `${h}:${mm}`
    }
    return `${fmt(parts[0])}-${fmt(parts[1])}`
  }
  return raw.replace('~', '–')
}

function toMinutes(timeStr) {
  const t = String(timeStr).trim()
  if (t.includes(':')) {
    const [hour = 0, minute = 0] = t.split(':').map(Number)
    return hour * 60 + minute
  }
  const hour = Number(t)
  if (Number.isNaN(hour)) return 0
  return hour * 60
}

function createTrace() {
  return Math.random().toString(36).slice(2, 8)
}

async function clickByText(page, text) {
  await page.getByText(text, { exact: false }).first().click()
}

// 预约失败现场取证：保存最终页面截图 + HTML + URL 到 logs/，便于排查网站实际拒绝原因
// page 可为 null（浏览器尚未打开/已关闭），此时只记录基本信息
const LOGS_DIR = process.env.LOGS_DIR || path.resolve(__dirname, '../../logs')

async function captureFailureEvidence(page, label = 'booking', dir = LOGS_DIR) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const safe = String(label || 'booking').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80)
  const base = `${stamp}-${safe}`
  const out = { ts: Date.now(), base, url: '' }
  const written = []
  try {
    fs.mkdirSync(dir, { recursive: true })
    if (page && typeof page.url === 'function') {
      out.url = page.url()
      await page.screenshot({ path: path.join(dir, `${base}.png`), fullPage: true })
      written.push(`${base}.png`)
      const html = await page.content().catch(() => '')
      if (html) {
        fs.writeFileSync(path.join(dir, `${base}.html`), html, 'utf8')
        written.push(`${base}.html`)
      }
    }
    fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(out, null, 2), 'utf8')
    written.push(`${base}.json`)
    console.log(`[utils] 预约失败取证已保存: ${path.join(dir, base)} (${written.join(', ')})`)
  } catch (e) {
    console.log(`[utils] 预约失败取证失败: ${e.message}`)
  }
  return out
}

// 延迟自动抢的观望期（毫秒）：在 [minMinutes, maxMinutes] 内随机（含两端附近），
// 每个空位各取一个等待时长，避免所有空位同一分钟齐抢、也更像真人观望后再下手。
function delayedGrabWaitMs(minMinutes, maxMinutes, random = Math.random) {
  const lo = Number(minMinutes)
  const hi = Number(maxMinutes)
  const a = Number.isFinite(lo) && lo > 0 ? lo : 10
  const b = Number.isFinite(hi) && hi >= a ? hi : a
  return Math.round((a + random() * (b - a)) * 60 * 1000)
}

// Open-Meteo hourly 预报 → 指定日期 [startHour, endHour) 时段的下雨判定（纯函数）。
// 判定：时段内任一小时降水概率 >= probMax（%），或降水量 > 0mm，即为下雨。
// 预报未覆盖该日期/时段（Open-Meteo 只给 16 天）时 known=false，调用方按「无雨信号」处理。
// 返回 { known, rain, maxProb, maxPrecip }，maxProb/maxPrecip 为时段内最大值（无数据为 null）。
function rainVerdictForWindow(hourly, dateStr, startHour, endHour, probMax) {
  const unknown = { known: false, rain: false, maxProb: null, maxPrecip: null }
  const times = hourly?.time
  if (!Array.isArray(times) || !dateStr) return unknown
  const probs = hourly.precipitation_probability
  const precips = hourly.precipitation
  let seen = false
  let rain = false
  let maxProb = null
  let maxPrecip = null
  for (let i = 0; i < times.length; i++) {
    const t = String(times[i])
    if (!t.startsWith(dateStr)) continue
    const hour = Number(t.slice(11, 13))
    if (Number.isNaN(hour) || hour < startHour || hour >= endHour) continue
    seen = true
    const p = Array.isArray(probs) ? probs[i] : null
    const mm = Array.isArray(precips) ? precips[i] : null
    if (typeof p === 'number') {
      maxProb = maxProb === null ? p : Math.max(maxProb, p)
      if (p >= probMax) rain = true
    }
    if (typeof mm === 'number') {
      maxPrecip = maxPrecip === null ? mm : Math.max(maxPrecip, mm)
      if (mm > 0) rain = true
    }
  }
  if (!seen) return unknown
  return { known: true, rain, maxProb, maxPrecip }
}

// "9:00-11:00" / "9-11" / "9:30～12:00" → { start, end }（当日分钟数，end 为整点时取该整点）
// 解析失败返回 null。与 normalizeTimeRange 不同，这里保留分钟（Tennis Bear 行程可能有 :30）。
function parseTimeRangeMinutes(timeStr) {
  const raw = String(timeStr || '')
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/：/g, ':')
    .replace(/～/g, '~')
    .trim()
  const parts = raw.split(/[~-]/)
  if (parts.length !== 2) return null
  const toMin = (s) => {
    const v = String(s || '').trim()
    if (!v) return null
    const [hStr, mStr = '0'] = v.includes(':') ? v.split(':') : [v, '0']
    const h = Number(hStr), m = Number(mStr)
    if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 24 || m < 0 || m > 59) return null
    return h * 60 + m
  }
  const start = toMin(parts[0])
  const end = toMin(parts[1])
  if (start === null || end === null || end <= start) return null
  return { start, end }
}

// 延迟自动抢的行程守卫（用户规则，2026-11-21）：
//   candidate: { start, end, venue }（当日分钟数 + 场地全名）
//   blocks: 当天已有的网球时间块 [{ start, end, venue, source }]，source: 'booked' | 'bear'
//   opts.nowMin: 当前时间（当日分钟数，JST）；候选不是当天时传 null（不设时限）
//   opts.standaloneLeadMin / opts.extensionLeadMin: 提前量（分钟），默认 60 / 120
// 判定：
//   - 当天没有任何时间块 → 可抢（day-free）；但当天候选距开场不足 1 小时 → 不抢（too-late）
//   - 候选与某个时间块首尾相接（续场）→ 可抢（extension）
//     其中 booked 块要求同场地（异场地首尾相接赶不过去，不算续场）；bear 块只看时间
//     （Tennis Bear 行程的场地是自由文本，与设施名对不齐）
//   - 续场时限（两个条件同时成立才可抢）：① 当前时间早于所接「连续链」的开始
//     （如已约 9-11，11-13 的续场只能在 9:00 前决定；9-11 与 11-13 已连成链时，
//     13-15 的续场同样以 9:00 为限）；② 距候选开场 2 小时以上。
//     任一不满足 → { allow: false, reason: 'extension-too-late', block }
//   - 其余（已有不相连的安排 / 与安排重叠）→ { allow: false, reason: 'separate', block: 首个冲突块 }
//   - 候选时间非法 → { allow: false, reason: 'invalid' }（失败安全，不抢）
function evaluateGrabGuard(candidate, blocks, opts = {}) {
  const c = candidate || {}
  if (!Number.isFinite(c.start) || !Number.isFinite(c.end) || c.end <= c.start) {
    return { allow: false, reason: 'invalid' }
  }
  const nowMin = opts && Number.isFinite(opts.nowMin) ? opts.nowMin : null
  const standaloneLeadMin = opts && Number.isFinite(opts.standaloneLeadMin) ? opts.standaloneLeadMin : 60
  const extensionLeadMin = opts && Number.isFinite(opts.extensionLeadMin) ? opts.extensionLeadMin : 120
  const list = (Array.isArray(blocks) ? blocks : [])
    .filter(b => b && Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
  if (list.length === 0) {
    if (nowMin !== null && c.start - nowMin <= standaloneLeadMin) {
      return { allow: false, reason: 'too-late' }
    }
    return { allow: true, reason: 'day-free' }
  }
  const sameVenue = (a, b) => String(a || '').trim() !== '' && String(a || '').trim() === String(b || '').trim()
  const adjacent = list.filter(b => {
    if (!(c.start === b.end || c.end === b.start)) return false
    if (b.source === 'booked' && !sameVenue(c.venue, b.venue)) return false
    return true
  })
  if (adjacent.length === 0) return { allow: false, reason: 'separate', block: list[0] }
  if (nowMin !== null) {
    // 把时间块按重叠/相接合并成连续链，取候选所接链的最早开始作为决定截止点
    const sorted = [...list].sort((a, b) => a.start - b.start)
    const chains = []
    for (const b of sorted) {
      const last = chains[chains.length - 1]
      if (last && b.start <= last.end) {
        last.end = Math.max(last.end, b.end)
        last.members.push(b)
      } else {
        chains.push({ start: b.start, end: b.end, members: [b] })
      }
    }
    let chainStart = Infinity
    for (const b of adjacent) {
      const chain = chains.find(ch => ch.members.includes(b))
      if (chain) chainStart = Math.min(chainStart, chain.start)
    }
    if ((Number.isFinite(chainStart) && nowMin >= chainStart) || c.start - nowMin <= extensionLeadMin) {
      return { allow: false, reason: 'extension-too-late', block: adjacent[0] }
    }
  }
  return { allow: true, reason: 'extension', block: adjacent[0] }
}

module.exports = {
  slotToken,
  sleep,
  randomInt,
  humanType,
  humanPause,
  humanPauseAfterInput,
  setHumanPauseRange,
  normalizeText,
  formatCourt,
  formatCourtShort,
  normalizeCourtAlias,
  parseSlotDayKey,
  parseTimeSafe,
  parseSlotStartDateTimeSafe,
  normalizeTimeRange,
  isJapaneseHoliday,
  isWeekendOrHoliday,
  formatDateDisplayFromIso,
  jstParts,
  jstDateKey,
  parseHHMM,
  normalizeReleaseReminder,
  isReleaseWindow,
  matchReleaseReminderMoment,
  formatTimeDisplay,
  toMinutes,
  createTrace,
  clickByText,
  captureFailureEvidence,
  delayedGrabWaitMs,
  rainVerdictForWindow,
  parseTimeRangeMinutes,
  evaluateGrabGuard,
  WEEKDAY_JP
}
