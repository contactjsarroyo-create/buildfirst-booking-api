import { sql } from '@vercel/postgres';

// ------------------------------------------------------------
// Outside clients (Merbau, later Elmarie) that run their own systems.
// 1) We keep our OWN permanent copy of their bookings in client_bookings.
//    A row deleted from the client's sheet is never deleted here: it is
//    only marked missing_since, so history cannot be erased by the client.
// 2) Analytics count ONLY bookings whose status is "Paid". Pending and
//    cancelled ones are shown as context, never counted as bookings.
// No guest names, emails or phone numbers are ever copied: only a short
// one-way key (guest_key) so repeat guests can be counted.
//
// Vercel setting CLIENT_FEEDS (JSON list):
// [{"key":"merbau","name":"Merbau Events & Villas","url":"https://.../api/client-stats",
//   "token":"...","launch":"2026-03-15","baseline_monthly_bookings":6}]
// ------------------------------------------------------------
const PH_MS = 8 * 3600 * 1000;
const STALE_MS = 10 * 60 * 1000;
const DAY = 86400000;

export function listClientConfigs() {
  try {
    const list = JSON.parse(process.env.CLIENT_FEEDS || '[]');
    if (!Array.isArray(list)) return [];
    return list.filter((c) => c && c.url).map((c) => ({
      key: String(c.key || c.name || '').trim(),
      name: String(c.name || c.key || 'Client'),
      url: String(c.url),
      token: String(c.token || ''),
      launch: c.launch ? String(c.launch) : null,
      baseline_monthly_bookings: Number(c.baseline_monthly_bookings) > 0 ? Number(c.baseline_monthly_bookings) : null,
    })).filter((c) => c.key);
  } catch (e) {
    return [];
  }
}

export function publicConfig(c) {
  return { key: c.key, name: c.name, launch: c.launch, baseline_monthly_bookings: c.baseline_monthly_bookings };
}

// ---------------- sync ----------------
async function fetchRows(cfg) {
  const u = new URL(cfg.url);
  u.searchParams.set('rows', '1');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(u.toString(), { headers: { 'x-stats-token': cfg.token }, signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok || !Array.isArray(j.rows)) return { ok: false, error: 'Their system answered ' + r.status + ' (no rows).' };
    return { ok: true, rows: j.rows };
  } catch (e) {
    return { ok: false, error: 'Could not reach their system.' };
  } finally {
    clearTimeout(timer);
  }
}

export async function syncStatus(key) {
  const r = await sql`
    select max(last_seen_at) as last_sync, count(*)::int as rows,
           count(*) filter (where missing_since is not null)::int as removed
    from client_bookings where client_key = ${key}::text
  `;
  const x = r.rows[0] || {};
  return { last_sync: x.last_sync ? new Date(x.last_sync).toISOString() : null, rows: x.rows || 0, removed: x.removed || 0 };
}

