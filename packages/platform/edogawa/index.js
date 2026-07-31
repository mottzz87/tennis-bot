/**
 * Edogawa 江戸川区 平台适配器（纯 HTTP，无登录）
 *
 * 流程（单 session 内 7 个请求）：
 *  Home → SearchByFacilityCategory → SelectFacility(勾选目标设施) → Next
 *    → SelectDays → SearchCondition(1ヶ月视图) → Next(勾选全部 some cell) → 时间页
 *
 * 时间页 SSR 模型内嵌 AvailabilityTime，cell.Status==="vacant" 即空位。
 * 每次扫描必须用全新 cookie jar：失败的 POST 会污染 session 导致 NRE 500。
 */
const core = require('@tennis-bot/core')
const PLATFORM_NAME = 'edogawa'
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const TIME_ZONE_ALL = '2147483647'

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
    this._scanDays = Number(platformConfig.SCAN_DAYS) > 0 ? Number(platformConfig.SCAN_DAYS) : 7
    this._minMinutes = Number(platformConfig.MIN_CONTINUOUS_HOURS) > 0
      ? Number(platformConfig.MIN_CONTINUOUS_HOURS) * 60
      : 120

    const http = this._createHttp()
    try {
      return await this._scan(http, targets)
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

  async _scan(req, targets) {
    // 1. Home → token
    let res = await req('/user/Home')
    let html = await res.text()
    const token1 = extractToken(html)

    // 2. SearchByFacilityCategory（屋外スポーツ）
    const fd1 = new URLSearchParams()
    fd1.set('HomeModel.SelectedPlaceClassCategory', '1')
    fd1.set('HomeModel.SelectedPurposeCategory', '1')
    fd1.set('SelectedLanguageCode', '0')
    fd1.set('facilityCategoryCode', '3')
    fd1.set('__RequestVerificationToken', token1)
    res = await req('/user/Home/SearchByFacilityCategory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: fd1.toString()
    })
    const nav1Raw = await res.text()
    const nav1 = JSON.parse(nav1Raw)
    const nav1Info = typeof nav1 === 'string' ? nav1 : nav1.Information
    if (typeof nav1 === 'object' && nav1.Result !== 'Ok') {
      return this._fail(`SearchByFacilityCategory ${nav1Info}`)
    }

    // 3. 设施页 → token2 + 设施 code→name
    res = await req('/user/AvailabilityCheckApplySelectFacility')
    html = await res.text()
    const token2 = extractToken(html)
    const facilities = extractFacilities(html)
    const selected = facilities.filter(f => targets.includes(f.name))
    if (selected.length === 0) {
      console.log(`[edogawa] TARGET_PLACE 未匹配到设施: ${targets.join(', ')}（可用: ${facilities.map(f => f.name).join(' / ')}）`)
      return []
    }

    // 4. SelectFacility/Next
    const fd2 = new URLSearchParams()
    for (const f of facilities) {
      fd2.set(`SelectFacilities.Facilities[${f.idx}].SelectedFacility.Value`, f.code)
      fd2.set(`SelectFacilities.Facilities[${f.idx}].SelectedFacility.Text`, f.name)
    }
    selected.forEach((f, i) => fd2.set(`SelectFacilities.Selected[${i}]`, f.code))
    fd2.set('token', 'null')
    fd2.set('__RequestVerificationToken', token2)
    res = await req('/user/AvailabilityCheckApplySelectFacility/Next', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: fd2.toString()
    })
    const nav2 = JSON.parse(await res.text())
    if (nav2.Result !== 'Ok') return this._fail(`SelectFacility/Next ${nav2.Information}`)

    // 5. 日视图页 → token3 + SearchCondition 表单字段
    res = await req('/user/AvailabilityCheckApplySelectDays')
    html = await res.text()
    const token3 = extractToken(html)
    const formFields = extractInputs(html)

    // 6. SearchCondition → 视图 JSON（窗口由 SCAN_DAYS 决定）
    const startDate = todayJst()
    const endDate = addDaysJst(startDate, this._scanDays - 1)
    const displayTerm = this._scanDays <= 7 ? '2' : this._scanDays <= 14 ? '3' : '4'
    const fd3 = new URLSearchParams()
    for (const [k, v] of formFields) fd3.set(k, v)
    fd3.set('SearchCondition.StartDate', startDate)
    fd3.set('SearchCondition.DisplayTerm', displayTerm)
    fd3.set('SearchCondition.DisplayCalendar', '0')
    fd3.set('SearchCondition.TimeZone', TIME_ZONE_ALL)
    fd3.set('token', 'null')
    fd3.set('__RequestVerificationToken', token3)
    res = await req('/user/AvailabilityCheckApplySelectDays/SearchCondition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: fd3.toString()
    })
    const monthBody = await res.text()
    const month = JSON.parse(monthBody)[1].AvailabilitySelectDays
    if (!Array.isArray(month) || month.length === 0) return this._fail('SearchCondition 返回空')

    // 7-8. 勾选 some cell（每批 ≤10，服务端 E-203-000018 限制）→ Next → 时间页 → vacant slots
    const someCells = collectSomeCells(month, startDate, endDate)
    console.log(`[edogawa] ${selected.length} 设施 ${this._scanDays}天窗口, some cells: ${someCells.length}`)
    if (someCells.length === 0) {
      console.log(`[edogawa] ${selected.length} 设施 ${this._scanDays}天窗口内无 some 空位`)
      return []
    }

    const calcStart = Date.now()
    const slots = []
    const BATCH = 10
    for (let i = 0; i < someCells.length; i += BATCH) {
      const batch = someCells.slice(i, i + BATCH)
      const fd4 = buildNextPayload(month, batch, formFields, token3, startDate, displayTerm)
      res = await req('/user/AvailabilityCheckApplySelectDays/Next', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: fd4.toString()
      })
      const nextBody = await res.text()
      if (!nextBody.includes('Result')) {
        console.log(`[edogawa] Next 异常响应: ${nextBody.slice(0, 120)}`)
        continue
      }
      const nextInfo = JSON.parse(JSON.parse(nextBody))
      if (nextInfo.Result !== 'Ok') {
        console.log(`[edogawa] Next 批次失败 (${i}): ${JSON.stringify(nextInfo.Information)}`)
        continue
      }
      const timeUrl = nextInfo.Information?.MessageId || ''
      if (!timeUrl) continue
      res = await req(timeUrl.startsWith('.') ? '/user/' + timeUrl.slice(2) : timeUrl)
      const timeHtml = await res.text()
      slots.push(...parseTimePage(timeHtml))
    }
    const merged = core.mergeContiguousSlots(slots, this._minMinutes)
    if (merged.length !== slots.length) {
      console.log(`[edogawa] 合并连续时段: ${slots.length} → ${merged.length} (阈值 ${this._minMinutes / 60}h)`)
    }
    console.log(`[edogawa] 计算耗时: ${formatElapsed(Date.now() - calcStart)}`)
    return merged
  }

  _fail(msg) {
    console.log(`[edogawa] ${msg}`)
    return []
  }

  async book(slotData, platformConfig) {
    // monitor-only：本次不做自动预约
    return { success: false, message: 'edogawa 暂不支持自动预约' }
  }
}

