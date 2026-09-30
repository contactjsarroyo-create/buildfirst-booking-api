import { sql } from '@vercel/postgres';

// Money: the daily closing report and the statement of account.
// Lives in _lib so it adds no serverless function (Vercel Hobby cap is 12).
// bookings.js serves the reads: ?resource=closing (needs the "money" area)
// and ?resource=statement (needs Bookings view). Nothing here changes data.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 92;
const MAX_LINES = 500;
const MAX_UNPAID = 200;

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function fail(status, error) {
  return { status, json: { ok: false, error } };
}

function dayNumber(ds) {
  return Math.round(Date.parse(ds + 'T00:00:00Z') / 86400000);
}

async function tenantInfo(tenantId) {
  const r = await sql`select name, timezone from tenants where id = ${tenantId}`;
  const row = r.rows[0] || {};
  return { name: row.name || '', timezone: row.timezone || 'Asia/Manila' };
}

// Groups the many ways a payment can be labelled into six columns.
export const METHODS = [
  { key: 'cash', label: 'Cash' },
  { key: 'gcash', label: 'GCash' },
  { key: 'maya', label: 'Maya' },
  { key: 'bank', label: 'Bank transfer' },
  { key: 'card', label: 'Card or online' },
  { key: 'other', label: 'Other' },
];

export function methodKey(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return 'other';
  if (s.includes('gcash')) return 'gcash';
  if (s.includes('maya')) return 'maya';
  if (s.includes('bank')) return 'bank';
  if (s.includes('cash')) return 'cash';
  if (s.includes('card') || s.includes('paymongo')) return 'card';
  return 'other';
}

function methodLabel(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'Not recorded';
  if (s === 'paymongo') return 'Card or online';
  if (s === 'gcash') return 'GCash';
  if (s === 'maya') return 'Maya';
  if (s === 'bank_transfer') return 'Bank transfer';
  if (s === 'qr_code') return 'QR code';
  if (s.startsWith('custom_')) return s.slice(7).replace(/_/g, ' ');
  return s;
}

