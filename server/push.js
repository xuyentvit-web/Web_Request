'use strict';
const webpush = require('web-push');
const { db, getSetting, setSetting } = require('./db');

let keys = getSetting('vapid');
if (!keys) {
  keys = webpush.generateVAPIDKeys();
  setSetting('vapid', keys);
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', keys.publicKey, keys.privateKey);

const publicKey = () => keys.publicKey;

function saveSubscription(userId, sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    throw new Error('bad_subscription');
  }
  db.prepare(`INSERT INTO push_subs(user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, Date.now());
}
function removeSubscription(userId, endpoint) {
  db.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
}
const countSubs = userId => db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?').get(userId).n;

// payload: { title, body, url, tag, urgent }
async function sendToUsers(userIds, payload) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return 0;
  const subs = db.prepare(`SELECT * FROM push_subs WHERE user_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  let sent = 0;
  await Promise.all(subs.map(async s => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 3600, urgency: payload.urgent ? 'high' : 'normal' });
      sent++;
    } catch (err) {
      // 404/410: the browser dropped this subscription, forget it.
      if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE id = ?').run(s.id);
      else console.warn('[push] send failed', err.statusCode || '', err.body || err.message);
    }
  }));
  return sent;
}

module.exports = { publicKey, saveSubscription, removeSubscription, sendToUsers, countSubs };
