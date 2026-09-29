import { sql } from '@vercel/postgres';

// ------------------------------------------------------------
// Plan limits. Keep in sync with PLANS in DashboardSignup.tsx.
//   unit_types          room types a tenant can create
//   rooms               individual rooms (and total unit_count) across all types
//   bookings_per_month  bookings created per calendar month (Asia/Manila)
//   storage_bytes       total uploaded image storage (never resets)
//   custom_fields       custom guest questions
//   emails              booking emails sent per calendar month (Asia/Manila),
//                       counted from the email_log table. Auth emails
//                       (verify / reset) are not counted.
// Not enforced yet (nothing to enforce): staff logins.
// ------------------------------------------------------------
const MB = 1024 * 1024;
const GB = 1024 * MB;

export const PLAN_LIMITS = {
  starter: { unit_types: 3, rooms: 10, bookings_per_month: 75, storage_bytes: 50 * MB, custom_fields: 5, emails: 300 },
  growth: { unit_types: 10, rooms: 40, bookings_per_month: 300, storage_bytes: 250 * MB, custom_fields: 15, emails: 1000 },
  pro: { unit_types: 25, rooms: 100, bookings_per_month: 1000, storage_bytes: 1 * GB, custom_fields: 40, emails: 3000 },
};

// Trials always run on the cheapest plan's limits, whatever plan was picked at signup.
const TRIAL_PLAN = 'starter';
const DAY_MS = 24 * 60 * 60 * 1000;

// Turns a tenants row ({ plan, status, trial_ends_at, storage_bytes }) into
// the account state every endpoint uses.
//   state 'trial'         status onboarding, trial not over
//   state 'trial_expired' status onboarding, trial over: no new bookings/uploads
//   state 'active'        paying tenant, limits come from their plan
//   state 'inactive'      paused / cancelled / anything else
export function resolveAccount(row) {
  const plan = PLAN_LIMITS[row.plan] ? row.plan : 'starter';
  const trialEnds = row.trial_ends_at ? new Date(row.trial_ends_at) : null;
  const msLeft = trialEnds ? trialEnds.getTime() - Date.now() : null;

  let state;
  if (row.status === 'active') state = 'active';
  else if (row.status === 'onboarding') state = msLeft !== null && msLeft <= 0 ? 'trial_expired' : 'trial';
  else state = 'inactive';

  const effective_plan = state === 'active' ? plan : TRIAL_PLAN;
  const can_book = state === 'trial' || state === 'active';

  let blocked_code = null;
  let blocked_message = null;
  if (state === 'trial_expired') {
    blocked_code = 'trial_expired';
    blocked_message = 'Your free trial has ended. Choose a plan to keep taking bookings.';
  } else if (state === 'inactive') {
    blocked_code = 'account_inactive';
    blocked_message = 'This account is not active. Contact Buildfirst support.';
  }

  const planName = plan.charAt(0).toUpperCase() + plan.slice(1);

  return {
    tenant_id: row.id,
    plan,
    state,
    effective_plan,
    label: state === 'active' ? `${planName} plan` : 'free trial',
    limits: PLAN_LIMITS[effective_plan],
    can_book,
    blocked_code,
    blocked_message,
    trial_ends_at: trialEnds ? trialEnds.toISOString() : null,
    trial_days_left: state === 'trial' && msLeft !== null ? Math.max(0, Math.ceil(msLeft / DAY_MS)) : null,
    storage_bytes: Number(row.storage_bytes) || 0,
  };
}

// The safe-to-send-to-the-browser version of an account.
export function publicAccount(account) {
  return {
    state: account.state,
    plan: account.plan,
    effective_plan: account.effective_plan,
    trial_ends_at: account.trial_ends_at,
    trial_days_left: account.trial_days_left,
  };
}

