import { sql } from '@vercel/postgres';

// Analytics: how full the rooms are, what a room earns, where bookings come
// from and how guests behave. Read only.
// Lives in _lib so it adds no serverless function (Vercel Hobby cap is 12).
// bookings.js serves it as GET ?resource=analytics&from=&to= and needs the
// Money "view" permission, because it shows income.
//
// Rules used everywhere in this file:
// - Only confirmed bookings that were not marked no-show are counted.
// - Money is the room price WITHOUT VAT (base amount minus the promo discount).
// - A booking's income is spread evenly over its nights. Only the nights that
//   fall inside the chosen days count.
// - Rooms available = the active rooms the resort has NOW times the days. The
//   history of how many rooms existed in the past is not kept.
// - Rooms blocked for maintenance still count as available (kept simple).

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;
const MAX_ROWS = 20000;
const AHEAD_DAYS = 30;
const WEEKLY_AFTER = 45;

function round1(n) {
  return Math.round((Number(n) + Number.EPSILON) * 10) / 10;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function fail(status, error) {
  return { status, json: { ok: false, error } };
}

function dayNumber(ds) {
  return Math.round(Date.parse(ds + 'T00:00:00Z') / 86400000);
}

function fromDayNumber(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

function addDays(ds, n) {
  return fromDayNumber(dayNumber(ds) + n);
}

// Same calendar day one year earlier. 29 February becomes 28 February.
function yearAgo(ds) {
  const y = Number(ds.slice(0, 4));
  const m = Number(ds.slice(5, 7));
  const d = Number(ds.slice(8, 10));
  const dt = new Date(Date.UTC(y - 1, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) dt.setUTCDate(0);
  return dt.toISOString().slice(0, 10);
}

function todayIn(timezone) {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: timezone || 'Asia/Manila' });
  } catch (err) {
    return new Date().toISOString().slice(0, 10);
  }
}

