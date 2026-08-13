/**
 * Ichikawa 平台适配器
 *
 * 负责：
 * - 登录预约网站
 * - 获取空位
 * - 执行预约
 *
 * 每个方法自行管理浏览器生命周期
 */
const { chromium } = require('playwright')
const { sleep, createTrace, normalizeTimeRange, formatDateDisplayFromIso, setHumanPauseRange } = require('@tennis-bot/utils')
const { parsePage } = require('./parser')
const { clickSlot } = require('./booking')
const {
  navigateToSports,
  selectPlaces,
  selectDuration,
  autoSelectWeekdays,
  handleLoginIfNeeded,
  clickApply,
  getSkipCourtContains
} = require('./login')

const PLATFORM_NAME = 'ichikawa'

function create() {
  const baseUrl = process.env.ICHIKAWA_BASE_URL
  if (!baseUrl) {
    throw new Error('[ichikawa] ICHIKAWA_BASE_URL 未设置，请在 .env 中配置目标网站地址')
  }
  return new IchikawaAdapter(baseUrl)
}

class IchikawaAdapter {
  constructor(baseUrl) {
    this._baseUrl = baseUrl
  }
  get name() {
    return PLATFORM_NAME
  }

  /**
   * 扫描空位
   * @param {Object} platformConfig - 平台配置
   * @returns {Promise<Object[]>} Slot 数组
   */
  async fetchSlots(platformConfig) {
    const trace = createTrace()
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox']
    })

    try {
      const page = await browser.newPage()

      // 导航到スポーツ施設选择
      await navigateToSports(page, this._baseUrl)

      // 选择场地
      const places = platformConfig.TARGET_PLACE || []
      await selectPlaces(page, places, platformConfig.STEP_DELAY || 500)

      // 选择表示期间
      const durationText = this._getDurationText(platformConfig)
      await selectDuration(page, durationText, platformConfig.STEP_DELAY || 500)

      // 自动选择星期
      await autoSelectWeekdays(page, platformConfig)

      // 下一步
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle' }),
        page.click('#ucPCFooter_btnForward')
      ])

      // 解析数据
      const skipCourtContains = getSkipCourtContains(platformConfig)
      const rawData = await parsePage(page, skipCourtContains)

      // 标准化
      const slots = rawData.map(d => {
        const date = d.date
        const time = normalizeTimeRange(d.time)
        const dateDisplay = d.dateDisplay || formatDateDisplayFromIso(date)
        const startHour = time.split('-')[0]
        const endHour = time.split('-')[1]
        return {
          platform: PLATFORM_NAME,
          place: d.place,
          court: d.court,
          date,
          start: `${startHour}:00`,
          end: `${endHour}:00`,
          duration: (Number(endHour) - Number(startHour)) * 60,
          available: true,
          _raw: d
        }
      })

      // 不在 adapter 层记日志：monitor 已按周期汇总「N 空位 无变化/DIFF」，避免重复刷屏
      return slots

    } finally {
      await browser.close()
    }
  }

  /**
   * 执行预约
   * @param {Object} slotData - 包含 _raw 原始数据的 slot 信息
   * @param {Object} platformConfig - 平台配置
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async book(slotData, platformConfig) {
    const trace = createTrace()
    setHumanPauseRange(platformConfig.HUMAN_DELAY_MIN, platformConfig.HUMAN_DELAY_MAX, platformConfig.HUMAN_INPUT_EXTRA_MS)
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox']
    })

    try {
      const page = await browser.newPage()

      // 导航
      await navigateToSports(page, this._baseUrl)

      // 选择场地
      await selectPlaces(page, [slotData.place], platformConfig.STEP_DELAY || 500)

      // 选择表示期间
      const durationText = this._getDurationText(platformConfig)
      await selectDuration(page, durationText, platformConfig.STEP_DELAY || 500)

      // 自动选择星期
      await autoSelectWeekdays(page, platformConfig)

      // 下一步
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle' }),
        page.click('#ucPCFooter_btnForward')
      ])

      // 点击目标 slot
      const raw = slotData._raw || slotData
      await clickSlot(page, raw)

      // 提交
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle' }),
        page.click('#ucPCFooter_btnForward')
      ])

      await handleLoginIfNeeded(page)
      await clickApply(page)

      console.log(`[ichikawa] 预约成功: ${slotData.place} ${slotData.date} ${slotData.start}`)
      return { success: true, message: '' }

    } catch (e) {
      console.log(`[ichikawa] 预约失败:`, e.message)
      return { success: false, message: e.message }
    } finally {
      await browser.close()
    }
  }

  _getDurationText(config) {
    const map = config.BOOK_DURATION_MAP
    const dur = config.BOOK_DURATION
    return map?.[dur] || '1ヶ月'
  }
}

module.exports = { create }
