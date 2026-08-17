/**
 * Edogawa 共享流程工具（扫描 / 预约共用）
 *
 * 导航序列（单 session 内 6 个请求）：
 *  Home → SearchByFacilityCategory → SelectFacility(勾选目标设施) → Next
 *    → SelectDays → SearchCondition(1ヶ月视图)
 * 返回 month 模型与后续步骤所需状态，供扫描批处理和单点预约复用。
 */
const PLATFORM_NAME = 'edogawa'
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const TIME_ZONE_ALL = '2147483647'

/**
 * 把扫描窗口拆成多个周期：站点 SearchCondition 的 DisplayTerm 最大只有 1ヶ月（约 30 天），
 * 窗口超过 30 天必须按周期多次查询（等价于页面点「次の期間」）。
 * 每周期返回 { startDate, endDate, displayTerm }，日期不重叠、首尾相接覆盖整个窗口。
 */
function buildPeriodPlan(startDate, scanDays) {
  const term = scanDays <= 7 ? '2' : scanDays <= 14 ? '3' : '4'
  const stepDays = scanDays <= 7 ? 7 : scanDays <= 14 ? 14 : 30
  const periods = []
  let cursor = startDate
  let covered = 0
  while (covered < scanDays) {
    const segDays = Math.min(stepDays, scanDays - covered)
    periods.push({
      startDate: cursor,
      endDate: addDaysJst(cursor, segDays - 1),
      displayTerm: term
    })
    cursor = addDaysJst(cursor, stepDays)
    covered += segDays
  }
  return periods
}

/**
 * 走完 Home → … → SelectDays 页面导航，返回后续 SearchCondition 所需状态。
 * 注意：站点要求 Next 的模型必须匹配「当前 session 的 SearchCondition」，
 * 因此不要在这里提前把多期 SearchCondition 全部查完 —— 应每期调用 queryMonth 后紧跟该期的 Next 批次。
 * @param {Function} req - (path, {method, headers, body}) => Response
 * @param {string[]} targets - TARGET_PLACE 设施名列表
 * @param {number} scanDays - 扫描窗口天数
 * @param {number} startOffset - 从今天往后跳过几天开始（当天/次日无数据，默认 2）
 * @returns {Promise<Object|null>} { facilities, selected, formFields, token3, startDate, endDate, periods }
 *   periods: [{ startDate, endDate, displayTerm }]，各期需用 queryMonth 拉取各自的 month
 */
async function navigateToMonth(req, targets, scanDays, startOffset = 2) {
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
    console.log(`[edogawa] SearchByFacilityCategory ${nav1Info}`)
    return null
  }

  // 3. 设施页 → token2 + 设施 code→name
  res = await req('/user/AvailabilityCheckApplySelectFacility')
  html = await res.text()
  const token2 = extractToken(html)
  const facilities = extractFacilities(html)
  const selected = facilities.filter(f => targets.includes(f.name))
  if (selected.length === 0) {
    console.log(`[edogawa] TARGET_PLACE 未匹配到设施: ${targets.join(', ')}（可用: ${facilities.map(f => f.name).join(' / ')}）`)
    return null
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
  if (nav2.Result !== 'Ok') {
    console.log(`[edogawa] SelectFacility/Next ${nav2.Information}`)
    return null
  }

  // 5. 日视图页 → token3 + SearchCondition 表单字段
  res = await req('/user/AvailabilityCheckApplySelectDays')
  html = await res.text()
  const token3 = extractToken(html)
  const formFields = extractInputs(html)

  // 6. 只计算窗口周期，不提前查询（见函数注释：每期 SearchCondition 必须紧跟该期 Next）
  const startDate = addDaysJst(todayJst(), startOffset)
  const endDate = addDaysJst(startDate, scanDays - 1)
  const periods = buildPeriodPlan(startDate, scanDays)

  return { facilities, selected, formFields, token3, startDate, endDate, periods }
}

/**
 * 单次 SearchCondition 查询，返回该窗口的月视图模型。
 * 调用后必须紧接着用同一 req 对该期做 Next，再查询下一期。
 * @param {Function} req - (path, {method, headers, body}) => Response
 * @param {Array} formFields - SelectDays 页的表单字段
 * @param {string} token3 - __RequestVerificationToken
 * @param {string} startDate - 本期开始日期 YYYY-MM-DD
 * @param {string} displayTerm - SearchCondition.DisplayTerm
 * @returns {Promise<Array>} AvailabilitySelectDays 数组；查询失败/为空返回 []
 */
async function queryMonth(req, formFields, token3, startDate, displayTerm) {
  const fd3 = new URLSearchParams()
  for (const [k, v] of formFields) fd3.set(k, v)
  fd3.set('SearchCondition.StartDate', startDate)
  fd3.set('SearchCondition.DisplayTerm', displayTerm)
  fd3.set('SearchCondition.DisplayCalendar', '0')
  fd3.set('SearchCondition.TimeZone', TIME_ZONE_ALL)
  fd3.set('token', 'null')
  fd3.set('__RequestVerificationToken', token3)
  let res
  try {
    res = await req('/user/AvailabilityCheckApplySelectDays/SearchCondition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: fd3.toString()
    })
  } catch (e) {
    console.log(`[edogawa] SearchCondition 请求失败 (${startDate}): ${e.message}`)
    return []
  }
  const body = await res.text()
  try {
    const month = JSON.parse(body)[1]?.AvailabilitySelectDays
    return Array.isArray(month) ? month : []
  } catch {
    console.log(`[edogawa] SearchCondition 返回异常 (${startDate}): ${body.slice(0, 120)}`)
    return []
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

// 重建 Next 完整模型，勾选 someCells 内的 cell
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

// 所在月份"下个月"的月底，如 2026-08-19 → 2026-09-30
function endOfNextMonthStr(dateStr) {
  const [y, m] = dateStr.split('-').map(Number)
  const nextYear = y + Math.floor(m / 12)
  const nextMonthIdx = m % 12
  const e = new Date(Date.UTC(nextYear, nextMonthIdx + 1, 0))
  return `${e.getUTCFullYear()}-${String(e.getUTCMonth() + 1).padStart(2, '0')}-${String(e.getUTCDate()).padStart(2, '0')}`
}

// startDate（含）到 endDate（含）的天数
function daysBetween(startDate, endDate) {
  const [y1, m1, d1] = startDate.split('-').map(Number)
  const [y2, m2, d2] = endDate.split('-').map(Number)
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000) + 1
}

// 从 startDate 起覆盖到下个月月底需要的天数（SCAN_UNTIL_NEXT_MONTH_END）
function daysToEndOfNextMonth(startDate) {
  return daysBetween(startDate, endOfNextMonthStr(startDate))
}

// 全角/半角/空白归一化，用于 court 名称匹配
function normalizeName(s) {
  return String(s || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, '')
    .trim()
}

module.exports = {
  PLATFORM_NAME,
  USER_AGENT,
  TIME_ZONE_ALL,
  navigateToMonth,
  queryMonth,
  buildPeriodPlan,
  extractToken,
  extractFacilities,
  extractInputs,
  decodeEntities,
  collectSomeCells,
  isTennisCourt,
  buildNextPayload,
  parseTimePage,
  fmtHHMM,
  minutesBetween,
  todayJst,
  addDaysJst,
  endOfNextMonthStr,
  daysBetween,
  daysToEndOfNextMonth,
  normalizeName
}
