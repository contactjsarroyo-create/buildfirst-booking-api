import { sql } from '@vercel/postgres';
import { resolveAccount, getUsage, PLAN_LIMITS } from './limits.js';

// ------------------------------------------------------------
// Owner-of-Buildfirst admin tools. Reached via /api/settings?resource=admin
// (no new route file: the 12-function cap is full).
// Only logins whose email is in the Vercel setting ADMIN_EMAILS (comma
// separated) may use it. Checked on the server on every call.
// Never returns guest names, guest emails, ID numbers or money: only counts.
// ------------------------------------------------------------
const PLAN_PRICE = { starter: 999, growth: 2499, pro: 4999 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireAdmin(res, auth) {
  const list = String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const deny = () => {
    res.status(403).json({ ok: false, error: 'Not allowed.', code: 'not_admin' });
    return null;
  };
  if (!list.length || !auth || auth.role === 'staff') return deny();
  const r = await sql`
    select email from tenant_users
    where id::text = ${String(auth.user_id)} and tenant_id::text = ${String(auth.tenant_id)}
    limit 1
  `;
  const email = r.rows[0] && String(r.rows[0].email || '').toLowerCase();
  if (!email || !list.includes(email)) return deny();
  return email;
}

function shape(row) {
  const account = resolveAccount(row);
  return {
    id: row.id,
    name: row.name,
    slug: row.public_slug || row.slug || null,
    plan: account.plan,
    status: row.status,
    state: account.state,
    trial_ends_at: account.trial_ends_at,
    trial_days_left: account.trial_days_left,
    storage_bytes: account.storage_bytes,
    created_at: row.created_at || null,
    owner_email: row.owner_email || null,
    verified: !!row.verified,
    rooms: row.rooms || 0,
    staff: row.staff || 0,
    bookings_month: row.bookings_month || 0,
    bookings_total: row.bookings_total || 0,
    last_booking_at: row.last_booking_at ? new Date(row.last_booking_at).toISOString() : null,
  };
}

async function listTenants() {
  const r = await sql`
    select t.id, t.name, t.slug, t.public_slug, t.plan, t.status, t.trial_ends_at,
      t.storage_bytes::float8 as storage_bytes,
      to_jsonb(t)->>'created_at' as created_at,
      (select u.email from tenant_users u where u.tenant_id = t.id and u.role is distinct from 'staff'
         order by u.created_at asc limit 1) as owner_email,
      (select (u.email_verified_at is not null) from tenant_users u where u.tenant_id = t.id and u.role is distinct from 'staff'
         order by u.created_at asc limit 1) as verified,
      (select count(*)::int from rooms r join unit_types ut on ut.id = r.unit_type_id
         where r.tenant_id = t.id and r.is_active is not false and ut.is_active is not false) as rooms,
      (select count(*)::int from tenant_users u where u.tenant_id = t.id and u.role = 'staff') as staff,
      (select count(*)::int from bookings b where b.tenant_id = t.id
         and b.created_at >= (date_trunc('month', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila')) as bookings_month,
      (select count(*)::int from bookings b where b.tenant_id = t.id) as bookings_total,
      (select max(b.created_at) from bookings b where b.tenant_id = t.id) as last_booking_at
    from tenants t
    order by (to_jsonb(t)->>'created_at') desc nulls last
    limit 500
  `;
  return r.rows.map(shape);
}

function summarize(items) {
  const s = { total: items.length, paying: 0, trial: 0, trial_expired: 0, suspended: 0, monthly_estimate: 0 };
  for (const t of items) {
    if (t.state === 'active') {
      s.paying += 1;
      s.monthly_estimate += PLAN_PRICE[t.plan] || 0;
    } else if (t.state === 'trial') s.trial += 1;
    else if (t.state === 'trial_expired') s.trial_expired += 1;
    else s.suspended += 1;
  }
  return s;
}

async function detail(id) {
  const r = await sql`
    select t.id, t.name, t.slug, t.public_slug, t.plan, t.status, t.trial_ends_at,
      t.storage_bytes::float8 as storage_bytes, to_jsonb(t)->>'created_at' as created_at, t.currency
    from tenants t where t.id = ${id}::uuid
  `;
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  const users = await sql`
    select id, email, role, created_at, (email_verified_at is not null) as verified
    from tenant_users where tenant_id = ${id}::uuid order by created_at asc
  `;
  const usage = await getUsage(id);
  const account = resolveAccount(row);
  let emails30 = 0;
  try {
    const e = await sql`
      select count(*)::int as n from email_log
      where tenant_id = ${id}::uuid and status = 'sent' and created_at >= now() - interval '30 days'
    `;
    emails30 = e.rows[0].n;
  } catch (err) {
    emails30 = 0;
  }
  return {
    tenant: { ...shape({ ...row, owner_email: null }), currency: row.currency || null },
    users: users.rows.map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role || 'owner',
      verified: !!u.verified,
      created_at: u.created_at ? new Date(u.created_at).toISOString() : null,
    })),
    usage,
    limits: account.limits,
    emails_30_days: emails30,
  };
}

