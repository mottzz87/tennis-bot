/**
 * Ichikawa 登录相关功能
 */
const { sleep, clickByText, humanType, humanPause } = require('@tennis-bot/utils')

async function handleLoginIfNeeded(page) {
  const btn = page.locator('#ucPCFooter_btnForward')
  if (!(await btn.isVisible())) return

  const value = await btn.inputValue()
  if (!value.includes('ログイン')) return

  console.log('[ichikawa] 需要登录')

  await humanType(page.locator('#txtID'), process.env.USER_ID)
  await humanPause(400, 1000)
  await humanType(page.locator('#txtPass'), process.env.PASSWORD)
  await humanPause(500, 1200)

  await Promise.all([
    page.waitForNavigation(),
    btn.click()
  ])
}

async function clickApply(page) {
  const btn = page.locator('#ucPCFooter_btnForward')
  const value = await btn.inputValue()

  if (value.includes('申込')) {
    console.log('[ichikawa] 提交预约')
    await humanPause(600, 1500)
    await Promise.all([
      page.waitForNavigation(),
      btn.click()
    ])
  }
}

/**
 * 进入预约系统首页并选择スポーツ施設
 * @param {Page} page - Playwright page
 * @param {string} baseUrl - 从环境变量读取的 BASE_URL
 */
async function navigateToSports(page, baseUrl) {
  if (!baseUrl) throw new Error('BASE_URL 未设置')
  await page.goto(baseUrl)
  await clickByText(page, 'スポーツ施設')
}

/**
 * 选择场地并进入下一步
 */
async function selectPlaces(page, places, stepDelay) {
  for (const place of places) {
    await clickByText(page, place)
    await sleep(stepDelay)
  }
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('#ucPCFooter_btnForward')
  ])
}

/**
 * 选择表示期间
 */
async function selectDuration(page, durationText, stepDelay) {
  await clickByText(page, durationText)
  await sleep(stepDelay)
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('#ucPCFooter_btnForward')
  ])
}

/**
 * 自动选择星期（周末优先）
 */
async function autoSelectWeekdays(page, platformConfig) {
  const autoWeekdays = platformConfig.AUTO_WEEKDAY_FILTER || []
  const skipCourtContains = getSkipCourtContains(platformConfig)

  await page.evaluate(({ autoWeekdays, skipCourtContains }) => {
    let count = 0
    const MAX = 10

    const shouldSkipCourtRow = (rowCourtNorm) =>
      Array.isArray(skipCourtContains) &&
      skipCourtContains.some(sub => sub && rowCourtNorm.includes(sub))

    const weekdayMap = {
      '日': 0, '月': 1, '火': 2, '水': 3,
      '木': 4, '金': 5, '土': 6
    }

    const preferred = autoWeekdays.map(w => weekdayMap[w])
    const tables = document.querySelectorAll('table[id*="dgTable"]')
    const candidates = []

    tables.forEach(table => {
      const rows = table.querySelectorAll('tr')
      if (rows.length === 0) return
      const headers = rows[0].querySelectorAll('td')
      const h1 = String(headers[1]?.innerText || '').replace(/\s/g, '')
      const slot0 = h1.includes('定員') ? 2 : 1
      const row0Wd = String(headers[0]?.innerText || '')
        .replace(/\s/g, '').match(/（([月火水木金土日])）/)
      const rowWeekday = row0Wd ? row0Wd[1] : null

      const colWeekdays = []
      for (let i = slot0; i < headers.length; i++) {
        const text = headers[i].innerText.replace(/\s/g, '')
        const m = text.match(/（([月火水木金土日])）/)
        colWeekdays.push(m ? m[1] : rowWeekday)
      }

      for (let i = 1; i < rows.length; i++) {
        const tds = rows[i].querySelectorAll('td')
        const rowCourt = (tds[0]?.innerText || '').replace(/\s/g, '')
        if (shouldSkipCourtRow(rowCourt)) continue
        for (let j = slot0; j < tds.length; j++) {
          const link = tds[j].querySelector('a')
          if (!link) continue
          const val = link.innerText.replace(/\s/g, '')
          if (val !== '○' && val !== '△') continue
          const weekday = colWeekdays[j - slot0]
          candidates.push({ el: link, weekday })
        }
      }
    })

    for (const c of candidates) {
      if (count >= MAX) break
      const wd = weekdayMap[c.weekday]
      if (preferred.includes(wd)) {
        c.el.click()
        c.el.dataset.selected = '1'
        count++
      }
    }
    for (const c of candidates) {
      if (count >= MAX) break
      if (c.el.dataset.selected) continue
      c.el.click()
      count++
    }
  }, { autoWeekdays, skipCourtContains })
}

function getSkipCourtContains(cfg) {
  const raw = cfg?.SKIP_COURT_CONTAINS
  if (!Array.isArray(raw)) return []
  return raw.map(s => String(s || '').trim()).filter(Boolean)
}

module.exports = {
  handleLoginIfNeeded,
  clickApply,
  navigateToSports,
  selectPlaces,
  selectDuration,
  autoSelectWeekdays,
  getSkipCourtContains
}
