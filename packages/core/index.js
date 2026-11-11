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
  isWeekendOrHoliday,
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

// 从 dateDisplay（如 "8.08（土）" / "9.22（火祝）"）或 date（ISO）解析星期，解析失败返回 null
function resolveWeekday(d) {
  const display = String(d.dateDisplay || '')
  const m1 = display.match(/[（(]([月火水木金土日])祝?[）)]/)
  if (m1) return m1[1]
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '').trim())) {
    const [y, mo, day] = String(d.date).split('-').map(Number)
    return WEEKDAY_JP[new Date(y, mo - 1, day).getDay()]
  }
  const m2 = String(d.date || '').match(/[（(]([月火水木金土日])祝?[）)]/)
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

    // 周末（土/日）与祝日默认全天可扫，不受 TIME_FILTER 限制
    if (TIME_FILTER.length > 0 && !isWeekendOrHoliday(d)) {
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
// 自动抢目标选择（放号窗口专用规则，每天最多两个）
// ========================
// 每天最多选两个时段（确定性规则，无随机）：
//   1. 有 19:00 开始的时段 → 选它，再加一个在它之前、19:00 结束的 2 小时段
//      （配成连续晚场，如 17–19 + 19–21；优先同设施、同场地）；
//      没有 19:00 前的 2 小时段时，只选 19:00 档一个。
//   2. 没有 19:00 开始的时段 → 取当天最晚的两个 2 小时段；2 小时段不足两个时，
//      用其余时段（任意时长，最晚优先）补足到两个；当天只有一个时段时只选它一个。
// 注意：19:00 档本身不限时长（19–21 / 19–22 均可）；“之前”的时段严格要求 2 小时。
// autoBookedDayKeys 仍按天跳过（当天已自动预约过则整天跳过），与今天一致。
// 连续 3–4 小时档的日间段（默认与 edogawa TIME_FILTER 的早/晚段一致：
// 上午 6:00–12:00，下午/晚上 17:00–22:00）。连续档必须完整落在其内
// （例：8–12、17–21）。调用方可通过 opts.windows 覆盖。
const DEFAULT_RANGE_WINDOWS = [[360, 720], [1020, 1320]]
const EVENING_START_MIN = 19 * 60 // 19:00（黄金档锚点）

// 目标选择：每天一个（一次申请只约一个时段；二合一申请全有全无，
// 一个被抢整单作废，所以不再把两个时段拼进一次申请）。
// 每日优先级（确定性，无随机）：
//   1) 连续 3–4 小时空闲段（一次申请，例：17–21、8–12），晚段优先、
//      其次时长更长、其次开始更早；
//   2) 否则 2 小时段：19:00 开始优先，其次最早的上午段，其次最晚的段；
//   3) 否则当天最晚的时段（兜底，避免空手）。
// 2) / 3) 只取开始时间落在日间段内的时段（中午段不在 TIME_FILTER 内，不抢）。
// 连续段可能由一段合并时段直接构成（如上午 8–12），也可能由同场地
// 相邻的两段拼成（如 17–19 + 19–21，黄金时段 19–21 会把合并链断开）。
// opts.windows：日间段 [[开始分钟, 结束分钟], ...]，默认上午/晚上两段。
function autoPickTargets(candidates, autoBookedUIDs, autoBookedDayKeys, opts = {}) {
  const now = Date.now()
  const windows = Array.isArray(opts.windows) && opts.windows.length > 0
    ? opts.windows
    : DEFAULT_RANGE_WINDOWS

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

  // 按天分组，每天选一个
  const grouped = new Map()
  for (const d of valid) {
    const dayKey = parseSlotDayKey(d)
    if (!dayKey) continue
    if (!grouped.has(dayKey)) grouped.set(dayKey, [])
    grouped.get(dayKey).push(d)
  }

  const targets = []
  for (const [dayKey, list] of grouped.entries()) {
    const range = pickBestRange(list, windows)
    if (range) {
      targets.push(range)
      continue
    }
    const inWindow = d => {
      const s = slotStartMin(d)
      return windows.some(w => s >= w[0] && s <= w[1])
    }
    const twoHour = list.filter(d => slotDurationMin(d) === 120 && inWindow(d))
    const morningEnd = windows[0][1]
    const sorted2h = twoHour.slice().sort((a, b) => {
      const sa = slotStartMin(a)
      const sb = slotStartMin(b)
      const a19 = sa === EVENING_START_MIN
      const b19 = sb === EVENING_START_MIN
      if (a19 !== b19) return a19 ? -1 : 1
      const aM = sa < morningEnd
      const bM = sb < morningEnd
      if (aM && bM) return sa - sb // 都是上午：最早优先
      if (aM !== bM) return aM ? -1 : 1 // 上午优先于非上午
      if (sb !== sa) return sb - sa // 都不是上午：最晚优先
      return slotTiebreak(a, b)
    })
    if (sorted2h.length > 0) {
      targets.push(sorted2h[0])
      continue
    }
    // 兜底：当天最晚的日间段时段（任意时长）；中午段不取
    const latest = list.filter(inWindow).sort((a, b) => {
      const diff = slotStartMin(b) - slotStartMin(a)
      return diff !== 0 ? diff : slotTiebreak(a, b)
    })[0]
    if (latest) targets.push(latest)
  }

  return targets
}

// 确定性平局：设施、场地、uid 字典序
function slotTiebreak(a, b) {
  const pa = `${a.place || ''}|${a.court || ''}|${a.uid || ''}`
  const pb = `${b.place || ''}|${b.court || ''}|${b.uid || ''}`
  return pa < pb ? -1 : pa > pb ? 1 : 0
}

// 时段是否覆盖某分钟（起 ≤ 该分钟 < 止；例：17–21 覆盖 19:00，17–19 不覆盖）
function slotCoversHour(d, hourMin) {
  return slotStartMin(d) <= hourMin && slotEndMin(d) > hourMin
}

// 单面时段：courts 拼接序列里只有一个场地字母（或无序列，默认单面）。
// 跨面拼段（如 "AB面"）不参与连续档组装——跨面就不是同一张场地的连续时间。
function isSingleCourtSlot(d) {
  const seq = String(d.courts || '')
  if (!seq) return true
  const letters = seq.replace(/[\d.]/g, '')
  return new Set(letters).size <= 1
}

// 从一段连续空闲里取最佳 3–4 小时窗口（无则返回 null）。
// 同场地（place+court）相邻段拼成连续链；链总长 180–240 分钟取整条，
// 超过 240 分钟取链尾 240 分钟（如上午 6–12 空满取 8–12）；
// 窗口必须完整落在某个日间段内。返回合成的时段对象（可直接用于预约：
// start/end/duration/time/courts/uid/ucode 均按窗口重算）。
function pickBestRange(list, windows) {
  // 同场地分组
  const groups = new Map()
  for (const d of list) {
    if (!isSingleCourtSlot(d)) continue
    const key = `${d.place || ''}|${d.court || ''}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(d)
  }
  const wins = []
  for (const segs of groups.values()) {
    const sorted = segs.slice().sort((a, b) => slotStartMin(a) - slotStartMin(b) || slotTiebreak(a, b))
    // 连续链：上一段结束 = 下一段开始
    let run = [sorted[0]]
    const runs = []
    for (let i = 1; i < sorted.length; i++) {
      if (slotEndMin(run[run.length - 1]) === slotStartMin(sorted[i])) run.push(sorted[i])
      else { runs.push(run); run = [sorted[i]] }
    }
    runs.push(run)
    for (const r of runs) {
      const total = slotEndMin(r[r.length - 1]) - slotStartMin(r[0])
      if (total < 180) continue
      // 窗口：整条（180–240）或链尾 240 分钟
      const winEnd = slotEndMin(r[r.length - 1])
      const winStart = total <= 240 ? slotStartMin(r[0]) : winEnd - 240
      const wi = windows.findIndex(w => winStart >= w[0] && winEnd <= w[1])
      if (wi < 0) continue
      wins.push({ segments: r, startMin: winStart, endMin: winEnd, windowIndex: wi, duration: winEnd - winStart })
    }
  }
  if (wins.length === 0) return null
  // 晚段优先、时长更长、开始更早、设施/场地字典序
  wins.sort((a, b) => {
    if (b.windowIndex !== a.windowIndex) return b.windowIndex - a.windowIndex
    if (b.duration !== a.duration) return b.duration - a.duration
    if (a.startMin !== b.startMin) return a.startMin - b.startMin
    return slotTiebreak(a.segments[0], b.segments[0])
  })
  const best = wins[0]
  return buildRangeSlot(best.segments, best.startMin, best.endMin)
}

// 把一段连续空闲（一段或多段同场地）合成一个可预约的时段对象。
// courts 按窗口逐小时展开（如 17–21 同面 A → "4A"），selectTimeCells 靠它逐小时选面。
function buildRangeSlot(segments, startMin, endMin) {
  const first = segments[0]
  const hours = Math.round((endMin - startMin) / 60)
  const letter = courtLetter(first.court)
  const start = fmtMin(startMin)
  const end = fmtMin(endMin)
  const time = `${start}-${end}`
  return {
    ...first,
    start,
    end,
    duration: endMin - startMin,
    time,
    courts: hours > 0 && letter ? `${hours}${letter}` : first.courts,
    uid: `${first.place || ''}_${first.court || ''}_${first.date || ''}_${time}`,
    ucode: `${first.place || ''}_${first.court || ''}_${first.date || ''}_${time}`
  }
}

// 分钟数 → "HH:MM"
function fmtMin(min) {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// 时段开始分钟数（start 为 "HH:MM"；无 start 时从 time 取首段）
function slotStartMin(d) {
  const raw = String(d.start ?? String(d.time || '').split(/[～~\-]/)[0] ?? '')
  return toMinutes(raw)
}

// 时段结束分钟数（end 为 "HH:MM"；无 end 时从 time 取末段）
function slotEndMin(d) {
  const raw = String(d.end ?? '')
  if (raw) return toMinutes(raw)
  const parts = String(d.time || '').split(/[～~\-]/)
  return parts.length > 1 ? toMinutes(parts[1]) : 0
}

// 时段开始小时
function slotStartHour(d) {
  return Math.floor(slotStartMin(d) / 60)
}

// 时段结束小时
function slotEndHour(d) {
  return Math.floor(slotEndMin(d) / 60)
}

// 时段时长（分钟）：优先用 duration 字段，否则 start/end 相减
function slotDurationMin(d) {
  const dur = Number(d.duration)
  if (Number.isFinite(dur) && dur > 0) return dur
  const s = slotStartMin(d)
  const e = slotEndMin(d)
  if (e > s) return e - s
  return 0
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
  slotCoversHour,
  cleanExpiredBooked,
  getFutureBookedSlots,
  eligibleForBookedSummary,
  recordStats,
  buildStatsReport,
  splitForTelegram
}
