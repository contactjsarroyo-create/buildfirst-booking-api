import { sql } from '@vercel/postgres';

// Online deposits: an OPTIONAL per-resort setting (off by default).
// When on, a guest who books and pays by a manual channel (GCash, bank
// transfer and so on) is asked to send a deposit now and the rest at
// check-in. The owner taps "Deposit received" on the booking when the money
// arrives. Lives in _lib so it adds no serverless function (Vercel Hobby cap).
//
// SYNC RULE: the widget (BookingWidgetCore, function depositFor) shows the
// same number to the guest. Change both together. The server's number is the
// one that counts: it is saved on the booking (bookings.deposit_due).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
function fail(status, error) {
  return { status, json: { ok: false, error } };
}

const OFF = { enabled: false, kind: 'percent', percent: 0, fixed: 0, policy: '' };

// Never throws. A missing column or table means "no online deposit".
export async function loadOnlineDeposit(tenantId) {
  try {
    const r = await sql`
      select online_deposit_enabled, online_deposit_kind, online_deposit_percent,
             online_deposit_fixed, online_deposit_policy
      from tenant_settings where tenant_id = ${tenantId}
    `;
    const s = r.rows[0];
    if (!s) return { ...OFF };
    return {
      enabled: s.online_deposit_enabled === true,
      kind: s.online_deposit_kind === 'fixed' ? 'fixed' : 'percent',
      percent: Number(s.online_deposit_percent) || 0,
      fixed: Number(s.online_deposit_fixed) || 0,
      policy: String(s.online_deposit_policy || '').trim(),
    };
  } catch (err) {
    console.error('onlineDeposit: could not load settings', err && err.message);
    return { ...OFF };
  }
}

// How much deposit to ask for a booking total (VAT included). 0 = none.
// Card payment through PayMongo pays in full, so it is never asked a deposit.
export function depositAmount(dep, total, channel) {
  if (!dep || dep.enabled !== true) return 0;
  if (!channel || channel === 'paymongo') return 0;
  const t = round2(total);
  if (!(t > 0)) return 0;
  const raw = dep.kind === 'fixed' ? Number(dep.fixed) : (t * Number(dep.percent)) / 100;
  const amt = round2(raw);
  if (!(amt > 0)) return 0;
  return Math.min(amt, t);
}

// Public read for the booking widget (no login). Only the deposit wording and
// numbers the guest is going to see anyway.
export async function getPublicDeposit(tenantId) {
  if (!UUID_RE.test(String(tenantId || ''))) return fail(400, 'A valid tenant_id is required');
  const d = await loadOnlineDeposit(tenantId);
  return {
    status: 200,
    json: {
      ok: true,
      deposit: {
        enabled: d.enabled,
        kind: d.kind,
        percent: d.percent,
        fixed: d.fixed,
        policy: d.policy,
      },
    },
  };
}

// Folio "method" names used on the bill.
function folioMethod(channelKey, channel) {
  const s = `${channelKey || ''} ${(channel && channel.name) || ''}`.toLowerCase();
  if (s.includes('gcash')) return 'GCash';
  if (s.includes('maya')) return 'Maya';
  if (s.includes('bank')) return 'Bank transfer';
  if (s.includes('cash')) return 'Cash';
  if (s.includes('card') || s.includes('paymongo')) return 'Card';
  return 'Other';
}

export const ONLINE_DEPOSIT_ACTIONS = ['deposit_received'];

// PATCH action: the guest's deposit has arrived. Adds one bill payment line
// "Deposit" for the amount that was asked (never more than is owed). It never
// runs next to "Mark as paid": that is refused once the bill has a payment.
// The caller (booking-update.js) then sends the guest confirmation email.
export async function onlineDepositAction(auth, body) {
  const id = String((body && body.id) || '');
  if (!UUID_RE.test(id)) return fail(400, 'id is required');

  const found = await sql`
    select id, status, payment_status, payment_channel, deposit_due, total_amount
    from bookings where id = ${id} and tenant_id = ${auth.tenant_id}
  `;
  const b = found.rows[0];
  if (!b) return fail(404, 'Booking not found');
  const due = round2(b.deposit_due);
  if (b.status === 'cancelled') return fail(409, 'This booking is cancelled.');
  if (!(due > 0)) return fail(400, 'No deposit was asked for this booking.');
  if (b.payment_status === 'paid') return fail(409, 'This booking is already marked as paid.');

  // Same balance formula as the bill (see the MONEY note in the handoff).
  const sums = await sql`
    select coalesce(sum(amount) filter (where kind = 'charge'), 0) as charges,
           coalesce(sum(amount) filter (where kind = 'payment'), 0) as payments,
           coalesce(sum(amount) filter (where kind = 'refund'), 0) as refunds,
           coalesce(sum(amount) filter (where kind = 'discount'), 0) as discounts
    from folio_items
    where booking_id = ${id} and tenant_id = ${auth.tenant_id} and voided_at is null
  `;
  const s = sums.rows[0] || {};
  const balance = round2(
    Number(b.total_amount) + Number(s.charges) - Number(s.payments) + Number(s.refunds) - Number(s.discounts)
  );
  if (!(balance > 0.005)) return fail(409, 'Nothing is owed on this booking. It is already paid.');
  const amount = round2(Math.min(due, balance));

  let channel = null;
  try {
    const st = await sql`select payment_channels from tenant_settings where tenant_id = ${auth.tenant_id}`;
    const all = st.rows[0] && st.rows[0].payment_channels;
    channel = all && b.payment_channel ? all[b.payment_channel] : null;
  } catch (err) {
    channel = null;
  }
  const method = folioMethod(b.payment_channel, channel);

  // One statement: the line is added only if no Deposit line is on the bill,
  // so a double tap can never record the deposit twice.
  const ins = await sql`
    insert into folio_items (tenant_id, booking_id, kind, description, amount, method)
    select ${auth.tenant_id}::uuid, ${id}::uuid, 'payment', 'Deposit', ${amount}::numeric, ${method}::text
    where not exists (
      select 1 from folio_items f
      where f.booking_id = ${id}::uuid and f.tenant_id = ${auth.tenant_id}::uuid
        and f.kind = 'payment' and f.voided_at is null and f.description like 'Deposit%'
    )
    returning id
  `;
  if (ins.rows.length === 0) return fail(409, 'The deposit is already on the bill.');
  return { status: 200, json: { ok: true, amount } };
}
