/* ============================================================
   Recruit Pro — Web Push Notification Service
   Uses VAPID keys stored in env vars.
   ============================================================ */

const webpush = require('web-push');
const storage = require('./storage');

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:support@recruitpro.app', VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  console.warn('Push: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push notifications disabled');
}

async function sendNotification(userId, { title, body, tag = 'recruit-pro', url = '/dashboard' }) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  try {
    const user = await storage.getUserById(userId);
    if (!user || !user.pushSubscription) return;
    const payload = JSON.stringify({ title, body, tag, url });
    await webpush.sendNotification(user.pushSubscription, payload);
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      // Subscription expired — clear it
      try {
        const user = await storage.getUserById(userId);
        if (user) { user.pushSubscription = null; await storage.saveUser(user); }
      } catch (_) {}
    } else {
      console.error('Push send error:', err.message);
    }
  }
}

module.exports = { sendNotification, VAPID_PUBLIC };
