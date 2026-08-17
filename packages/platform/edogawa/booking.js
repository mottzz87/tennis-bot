/**
 * Edogawa 预约执行（Playwright）
 *
 * 复用 flow.js 的 HTTP 导航（context.request 与浏览器共享 cookie）：
 *  Home → … → SearchCondition → 勾选该时段全部 some cells → Next → 合并时间页
 *    （跨面拼接如 "IF" 会一次勾选 I面+F面 的 some cells，合并页含多个 Place）
 *    → 按拼接序列逐小时勾选目标时段 → 次へ進む → (登录) → 申请明细 → 申込 → 确认弹窗 はい
 */
const { chromium } = require('playwright')
const { humanType, humanPause, humanPauseAfterInput, setHumanPauseRange } = require('@tennis-bot/utils')
const {
  USER_AGENT,
  navigateToMonth,
  queryMonth,
  buildNextPayload,
  isTennisCourt,
  normalizeName,
  todayJst,
  addDaysJst,
  daysToEndOfNextMonth
} = require('./flow')

// "12:00" / "12:30" → 1200 / 1230
function toHHMM(timeStr) {
  const s = String(timeStr || '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  const m = s.match(/(\d{1,2})\s*[:：]?\s*(\d{2})?/)
  if (!m) return NaN
  return Number(m[1]) * 100 + Number(m[2] || 0)
}

// "水辺テニスＡ面" → "A"；"Ａ面" → "A"；兜底取名字首字符（与 core.courtLetter 一致）
function courtLetter(court) {
  const name = String(court || '')
  const m = name.match(/([Ａ-Ｚ])(?=面)/)
  if (m) return String.fromCharCode(m[1].charCodeAt(0) - 0xFEE0)
  const m2 = name.match(/([A-Z])(?=面)/)
  if (m2) return m2[1]
  return name.slice(0, 1) || '?'
}

// "IF" → [{letter:'I',hours:1},{letter:'F',hours:1}]；"A2B" → A1h+B2h；"2A" → A2h
function parseCourts(courtsStr) {
  const s = String(courtsStr || '')
  if (!s) return []
  const groups = []
  const re = /(\d+(?:\.\d+)?)?([^\d])/g
  let m
  while ((m = re.exec(s)) !== null) {
    groups.push({ letter: m[2], hours: m[1] ? Number(m[1]) : 1 })
  }
  return groups
}

// 把拼接序列展开成逐小时期望表 { startH+k*100: letter }；总时长与时段不符时返回 null
function buildExpectedSchedule(startH, endH, courtGroups) {
  const expected = {}
  let cur = startH
  for (const g of courtGroups) {
    for (let i = 0; i < g.hours; i++) {
      expected[cur] = g.letter
      cur += 100
    }
  }
  const totalHours = (endH - startH) / 100
  if (Object.keys(expected).length !== totalHours) return null
  return expected
}

// context.request 共享浏览器 cookie，封装成扫描同款 req(path, {method, headers, body})
function createReq(context, baseUrl) {
  return async (path, opts = {}) => {
    const url = baseUrl + path
    const headers = { 'User-Agent': USER_AGENT, ...(opts.headers || {}) }
    if (opts.method === 'POST') {
      return context.request.post(url, { headers, data: opts.body })
    }
    return context.request.get(url, { headers })
  }
}

// 在月视图中定位 (facility, court, date) 的 some cell；面名不匹配时退而求其次取同设施同日期的其它面
function findSomeCell(month, slotData) {
  const place = normalizeName(slotData.place)
  const court = normalizeName(slotData.court)
  const date = String(slotData.date || '').slice(0, 10)
  let fallback = null
  for (const d of month) {
    if (normalizeName(d.FacilityName) !== place) continue
    for (const r of d.Rows || []) {
      if (!isTennisCourt(r.ObjectName, d.FacilityName)) continue
      for (const c of r.Cells || []) {
        if (c.Status !== 'some') continue
        if (!c.UseDate || c.UseDate.slice(0, 10) !== date) continue
        const rec = { facility: d, row: r, cell: c }
        if (!fallback) fallback = rec
        if (court && normalizeName(r.ObjectName) === court) return rec
      }
    }
  }
  return fallback
}

// 取 (facility, date) 下所有 some cell，并按拼接序列字母过滤（无序列则全取）
// 多 some cell 一起 Next 会得到包含多个面（Place）的合并时间页，用于跨面拼接预约
function findSomeCells(month, slotData) {
  const place = normalizeName(slotData.place)
  const date = String(slotData.date || '').slice(0, 10)
  const seqLetters = parseCourts(slotData.courts).map(g => g.letter)
  const out = []
  for (const d of month) {
    if (normalizeName(d.FacilityName) !== place) continue
    for (const r of d.Rows || []) {
      if (!isTennisCourt(r.ObjectName, d.FacilityName)) continue
      if (seqLetters.length && !seqLetters.includes(courtLetter(r.ObjectName))) continue
      for (const c of r.Cells || []) {
        if (c.Status !== 'some') continue
        if (!c.UseDate || c.UseDate.slice(0, 10) !== date) continue
        out.push({ facility: d, row: r, cell: c })
      }
    }
  }
  return out.slice(0, 10)
}

// 时间页 SSR 模型中勾选目标时段：
//   - 有 courts 拼接序列（如 "DB"/"IF"）→ 逐小时按序列字母选对应面
//   - 无序列 → 精确匹配面名，未命中退到同设施其它网球面
async function selectTimeCells(page, slotData) {
  const startH = toHHMM(slotData.start)
  const endH = toHHMM(slotData.end)
  const courtNorm = normalizeName(slotData.court)
  const expected = buildExpectedSchedule(startH, endH, parseCourts(slotData.courts))
  return page.evaluate(({ startH, endH, courtNorm, expected }) => {
    const m = document.documentElement.innerHTML.match(/model: JSON\.parse\(\"((?:[^"\\]|\\.)*)\"\)/)
    if (!m) return { ok: false, reason: '未找到时间页 SSR 模型' }
    const model = JSON.parse(JSON.parse(`"${m[1]}"`))
    const list = model.AvailabilityTime?.FacilityList || []
    const norm = s => String(s || '')
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/\s+/g, '')
    const letterOf = name => {
      const n = String(name || '')
      const m1 = n.match(/([Ａ-Ｚ])(?=面)/)
      if (m1) return String.fromCharCode(m1[1].charCodeAt(0) - 0xFEE0)
      const m2 = n.match(/([A-Z])(?=面)/)
      if (m2) return m2[1]
      return n.slice(0, 1) || '?'
    }
    const spanOf = c => Number(c.TimeTo) - Number(c.TimeFrom)
    const candidates = []
    for (let fi = 0; fi < list.length; fi++) {
      for (let ti = 0; ti < (list[fi].Tables || []).length; ti++) {
        for (let pi = 0; pi < (list[fi].Tables[ti].Places || []).length; pi++) {
          const p = list[fi].Tables[ti].Places[pi]
          const placeNorm = norm(p.ObjectName)
          for (let ci = 0; ci < (p.Cells || []).length; ci++) {
            const c = p.Cells[ci]
            if (c.Status !== 'vacant') continue
            if (Number(c.TimeFrom) < startH || Number(c.TimeTo) > endH) continue
            candidates.push({ fi, ti, pi, ci, c, placeNorm, letter: letterOf(p.ObjectName) })
          }
        }
      }
    }

    const pick = []
    const missing = []
    if (expected) {
      // 逐小时选面：每个整点时段归入期望字母，同小时只选覆盖该整小时的最佳 cell
      const byHour = {}
      for (const e of candidates) {
        const ownerHour = Math.floor(Number(e.c.TimeFrom) / 100) * 100
        if (!expected[ownerHour]) continue
        if (e.letter !== expected[ownerHour]) continue
        if (Number(e.c.TimeFrom) > ownerHour || Number(e.c.TimeTo) < ownerHour + 100) continue
        if (!byHour[ownerHour] || spanOf(e.c) > spanOf(byHour[ownerHour].c)) byHour[ownerHour] = e
      }
      for (const h of Object.keys(expected).map(Number).sort((a, b) => a - b)) {
        if (byHour[h]) pick.push(byHour[h])
        else missing.push({ hour: h, letter: expected[h] })
      }
    } else {
      // 兜底：精确面命中优先，否则全选（面名出入时）
      const exacts = candidates.filter(e => courtNorm && e.placeNorm === courtNorm)
      pick.push(...(exacts.length ? exacts : candidates))
    }

    let selected = 0
    const log = []
    for (const e of pick) {
      const sel = `input[name="AvailabilityTime.FacilityList[${e.fi}].Tables[${e.ti}].Places[${e.pi}].Cells[${e.ci}].IsSelected"]`
      const inp = document.querySelector(sel)
      if (inp) { inp.value = 'True'; selected++; log.push(`${e.letter} ${e.c.TimeFrom}-${e.c.TimeTo}`) }
    }
    const selectedCells = pick.map(e => ({ letter: e.letter, from: Number(e.c.TimeFrom), to: Number(e.c.TimeTo) }))
    return { ok: selected > 0, selected, expectedCount: expected ? Object.keys(expected).length : 0, missing, selectedCells, log }
  }, { startH, endH, courtNorm, expected })
}