function sourceLabel(s) {
  const k = String(s || '').toLowerCase();
  if (!k || k === 'direct') return 'Online booking';
  if (k === 'walk_in') return 'Walk-in';
  return k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

// Nights of a stay that fall inside [f, t] (day numbers, both included).
function overlap(ci, co, f, t) {
  return Math.max(0, Math.min(co, t + 1) - Math.max(ci, f));
}

// Turns raw booking rows into numbers that are quick to work with.
function prepare(rows) {
  const out = [];
  for (const r of rows) {
    const ci = dayNumber(r.ci);
    const co = dayNumber(r.co);
    const total = co - ci;
    if (!(total > 0)) continue;
    const roomRev = Math.max(0, (Number(r.base_amount) || 0) - (Number(r.discount_amount) || 0));
    out.push({
      ci,
      co,
      unit_type_id: r.unit_type_id,
      source: r.source || 'direct',
      roomPerNight: roomRev / total,
      addonsPerNight: (Number(r.addons_amount) || 0) / total,
    });
  }
  return out;
}

// Headline numbers for one range.
function summarize(list, from, to, roomsTotal) {
  const f = dayNumber(from);
  const t = dayNumber(to);
  const days = t - f + 1;
  let nights = 0;
  let room = 0;
  let addons = 0;
  let count = 0;
  const byType = new Map();
  const bySource = new Map();
  for (const b of list) {
    const n = overlap(b.ci, b.co, f, t);
    if (n === 0) continue;
    count += 1;
    nights += n;
    room += n * b.roomPerNight;
    addons += n * b.addonsPerNight;
    const ty = byType.get(b.unit_type_id) || { nights: 0, revenue: 0 };
    ty.nights += n;
    ty.revenue += n * b.roomPerNight;
    byType.set(b.unit_type_id, ty);
    const key = String(b.source || 'direct').toLowerCase() === 'direct' ? 'direct' : String(b.source).toLowerCase();
    const so = bySource.get(key) || { bookings: 0, nights: 0, revenue: 0 };
    so.bookings += 1;
    so.nights += n;
    so.revenue += n * b.roomPerNight;
    bySource.set(key, so);
  }
  const available = roomsTotal * days;
  const occupancy = available > 0 ? Math.min(100, (nights / available) * 100) : null;
  return {
    from,
    to,
    days,
    bookings: count,
    room_nights: nights,
    available,
    occupancy: occupancy === null ? null : round1(occupancy),
    room_revenue: round2(room),
    addons_revenue: round2(addons),
    adr: nights > 0 ? round2(room / nights) : null,
    revpar: available > 0 ? round2(room / available) : null,
    byType,
    bySource,
  };
}

// Occupancy over time. One point per day, or per week for long ranges.
function buildSeries(list, from, to, roomsTotal, forceDaily) {
  const f = dayNumber(from);
  const t = dayNumber(to);
  const days = t - f + 1;
  const weekly = !forceDaily && days > WEEKLY_AFTER;
  const size = weekly ? 7 : 1;
  const points = [];
  for (let start = f; start <= t; start += size) {
    const end = Math.min(t, start + size - 1);
    let nights = 0;
    let room = 0;
    for (const b of list) {
      const n = overlap(b.ci, b.co, start, end);
      if (n === 0) continue;
      nights += n;
      room += n * b.roomPerNight;
    }
    const avail = roomsTotal * (end - start + 1);
    points.push({
      from: fromDayNumber(start),
      to: fromDayNumber(end),
      room_nights: nights,
      occupancy: avail > 0 ? round1(Math.min(100, (nights / avail) * 100)) : 0,
      room_revenue: round2(room),
    });
  }
  return { bucket: weekly ? 'week' : 'day', points };
}

function compact(s) {
  return {
    from: s.from,
    to: s.to,
    room_nights: s.room_nights,
    occupancy: s.occupancy,
    adr: s.adr,
    revpar: s.revpar,
    room_revenue: s.room_revenue,
  };
}

// Pure: takes rows already read from the database and returns the report.
// Kept separate from the queries so it can be tested without a database.
export function buildAnalytics(input) {
  const { from, to, today, roomsByType, typeNames, bookingRows, created, extras } = input;
  const list = prepare(bookingRows);
  const roomsTotal = roomsByType.reduce((a, r) => a + r.rooms, 0);
  const span = dayNumber(to) - dayNumber(from) + 1;

  const cur = summarize(list, from, to, roomsTotal);
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(span - 1));
  const prev = summarize(list, prevFrom, prevTo, roomsTotal);
  const lyFrom = yearAgo(from);
  const lyTo = yearAgo(to);
  const ly = summarize(list, lyFrom, lyTo, roomsTotal);

  const roomsOf = new Map(roomsByType.map((r) => [r.unit_type_id, r.rooms]));
  const typeIds = new Set([...cur.byType.keys(), ...roomsByType.map((r) => r.unit_type_id)]);
  const totalRoomRev = cur.room_revenue;
  const byType = [];
  for (const id of typeIds) {
    const v = cur.byType.get(id) || { nights: 0, revenue: 0 };
    const rooms = roomsOf.get(id) || 0;
    const avail = rooms * cur.days;
    byType.push({
      unit_type_id: id,
      name: typeNames.get(id) || 'Removed room type',
      rooms,
      room_nights: v.nights,
      occupancy: avail > 0 ? round1(Math.min(100, (v.nights / avail) * 100)) : null,
      adr: v.nights > 0 ? round2(v.revenue / v.nights) : null,
      room_revenue: round2(v.revenue),
      share: totalRoomRev > 0 ? round1((v.revenue / totalRoomRev) * 100) : 0,
    });
  }
  byType.sort((a, b) => b.room_revenue - a.room_revenue || a.name.localeCompare(b.name));

  const bySource = [...cur.bySource.entries()]
    .map(([key, v]) => ({
      key,
      label: sourceLabel(key),
      bookings: v.bookings,
      room_nights: v.nights,
      room_revenue: round2(v.revenue),
      share: totalRoomRev > 0 ? round1((v.revenue / totalRoomRev) * 100) : 0,
    }))
    .sort((a, b) => b.room_revenue - a.room_revenue);

  // Bookings made inside the range (by the day they were made).
  let made = 0;
  let cancelled = 0;
  let noShows = 0;
  let stays = 0;
  let stayNights = 0;
  let leadCount = 0;
  let leadSum = 0;
  for (const c of created) {
    made += 1;
    if (c.no_show) {
      noShows += 1;
      continue;
    }
    if (c.status === 'cancelled') {
      cancelled += 1;
      continue;
    }
    stays += 1;
    stayNights += Number(c.nights) || 0;
    if (c.source !== 'walk_in' && Number.isFinite(Number(c.lead)) && Number(c.lead) >= 0) {
      leadCount += 1;
      leadSum += Number(c.lead);
    }
  }

  const aheadTo = addDays(today, AHEAD_DAYS - 1);
  const ahead = summarize(list, today, aheadTo, roomsTotal);
  const aheadSeries = buildSeries(list, today, aheadTo, roomsTotal, true);

  return {
    from,
    to,
    days_count: span,
    rooms_total: roomsTotal,
    headline: {
      bookings: cur.bookings,
      room_nights: cur.room_nights,
      available: cur.available,
      occupancy: cur.occupancy,
      adr: cur.adr,
      revpar: cur.revpar,
      room_revenue: cur.room_revenue,
      addons_revenue: cur.addons_revenue,
      extras_revenue: round2(extras.extras),
      service_charge_billed: round2(extras.service),
    },
    compare: { previous: compact(prev), last_year: compact(ly) },
    series: buildSeries(list, from, to, roomsTotal, false),
    by_type: byType,
    by_source: bySource,
    behavior: {
      made,
      cancelled,
      cancel_rate: made > 0 ? round1((cancelled / made) * 100) : null,
      no_shows: noShows,
      avg_stay: stays > 0 ? round1(stayNights / stays) : null,
      avg_lead_days: leadCount > 0 ? round1(leadSum / leadCount) : null,
      online_count: leadCount,
    },
    ahead: {
      from: today,
      to: aheadTo,
      room_nights: ahead.room_nights,
      occupancy: ahead.occupancy,
      room_revenue: ahead.room_revenue,
      points: aheadSeries.points,
    },
  };
}

