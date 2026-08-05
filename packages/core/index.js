/**
 * Core — 平台无关业务逻辑
 *
 * 禁止出现任何平台判断 (if platform === 'ichikawa')
 * 所有平台差异仅在 packages/platform 中处理
 */
const {
  parseSlotDayKey,
  parseSlotStartDateTimeSafe,
  normalizeTimeRange,
  formatDateDisplayFromIso,
  normalizeCourtAlias,
  formatCourt,
  toMinutes,
  normalizeText,
  WEEKDAY_JP
} = require('@tennis-bot/utils')

// ========================
// Slot 过滤
// ========================

function matchTime(dTime, filter) {
  // 每个过滤项是一个时间段（如 "6-11" 表示起始时间 6:00-11:00），
  // 单项如 "12" 表示起始时间 >= 12:00；命中任意一个时间段即保留
  const start = String(dTime).split(/[～~\-]/)[0]
  const startMin = toMinutes(start)
  for (const item of filter) {
    const parts = String(item).trim().split(/[～~\-]/)
    const min = toMinutes(parts[0])
    if (parts.length < 2) {
      if (startMin >= min) return true
    } else {
      const max = toMinutes(parts[1])
      if (startMin >= min && startMin <= max) return true
    }
  }
  return false
}

// 从 dateDisplay（如 "8.08（土）"）或 date（ISO）解析星期，解析失败返回 null
function resolveWeekday(d) {
  const display = String(d.dateDisplay || '')
  const m1 = display.match(/[（(]([月火水木金土日])[）)]/)
  if (m1) return m1[1]
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '').trim())) {
    const [y, mo, day] = String(d.date).split('-').map(Number)
    return WEEKDAY_JP[new Date(y, mo - 1, day).getDay()]
  }
  const m2 = String(d.date || '').match(/[（(]([月火水木金土日])[）)]/)
  return m2 ? m2[1] : null
}

function filterSlotsByRules(data, rules) {
  const TIME_FILTER = rules.TIME_FILTER || []
  const WEEKDAY_FILTER = rules.WEEKDAY_FILTER || []
  const COURT_NUM_FILTER = rules.COURT_NUM_FILTER || []
  const PLACE_FILTER = rules.PLACE_FILTER || []
  const COURT_GROUP_FILTER = rules.COURT_GROUP_FILTER || []

  return data.filter(d => {
    const weekday = resolveWeekday(d)

    // 周末（土/日）默认全天可扫，不受 TIME_FILTER 限制
    if (TIME_FILTER.length > 0 && weekday !== '土' && weekday !== '日') {
      if (!matchTime(d.time || d.start, TIME_FILTER)) return false
    }

    if (WEEKDAY_FILTER.length > 0) {
      if (!weekday || !WEEKDAY_FILTER.includes(weekday)) return false
    }

    if (COURT_NUM_FILTER.length > 0) {
      const court = normalizeCourtAlias(formatCourt(d.court))
      if (!COURT_NUM_FILTER.some(c => court.includes(normalizeCourtAlias(c)))) return false
    }

    if (PLACE_FILTER.length > 0) {
      const placeStr = String(d.place || '')
      const placeN = normalizeText(placeStr)
      const hit = PLACE_FILTER.some(kw => {
        const k = String(kw || '').trim()
        if (!k) return false
        return placeStr.includes(k) || placeN.includes(normalizeText(k))
      })
      if (!hit) return false
    }

    // 场地组过滤（如 AUTO_COURT_GROUP: ["硬地"]，只自动抢硬地）
    if (COURT_GROUP_FILTER.length > 0 && !COURT_GROUP_FILTER.includes(d.group)) {
      return false
    }

    return true
  })
}

function filterSlotsByConfig(data, config) {
  return filterSlotsByRules(data, {
    TIME_FILTER: config.TIME_FILTER,
    WEEKDAY_FILTER: config.WEEKDAY_FILTER,
    COURT_NUM_FILTER: config.COURT_NUM_FILTER
  })
}

