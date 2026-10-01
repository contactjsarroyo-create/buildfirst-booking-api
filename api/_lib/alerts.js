import { AsyncLocalStorage } from 'node:async_hooks';

// ------------------------------------------------------------
// Error alerts. When any route answers with a server error (500 or above),
// one email goes to ALERT_EMAIL saying which route failed and why.
//
// Setup (Vercel, Settings, Environment Variables, Production):
//   ALERT_EMAIL = the address that should get the alerts
//   RESEND_API_KEY and EMAIL_FROM already exist (used for all other emails)
//
// How it works: a route is wrapped with withAlerts('name', handler). While the
// request runs, the first console.error text is kept. If the route then answers
// 500 or above, that text is emailed. The same problem is emailed at most once
// every 10 minutes per server copy, so a broken page cannot flood the inbox.
// Never include request bodies, tokens or guest details in the email.
// ------------------------------------------------------------

const als = new AsyncLocalStorage();
const lastSent = new Map();
const QUIET_MS = 10 * 60 * 1000;
let patched = false;

function patchConsole() {
  if (patched) return;
  patched = true;
  const orig = console.error.bind(console);
  console.error = (...args) => {
    try {
      const st = als.getStore();
      if (st && !st.msg) {
        st.msg = args
          .map((a) => (a && a.message ? a.message : typeof a === 'string' ? a : ''))
          .filter(Boolean)
          .join(' ')
          .slice(0, 400);
      }
    } catch (e) {
      // never break logging
    }
    orig(...args);
  };
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function reportError(where, message, info) {
  try {
    const to = process.env.ALERT_EMAIL;
    const key = process.env.RESEND_API_KEY;
    if (!to || !key) return;
    const msg = String(message || 'Unknown error').slice(0, 400);
    const sig = where + '|' + msg.slice(0, 80);
    const now = Date.now();
    const prev = lastSent.get(sig);
    if (prev && now - prev < QUIET_MS) return;
    if (lastSent.size > 200) lastSent.clear();
    lastSent.set(sig, now);

    const when = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
    const html =
      '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">' +
      '<p><b>Something broke on Buildfirst Booking.</b></p>' +
      '<p>Where: ' + esc(where) + (info ? ' (' + esc(info) + ')' : '') + '<br>When: ' + esc(when) + ' (Manila)</p>' +
      '<p>What it said:<br><code>' + esc(msg) + '</code></p>' +
      '<p>To see more, open Vercel, then Logs, and look for this time.</p></div>';

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM || 'Buildfirst <no-reply@buildfirst.digital>',
          to: [to],
          subject: 'Buildfirst alert: ' + where,
          html,
        }),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    // an alert must never break a request
  }
}

export function withAlerts(name, handler) {
  return async function wrapped(req, res) {
    patchConsole();
    const st = { msg: '' };
    const method = (req && req.method) || '';
    const path = String((req && req.url) || '').split('?')[0];
    const resource = req && req.query && req.query.resource ? '?resource=' + String(req.query.resource).slice(0, 30) : '';
    const info = method + ' ' + path + resource;
    // Test switch: a request with the header x-alert-test equal to CRON_SECRET
    // fakes a crash, so the alert email can be tried without breaking anything.
    const testKey = req && req.headers && req.headers['x-alert-test'];
    try {
      if (testKey && process.env.CRON_SECRET && String(testKey) === process.env.CRON_SECRET) {
        throw new Error('This is a test alert. Nothing is broken.');
      }
      await als.run(st, () => handler(req, res));
    } catch (err) {
      await reportError(name, (err && err.message) || st.msg || 'Crashed', info);
      if (!res.headersSent) res.status(500).json({ ok: false, error: 'Server error' });
      return;
    }
    if (res.statusCode >= 500) {
      await reportError(name, st.msg || 'Answered with error ' + res.statusCode, info);
    }
  };
}