export async function getAnalytics(tenantId, from, to) {
  if (!DATE_RE.test(String(from || '')) || !DATE_RE.test(String(to || ''))) {
    return fail(400, 'Please choose the days to look at.');
  }
  const span = dayNumber(to) - dayNumber(from) + 1;
  if (!(span >= 1)) return fail(400, 'The last day must not be before the first day.');
  if (span > MAX_DAYS) return fail(400, 'Please choose 366 days or fewer.');

  const t = await sql`select name, timezone from tenants where id = ${tenantId}`;
  const tenant = t.rows[0] || {};
  const timezone = tenant.timezone || 'Asia/Manila';
  const today = todayIn(timezone);

  // The rooms the resort has now (active rooms inside active room types).
  const inv = await sql`
    select r.unit_type_id, count(*)::int as rooms
    from rooms r join unit_types ut on ut.id = r.unit_type_id
    where r.tenant_id = ${tenantId} and r.is_active = true and ut.is_active = true
    group by r.unit_type_id
  `;
  const roomsByType = inv.rows.map((x) => ({ unit_type_id: x.unit_type_id, rooms: Number(x.rooms) || 0 }));
  const names = await sql`select id, name from unit_types where tenant_id = ${tenantId}`;
  const typeNames = new Map(names.rows.map((x) => [x.id, x.name]));

  // One read covers this range, the range before it, the same days last year
  // and the next 30 days.
  const prevStart = addDays(from, -span);
  const lastYearStart = yearAgo(from);
  const aheadEnd = addDays(today, AHEAD_DAYS - 1);
  const minStart = [prevStart, lastYearStart, from, today].sort()[0];
  const maxEnd = [to, aheadEnd, yearAgo(to)].sort().slice(-1)[0];

  const br = await sql`
    select b.unit_type_id, b.source, b.check_in::text as ci, b.check_out::text as co,
           b.base_amount, b.addons_amount, b.discount_amount
    from bookings b
    where b.tenant_id = ${tenantId}
      and b.status = 'confirmed' and b.no_show_at is null
      and b.check_in <= ${maxEnd}::date and b.check_out > ${minStart}::date
    order by b.check_in
    limit 20001
  `;
  const truncated = br.rows.length > MAX_ROWS;
  const bookingRows = br.rows.slice(0, MAX_ROWS);

  const cr = await sql`
    select b.status, (b.no_show_at is not null) as no_show, b.source, b.nights,
           (b.check_in - (b.created_at at time zone ${timezone})::date)::int as lead
    from bookings b
    where b.tenant_id = ${tenantId}
      and (b.created_at at time zone ${timezone})::date between ${from}::date and ${to}::date
    limit 20000
  `;

  // Extra charges written on guest bills. Best effort: the report still works
  // if this cannot be read.
  let extras = { extras: 0, service: 0 };
  try {
    const er = await sql`
      select coalesce(sum(amount) filter (where description not ilike 'Service charge%'), 0) as extras,
             coalesce(sum(amount) filter (where description ilike 'Service charge%'), 0) as service
      from folio_items
      where tenant_id = ${tenantId} and kind = 'charge' and voided_at is null
        and (created_at at time zone ${timezone})::date between ${from}::date and ${to}::date
    `;
    extras = { extras: Number(er.rows[0].extras) || 0, service: Number(er.rows[0].service) || 0 };
  } catch (err) {
    extras = { extras: 0, service: 0 };
  }

  const report = buildAnalytics({
    from,
    to,
    today,
    roomsByType,
    typeNames,
    bookingRows,
    created: cr.rows,
    extras,
  });
  return {
    status: 200,
    json: { ok: true, resort: tenant.name || '', today, truncated, ...report },
  };
}
