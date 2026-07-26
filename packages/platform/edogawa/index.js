/**
 * Edogawa 平台适配器（骨架）
 *
 * TODO: 实现 Edogawa 实际预约流程
 */
const PLATFORM_NAME = 'edogawa'

function create() {
  const baseUrl = process.env.EDOGAWA_BASE_URL
  if (!baseUrl) {
    console.warn('[edogawa] EDOGAWA_BASE_URL 未设置，需配置后才可使用')
  }
  return new EdogawaAdapter(baseUrl)
}

class EdogawaAdapter {
  constructor(baseUrl) {
    this._baseUrl = baseUrl
  }

  get name() {
    return PLATFORM_NAME
  }

  async fetchSlots(platformConfig) {
    if (!this._baseUrl) {
      console.log('[edogawa] BASE_URL 未配置，跳过')
      return []
    }
    console.log('[edogawa] fetchSlots 未实现，返回空')
    return []
  }

  async book(slotData, platformConfig) {
    if (!this._baseUrl) {
      return { success: false, message: 'EDOGAWA_BASE_URL 未配置' }
    }
    console.log('[edogawa] book 未实现')
    return { success: false, message: '未实现' }
  }
}

module.exports = { create }