function fmtTime(hhmm) {
  const h = Math.floor(hhmm / 100)
  const m = hhmm % 100
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// 把同面连续的时段合并成一段，用于提示文案（[A16-17, A17-18] → [A16-18]）
function mergeSegments(segments) {
  const sorted = segments.slice().sort((a, b) => a.from - b.from)
  const out = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && last.letter === s.letter && last.to === s.from) last.to = s.to
    else out.push({ letter: s.letter, from: s.from, to: s.to })
  }
  return out
}

function segmentsText(segments) {
  return segments.map(s => `${s.letter}面 ${fmtTime(s.from)}-${fmtTime(s.to)}`).join(', ')
}

async function clickNext(page) {
  await page.locator('.fixed-bottom ul.buttons button[class*="btn-primary"]').click({ timeout: 20000 })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1500)
}

async function handleLogin(page) {
  console.log('[edogawa] 需要登录')
  await humanPause()
  await humanType(page.locator('#UserLoginInputModel_Id'), process.env.EDOGAWA_USER_ID)
  await humanPause()
  await humanType(page.locator('#password'), process.env.EDOGAWA_PASSWORD)
  await humanPause()
  await page.click('.buttons button:has-text("ログイン")')
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(2000)
}

async function fillApplyDetail(page, platformConfig) {
  const purposeLabel = platformConfig.BOOK_PURPOSE || 'テニス（硬・軟式）'
  const people = platformConfig.BOOK_PEOPLE != null ? String(platformConfig.BOOK_PEOPLE) : '6'
  const eventName = platformConfig.BOOK_EVENT_NAME || 'テニス練習'

  // 用途 radio：每个利用枠可能各有一个 radio 组，逐个勾选（已选中的再次点击无副作用）
  const purposeLabels = page.locator(`label.custom-control-label:has-text("${purposeLabel}")`)
  const purposeCount = await purposeLabels.count()
  for (let i = 0; i < purposeCount; i++) {
    await purposeLabels.nth(i).click()
    await humanPause()
  }

  // 利用枠表格循环：站点按利用枠（可能按小时拆成多个表格）分别填 利用人数 + 催し物名
  const numberInputs = page.locator('input[name$=".Reservation.Number"][type="number"]')
  const itemCount = await numberInputs.count()
  if (itemCount === 0) throw new Error('未找到利用人数输入框')
  for (let i = 0; i < itemCount; i++) {
    await humanType(numberInputs.nth(i), people)
    await humanPauseAfterInput()
    const itemIdx = await numberInputs.nth(i).evaluate(el => {
      const m = el.name.match(/Items\[(\d+)\]/)
      return m ? m[1] : null
    })
    if (itemIdx != null) {
      const content = page.locator(`input[name="AvailabilityDetailModel.Items[${itemIdx}].Reservation.ObjectContents[1].Content"][type="text"]`)
      if (await content.count() > 0) {
        await humanType(content, eventName)
        await humanPauseAfterInput()
      }
    }
  }
  console.log(`[edogawa] 勾选用途 radio ×${purposeCount}, 填写利用枠 ×${itemCount}`)

  // 同意条款：label 点击绕过隐藏 checkbox 与 fixed-bottom 栏遮挡
  const agreeClicked = await page.evaluate(() => {
    const lbl = [...document.querySelectorAll('label.custom-control-label')]
      .find(l => l.textContent.includes('すべての注意事項を確認し、同意します'))
    if (lbl) { lbl.click(); return true }
    return false
  })
  if (!agreeClicked) throw new Error('未找到同意条款 label')
  await humanPause()
}

