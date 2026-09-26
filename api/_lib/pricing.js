import { sql } from '@vercel/postgres';
import { isBookableStatus } from './helpers.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function fail(status, error) {
  return { ok: false, status, error };
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function dayNumber(ds) {
  return Math.round(Date.parse(ds + 'T00:00:00Z') / 86400000);
}

function todayIn(timezone) {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: timezone || 'Asia/Manila' });
  } catch (err) {
    return new Date().toISOString().slice(0, 10);
  }
}

// Shared by the price quote and the real booking, so both always agree.
// Returns { ok: false, status, error } or { ok: true, ...amounts, room_id }.
export async function computeQuote(input) {
  const { tenant_id, unit_type_id, check_in, check_out, guests, addon_ids, promo_code } = input || {};

  if (!tenant_id || !unit_type_id || !check_in || !check_out) {
    return fail(400, 'tenant_id, unit_type_id, check_in and check_out are required');
  }
  if (!UUID_RE.test(String(tenant_id)) || !UUID_RE.test(String(unit_type_id))) {
    return fail(400, 'Invalid tenant_id or unit_type_id');
  }
  if (!DATE_RE.test(String(check_in)) || !DATE_RE.test(String(check_out))) {
    return fail(400, 'Dates must be in YYYY-MM-DD format');
  }

  const inDay = dayNumber(check_in);
  const outDay = dayNumber(check_out);
  if (Number.isNaN(inDay) || Number.isNaN(outDay)) {
    return fail(400, 'Invalid date');
  }
  const nights = outDay - inDay;
  if (nights <= 0) {
    return fail(400, 'check_out must be after check_in');
  }

  const tenantResult = await sql`
    SELECT timezone, status FROM tenants WHERE id = ${tenant_id}
  `;
  if (tenantResult.rows.length === 0) {
    return fail(404, 'Resort not found');
  }
  if (!isBookableStatus(tenantResult.rows[0].status)) {
    return fail(403, 'This resort is not accepting bookings right now');
  }
  const today = todayIn(tenantResult.rows[0].timezone);

  const settingsResult = await sql`
    SELECT vat_percent, min_stay_nights, booking_window_days
    FROM tenant_settings WHERE tenant_id = ${tenant_id}
  `;
  const s = settingsResult.rows[0];
  const vatPercent = s && s.vat_percent !== null ? Number(s.vat_percent) : 12;
  const minStay = s && s.min_stay_nights !== null ? Number(s.min_stay_nights) : 1;
  const windowDays = s && s.booking_window_days !== null ? Number(s.booking_window_days) : 365;

  if (check_in < today) {
    return fail(400, 'Check-in date cannot be in the past');
  }
  if (nights < minStay) {
    return fail(400, `Minimum stay is ${minStay} night${minStay === 1 ? '' : 's'}`);
  }
  if (inDay - dayNumber(today) > windowDays) {
    return fail(400, `Bookings can only be made up to ${windowDays} days ahead`);
  }

  const unitResult = await sql`
    SELECT base_rate, capacity_guests FROM unit_types
    WHERE id = ${unit_type_id} AND tenant_id = ${tenant_id} AND is_active = true
  `;
  if (unitResult.rows.length === 0) {
    return fail(404, 'Room type not found');
  }
  const baseRate = Number(unitResult.rows[0].base_rate);
  const capacity = unitResult.rows[0].capacity_guests
    ? Number(unitResult.rows[0].capacity_guests)
    : null;

  const guestCount = Math.max(1, Math.floor(Number(guests)) || 1);
  if (capacity && guestCount > capacity) {
    return fail(400, `This room sleeps up to ${capacity} guest${capacity === 1 ? '' : 's'}`);
  }

  // A block covers its first and last date, both included. Blocks are still
  // unit-type-level (apply to every room of that type), not per-room.
  const overlappingBlocks = await sql`
    SELECT COUNT(*) FROM availability_blocks
    WHERE unit_type_id = ${unit_type_id}
      AND tenant_id = ${tenant_id}
      AND start_date < ${check_out}::date
      AND end_date >= ${check_in}::date
  `;
  if (Number(overlappingBlocks.rows[0].count) > 0) {
    return fail(409, 'These dates are blocked for this room type');
  }

  // Per-room availability: find every active room of this type, then find
  // which of those rooms are already taken by a confirmed booking for these
  // dates, and pick the first one that's free.
  const roomsResult = await sql`
    SELECT id FROM rooms
    WHERE unit_type_id = ${unit_type_id}
      AND tenant_id = ${tenant_id}
      AND is_active = true
    ORDER BY label
  `;
  const allRoomIds = roomsResult.rows.map((r) => r.id);

  if (allRoomIds.length === 0) {
    return fail(409, 'No rooms have been set up for this room type yet');
  }

  const occupiedResult = await sql`
    SELECT room_id FROM bookings
    WHERE unit_type_id = ${unit_type_id}
      AND tenant_id = ${tenant_id}
      AND status = 'confirmed'
      AND room_id IS NOT NULL
      AND check_in < ${check_out}::date
      AND check_out > ${check_in}::date
  `;
  const occupiedRoomIds = new Set(occupiedResult.rows.map((r) => r.room_id));
  const availableRoomId = allRoomIds.find((id) => !occupiedRoomIds.has(id));

  if (!availableRoomId) {
    return fail(409, 'No rooms of this type are available for the selected dates');
  }

  let addonsAmount = 0;
  const validAddons = [];
  const ids = Array.isArray(addon_ids) ? Array.from(new Set(addon_ids)) : [];
  if (ids.length > 0) {
    if (ids.some((id) => !UUID_RE.test(String(id)))) {
      return fail(400, 'One or more addon_ids are invalid or inactive');
    }
    const addonsResult = await sql`
      SELECT id, price FROM addons
      WHERE tenant_id = ${tenant_id} AND id = ANY(${ids}) AND is_active = true
    `;
    for (const row of addonsResult.rows) {
      const price = Number(row.price);
      addonsAmount += price;
      validAddons.push({ id: row.id, price });
    }
    if (validAddons.length !== ids.length) {
      return fail(400, 'One or more addon_ids are invalid or inactive');
    }
  }

  const baseAmount = round2(baseRate * nights);
  addonsAmount = round2(addonsAmount);
  const preDiscountSubtotal = baseAmount + addonsAmount;

  let discountAmount = 0;
  let promoCodeId = null;
  const code = promo_code ? String(promo_code).trim().toUpperCase() : '';
  if (code) {
    const promoResult = await sql`
      SELECT id, discount_percent, discount_amount,
             valid_from::text AS valid_from, valid_to::text AS valid_to,
             max_uses, times_used, is_active
      FROM promo_codes
      WHERE tenant_id = ${tenant_id} AND UPPER(code) = ${code}
    `;
    if (promoResult.rows.length === 0) {
      return fail(400, 'Invalid promo code');
    }
    const promo = promoResult.rows[0];

    if (!promo.is_active) {
      return fail(400, 'This promo code is no longer active');
    }
    if (promo.valid_from && today < promo.valid_from) {
      return fail(400, 'This promo code is not yet valid');
    }
    if (promo.valid_to && today > promo.valid_to) {
      return fail(400, 'This promo code has expired');
    }
    if (promo.max_uses !== null && Number(promo.times_used || 0) >= Number(promo.max_uses)) {
      return fail(400, 'This promo code has reached its usage limit');
    }

    if (Number(promo.discount_percent) > 0) {
      discountAmount = preDiscountSubtotal * (Number(promo.discount_percent) / 100);
    } else if (Number(promo.discount_amount) > 0) {
      discountAmount = Number(promo.discount_amount);
    }
    discountAmount = round2(Math.min(discountAmount, preDiscountSubtotal));
    promoCodeId = promo.id;
  }

  const taxableAmount = round2(preDiscountSubtotal - discountAmount);
  const vatAmount = round2(taxableAmount * (vatPercent / 100));
  const totalAmount = round2(taxableAmount + vatAmount);

  return {
    ok: true,
    tenant_id,
    unit_type_id,
    room_id: availableRoomId,
    check_in,
    check_out,
    nights,
    guests: guestCount,
    base_rate: baseRate,
    base_amount: baseAmount,
    addons_amount: addonsAmount,
    discount_amount: discountAmount,
    vat_percent: vatPercent,
    vat_amount: vatAmount,
    total_amount: totalAmount,
    promo_code_id: promoCodeId,
    valid_addons: validAddons,
  };
}
