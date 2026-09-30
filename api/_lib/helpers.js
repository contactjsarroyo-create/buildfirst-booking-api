import jwt from 'jsonwebtoken';
import { sql } from '@vercel/postgres';

export function setCors(req, res, methods) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  return false;
}

// Checks the login token AND that the person still exists. A removed staff
// member stops working right away instead of when their 7-day token runs out,
// and the role always comes from the database, not from the token.
// Async: always call it as  const auth = await getAuth(req);
export async function getAuth(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return null;
  }
  if (!payload || !payload.user_id || !payload.tenant_id) return null;
  try {
    const r = await sql`
      select role from tenant_users
      where id::text = ${String(payload.user_id)} and tenant_id::text = ${String(payload.tenant_id)}
      limit 1
    `;
    if (r.rows.length === 0) return null;
    return { ...payload, role: r.rows[0].role };
  } catch (err) {
    console.error('getAuth lookup failed', err && err.message);
    return null;
  }
}

// Staff can run the day-to-day (bookings, rooms, add-ons, promos, photos) but
// not the account itself. Only the role 'staff' is restricted, so every
// existing login keeps working exactly as before.
// Usage:  if (staffBlocked(auth, res)) return;
export function staffBlocked(auth, res) {
  if (!auth || auth.role !== 'staff') return false;
  res.status(403).json({ ok: false, error: 'Only the account owner can do this.', code: 'owner_only' });
  return true;
}

export function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

export function text(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// A tenant can take bookings while active, or during onboarding (the trial
// period before they've paid). 'paused' and 'cancelled' are not bookable.
export function isBookableStatus(status) {
  return status === 'active' || status === 'onboarding';
}
