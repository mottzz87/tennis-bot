/**
 * @typedef {Object} Slot
 * @property {string} platform - 平台标识 (ichikawa, edogawa, ...)
 * @property {string} place - 场地名
 * @property {string} court - 球场名
 * @property {string} date - 日期 YYYY-MM-DD
 * @property {string} start - 开始时间 HH:MM
 * @property {string} end - 结束时间 HH:MM
 * @property {number} duration - 时长（分钟）
 * @property {boolean} available - 是否可预约
 */

/**
 * @typedef {Object} BookedSlot
 * @property {string} uid - 唯一ID
 * @property {string} ucode - 用于按钮回调的编码
 * @property {string} platform - 平台标识
 * @property {string} place - 场地名
 * @property {string} court - 球场名
 * @property {string} date - 日期 YYYY-MM-DD
 * @property {string} time - 时间范围 (e.g. "18-20")
 * @property {string} dateDisplay - 显示用日期 (e.g. "7.24（水）")
 * @property {boolean} reminderEnabled - 是否开启提醒
 * @property {number} bookedAt - 预约时间戳
 * @property {string} create - 创建时间字符串
 */

/**
 * @typedef {Object} BookingResult
 * @property {boolean} success
 * @property {string} message
 */

/**
 * @typedef {Object} ReminderEntry
 * @property {number} chatId
 * @property {number} messageId
 */

module.exports = {}
