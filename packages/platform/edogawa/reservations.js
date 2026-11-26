/**
 * 江户川官网预约列表（只读同步）
 *
 * 背景：用户有时直接在官网预约，这类预约不经过 bot，服务器的
 * bookedSlots 里没有记录 — 延迟自动抢的行程守卫看不到、Tennis Bear
 * 拟稿不触发、到期提醒也不会发。同步流程：登录官网 → 打开
 * /user/ReservationCheckList → 解析预约卡片 → 映射成 bot 预约记录
 * 形状，交给 booking-service 对账（apps/booking-service/sync.js）。
 *
 * 约束（与既有设计一致）：
 * - 日常扫描仍走游客流程；只有同步和预约才登录。
 * - 同步只读：绝不点击取消/变更，不提交任何表单（登录除外）。
 * - 页面异常（未登录/改版/解析不到条目）一律抛错，整轮同步跳过，
 *   绝不把「读不到」当成「没有预约」去删本地记录。
 */
const { chromium } = require('playwright')
const { USER_AGENT } = require('./flow')
const { loginFirst } = require('./booking')
const core = require('@tennis-bot/core')
const { formatDateDisplayFromIso } = require('@tennis-bot/utils')

function parseYen(text) {
  const m = String(text || '').replace(/,/g, '').match(/(\d+)\s*円/)
  return m ? Number(m[1]) : null
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

// '2026/12/3 (木)' -> '2026-12-03'
function parseSiteDate(text) {
  const m = String(text || '').match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/)
  if (!m) return null
  return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`
}

// '8:00 ～ 12:00' -> '08:00-12:00'
function parseSiteTimeRange(text) {
  const m = String(text || '').match(/(\d{1,2}):(\d{2})\s*～\s*(\d{1,2}):(\d{2})/)
  if (!m) return null
  return `${pad2(m[1])}:${m[2]}-${pad2(m[3])}:${m[4]}`
}

// 施設欄：'本予約 谷河内テニスコート Ｂ面' / '本予約 水辺のスポーツガーデン 水辺テニスＤ面'
// placeNames 按长度降序传入（最长前缀优先）。识别不了设施名时 place=null，
// 由上层记日志并跳过该条 — 绝不臆造记录。
function splitPlaceCourt(facilityText, placeNames) {
  const text = String(facilityText || '').replace(/\s+/g, ' ').trim()
  const badgeMatch = text.match(/^(\S+)\s+(.*)$/)
  const badge = badgeMatch ? badgeMatch[1] : ''
  const rest = badgeMatch ? badgeMatch[2] : text
  for (const place of placeNames || []) {
    if (rest.startsWith(place)) {
      return { badge, place, court: rest.slice(place.length).trim() }
    }
  }
  return { badge, place: null, court: null, raw: rest }
}

/**
 * 把预约列表页的 dl 序列（[{dt, dd}]，页面顺序）切块解析成站点预约条目。
 * 每块以「施設」开头；備品子块自带一組 時間帯/領収済額 dl，只取主块的
 * 時間帯（第一次出现），備品只取 備品名 与 備品使用料。
 * 只收 本予約（仮予約等未确定状态跳过并计数）。
 */
function parseReservationPairs(pairs, placeNames) {
  const chunks = []
  let cur = null
  for (const pair of pairs || []) {
    const dt = pair.dt || ''
    const dd = pair.dd || ''
    if (dt === '施設') {
      cur = { facility: dd, equipName: null, equipFee: null }
      chunks.push(cur)
      continue
    }
    if (!cur) continue
    if (dt === '利用日' && !cur.dateText) cur.dateText = dd
    else if (dt === '時間帯' && !cur.timeText) cur.timeText = dd
    else if (dt === '施設使用料' && cur.facilityFee === undefined) cur.facilityFee = parseYen(dd)
    else if (dt === '備品') cur.equipName = dd
    else if (dt === '備品使用料') cur.equipFee = parseYen(dd)
  }
  const entries = []
  let skipped = 0
  for (const chunk of chunks) {
    const { badge, place, court } = splitPlaceCourt(chunk.facility, placeNames)
    const date = parseSiteDate(chunk.dateText)
    const time = parseSiteTimeRange(chunk.timeText)
    if (badge !== '本予約' || !place || !court || !date || !time) {
      skipped += 1
      continue
    }
    const hasLighting = !!chunk.equipName && chunk.equipName.includes('照明')
    entries.push({
      place,
      court,
      date,
      time,
      facilityFee: chunk.facilityFee ?? null,
      lightingFee: hasLighting ? (chunk.equipFee ?? null) : null
    })
  }
  return { entries, skipped }
}

// 'Ｄ面' / '水辺テニスＤ面' -> 'D'
function courtLetterOf(court) {
  const m = String(court || '').match(/([A-Za-zＡ-Ｚａ-ｚ])\s*面/)
  if (!m) return ''
  return m[1].replace(/[Ａ-Ｚａ-ｚ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).toUpperCase()
}

// 站点条目 -> bot 预约记录（形状与 booking-service 下单成功后写入的一致；
// ucode 复用 core.buildUcode，保证与扫描/下单路径同一套构建规则）
function siteEntryToRecord(entry, platformConfig, now = Date.now()) {
  const [startH, startM] = entry.time.split('-')[0].split(':').map(Number)
  const [endH, endM] = entry.time.split('-')[1].split(':').map(Number)
  const hours = (endH * 60 + endM - (startH * 60 + startM)) / 60
  const letter = courtLetterOf(entry.court)
  const facilityFee = entry.facilityFee ?? null
  const lightingFee = entry.lightingFee ?? null
  return {
    uid: `${entry.place}_${entry.court}_${entry.date}_${entry.time}`,
    ucode: core.buildUcode(
      { place: entry.place, court: entry.court, date: entry.date, time: entry.time },
      platformConfig
    ),
    platform: 'edogawa',
    place: entry.place,
    court: entry.court,
    courts: letter && hours > 0 ? `${hours}${letter}` : null,
    date: entry.date,
    time: entry.time,
    dateDisplay: formatDateDisplayFromIso(entry.date),
    reminderEnabled: true,
    facilityFee,
    lightingFee,
    totalFee: facilityFee != null ? facilityFee + (lightingFee || 0) : null,
    bookedAt: now,
    create: new Date(now).toLocaleString(),
    origin: 'site-sync'
  }
}

/**
 * 登录官网并读取全部未来预约（列表页单页展示全部，无分页）。
 * placeNames：已知设施名全称（edogawa PLACE_MAP 的键）。
 * 返回 [{place, court, date, time, facilityFee, lightingFee}]。
 * 未登录/页面异常/一条都解析不出（且页面非空）时抛错。
 */
async function fetchReservationEntries(placeNames) {
  const baseUrl = (process.env.EDOGAWA_BASE_URL || '').replace(/\/+$/, '')
  if (!baseUrl) throw new Error('EDOGAWA_BASE_URL 未配置')
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'ja-JP' })
    const page = await context.newPage()
    await loginFirst(page, baseUrl)
    await page.goto(`${baseUrl}/user/ReservationCheckList`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    const snapshot = await page.evaluate(() => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim()
      return {
        url: location.href,
        loggedIn: (document.body?.innerText || '').includes('ログアウト'),
        pairs: [...document.querySelectorAll('dl')].map(dl => ({
          dt: norm(dl.querySelector('dt')?.textContent),
          dd: norm(dl.querySelector('dd')?.textContent)
        }))
      }
    })
    if (!snapshot.loggedIn || !/ReservationCheckList/.test(snapshot.url)) {
      throw new Error(`预约列表页状态异常（url=${snapshot.url}, loggedIn=${snapshot.loggedIn}）`)
    }
    const { entries, skipped } = parseReservationPairs(snapshot.pairs, placeNames)
    if (skipped > 0) {
      console.log(`[edogawa][预约同步] 有 ${skipped} 条预约未识别（非本予約/设施名未识别/字段缺失），已跳过`)
    }
    return entries
  } finally {
    await browser.close().catch(() => {})
  }
}

module.exports = {
  fetchReservationEntries,
  parseReservationPairs,
  splitPlaceCourt,
  parseSiteDate,
  parseSiteTimeRange,
  siteEntryToRecord,
  courtLetterOf
}