// 申込按钮初始 disabled，填完表单后启用；点击后弹确认框，再点 はい
async function submitApply(page) {
  const enabled = await page.waitForFunction(() => {
    const btn = [...document.querySelectorAll('.fixed-bottom ul.buttons button')]
      .find(b => b.textContent.includes('申込'))
    return btn && !btn.disabled && !btn.hasAttribute('disabled')
  }, { timeout: 20000 }).then(() => true).catch(() => false)
  if (!enabled) return { ok: false, message: '申込按钮一直不可用' }

  await humanPause()
  await page.locator('.fixed-bottom ul.buttons button:has-text("申込")').click({ timeout: 15000 })
  await page.waitForTimeout(2000)

  const confirmBtn = page.locator('.modal-dialog button:has-text("はい")')
  if (await confirmBtn.count() === 0) {
    const modal = page.locator('.modal-dialog')
    if (await modal.count() > 0) {
      return { ok: false, message: `出现弹窗: ${(await modal.first().innerText()).slice(0, 200)}` }
    }
    return { ok: false, message: `未出现确认弹窗, URL: ${page.url()}` }
  }

  await humanPause()
  await confirmBtn.first().click()
  await page.waitForTimeout(2500)
  await page.waitForLoadState('networkidle').catch(() => {})
  return { ok: true, url: page.url() }
}