function getAutoRules(platformConfig) {
  return {
    TIME_FILTER: Array.isArray(platformConfig.AUTO_TIME_FILTER)
      ? platformConfig.AUTO_TIME_FILTER
      : platformConfig.TIME_FILTER,
    WEEKDAY_FILTER: Array.isArray(platformConfig.AUTO_WEEKDAY_FILTER)
      ? platformConfig.AUTO_WEEKDAY_FILTER
      : platformConfig.WEEKDAY_FILTER,
    COURT_NUM_FILTER: Array.isArray(platformConfig.AUTO_COURT_NUM_FILTER)
      ? platformConfig.AUTO_COURT_NUM_FILTER
      : [],
    PLACE_FILTER: Array.isArray(platformConfig.AUTO_PLACE_FILTER)
      ? platformConfig.AUTO_PLACE_FILTER
      : [],
    COURT_GROUP_FILTER: Array.isArray(platformConfig.AUTO_COURT_GROUP)
      ? platformConfig.AUTO_COURT_GROUP
      : []
  }
}

function filterSlotsAuto(data, platformConfig) {
  const rules = getAutoRules(platformConfig)
  const placeFilter = rules.PLACE_FILTER || []
  if (placeFilter.length > 0 && platformConfig.PLACE_MAP) {
    const expanded = [...placeFilter]
    for (const [placeName, meta] of Object.entries(platformConfig.PLACE_MAP)) {
      if (placeFilter.some(kw => kw === meta.short) && !expanded.includes(placeName)) {
        expanded.push(placeName)
      }
    }
    rules.PLACE_FILTER = expanded
  }
  return filterSlotsByRules(data, rules)
}

// ========================
// 连续时段合并
// ========================

