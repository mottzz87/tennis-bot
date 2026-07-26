/**
 * Ichikawa 预约执行逻辑
 */
const { sleep, normalizeTimeRange, formatDateDisplayFromIso, normalizeText } = require('@tennis-bot/utils')
const { parseSlotDayKey } = require('@tennis-bot/utils')

/**
 * 在结果页点击目标 slot
 * 兼容两种查找方式：domId 直接点击 或 表格匹配
 */
async function clickSlot(page, slotData) {
  if (slotData.domId) {
    const el = await page.$(`#${slotData.domId}`)
    if (el) {
      await el.click()
      return
    }
  }

  const found = await page.evaluate((d) => {
    const normalize = s =>
      String(s)
        .replace(/\s/g, '')
        .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
        .replace(/：/g, ':')
        .replace(/～/g, '~')

    const o = d.origin || d.oragin
    const targetPlace = normalize(o?.placeText ?? o?.place ?? d.place)
    const targetCourt = normalize(o?.courtText ?? o?.court ?? d.court)
    const targetIso = String(d.date || '').trim()
    const targetTimeRange = normalize(o?.timeText ?? o?.time ?? d.time)
    const originDateRaw = o?.dateText ?? o?.date
    const originTimeRaw = o?.timeText ?? o?.time

    const dateTextMatchesTarget = (textNorm) => {
      if (!textNorm) return false
      if (originDateRaw) {
        const on = normalize(originDateRaw)
        if (on && (textNorm.includes(on) || on.includes(textNorm))) return true
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(targetIso)) {
        const [y, mo, day] = targetIso.split('-').map(Number)
        const patterns = [
          normalize(`${y}年${mo}月${day}日`),
          normalize(`${y}年${String(mo).padStart(2, '0')}月${String(day).padStart(2, '0')}日`),
          normalize(`${mo}.${String(day).padStart(2, '0')}（`),
          normalize(`${mo}.${day}（`),
          normalize(`${String(mo).padStart(2, '0')}.${String(day).padStart(2, '0')}（`),
          normalize(`${mo}/${day}（`),
          normalize(`${mo}/${String(day).padStart(2, '0')}`),
          normalize(`${String(mo).padStart(2, '0')}/${String(day).padStart(2, '0')}`)
        ]
        if (patterns.some(p => p && textNorm.includes(p))) return true
      }
      const fallback = normalize(targetIso)
      return !!(fallback && textNorm.includes(fallback))
    }

    const columnHeaderHasOwnDate = (colNorm) =>
      /\d{4}年\d{1,2}月\d{1,2}日/.test(colNorm) ||
      /\d{1,2}月\d{1,2}日/.test(colNorm) ||
      /\d{1,2}\.\d{1,2}（[月火水木金土日]）/.test(colNorm) ||
      /\d{1,2}\/\d{1,2}（[月火水木金土日]）/.test(colNorm)

    const timeHeaderMatches = (headerNorm) => {
      if (!headerNorm) return false
      const mRange = targetTimeRange.match(/^(\d{1,2})-(\d{1,2})$/)
      if (mRange) {
        const hs = Number(mRange[1]), he = Number(mRange[2])
        const m = headerNorm.match(/(\d{1,2}):\d{2}[~\-](\d{1,2}):\d{2}/)
        if (m) return Number(m[1]) === hs && Number(m[2]) === he
        if (headerNorm.includes(`${hs}:`) && headerNorm.includes(`${he}:`)) return true
      }
      if (originTimeRaw) {
        const ot = normalize(originTimeRaw)
        if (ot && (headerNorm.includes(ot) || ot.includes(headerNorm))) return true
      }
      return headerNorm.includes(targetTimeRange)
    }

    function placeNameForDgTable(dgTable) {
      const tb = dgTable.closest('tbody')
      if (tb) {
        const a = tb.querySelector('a[id*="lnkShisetsu"]')
        if (a) return String(a.innerText).replace(/\s+/g, ' ').trim()
      }
      let p = dgTable.parentElement
      for (let n = 0; n < 28 && p; n++) {
        if (p.tagName === 'TABLE' && p !== dgTable) {
          const a = p.querySelector('a[id*="lnkShisetsu"]')
          if (a && !dgTable.contains(a)) return String(a.innerText).replace(/\s+/g, ' ').trim()
        }
        p = p.parentElement
      }
      return ''
    }

    function slotColumnStartIndex(headerTds) {
      const h1 = String(headerTds[1]?.innerText || '').replace(/\s/g, '')
      return h1.includes('定員') ? 2 : 1
    }

    const dgTables = document.querySelectorAll('table[id*="dgTable"]')

    for (const table of dgTables) {
      const placeRaw = placeNameForDgTable(table)
      const currentPlace = normalize(placeRaw)
      if (!currentPlace ||
        (!currentPlace.includes(targetPlace) && !targetPlace.includes(currentPlace))
      ) continue

      const rows = table.querySelectorAll('tr')
      if (rows.length < 2) continue

      const headerTds = rows[0].querySelectorAll('td')
      const slot0 = slotColumnStartIndex(headerTds)
      const rowDateNorm = normalize(headerTds[0]?.innerText || '')

      for (let i = 1; i < rows.length; i++) {
        const tds = rows[i].querySelectorAll('td')
        const courtText = normalize(tds[0].innerText)
        if (!courtText.includes(targetCourt)) continue

        for (let j = slot0; j < tds.length; j++) {
          const link = tds[j].querySelector('a')
          if (!link) continue

          const colHeaderNorm = normalize(headerTds[j]?.innerText || '')
          const dateOk = columnHeaderHasOwnDate(colHeaderNorm)
            ? dateTextMatchesTarget(colHeaderNorm)
            : dateTextMatchesTarget(colHeaderNorm) || dateTextMatchesTarget(rowDateNorm)
          if (!dateOk) continue
          if (!timeHeaderMatches(colHeaderNorm)) continue

          link.click()
          return true
        }
      }
    }

    return false
  }, slotData)

  if (!found) {
    throw new Error(`找不到 slot: ${slotData.place} ${slotData.court} ${slotData.date} ${slotData.time}`)
  }
}

module.exports = { clickSlot }
