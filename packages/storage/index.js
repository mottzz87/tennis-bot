/**
 * Storage 抽象接口
 * 业务代码统一通过此接口访问持久化数据
 */
class Storage {
  async getLastSets() { throw new Error('Not implemented') }
  async saveLastSets(map) { throw new Error('Not implemented') }
  async getBookedSlots() { throw new Error('Not implemented') }
  async saveBookedSlots(slots) { throw new Error('Not implemented') }
  async getReminderIndex() { throw new Error('Not implemented') }
  async saveReminderIndex(index) { throw new Error('Not implemented') }
  async getAutoBooked() { throw new Error('Not implemented') }
  async saveAutoBooked(uids) { throw new Error('Not implemented') }
}

module.exports = Storage