// ---------- 解析工具 ----------

function extractToken(html) {
  const m = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)
  if (!m) throw new Error('token not found')
  return m[1]
}

// 设施列表：code→name 隐藏域
function extractFacilities(html) {
  const map = new Map()
  const re = /name="SelectFacilities\.Facilities\[(\d+)\]\.SelectedFacility\.(Value|Text)" value="([^"]*)"/g
  let m
  while ((m = re.exec(html))) {
    const idx = m[1]
    if (!map.has(idx)) map.set(idx, {})
    const rec = map.get(idx)
    if (m[2] === 'Value') rec.code = m[3]
    else rec.name = decodeEntities(m[3])
  }
  return [...map.entries()]
    .map(([idx, o]) => ({ idx: Number(idx), code: o.code, name: o.name }))
    .filter(f => f.code && f.name)
    .sort((a, b) => a.idx - b.idx)
}

// days 页所有 input[name][value]
function extractInputs(html) {
  const out = []
  const re = /<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/g
  let m
  while ((m = re.exec(html))) out.push([m[1], m[2]])
  return out
}

function decodeEntities(s) {
  return String(s).replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
}

// 收集 some cell（startDate..endDate 内，仅网球场）
function collectSomeCells(month, startDate, endDate) {
  const out = []
  const seen = new Set()
  for (const d of month) {
    for (const r of d.Rows || []) {
      if (!isTennisCourt(r.ObjectName, d.FacilityName)) continue
      for (const c of r.Cells || []) {
        if (c.Status !== 'some') continue
        if (!c.UseDate) continue
        const date = c.UseDate.slice(0, 10)
        if (date < startDate || date > endDate) continue
        const key = `${d.FacilityCode}|${r.DisplayGroupCode}|${date}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ facility: d, row: r, cell: c })
      }
    }
  }
  return out
}

// 面名是否网球场：
//   - 面名带「テニス」→ 网球（混合设施如西葛西/スポーツランド/水辺的网球面都带）
//   - 面名带其它球类关键词 → 非网球（フットサル/バスケット/野球/ソフトボール等）
//   - 纯网球设施（谷河内）面名只有 Ａ面/Ｂ面，不带テニス → 按设施名判定
function isTennisCourt(surfaceName, facilityName) {
  const s = String(surfaceName || '')
  if (/テニス/.test(s)) return true
  if (/フットサル|バスケット|野球|ソフトボール|多目的|ローラー|サッカー|ラグビー|球技|運動場/.test(s)) return false
  return /テニス/.test(String(facilityName || ''))
}

// 重建 Next 完整模型，勾选 batch 内的 some cell
function buildNextPayload(month, someCells, formFields, token, startDate, displayTerm) {
  const fd = new URLSearchParams()
  month.forEach((d, fi) => {
    fd.set(`AvailabilitySelectDays[${fi}].FacilityCode`, String(d.FacilityCode))
    d.Rows.forEach((r, ri) => {
      fd.set(`AvailabilitySelectDays[${fi}].Rows[${ri}].DisplayGroupCode`, String(r.DisplayGroupCode))
      r.Cells.forEach((c, ci) => {
        const base = `AvailabilitySelectDays[${fi}].Rows[${ri}].Cells[${ci}]`
        const checked = someCells.some(t => t.facility === d && t.row === r && t.cell === c)
          ? 'true' : 'false'
        fd.set(`${base}.IsChecked`, checked)
        fd.set(`${base}.FacilityCode`, String(c.FacilityCode))
        fd.set(`${base}.DisplayGroupCode`, String(c.DisplayGroupCode))
        fd.set(`${base}.UseDate`, c.UseDate)
        fd.set(`${base}.Status`, c.Status)
        fd.set(`${base}.ObjectCode[0]`, String((c.ObjectCode || [1])[0]))
      })
    })
  })
  for (const [k, v] of formFields) {
    if (k.startsWith('AvailabilitySelectDays')) continue
    fd.set(k, v)
  }
  fd.set('SearchCondition.StartDate', startDate)
  fd.set('SearchCondition.DisplayTerm', displayTerm)
  fd.set('SearchCondition.DisplayCalendar', '0')
  fd.set('SearchCondition.TimeZone', TIME_ZONE_ALL)
  fd.set('token', 'null')
  fd.set('__RequestVerificationToken', token)
  return fd
}

// 解析时间页 SSR 模型 → vacant slots
function parseTimePage(html) {
  const m = html.match(/model: JSON\.parse\(\"((?:[^"\\]|\\.)*)\"\)/)
  if (!m) throw new Error('时间页未找到 SSR 模型')
  const model = JSON.parse(JSON.parse(`"${m[1]}"`))
  const list = model.AvailabilityTime?.FacilityList || []
  const slots = []
  for (const f of list) {
    const place = f.FacilityName
    for (const t of f.Tables || []) {
      const date = String(t.UseDate || '').slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      for (const p of t.Places || []) {
        if (!isTennisCourt(p.ObjectName, f.FacilityName)) continue
        for (const c of p.Cells || []) {
          if (c.Status !== 'vacant') continue
          const start = fmtHHMM(c.TimeFrom)
          const end = fmtHHMM(c.TimeTo)
          if (!start || !end) continue
          slots.push({
            platform: PLATFORM_NAME,
            place,
            court: p.ObjectName,
            date,
            start,
            end,
            duration: minutesBetween(c.TimeFrom, c.TimeTo),
            available: true
          })
        }
      }
    }
  }
  return slots
}

// TimeFrom 是 HHMM 数字（800 → '08:00'）
function fmtHHMM(n) {
  const v = Number(n)
  if (!Number.isInteger(v) || v < 0 || v > 2400) return ''
  const hh = Math.floor(v / 100)
  const mm = v % 100
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

// ms → "40s" / "1m20s"
function formatElapsed(ms) {
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  const rem = s % 60
  return m > 0 ? `${m}m${String(rem).padStart(2, '0')}s` : `${s}s`
}

function minutesBetween(from, to) {
  const f = Number(from), t = Number(to)
  if (!Number.isInteger(f) || !Number.isInteger(t)) return 60
  return (Math.floor(t / 100) * 60 + (t % 100)) - (Math.floor(f / 100) * 60 + (f % 100))
}

function todayJst() {
  const d = new Date(Date.now() + 9 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function addDaysJst(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86400000)
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

module.exports = { create }
