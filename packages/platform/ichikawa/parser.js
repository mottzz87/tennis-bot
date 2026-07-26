/**
 * Ichikawa 页面解析器
 * 从预约结果页面解析空位数据
 */

/**
 * 在页面中执行解析，返回原始数据
 * @param {Page} page - Playwright page
 * @param {string[]} skipCourtContains - 要跳过的球场关键词
 * @returns {Object[]} 解析后的原始数据
 */
async function parsePage(page, skipCourtContains) {
  return page.evaluate((skipCourtContains) => {
    const shouldSkipCourtRow = (courtText) =>
      Array.isArray(skipCourtContains) &&
      skipCourtContains.some(sub => sub && String(courtText).includes(sub))

    const halfNum = (s) =>
      String(s).replace(/[０-９]/g, ch =>
        String.fromCharCode(ch.charCodeAt(0) - 0xfee0))

    function resolveRawDateTimeForColumn(headers, j, timesArr, slotColStart) {
      const row0 = halfNum(headers[0].innerText).replace(/\s/g, '')
      const col = halfNum(headers[j].innerText).replace(/\s/g, '')
      let rawDate = row0
      let rawTime = timesArr[j - slotColStart]

      const ymdCol = col.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
      if (ymdCol) {
        rawDate = ymdCol[0]
        let rest = col.slice(ymdCol.index + ymdCol[0].length)
        const wd = rest.match(/^（[月火水木金土日]）/)
        if (wd) {
          rawDate += wd[0]
          rest = rest.slice(wd[0].length)
        }
        const tm = rest.match(/(\d{1,2}:\d{2})[～~\-](\d{1,2}:\d{2})/)
        if (tm) rawTime = `${tm[1]}～${tm[2]}`
        return { rawDate, rawTime }
      }

      const mdCol = col.match(/(\d{1,2})月(\d{1,2})日/)
      if (mdCol) {
        const yFromRow = row0.match(/(\d{4})年/)
        if (yFromRow) {
          rawDate = `${yFromRow[1]}年${mdCol[1]}月${mdCol[2]}日`
          let rest = col.slice(mdCol.index + mdCol[0].length)
          const wd = rest.match(/^（[月火水木金土日]）/)
          if (wd) {
            rawDate += wd[0]
            rest = rest.slice(wd[0].length)
          }
          const tm = rest.match(/(\d{1,2}:\d{2})[～~\-](\d{1,2}:\d{2})/)
          if (tm) rawTime = `${tm[1]}～${tm[2]}`
          return { rawDate, rawTime }
        }
      }

      const dotMd = col.match(/(\d{1,2})\.(\d{1,2})（([月火水木金土日])）/)
      if (dotMd) {
        const ymdRow = row0.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
        if (ymdRow) {
          rawDate = `${ymdRow[1]}年${Number(dotMd[1])}月${Number(dotMd[2])}日（${dotMd[3]}）`
          const after = col.slice(dotMd.index + dotMd[0].length)
          const tm = after.match(/(\d{1,2}:\d{2})[～~\-](\d{1,2}:\d{2})/)
          if (tm) rawTime = `${tm[1]}～${tm[2]}`
          return { rawDate, rawTime }
        }
      }

      const slashMd = col.match(/(\d{1,2})\/(\d{1,2})（([月火水木金土日])）/)
      if (slashMd) {
        const ymdRow = row0.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
        if (ymdRow) {
          rawDate = `${ymdRow[1]}年${Number(slashMd[1])}月${Number(slashMd[2])}日（${slashMd[3]}）`
          const after = col.slice(slashMd.index + slashMd[0].length)
          const tm = after.match(/(\d{1,2}:\d{2})[～~\-](\d{1,2}:\d{2})/)
          if (tm) rawTime = `${tm[1]}～${tm[2]}`
          return { rawDate, rawTime }
        }
      }

      return { rawDate, rawTime }
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

    const result = []
    const dgTables = document.querySelectorAll('table[id*="dgTable"]')

    for (const table of dgTables) {
      const currentPlace = placeNameForDgTable(table)
      const rows = table.querySelectorAll('tr')
      const headers = rows[0].querySelectorAll('td')
      const slot0 = slotColumnStartIndex(headers)

      const times = []
      for (let i = slot0; i < headers.length; i++) {
        times.push(headers[i].innerText.replace(/\s/g, ''))
      }

      for (let i = 1; i < rows.length; i++) {
        const tds = rows[i].querySelectorAll('td')
        const court = tds[0].innerText.trim()
        if (shouldSkipCourtRow(court)) continue

        for (let j = slot0; j < tds.length; j++) {
          const link = tds[j].querySelector('a')
          if (!link) continue

          const val = link.innerText.replace(/\s/g, '')
          if (val !== '○' && val !== '△') continue

          const { rawDate: rawDateCompact, rawTime: rawTimeFromCol } =
            resolveRawDateTimeForColumn(headers, j, times, slot0)
          const rawDate = rawDateCompact
          const rawTime = rawTimeFromCol

          const formatStr = str => String(str)
            .toLowerCase()
            .replace(/　/g, ' ')
            .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
            .replace(/\s+/g, ' ')
            .trim()

          const dateMatch = rawDate.match(/(\d+)年(\d+)月(\d+)日/)
          let dateFormatted = rawDate
          let dateDisplay = ''
          if (dateMatch) {
            const y = dateMatch[1]
            const mo = String(dateMatch[2]).padStart(2, '0')
            const d = String(dateMatch[3]).padStart(2, '0')
            dateFormatted = `${y}-${mo}-${d}`
            const moNum = Number(dateMatch[2])
            const dday = String(dateMatch[3]).padStart(2, '0')
            const wdMatch = rawDate.match(/（([月火水木金土日])）/)
            dateDisplay = wdMatch
              ? `${moNum}.${dday}（${wdMatch[1]}）`
              : `${moNum}.${dday}`
          }

          const normalized = rawTime
            .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
            .replace(/：/g, ':')
            .replace(/～/g, '~')
            .trim()
          const [startRaw = '0', endRaw = '0'] = normalized.split('~')
          const toHour = (s) => {
            const t = String(s || '').trim()
            const h = Number(t.includes(':') ? t.split(':')[0] : t)
            return Number.isNaN(h) ? '0' : String(h)
          }
          const timeFormatted = `${toHour(startRaw)}-${toHour(endRaw)}`

          result.push({
            origin: {
              place: currentPlace,
              court,
              domId: link.id,
              time: rawTime,
              date: rawDate
            },
            place: currentPlace,
            court: formatStr(court),
            date: dateFormatted,
            time: timeFormatted,
            dateDisplay,
            domId: link.id,
            uid: formatStr(`${currentPlace}_${court}_${dateFormatted}_${timeFormatted}`)
          })
        }
      }
    }

    return result
  }, skipCourtContains)
}

module.exports = { parsePage }
