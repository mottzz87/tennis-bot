const fs = require('fs')
const path = require('path')
const Storage = require('../index')

class FileStorage extends Storage {
  constructor(dataDir) {
    super()
    this.dataDir = dataDir
  }

  _filePath(name) {
    return path.join(this.dataDir, name)
  }

  _readJSON(name, defaultVal) {
    const fp = this._filePath(name)
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf-8'))
    } catch {
      return defaultVal
    }
  }

  _writeJSON(name, data) {
    fs.mkdirSync(this.dataDir, { recursive: true })
    fs.writeFileSync(this._filePath(name), JSON.stringify(data, null, 2))
  }

  // ========================
  // LastSet（按平台分区：{ platformName: [uid,...] }）
  // ========================
  async getLastSets() {
    return this._readJSON('lastSet.json', {})
  }

  async saveLastSets(map) {
    this._writeJSON('lastSet.json', map)
  }

  // ========================
  // BookedSlots
  // ========================
  async getBookedSlots() {
    return this._readJSON('bookedSlots.json', [])
  }

  async saveBookedSlots(slots) {
    this._writeJSON('bookedSlots.json', slots)
  }

  // ========================
  // ReminderIndex
  // ========================
  async getReminderIndex() {
    return this._readJSON('reminderIndex.json', {})
  }

  async saveReminderIndex(index) {
    this._writeJSON('reminderIndex.json', index)
  }

  // ========================
  // AutoBooked
  // ========================
  async getAutoBooked() {
    return new Set(this._readJSON('autoBooked.json', []))
  }

  async saveAutoBooked(uids) {
    this._writeJSON('autoBooked.json', [...uids])
  }
}

module.exports = FileStorage
