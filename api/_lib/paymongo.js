import crypto from 'crypto';
import { sql } from '@vercel/postgres';
import { encryptText, decryptStrict, encryptionReady } from './crypto.js';
import { sendBookingConfirmedEmail, withTimeout } from './bookingemails.js';

// Each property uses its OWN PayMongo account: the guest's money goes straight
// to the property, never through Buildfirst. The property pastes its secret key
// in Payments; it is stored encrypted (see crypto.js).
//   - settings.js  ?resource=paymongo  -> getPaymongoSettings / savePaymongoSettings / removePaymongo
//   - bookings.js  POST (card booking) -> createCheckout
//   - bookings.js  POST ?resource=paymongo_webhook -> handlePaymongoWebhook
// Lives in _lib so it adds no serverless function (Vercel Hobby cap is 12).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^sk_(test|live)_[A-Za-z0-9]{16,200}$/;
const ALLOWED_METHODS = ['card', 'gcash', 'paymaya', 'grab_pay', 'qrph'];
const DEFAULT_METHODS = 'card,gcash,paymaya,qrph';
const CHECKOUT_URL = 'https://api.paymongo.com/v2/checkout_sessions';
const PAID_EVENT = 'checkout_session.payment.paid';

function fail(status, error) {
  return { status, json: { ok: false, error } };
}