// ------------------------------------------------------------
// DAILY CLOSING REPORT for one day or a short range of days.
// Money received = bookings marked as paid (on the day they were marked)
// plus payments and refunds typed into a bill at the Front Desk.
// "Still unpaid" is the balance right now for stays that touch the range.
// ------------------------------------------------------------
export async function getClosing(tenantId, from, to) {
  if (!DATE_RE.test(String(from || '')) || !DATE_RE.test(String(to || ''))) {
    return fail(400, 'Please choose a day.');
  }
  const span = dayNumber(to) - dayNumber(from) + 1;
  if (!(span >= 1)) return fail(400, 'The last day must not be before the first day.');
  if (span > MAX_DAYS) return fail(400, 'Please choose 92 days or fewer.');

  const t = await tenantInfo(tenantId);
  const tz = t.timezone;

  const bookingPay = await sql`
    select b.id as booking_id, b.guest_name, b.status, b.payment_channel,
           b.total_amount as amount, b.payment_confirmed_at as at,
           (b.payment_confirmed_at at time zone ${tz})::date::text as day,
           r.label as room
    from bookings b
    left join rooms r on r.id = b.room_id
    where b.tenant_id = ${tenantId}
      and b.payment_status = 'paid'
      and b.payment_confirmed_at is not null
      and (b.payment_confirmed_at at time zone ${tz})::date between ${from}::date and ${to}::date
  `;
  const folio = await sql`
    select f.id, f.kind, f.description, f.amount, f.method, f.created_at as at,
           (f.created_at at time zone ${tz})::date::text as day,
           b.id as booking_id, b.guest_name, r.label as room
    from folio_items f
    join bookings b on b.id = f.booking_id and b.tenant_id = f.tenant_id
    left join rooms r on r.id = b.room_id
    where f.tenant_id = ${tenantId}
      and f.voided_at is null
      and (f.created_at at time zone ${tz})::date between ${from}::date and ${to}::date
  `;

  const lines = [];
  for (const p of bookingPay.rows) {
    lines.push({
      at: p.at, day: p.day, booking_id: p.booking_id, guest_name: p.guest_name, room: p.room || null,
      kind: 'payment',
      what: p.status === 'cancelled' ? 'Booking payment (booking is cancelled)' : 'Booking payment',
      method_key: methodKey(p.payment_channel),
      method_label: methodLabel(p.payment_channel),
      amount: round2(p.amount),
    });
  }
  let chargesPosted = 0;
  let discountsGiven = 0;
  for (const f of folio.rows) {
    if (f.kind === 'charge') {
      chargesPosted += Number(f.amount) || 0;
      continue;
    }
    if (f.kind === 'discount') {
      discountsGiven += Number(f.amount) || 0;
      continue;
    }
    if (f.kind !== 'payment' && f.kind !== 'refund') continue;
    lines.push({
      at: f.at, day: f.day, booking_id: f.booking_id, guest_name: f.guest_name, room: f.room || null,
      kind: f.kind,
      what: f.description || (f.kind === 'refund' ? 'Refund given' : 'Payment received'),
      method_key: methodKey(f.method),
      method_label: methodLabel(f.method),
      amount: round2(f.amount),
    });
  }
  // Newest first.
  lines.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  const byMethod = {};
  for (const m of METHODS) byMethod[m.key] = { key: m.key, label: m.label, received: 0, refunded: 0, net: 0, count: 0 };
  const byDay = {};
  let received = 0;
  let refunded = 0;
  for (const l of lines) {
    const m = byMethod[l.method_key];
    const d = byDay[l.day] || (byDay[l.day] = { date: l.day, received: 0, refunded: 0, net: 0 });
    if (l.kind === 'refund') {
      m.refunded += l.amount;
      refunded += l.amount;
      d.refunded += l.amount;
    } else {
      m.received += l.amount;
      received += l.amount;
      d.received += l.amount;
    }
    m.count += 1;
  }
  const methods = METHODS.map((x) => {
    const m = byMethod[x.key];
    return { ...m, received: round2(m.received), refunded: round2(m.refunded), net: round2(m.received - m.refunded) };
  });
  const days = Object.values(byDay)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((d) => ({ ...d, received: round2(d.received), refunded: round2(d.refunded), net: round2(d.received - d.refunded) }));

  // Still unpaid: confirmed bookings that touch these days and still owe money.
  const owing = await sql`
    select b.id as booking_id, b.guest_name, b.check_in::text as check_in, b.check_out::text as check_out,
           b.total_amount, b.payment_status, b.checked_in_at, b.checked_out_at, r.label as room,
           coalesce(f.charges, 0) as charges, coalesce(f.payments, 0) as payments, coalesce(f.refunds, 0) as refunds,
           coalesce(f.discounts, 0) as discounts
    from bookings b
    left join rooms r on r.id = b.room_id
    left join lateral (
      select sum(amount) filter (where kind = 'charge') as charges,
             sum(amount) filter (where kind = 'payment') as payments,
             sum(amount) filter (where kind = 'refund') as refunds,
             sum(amount) filter (where kind = 'discount') as discounts
      from folio_items where booking_id = b.id and voided_at is null
    ) f on true
    where b.tenant_id = ${tenantId}
      and b.status = 'confirmed' and b.no_show_at is null
      and b.check_in <= ${to}::date and b.check_out >= ${from}::date
    order by b.check_in, b.guest_name
    limit 1000
  `;
  const unpaidRows = [];
  let unpaidTotal = 0;
  for (const o of owing.rows) {
    const total = Number(o.total_amount) || 0;
    const balance = round2(total + Number(o.charges) - (o.payment_status === 'paid' ? total : 0) - Number(o.payments) + Number(o.refunds) - Number(o.discounts));
    if (balance > 0.005) {
      unpaidTotal += balance;
      unpaidRows.push({
        booking_id: o.booking_id, guest_name: o.guest_name, room: o.room || null,
        check_in: o.check_in, check_out: o.check_out, balance,
        stage: o.checked_out_at ? 'Checked out' : o.checked_in_at ? 'In house' : 'Not arrived',
      });
    }
  }

  return {
    status: 200,
    json: {
      ok: true,
      resort: t.name,
      from, to, days_count: span,
      received: round2(received),
      refunded: round2(refunded),
      net: round2(received - refunded),
      charges_posted: round2(chargesPosted),
      discounts_given: round2(discountsGiven),
      methods,
      days: span > 1 ? days : [],
      lines: lines.slice(0, MAX_LINES),
      lines_truncated: lines.length > MAX_LINES,
      unpaid: { total: round2(unpaidTotal), count: unpaidRows.length, rows: unpaidRows.slice(0, MAX_UNPAID) },
    },
  };
}

