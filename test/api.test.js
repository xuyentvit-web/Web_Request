'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-test-'));
process.env.ADMIN_PASSWORD = 'admin-pass';
const { app } = require('../server/index');

let server, base;
before(async () => { server = app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

async function login(username, password) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.strictEqual(r.status, 200, `login ${username}`);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (p, body, method) => {
    const res = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}

test('full request flow with roles', async () => {
  const anon = await fetch(base + '/api/tickets');
  assert.strictEqual(anon.status, 401);
  const bad = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'nope' }) });
  assert.strictEqual(bad.status, 401);

  const admin = await login('admin', 'admin-pass');
  const cfg = (await admin('/api/me')).data;
  const D = n => cfg.depts.find(d => d.name === n).id;
  const T = (d, n) => cfg.types.find(t => t.dept_id === D(d) && t.name === n).id;

  for (const [u, n, role, d] of [['le.tan', 'Lễ Tân A', 'staff', 'Lễ tân'], ['ky.thuat', 'Kỹ Thuật B', 'staff', 'Kỹ thuật'], ['buong', 'Buồng C', 'staff', 'Buồng phòng'], ['hod', 'HoD D', 'hod', 'Lễ tân']]) {
    const r = await admin('/api/admin/users', { username: u, name: n, password: 'secret1', role, dept_id: D(d) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  }
  assert.strictEqual((await admin('/api/admin/users', { username: 'le.tan', name: 'x', password: 'secret1' })).status, 409);

  const fo = await login('le.tan', 'secret1');
  const eng = await login('ky.thuat', 'secret1');
  const hk = await login('buong', 'secret1');
  const hod = await login('hod', 'secret1');

  // staff cannot reach admin
  assert.strictEqual((await fo('/api/admin/users')).status, 403);

  const created = await fo('/api/tickets', { title: 'Điều hoà phòng 702 không mát', dept_id: D('Kỹ thuật'), type_id: T('Kỹ thuật', 'Điều hoà'), priority: 'critical', location: 'Phòng 702' });
  assert.strictEqual(created.status, 200);
  const code = created.data.code;
  assert.match(code, /^RQ-10\d\d$/);
  // type must belong to dept
  assert.strictEqual((await fo('/api/tickets', { title: 'x', dept_id: D('Kỹ thuật'), type_id: T('IT', 'Wifi / mạng') })).status, 400);

  // visibility: requester and handler dept see it, unrelated dept does not, HoD does
  assert.ok((await eng('/api/tickets')).data.some(t => t.code === code));
  assert.ok(!(await hk('/api/tickets')).data.some(t => t.code === code));
  assert.strictEqual((await hk('/api/tickets/' + code)).status, 404);
  assert.ok((await hod('/api/tickets')).data.some(t => t.code === code));

  // only handling dept can accept; HoD cannot
  assert.strictEqual((await fo(`/api/tickets/${code}/action`, { action: 'accept' })).status, 409);
  assert.strictEqual((await hod(`/api/tickets/${code}/action`, { action: 'accept' })).status, 409);
  let r = await eng(`/api/tickets/${code}/action`, { action: 'accept' });
  assert.strictEqual(r.data.status, 'process');
  assert.strictEqual((await eng(`/api/tickets/${code}/action`, { action: 'pending' })).status, 400, 'pending needs a reason');
  r = await eng(`/api/tickets/${code}/action`, { action: 'pending', note: 'Chờ linh kiện' });
  assert.strictEqual(r.data.status, 'pending');
  r = await eng(`/api/tickets/${code}/action`, { action: 'resume' });
  assert.strictEqual(r.data.status, 'process');
  r = await eng(`/api/tickets/${code}/action`, { action: 'follow', note: 'Đã nạp gas' });
  assert.strictEqual(r.data.status, 'follow');
  r = await fo(`/api/tickets/${code}/action`, { action: 'reopen', note: 'Vẫn chưa mát' });
  assert.strictEqual(r.data.status, 'process');
  await eng(`/api/tickets/${code}/action`, { action: 'follow' });
  r = await fo(`/api/tickets/${code}/action`, { action: 'done' });
  assert.strictEqual(r.data.status, 'done');
  assert.ok(r.data.done_at);
  r = await hod(`/api/tickets/${code}/action`, { action: 'comment', note: 'Cảm ơn team' });
  assert.strictEqual(r.status, 200);
  const detail = (await fo('/api/tickets/' + code)).data;
  assert.strictEqual(detail.history.length, 9);

  // admin: SLA, perms, lock account
  assert.strictEqual((await admin('/api/admin/sla', { normal: { resp: 20, resolve: 600 }, priority: { resp: 10, resolve: 120 }, critical: { resp: 5, resolve: 60 } }, 'PUT')).status, 200);
  const p = (await admin('/api/admin/perms', { it: { config: false }, hod: { handleOwn: true } }, 'PUT')).data;
  assert.strictEqual(p.it.config, 1);
  const users = (await admin('/api/admin/users')).data;
  const hkUser = users.find(u => u.username === 'buong');
  await admin('/api/admin/users/' + hkUser.id, { active: false }, 'PATCH');
  assert.strictEqual((await hk('/api/tickets')).status, 401, 'locked user is logged out');
  const self = users.find(u => u.username === 'admin');
  assert.strictEqual((await admin('/api/admin/users/' + self.id, { role: 'staff' }, 'PATCH')).status, 400);
});