// 从申请明细页抓取费用：
//   - 设施费: dt 含「施設使用料」的 dl，其 dd 金额求和
//   - 照明料: dt 含「備品使用料」的 dl，其 dd 金额求和
//   - 合计: class=total-fee 下 class=fee 的文本
// 任一缺失即返回 null（不阻断预约）
async function extractFee(page) {
  try {
    const total = await page
      .locator('.total-fee .fee')
      .first()
      .textContent({ timeout: 3000 })
      .then(t => parseYen(t))
      .catch(() => null)

    const sums = await page.evaluate(() => {
      const out = { facility: 0, lighting: 0 }
      for (const dl of document.querySelectorAll('dl.dl-item.mr-2')) {
        // 每个利用枠的费用行会在折叠体表单区重复一份（带 narrow wide 类），只统计 header 的实际行
        if (dl.classList.contains('narrow')) continue
        const dt = dl.querySelector('dt')
        const dd = dl.querySelector('dd')
        if (!dt || !dd) continue
        const label = dt.textContent || ''
        const n = parseInt(String(dd.textContent || '').replace(/[^\d]/g, ''), 10)
        if (Number.isNaN(n)) continue
        if (label.includes('施設使用料')) out.facility += n
        if (label.includes('備品使用料')) out.lighting += n
      }
      return out
    })

    const fee = {
      facility: sums.facility || null,
      lighting: sums.lighting || null,
      total: total ?? null
    }
    if (fee.facility == null && fee.lighting == null && fee.total == null) return null
    return fee
  } catch {
    return null
  }
}

// "1,234 円" / "1234円" → 1234；解析失败返回 null
function parseYen(text) {
  const m = String(text || '').match(/(\d[\d,]*)\s*円/)
  if (!m) return null
  return Number(m[1].replace(/,/g, ''))
}

