import { sql } from '@vercel/postgres';
import { setCors, text, isBookableStatus } from './_lib/helpers.js';
import { getAccount, countBookingsThisMonth } from './_lib/limits.js';

// Only PayMongo is built in. Any other channel is created by the tenant and stored
// under a "custom_..." key (see settings.js), so there is nothing else to default.
const DEFAULT_PAYMENT_CHANNELS = {
  paymongo: { enabled: false },
};


function dayNumber(ds) {
  return Math.round(Date.parse(ds + 'T00:00:00Z') / 86400000);
}

function dayString(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

function todayIn(timezone) {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: timezone || 'Asia/Manila' });
  } catch (err) {
    return new Date().toISOString().slice(0, 10);
  }
}

// For each room type, the list of nights (YYYY-MM-DD, ascending) that can't be
// booked at all: every active room of that type is either taken by a confirmed
// booking or blocked. Uses the same rules as computeQuote in _lib/pricing.js.
async function computeUnavailable(tenantId, unitTypes, today, windowDays) {
  const result = {};
  unitTypes.forEach((u) => {
    result[u.id] = [];
  });
  if (unitTypes.length === 0) return result;

  const startDay = dayNumber(today);
  const endDay = startDay + Math.min(Math.max(windowDays, 1), 400);
  const startStr = today;
  const endStr = dayString(endDay);

  const roomsRes = await sql`
    SELECT id::text AS id, unit_type_id::text AS unit_type_id FROM rooms
    WHERE tenant_id = ${tenantId} AND is_active = true
  `;
  const bookingsRes = await sql`
    SELECT room_id::text AS room_id, unit_type_id::text AS unit_type_id,
           check_in::text AS check_in, check_out::text AS check_out
    FROM bookings
    WHERE tenant_id = ${tenantId} AND status = 'confirmed' AND room_id IS NOT NULL
      AND check_in <= ${endStr}::date AND check_out > ${startStr}::date
  `;
  const blocksRes = await sql`
    SELECT unit_type_id::text AS unit_type_id, start_date::text AS start_date,
           end_date::text AS end_date, room_ids::text[] AS room_ids
    FROM availability_blocks
    WHERE tenant_id = ${tenantId}
      AND end_date >= ${startStr}::date AND start_date <= ${endStr}::date
  `;

  const roomsByType = {};
  roomsRes.rows.forEach((r) => {
    (roomsByType[r.unit_type_id] = roomsByType[r.unit_type_id] || []).push(r.id);
  });

  const taken = new Map(); // "typeId|day" -> Set of room ids
  function mark(typeId, day, roomId) {
    const key = typeId + '|' + day;
    let set = taken.get(key);
    if (!set) {
      set = new Set();
      taken.set(key, set);
    }
    set.add(roomId);
  }

  // A booking occupies its room from check-in up to (not including) check-out.
  bookingsRes.rows.forEach((b) => {
    const from = Math.max(dayNumber(b.check_in), startDay);
    const to = Math.min(dayNumber(b.check_out) - 1, endDay);
    for (let d = from; d <= to; d++) mark(b.unit_type_id, d, b.room_id);
  });

  // A block covers its first and last date, both included.
  blocksRes.rows.forEach((k) => {
    const rooms = roomsByType[k.unit_type_id] || [];
    const ids = k.room_ids ? k.room_ids : rooms;
    const from = Math.max(dayNumber(k.start_date), startDay);
    const to = Math.min(dayNumber(k.end_date), endDay);
    for (let d = from; d <= to; d++) ids.forEach((id) => mark(k.unit_type_id, d, id));
  });

  unitTypes.forEach((u) => {
    const rooms = roomsByType[u.id] || [];
    for (let d = startDay; d <= endDay; d++) {
      if (rooms.length === 0) {
        result[u.id].push(dayString(d));
        continue;
      }
      const set = taken.get(u.id + '|' + d);
      if (set && rooms.every((id) => set.has(id))) result[u.id].push(dayString(d));
    }
  });
  return result;
}