export async function syncClient(cfg, force) {
  if (!force) {
    const st = await syncStatus(cfg.key);
    if (st.last_sync && Date.now() - new Date(st.last_sync).getTime() < STALE_MS) return { ok: true, skipped: true };
  }
  const feed = await fetchRows(cfg);
  if (!feed.ok) return { ok: false, error: feed.error };

  // Safety: a feed that suddenly returns nothing must never mark everything as deleted.
  const have = await sql`select count(*)::int as n from client_bookings where client_key = ${cfg.key}::text and missing_since is null`;
  if (feed.rows.length === 0 && have.rows[0].n > 0) {
    return { ok: false, error: 'Their sheet returned 0 rows, so nothing was changed. Check the sheet.' };
  }

  const seen = new Map();
  for (const r of feed.rows) {
    if (r && r.id) seen.set(String(r.id), r);
  }
  const rows = Array.from(seen.values()).map((r) => ({
    id: String(r.id),
    made_at: r.made_at || null,
    room_type: r.room_type || null,
    unit: r.unit === undefined || r.unit === null ? null : String(r.unit),
    check_in: /^\d{4}-\d{2}-\d{2}$/.test(String(r.check_in || '')) ? r.check_in : null,
    check_out: /^\d{4}-\d{2}-\d{2}$/.test(String(r.check_out || '')) ? r.check_out : null,
    nights: Number.isFinite(Number(r.nights)) ? Math.round(Number(r.nights)) : null,
    guests: Number.isFinite(Number(r.guests)) ? Math.round(Number(r.guests)) : null,
    total: Number(r.total) || 0,
    vat: Number(r.vat) || 0,
    extra_fee: Number(r.extra_fee) || 0,
    status: r.status ? String(r.status).trim() : null,
    guest_key: r.guest_key || null,
  }));

  const ts = new Date().toISOString();
  for (let i = 0; i < rows.length; i += 400) {
    const json = JSON.stringify(rows.slice(i, i + 400));
    await sql`
      insert into client_bookings
        (client_key, booking_id, made_at, room_type, unit, check_in, check_out, nights, guests,
         total, vat, extra_fee, status, guest_key, last_seen_at, paid_first_seen_at)
      select ${cfg.key}::text, x.id, x.made_at, x.room_type, x.unit, x.check_in, x.check_out, x.nights, x.guests,
             coalesce(x.total, 0), coalesce(x.vat, 0), coalesce(x.extra_fee, 0), x.status, x.guest_key,
             ${ts}::timestamptz, case when x.status = 'Paid' then ${ts}::timestamptz end
      from jsonb_to_recordset(${json}::jsonb) as x(
        id text, made_at timestamptz, room_type text, unit text, check_in date, check_out date,
        nights int, guests int, total numeric, vat numeric, extra_fee numeric, status text, guest_key text)
      on conflict (client_key, booking_id) do update set
        made_at = coalesce(excluded.made_at, client_bookings.made_at),
        room_type = excluded.room_type,
        unit = excluded.unit,
        check_in = excluded.check_in,
        check_out = excluded.check_out,
        nights = excluded.nights,
        guests = excluded.guests,
        total = excluded.total,
        vat = excluded.vat,
        extra_fee = excluded.extra_fee,
        guest_key = coalesce(excluded.guest_key, client_bookings.guest_key),
        status_changed_at = case when client_bookings.status is distinct from excluded.status
                                 then ${ts}::timestamptz else client_bookings.status_changed_at end,
        status = excluded.status,
        paid_first_seen_at = coalesce(client_bookings.paid_first_seen_at, excluded.paid_first_seen_at),
        last_seen_at = excluded.last_seen_at,
        missing_since = null
    `;
  }
  // Rows we knew about that were not in this answer were deleted from their sheet.
  const gone = await sql`
    update client_bookings set missing_since = ${ts}::timestamptz
    where client_key = ${cfg.key}::text and missing_since is null and last_seen_at < ${ts}::timestamptz
    returning booking_id
  `;
  return { ok: true, rows: rows.length, newly_removed: gone.rows.length };
}

export async function loadRows(key) {
  const r = await sql`
    select booking_id, made_at, room_type, unit, check_in::text as check_in, check_out::text as check_out,
           nights, guests, total::float8 as total, vat::float8 as vat, extra_fee::float8 as extra_fee,
           status, guest_key, first_seen_at, paid_first_seen_at, status_changed_at, missing_since
    from client_bookings where client_key = ${key}::text
    order by made_at desc nulls last
    limit 50000
  `;
  return r.rows;
}

export async function clientSyncCron(req, res) {
  const secret = process.env.CRON_SECRET;
  const header = (req.headers && req.headers.authorization) || '';
  if (!secret || header !== 'Bearer ' + secret) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const out = [];
  for (const cfg of listClientConfigs()) {
    try {
      out.push({ key: cfg.key, ...(await syncClient(cfg, true)) });
    } catch (e) {
      out.push({ key: cfg.key, ok: false, error: String(e && e.message) });
    }
  }
  return res.status(200).json({ ok: true, clients: out });
}

// ---------------- analytics (pure, no database) ----------------
const phDay = (d) => new Date(d.getTime() + PH_MS).toISOString().slice(0, 10);
const phMonth = (d) => phDay(d).slice(0, 7);
const dayNum = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY;
const addMonth = (k, n) => {
  const y = +k.slice(0, 4), m = +k.slice(5, 7) - 1 + n;
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
};
const div = (a, b) => (b > 0 ? a / b : 0);
const pct = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function bucket(list, v) {
  for (const b of list) if (v >= b.min && v <= b.max) return b.label;
  return list[list.length - 1].label;
}
const LEAD = [
  { label: 'Same day', min: 0, max: 0 }, { label: '1 to 7 days', min: 1, max: 7 }, { label: '8 to 30 days', min: 8, max: 30 },
  { label: '31 to 90 days', min: 31, max: 90 }, { label: 'Over 90 days', min: 91, max: 1e9 },
];
const STAY = [
  { label: '1 night', min: 1, max: 1 }, { label: '2 nights', min: 2, max: 2 }, { label: '3 nights', min: 3, max: 3 },
  { label: '4 to 6 nights', min: 4, max: 6 }, { label: '7+ nights', min: 7, max: 1e9 },
];
const GROUP = [
  { label: '1 guest', min: 0, max: 1 }, { label: '2 guests', min: 2, max: 2 }, { label: '3 to 4 guests', min: 3, max: 4 },
  { label: '5 to 8 guests', min: 5, max: 8 }, { label: '9+ guests', min: 9, max: 1e9 },
];

