const fs = require('fs')
const path = require('path')

class ConfigManager {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.configDir = path.join(dataDir, 'config')
    this.global = {}
    this._platforms = {}
  }

  load() {
    fs.mkdirSync(this.configDir, { recursive: true })

    // 加载全局配置
    const globalPath = path.join(this.configDir, 'global.json')
    if (fs.existsSync(globalPath)) {
      this.global = JSON.parse(fs.readFileSync(globalPath, 'utf-8'))
    } else {
      this.global = {}
    }

    // 加载所有平台配置
    this._platforms = {}
    const files = fs.readdirSync(this.configDir)
    for (const file of files) {
      if (file === 'global.json') continue
      if (!file.endsWith('.json')) continue
      const platformName = file.replace('.json', '')
      const filePath = path.join(this.configDir, file)
      this._platforms[platformName] = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    }

    return this
  }

  getPlatform(name) {
    return this._platforms[name] || {}
  }

  getAllPlatforms() {
    return { ...this._platforms }
  }

  getPlatformNames() {
    return Object.keys(this._platforms)
  }

  save() {
    const globalPath = path.join(this.configDir, 'global.json')
    fs.writeFileSync(globalPath, JSON.stringify(this.global, null, 2))

    for (const [name, config] of Object.entries(this._platforms)) {
      const filePath = path.join(this.configDir, `${name}.json`)
      fs.writeFileSync(filePath, JSON.stringify(config, null, 2))
    }
  }

  set(key, value) {
    this.global[key] = value
  }

  setPlatform(platform, key, value) {
    if (!this._platforms[platform]) this._platforms[platform] = {}
    this._platforms[platform][key] = value
  }

  /**
   * 获取平台 PLACE_MAP 及其相关配置的快捷方式
   * 按名称匹配平台配置，兼容原有代码
   */
  getPlatformConfig(platformName) {
    return this._platforms[platformName] || {}
  }

  /**
   * 获取合并后的配置（global + platform），platform 优先级高于 global
   */
  getMergedConfig(platformName) {
    return { ...this.global, ...this.getPlatformConfig(platformName) }
  }

  /**
   * 获取某个 key 的有效值：platform 有值则用 platform，否则用 global
   */
  getEffective(key, platformName) {
    const pc = this.getPlatformConfig(platformName)
    if (pc && key in pc) return pc[key]
    return this.global[key]
  }

  /**
   * 从对象加载配置（替代从文件加载）
   * 用于跨服务部署时从 Monitor API 获取配置
   */
  loadFromData(data) {
    if (data && typeof data === 'object') {
      this.global = data.global || {}
      this._platforms = data.platforms || {}
    }
    return this
  }
}

module.exports = ConfigManager
