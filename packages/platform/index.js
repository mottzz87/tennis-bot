const path = require('path')

const PLATFORM_DIR = __dirname

const _cache = {}

/**
 * 加载指定平台的适配器
 * @param {string} name - 平台名 (ichikawa, edogawa, ...)
 * @returns {Object|null} 平台适配器实例
 */
function loadPlatform(name) {
  if (_cache[name]) return _cache[name]

  try {
    const mod = require(path.join(PLATFORM_DIR, name))
    const instance = mod.create ? mod.create() : mod
    _cache[name] = instance
    return instance
  } catch (e) {
    console.error(`[platform] 加载 ${name} 失败:`, e.message)
    return null
  }
}

/**
 * 获取所有已注册的平台列表
 */
function getPlatformNames() {
  return ['ichikawa', 'edogawa']
}

module.exports = { loadPlatform, getPlatformNames }
