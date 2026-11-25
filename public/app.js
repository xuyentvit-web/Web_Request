(function () {
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const H = 3600e3, M = 60e3;

const STATUS = { open: 'Open', process: 'Process', follow: 'Follow', pending: 'Pending', done: 'Done' };
const STATUS_VI = { open: 'Mới tạo, chưa ai nhận', process: 'Đang xử lý', follow: 'Đã xử lý, chờ phản hồi', pending: 'Cần thêm thời gian', done: 'Hoàn tất' };
const STATUS_ORDER = ['open', 'process', 'follow', 'pending', 'done'];
const PRIO = { normal: 'Normal', priority: 'Priority', critical: 'Critical' };
const PRIO_ICON = { normal: '', priority: '▲', critical: '⬤' };
const ROLE = { staff: 'User / Admin bộ phận', hod: 'HoD', it: 'Admin IT' };

let C = null;          // config from /api/me
let tickets = [];
let tab = 'tickets';
let openId = null;     // ticket code shown in drawer
const ui = { q: '', fDept: '', fType: '', fPrio: '', fStatus: '', mine: false, range: 30, dDept: '', showTable: {} };

/* ---------- api ---------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty */ }
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('auth'); }
  if (!res.ok) throw new Error((data && data.error) || 'Có lỗi, thử lại sau.');
  return data;
}

/* ---------- lookups ---------- */
const me = () => C.me;
const can = k => !!C.perms[k];
const user = id => C.users.find(u => u.id === id);
const dept = id => C.depts.find(d => d.id === id) || { name: '—' };
const type = id => C.types.find(t => t.id === id);
function canHandle(t) { return me().role === 'it' || (can('handleOwn') && t.dept_id === me().dept_id); }
function canConfirm(t) { return canHandle(t) || t.created_by_dept === me().dept_id || t.created_by === me().id; }

/* ---------- time ---------- */
function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / M)); if (m < 60) return m + ' phút';
  const h = Math.floor(m / 60); if (h < 24) return h + ' giờ' + (m % 60 ? ' ' + (m % 60) + 'p' : '');
  const d = Math.floor(h / 24); return d + ' ngày' + (h % 24 ? ' ' + (h % 24) + 'h' : '');
}
const ago = ts => (Date.now() - ts < M ? 'vừa xong' : fmtDur(Date.now() - ts) + ' trước');
const fmtTime = ts => new Date(ts).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
function lateInfo(t) {
  const sl = C.sla[t.priority]; const now = Date.now();
  if (t.status === 'open' && now - t.created_at > sl.resp * M) return 'Quá hạn nhận';
  if ((t.status === 'process' || t.status === 'pending') && now - t.created_at > sl.resolve * M) return 'Quá hạn xử lý';
  return '';
}
function metSla(t) { const end = t.follow_at || t.done_at; if (!end) return null; return end - t.created_at <= C.sla[t.priority].resolve * M; }

/* ---------- toast & layers ---------- */
let toastT;
function toast(msg) {
  let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2800);
}
function closeLayer() { $('#layer').innerHTML = ''; openId = null; if (location.hash) history.replaceState(null, '', location.pathname); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLayer(); });
function modal(html, onSubmit) {
  $('#layer').innerHTML = `<div class="scrim" data-close></div><div class="modal" data-close><div class="modal-card" role="dialog" aria-modal="true">${html}</div></div>`;
  $('#layer').onclick = e => { if (e.target.hasAttribute('data-close')) closeLayer(); };
  const f = $('#layer form');
  if (f) f.onsubmit = async e => {
    e.preventDefault();
    const btn = f.querySelector('button.primary'); if (btn) btn.disabled = true;
    try { await onSubmit(new FormData(f), f); } catch (err) { if (err.message !== 'auth') { const el = f.querySelector('.err'); if (el) el.textContent = err.message; else toast(err.message); } }
    if (btn) btn.disabled = false;
  };
  const first = $('#layer input, #layer select, #layer textarea'); first && first.focus();
}

/* ---------- login ---------- */
function showLogin() {
  C = null; stopEvents();
  $('#layer').innerHTML = '';
  $('#app').innerHTML = `<div class="login wrap"><form class="login-card" id="loginForm">
    <div class="brand"><div class="brand-mark">RQ</div><div>Web Request<small>Yêu cầu nội bộ</small></div></div>
    <div class="field"><label for="lg-user">Tên đăng nhập</label><input type="text" id="lg-user" name="username" autocomplete="username" autocapitalize="none" required></div>
    <div class="field"><label for="lg-pass">Mật khẩu</label><input type="password" id="lg-pass" name="password" autocomplete="current-password" required style="background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:7px 10px"></div>
    <div class="err" id="lg-err"></div>
    <button class="btn primary">Đăng nhập</button>
    <p class="hint" style="margin:0">Chưa có tài khoản? Liên hệ Admin IT để được cấp.</p>
  </form></div>`;
  $('#lg-user').focus();
  $('#loginForm').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try { await api('/api/login', { body: { username: fd.get('username'), password: fd.get('password') } }); await boot(); }
    catch (err) { $('#lg-err').textContent = err.message; }
  };
}

/* ---------- boot ---------- */
async function loadConfig() { C = await api('/api/me'); }
async function loadTickets() { tickets = await api('/api/tickets'); }
async function boot() {
  try { await loadConfig(); } catch (e) { if (e.message !== 'auth') showLogin(); return; }
  await loadTickets();
  renderShell(); render(); startEvents();
  if (location.hash.length > 1) openTicket(decodeURIComponent(location.hash.slice(1)));
}
window.addEventListener('hashchange', () => { if (C && location.hash.length > 1) openTicket(decodeURIComponent(location.hash.slice(1))); });
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.type === 'open') { const u = new URL(e.data.url); if (u.hash.length > 1 && C) openTicket(decodeURIComponent(u.hash.slice(1))); }
  });
}

/* ---------- live updates ---------- */
let es = null;
function startEvents() {
  stopEvents();
  if (!window.EventSource) return;
  es = new EventSource('/api/events');
  es.onopen = () => setLive(true);
  es.onerror = () => setLive(false);
  es.addEventListener('ticket', async e => {
    const d = JSON.parse(e.data);
    await loadTickets();
    if (d.kind === 'created' && d.ticket.created_by !== me().id && d.ticket.dept_id === me().dept_id) toast(`Yêu cầu mới ${'RQ-' + (1000 + d.ticket.id)}: ${d.ticket.title}`);
    if (tab !== 'admin') render();
    if (openId && openId === 'RQ-' + (1000 + d.ticket.id)) openTicket(openId, true);
  });
}
function stopEvents() { if (es) { es.close(); es = null; } }
function setLive(on) { const l = $('#live'); if (l) { l.classList.toggle('on', on); l.title = on ? 'Đang cập nhật trực tiếp' : 'Mất kết nối, đang thử lại'; } }

