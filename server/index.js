'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, getSetting, setSetting, ticketCode } = require('./db');
const push = require('./push');

const PORT = Number(process.env.PORT || 3000);
const SESSION_DAYS = 30;
const COOKIE = 'wr_session';
const STATUSES = ['open', 'process', 'follow', 'pending', 'done'];
const PRIORITIES = ['normal', 'priority', 'critical'];
const ROLES = ['staff', 'hod', 'it'];
const PRIO_LABEL = { normal: 'Normal', priority: 'Priority', critical: 'Critical' };
const STATUS_LABEL = { open: 'Open', process: 'Process', follow: 'Follow', pending: 'Pending', done: 'Done' };

/* ---------- first admin account ---------- */
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  const itDept = db.prepare("SELECT id FROM depts WHERE name = 'IT'").get();
  db.prepare('INSERT INTO users(username, name, password_hash, role, dept_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('admin', 'Admin IT', bcrypt.hashSync(pw, 10), 'it', itDept ? itDept.id : null, Date.now());
  console.log('\n=== Tài khoản quản trị đầu tiên ===\n  Tên đăng nhập: admin\n  Mật khẩu: ' + pw +
    '\n  Hãy đổi mật khẩu sau khi đăng nhập.\n');
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

/* ---------- helpers ---------- */
const perms = () => getSetting('perms');
const can = (u, k) => !!(perms()[u.role] || {})[k];
const now = () => Date.now();

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setSessionCookie(req, res, token, maxAgeSec) {
  const secure = req.secure ? '; Secure' : '';
  res.set('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}
function loadUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`).get(token, now());
  return row || null;
}
function auth(req, res, next) {
  const u = loadUser(req);
  if (!u) return res.status(401).json({ error: 'Phiên đăng nhập đã hết, hãy đăng nhập lại.' });
  req.user = u;
  next();
}
function requirePerm(k) {
  return (req, res, next) => can(req.user, k) ? next() : res.status(403).json({ error: 'Bạn không có quyền làm việc này.' });
}
const publicUser = u => ({ id: u.id, username: u.username, name: u.name, role: u.role, dept_id: u.dept_id, active: u.active });
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function visible(u, t) {
  if (can(u, 'viewAll')) return true;
  return can(u, 'viewDept') && (t.dept_id === u.dept_id || t.created_by_dept === u.dept_id);
}
function canHandle(u, t) {
  if (u.role === 'it') return true;
  return can(u, 'handleOwn') && t.dept_id === u.dept_id;
}
const canConfirm = (u, t) => canHandle(u, t) || t.created_by_dept === u.dept_id || t.created_by === u.id;

function ticketOut(t) {
  return { ...t, code: ticketCode(t.id) };
}
function addHistory(ticketId, userId, action, note = '') {
  db.prepare('INSERT INTO history(ticket_id, at, user_id, action, note) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, now(), userId, action, note);
}

/* ---------- live updates (Server-Sent Events) ---------- */
const clients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (data.ticket && !visible(c.user, data.ticket)) continue;
    c.res.write(msg);
  }
}
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25000).unref();

/* ---------- notifications ---------- */
const deptHandlers = deptId => db.prepare('SELECT * FROM users WHERE active = 1 AND dept_id = ?').all(deptId)
  .filter(u => can(u, 'handleOwn') && u.role !== 'it').map(u => u.id);
const hods = () => db.prepare("SELECT id FROM users WHERE active = 1 AND role = 'hod'").all().map(r => r.id);
const deptName = id => (db.prepare('SELECT name FROM depts WHERE id = ?').get(id) || {}).name || '';

function notify(userIds, t, title, body, urgent) {
  push.sendToUsers(userIds, { title, body, url: '/#' + ticketCode(t.id), tag: ticketCode(t.id), urgent })
    .catch(e => console.warn('[push]', e.message));
}

/* ---------- auth routes ---------- */
const attempts = new Map();
app.post('/api/login', (req, res) => {
  const key = req.ip;
  const a = attempts.get(key) || { n: 0, until: 0 };
  if (a.until > now()) return res.status(429).json({ error: 'Sai quá nhiều lần. Thử lại sau 5 phút.' });
  const username = str(req.body.username, 64);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) {
    a.n++; if (a.n >= 8) { a.until = now() + 5 * 60e3; a.n = 0; }
    attempts.set(key, a);
    return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu.' });
  }
  attempts.delete(key);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, u.id, now() + SESSION_DAYS * 864e5);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  const token = parseCookies(req)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  res.json({
    me: publicUser(req.user),
    perms: perms()[req.user.role],
    allPerms: can(req.user, 'config') ? perms() : undefined,
    sla: getSetting('sla'),
    depts: db.prepare('SELECT * FROM depts ORDER BY id').all(),
    types: db.prepare('SELECT * FROM types ORDER BY dept_id, id').all(),
    users: db.prepare('SELECT id, name, dept_id, role, active FROM users ORDER BY name').all(),
    vapidPublicKey: push.publicKey(),
    pushDevices: push.countSubs(req.user.id),
  });
});
app.post('/api/me/password', auth, (req, res) => {
  const { current, next: nextPw } = req.body || {};
  if (typeof nextPw !== 'string' || nextPw.length < 6) return res.status(400).json({ error: 'Mật khẩu mới cần ít nhất 6 ký tự.' });
  if (!bcrypt.compareSync(String(current || ''), req.user.password_hash)) return res.status(400).json({ error: 'Mật khẩu hiện tại không đúng.' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(nextPw, 10), req.user.id);
  res.json({ ok: true });
});

app.get('/api/events', auth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  const c = { user: req.user, res };
  clients.add(c);
  req.on('close', () => clients.delete(c));
});

/* ---------- push routes ---------- */
app.post('/api/push/subscribe', auth, (req, res) => {
  try { push.saveSubscription(req.user.id, req.body); res.json({ ok: true, devices: push.countSubs(req.user.id) }); }
  catch (e) { res.status(400).json({ error: 'Đăng ký thông báo không hợp lệ.' }); }
});
app.post('/api/push/unsubscribe', auth, (req, res) => {
  push.removeSubscription(req.user.id, str(req.body.endpoint, 2000));
  res.json({ ok: true, devices: push.countSubs(req.user.id) });
});
app.post('/api/push/test', auth, async (req, res) => {
  const n = await push.sendToUsers([req.user.id], { title: 'Thông báo thử', body: 'Thiết bị này sẽ nhận thông báo khi có yêu cầu mới.', url: '/', tag: 'test' });
  res.json({ ok: true, sent: n });
});

/* ---------- tickets ---------- */
app.get('/api/tickets', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM tickets ORDER BY id DESC').all();
  res.json(rows.filter(t => visible(req.user, t)).map(ticketOut));
});
function findTicket(req, res) {
  const raw = String(req.params.id).replace(/^RQ-/i, '');
  const id = Number(raw) > 1000 ? Number(raw) - 1000 : Number(raw);
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  if (!t || !visible(req.user, t)) { res.status(404).json({ error: 'Không tìm thấy yêu cầu.' }); return null; }
  return t;
}
app.get('/api/tickets/:id', auth, (req, res) => {
  const t = findTicket(req, res); if (!t) return;
  const history = db.prepare('SELECT * FROM history WHERE ticket_id = ? ORDER BY at, id').all(t.id);
  res.json({ ...ticketOut(t), history });
});
app.post('/api/tickets', auth, requirePerm('create'), (req, res) => {
  const b = req.body || {};
  const title = str(b.title, 200);
  const deptId = Number(b.dept_id);
  const typeId = b.type_id ? Number(b.type_id) : null;
  const priority = PRIORITIES.includes(b.priority) ? b.priority : 'normal';
  if (!title) return res.status(400).json({ error: 'Cần nhập tiêu đề.' });
  if (!db.prepare('SELECT 1 FROM depts WHERE id = ? AND active = 1').get(deptId)) return res.status(400).json({ error: 'Bộ phận không hợp lệ.' });
  if (typeId && !db.prepare('SELECT 1 FROM types WHERE id = ? AND dept_id = ?').get(typeId, deptId)) return res.status(400).json({ error: 'Loại yêu cầu không thuộc bộ phận này.' });
  const ts = now();
  const r = db.prepare(`INSERT INTO tickets(title, description, location, dept_id, type_id, priority, status, created_by, created_by_dept, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`)
    .run(title, str(b.description, 4000), str(b.location, 120), deptId, typeId, priority, req.user.id, req.user.dept_id, ts, ts);
  addHistory(r.lastInsertRowid, req.user.id, 'Tạo yêu cầu');
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(r.lastInsertRowid);
  broadcast('ticket', { ticket: t, kind: 'created' });
  const who = deptHandlers(deptId).filter(id => id !== req.user.id);
  const extra = priority === 'critical' ? hods() : [];
  notify([...who, ...extra.filter(id => id !== req.user.id)], t,
    `${PRIO_LABEL[priority]} · ${ticketCode(t.id)} gửi ${deptName(deptId)}`,
    `${title}${t.location ? ' · ' + t.location : ''}\nTừ ${req.user.name}`, priority !== 'normal');
  res.json(ticketOut(t));
});

app.post('/api/tickets/:id/action', auth, (req, res) => {
  const t = findTicket(req, res); if (!t) return;
  const u = req.user;
  const action = String((req.body || {}).action || '');
  const note = str((req.body || {}).note, 2000);
  const ts = now();
  let label, set = {};
  const handle = canHandle(u, t);
  switch (action) {
    case 'comment':
      if (!note) return res.status(400).json({ error: 'Nhập ghi chú trước.' });
      label = 'Ghi chú'; break;
    case 'accept':
      if (!handle || t.status !== 'open') return res.status(409).json({ error: 'Không nhận được yêu cầu này.' });
      label = 'Nhận xử lý → Process'; set = { status: 'process', assignee: u.id, accepted_at: ts }; break;
    case 'resume':
      if (!handle || t.status !== 'pending') return res.status(409).json({ error: 'Chỉ tiếp tục được yêu cầu đang Pending.' });
      label = 'Tiếp tục → Process'; set = { status: 'process', assignee: t.assignee || u.id, accepted_at: t.accepted_at || ts }; break;
    case 'pending':
      if (!handle || !['open', 'process'].includes(t.status)) return res.status(409).json({ error: 'Không chuyển Pending được.' });
      if (!note) return res.status(400).json({ error: 'Ghi lý do cần thêm thời gian.' });
      label = 'Chuyển Pending'; set = { status: 'pending', assignee: t.assignee || u.id, accepted_at: t.accepted_at || ts }; break;
    case 'follow':
      if (!handle || t.status !== 'process') return res.status(409).json({ error: 'Chỉ chuyển Follow khi đang Process.' });
      label = 'Đã xử lý → Follow'; set = { status: 'follow', follow_at: ts }; break;
    case 'done':
      if (!canConfirm(u, t) || t.status !== 'follow') return res.status(409).json({ error: 'Chỉ xác nhận Done khi đang Follow.' });
      label = 'Xác nhận → Done'; set = { status: 'done', done_at: ts }; break;
    case 'reopen':
      if (!canConfirm(u, t) || t.status !== 'follow') return res.status(409).json({ error: 'Chỉ mở lại khi đang Follow.' });
      label = 'Chưa đạt, mở lại → Process'; set = { status: 'process', follow_at: null }; break;
    default:
      return res.status(400).json({ error: 'Thao tác không hợp lệ.' });
  }
  set.updated_at = ts;
  const keys = Object.keys(set);
  db.prepare(`UPDATE tickets SET ${keys.map(k => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map(k => set[k]), t.id);
  addHistory(t.id, u.id, label, note);
  const nt = db.prepare('SELECT * FROM tickets WHERE id = ?').get(t.id);
  broadcast('ticket', { ticket: nt, kind: action });

  const code = ticketCode(t.id);
  if (action === 'follow' && nt.created_by !== u.id) {
    notify([nt.created_by], nt, `${code} đã xử lý xong, cần bạn xác nhận`, `${nt.title}${note ? '\n' + note : ''}`);
  } else if (action === 'accept' && nt.created_by !== u.id) {
    notify([nt.created_by], nt, `${code} đã có người nhận`, `${u.name} đang xử lý: ${nt.title}`);
  } else if (action === 'reopen' && nt.assignee && nt.assignee !== u.id) {
    notify([nt.assignee], nt, `${code} bị mở lại`, `${u.name}: ${note || nt.title}`, true);
  } else if (action === 'comment') {
    const to = [nt.created_by, nt.assignee].filter(id => id && id !== u.id);
    if (to.length) notify(to, nt, `Ghi chú mới ở ${code}`, `${u.name}: ${note}`);
  }
  res.json(ticketOut(nt));
});

/* ---------- reminders: open tickets past their response time ---------- */
function remindLate() {
  const sla = getSetting('sla');
  const open = db.prepare("SELECT * FROM tickets WHERE status = 'open' AND reminded_at IS NULL").all();
  for (const t of open) {
    const limit = (sla[t.priority] || sla.normal).resp * 60e3;
    if (now() - t.created_at < limit) continue;
    db.prepare('UPDATE tickets SET reminded_at = ? WHERE id = ?').run(now(), t.id);
    const to = deptHandlers(t.dept_id);
    if (t.priority === 'critical') to.push(...hods());
    notify(to, t, `Chưa ai nhận ${ticketCode(t.id)} (${PRIO_LABEL[t.priority]})`,
      `${t.title} · đã chờ ${Math.round((now() - t.created_at) / 60e3)} phút`, true);
  }
}
setInterval(remindLate, 30e3).unref();

/* ---------- admin ---------- */
const admin = [auth, requirePerm('config')];
app.get('/api/admin/users', admin, (req, res) => {
  res.json(db.prepare('SELECT * FROM users ORDER BY id').all().map(u => ({ ...publicUser(u), devices: push.countSubs(u.id) })));
});
app.post('/api/admin/users', admin, (req, res) => {
  const b = req.body || {};
  const username = str(b.username, 64).toLowerCase();
  const name = str(b.name, 120);
  const role = ROLES.includes(b.role) ? b.role : 'staff';
  const deptId = b.dept_id ? Number(b.dept_id) : null;
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) return res.status(400).json({ error: 'Tên đăng nhập 3–64 ký tự: chữ thường không dấu, số, dấu chấm, gạch.' });
  if (!name) return res.status(400).json({ error: 'Cần nhập họ tên.' });
  if (typeof b.password !== 'string' || b.password.length < 6) return res.status(400).json({ error: 'Mật khẩu cần ít nhất 6 ký tự.' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(409).json({ error: 'Tên đăng nhập đã có người dùng.' });
  const r = db.prepare('INSERT INTO users(username, name, password_hash, role, dept_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(username, name, bcrypt.hashSync(b.password, 10), role, deptId, now());
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid)));
});
app.patch('/api/admin/users/:id', admin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'Không tìm thấy người dùng.' });
  const b = req.body || {};
  if (b.role !== undefined) {
    if (!ROLES.includes(b.role)) return res.status(400).json({ error: 'Vai trò không hợp lệ.' });
    if (u.id === req.user.id && b.role !== 'it') return res.status(400).json({ error: 'Không tự bỏ quyền Admin IT của chính mình.' });
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, u.id);
  }
  if (b.dept_id !== undefined) db.prepare('UPDATE users SET dept_id = ? WHERE id = ?').run(b.dept_id ? Number(b.dept_id) : null, u.id);
  if (b.name !== undefined && str(b.name, 120)) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(str(b.name, 120), u.id);
  if (b.active !== undefined) {
    if (u.id === req.user.id) return res.status(400).json({ error: 'Không tự khoá tài khoản của chính mình.' });
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(b.active ? 1 : 0, u.id);
    if (!b.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  }
  if (b.password !== undefined) {
    if (typeof b.password !== 'string' || b.password.length < 6) return res.status(400).json({ error: 'Mật khẩu cần ít nhất 6 ký tự.' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(b.password, 10), u.id);
  }
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)));
});
app.post('/api/admin/depts', admin, (req, res) => {
  const name = str(req.body.name, 80);
  if (!name) return res.status(400).json({ error: 'Cần nhập tên bộ phận.' });
  try { db.prepare('INSERT INTO depts(name) VALUES (?)').run(name); } catch (e) { return res.status(409).json({ error: 'Bộ phận này đã có.' }); }
  res.json({ ok: true });
});
app.post('/api/admin/types', admin, (req, res) => {
  const name = str(req.body.name, 80); const deptId = Number(req.body.dept_id);
  if (!name || !db.prepare('SELECT 1 FROM depts WHERE id = ?').get(deptId)) return res.status(400).json({ error: 'Cần chọn bộ phận và nhập tên loại.' });
  try { db.prepare('INSERT INTO types(dept_id, name) VALUES (?, ?)').run(deptId, name); } catch (e) { return res.status(409).json({ error: 'Loại này đã có trong bộ phận.' }); }
  res.json({ ok: true });
});
app.delete('/api/admin/types/:id', admin, (req, res) => {
  const id = Number(req.params.id);
  if (db.prepare('SELECT 1 FROM tickets WHERE type_id = ?').get(id)) return res.status(409).json({ error: 'Loại đã có yêu cầu, không xoá được.' });
  db.prepare('DELETE FROM types WHERE id = ?').run(id);
  res.json({ ok: true });
});
app.put('/api/admin/sla', admin, (req, res) => {
  const b = req.body || {}; const sla = getSetting('sla');
  for (const p of PRIORITIES) {
    const r = Number(b[p] && b[p].resp), z = Number(b[p] && b[p].resolve);
    if (!(r > 0) || !(z > 0)) return res.status(400).json({ error: 'Thời gian SLA phải lớn hơn 0.' });
    sla[p] = { resp: Math.round(r), resolve: Math.round(z) };
  }
  setSetting('sla', sla);
  res.json(sla);
});
app.put('/api/admin/perms', admin, (req, res) => {
  const b = req.body || {}; const p = getSetting('perms');
  for (const r of ROLES) for (const k of Object.keys(p[r])) if (b[r] && b[r][k] !== undefined) p[r][k] = b[r][k] ? 1 : 0;
  p.it.config = 1; // Admin IT always keeps configuration rights
  setSetting('perms', p);
  res.json(p);
});

/* ---------- static app ---------- */
const pub = path.join(__dirname, '..', 'public');
app.get('/sw.js', (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(pub, 'sw.js')); });
app.use(express.static(pub, { index: 'index.html', maxAge: '1h' }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Không có API này.' }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Web Request đang chạy tại http://localhost:${PORT}`));
}
module.exports = { app };
