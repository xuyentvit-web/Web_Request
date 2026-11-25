'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'web-request.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS depts (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS types (
  id INTEGER PRIMARY KEY, dept_id INTEGER NOT NULL REFERENCES depts(id), name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, UNIQUE(dept_id, name));
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('staff','hod','it')),
  dept_id INTEGER REFERENCES depts(id), active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '', dept_id INTEGER NOT NULL REFERENCES depts(id),
  type_id INTEGER REFERENCES types(id),
  priority TEXT NOT NULL CHECK (priority IN ('normal','priority','critical')),
  status TEXT NOT NULL CHECK (status IN ('open','process','follow','pending','done')),
  created_by INTEGER NOT NULL REFERENCES users(id), created_by_dept INTEGER REFERENCES depts(id),
  assignee INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL, accepted_at INTEGER, follow_at INTEGER, done_at INTEGER,
  reminded_at INTEGER, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS tickets_dept ON tickets(dept_id, status);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  at INTEGER NOT NULL, user_id INTEGER REFERENCES users(id), action TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS history_ticket ON history(ticket_id);
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL);
`);

// Ticket codes are RQ-(1000 + id), see ticketCode().

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

const DEFAULT_SLA = {
  normal: { resp: 30, resolve: 24 * 60 },
  priority: { resp: 15, resolve: 4 * 60 },
  critical: { resp: 5, resolve: 60 },
};
const DEFAULT_PERMS = {
  staff: { create: 1, handleOwn: 1, viewDept: 1, viewAll: 0, reportDept: 1, reportAll: 0, config: 0 },
  hod: { create: 1, handleOwn: 0, viewDept: 1, viewAll: 1, reportDept: 1, reportAll: 1, config: 0 },
  it: { create: 1, handleOwn: 1, viewDept: 1, viewAll: 1, reportDept: 1, reportAll: 1, config: 1 },
};
const DEFAULT_DEPTS = {
  'Lễ tân': ['Check-in / check-out', 'Hành lý / đưa đón', 'Phản hồi của khách'],
  'Buồng phòng': ['Dọn phòng', 'Đồ vải (linen)', 'Amenities / minibar', 'Đồ thất lạc'],
  'Kỹ thuật': ['Điện', 'Nước / ống nước', 'Điều hoà', 'Thiết bị trong phòng', 'Thang máy'],
  'Nhà hàng (F&B)': ['Room service', 'Đặt bàn / sự kiện', 'Thiết bị bếp'],
  'IT': ['Wifi / mạng', 'Máy tính / máy in', 'Phần mềm PMS', 'TV / điện thoại', 'Tài khoản / mật khẩu'],
  'An ninh': ['Thẻ từ / khoá cửa', 'Sự cố an ninh', 'Camera'],
};

function seedConfig() {
  if (getSetting('sla') == null) setSetting('sla', DEFAULT_SLA);
  if (getSetting('perms') == null) setSetting('perms', DEFAULT_PERMS);
  const n = db.prepare('SELECT COUNT(*) AS n FROM depts').get().n;
  if (n === 0) {
    const insD = db.prepare('INSERT INTO depts(name) VALUES (?)');
    const insT = db.prepare('INSERT INTO types(dept_id, name) VALUES (?, ?)');
    for (const [d, ts] of Object.entries(DEFAULT_DEPTS)) {
      const id = insD.run(d).lastInsertRowid;
      for (const t of ts) insT.run(id, t);
    }
  }
}
seedConfig();

const ticketCode = id => 'RQ-' + (1000 + Number(id));

module.exports = { db, getSetting, setSetting, ticketCode, DATA_DIR };