export function buildAnalytics(input, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const includeRemoved = opts.includeRemoved !== false;
  const from = opts.from || null;
  const today = phDay(now);
  const thisMonth = today.slice(0, 7);

  const all = input.map((r) => {
    const made = r.made_at ? new Date(r.made_at) : null;
    const total = Number(r.total) || 0;
    const net = Math.max(0, total - (Number(r.vat) || 0) - (Number(r.extra_fee) || 0));
    let nights = Number(r.nights) || 0;
    if (!nights && r.check_in && r.check_out) nights = Math.max(0, dayNum(r.check_out) - dayNum(r.check_in));
    return {
      id: r.booking_id, made, month: made ? phMonth(made) : null, room: r.room_type || 'Unknown',
      check_in: r.check_in || null, check_out: r.check_out || null, nights, guests: Number(r.guests) || 0,
      total, net, status: r.status || '', paid: r.status === 'Paid', cancelled: r.status === 'Cancelled',
      guest_key: r.guest_key || null, missing: r.missing_since ? new Date(r.missing_since) : null,
    };
  });

  const live = all.filter((r) => includeRemoved || !r.missing);
  const inRange = live.filter((r) => !from || (r.month && r.month >= from));
  const paid = inRange.filter((r) => r.paid);

  // ---- monthly series (all months, whatever the range) ----
  const months = {};
  let minM = null;
  for (const r of live) {
    if (!r.month) continue;
    if (!minM || r.month < minM) minM = r.month;
    const m = months[r.month] || (months[r.month] = { month: r.month, bookings: 0, revenue: 0, net: 0, nights: 0, started: 0, pending: 0, cancelled: 0 });
    m.started += 1;
    if (r.paid) { m.bookings += 1; m.revenue += r.total; m.net += r.net; m.nights += r.nights; }
    else if (r.cancelled) m.cancelled += 1;
    else m.pending += 1;
  }
  const series = [];
  if (minM) {
    for (let k = minM; k <= thisMonth; k = addMonth(k, 1)) {
      series.push(months[k] || { month: k, bookings: 0, revenue: 0, net: 0, nights: 0, started: 0, pending: 0, cancelled: 0 });
    }
  }
  const complete = series.filter((m) => m.month < thisMonth);
  const last = complete.length ? complete[complete.length - 1] : null;
  const prev = complete.length > 1 ? complete[complete.length - 2] : null;
  const current = series.find((m) => m.month === thisMonth) || null;
  const compare = {
    last, prev, current,
    bookings_change: last && prev ? pct(last.bookings, prev.bookings) : null,
    revenue_change: last && prev ? pct(last.revenue, prev.revenue) : null,
  };

  // ---- headline (inside the chosen range) ----
  const n = paid.length;
  const revenue = paid.reduce((a, r) => a + r.total, 0);
  const net = paid.reduce((a, r) => a + r.net, 0);
  const nights = paid.reduce((a, r) => a + r.nights, 0);
  const leads = [];
  for (const r of paid) {
    if (r.made && r.check_in) {
      const l = dayNum(r.check_in) - dayNum(phDay(r.made));
      if (l >= 0) leads.push(l);
    }
  }
  const headline = {
    paid_bookings: n, revenue, net_room_revenue: net, room_nights: nights,
    avg_booking_value: div(revenue, n), adr: div(net, nights), avg_stay: div(nights, n),
    avg_guests: div(paid.reduce((a, r) => a + r.guests, 0), n),
    avg_lead_days: leads.length ? leads.reduce((a, b) => a + b, 0) / leads.length : null,
  };

  // ---- money funnel (inside range) ----
  const pend = inRange.filter((r) => !r.paid && !r.cancelled);
  const pendOld = pend.filter((r) => r.made && now.getTime() - r.made.getTime() > 3 * DAY);
  const funnel = {
    started: inRange.length, paid: n, pending: pend.length, pending_value: pend.reduce((a, r) => a + r.total, 0),
    pending_recent: pend.length - pendOld.length, abandoned: pendOld.length,
    abandoned_value: pendOld.reduce((a, r) => a + r.total, 0),
    cancelled: inRange.filter((r) => r.cancelled).length,
    completion_rate: inRange.length ? Math.round((n / inRange.length) * 100) : null,
  };

  // ---- rooms ----
  const roomMap = {};
  for (const r of paid) {
    const x = roomMap[r.room] || (roomMap[r.room] = { room: r.room, bookings: 0, revenue: 0, net: 0, nights: 0 });
    x.bookings += 1; x.revenue += r.total; x.net += r.net; x.nights += r.nights;
  }
  const rooms = Object.values(roomMap).map((x) => ({ ...x, adr: div(x.net, x.nights), share: Math.round(div(x.revenue, revenue) * 100) }))
    .sort((a, b) => b.revenue - a.revenue);

  // ---- timing and guests ----
  const dow = DOW.map((label) => ({ label, value: 0 }));
  const lead = LEAD.map((b) => ({ label: b.label, value: 0 }));
  const stay = STAY.map((b) => ({ label: b.label, value: 0 }));
  const group = GROUP.map((b) => ({ label: b.label, value: 0 }));
  const tick = (arr, label) => { const x = arr.find((a) => a.label === label); if (x) x.value += 1; };
  for (const r of paid) {
    if (r.check_in) dow[new Date(dayNum(r.check_in) * DAY).getUTCDay()].value += 1;
    if (r.made && r.check_in) { const l = dayNum(r.check_in) - dayNum(phDay(r.made)); if (l >= 0) tick(lead, bucket(LEAD, l)); }
    if (r.nights) tick(stay, bucket(STAY, r.nights));
    if (r.guests) tick(group, bucket(GROUP, r.guests));
  }
  const byGuest = {};
  for (const r of paid) if (r.guest_key) byGuest[r.guest_key] = (byGuest[r.guest_key] || 0) + 1;
  const keys = Object.keys(byGuest);
  const returning = keys.filter((k) => byGuest[k] >= 2).length;
  const guests = { known: keys.length, returning, returning_rate: keys.length ? Math.round((returning / keys.length) * 100) : null };
  const weekend = paid.filter((r) => { if (!r.check_in) return false; const d = new Date(dayNum(r.check_in) * DAY).getUTCDay(); return d === 5 || d === 6; }).length;

  // ---- already booked ahead (all paid, not just the range) ----
  const aheadRows = live.filter((r) => r.paid && r.check_in && r.check_in >= today);
  const t30 = dayNum(today) + 30;
  const ahead = {
    bookings: aheadRows.length, revenue: aheadRows.reduce((a, r) => a + r.total, 0),
    nights: aheadRows.reduce((a, r) => a + r.nights, 0),
    next_30_bookings: aheadRows.filter((r) => dayNum(r.check_in) <= t30).length,
  };

  // ---- data safety ----
  const removed = all.filter((r) => r.missing);
  const removedPaid = removed.filter((r) => r.paid);
  const safety = {
    removed: removed.length, removed_paid: removedPaid.length,
    removed_paid_value: removedPaid.reduce((a, r) => a + r.total, 0),
    counted_in_numbers: includeRemoved,
    list: removed.sort((a, b) => b.missing - a.missing).slice(0, 25).map((r) => ({
      id: r.id, room: r.room, check_in: r.check_in, check_out: r.check_out, total: r.total,
      status: r.status || '-', removed_at: r.missing.toISOString(), made_at: r.made ? r.made.toISOString() : null,
    })),
    undated: all.filter((r) => !r.made).length,
  };

  // ---- plain-words notes ----
  const notes = [];
  if (compare.bookings_change !== null && last && prev) {
    notes.push('Paid bookings in ' + last.month + ' were ' + (compare.bookings_change >= 0 ? 'up ' : 'down ') + Math.abs(compare.bookings_change) + '% on ' + prev.month + '.');
  }
  if (rooms.length) notes.push(rooms[0].room + ' brings in the most money (' + rooms[0].share + '% of paid revenue).');
  const topDow = dow.slice().sort((a, b) => b.value - a.value)[0];
  if (topDow && topDow.value > 0) notes.push('Most guests check in on ' + topDow.label + '.');
  if (funnel.abandoned > 0) notes.push(funnel.abandoned + ' checkouts were started but never paid. They are not counted.');
  if (safety.removed_paid > 0) notes.push(safety.removed_paid + ' paid booking(s) were deleted from their sheet. We kept our copy.');

  return { headline, series, compare, funnel, rooms, timing: { dow, lead, stay, group, weekend_share: n ? Math.round((weekend / n) * 100) : null }, guests, ahead, safety, notes, range_from: from, today };
}
