/**
 * Ichikawa 登录相关功能
 */
const { sleep, clickByText, humanType, humanPause } = require('@tennis-bot/utils')

const FORWARD_SEL = '#ucPCFooter_btnForward'
const CLICK_TIMEOUT = 15000
const NAV_TIMEOUT = 30000

// 页面内容签名：URL + 表格数 + 正文前 200 字，用于确认 postback 后页面是否真的换了
function pageSignature(page) {
  return page.evaluate(() => {
    const t = document.body ? document.body.innerText : ''
    return `${location.href}|${document.querySelectorAll('table').length}|${t.length}|${t.slice(0, 200)}`
  }).catch(() => '')
}

/**
 * 点击「次へ >>」并等待 ASP.NET postback 返回新页面。
 *
 * 两个坑：
 * 1) click() 自身会等待它触发的导航，外面再套 waitForNavigation 等于同一个导航等两遍。
 * 2) networkidle 要求 500ms 内零网络活动，站点有慢子资源时永远等不到；postback 返回的是
 *    服务端渲染的完整 HTML，domcontentloaded 已足够解析。
 * 导航等待超时后用内容签名兜底确认，避免误判失败丢掉整轮扫描。
 */
async function clickForward(page) {
  const before = await pageSignature(page)
  const navigated = page
    .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
    .then(() => true, () => false)

  await page.click(FORWARD_SEL, { noWaitAfter: true, timeout: CLICK_TIMEOUT })
  if (await navigated) return
  if (await pageSignature(page) !== before) return

  throw new Error(`点击 ${FORWARD_SEL} 后页面无变化（等待 ${NAV_TIMEOUT}ms）`)
}

async function handleLoginIfNeeded(page) {
  const btn = page.locator(FORWARD_SEL)
  if (!(await btn.isVisible())) return

  const value = await btn.inputValue()
  if (!value.includes('ログイン')) return

  console.log('[ichikawa] 需要登录')

  await humanType(page.locator('#txtID'), process.env.USER_ID)
  await humanPause()
  await humanType(page.locator('#txtPass'), process.env.PASSWORD)
  await humanPause()

  await clickForward(page)
}

const ICHI_ERROR_RE = /エラー|error|既に予約|予約されています|予約済み|申込済み|登録済み|予約できません|申込できません|申し込みできません|失敗しました|空きがありません|空きがない|満席|受付終了|時間切れ|セッション/i

function pickIchiError(bodyText) {
  const t = String(bodyText || '')
  const line = t.split('\n').map(s => s.trim()).filter(Boolean).find(s => ICHI_ERROR_RE.test(s))
  return line ? line.slice(0, 200) : ''
}

// 提交 申込 后必须验证真实结果：成功会跳转完成页，失败会停留在原页/跳错误页显示错误文案。
// 只有确认成功才返回 ok:true，避免"假预约成功"。
async function clickApply(page) {
  const btn = page.locator(FORWARD_SEL)
  const value = await btn.inputValue()

  if (!value.includes('申込')) {
    return { ok: false, message: '未找到 申込 按钮' }
  }

  console.log('[ichikawa] 提交预约')
  await humanPause()
  // 不把「页面跳转成功」当作预约成功：无论跳转等不等得到，都回到页面核对真实结果
  await clickForward(page).catch(() => {})
  await sleep(1500)

  const url = page.url()
  const bodyText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '')

  if (/login/i.test(url)) {
    return { ok: false, message: '提交时会话失效，被跳转到登录页' }
  }
  const errText = pickIchiError(bodyText)
  if (errText) {
    return { ok: false, message: `预约未成功: ${errText}` }
  }
  return { ok: true, url }
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
  await clickForward(page)
}

/**
 * 选择表示期间
 */
async function selectDuration(page, durationText, stepDelay) {
  await clickByText(page, durationText)
  await sleep(stepDelay)
  await clickForward(page)
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
  clickForward,
  navigateToSports,
  selectPlaces,
  selectDuration,
  autoSelectWeekdays,
  getSkipCourtContains
}