// 连续时段合并，两级优先：
//   1) 同场地（place+date+court）内时间连续的，优先拼成整段（如 Ａ面 11-15 → "4A"）；
//   2) 只剩单条空位的，再跨场地按时间拼接凑满阈值（如 Ｄ面10-11 + Ｃ面11-12 → "DC"）。
// 已拼入整段的场地不会被二次使用；所有输出总时长均 >= minMinutes，不足阈值（含 1h 单条）丢弃。
// 输出带 courts 字段：按拼接先后顺序排列的场地计数序列（如 "4J" / "DC"）。
// preferredWindows（可选，如 ["7-9","16-18"]）：黄金时段。连续链在黄金时段边界处断开，
// 使拼接结果尽可能落在某个黄金时段内（如 7-11 → 7-9 + 9-11），不配置时保持原最长链行为。
function mergeContiguousSlots(slots, minMinutes, preferredWindows) {
  if (!Array.isArray(slots) || slots.length === 0) return []

  const out = []
  const leftover = []

  const hasGolden = Array.isArray(preferredWindows) && preferredWindows.length > 0

  // cell [start, end] 是否完整落在某个黄金时段内
  const inGoldenWindow = s => {
    if (!hasGolden) return false
    const st = toMinutes(s.start)
    const en = toMinutes(s.end)
    if (!st || !en) return false
    return preferredWindows.some(w => {
      const [gs, ge] = String(w).split(/[~\-]/)
      const gsMin = toMinutes(gs)
      const geMin = toMinutes(ge)
      if (!gsMin || !geMin || geMin <= gsMin) return false
      return st >= gsMin && en <= geMin
    })
  }

  const buildMerged = run => {
    const totalMin = run.reduce((a, s) => a + Number(s.duration || 60), 0)
    const courts = courtSeq(run)
    return {
      platform: run[0].platform,
      place: run[0].place,
      court: combinedCourtName(run, courts),
      date: run[0].date,
      start: run[0].start,
      end: run[run.length - 1].end,
      duration: totalMin,
      available: true,
      courts,
      group: run[0].group
    }
  }

  // 排序后连续拼接；golden 边界（黄金时段内/外切换）处也断开
  const chainSorted = (list, emit) => {
    const run = []
    let curInside = false
    const flush = () => {
      if (run.length === 0) return
      emit(run)
      run.length = 0
    }
    list
      .slice()
      .sort((a, b) => String(a.start).localeCompare(String(b.start)))
      .forEach(s => {
        const prev = run[run.length - 1]
        const inside = inGoldenWindow(s)
        const goldenBreak = prev && curInside !== inside
        if (prev && (prev.end !== s.start || goldenBreak)) flush()
        if (run.length === 0) curInside = inside
        run.push(s)
      })
    flush()
  }

  // 阶段一：同场地优先拼接
  const groups = new Map()
  for (const s of slots) {
    const key = `${s.place}|${s.date}|${s.court}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(s)
  }
  for (const list of groups.values()) {
    chainSorted(list, run => {
      const totalMin = run.reduce((a, s) => a + Number(s.duration || 60), 0)
      if (run.length === 1 && totalMin < minMinutes) {
        leftover.push(run[0]) // 单条且不足阈值 → 阶段二尝试跨场地
      } else if (totalMin >= minMinutes) {
        out.push(buildMerged(run))
      } else {
        leftover.push(...run) // 罕见：多段但不足阈值 → 退回单条
      }
    })
  }

  // 阶段二：单条空位跨场地按时间拼接，不足 minMinutes（含凑不满的单条）丢弃
  // 按 场地+日期+组 分组，同组才拼（硬地/人工芝不互相拼接）
  const looseGroups = new Map()
  for (const s of leftover) {
    const key = `${s.place}|${s.date}|${s.group || ''}`
    if (!looseGroups.has(key)) looseGroups.set(key, [])
    looseGroups.get(key).push(s)
  }
  for (const list of looseGroups.values()) {
    chainSorted(list, run => {
      const totalMin = run.reduce((a, s) => a + Number(s.duration || 60), 0)
      if (totalMin >= minMinutes) out.push(buildMerged(run))
    })
  }

  return out
}

// 拼接顺序的场地序列：连续同一场地合并为"N字母"，N>1 才带小时数
// （Ａ面12-13+Ａ面13-14 → "2A"；Ａ面12-13+Ｂ面13-14 → "AB"）
function courtSeq(run) {
  const groups = []
  for (const s of run) {
    const letter = courtLetter(s.court)
    const hours = (Number(s.duration) || 60) / 60
    const last = groups[groups.length - 1]
    if (last && last.letter === letter) last.hours += hours
    else groups.push({ letter, hours })
  }
  return groups.map(g => g.hours > 1 ? `${trimHourNum(g.hours)}${g.letter}` : g.letter).join('')
}

function trimHourNum(h) {
  return Number.isInteger(h) ? String(h) : String(+h.toFixed(1))
}

// 跨面拼接时用组合场地名（"GB" → "GB面"，"2GB" → "2GB面"），单面/同面多时段保留原名
function combinedCourtName(run, courts) {
  const letters = String(courts || '').replace(/\d+/g, '')
  if (letters && new Set(letters).size > 1) return `${courts}面`
  return run[0].court
}

// "水辺テニスＡ面" → "A"；"Ａ面" → "A"；兜底取名字首字符
function courtLetter(court) {
  const name = String(court || '')
  const m = name.match(/([Ａ-Ｚ])(?=面)/)
  if (m) return String.fromCharCode(m[1].charCodeAt(0) - 0xFEE0)
  const m2 = name.match(/([A-Z])(?=面)/)
  if (m2) return m2[1]
  return name.slice(0, 1) || '?'
}

// ========================
// 场地组（court group）判定
// ========================

// 归一化配置里的字母："Ａ"/"ａ"/"a" → "A"
function normalizeCourtLetter(s) {
  return String(s || '')
    .replace(/[Ａ-Ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[ａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .toUpperCase()
    .replace(/\s+/g, '')
}

// 某场地是否命中组规则：命中任意 letters（字母）或 keywords（场地名关键词）即算命中
function matchCourtGroup(g, letter, courtNorm) {
  if (Array.isArray(g.letters) && g.letters.length) {
    const letters = g.letters.map(normalizeCourtLetter).filter(Boolean)
    if (letter && letters.includes(letter)) return true
  }
  if (Array.isArray(g.keywords) && g.keywords.length) {
    if (g.keywords.some(k => courtNorm.includes(normalizeText(k)))) return true
  }
  return false
}

/**
 * 按配置 COURT_GROUPS 判定某场地的组标签。
 * @param {string} court - 场地名（如 "西葛西テニスＡ面"）
 * @param {string} place - 场地名（如 "西葛西テニスコート"）
 * @param {Object} platformConfig - 平台配置（COURT_GROUPS）
 * @returns {string|undefined} 组标签；未配置或无匹配返回 undefined
 */
function resolveCourtGroup(court, place, platformConfig) {
  const groups = platformConfig?.COURT_GROUPS?.[place]
  if (!Array.isArray(groups) || groups.length === 0) return undefined
  const letter = courtLetter(court)
  const courtNorm = normalizeText(court)
  let defaultGroup = null
  for (const g of groups) {
    if (!g || typeof g.group !== 'string' || !g.group) continue
    if (g.default) {
      if (!defaultGroup) defaultGroup = g.group
      continue
    }
    if (matchCourtGroup(g, letter, courtNorm)) return g.group
  }
  return defaultGroup
}

// ========================
// Ucode 构建
// ========================

function buildUcode(d, platformConfig) {
  const placeMeta = platformConfig.PLACE_MAP?.[d.place] || {}
  const placeCode = placeMeta.courtCode || 'unknown'
  const courtCode = normalizeCourtAlias(d.court)
  const dayKey = parseSlotDayKey(d) || d.date || 'unknown-date'
  const timeRange = normalizeTimeRange(d.time || `${d.start}-${d.end}`)
  return `${placeCode}_${courtCode}_${dayKey}_${timeRange}`
}

// ========================
// Diff 计算
// ========================

function diffSlots(currentData, lastSet) {
  const currentUids = new Set(currentData.map(d => d.uid))
  const added = currentData.filter(d => !lastSet.has(d.uid))
  const removedUids = [...lastSet].filter(k => !currentUids.has(k))
  return { added, removedUids, currentUids }
}

// ========================
// 自动抢目标选择
// ========================

function autoPickTargets(candidates, autoBookedUIDs, autoBookedDayKeys) {
  const now = Date.now()

  const valid = candidates.filter(d => {
    const startDate = parseSlotStartDateTimeSafe(d)
    if (!startDate) return false
    const diffMin = (startDate.getTime() - now) / 60000
    if (diffMin < 20) return false

    const dayKey = parseSlotDayKey(d)
    if (dayKey && autoBookedDayKeys.has(dayKey)) return false
    if (autoBookedUIDs.has(d.uid)) return false

    return true
  })

  if (valid.length === 0) return []

  // 按天分组，每天选最晚一个
  const grouped = new Map()
  for (const d of valid) {
    const dayKey = parseSlotDayKey(d)
    if (!dayKey) continue
    if (!grouped.has(dayKey)) grouped.set(dayKey, [])
    grouped.get(dayKey).push(d)
  }

  const targets = []
  for (const [dayKey, list] of grouped.entries()) {
    list.sort((a, b) => {
      const ta = parseSlotStartDateTimeSafe(a)?.getTime() ?? -Infinity
      const tb = parseSlotStartDateTimeSafe(b)?.getTime() ?? -Infinity
      return tb - ta
    })
    targets.push(list[0])
  }

  return targets
}

// ========================
// 已预约管理
// ========================

function cleanExpiredBooked(bookedSlots) {
  const now = Date.now()
  return bookedSlots.filter(s => {
    const start = parseSlotStartDateTimeSafe(s)
    return start && start.getTime() > now
  })
}

function getFutureBookedSlots(bookedSlots) {
  const now = Date.now()
  return bookedSlots.filter(s => {
    const start = parseSlotStartDateTimeSafe(s)
    return start && start.getTime() > now
  })
}

function eligibleForBookedSummary(s, intervalMs) {
  if (s.reminderEnabled === false) return false
  if (s.bookedAt == null) return true
  return Date.now() >= s.bookedAt + intervalMs
}

// ========================
// Stats 记录
// ========================

const fs = require('fs')
const path = require('path')

const STATS_DIR = 'stats'

function recordStats(type, list) {
  if (!list || list.length === 0) return

  const now = Date.now()
  const hour = new Date().getHours()
  const file = path.join(STATS_DIR, `${type}.log`)
  fs.mkdirSync(STATS_DIR, { recursive: true })

  const lines = list.map(d => JSON.stringify({
    time: now,
    hour,
    place: d.place,
    court: d.court,
    date: d.date,
    slot: d.time,
    id: d.uid
  })).join('\n') + '\n'

  fs.appendFileSync(file, lines)
}

function readLogLines(filePath) {
  if (!fs.existsSync(filePath)) return []
  const raw = fs.readFileSync(filePath, 'utf-8')
  return raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean)
}

function startOfLocalDayMs() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const PERIODS = [
  { label: '今天', cutoff: startOfLocalDayMs },
  { label: '近7天', days: 7 },
  { label: '近30天', days: 30 },
  { label: '近半年', days: 182 },
  { label: '近一年', days: 365 }
]

function periodCutoff(period) {
  if (typeof period.cutoff === 'function') return period.cutoff()
  const d = period.days
  if (!d) return 0
  return Date.now() - d * 24 * 60 * 60 * 1000
}

function filterSince(list, cutoffMs) {
  return list.filter(i => typeof i.time === 'number' && i.time >= cutoffMs)
}

function groupByHour(list) {
  const map = {}
  list.forEach(i => { if (i.hour !== undefined && i.hour !== null) map[i.hour] = (map[i.hour] || 0) + 1 })
  return map
}

function groupByPlace(list) {
  const map = {}
  list.forEach(i => { const p = i.place || '（未知）'; map[p] = (map[p] || 0) + 1 })
  return map
}

function shortenPlaceName(name, placeMap) {
  return placeMap?.[name]?.short || name
}

function topNWithShort(map, n, placeMap, sep = ' · ') {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${shortenPlaceName(k, placeMap)}×${v}`)
    .join(sep)
}