export async function getAccount(tenantId) {
  const r = await sql`
    select id, plan, status, trial_ends_at, storage_bytes::float8 as storage_bytes
    from tenants
    where id = ${tenantId}
  `;
  if (r.rows.length === 0) return null;
  return resolveAccount(r.rows[0]);
}

// Current usage for the dashboard meters and for limit checks.
export async function getUsage(tenantId) {
  const r = await sql`
    select
      (select count(*)::int from unit_types where tenant_id = ${tenantId}) as unit_types,
      (select count(*)::int from rooms where tenant_id = ${tenantId}) as rooms,
      (select coalesce(sum(unit_count), 0)::int from unit_types where tenant_id = ${tenantId}) as unit_count_total,
      (select count(*)::int from bookings
         where tenant_id = ${tenantId}
           and created_at >= (date_trunc('month', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila')
      ) as bookings_this_month,
      (select storage_bytes::float8 from tenants where id = ${tenantId}) as storage_bytes,
      (select case when jsonb_typeof(custom_fields) = 'array' then jsonb_array_length(custom_fields) else 0 end
         from tenant_settings where tenant_id = ${tenantId}) as custom_fields
  `;
  const u = r.rows[0] || {};
  const emailsThisMonth = await countEmailsThisMonth(tenantId);
  return {
    unit_types: u.unit_types || 0,
    rooms: u.rooms || 0,
    unit_count_total: u.unit_count_total || 0,
    bookings_this_month: u.bookings_this_month || 0,
    storage_bytes: Number(u.storage_bytes) || 0,
    custom_fields: u.custom_fields || 0,
    emails_this_month: emailsThisMonth,
  };
}

// Booking emails actually sent this calendar month (Asia/Manila). Skipped and
// failed sends are logged too but do not count. Returns 0 if the log can't be
// read, so a problem here never blocks a booking.
export async function countEmailsThisMonth(tenantId) {
  try {
    const r = await sql`
      select count(*)::int as n from email_log
      where tenant_id = ${tenantId}
        and status = 'sent'
        and created_at >= (date_trunc('month', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila')
    `;
    return r.rows[0].n;
  } catch (err) {
    console.error('countEmailsThisMonth failed', err && err.message);
    return 0;
  }
}

export async function countBookingsThisMonth(tenantId) {
  const r = await sql`
    select count(*)::int as n from bookings
    where tenant_id = ${tenantId}
      and created_at >= (date_trunc('month', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila')
  `;
  return r.rows[0].n;
}

// Reserves upload space before the file is stored. Atomic: the row is only
// updated if the tenant stays under their limit, so two simultaneous uploads
// can't both squeeze past it. Returns true if the space was reserved.
export async function reserveStorage(tenantId, bytes, limitBytes) {
  const r = await sql`
    update tenants
    set storage_bytes = storage_bytes + ${bytes}::bigint
    where id = ${tenantId} and storage_bytes + ${bytes}::bigint <= ${limitBytes}::bigint
    returning id
  `;
  return r.rows.length > 0;
}

// Gives reserved space back (used when the upload itself fails).
export async function releaseStorage(tenantId, bytes) {
  await sql`
    update tenants
    set storage_bytes = greatest(storage_bytes - ${bytes}::bigint, 0)
    where id = ${tenantId}
  `;
}

export function formatBytes(bytes) {
  if (bytes >= GB) return `${Math.round((bytes / GB) * 10) / 10} GB`;
  return `${Math.round(bytes / MB)} MB`;
}

// Standard "you hit your plan limit" response. The dashboard can key off
// code === 'plan_limit' to show an upgrade prompt.
export function planLimit(res, account, message, limitKey) {
  const hint = account.effective_plan === 'pro' && account.state === 'active'
    ? ' Contact us to raise your limit.'
    : ' Upgrade your plan to add more.';
  return res.status(403).json({ ok: false, error: message + hint, code: 'plan_limit', limit: limitKey });
}

export function blocked(res, account) {
  return res.status(403).json({ ok: false, error: account.blocked_message, code: account.blocked_code });
}
