import { sql } from '@vercel/postgres';
import { computeQuote } from './pricing.js';
import { getAccount, countBookingsThisMonth } from './limits.js';
import { addGuestInfo, attachGuestToBooking } from './guests.js';

// Front Desk: arrivals, in-house guests, check-in / check-out, folio (extra
// charges and payments), room status, staff-entered walk-in bookings.
// Lives in _lib so it adds no serverless function (Vercel Hobby cap is 12).
// bookings.js serves the reads (?resource=frontdesk / folio) and
// booking-update.js runs the actions (PATCH with an "action" field).
// Permission checks happen in those two files before anything here runs.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_AMOUNT = 10000000;

function todayIn(timezone) {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: timezone || 'Asia/Manila' });
  } catch (err) {
    return new Date().toISOString().slice(0, 10);
  }
}

async function tenantToday(tenantId) {
  const r = await sql`select timezone from tenants where id = ${tenantId}`;
  return todayIn(r.rows[0] && r.rows[0].timezone);
}

function addDays(ds, n) {
  const d = new Date(ds + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function fail(status, error, extra) {
  return { status, json: { ok: false, error, ...(extra || {}) } };
}

function done(json) {
  return { status: 200, json: { ok: true, ...(json || {}) } };
}

// What is still owed on a booking row that carries folio_charges,
// folio_payments and folio_refunds. A booking marked as paid counts as paid
// for its own total; extra charges and folio payments come on top of that.
function balanceOf(row) {
  const total = Number(row.total_amount) || 0;
  const paidOnBooking = row.payment_status === 'paid' ? total : 0;
  return round2(
    total + (Number(row.folio_charges) || 0) - paidOnBooking - (Number(row.folio_payments) || 0) + (Number(row.folio_refunds) || 0)
  );
}

// ------------------------------------------------------------
// READS
// ------------------------------------------------------------
export async function getFrontDesk(tenantId) {
  const today = await tenantToday(tenantId);

  const result = await sql`
    select b.id, b.guest_name, b.guest_email, b.guest_phone,
           b.check_in::text as check_in, b.check_out::text as check_out,
           b.guests, b.special_requests, b.total_amount, b.payment_status, b.payment_channel,
           b.status, b.source, b.room_id, b.unit_type_id, b.owner_note, b.guest_id,
           b.checked_in_at, b.checked_out_at, b.guest_id_type, b.guest_id_number,
           coalesce(f.charges, 0) as folio_charges,
           coalesce(f.payments, 0) as folio_payments,
           coalesce(f.refunds, 0) as folio_refunds
    from bookings b
    left join lateral (
      select sum(amount) filter (where kind = 'charge') as charges,
             sum(amount) filter (where kind = 'payment') as payments,
             sum(amount) filter (where kind = 'refund') as refunds
      from folio_items where booking_id = b.id and voided_at is null
    ) f on true
    where b.tenant_id = ${tenantId}
      and (
        (b.checked_in_at is not null and b.checked_out_at is null)
        or (b.checked_in_at is null and b.status = 'confirmed' and b.no_show_at is null
            and b.is_archived = false
            and b.check_in <= ${today}::date and b.check_out > ${today}::date)
      )
    order by b.check_in, b.guest_name
  `;
  const rows = await addGuestInfo(
    tenantId,
    result.rows.map((r) => ({ ...r, balance_due: balanceOf(r) }))
  );
  const inHouse = rows.filter((r) => r.checked_in_at);
  const arrivals = rows.filter((r) => !r.checked_in_at);

  const roomsResult = await sql`
    select r.id, r.label, r.unit_type_id, r.housekeeping_status, ut.name as type_name
    from rooms r join unit_types ut on ut.id = r.unit_type_id
    where r.tenant_id = ${tenantId} and r.is_active = true and ut.is_active = true
    order by ut.name, r.label
  `;
  const blocksResult = await sql`
    select unit_type_id, room_ids::text[] as room_ids from availability_blocks
    where tenant_id = ${tenantId} and start_date <= ${today}::date and end_date >= ${today}::date
  `;

  // Open problems reported in Housekeeping, so the room board can say why a
  // room is out of order. If the table is not there yet, carry on without it.
  let openProblems = [];
  try {
    const pr = await sql`
      select room_id::text as room_id, title from maintenance_requests
      where tenant_id = ${tenantId} and status = 'open' order by created_at
    `;
    openProblems = pr.rows;
  } catch (err) {
    openProblems = [];
  }

  const rooms = roomsResult.rows.map((r) => {
    const guest = inHouse.find((b) => b.room_id === r.id);
    const problem = openProblems.find((p) => p.room_id === r.id);
    const blocked = blocksResult.rows.some(
      (bl) => bl.unit_type_id === r.unit_type_id && (!bl.room_ids || bl.room_ids.includes(r.id))
    );
    const arriving = arrivals.find((b) => b.room_id === r.id && b.check_in === today);
    let status = 'clean';
    if (guest) status = 'occupied';
    else if (blocked) status = 'out_of_order';
    else if (r.housekeeping_status === 'dirty') status = 'dirty';
    return {
      id: r.id,
      label: r.label,
      unit_type_id: r.unit_type_id,
      type_name: r.type_name,
      status,
      guest_name: guest ? guest.guest_name : null,
      booking_id: guest ? guest.id : null,
      check_out: guest ? guest.check_out : null,
      arriving_name: arriving ? arriving.guest_name : null,
      problem: problem ? problem.title : null,
    };
  });

  return { ok: true, today, arrivals, in_house: inHouse, rooms };
}

export async function getFolio(tenantId, bookingId) {
  if (!UUID_RE.test(String(bookingId || ''))) return fail(400, 'A valid booking is required');
  const b = await loadBooking(tenantId, bookingId);
  if (!b) return fail(404, 'Booking not found');
  const items = await sql`
    select id, kind, description, amount, method, created_at
    from folio_items
    where booking_id = ${bookingId} and tenant_id = ${tenantId} and voided_at is null
    order by created_at
  `;
  return done({
    folio: {
      booking_id: b.id,
      total_amount: Number(b.total_amount) || 0,
      paid_on_booking: b.payment_status === 'paid',
      items: items.rows,
      balance_due: balanceOf(b),
    },
  });
}

async function loadBooking(tenantId, bookingId) {
  const r = await sql`
    select b.*, b.check_in::text as ci, b.check_out::text as co,
           coalesce(f.charges, 0) as folio_charges,
           coalesce(f.payments, 0) as folio_payments,
           coalesce(f.refunds, 0) as folio_refunds
    from bookings b
    left join lateral (
      select sum(amount) filter (where kind = 'charge') as charges,
             sum(amount) filter (where kind = 'payment') as payments,
             sum(amount) filter (where kind = 'refund') as refunds
      from folio_items where booking_id = b.id and voided_at is null
    ) f on true
    where b.id = ${bookingId} and b.tenant_id = ${tenantId}
  `;
  return r.rows[0] || null;
}

// ------------------------------------------------------------
// ROOM CHECKS
// ------------------------------------------------------------
// Returns an error message, or '' when the room can take these dates.
async function roomProblem(tenantId, roomId, ci, co, excludeBookingId) {
  const room = await sql`
    select id, unit_type_id, is_active from rooms where id = ${roomId} and tenant_id = ${tenantId}
  `;
  if (room.rows.length === 0) return { message: 'That room was not found.', status: 404 };
  if (room.rows[0].is_active === false) {
    return { message: 'That room is turned off. Turn it on first or pick another room.', status: 400 };
  }
  const exclude = excludeBookingId || '00000000-0000-0000-0000-000000000000';
  const clash = await sql`
    select 1 from bookings
    where tenant_id = ${tenantId} and room_id = ${roomId} and id <> ${exclude}
      and status <> 'cancelled' and checked_out_at is null
      and check_in < ${co}::date and check_out > ${ci}::date
    limit 1
  `;
  if (clash.rows.length > 0) return { message: 'That room already has a booking on some of these dates.', status: 409 };
  const stillIn = await sql`
    select 1 from bookings
    where tenant_id = ${tenantId} and room_id = ${roomId} and id <> ${exclude}
      and checked_in_at is not null and checked_out_at is null
    limit 1
  `;
  if (stillIn.rows.length > 0) return { message: 'A guest is still checked in to that room.', status: 409 };
  const blocked = await sql`
    select 1 from availability_blocks
    where tenant_id = ${tenantId} and unit_type_id = ${room.rows[0].unit_type_id}
      and start_date <= (${co}::date - 1) and end_date >= ${ci}::date
      and (room_ids is null or ${roomId}::text = any(room_ids::text[]))
    limit 1
  `;
  if (blocked.rows.length > 0) return { message: 'That room is blocked on some of these dates.', status: 409 };
  return { message: '', unit_type_id: room.rows[0].unit_type_id };
}

// ------------------------------------------------------------
// CHECK-IN (shared by the check_in action and walk-ins)
// ------------------------------------------------------------
async function doCheckIn(tenantId, bookingId, roomIdIn, idTypeIn, idNumberIn) {
  const b = await loadBooking(tenantId, bookingId);
  if (!b) return fail(404, 'Booking not found');
  if (b.status === 'cancelled') return fail(400, 'This booking is cancelled.');
  if (b.status !== 'confirmed') return fail(400, 'Confirm this booking before checking the guest in.');
  if (b.checked_in_at) return fail(400, 'This guest is already checked in.');
  const today = await tenantToday(tenantId);
  if (b.ci > today) return fail(400, 'This guest arrives on ' + b.ci + '. It is too early to check in.');
  if (b.co <= today) return fail(400, 'The dates of this booking have already passed.');

  const roomId = roomIdIn || b.room_id;
  if (!roomId) return fail(400, 'Choose a room first.');
  if (!UUID_RE.test(String(roomId))) return fail(400, 'Please choose a valid room');
  const problem = await roomProblem(tenantId, roomId, b.ci, b.co, bookingId);
  if (problem.message) return fail(problem.status, problem.message);

  const idType = idTypeIn ? String(idTypeIn).trim().slice(0, 40) : null;
  const idNumber = idNumberIn ? String(idNumberIn).trim().slice(0, 60) : null;
  await sql`
    update bookings set
      checked_in_at = now(), room_id = ${roomId}, unit_type_id = ${problem.unit_type_id},
      guest_id_type = ${idType || null}, guest_id_number = ${idNumber || null}
    where id = ${bookingId} and tenant_id = ${tenantId}
  `;
  return done({});
}

// ------------------------------------------------------------
// ACTIONS
// ------------------------------------------------------------
export async function frontDeskAction(auth, body) {
  try {
    return await run(auth, body || {});
  } catch (err) {
    console.error('frontDeskAction', err);
    return fail(500, 'Server error');
  }
}

async function run(auth, body) {
  const tenantId = auth.tenant_id;
  const action = String(body.action || '');
  const id = body.id;

  if (action === 'set_room_status') {
    if (!UUID_RE.test(String(body.room_id || ''))) return fail(400, 'Please choose a valid room');
    if (body.status !== 'clean' && body.status !== 'dirty') return fail(400, 'Status must be clean or dirty');
    const r = await sql`
      update rooms set housekeeping_status = ${body.status}
      where id = ${body.room_id} and tenant_id = ${tenantId} returning id
    `;
    if (r.rows.length === 0) return fail(404, 'That room was not found.');
    return done({});
  }

  if (action === 'walk_in') return walkIn(auth, body);

  if (!id || !UUID_RE.test(String(id))) return fail(400, 'A valid booking is required');

  if (action === 'check_in') {
    return doCheckIn(tenantId, id, body.room_id, body.id_type, body.id_number);
  }

  if (action === 'undo_check_in') {
    const r = await sql`
      update bookings set checked_in_at = null, guest_id_type = null, guest_id_number = null
      where id = ${id} and tenant_id = ${tenantId}
        and checked_in_at is not null and checked_out_at is null
      returning id
    `;
    if (r.rows.length === 0) return fail(400, 'This guest is not checked in.');
    return done({});
  }

  if (action === 'check_out') {
    const b = await loadBooking(tenantId, id);
    if (!b) return fail(404, 'Booking not found');
    if (!b.checked_in_at) return fail(400, 'This guest is not checked in.');
    if (b.checked_out_at) return fail(400, 'This guest is already checked out.');
    const balance = balanceOf(b);
    if (balance > 0.005 && body.force !== true) {
      return fail(409, 'This guest still owes money.', { code: 'balance_due', balance });
    }
    await sql`
      update bookings set checked_out_at = now()
      where id = ${id} and tenant_id = ${tenantId}
    `;
    if (b.room_id) {
      await sql`
        update rooms set housekeeping_status = 'dirty'
        where id = ${b.room_id} and tenant_id = ${tenantId}
      `;
    }
    return done({ balance });
  }

  if (action === 'no_show') {
    const b = await loadBooking(tenantId, id);
    if (!b) return fail(404, 'Booking not found');
    if (b.checked_in_at) return fail(400, 'This guest is already checked in.');
    if (b.status !== 'confirmed') return fail(400, 'Only a confirmed booking can be marked as a no-show.');
    const today = await tenantToday(tenantId);
    if (b.ci > today) return fail(400, 'This guest has not arrived yet, so it is too early to call a no-show.');
    await sql`
      update bookings set status = 'cancelled', no_show_at = now()
      where id = ${id} and tenant_id = ${tenantId}
    `;
    return done({});
  }

  if (action === 'add_folio') {
    const kind = String(body.kind || '');
    if (!['charge', 'payment', 'refund'].includes(kind)) return fail(400, 'Please choose charge, payment or refund');
    const description = String(body.description || '').trim().slice(0, 120);
    if (!description) return fail(400, 'Please write what this is for.');
    const amount = round2(body.amount);
    if (!(amount > 0) || amount > MAX_AMOUNT) return fail(400, 'Please enter an amount above zero.');
    const method = body.method ? String(body.method).trim().slice(0, 40) : null;
    const b = await loadBooking(tenantId, id);
    if (!b) return fail(404, 'Booking not found');
    if (kind === 'payment') {
      // Never take more than what is owed. This also stops the same money being
      // recorded twice (once as "Mark as paid", once on the bill).
      const owed = balanceOf(b);
      if (owed <= 0.005) return fail(409, 'Nothing is owed on this booking. It is already paid.');
      if (amount > owed + 0.005) return fail(409, 'That is more than the guest owes (' + owed.toFixed(2) + ').');
    }
    await sql`
      insert into folio_items (tenant_id, booking_id, kind, description, amount, method)
      values (${tenantId}, ${id}, ${kind}, ${description}, ${amount}, ${method})
    `;
    return done({});
  }

  if (action === 'void_folio') {
    if (!UUID_RE.test(String(body.item_id || ''))) return fail(400, 'Please choose a valid line');
    const r = await sql`
      update folio_items set voided_at = now()
      where id = ${body.item_id} and booking_id = ${id} and tenant_id = ${tenantId} and voided_at is null
      returning id
    `;
    if (r.rows.length === 0) return fail(404, 'That line was not found.');
    return done({});
  }

  return fail(400, 'Unknown action');
}

// ------------------------------------------------------------
// WALK-IN: a booking typed in by staff for a guest at the desk.
// Uses the same price and availability rules as an online booking.
// ------------------------------------------------------------
async function walkIn(auth, body) {
  const tenantId = auth.tenant_id;
  const guestName = String(body.guest_name || '').trim().slice(0, 120);
  const guestPhone = body.guest_phone ? String(body.guest_phone).trim().slice(0, 40) : null;
  const guestEmail = body.guest_email ? String(body.guest_email).trim().slice(0, 200) : '';
  if (!guestName) return fail(400, "Please enter the guest's name.");
  if (guestEmail && !EMAIL_RE.test(guestEmail)) return fail(400, 'That email address does not look right.');
  if (!UUID_RE.test(String(body.unit_type_id || ''))) return fail(400, 'Please choose a room type.');

  const today = await tenantToday(tenantId);
  const checkIn = body.check_in ? String(body.check_in) : today;
  if (!DATE_RE.test(checkIn)) return fail(400, 'Dates must be in YYYY-MM-DD format');
  const nights = Math.floor(Number(body.nights) || 1);
  if (nights < 1 || nights > 60) return fail(400, 'Nights must be between 1 and 60.');
  const checkOut = addDays(checkIn, nights);
  const guests = Math.max(1, Math.floor(Number(body.guests)) || 1);

  const account = await getAccount(tenantId);
  if (!account) return fail(404, 'Resort not found');
  if (!account.can_book) {
    return fail(403, 'New bookings are switched off for this account right now. Please ask the account owner.');
  }
  const thisMonth = await countBookingsThisMonth(tenantId);
  if (thisMonth >= account.limits.bookings_per_month) {
    return fail(403, 'This account has reached its booking limit for this month.', { code: 'booking_limit' });
  }

  const q = await computeQuote({
    tenant_id: tenantId,
    unit_type_id: body.unit_type_id,
    check_in: checkIn,
    check_out: checkOut,
    guests,
  });
  if (!q.ok) return fail(q.status, q.error);

  let roomId = q.room_id;
  if (body.room_id) {
    if (!UUID_RE.test(String(body.room_id))) return fail(400, 'Please choose a valid room');
    const own = await sql`
      select 1 from rooms where id = ${body.room_id} and tenant_id = ${tenantId} and unit_type_id = ${body.unit_type_id}
    `;
    if (own.rows.length === 0) return fail(400, 'That room does not belong to the chosen room type.');
    const problem = await roomProblem(tenantId, body.room_id, checkIn, checkOut, null);
    if (problem.message) return fail(problem.status, problem.message);
    roomId = body.room_id;
  }

  const inserted = await sql`
    insert into bookings (
      tenant_id, unit_type_id, room_id, guest_name, guest_email, guest_phone,
      check_in, check_out, guests, base_amount, addons_amount, vat_amount,
      discount_amount, total_amount, source, status
    ) values (
      ${tenantId}, ${q.unit_type_id}, ${roomId}, ${guestName}, ${guestEmail}, ${guestPhone},
      ${q.check_in}, ${q.check_out}, ${q.guests}, ${q.base_amount}, 0, ${q.vat_amount},
      0, ${q.total_amount}, 'walk_in', 'confirmed'
    )
    returning id
  `;
  const bookingId = inserted.rows[0].id;

  // Link the walk-in to a guest profile (a returning guest is matched by phone).
  await attachGuestToBooking(tenantId, bookingId, { name: guestName, email: guestEmail, phone: guestPhone });

  let checkInError = '';
  if (body.check_in_now === true && checkIn === today) {
    const r = await doCheckIn(tenantId, bookingId, roomId, body.id_type, body.id_number);
    if (!r.json.ok) checkInError = r.json.error;
  }
  return done({ booking_id: bookingId, check_in_error: checkInError });
}
