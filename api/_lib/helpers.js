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

// ------------------------------------------------------------
// Staff permissions. The owner sets, per staff member, one level for each
// area: 'none' (hidden and refused), 'view' (can look, cannot change) or
// 'edit' (full access to that area). Stored as jsonb in
// tenant_users.permissions. A staff row with nothing stored (older invites)
// gets 'edit' everywhere, which is what staff could already do.
//   bookings  Bookings, Calendar (blocking dates), Archive, guest details
//   rooms     Rooms & Rates
//   extras    Add-ons & Promos
//   storage   Storage (view files, delete files)
//   housekeeping  Housekeeping (rooms to clean, room problems, lost and found)
//   money     Money (daily closing report; later expenses). A statement of
//             account for one booking only needs Bookings view.
// Payments, Booking Form, Automated Emails, Share & Embed, Account Settings,
// the Staff tab and plans are ALWAYS owner only, whatever these say.
// ------------------------------------------------------------
export const PERMISSION_AREAS = ['bookings', 'rooms', 'extras', 'storage', 'housekeeping', 'money'];
const LEVEL_RANK = { none: 0, view: 1, edit: 2 };
// Areas added after staff were first invited. A staff member whose permissions
// were saved before the area existed gets 'none' for it, not 'edit'.
const NEWER_AREAS = ['housekeeping', 'money'];

export function normalizePermissions(input) {
  const out = {};
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const hasStored = PERMISSION_AREAS.some((a) => LEVEL_RANK[src[a]] !== undefined);
  for (const area of PERMISSION_AREAS) {
    if (LEVEL_RANK[src[area]] !== undefined) out[area] = src[area];
    else out[area] = hasStored && NEWER_AREAS.includes(area) ? 'none' : 'edit';
  }
  return out;
}

// True if this login may do `need` ('view' or 'edit') in `area`.
// Owners and any non-staff role always may.
export function can(auth, area, need) {
  if (!auth || auth.role !== 'staff') return true;
  const level = (auth.permissions && auth.permissions[area]) || 'none';
  return LEVEL_RANK[level] >= LEVEL_RANK[need];
}

// Usage:  if (staffCannot(auth, res, 'rooms', 'edit')) return;
export function staffCannot(auth, res, area, need) {
  if (can(auth, area, need)) return false;
  res.status(403).json({
    ok: false,
    error: 'Your login does not have permission to do this. Please ask the account owner.',
    code: 'no_permission',
  });
  return true;
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
    let r;
    try {
      r = await sql`
        select role, permissions from tenant_users
        where id::text = ${String(payload.user_id)} and tenant_id::text = ${String(payload.tenant_id)}
        limit 1
      `;
    } catch (colErr) {
      // The permissions column has not been added yet: keep everyone working.
      r = await sql`
        select role from tenant_users
        where id::text = ${String(payload.user_id)} and tenant_id::text = ${String(payload.tenant_id)}
        limit 1
      `;
    }
    if (r.rows.length === 0) return null;
    const role = r.rows[0].role;
    return {
      ...payload,
      role,
      permissions: role === 'staff' ? normalizePermissions(r.rows[0].permissions) : null,
    };
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