/**
 * 执行预约
 * @param {EdogawaAdapter} adapter - 平台适配器（提供 _baseUrl）
 * @param {Object} slotData - { place, court, date, start, end, time, ... }
 * @param {Object} platformConfig - 平台配置（SCAN_DAYS / BOOK_*）
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function bookSlot(adapter, slotData, platformConfig) {
  const baseUrl = adapter._baseUrl
  if (!baseUrl) return { success: false, message: 'EDOGAWA_BASE_URL 未配置' }
  if (!process.env.EDOGAWA_USER_ID || !process.env.EDOGAWA_PASSWORD) {
    return { success: false, message: 'EDOGAWA_USER_ID / EDOGAWA_PASSWORD 未配置' }
  }
  setHumanPauseRange(platformConfig.HUMAN_DELAY_MIN, platformConfig.HUMAN_DELAY_MAX, platformConfig.HUMAN_INPUT_EXTRA_MS)
  const startOffset = Number(platformConfig.SCAN_START_OFFSET) > 0 ? Number(platformConfig.SCAN_START_OFFSET) : 2
  let scanDays = Number(platformConfig.SCAN_DAYS) > 0 ? Number(platformConfig.SCAN_DAYS) : 14
  if (platformConfig.SCAN_UNTIL_NEXT_MONTH_END) {
    scanDays = daysToEndOfNextMonth(addDaysJst(todayJst(), startOffset))
  }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT })
    const req = createReq(context, baseUrl)
    const page = await context.newPage()

    // 1. 导航到 SelectDays 页，拿到各期窗口
    const nav = await navigateToMonth(req, [slotData.place], scanDays, startOffset)
    if (!nav) return { success: false, message: `导航失败，设施 ${slotData.place} 不可用或站点变动` }
    const { formFields, token3, periods } = nav

    // 2. 定位目标日期所在周期，紧接 SearchCondition 拉取该期月视图，再找 some cells
    //    （跨面拼接时段需要同时勾选多个面，一个 Next 打开合并时间页）
    const dateKey = String(slotData.date || '').slice(0, 10)
    const period = periods.find(p => p.startDate <= dateKey && dateKey <= p.endDate)
    if (!period) {
      return { success: false, message: `未找到 ${slotData.place} ${dateKey} 的空位（目标日期在扫描窗口外）` }
    }
    const { startDate, displayTerm } = period
    const month = await queryMonth(req, formFields, token3, startDate, displayTerm)
    let someCells = findSomeCells(month, slotData)
    if (someCells.length === 0) {
      const legacy = findSomeCell(month, slotData)
      if (!legacy) {
        return { success: false, message: `未找到 ${slotData.place} ${dateKey} 的空位（可能已被预约）` }
      }
      someCells = [legacy]
    }
    if (someCells.length > 10) someCells = someCells.slice(0, 10)

    // 3. 多点 Next → 时间页地址
    const fd4 = buildNextPayload(month, someCells, formFields, token3, startDate, displayTerm)
    let res = await req('/user/AvailabilityCheckApplySelectDays/Next', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: fd4.toString()
    })
    const nextBody = await res.text()
    if (!nextBody.includes('Result')) {
      return { success: false, message: `Next 异常响应: ${nextBody.slice(0, 120)}` }
    }
    const nextInfo = JSON.parse(JSON.parse(nextBody))
    if (nextInfo.Result !== 'Ok') {
      return { success: false, message: `Next 失败: ${JSON.stringify(nextInfo.Information)}` }
    }
    const timeUrl = nextInfo.Information?.MessageId || ''
    if (!timeUrl) return { success: false, message: '未获得时间页地址' }

    // 4. 打开时间页
    await page.goto(baseUrl + (timeUrl.startsWith('.') ? '/user/' + timeUrl.slice(2) : timeUrl), { waitUntil: 'networkidle' })
    await page.waitForTimeout(1000)

    // 5. 勾选目标时段
    const sel = await selectTimeCells(page, slotData)
    const missingSegs = mergeSegments(sel.missing.map(m => ({ letter: m.letter, from: m.hour, to: m.hour + 100 })))
    const remainSegs = mergeSegments(sel.selectedCells)
    if (!sel.ok) {
      // 一个时段都没勾上：若是拼接序列，说明期望的全部时段都已没了
      if (sel.expectedCount > 0) {
        return { success: false, message: `预约失败（场地/时间已变）: ${segmentsText(missingSegs)} 已被预约` }
      }
      return { success: false, message: sel.reason || '未找到匹配的空闲时段' }
    }
    // 拼接序列必须完整勾选，避免只约到部分场地；不匹配时明确提示哪些面/时段没了、还剩哪些
    if (sel.expectedCount > 0 && sel.selected !== sel.expectedCount) {
      const gone = segmentsText(missingSegs)
      const remain = segmentsText(remainSegs)
      return { success: false, message: `预约失败（场地/时间已变）: ${gone} 已被预约；剩余可约 ${remain}` }
    }
    console.log(`[edogawa] 勾选 ${sel.selected} 个时段: ${sel.log.join('; ')}`)

    // 6. 次へ進む → 若需登录则登录
    await clickNext(page)
    if (page.url().includes('Login')) {
      await handleLogin(page)
    }

    // 7. 申请明细
    await fillApplyDetail(page, platformConfig)
    const fee = await extractFee(page)

    // 8. 提交（含确认弹窗）
    const result = await submitApply(page)
    if (!result.ok) return { success: false, message: result.message }

    console.log(`[edogawa] 预约成功: ${slotData.place} ${slotData.date} ${slotData.time}`, fee ? `费用 ${fee.total ?? '-'}円` : '')
    return { success: true, message: `已提交预约: ${slotData.place} ${slotData.date} ${slotData.time}`, fee }
  } catch (e) {
    console.log(`[edogawa] 预约失败:`, e.message)
    return { success: false, message: e.message }
  } finally {
    await browser.close()
  }
}

module.exports = {
  bookSlot,
  createReq,
  findSomeCell,
  findSomeCells,
  courtLetter,
  parseCourts,
  selectTimeCells,
  clickNext,
  handleLogin,
  fillApplyDetail,
  submitApply,
  extractFee,
  toHHMM
}
