// Kitchen Agent — Daily Reminder Batch (Netlify Function)
// To deliver notifications even when the app is closed, schedule this function to run daily.
//
// Setup:
//   1. Configure push.js (VAPID env vars).
//   2. Schedule daily via Netlify Scheduled Functions (add `schedule = "0 17 * * *"` to netlify.toml [functions])
//      or trigger externally via cron-job.org pinging this endpoint at 5 PM local.
//   3. The function reads pending reminders from Airtable for each subscribed user and pushes the highest-priority
//      one. (Schema requires a Subscriptions table — see README.)
//
// This is intentionally a stub: the Airtable wiring depends on user setup. Until configured, returns a no-op.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' };

  const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID;

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'not_configured', missing: 'VAPID_*' }) };
  }
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE) {
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'not_configured', missing: 'AIRTABLE_*' }) };
  }

  let webpush;
  try { webpush = require('web-push'); }
  catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'web-push not installed' }) };
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:hello@example.com', VAPID_PUBLIC, VAPID_PRIVATE);

  // Fetch all push subscriptions from Airtable. Schema expectation:
  //   Table: Subscriptions
  //     - userId (text)
  //     - subscription (long text JSON)
  //     - reminders (long text JSON, list of pending reminders)
  //     - lastSentAt (datetime)
  let subs;
  try {
    const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/Subscriptions?pageSize=100`, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    });
    if (!res.ok) throw new Error('Airtable Subscriptions table missing or unreadable');
    const data = await res.json();
    subs = data.records || [];
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'no_subscriptions_table', message: e.message }) };
  }

  let sent = 0, errors = 0;
  for (const r of subs) {
    try {
      const sub = JSON.parse(r.fields.subscription || 'null');
      const reminders = JSON.parse(r.fields.reminders || '[]');
      if (!sub || !reminders.length) continue;
      // Pick highest-priority reminder
      const top = reminders.sort((a,b) => (b.priority||0) - (a.priority||0))[0];
      await webpush.sendNotification(sub, JSON.stringify({
        title: top.title || 'Kitchen Agent',
        body: top.body || '',
        tag: top.id || 'ka-batch',
        url: top.url || '/',
      }));
      sent++;
    } catch (e) {
      errors++;
    }
  }

  return { statusCode: 200, headers, body: JSON.stringify({ status: 'ok', sent, errors, total: subs.length }) };
};