/* ---------- push ---------- */
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function b64ToU8(b64) { const p = '='.repeat((4 - b64.length % 4) % 4); const s = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, c => c.charCodeAt(0)); }
async function currentSub() { if (!pushSupported()) return null; const reg = await navigator.serviceWorker.ready; return reg.pushManager.getSubscription(); }
async function enablePush() {
  if (!pushSupported()) {
    if (isIOS() && !isStandalone()) return toast('Trên iPhone: bấm Chia sẻ → "Thêm vào MH chính", rồi mở app từ màn hình chính để bật thông báo.');
    return toast('Trình duyệt này không hỗ trợ thông báo đẩy.');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('Bạn chưa cho phép thông báo. Bật lại trong cài đặt trình duyệt.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(C.vapidPublicKey) });
  await api('/api/push/subscribe', { body: sub.toJSON() });
  await api('/api/push/test', { body: {} });
  toast('Đã bật thông báo trên thiết bị này');
  renderShell();
}
async function disablePush() {
  const sub = await currentSub();
  if (sub) { await api('/api/push/unsubscribe', { body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); }
  toast('Đã tắt thông báo trên thiết bị này'); renderShell();
}

/* ---------- shell ---------- */
async function renderShell() {
  const u = me();
  const sub = await currentSub().catch(() => null);
  const tabs = [['tickets', 'Yêu cầu'], ['dashboard', 'Dashboard']];
  if (can('config')) tabs.push(['admin', 'Phân quyền & cấu hình']);
  $('#app').innerHTML = `
  <header class="top"><div class="wrap">
    <div class="top-row">
      <div class="brand"><div class="brand-mark">RQ</div><div>Web Request<small>${esc(u.dept_id ? dept(u.dept_id).name : 'Yêu cầu nội bộ')}</small></div></div>
      <div class="spacer"></div>
      <button class="bell ${sub ? 'on' : ''}" id="bell" title="${sub ? 'Thông báo đang bật trên thiết bị này' : 'Bật thông báo khi có yêu cầu mới'}">${sub ? '🔔 Thông báo: bật' : '🔕 Bật thông báo'}</button>
      <div style="position:relative">
        <button class="menu-btn" id="menuBtn" aria-haspopup="true" aria-expanded="false"><span class="avatar">${esc(u.name.split(' ').pop().slice(0, 1).toUpperCase())}</span><span class="hide-sm">${esc(u.name)}</span><span class="live" id="live"></span></button>
        <div class="menu" id="menu" hidden>
          <div class="info"><b>${esc(u.name)}</b><div class="t-sub">${esc(ROLE[u.role])}${u.dept_id ? ' · ' + esc(dept(u.dept_id).name) : ''} · @${esc(u.username)}</div></div>
          <button data-m="push">${sub ? 'Tắt thông báo trên thiết bị này' : 'Bật thông báo trên thiết bị này'}</button>
          <button data-m="pw">Đổi mật khẩu</button>
          <button data-m="out">Đăng xuất</button>
        </div>
      </div>
    </div>
    <nav class="tabs" role="tablist" id="tabs">${tabs.map(([k, l]) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="${tab === k}">${l}</button>`).join('')}</nav>
  </div></header>
  <main class="wrap" id="main"></main>`;
  setLive(!!es && es.readyState === 1);
  $('#bell').onclick = () => (sub ? disablePush() : enablePush()).catch(e => toast(e.message));
  $('#menuBtn').onclick = e => { e.stopPropagation(); const m = $('#menu'); m.hidden = !m.hidden; $('#menuBtn').setAttribute('aria-expanded', String(!m.hidden)); };
  document.onclick = e => { const m = $('#menu'); if (m && !m.hidden && !e.target.closest('#menu')) m.hidden = true; };
  $('#menu').onclick = async e => {
    const b = e.target.closest('[data-m]'); if (!b) return; $('#menu').hidden = true;
    if (b.dataset.m === 'push') (sub ? disablePush() : enablePush()).catch(err => toast(err.message));
    if (b.dataset.m === 'pw') changePassword();
    if (b.dataset.m === 'out') { await api('/api/logout', { body: {} }).catch(() => {}); showLogin(); }
  };
  $('#tabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (!b) return; tab = b.dataset.tab; $('#tabs').querySelectorAll('.tab').forEach(x => x.setAttribute('aria-selected', String(x === b))); render(); };
  render();
}
function changePassword() {
  modal(`<form><h2 style="margin:0">Đổi mật khẩu</h2>
    <div class="field"><label for="pw-cur">Mật khẩu hiện tại</label><input type="password" id="pw-cur" name="current" required autocomplete="current-password" style="background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:7px 10px"></div>
    <div class="field"><label for="pw-new">Mật khẩu mới (ít nhất 6 ký tự)</label><input type="password" id="pw-new" name="next" minlength="6" required autocomplete="new-password" style="background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:7px 10px"></div>
    <div class="err"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn" data-close>Huỷ</button><button class="btn primary">Lưu</button></div></form>`,
  async fd => { await api('/api/me/password', { body: { current: fd.get('current'), next: fd.get('next') } }); closeLayer(); toast('Đã đổi mật khẩu'); });
}

function render() {
  if (!C || !$('#main')) return;
  if (tab === 'dashboard') renderDash();
  else if (tab === 'admin' && can('config')) renderAdmin();
  else { tab = 'tickets'; renderTickets(); }
}

/* ---------- tickets ---------- */
const prioRank = p => (p === 'critical' ? 0 : p === 'priority' ? 1 : 2);
const statusBadge = s => `<span class="status st-${s}"><i></i>${STATUS[s]}</span>`;
const prioBadge = p => `<span class="prio pr-${p}">${PRIO_ICON[p] ? `<span aria-hidden="true" style="font-size:9px">${PRIO_ICON[p]}</span>` : ''}${PRIO[p]}</span>`;