// ------------------------------------------------------------
// STATEMENT OF ACCOUNT for one booking. A printable summary the owner or the
// accountant can work from. It is NOT an official receipt.
// ------------------------------------------------------------
export async function getStatement(tenantId, bookingId) {
  if (!UUID_RE.test(String(bookingId || ''))) return fail(400, 'A valid booking is required');
  const t = await tenantInfo(tenantId);

  const br = await sql`
    select b.id, b.guest_name, b.guest_email, b.guest_phone, b.check_in::text as check_in,
           b.check_out::text as check_out, b.nights, b.guests, b.status, b.payment_status,
           b.payment_channel, b.payment_confirmed_at, b.base_amount, b.addons_amount, b.discount_amount,
           b.vat_amount, b.total_amount, b.checked_in_at, b.checked_out_at, b.no_show_at,
           b.guest_id_type, b.guest_id_number, b.source,
           r.label as room, ut.name as room_type, pc.code as promo_code
    from bookings b
    left join rooms r on r.id = b.room_id
    left join unit_types ut on ut.id = b.unit_type_id
    left join promo_codes pc on pc.id = b.promo_code_id
    where b.id = ${bookingId} and b.tenant_id = ${tenantId}
  `;
  if (br.rows.length === 0) return fail(404, 'Booking not found');
  const b = br.rows[0];

  let addons = [];
  try {
    const ar = await sql`
      select a.name, ba.quantity, ba.price_at_booking
      from booking_addons ba join addons a on a.id = ba.addon_id
      where ba.booking_id = ${bookingId} and a.tenant_id = ${tenantId}
    `;
    addons = ar.rows.map((x) => ({
      name: x.name,
      quantity: Number(x.quantity) || 1,
      amount: round2((Number(x.price_at_booking) || 0) * (Number(x.quantity) || 1)),
    }));
  } catch (err) {
    addons = [];
  }

  const fr = await sql`
    select id, kind, description, amount, method, created_at,
           person_type, person_name, person_id, discount_scope, basis, discount_part, vat_part, exempt_sale,
           (created_at at time zone ${t.timezone})::date::text as day
    from folio_items
    where booking_id = ${bookingId} and tenant_id = ${tenantId} and voided_at is null
    order by created_at
  `;
  const items = fr.rows.map((x) => ({
    day: x.day, kind: x.kind, description: x.description,
    method: x.method || null, amount: round2(x.amount),
  }));
  const sum = (k) => round2(items.filter((i) => i.kind === k).reduce((a, i) => a + i.amount, 0));
  const charges = sum('charge');
  const payments = sum('payment');
  const refunds = sum('refund');
  const discountRows = fr.rows.filter((x) => x.kind === 'discount').map((x) => ({
    day: x.day,
    description: x.description,
    person_type: x.person_type || null,
    person_name: x.person_name || '',
    person_id: x.person_id || '',
    scope: x.discount_scope || null,
    basis: round2(x.basis),
    discount_part: round2(x.discount_part),
    vat_part: round2(x.vat_part),
    exempt_sale: round2(x.exempt_sale),
    amount: round2(x.amount),
  }));
  const discountsTotal = sum('discount');
  const vatExempt = round2(discountRows.reduce((a, d) => a + d.exempt_sale, 0));

  const total = Number(b.total_amount) || 0;
  const paidOnBooking = b.payment_status === 'paid' ? total : 0;
  const paidDay = b.payment_confirmed_at
    ? new Date(b.payment_confirmed_at).toLocaleDateString('en-CA', { timeZone: t.timezone })
    : null;
  const balance = round2(total + charges - paidOnBooking - payments + refunds - discountsTotal);
  const base = Number(b.base_amount) || 0;
  const nights = Number(b.nights) || 1;

  return {
    status: 200,
    json: {
      ok: true,
      statement: {
        resort: t.name,
        generated_on: new Date().toLocaleDateString('en-CA', { timeZone: t.timezone }),
        reference: String(b.id).slice(0, 8).toUpperCase(),
        guest: {
          name: b.guest_name, email: b.guest_email || null, phone: b.guest_phone || null,
          id_type: b.guest_id_type || null, id_number: b.guest_id_number || null,
        },
        stay: {
          room: b.room || null, room_type: b.room_type || null, check_in: b.check_in, check_out: b.check_out,
          nights, guests: b.guests, status: b.status, source: b.source,
          checked_in: !!b.checked_in_at, checked_out: !!b.checked_out_at, no_show: !!b.no_show_at,
        },
        room_amount: round2(base),
        rate_per_night: round2(base / nights),
        addons,
        addons_amount: round2(b.addons_amount),
        discount_amount: round2(b.discount_amount),
        promo_code: b.promo_code || null,
        subtotal_before_vat: round2(base + (Number(b.addons_amount) || 0) - (Number(b.discount_amount) || 0)),
        vat_amount: round2(b.vat_amount),
        booking_total: round2(total),
        extra_charges: items.filter((i) => i.kind === 'charge'),
        extra_charges_total: charges,
        paid_on_booking: round2(paidOnBooking),
        paid_on_booking_method: b.payment_status === 'paid' ? methodLabel(b.payment_channel) : null,
        paid_on_booking_day: b.payment_status === 'paid' ? paidDay : null,
        payments: items.filter((i) => i.kind === 'payment'),
        payments_total: payments,
        refunds: items.filter((i) => i.kind === 'refund'),
        refunds_total: refunds,
        discounts: discountRows,
        discounts_total: discountsTotal,
        vat_exempt_sales: vatExempt,
        balance,
      },
    },
  };
}
