const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

// 剥离 JSON 字符串中的 // 行注释与 /* */ 块注释（字符串内的 // 会保留），支持配置文件里的注释
function stripJsonComments(jsonStr) {
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  let out = ''
  for (let i = 0; i < jsonStr.length; i++) {
    const c = jsonStr[i]
    const next = jsonStr[i + 1]
    if (inLineComment) {
      if (c === '\n') { inLineComment = false; out += c }
      continue
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') { inBlockComment = false; i++ }
      continue
    }
    if (inString) {
      out += c
      if (c === '\\') { out += next || ''; i++ }
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; out += c; continue }
    if (c === '/' && next === '/') { inLineComment = true; i++; continue }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue }
    out += c
  }
  return out
}

// 按 .yaml → .yml → .json 顺序返回第一个存在的配置文件路径（都不存在返回 null）
function resolveConfigPath(configDir, name) {
  for (const ext of ['.yaml', '.yml', '.json']) {
    const p = path.join(configDir, name + ext)
    if (fs.existsSync(p)) return p
  }
  return null
}

// 按扩展名解析配置文件：.yaml/.yml 用 js-yaml，.json 用 JSON（兼容注释）
function readConfigFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8')
  if (/\.ya?ml$/i.test(filePath)) {
    return yaml.load(content)
  }
  return JSON.parse(stripJsonComments(content))
}

class ConfigManager {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.configDir = path.join(dataDir, 'config')
    this.global = {}
    this._platforms = {}
    this._globalPath = null
    this._platformPaths = {}
  }

  load() {
    fs.mkdirSync(this.configDir, { recursive: true })

    // 加载全局配置（支持 global.yaml / global.yml / global.json）
    this._globalPath = resolveConfigPath(this.configDir, 'global')
    if (this._globalPath) {
      this.global = readConfigFile(this._globalPath)
    } else {
      this.global = {}
    }

    // 加载所有平台配置（跳过 global 文件，按去扩展名的 basename 作为平台名）
    this._platforms = {}
    this._platformPaths = {}
    const files = fs.readdirSync(this.configDir)
    for (const file of files) {
      if (!/\.(json|yaml|yml)$/i.test(file)) continue
      const platformName = file.replace(/\.(json|yaml|yml)$/i, '')
      if (platformName === 'global') continue
      const filePath = path.join(this.configDir, file)
      this._platforms[platformName] = readConfigFile(filePath)
      this._platformPaths[platformName] = filePath
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
    const writeFile = (filePath, data) => {
      if (/\.ya?ml$/i.test(filePath)) {
        fs.writeFileSync(filePath, yaml.dump(data, { noRefs: true, lineWidth: -1 }))
      } else {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
      }
    }

    if (this._globalPath) {
      writeFile(this._globalPath, this.global)
    } else if (Object.keys(this.global).length > 0) {
      writeFile(path.join(this.configDir, 'global.yaml'), this.global)
    }

    for (const [name, config] of Object.entries(this._platforms)) {
      const filePath = this._platformPaths[name] || path.join(this.configDir, `${name}.yaml`)
      writeFile(filePath, config)
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
