/**
 * 官网预约同步对账（纯函数）
 *
 * 输入：本地 bookedSlots 全部记录 + 官网预约列表映射成的记录（仅 edogawa）。
 * 输出：要新增的、要删除的、以及对账后的完整记录数组。
 *
 * 规则：
 * - 新增：官网有、本地没有（按 uid 匹配）的预约 → 补进本地。
 * - 删除：本地 platform=edogawa 且日期 >= 今天（JST）的记录，官网列表里
 *   没有了 → 视为用户已在官网取消，删除。过去的记录与其它平台的记录
 *   永远不动。
 * - 安全阀：官网列表为空但本地还有未来 edogawa 记录时，拒绝删除
 *   （suspectEmpty=true）— 空列表更可能是页面改版/解析失效，而不是
 *   用户一夜之间取消了全部预约。新增不受影响（本来也没有）。
 * 调用方保证：只有官网抓取成功时才调用本函数对账并落盘；抓取失败整轮跳过。
 */
function reconcileBookedSlots(localRecords, siteRecords, todayKey) {
  const locals = Array.isArray(localRecords) ? localRecords : []
  const sites = Array.isArray(siteRecords) ? siteRecords : []
  const siteUids = new Set(sites.map(r => r.uid))
  const localUids = new Set(locals.map(r => r.uid))

  const added = sites.filter(r => !localUids.has(r.uid))

  const futureLocalEdogawa = locals.filter(
    r => r.platform === 'edogawa' && r.date >= todayKey
  )
  const suspectEmpty = sites.length === 0 && futureLocalEdogawa.length > 0

  const removed = suspectEmpty
    ? []
    : futureLocalEdogawa.filter(r => !siteUids.has(r.uid))
  const removedUids = new Set(removed.map(r => r.uid))

  const next = locals.filter(r => !removedUids.has(r.uid)).concat(added)
  return { added, removed, next, suspectEmpty }
}

module.exports = { reconcileBookedSlots }