function calcSpeedBuckets(addedList, removedList) {
  const addedMap = new Map()
  addedList.forEach(a => { if (a.id && (!addedMap.has(a.id) || a.time < addedMap.get(a.id))) addedMap.set(a.id, a.time) })

  const buckets = { '≤2m': 0, '≤5m': 0, '≤10m': 0, '≤30m': 0, '>30m': 0 }
  let paired = 0

  removedList.forEach(r => {
    if (!r.id || !addedMap.has(r.id)) return
    const diff = (r.time - addedMap.get(r.id)) / 1000
    if (diff < 0) return
    paired++
    if (diff <= 120) buckets['≤2m']++
    else if (diff <= 300) buckets['≤5m']++
    else if (diff <= 600) buckets['≤10m']++
    else if (diff <= 1800) buckets['≤30m']++
    else buckets['>30m']++
  })

  return { paired, buckets }
}

function buildStatsReport(placeMap) {
  const allAdded = readLogLines(path.join(STATS_DIR, 'added.log'))
  const allRemoved = readLogLines(path.join(STATS_DIR, 'removed.log'))
  const header = '📊 抢场统计\n━━━━━━━━━━━━━━━━━━\n'
  const blocks = PERIODS.map(p => summarizePeriod(p.label, periodCutoff(p), allAdded, allRemoved, placeMap))
  return header + blocks.join('\n')
}