function filtered() {
  const u = me(); const q = ui.q.trim().toLowerCase();
  return tickets
    .filter(t => !ui.fDept || t.dept_id === +ui.fDept)
    .filter(t => !ui.fType || t.type_id === +ui.fType)
    .filter(t => !ui.fPrio || t.priority === ui.fPrio)
    .filter(t => !ui.mine || t.assignee === u.id || t.created_by === u.id)
    .filter(t => !q || [t.code, t.title, t.description, t.location, dept(t.dept_id).name, type(t.type_id)?.name, user(t.created_by)?.name, user(t.assignee)?.name].join(' ').toLowerCase().includes(q));
}
async function pushBanner() {
  if (localStorage.getItem('wr-hide-push') === '1') return '';
  const sub = await currentSub().catch(() => null);
  if (sub) return '';
  const ios = isIOS() && !isStandalone();
  return `<div class="banner" id="pushBanner"><p>${ios
    ? 'Muốn nhận thông báo trên iPhone: bấm nút <b>Chia sẻ</b> → <b>Thêm vào MH chính</b>, mở app từ màn hình chính rồi bật thông báo.'
    : 'Bật thông báo để biết ngay khi có yêu cầu mới, kể cả khi không mở web.'}</p>
    ${ios ? '' : '<button class="btn primary sm" data-banner="on">Bật thông báo</button>'}<button class="btn sm" data-banner="hide">Để sau</button></div>`;
}
async function renderTickets() {
  const u = me();
  const base = filtered();
  const counts = {}; STATUS_ORDER.forEach(s => (counts[s] = base.filter(t => t.status === s).length));
  const rows = base.filter(t => !ui.fStatus || t.status === ui.fStatus);
  rows.sort((a, b) => {
    const da = a.status === 'done', db = b.status === 'done'; if (da !== db) return da ? 1 : -1;
    if (!da) { const p = prioRank(a.priority) - prioRank(b.priority); if (p) return p; }
    return b.created_at - a.created_at;
  });
  const scope = can('viewAll') ? 'Tất cả bộ phận' : `Yêu cầu bộ phận ${dept(u.dept_id).name} gửi đi hoặc cần xử lý`;
  const typeOpts = C.types.filter(t => !ui.fDept || t.dept_id === +ui.fDept);
  const banner = await pushBanner();
  if (tab !== 'tickets') return;
  $('#main').innerHTML = `${banner}
  <div class="page-head">
    <div><h1>Yêu cầu</h1><p>${esc(scope)}</p></div>
    <div class="spacer"></div>
    ${can('create') ? '<button class="btn primary" id="new">+ Tạo yêu cầu</button>' : ''}
  </div>
  <div class="filters">
    <div class="search"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="7" cy="7" r="5"/><path d="m11 11 3.5 3.5"/></svg>
      <input type="text" id="q" placeholder="Tìm theo từ khoá: số phòng, nội dung, mã RQ, tên…" value="${esc(ui.q)}"></div>
    <select id="fDept" aria-label="Bộ phận xử lý"><option value="">Mọi bộ phận</option>${C.depts.map(d => `<option value="${d.id}" ${+ui.fDept === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
    <select id="fType" aria-label="Loại yêu cầu"><option value="">Mọi loại</option>${typeOpts.map(t => `<option value="${t.id}" ${+ui.fType === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
    <select id="fPrio" aria-label="Mức độ"><option value="">Mọi mức độ</option>${Object.keys(PRIO).map(p => `<option value="${p}" ${ui.fPrio === p ? 'selected' : ''}>${PRIO[p]}</option>`).join('')}</select>
    <label class="chip"><input type="checkbox" id="mine" ${ui.mine ? 'checked' : ''}> Của tôi</label>
  </div>
  <div class="chips" id="stChips">
    <button class="chip" data-st="" aria-pressed="${!ui.fStatus}">Tất cả <span class="n">${base.length}</span></button>
    ${STATUS_ORDER.map(s => `<button class="chip" data-st="${s}" aria-pressed="${ui.fStatus === s}"><span class="status st-${s}" style="padding:0;background:none"><i></i></span>${STATUS[s]} <span class="n">${counts[s]}</span></button>`).join('')}
  </div>
  <div class="panel table-scroll">
  ${rows.length ? `<table><thead><tr><th>Mã</th><th>Yêu cầu</th><th>Mức độ</th><th>Trạng thái</th><th class="hide-sm">Bộ phận xử lý</th><th class="hide-sm">Người nhận</th><th>Tạo lúc</th></tr></thead><tbody>
  ${rows.map(t => { const late = t.status !== 'done' ? lateInfo(t) : ''; const live = t.status !== 'done'; return `<tr data-id="${t.code}" class="${live && t.priority === 'critical' ? 'crit' : live && t.priority === 'priority' ? 'prio' : ''}">
    <td class="mono">${t.code}</td>
    <td><div class="t-title">${esc(t.title)}</div><div class="t-sub">${esc(type(t.type_id)?.name || '')}${t.location ? ' · ' + esc(t.location) : ''} · từ ${esc(dept(t.created_by_dept).name)}</div></td>
    <td>${prioBadge(t.priority)}</td>
    <td>${statusBadge(t.status)}${late ? `<div class="late">${late}</div>` : ''}</td>
    <td class="hide-sm nowrap">${esc(dept(t.dept_id).name)}</td>
    <td class="hide-sm nowrap">${t.assignee ? esc(user(t.assignee)?.name) : '<span class="t-sub">Chưa có</span>'}</td>
    <td class="nowrap t-sub">${ago(t.created_at)}</td></tr>`; }).join('')}
  </tbody></table>` : `<div class="empty">${tickets.length ? 'Không có yêu cầu nào khớp bộ lọc. Thử bỏ bớt điều kiện hoặc từ khoá.' : 'Chưa có yêu cầu nào. Bấm “Tạo yêu cầu” để gửi yêu cầu đầu tiên.'}</div>`}
  </div>`;
  const q = $('#q'); q.addEventListener('input', () => { ui.q = q.value; const pos = q.selectionStart; renderTickets().then(() => { const n = $('#q'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }); });
  $('#fDept').onchange = e => { ui.fDept = e.target.value; ui.fType = ''; renderTickets(); };
  $('#fType').onchange = e => { ui.fType = e.target.value; renderTickets(); };
  $('#fPrio').onchange = e => { ui.fPrio = e.target.value; renderTickets(); };
  $('#mine').onchange = e => { ui.mine = e.target.checked; renderTickets(); };
  $('#stChips').onclick = e => { const b = e.target.closest('[data-st]'); if (!b) return; ui.fStatus = b.dataset.st; renderTickets(); };
  $('#main tbody')?.addEventListener('click', e => { const tr = e.target.closest('tr[data-id]'); if (tr) openTicket(tr.dataset.id); });
  $('#new') && ($('#new').onclick = openCreate);
  const pb = $('#pushBanner');
  if (pb) pb.onclick = e => {
    const b = e.target.closest('[data-banner]'); if (!b) return;
    if (b.dataset.banner === 'hide') { try { localStorage.setItem('wr-hide-push', '1'); } catch (err) { /* ignore */ } pb.remove(); }
    else enablePush().then(() => renderTickets()).catch(err => toast(err.message));
  };
}

/* ---------- create ---------- */
function openCreate() {
  const u = me();
  const depts = C.depts.filter(d => d.active);
  const defDept = (depts.find(d => d.id !== u.dept_id) || depts[0]).id;
  const typeOptions = d => C.types.filter(t => t.dept_id === +d && t.active).map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  modal(`<form>
    <div style="display:flex;align-items:center"><h2 style="margin:0">Tạo yêu cầu mới</h2><div class="spacer"></div><button type="button" class="x" data-close aria-label="Đóng">×</button></div>
    <div class="field"><label for="c-title">Tiêu đề</label><input type="text" id="c-title" name="title" required maxlength="200" placeholder="VD: Điều hoà phòng 702 không mát"></div>
    <div class="grid2">
      <div class="field"><label for="c-dept">Gửi tới bộ phận</label><select id="c-dept" name="dept_id">${depts.map(d => `<option value="${d.id}" ${d.id === defDept ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="c-type">Loại yêu cầu</label><select id="c-type" name="type_id">${typeOptions(defDept)}</select></div>
    </div>
    <div class="field"><label>Mức độ</label><div class="seg">
      ${Object.keys(PRIO).map((p, i) => `<label><input type="radio" name="priority" value="${p}" ${i === 0 ? 'checked' : ''}>${PRIO[p]}<div class="hint">Nhận trong ${C.sla[p].resp} phút · xong trong ${fmtDur(C.sla[p].resolve * M)}</div></label>`).join('')}
    </div></div>
    <div class="field"><label for="c-loc">Vị trí</label><input type="text" id="c-loc" name="location" maxlength="120" placeholder="VD: Phòng 702, Sảnh, Bếp…"></div>
    <div class="field"><label for="c-desc">Mô tả</label><textarea id="c-desc" name="description" maxlength="4000" placeholder="Mô tả ngắn tình trạng, khách đang chờ hay không…"></textarea></div>
    <div class="err"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn" data-close>Huỷ</button><button class="btn primary">Gửi yêu cầu</button></div>
  </form>`, async fd => {
    const t = await api('/api/tickets', { body: Object.fromEntries(fd) });
    closeLayer(); ui.fStatus = '';
    await loadTickets(); render();
    toast(`Đã gửi ${t.code} tới ${dept(t.dept_id).name}`);
  });
  $('#c-dept').onchange = e => { $('#c-type').innerHTML = typeOptions(e.target.value); };
}

/* ---------- detail ---------- */
async function openTicket(code, keepNote) {
  let t;
  try { t = await api('/api/tickets/' + encodeURIComponent(code)); } catch (e) { if (e.message !== 'auth') toast(e.message); return; }
  const prevNote = keepNote && $('#note') ? $('#note').value : '';
  openId = t.code;
  if (location.hash !== '#' + t.code) history.replaceState(null, '', '#' + t.code);
  const u = me(); const acts = [];
  if (canHandle(t)) {
    if (t.status === 'open') { acts.push(['accept', 'Nhận xử lý', 'primary']); acts.push(['pending', 'Cần thêm thời gian → Pending', '']); }
    if (t.status === 'process') { acts.push(['follow', 'Đã xử lý xong → Follow', 'primary']); acts.push(['pending', 'Cần thêm thời gian → Pending', '']); }
    if (t.status === 'pending') acts.push(['resume', 'Tiếp tục xử lý', 'primary']);
  }
  if (t.status === 'follow' && canConfirm(t)) { acts.push(['done', 'Xác nhận hoàn tất → Done', 'primary']); acts.push(['reopen', 'Chưa đạt, mở lại', '']); }
  const late = t.status !== 'done' ? lateInfo(t) : '';
  const met = metSla(t);
  const sl = C.sla[t.priority];
  $('#layer').innerHTML = `<div class="scrim" data-close></div>
  <aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(t.code)}">
    <div class="drawer-head"><div style="flex:1;min-width:0"><div class="mono">${t.code}</div><h2 style="margin:2px 0 6px;font-size:18px">${esc(t.title)}</h2>
      <div style="display:flex;gap:6px;flex-wrap:wrap">${prioBadge(t.priority)}${statusBadge(t.status)}${late ? `<span class="late" style="align-self:center">${late}</span>` : ''}</div></div>
      <button class="x" data-close aria-label="Đóng">×</button></div>
    <div class="drawer-body">
      <div class="flow" aria-label="Luồng trạng thái">${['open', 'process', 'pending', 'follow', 'done'].map((s, i) => `${i ? '<b>›</b>' : ''}<span class="${t.status === s ? 'on' : ''}">${STATUS[s]}</span>`).join('')}</div>
      <p style="margin:-8px 0 0;color:var(--fg-2);font-size:13px">${STATUS_VI[t.status]}</p>
      <dl class="meta">
        <dt>Bộ phận xử lý</dt><dd>${esc(dept(t.dept_id).name)}${t.type_id ? ' · ' + esc(type(t.type_id)?.name) : ''}</dd>
        <dt>Vị trí</dt><dd>${esc(t.location || '—')}</dd>
        <dt>Người gửi</dt><dd>${esc(user(t.created_by)?.name)} (${esc(dept(t.created_by_dept).name)})</dd>
        <dt>Người nhận</dt><dd>${t.assignee ? esc(user(t.assignee)?.name) : 'Chưa có'}</dd>
        <dt>Tạo lúc</dt><dd>${fmtTime(t.created_at)} · ${ago(t.created_at)}</dd>
        <dt>SLA</dt><dd>Nhận trong ${sl.resp} phút, xong trong ${fmtDur(sl.resolve * M)}${met === null ? '' : met ? ' · <span class="yes">Đạt</span>' : ' · <span class="late">Trễ</span>'}</dd>
      </dl>
      ${t.description ? `<div><h2 style="margin-bottom:4px">Mô tả</h2><p style="margin:0;white-space:pre-wrap">${esc(t.description)}</p></div>` : ''}
      <div><h2>Lịch sử</h2><ul class="timeline">${t.history.slice().reverse().map(h => `<li><span class="dot"></span><div><div><b>${esc(user(h.user_id)?.name || '?')}</b> · ${esc(h.action)}</div><div class="when">${fmtTime(h.at)}</div>${h.note ? `<div class="note">${esc(h.note)}</div>` : ''}</div></li>`).join('')}</ul></div>
      <div class="field"><label for="note">Ghi chú / phản hồi${acts.length ? ' (đi kèm thao tác)' : ''}</label><textarea id="note" maxlength="2000" placeholder="${t.status === 'process' ? 'VD: đã thay tụ điện, nhờ lễ tân hỏi lại khách' : 'Thêm ghi chú…'}">${esc(prevNote)}</textarea></div>
    </div>
    <div class="drawer-foot">
      ${acts.map(([k, l, c]) => `<button class="btn ${c}" data-act="${k}">${l}</button>`).join('')}
      <button class="btn" data-act="comment">Chỉ thêm ghi chú</button>
      ${!acts.length && !canHandle(t) && t.status !== 'done' ? `<span class="hint" style="align-self:center">${u.role === 'hod' ? 'HoD theo dõi và ghi chú, bộ phận ' + esc(dept(t.dept_id).name) + ' xử lý.' : 'Chỉ bộ phận ' + esc(dept(t.dept_id).name) + ' cập nhật được trạng thái.'}</span>` : ''}
    </div>
  </aside>`;
  $('#layer').onclick = async e => {
    if (e.target.hasAttribute('data-close')) { closeLayer(); return; }
    const b = e.target.closest('[data-act]'); if (!b) return;
    const note = $('#note').value.trim(); const a = b.dataset.act;
    if (a === 'comment' && !note) { toast('Nhập ghi chú trước'); $('#note').focus(); return; }
    if (a === 'pending' && !note) { toast('Ghi lý do cần thêm thời gian'); $('#note').focus(); return; }
    b.disabled = true;
    try {
      const nt = await api(`/api/tickets/${t.code}/action`, { body: { action: a, note } });
      await loadTickets(); render(); openTicket(nt.code);
      toast(a === 'comment' ? 'Đã thêm ghi chú' : `Đã chuyển ${nt.code} sang ${STATUS[nt.status]}`);
    } catch (err) { b.disabled = false; if (err.message !== 'auth') toast(err.message); }
  };
}

/* ---------- dashboard ---------- */
const SC = s => `var(--s-${s})`;
function renderDash() {
  const u = me(); const all = can('reportAll');
  const now = Date.now(); const from = now - ui.range * 24 * H;
  let ts = tickets.filter(t => (all ? true : t.dept_id === u.dept_id));
  if (all && ui.dDept) ts = ts.filter(t => t.dept_id === +ui.dDept);
  const inRange = ts.filter(t => t.created_at >= from);
  const active = ts.filter(t => t.status !== 'done');
  const critOpen = active.filter(t => t.priority === 'critical').length;
  const lateN = active.filter(t => lateInfo(t)).length;
  const finished = inRange.filter(t => t.follow_at);
  const slaPct = finished.length ? Math.round(finished.filter(metSla).length / finished.length * 100) : null;
  const accepted = inRange.filter(t => t.accepted_at);
  const avgResp = accepted.length ? accepted.reduce((s, t) => s + (t.accepted_at - t.created_at), 0) / accepted.length : null;
  const avgRes = finished.length ? finished.reduce((s, t) => s + (t.follow_at - t.created_at), 0) / finished.length : null;
  const scopeName = all ? (ui.dDept ? dept(+ui.dDept).name : 'Toàn khách sạn') : 'Bộ phận ' + dept(u.dept_id).name;
  const byDeptAll = all && !ui.dDept;

  $('#main').innerHTML = `
  <div class="page-head"><div><h1>Dashboard</h1><p>${esc(scopeName)} · ${ui.range} ngày gần nhất</p></div><div class="spacer"></div>
    <div class="filters" style="margin:0">
      ${all ? `<select id="dDept" aria-label="Bộ phận"><option value="">Mọi bộ phận</option>${C.depts.map(d => `<option value="${d.id}" ${+ui.dDept === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>` : ''}
      ${[7, 14, 30].map(r => `<button class="chip" data-range="${r}" aria-pressed="${ui.range === r}">${r} ngày</button>`).join('')}
    </div></div>
  <div class="kpis">
    <div class="kpi"><div class="k">Yêu cầu mới</div><div class="v">${inRange.length}</div><div class="d">trong ${ui.range} ngày</div></div>
    <div class="kpi"><div class="k">Đang mở</div><div class="v">${active.length}</div><div class="d">${STATUS_ORDER.slice(0, 4).map(s => active.filter(t => t.status === s).length + ' ' + STATUS[s]).join(' · ')}</div></div>
    <div class="kpi ${critOpen ? 'alert' : ''}"><div class="k">Critical đang mở</div><div class="v">${critOpen}</div><div class="d">${lateN} yêu cầu đang quá hạn SLA</div></div>
    <div class="kpi"><div class="k">Đạt SLA xử lý</div><div class="v">${slaPct === null ? '—' : slaPct + '%'}</div><div class="d">${finished.length} yêu cầu đã xử lý xong</div></div>
    <div class="kpi"><div class="k">Thời gian nhận TB</div><div class="v" style="font-size:22px">${avgResp === null ? '—' : fmtDur(avgResp)}</div><div class="d">xử lý xong TB ${avgRes === null ? '—' : fmtDur(avgRes)}</div></div>
  </div>
  <div class="dash-grid">
    <section class="panel wide"><div class="panel-head"><h2>Yêu cầu theo ngày</h2><button class="toggle-table" data-tt="trend">${ui.showTable.trend ? 'Xem biểu đồ' : 'Xem bảng'}</button></div>
      <div class="legend"><span><i style="background:var(--s-open)"></i>Tạo mới</span><span><i style="background:var(--s-done)"></i>Xử lý xong</span></div>
      <div id="trend"></div></section>
    <section class="panel ${byDeptAll ? '' : 'wide'}"><div class="panel-head"><h2>${byDeptAll ? 'Trạng thái theo bộ phận' : 'Trạng thái'}</h2><button class="toggle-table" data-tt="dept">${ui.showTable.dept ? 'Xem biểu đồ' : 'Xem bảng'}</button></div>
      <div class="legend">${STATUS_ORDER.map(s => `<span><i style="background:${SC(s)}"></i>${STATUS[s]}</span>`).join('')}</div>
      <div id="byDept"></div></section>
    ${byDeptAll ? `<section class="panel"><h2>Thời gian xử lý & SLA theo bộ phận</h2><div class="table-scroll"><table class="mini"><thead><tr><th>Bộ phận</th><th class="num">Tổng</th><th class="num">Nhận TB</th><th class="num">Xử lý TB</th><th class="num">Đạt SLA</th></tr></thead><tbody>
      ${C.depts.map(d => { const x = inRange.filter(t => t.dept_id === d.id); const ac = x.filter(t => t.accepted_at); const fi = x.filter(t => t.follow_at);
        const r = fi.length ? Math.round(fi.filter(metSla).length / fi.length * 100) : null;
        return `<tr><td>${esc(d.name)}</td><td class="num">${x.length}</td><td class="num">${ac.length ? fmtDur(ac.reduce((s, t) => s + t.accepted_at - t.created_at, 0) / ac.length) : '—'}</td><td class="num">${fi.length ? fmtDur(fi.reduce((s, t) => s + t.follow_at - t.created_at, 0) / fi.length) : '—'}</td><td class="num">${r === null ? '—' : `<span class="${r >= 80 ? 'yes' : 'late'}">${r}%</span>`}</td></tr>`; }).join('')}
    </tbody></table></div></section>` : ''}
    <section class="panel"><h2>Theo mức độ</h2><div id="byPrio"></div></section>
    <section class="panel"><h2>Loại yêu cầu nhiều nhất</h2><div id="byType"></div></section>
  </div>`;
  $('#dDept') && ($('#dDept').onchange = e => { ui.dDept = e.target.value; renderDash(); });
  $('#main').querySelectorAll('[data-range]').forEach(b => (b.onclick = () => { ui.range = +b.dataset.range; renderDash(); }));
  $('#main').querySelectorAll('[data-tt]').forEach(b => (b.onclick = () => { ui.showTable[b.dataset.tt] = !ui.showTable[b.dataset.tt]; renderDash(); }));

  const days = []; for (let i = ui.range - 1; i >= 0; i--) { const d = new Date(now - i * 24 * H); d.setHours(0, 0, 0, 0); days.push(d.getTime()); }
  const cr = days.map(d => ts.filter(t => t.created_at >= d && t.created_at < d + 24 * H).length);
  const dn = days.map(d => ts.filter(t => t.follow_at && t.follow_at >= d && t.follow_at < d + 24 * H).length);
  const lbl = d => { const x = new Date(d); return x.getDate() + '/' + (x.getMonth() + 1); };
  if (ui.showTable.trend) {
    $('#trend').innerHTML = `<div class="table-scroll"><table class="mini"><thead><tr><th>Ngày</th><th class="num">Tạo mới</th><th class="num">Xử lý xong</th></tr></thead><tbody>${days.map((d, i) => `<tr><td>${lbl(d)}</td><td class="num">${cr[i]}</td><td class="num">${dn[i]}</td></tr>`).join('')}</tbody></table></div>`;
  } else lineChart($('#trend'), days.map(lbl), [{ name: 'Tạo mới', c: 'var(--s-open)', v: cr }, { name: 'Xử lý xong', c: 'var(--s-done)', v: dn }]);

  const pool = active.concat(inRange.filter(t => t.status === 'done'));
  const groups = byDeptAll ? C.depts.map(d => ({ name: d.name, items: pool.filter(t => t.dept_id === d.id) })) : [{ name: scopeName, items: pool }];
  if (ui.showTable.dept) {
    $('#byDept').innerHTML = `<div class="table-scroll"><table class="mini"><thead><tr><th>Bộ phận</th>${STATUS_ORDER.map(s => `<th class="num">${STATUS[s]}</th>`).join('')}</tr></thead><tbody>${groups.map(g => `<tr><td>${esc(g.name)}</td>${STATUS_ORDER.map(s => `<td class="num">${g.items.filter(t => t.status === s).length}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  } else {
    const max = Math.max(1, ...groups.map(g => g.items.length));
    $('#byDept').innerHTML = groups.map(g => `<div class="hbar-row"><span title="${esc(g.name)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(g.name)}</span><div class="hbar-track" style="width:${g.items.length / max * 100}%">${STATUS_ORDER.map(s => { const n = g.items.filter(t => t.status === s).length; return n ? `<div data-tip="${esc(g.name)} · ${STATUS[s]}: ${n}" style="flex:${n};background:${SC(s)}"></div>` : ''; }).join('')}</div><span class="num t-sub">${g.items.length}</span></div>`).join('') +
      `<p class="hint" style="margin:4px 0 0">Gồm yêu cầu đang mở và yêu cầu Done trong ${ui.range} ngày.</p>`;
  }
  const pmax = Math.max(1, ...Object.keys(PRIO).map(p => inRange.filter(t => t.priority === p).length));
  $('#byPrio').innerHTML = Object.keys(PRIO).map(p => { const x = inRange.filter(t => t.priority === p); const op = x.filter(t => t.status !== 'done').length;
    return `<div class="hbar-row"><span>${prioBadge(p)}</span><div class="hbar-track" style="width:${x.length / pmax * 100}%"><div data-tip="${PRIO[p]}: ${x.length} yêu cầu, ${op} chưa xong" style="flex:1;background:var(--p-${p})"></div></div><span class="num t-sub">${x.length}</span></div>`; }).join('');
  const tc = {}; inRange.forEach(t => { if (t.type_id) tc[t.type_id] = (tc[t.type_id] || 0) + 1; });
  const top = Object.entries(tc).sort((a, b) => b[1] - a[1]).slice(0, 6); const tmax = top.length ? top[0][1] : 1;
  $('#byType').innerHTML = top.length ? top.map(([id, n]) => { const ty = type(+id) || { name: '?', dept_id: 0 }; return `<div class="hbar-row" style="grid-template-columns:minmax(0,1.3fr) 1fr 32px"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(ty.name)}">${esc(ty.name)} <span class="t-sub">· ${esc(dept(ty.dept_id).name)}</span></span><div class="hbar-track" style="width:${n / tmax * 100}%"><div data-tip="${esc(ty.name)}: ${n}" style="flex:1;background:var(--accent)"></div></div><span class="num t-sub">${n}</span></div>`; }).join('') : '<div class="empty">Chưa có dữ liệu trong khoảng này.</div>';
}
function lineChart(el, labels, series) {
  const W = 900, Hh = 220, pl = 32, pr = 12, pt = 12, pb = 26;
  const max = Math.max(4, ...series.flatMap(s => s.v)); const step = Math.ceil(max / 4); const top = step * 4;
  const x = i => pl + (labels.length === 1 ? 0 : i * (W - pl - pr) / (labels.length - 1)); const y = v => pt + (Hh - pt - pb) * (1 - v / top);
  const every = Math.ceil(labels.length / 10);
  let g = ''; for (let k = 0; k <= 4; k++) { const v = k * step; g += `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`; }
  labels.forEach((l, i) => { if (i % every === 0 || i === labels.length - 1) g += `<text x="${x(i)}" y="${Hh - 6}" text-anchor="middle">${l}</text>`; });
  const paths = series.map(s => { const d = s.v.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1)).join('');
    const last = s.v.length - 1; return `<path d="${d}" fill="none" stroke="${s.c}" stroke-width="2" stroke-linejoin="round"/><circle cx="${x(last)}" cy="${y(s.v[last])}" r="4" fill="${s.c}" stroke="var(--surface)" stroke-width="2"/>`; }).join('');
  el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Số yêu cầu tạo mới và xử lý xong theo ngày">${g}${paths}<line id="xh" class="grid" y1="${pt}" y2="${Hh - pb}" stroke-dasharray="3 3" visibility="hidden" style="stroke:var(--fg-3)"/><rect x="${pl}" y="${pt}" width="${W - pl - pr}" height="${Hh - pt - pb}" fill="transparent" id="hit"/></svg>`;
  const svg = el.querySelector('svg'), hit = el.querySelector('#hit'), xh = el.querySelector('#xh'), tip = $('#tip');
  hit.addEventListener('mousemove', e => { const r = svg.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * W;
    const i = Math.max(0, Math.min(labels.length - 1, Math.round((px - pl) / ((W - pl - pr) / Math.max(1, labels.length - 1)))));
    xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.setAttribute('visibility', 'visible');
    tip.innerHTML = `<b>${labels[i]}</b> · ` + series.map(s => `${s.name}: ${s.v[i]}`).join(' · '); tip.hidden = false; placeTip(e); });
  hit.addEventListener('mouseleave', () => { xh.setAttribute('visibility', 'hidden'); tip.hidden = true; });
}
function placeTip(e) { const tip = $('#tip'); const w = tip.offsetWidth; tip.style.left = Math.min(window.innerWidth - w - 8, e.clientX + 12) + 'px'; tip.style.top = (e.clientY - 36) + 'px'; }
document.addEventListener('mousemove', e => { const d = e.target.closest && e.target.closest('[data-tip]'); const tip = $('#tip');
  if (d) { tip.textContent = d.dataset.tip; tip.hidden = false; placeTip(e); } else if (!e.target.closest || !e.target.closest('#hit')) tip.hidden = true; });

/* ---------- admin ---------- */
async function renderAdmin() {
  let users;
  try { users = await api('/api/admin/users'); } catch (e) { if (e.message !== 'auth') toast(e.message); return; }
  if (tab !== 'admin') return;
  const P = C.allPerms;
  const permRows = [['create', 'Tạo yêu cầu'], ['handleOwn', 'Nhận & cập nhật yêu cầu của bộ phận mình'], ['viewDept', 'Xem yêu cầu liên quan bộ phận mình'], ['viewAll', 'Xem yêu cầu mọi bộ phận'], ['reportDept', 'Dashboard bộ phận mình'], ['reportAll', 'Dashboard toàn bộ ticket'], ['config', 'Phân quyền & cấu hình']];
  const deptOpts = sel => `<option value="">—</option>` + C.depts.map(d => `<option value="${d.id}" ${sel === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
  $('#main').innerHTML = `
  <div class="page-head"><div><h1>Phân quyền & cấu hình</h1><p>Chỉ Admin IT thấy trang này.</p></div></div>
  <div class="admin-grid">
    <section class="panel wide"><h2>Tài khoản</h2><div class="table-scroll"><table class="mini"><thead><tr><th>Họ tên</th><th>Tên đăng nhập</th><th>Vai trò</th><th>Bộ phận</th><th>Thông báo</th><th></th></tr></thead><tbody>
      ${users.map(x => `<tr style="${x.active ? '' : 'opacity:.55'}"><td>${esc(x.name)}${x.id === me().id ? ' <span class="t-sub">(bạn)</span>' : ''}</td><td class="mono">${esc(x.username)}</td>
      <td><select data-urole="${x.id}" aria-label="Vai trò của ${esc(x.name)}">${Object.keys(ROLE).map(r => `<option value="${r}" ${x.role === r ? 'selected' : ''}>${ROLE[r]}</option>`).join('')}</select></td>
      <td><select data-udept="${x.id}" aria-label="Bộ phận của ${esc(x.name)}">${deptOpts(x.dept_id)}</select></td>
      <td class="t-sub nowrap">${x.devices ? x.devices + ' thiết bị' : 'Chưa bật'}</td>
      <td class="nowrap"><button class="btn sm" data-upw="${x.id}">Đặt lại mật khẩu</button> ${x.id === me().id ? '' : `<button class="btn sm ${x.active ? 'danger' : ''}" data-uact="${x.id}" data-on="${x.active ? 0 : 1}">${x.active ? 'Khoá' : 'Mở khoá'}</button>`}</td></tr>`).join('')}
    </tbody></table></div>
    <form class="inline-add" id="addUser" autocomplete="off">
      <input type="text" id="nu-name" placeholder="Họ tên" required>
      <input type="text" id="nu-user" placeholder="Tên đăng nhập (vd: ha.nguyen)" required pattern="[a-zA-Z0-9._\\-]{3,64}" autocapitalize="none">
      <input type="text" id="nu-pass" placeholder="Mật khẩu ban đầu (≥ 6 ký tự)" required minlength="6">
      <select id="nu-role" aria-label="Vai trò">${Object.keys(ROLE).map(r => `<option value="${r}">${ROLE[r]}</option>`).join('')}</select>
      <select id="nu-dept" aria-label="Bộ phận">${C.depts.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select>
      <button class="btn primary">Tạo tài khoản</button></form></section>

    <section class="panel wide"><h2>Quyền theo vai trò</h2><div class="table-scroll"><table class="mini perm"><thead><tr><th>Quyền</th>${Object.keys(ROLE).map(r => `<th>${ROLE[r]}</th>`).join('')}</tr></thead><tbody>
      ${permRows.map(([k, l]) => `<tr><td>${l}</td>${Object.keys(ROLE).map(r => `<td><input type="checkbox" data-perm="${r}.${k}" aria-label="${ROLE[r]}: ${l}" ${P[r][k] ? 'checked' : ''} ${r === 'it' && k === 'config' ? 'disabled' : ''}></td>`).join('')}</tr>`).join('')}
    </tbody></table></div><p class="hint">Admin IT luôn giữ quyền cấu hình để không ai bị khoá ngoài.</p></section>

    <section class="panel"><h2>Bộ phận</h2><div>${C.depts.map(d => `<span class="tag">${esc(d.name)}</span>`).join('')}</div>
      <form class="inline-add" id="addDept"><input type="text" id="nd" placeholder="Tên bộ phận mới" required><button class="btn">Thêm</button></form></section>

    <section class="panel"><h2>Mức độ & SLA</h2><form id="slaForm"><div class="table-scroll"><table class="mini"><thead><tr><th>Mức độ</th><th>Nhận trong (phút)</th><th>Xong trong (giờ)</th></tr></thead><tbody>
      ${Object.keys(PRIO).map(p => `<tr><td>${prioBadge(p)}</td><td><input type="number" min="1" style="width:80px" name="${p}.resp" value="${C.sla[p].resp}" aria-label="${PRIO[p]} nhận trong"></td><td><input type="number" min="0.5" step="0.5" style="width:80px" name="${p}.resolve" value="${C.sla[p].resolve / 60}" aria-label="${PRIO[p]} xử lý trong"></td></tr>`).join('')}
    </tbody></table></div><button class="btn sm" style="margin-top:8px">Lưu SLA</button></form></section>

    <section class="panel wide"><h2>Loại yêu cầu theo bộ phận</h2>
      ${C.depts.map(d => `<div style="margin-bottom:8px"><div class="t-sub" style="margin-bottom:4px">${esc(d.name)}</div>${C.types.filter(t => t.dept_id === d.id).map(t => `<span class="tag">${esc(t.name)}${tickets.some(x => x.type_id === t.id) ? '' : `<button data-deltype="${t.id}" aria-label="Xoá ${esc(t.name)}">×</button>`}</span>`).join('') || '<span class="t-sub">Chưa có loại nào</span>'}</div>`).join('')}
      <form class="inline-add" id="addType"><select id="nt-dept" aria-label="Bộ phận">${C.depts.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select><input type="text" id="nt" placeholder="Tên loại yêu cầu mới" required><button class="btn">Thêm</button></form>
      <p class="hint">Loại đã có yêu cầu thì không xoá được, để giữ báo cáo đúng.</p></section>
  </div>`;
  const m = $('#main');
  const run = async (fn, msg) => { try { await fn(); await loadConfig(); toast(msg); renderAdmin(); } catch (e) { if (e.message !== 'auth') toast(e.message); renderAdmin(); } };
  m.querySelectorAll('[data-urole]').forEach(s => (s.onchange = () => run(() => api('/api/admin/users/' + s.dataset.urole, { method: 'PATCH', body: { role: s.value } }), 'Đã đổi vai trò')));
  m.querySelectorAll('[data-udept]').forEach(s => (s.onchange = () => run(() => api('/api/admin/users/' + s.dataset.udept, { method: 'PATCH', body: { dept_id: s.value || null } }), 'Đã đổi bộ phận')));
  m.querySelectorAll('[data-uact]').forEach(b => (b.onclick = () => run(() => api('/api/admin/users/' + b.dataset.uact, { method: 'PATCH', body: { active: b.dataset.on === '1' } }), b.dataset.on === '1' ? 'Đã mở khoá' : 'Đã khoá tài khoản')));
  m.querySelectorAll('[data-upw]').forEach(b => (b.onclick = () => {
    const x = users.find(z => z.id === +b.dataset.upw);
    modal(`<form><h2 style="margin:0">Đặt lại mật khẩu cho ${esc(x.name)}</h2><div class="field"><label for="rp">Mật khẩu mới (≥ 6 ký tự)</label><input type="text" id="rp" name="password" minlength="6" required></div><div class="err"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn" data-close>Huỷ</button><button class="btn primary">Lưu</button></div></form>`,
    async fd => { await api('/api/admin/users/' + x.id, { method: 'PATCH', body: { password: fd.get('password') } }); closeLayer(); toast('Đã đặt lại mật khẩu cho ' + x.name); });
  }));
  m.querySelectorAll('[data-perm]').forEach(c => (c.onchange = () => { const [r, k] = c.dataset.perm.split('.'); run(() => api('/api/admin/perms', { method: 'PUT', body: { [r]: { [k]: c.checked } } }), 'Đã cập nhật quyền ' + ROLE[r]); }));
  m.querySelectorAll('[data-deltype]').forEach(b => (b.onclick = () => run(() => api('/api/admin/types/' + b.dataset.deltype, { method: 'DELETE' }), 'Đã xoá loại yêu cầu')));
  $('#addUser').onsubmit = e => { e.preventDefault(); run(() => api('/api/admin/users', { body: { name: $('#nu-name').value, username: $('#nu-user').value, password: $('#nu-pass').value, role: $('#nu-role').value, dept_id: $('#nu-dept').value } }), 'Đã tạo tài khoản ' + $('#nu-user').value); };
  $('#addDept').onsubmit = e => { e.preventDefault(); run(() => api('/api/admin/depts', { body: { name: $('#nd').value } }), 'Đã thêm bộ phận'); };
  $('#addType').onsubmit = e => { e.preventDefault(); run(() => api('/api/admin/types', { body: { dept_id: $('#nt-dept').value, name: $('#nt').value } }), 'Đã thêm loại yêu cầu'); };
  $('#slaForm').onsubmit = e => { e.preventDefault(); const fd = new FormData(e.target); const body = {};
    Object.keys(PRIO).forEach(p => (body[p] = { resp: +fd.get(p + '.resp'), resolve: Math.round(+fd.get(p + '.resolve') * 60) }));
    run(() => api('/api/admin/sla', { method: 'PUT', body }), 'Đã lưu SLA'); };
}

boot();
})();
