/**
 * Edogawa 江戸川区 平台适配器（纯 HTTP 扫描 + Playwright 预约）
 *
 * 扫描（单 session 内 6 请求导航 + 批处理 Next）：
 *  Home → SearchByFacilityCategory → SelectFacility(勾选目标设施) → Next
 *    → SelectDays → SearchCondition(1ヶ月视图) → Next(勾选 some cell) → 时间页
 *
 * 预约（复用 flow 导航 → Playwright 驱动页面）见 ./booking.js。
 *
 * 每次扫描必须用全新 cookie jar：失败的 POST 会污染 session 导致 NRE 500。
 */
const core = require('@tennis-bot/core')
const {
  USER_AGENT,
  navigateToMonth,
  queryMonth,
  collectSomeCells,
  buildNextPayload,
  parseTimePage,
  todayJst,
  addDaysJst,
  daysToEndOfNextMonth
} = require('./flow')
const { bookSlot } = require('./booking')

const PLATFORM_NAME = 'edogawa'

function create() {
  const baseUrl = process.env.EDOGAWA_BASE_URL
  if (!baseUrl) {
    console.warn('[edogawa] EDOGAWA_BASE_URL 未设置，需配置后才可使用')
  }
  return new EdogawaAdapter(baseUrl)
}

class CookieJar {
  constructor() { this.map = new Map() }
  extract(res) {
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : []
    for (const c of sc) {
      const [pair] = c.split(';')
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      this.map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1))
    }
  }
  header() {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

class EdogawaAdapter {
  constructor(baseUrl) {
    this._baseUrl = (baseUrl || '').replace(/\/+$/, '')
  }

  get name() {
    return PLATFORM_NAME
  }

  async fetchSlots(platformConfig) {
    if (!this._baseUrl) {
      console.log('[edogawa] BASE_URL 未配置，跳过')
      return []
    }
    const targets = (platformConfig.TARGET_PLACE || []).filter(Boolean)
    if (targets.length === 0) return []
    this._startOffset = Number(platformConfig.SCAN_START_OFFSET) > 0 ? Number(platformConfig.SCAN_START_OFFSET) : 2
    let scanDays = Number(platformConfig.SCAN_DAYS) > 0 ? Number(platformConfig.SCAN_DAYS) : 7
    if (platformConfig.SCAN_UNTIL_NEXT_MONTH_END) {
      scanDays = daysToEndOfNextMonth(addDaysJst(todayJst(), this._startOffset))
    }
    this._scanDays = scanDays
    this._minMinutes = Number(platformConfig.MIN_CONTINUOUS_HOURS) > 0
      ? Number(platformConfig.MIN_CONTINUOUS_HOURS) * 60
      : 120
    this._goldenFilter = Array.isArray(platformConfig.GOLDEN_TIME_FILTER)
      ? platformConfig.GOLDEN_TIME_FILTER
      : []

    const http = this._createHttp()
    try {
      return await this._scan(http, targets, platformConfig)
    } catch (e) {
      console.log(`[edogawa] 扫描失败: ${e.message}`)
      return []
    }
  }

  _createHttp() {
    const jar = new CookieJar()
    const req = async (path, opts = {}) => {
      const headers = { 'User-Agent': USER_AGENT, ...(opts.headers || {}) }
      const cookie = jar.header()
      if (cookie) headers['Cookie'] = cookie
      let res
      try {
        res = await fetch(this._baseUrl + path, { ...opts, headers, redirect: 'manual' })
      } catch (e) {
        throw new Error(`fetch ${path}: ${e.message}`)
      }
      jar.extract(res)
      return res
    }
    return req
  }

  // ---------- 流程步骤 ----------

  async _scan(req, targets, platformConfig) {
    // 1-5. 导航到 SelectDays 页（窗口超 1ヶ月 自动拆多期，但不在导航阶段提前查询）
    const nav = await navigateToMonth(req, targets, this._scanDays, this._startOffset)
    if (!nav) return []
    const { selected, formFields, token3, periods } = nav

    // 6-8. 每期：SearchCondition → 勾选 some cell（每批 ≤10，服务端 E-203-000018 限制）→ Next → 时间页 → vacant slots。
    // 站点要求 Next 的模型必须匹配当前 session 的 SearchCondition，因此必须"查一期、接着处理该期 Next"，再进入下一期。
    const calcStart = Date.now()
    const slots = []
    const BATCH = 10
    let someTotal = 0
    for (const p of periods) {
      const month = await queryMonth(req, formFields, token3, p.startDate, p.displayTerm)
      const cells = collectSomeCells(month, p.startDate, p.endDate)
      someTotal += cells.length
      for (let i = 0; i < cells.length; i += BATCH) {
        const batch = cells.slice(i, i + BATCH)
        const fd4 = buildNextPayload(month, batch, formFields, token3, p.startDate, p.displayTerm)
        let res
        try {
          res = await req('/user/AvailabilityCheckApplySelectDays/Next', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: fd4.toString()
          })
        } catch (e) {
          console.log(`[edogawa] Next 请求失败 (${p.startDate}, ${i}): ${e.message}`)
          continue
        }
        const nextBody = await res.text()
        if (!nextBody.includes('Result')) {
          console.log(`[edogawa] Next 异常响应 (${p.startDate}): ${nextBody.slice(0, 120)}`)
          continue
        }
        const nextInfo = JSON.parse(JSON.parse(nextBody))
        if (nextInfo.Result !== 'Ok') {
          console.log(`[edogawa] Next 批次失败 (${p.startDate}, ${i}): ${JSON.stringify(nextInfo.Information)}`)
          continue
        }
        const timeUrl = nextInfo.Information?.MessageId || ''
        if (!timeUrl) continue
        let timeHtml
        try {
          res = await req(timeUrl.startsWith('.') ? '/user/' + timeUrl.slice(2) : timeUrl)
          timeHtml = await res.text()
        } catch (e) {
          console.log(`[edogawa] 时间页请求失败: ${e.message}`)
          continue
        }
        slots.push(...parseTimePage(timeHtml))
      }
    }
    console.log(`[edogawa] ${selected.length} 设施 ${this._scanDays}天窗口(${periods.length}期), some cells: ${someTotal}`)
    if (someTotal === 0) {
      console.log(`[edogawa] ${selected.length} 设施 ${this._scanDays}天窗口内无 some 空位`)
      return []
    }
    // 打场地组标签（硬地/人工芝等），拼接时同组才拼，避免混合类型拼成一段
    for (const s of slots) {
      s.group = core.resolveCourtGroup(s.court, s.place, platformConfig)
    }
    const merged = core.mergeContiguousSlots(slots, this._minMinutes, this._goldenFilter)
    if (merged.length !== slots.length) {
      const goldenNote = this._goldenFilter.length ? `, 黄金时段 ${this._goldenFilter.join('/')}` : ''
      console.log(`[edogawa] 合并连续时段: ${slots.length} → ${merged.length} (阈值 ${this._minMinutes / 60}h${goldenNote})`)
    }
    console.log(`[edogawa] 计算耗时: ${formatElapsed(Date.now() - calcStart)}`)
    return merged
  }

  async book(slotData, platformConfig) {
    return bookSlot(this, slotData, platformConfig)
  }
}

// ms → "40s" / "1m20s"
function formatElapsed(ms) {
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  const rem = s % 60
  return m > 0 ? `${m}m${String(rem).padStart(2, '0')}s` : `${s}s`
}

module.exports = { create }