function summarizePeriod(label, cutoffMs, allAdded, allRemoved, placeMap) {
  const added = filterSince(allAdded, cutoffMs)
  const removed = filterSince(allRemoved, cutoffMs)
  const ah = groupByHour(added)
  const rh = groupByHour(removed)

  const peakA = Object.entries(ah).sort((a, b) => b[1] - a[1])[0]
  const peakR = Object.entries(rh).sort((a, b) => b[1] - a[1])[0]
  const peakStr = peakA || peakR
    ? `出${peakA ? peakA[0] + '时' : '—'}／消${peakR ? peakR[0] + '时' : '—'}`
    : '—'
  const topPlaces = topNWithShort(groupByPlace(removed), 4, placeMap, '  ')
  const placeStr = topPlaces || '—'

  const lines = [`● ${label}  📈${added.length}  📉${removed.length}  ⚡${peakStr}  🏟${placeStr}`]
  const { paired, buckets } = calcSpeedBuckets(added, removed)
  if (paired > 0) {
    const detail = Object.entries(buckets).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join('  ')
    lines.push(`  ⏱配对 ${paired} 次  ${detail}`)
  }
  return lines.join('\n')
}

function splitForTelegram(text, maxLen = 3800) {
  if (text.length <= maxLen) return [text]
  const parts = []
  let rest = text
  while (rest.length) {
    if (rest.length <= maxLen) { parts.push(rest); break }
    let cut = rest.lastIndexOf('\n\n', maxLen)
    if (cut < maxLen / 2) cut = maxLen
    parts.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  return parts
}

module.exports = {
  filterSlotsByRules,
  filterSlotsByConfig,
  resolveCourtGroup,
  mergeContiguousSlots,
  getAutoRules,
  filterSlotsAuto,
  buildUcode,
  diffSlots,
  autoPickTargets,
  cleanExpiredBooked,
  getFutureBookedSlots,
  eligibleForBookedSummary,
  recordStats,
  buildStatsReport,
  splitForTelegram
}