export default async function handler(req, res) {
  if (setCors(req, res, 'GET, OPTIONS')) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const slug = text(req.query && req.query.slug);
    if (!slug) {
      return res.status(400).json({ ok: false, error: 'slug is required' });
    }

    // Look up by public_slug first (the customizable, guest-facing link),
    // falling back to the original internal slug so any widget page still
    // pointed at the old value keeps working.
    const t = await sql`
      SELECT id, name, currency, status, public_slug, timezone FROM tenants
      WHERE LOWER(public_slug) = ${slug.toLowerCase()} OR LOWER(slug) = ${slug.toLowerCase()}
      ORDER BY (LOWER(public_slug) = ${slug.toLowerCase()}) DESC
      LIMIT 1
    `;
    if (t.rows.length === 0 || !isBookableStatus(t.rows[0].status)) {
      return res.status(404).json({ ok: false, error: 'Resort not found' });
    }
    const tenant = t.rows[0];

    const s = await sql`
      SELECT primary_color, logo_url,
             checkin_time::text AS checkin_time, checkout_time::text AS checkout_time,
             cancellation_policy, vat_percent, vat_registered, min_stay_nights, booking_window_days,
             theme, payment_channels, custom_fields, widget_template, details_config
      FROM tenant_settings WHERE tenant_id = ${tenant.id}
    `;
    const settings = s.rows[0] || {};

    // Is this resort taking bookings? Trial over / account paused / monthly
    // booking cap reached all mean "no". The widget shows a friendly closed
    // screen instead of letting the guest fill in the whole form.
    const account = await getAccount(tenant.id);
    let acceptingBookings = !!(account && account.can_book);
    let closedReason = account ? account.blocked_code : 'account_inactive';
    if (acceptingBookings) {
      const used = await countBookingsThisMonth(tenant.id);
      if (used >= account.limits.bookings_per_month) {
        acceptingBookings = false;
        closedReason = 'booking_limit';
      }
    }

    let unitRows = [];
    let addonRows = [];
    let unavailable = {};
    if (acceptingBookings) {
      const units = await sql`
        SELECT id, name, description, capacity_guests, base_rate
        FROM unit_types
        WHERE tenant_id = ${tenant.id} AND is_active = true
        ORDER BY display_order, created_at
      `;
      const addons = await sql`
        SELECT id, name, price FROM addons
        WHERE tenant_id = ${tenant.id} AND is_active = true
        ORDER BY name
      `;
      unitRows = units.rows;
      addonRows = addons.rows;

      // Room photos (cover photo first) so the booking form and widget can show them.
      const photoRes = await sql`
        select p.unit_type_id::text as unit_type_id, p.url
        from unit_type_photos p
        join unit_types u on u.id = p.unit_type_id
        where u.tenant_id = ${tenant.id} and u.is_active = true
        order by p.display_order, p.id
      `;
      const photosByType = {};
      photoRes.rows.forEach((r) => {
        (photosByType[r.unit_type_id] = photosByType[r.unit_type_id] || []).push(r.url);
      });
      unitRows = unitRows.map((u) => ({ ...u, photos: photosByType[String(u.id)] || [] }));

      // A room type with no active rooms can never be booked, so guests should not see it
      // (it would show up as "not available" on every date, with no other dates to suggest).
      const roomTypeRes = await sql`
        select distinct unit_type_id::text as unit_type_id from rooms
        where tenant_id = ${tenant.id} and is_active = true
      `;
      const typesWithRooms = new Set(roomTypeRes.rows.map((r) => r.unit_type_id));
      unitRows = unitRows.filter((u) => typesWithRooms.has(String(u.id)));

      const windowDays = settings.booking_window_days ? Number(settings.booking_window_days) : 365;
      unavailable = await computeUnavailable(
        tenant.id,
        unitRows,
        todayIn(tenant.timezone),
        windowDays
      );
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      accepting_bookings: acceptingBookings,
      closed_reason: acceptingBookings ? null : closedReason,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        currency: tenant.currency,
        public_slug: tenant.public_slug,
      },
      settings: {
        primary_color: settings.primary_color || null,
        logo_url: settings.logo_url || null,
        checkin_time: settings.checkin_time ? String(settings.checkin_time).slice(0, 5) : '14:00',
        checkout_time: settings.checkout_time ? String(settings.checkout_time).slice(0, 5) : '12:00',
        cancellation_policy: settings.cancellation_policy || null,
        // Not VAT-registered means no VAT is added, so the widget sees 0.
        vat_percent:
          settings.vat_registered === false
            ? 0
            : settings.vat_percent !== undefined && settings.vat_percent !== null
              ? Number(settings.vat_percent)
              : 12,
        min_stay_nights: settings.min_stay_nights || 1,
        booking_window_days: settings.booking_window_days || 365,
        theme: settings.theme || null,
        payment_channels: settings.payment_channels || DEFAULT_PAYMENT_CHANNELS,
        custom_fields: settings.custom_fields || [],
        widget_template: settings.widget_template || 'standard',
        details_config: settings.details_config || {},
      },
      unit_types: unitRows,
      addons: addonRows,
      unavailable,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