function cleanMethods(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  const out = [];
  for (const m of list) {
    const k = String(m).trim().toLowerCase();
    if (ALLOWED_METHODS.includes(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

async function loadRow(tenantId) {
  try {
    const r = await sql`select * from tenant_paymongo where tenant_id = ${tenantId}`;
    return r.rows[0] || null;
  } catch (err) {
    console.error('tenant_paymongo not readable', err && err.message);
    return null;
  }
}

export async function hasPaymongo(tenantId) {
  return (await loadRow(tenantId)) !== null;
}

function webhookUrl(origin, tenantId, token) {
  return origin + '/api/bookings?resource=paymongo_webhook&tenant_id=' + tenantId + '&k=' + token;
}

// ------------------------------------------------------------
// Settings (owner only; settings.js checks that before calling)
// ------------------------------------------------------------
export async function getPaymongoSettings(tenantId, origin) {
  const row = await loadRow(tenantId);
  const base = { ok: true, encryption_ready: encryptionReady(), methods_allowed: ALLOWED_METHODS };
  if (!row) return { status: 200, json: { ...base, configured: false } };
  let url = null;
  try {
    url = webhookUrl(origin, tenantId, decryptStrict(row.webhook_token_enc));
  } catch (err) {
    console.error('webhook token not readable', err && err.message);
  }
  return {
    status: 200,
    json: {
      ...base,
      configured: true,
      mode: row.mode,
      key_hint: row.key_hint,
      methods: cleanMethods(row.methods),
      webhook_url: url,
    },
  };
}

export async function savePaymongoSettings(tenantId, body, origin) {
  const b = body || {};
  if (!encryptionReady()) {
    return fail(500, 'The server security key is not set up yet, so keys cannot be saved safely. Please contact Buildfirst.');
  }
  const existing = await loadRow(tenantId);
  const newKey = b.secret_key === undefined || b.secret_key === null ? '' : String(b.secret_key).trim();
  if (!existing && !newKey) return fail(400, 'Please paste your PayMongo secret key.');
  if (newKey && !KEY_RE.test(newKey)) {
    return fail(400, 'That does not look like a PayMongo secret key. It starts with sk_test_ or sk_live_.');
  }
  let methods = existing ? cleanMethods(existing.methods) : cleanMethods(DEFAULT_METHODS);
  if (b.methods !== undefined) {
    methods = cleanMethods(b.methods);
    if (methods.length === 0) return fail(400, 'Please choose at least one way for guests to pay.');
  }

  if (!existing) {
    const token = crypto.randomBytes(24).toString('hex');
    await sql`
      insert into tenant_paymongo (tenant_id, secret_key_enc, key_hint, mode, methods, webhook_token_enc)
      values (${tenantId}, ${encryptText(newKey)}, ${newKey.slice(-4)}, ${newKey.startsWith('sk_live_') ? 'live' : 'test'},
              ${methods.join(',')}, ${encryptText(token)})
    `;
  } else if (newKey) {
    await sql`
      update tenant_paymongo set secret_key_enc = ${encryptText(newKey)}, key_hint = ${newKey.slice(-4)},
        mode = ${newKey.startsWith('sk_live_') ? 'live' : 'test'}, methods = ${methods.join(',')}, updated_at = now()
      where tenant_id = ${tenantId}
    `;
  } else {
    await sql`
      update tenant_paymongo set methods = ${methods.join(',')}, updated_at = now()
      where tenant_id = ${tenantId}
    `;
  }
  return getPaymongoSettings(tenantId, origin);
}

export async function removePaymongo(tenantId) {
  await sql`delete from tenant_paymongo where tenant_id = ${tenantId}`;
  return { status: 200, json: { ok: true } };
}

// ------------------------------------------------------------
// Checkout: called right after a card booking is saved. Never throws.
// Returns { url } or { error }.
// ------------------------------------------------------------
export async function createCheckout({ tenantId, booking, returnUrl }) {
  try {
    const row = await loadRow(tenantId);
    if (!row) return { error: 'not_configured' };
    const secret = decryptStrict(row.secret_key_enc);
    const total = Number(booking.total_amount) || 0;
    const amount = Math.round(total * 100);
    if (!(amount >= 2000)) return { error: 'amount_too_small' };

    const t = await sql`select name from tenants where id = ${tenantId}`;
    const name = (t.rows[0] && t.rows[0].name) || 'Your stay';
    const sep = returnUrl.includes('?') ? '&' : '?';
    const ref = String(booking.id);
    const payload = {
      data: {
        attributes: {
          line_items: [
            {
              name: ('Stay at ' + name).slice(0, 100),
              description: String(booking.check_in).slice(0, 10) + ' to ' + String(booking.check_out).slice(0, 10),
              amount,
              currency: 'PHP',
              quantity: 1,
            },
          ],
          payment_method_types: cleanMethods(row.methods),
          success_url: returnUrl + sep + 'bf_payment=success&bf_ref=' + ref.slice(0, 8).toUpperCase(),
          cancel_url: returnUrl + sep + 'bf_payment=cancelled',
          reference_number: ref,
          metadata: { booking_id: ref, tenant_id: String(tenantId) },
        },
      },
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    let res;
    try {
      res = await fetch(CHECKOUT_URL, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(secret + ':').toString('base64'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || !json.data || !json.data.attributes || !json.data.attributes.checkout_url) {
      console.error('paymongo checkout failed', res.status, JSON.stringify(json && json.errors ? json.errors : json).slice(0, 500));
      return { error: 'paymongo_refused' };
    }
    try {
      await sql`
        update bookings set paymongo_session_id = ${String(json.data.id || '')}
        where id = ${booking.id} and tenant_id = ${tenantId}
      `;
    } catch (err) {
      console.error('paymongo_session_id not saved', err && err.message);
    }
    return { url: json.data.attributes.checkout_url };
  } catch (err) {
    console.error('createCheckout', err && err.message);
    return { error: 'checkout_failed' };
  }
}

// ------------------------------------------------------------
// Webhook: PayMongo tells us a checkout was paid.
// Safety: the link carries the property's own secret token, the booking id
// must belong to that property, the session must match, test/live must match
// the saved key, and the paid amount must cover the booking total.
// Answers 200 for anything to ignore (so PayMongo does not keep retrying) and
// 500 only for a real server problem (so PayMongo tries again).
// ------------------------------------------------------------
export function readEvent(body) {
  const d = body && body.data;
  if (!d || typeof d !== 'object') return null;
  if (typeof d.type === 'string' && d.data) return { type: d.type, livemode: d.livemode, session: d.data };
  const a = d.attributes;
  if (a && typeof a.type === 'string' && a.data) return { type: a.type, livemode: a.livemode, session: a.data };
  return null;
}

function sameToken(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export async function handlePaymongoWebhook(req) {
  const q = req.query || {};
  const tenantId = String(q.tenant_id || '');
  const token = String(q.k || '');
  if (!UUID_RE.test(tenantId) || !token) return fail(401, 'Not allowed');

  const row = await loadRow(tenantId);
  if (!row) return fail(401, 'Not allowed');
  let expected;
  try {
    expected = decryptStrict(row.webhook_token_enc);
  } catch (err) {
    console.error('webhook token not readable', err && err.message);
    return fail(500, 'Server error');
  }
  if (!sameToken(token, expected)) return fail(401, 'Not allowed');

  const ev = readEvent(req.body);
  if (!ev || ev.type !== PAID_EVENT) return { status: 200, json: { ok: true, ignored: 'other event' } };
  if (typeof ev.livemode === 'boolean' && ev.livemode !== (row.mode === 'live')) {
    return { status: 200, json: { ok: true, ignored: 'wrong mode' } };
  }

  const attrs = (ev.session && ev.session.attributes) || {};
  const bookingId = String(attrs.reference_number || (attrs.metadata && attrs.metadata.booking_id) || '');
  if (!UUID_RE.test(bookingId)) return { status: 200, json: { ok: true, ignored: 'no booking' } };

  const br = await sql`
    select id, total_amount, payment_status, paymongo_session_id,
           (select coalesce(sum(f.amount), 0) from folio_items f
             where f.booking_id = b.id and f.tenant_id = b.tenant_id
               and f.kind in ('payment', 'discount') and f.voided_at is null) as bill_lines
    from bookings b where b.id = ${bookingId} and b.tenant_id = ${tenantId}
  `;
  if (br.rows.length === 0) return { status: 200, json: { ok: true, ignored: 'booking not found' } };
  const b = br.rows[0];
  if (b.paymongo_session_id && ev.session.id && String(ev.session.id) !== String(b.paymongo_session_id)) {
    return { status: 200, json: { ok: true, ignored: 'other session' } };
  }
  if (b.payment_status === 'paid') return { status: 200, json: { ok: true, already: true } };

  const paid = (Array.isArray(attrs.payments) ? attrs.payments : []).filter(
    (p) => p && p.attributes && p.attributes.status === 'paid'
  );
  const paidCentavos = paid.reduce((a, p) => a + (Number(p.attributes.amount) || 0), 0);
  if (paid.length === 0 || paidCentavos < Math.round(Number(b.total_amount) * 100) - 1) {
    console.error('paymongo webhook: amount does not cover booking', bookingId, paidCentavos, b.total_amount);
    return { status: 200, json: { ok: true, ignored: 'amount' } };
  }
  if (Number(b.bill_lines) > 0) {
    // Payments or discounts were already typed into the bill; marking the whole
    // booking paid would count the same money twice. The owner must reconcile.
    console.error('paymongo webhook: bill already has payments, not marking paid', bookingId);
    return { status: 200, json: { ok: true, ignored: 'bill has payments' } };
  }

  const upd = await sql`
    update bookings set payment_status = 'paid', payment_confirmed_at = now(),
      paymongo_payment_id = ${String(paid[0].id || '')}
    where id = ${bookingId} and tenant_id = ${tenantId} and payment_status is distinct from 'paid'
    returning id
  `;
  if (upd.rows.length > 0) {
    await withTimeout(sendBookingConfirmedEmail(tenantId, bookingId));
  }
  return { status: 200, json: { ok: true, paid: upd.rows.length > 0 } };
}