// Existing clients that run their own systems (Merbau, later Elmarie).
// Vercel setting CLIENT_FEEDS (JSON list):
// [{"key":"merbau","name":"Merbau Events & Villas","url":"https://.../api/client-stats",
//   "token":"...","launch":"2026-03-15","baseline_monthly_bookings":6}]
// launch and baseline_monthly_bookings are optional. The url and token are never sent to the browser.
async function clientFeeds() {
  let list = [];
  try {
    list = JSON.parse(process.env.CLIENT_FEEDS || '[]');
    if (!Array.isArray(list)) list = [];
  } catch (e) {
    return { error: 'CLIENT_FEEDS is not valid JSON.', clients: [] };
  }
  const clients = await Promise.all(
    list.map(async (c) => {
      const base = {
        key: String(c.key || c.name || ''),
        name: String(c.name || c.key || 'Client'),
        launch: c.launch ? String(c.launch) : null,
        baseline_monthly_bookings: Number(c.baseline_monthly_bookings) > 0 ? Number(c.baseline_monthly_bookings) : null,
      };
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const r = await fetch(String(c.url), { headers: { 'x-stats-token': String(c.token || '') }, signal: ctrl.signal });
        clearTimeout(timer);
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) return { ...base, ok: false, error: 'Their system answered ' + r.status + '.' };
        return { ...base, ok: true, totals: j.totals, months: j.months, top_rooms: j.top_rooms, undated_rows: j.undated_rows, note: j.note };
      } catch (e) {
        return { ...base, ok: false, error: 'Could not reach their system.' };
      }
    })
  );
  return { clients };
}

export async function adminCall(req, res, auth) {
  const who = await requireAdmin(res, auth);
  if (!who) return;

  if (req.method === 'GET' && req.query && req.query.view === 'clients') {
    const out = await clientFeeds();
    return res.status(200).json({ ok: true, ...out });
  }

  if (req.method === 'GET') {
    const id = req.query && req.query.tenant_id;
    if (id) {
      if (!UUID.test(String(id))) return res.status(400).json({ ok: false, error: 'Bad id.' });
      const d = await detail(String(id));
      if (!d) return res.status(404).json({ ok: false, error: 'Property not found.' });
      return res.status(200).json({ ok: true, ...d });
    }
    const items = await listTenants();
    return res.status(200).json({ ok: true, admin: who, summary: summarize(items), tenants: items, plans: PLAN_PRICE });
  }

  if (req.method === 'POST') {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const id = String(body.tenant_id || '');
    if (!UUID.test(id)) return res.status(400).json({ ok: false, error: 'Bad id.' });
    const exists = await sql`select 1 from tenants where id = ${id}::uuid`;
    if (exists.rows.length === 0) return res.status(404).json({ ok: false, error: 'Property not found.' });
    const action = String(body.action || '');

    if (action === 'extend_trial') {
      const days = Math.floor(Number(body.days));
      if (!Number.isFinite(days) || days < 1 || days > 365) {
        return res.status(400).json({ ok: false, error: 'Days must be 1 to 365.' });
      }
      await sql`
        update tenants
        set trial_ends_at = greatest(coalesce(trial_ends_at, now()), now()) + (${days}::int * interval '1 day'),
            updated_at = now()
        where id = ${id}::uuid
      `;
    } else if (action === 'set_plan') {
      const plan = String(body.plan || '');
      if (!PLAN_LIMITS[plan]) return res.status(400).json({ ok: false, error: 'Unknown plan.' });
      await sql`update tenants set plan = ${plan}, updated_at = now() where id = ${id}::uuid`;
    } else if (action === 'set_status') {
      const status = String(body.status || '');
      if (!['active', 'onboarding', 'paused'].includes(status)) {
        return res.status(400).json({ ok: false, error: 'Unknown status.' });
      }
      await sql`update tenants set status = ${status}, updated_at = now() where id = ${id}::uuid`;
    } else if (action === 'verify_email') {
      await sql`
        update tenant_users set email_verified_at = now()
        where tenant_id = ${id}::uuid and role is distinct from 'staff' and email_verified_at is null
      `;
    } else {
      return res.status(400).json({ ok: false, error: 'Unknown action.' });
    }
    console.log('ADMIN ACTION', who, action, id);
    const d = await detail(id);
    return res.status(200).json({ ok: true, ...d });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
