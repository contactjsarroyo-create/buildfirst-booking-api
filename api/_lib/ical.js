import { sql } from '@vercel/postgres';
import https from 'https';
import dns from 'dns';
import crypto from 'crypto';

// ------------------------------------------------------------
// Calendar sync (iCal). Everything is optional and per ROOM.
//
// SEND: a room can have a private link (a long random token). Other sites
//   (Booking.com, Agoda, Airbnb, anything that reads calendar links) read it.
//   It lists the nights that room is taken or blocked. No names, no prices.
//   Served without login by public-config.js (?feed=<token>.ics).
// GET: a room can have up to 5 links from other sites. Their dates become
//   availability_blocks rows (source 'ical', ical_import_id set) for that one
//   room. They are replaced on every sync. Pricing and the website already
//   respect availability_blocks, so nothing else had to change.
// Refresh: "Sync now", when the owner opens the calendar (links older than
//   30 minutes), and one daily cron (see vercel.json).
// ------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PER_ROOM = 5;
const MAX_PER_TENANT = 100;
const FETCH_TIMEOUT_MS = 7000;
const MAX_BYTES = 2000000;
const MAX_EVENTS = 1000;
const HORIZON_DAYS = 730;
const STALE_MINUTES = 30;
const OWN_UID = /@buildfirst\.digital$/i;

function plain(msg) {
  const e = new Error(msg);
  e.plain = true;
  return e;
}

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

// ---------------- reading a calendar file ----------------

function unfold(t) {
  return String(t).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

function parseProp(line) {
  const i = line.indexOf(':');
  if (i < 0) return null;
  const left = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts = left.split(';');
  const params = {};
  parts.slice(1).forEach((p) => {
    const k = p.indexOf('=');
    if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).toUpperCase();
  });
  return { name: parts[0].toUpperCase(), params, value: value.trim() };
}

function icsDate(v) {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(v || '').trim());
  if (!m) return null;
  const s = m[1] + '-' + m[2] + '-' + m[3];
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  return s;
}

// Returns { ranges: [{ start, end }], skipped } where start and end are the
// first and last NIGHT that is taken (both included, like our own blocks).
// In a calendar file the end date is the day the guest leaves, so the last
// night is the day before it.
export function parseIcs(input, todayStr) {
  const raw = unfold(input);
  if (!/BEGIN:VCALENDAR/i.test(raw)) {
    throw plain('That link did not give us a calendar. Check that you copied the calendar link, not the website address.');
  }
  const todayN = dayNumber(todayStr);
  const lastOk = todayN + HORIZON_DAYS;
  const skipped = { cancelled: 0, past: 0, own: 0, bad: 0 };
  const seen = new Map();
  let ev = null;
  raw.split('\n').forEach((line) => {
    const L = line.trim();
    if (!L) return;
    const up = L.toUpperCase();
    if (up === 'BEGIN:VEVENT') {
      ev = {};
      return;
    }
    if (up === 'END:VEVENT') {
      const e = ev;
      ev = null;
      if (!e) return;
      if (e.status === 'CANCELLED') return void (skipped.cancelled += 1);
      if (e.uid && OWN_UID.test(e.uid)) return void (skipped.own += 1);
      const s = e.dtstart ? icsDate(e.dtstart) : null;
      if (!s) return void (skipped.bad += 1);
      let endEx;
      if (e.dtend) endEx = icsDate(e.dtend);
      else if (e.duration !== undefined) endEx = dayString(dayNumber(s) + e.duration);
      else endEx = dayString(dayNumber(s) + 1);
      if (!endEx) return void (skipped.bad += 1);
      let lastN = dayNumber(endEx) - 1;
      if (lastN < dayNumber(s)) lastN = dayNumber(s);
      if (lastN < todayN) return void (skipped.past += 1);
      if (dayNumber(s) > lastOk) return void (skipped.past += 1);
      if (lastN > lastOk) lastN = lastOk;
      const range = { start: s, end: dayString(lastN) };
      seen.set(range.start + '|' + range.end, range);
      return;
    }
    if (!ev) return;
    const p = parseProp(L);
    if (!p) return;
    if (p.name === 'DTSTART') ev.dtstart = p.value;
    else if (p.name === 'DTEND') ev.dtend = p.value;
    else if (p.name === 'UID') ev.uid = p.value;
    else if (p.name === 'STATUS') ev.status = p.value.toUpperCase();
    else if (p.name === 'DURATION') {
      const m = /^P(?:(\d+)W)?(?:(\d+)D)?/i.exec(p.value);
      if (m) ev.duration = Number(m[1] || 0) * 7 + Number(m[2] || 0);
    }
  });
  const ranges = Array.from(seen.values()).sort((a, b) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : 1
  );
  if (ranges.length > MAX_EVENTS) {
    throw plain('That calendar has too many entries (more than ' + MAX_EVENTS + ').');
  }
  return { ranges, skipped };
}

// ---------------- writing our own calendar file ----------------

function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, ' ');
}
function icsDay(ds) {
  return ds.replace(/-/g, '');
}

// ranges: [{ start, endEx }]  (endEx = first free day, like a check-out date)
export function buildFeed({ calName, uidKey, ranges, now }) {
  const sorted = ranges
    .filter((r) => r && r.start && r.endEx && r.endEx > r.start)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const merged = [];
  sorted.forEach((r) => {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.endEx) {
      if (r.endEx > last.endEx) last.endEx = r.endEx;
    } else merged.push({ start: r.start, endEx: r.endEx });
  });
  const stamp = (now || new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Buildfirst//Booking Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' + icsEscape(calName),
  ];
  merged.forEach((r) => {
    lines.push(
      'BEGIN:VEVENT',
      'UID:bf-' + uidKey + '-' + icsDay(r.start) + '@buildfirst.digital',
      'DTSTAMP:' + stamp,
      'DTSTART;VALUE=DATE:' + icsDay(r.start),
      'DTEND;VALUE=DATE:' + icsDay(r.endEx),
      'SUMMARY:Not available',
      'TRANSP:OPAQUE',
      'END:VEVENT'
    );
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// Public, no login. The long random token in the link is the only protection.
export async function serveFeed(req, res) {
  const token = String((req.query && req.query.feed) || '').replace(/\.ics$/i, '').toLowerCase();
  if (!/^[0-9a-f]{48}$/.test(token)) {
    return res.status(404).send('Not found');
  }
  const r = await sql`
    select e.room_id::text as room_id, e.tenant_id::text as tenant_id,
           rm.label, rm.unit_type_id::text as unit_type_id, t.timezone, t.status
    from ical_exports e
    join rooms rm on rm.id = e.room_id
    join tenants t on t.id = e.tenant_id
    where e.token = ${token}
    limit 1
  `;
  if (r.rows.length === 0) return res.status(404).send('Not found');
  const row = r.rows[0];
  if (row.status !== 'active' && row.status !== 'onboarding') return res.status(404).send('Not found');

  const today = todayIn(row.timezone);
  const horizon = dayString(dayNumber(today) + HORIZON_DAYS);
  const b = await sql`
    select check_in::text as s, check_out::text as e from bookings
    where tenant_id = ${row.tenant_id}::uuid and room_id = ${row.room_id}::uuid
      and status = 'confirmed' and checked_out_at is null
      and check_out > ${today}::date and check_in < ${horizon}::date
  `;
  const k = await sql`
    select start_date::text as s, end_date::text as e from availability_blocks
    where tenant_id = ${row.tenant_id}::uuid and unit_type_id = ${row.unit_type_id}::uuid
      and coalesce(source, 'manual') <> 'ical'
      and end_date >= ${today}::date and start_date < ${horizon}::date
      and (room_ids is null or ${row.room_id}::uuid = any(room_ids))
  `;
  const ranges = [];
  b.rows.forEach((x) => ranges.push({ start: x.s, endEx: x.e > horizon ? horizon : x.e }));
  k.rows.forEach((x) => {
    const endEx = dayString(dayNumber(x.e) + 1);
    ranges.push({ start: x.s, endEx: endEx > horizon ? horizon : endEx });
  });
  const body = buildFeed({ calName: row.label, uidKey: row.room_id.slice(0, 8), ranges });
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="calendar.ics"');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(body);
}

// ---------------- fetching a link safely ----------------

export function isPrivateIp(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (!s) return true;
  if (s.includes(':')) {
    if (s === '::' || s === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateIp(mapped[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return isPrivateIp([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
    }
    const first = parseInt(s.split(':')[0] || '0', 16) || 0;
    if ((first & 0xfe00) === 0xfc00) return true;
    if ((first & 0xffc0) === 0xfe80) return true;
    if ((first & 0xffc0) === 0xfec0) return true;
    if (s.startsWith('64:ff9b:')) return true;
    return false;
  }
  const p = s.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const a = p[0];
  const b = p[1];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && p[2] === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

export function checkImportUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) throw plain('Paste the calendar link first.');
  if (s.length > 2000) throw plain('That link is too long.');
  s = s.replace(/^webcal:\/\//i, 'https://');
  let u;
  try {
    u = new URL(s);
  } catch (err) {
    throw plain('That does not look like a link. It should start with https://');
  }
  if (u.protocol !== 'https:') throw plain('The link must start with https:// (or webcal://).');
  if (u.username || u.password) throw plain('Links with a username or password are not supported.');
  if (u.port && u.port !== '443') throw plain('That link uses an unusual port, which is not supported.');
  const host = u.hostname.toLowerCase();
  if (
    !host.includes('.') ||
    host.includes(':') ||
    host.startsWith('[') ||
    /^\d+(\.\d+){3}$/.test(host) ||
    /\.(local|internal|localhost|lan|home)$/.test(host)
  ) {
    throw plain('That link points to a private or unsupported address.');
  }
  return u.toString();
}

// The address is checked at the moment of connecting, so a website cannot
// answer with a safe address first and a private one later.
function safeLookup(hostname, options, cb) {
  let opts = options;
  let done = cb;
  if (typeof options === 'function') {
    done = options;
    opts = {};
  }
  dns.lookup(hostname, { ...(opts || {}), all: true }, (err, addrs) => {
    if (err) return done(err);
    if (!addrs || addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
      return done(new Error('blocked address'));
    }
    if (opts && opts.all) return done(null, addrs);
    return done(null, addrs[0].address, addrs[0].family);
  });
}

function requestOnce(urlStr, timeoutMs, maxBytes) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    let finished = false;
    let timer = null;
    function finish(fn, v) {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      fn(v);
    }
    const req = https.request(
      {
        protocol: 'https:',
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: 'GET',
        lookup: safeLookup,
        headers: {
          'User-Agent': 'Buildfirst-Calendar-Sync/1.0',
          Accept: 'text/calendar, text/plain, */*',
          'Accept-Encoding': 'identity',
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          let next;
          try {
            next = new URL(res.headers.location, u).toString();
          } catch (err) {
            return finish(reject, plain('The other site sent us somewhere we could not follow.'));
          }
          return finish(resolve, { redirect: next });
        }
        if (status !== 200) {
          res.resume();
          return finish(reject, plain('The other site answered with an error (' + status + ').'));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            return finish(reject, plain('That calendar is too big to read.'));
          }
          chunks.push(c);
        });
        res.on('end', () => finish(resolve, { body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', () => finish(reject, plain('The connection was cut while reading the calendar.')));
      }
    );
    timer = setTimeout(() => {
      req.destroy();
      finish(reject, plain('The other site took too long to answer.'));
    }, timeoutMs);
    req.on('error', (e) => {
      const m = String((e && e.message) || '');
      if (/blocked address/.test(m)) return finish(reject, plain('That link points to a private or unsupported address.'));
      if (e && e.code === 'ENOTFOUND') return finish(reject, plain('We could not find that website. Check the link.'));
      return finish(reject, plain('We could not connect to that link.'));
    });
    req.end();
  });
}

async function fetchIcsText(urlStr) {
  let current = checkImportUrl(urlStr);
  for (let i = 0; i < 4; i += 1) {
    const out = await requestOnce(current, FETCH_TIMEOUT_MS, MAX_BYTES);
    if (out.body !== undefined) return out.body;
    current = checkImportUrl(out.redirect);
  }
  throw plain('That link sends us around in circles.');
}

let fetcher = fetchIcsText;
// For tests only.
export function _setFetcher(fn) {
  fetcher = fn || fetchIcsText;
}

// ---------------- applying dates to the calendar ----------------

async function applyRanges(imp, ranges) {
  const existing = await sql`
    select id::text as id, start_date::text as s, end_date::text as e
    from availability_blocks where ical_import_id = ${imp.id}::uuid
  `;
  const want = new Set(ranges.map((r) => r.start + '|' + r.end));
  const have = new Set();
  const toDelete = [];
  existing.rows.forEach((row) => {
    const k = row.s + '|' + row.e;
    if (want.has(k) && !have.has(k)) have.add(k);
    else toDelete.push(row.id);
  });
  const toAdd = ranges.filter((r) => !have.has(r.start + '|' + r.end));
  // Add first, remove after, so a dropped connection never leaves a gap.
  if (toAdd.length > 0) {
    const startsLit = '{' + toAdd.map((r) => r.start).join(',') + '}';
    const endsLit = '{' + toAdd.map((r) => r.end).join(',') + '}';
    const roomLit = '{' + imp.room_id + '}';
    await sql`
      insert into availability_blocks
        (tenant_id, unit_type_id, room_ids, start_date, end_date, reason, source, ical_import_id)
      select ${imp.tenant_id}::uuid, ${imp.unit_type_id}::uuid, ${roomLit}::uuid[],
             t.s, t.e, ${imp.name}::text, 'ical', ${imp.id}::uuid
      from unnest(${startsLit}::date[], ${endsLit}::date[]) as t(s, e)
    `;
  }
  if (toDelete.length > 0) {
    const idsLit = '{' + toDelete.join(',') + '}';
    await sql`
      delete from availability_blocks
      where ical_import_id = ${imp.id}::uuid and id = any(${idsLit}::uuid[])
    `;
  }
  return { added: toAdd.length, removed: toDelete.length };
}

async function markOk(id, count) {
  await sql`
    update ical_imports
    set last_synced_at = now(), last_status = 'ok', last_error = null, last_count = ${count}
    where id = ${id}::uuid
  `;
}
async function markError(id, message) {
  await sql`
    update ical_imports
    set last_synced_at = now(), last_status = 'error', last_error = ${String(message).slice(0, 200)}
    where id = ${id}::uuid
  `;
}

// imp: { id, tenant_id, room_id, unit_type_id, name, url, timezone }
// A link that cannot be read keeps the dates from the last good sync.
async function syncOne(imp) {
  try {
    const body = await fetcher(imp.url);
    const parsed = parseIcs(body, todayIn(imp.timezone));
    const diff = await applyRanges(imp, parsed.ranges);
    await markOk(imp.id, parsed.ranges.length);
    return { ok: true, id: imp.id, count: parsed.ranges.length, added: diff.added, removed: diff.removed };
  } catch (err) {
    let msg = 'Something went wrong while reading this link.';
    if (err && err.plain) msg = err.message;
    else console.error('ical sync', imp.id, err && err.message);
    try {
      await markError(imp.id, msg);
    } catch (e2) {
      console.error('ical markError', e2 && e2.message);
    }
    return { ok: false, id: imp.id, error: msg };
  }
}

async function runLimited(items, limit, fn, deadline) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      if (Date.now() > deadline) return;
      const idx = i;
      i += 1;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out.filter(Boolean);
}

// tenantId null = every property (the daily cron). staleMinutes 0 = all.
export async function syncMany({ tenantId, staleMinutes, onlyId, limit, budgetMs }) {
  const stale = Math.max(0, Number(staleMinutes) || 0);
  const cap = Math.min(Math.max(Number(limit) || 20, 1), 300);
  let rows;
  if (onlyId) {
    rows = await sql`
      select i.id::text as id, i.tenant_id::text as tenant_id, i.room_id::text as room_id, i.name, i.url,
             rm.unit_type_id::text as unit_type_id, t.timezone
      from ical_imports i
      join rooms rm on rm.id = i.room_id
      join tenants t on t.id = i.tenant_id
      where i.id = ${onlyId}::uuid and i.tenant_id = ${tenantId}::uuid
    `;
  } else if (tenantId) {
    rows = await sql`
      select i.id::text as id, i.tenant_id::text as tenant_id, i.room_id::text as room_id, i.name, i.url,
             rm.unit_type_id::text as unit_type_id, t.timezone
      from ical_imports i
      join rooms rm on rm.id = i.room_id
      join tenants t on t.id = i.tenant_id
      where i.tenant_id = ${tenantId}::uuid
        and (${stale}::int = 0 or i.last_synced_at is null
             or i.last_synced_at < now() - make_interval(mins => ${stale}::int))
      order by i.last_synced_at asc nulls first
      limit ${cap}
    `;
  } else {
    rows = await sql`
      select i.id::text as id, i.tenant_id::text as tenant_id, i.room_id::text as room_id, i.name, i.url,
             rm.unit_type_id::text as unit_type_id, t.timezone
      from ical_imports i
      join rooms rm on rm.id = i.room_id
      join tenants t on t.id = i.tenant_id
      where t.status in ('active', 'onboarding')
        and (${stale}::int = 0 or i.last_synced_at is null
             or i.last_synced_at < now() - make_interval(mins => ${stale}::int))
      order by i.last_synced_at asc nulls first
      limit ${cap}
    `;
  }
  const results = await runLimited(rows.rows, 5, syncOne, Date.now() + (budgetMs || 20000));
  const failed = results.filter((r) => !r.ok).length;
  const changed = results.some((r) => r.ok && (r.added > 0 || r.removed > 0));
  return { tried: results.length, waiting: rows.rows.length - results.length, failed, synced: results.length - failed, changed, results };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Daily cron: GET /api/settings?resource=ical_cron (Vercel sends
// Authorization: Bearer <CRON_SECRET> by itself when CRON_SECRET is set).
export async function icalCron(req, res) {
  const secret = process.env.CRON_SECRET || '';
  const header = (req.headers && req.headers.authorization) || '';
  if (!secret || !safeEqual(header, 'Bearer ' + secret)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const out = await syncMany({ tenantId: null, staleMinutes: 0, limit: 300, budgetMs: 45000 });
  return res.status(200).json({ ok: true, tried: out.tried, synced: out.synced, failed: out.failed, waiting: out.waiting });
}

// ---------------- the owner's screen ----------------

export async function getIcalState(tenantId) {
  const rooms = await sql`
    select rm.id::text as id, rm.label, rm.is_active, rm.unit_type_id::text as unit_type_id,
           ut.name as type_name
    from rooms rm
    join unit_types ut on ut.id = rm.unit_type_id
    where rm.tenant_id = ${tenantId}::uuid
    order by ut.display_order nulls last, ut.name, rm.label
  `;
  const exp = await sql`
    select room_id::text as room_id, token from ical_exports where tenant_id = ${tenantId}::uuid
  `;
  const imps = await sql`
    select id::text as id, room_id::text as room_id, name, url, last_synced_at, last_status,
           last_error, last_count
    from ical_imports where tenant_id = ${tenantId}::uuid order by created_at
  `;
  const conf = await sql`
    select distinct k.ical_import_id::text as import_id, b.id::text as booking_id, b.guest_name,
           b.check_in::text as check_in, b.check_out::text as check_out
    from availability_blocks k
    join bookings b on b.tenant_id = k.tenant_id and b.room_id = any(k.room_ids)
    where k.tenant_id = ${tenantId}::uuid and k.source = 'ical'
      and b.status = 'confirmed' and b.checked_out_at is null
      and b.check_in <= k.end_date and b.check_out > k.start_date
      and b.check_out >= now()::date
    order by check_in
    limit 100
  `;
  const tokenByRoom = {};
  exp.rows.forEach((r) => {
    tokenByRoom[r.room_id] = r.token;
  });
  const conflictsByImport = {};
  conf.rows.forEach((c) => {
    (conflictsByImport[c.import_id] = conflictsByImport[c.import_id] || []).push({
      guest_name: c.guest_name,
      check_in: c.check_in,
      check_out: c.check_out,
    });
  });
  const impsByRoom = {};
  imps.rows.forEach((i) => {
    let host = '';
    try {
      host = new URL(i.url).hostname;
    } catch (err) {
      host = '';
    }
    (impsByRoom[i.room_id] = impsByRoom[i.room_id] || []).push({
      id: i.id,
      name: i.name,
      host,
      last_synced_at: i.last_synced_at,
      last_status: i.last_status,
      last_error: i.last_error,
      last_count: Number(i.last_count) || 0,
      conflicts: conflictsByImport[i.id] || [],
    });
  });
  return {
    rooms: rooms.rows.map((r) => ({
      id: r.id,
      label: r.label,
      type_name: r.type_name,
      unit_type_id: r.unit_type_id,
      is_active: r.is_active !== false,
      token: tokenByRoom[r.id] || null,
      imports: impsByRoom[r.id] || [],
    })),
  };
}

async function ownRoom(tenantId, roomId) {
  if (!UUID_RE.test(String(roomId || ''))) return null;
  const r = await sql`
    select rm.id::text as id, rm.unit_type_id::text as unit_type_id, t.timezone
    from rooms rm join tenants t on t.id = rm.tenant_id
    where rm.id = ${roomId}::uuid and rm.tenant_id = ${tenantId}::uuid
  `;
  return r.rows[0] || null;
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function cleanName(v) {
  const s = String(v || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return s || 'Other site';
}

export const ICAL_ACTIONS = [
  'export_on', 'export_off', 'export_new', 'import_add', 'import_remove', 'sync', 'sync_all', 'sync_stale',
];

// Owner only (the route checks). Returns { status, json }.
export async function icalAction(auth, body) {
  const b = body || {};
  const action = String(b.action || '');
  const tenantId = auth.tenant_id;
  try {
    if (action === 'sync_stale') {
      const out = await syncMany({ tenantId, staleMinutes: STALE_MINUTES, limit: 20, budgetMs: 20000 });
      return { status: 200, json: { ok: true, changed: out.changed, tried: out.tried } };
    }

    if (action === 'sync_all') {
      const out = await syncMany({ tenantId, staleMinutes: 0, limit: MAX_PER_TENANT, budgetMs: 40000 });
      return {
        status: 200,
        json: { ok: true, synced: out.synced, failed: out.failed, waiting: out.waiting, state: await getIcalState(tenantId) },
      };
    }

    if (action === 'sync') {
      if (!UUID_RE.test(String(b.id || ''))) return { status: 400, json: { ok: false, error: 'Invalid link' } };
      const out = await syncMany({ tenantId, staleMinutes: 0, onlyId: b.id, limit: 1, budgetMs: 20000 });
      if (out.results.length === 0) return { status: 404, json: { ok: false, error: 'Link not found' } };
      const r = out.results[0];
      return {
        status: 200,
        json: { ok: true, result: { ok: r.ok, error: r.error || null, count: r.count || 0 }, state: await getIcalState(tenantId) },
      };
    }

    if (action === 'export_on' || action === 'export_off' || action === 'export_new') {
      const room = await ownRoom(tenantId, b.room_id);
      if (!room) return { status: 404, json: { ok: false, error: 'Room not found' } };
      if (action === 'export_on') {
        await sql`
          insert into ical_exports (room_id, tenant_id, token)
          values (${room.id}::uuid, ${tenantId}::uuid, ${newToken()})
          on conflict (room_id) do nothing
        `;
      } else if (action === 'export_off') {
        await sql`delete from ical_exports where room_id = ${room.id}::uuid and tenant_id = ${tenantId}::uuid`;
      } else {
        const up = await sql`
          update ical_exports set token = ${newToken()}
          where room_id = ${room.id}::uuid and tenant_id = ${tenantId}::uuid
          returning room_id
        `;
        if (up.rows.length === 0) return { status: 404, json: { ok: false, error: 'Turn the link on first.' } };
      }
      return { status: 200, json: { ok: true, state: await getIcalState(tenantId) } };
    }

    if (action === 'import_remove') {
      if (!UUID_RE.test(String(b.id || ''))) return { status: 400, json: { ok: false, error: 'Invalid link' } };
      // The dates that came from this link go with it (cascade).
      const del = await sql`
        delete from ical_imports where id = ${b.id}::uuid and tenant_id = ${tenantId}::uuid returning id
      `;
      if (del.rows.length === 0) return { status: 404, json: { ok: false, error: 'Link not found' } };
      return { status: 200, json: { ok: true, state: await getIcalState(tenantId) } };
    }

    if (action === 'import_add') {
      const room = await ownRoom(tenantId, b.room_id);
      if (!room) return { status: 404, json: { ok: false, error: 'Room not found' } };
      let url;
      try {
        url = checkImportUrl(b.url);
      } catch (e) {
        return { status: 400, json: { ok: false, error: e.message } };
      }
      const name = cleanName(b.name);
      const counts = await sql`
        select count(*)::int as total, count(*) filter (where room_id = ${room.id}::uuid)::int as here,
               count(*) filter (where room_id = ${room.id}::uuid and url = ${url})::int as same
        from ical_imports where tenant_id = ${tenantId}::uuid
      `;
      const c = counts.rows[0];
      if (c.same > 0) return { status: 409, json: { ok: false, error: 'This room already has that link.' } };
      if (c.here >= MAX_PER_ROOM) {
        return { status: 409, json: { ok: false, error: 'A room can have up to ' + MAX_PER_ROOM + ' links.' } };
      }
      if (c.total >= MAX_PER_TENANT) {
        return { status: 409, json: { ok: false, error: 'You have reached the limit of ' + MAX_PER_TENANT + ' links.' } };
      }
      // Read it first: a link that does not work is never saved.
      let parsed;
      try {
        const text = await fetcher(url);
        parsed = parseIcs(text, todayIn(room.timezone));
      } catch (e) {
        if (e && e.plain) return { status: 400, json: { ok: false, error: e.message } };
        throw e;
      }
      const ins = await sql`
        insert into ical_imports (tenant_id, room_id, name, url)
        values (${tenantId}::uuid, ${room.id}::uuid, ${name}, ${url})
        returning id::text as id
      `;
      const imp = { id: ins.rows[0].id, tenant_id: tenantId, room_id: room.id, unit_type_id: room.unit_type_id, name };
      await applyRanges(imp, parsed.ranges);
      await markOk(imp.id, parsed.ranges.length);
      return { status: 200, json: { ok: true, count: parsed.ranges.length, state: await getIcalState(tenantId) } };
    }

    return { status: 400, json: { ok: false, error: 'Unknown action' } };
  } catch (err) {
    console.error('icalAction', action, err && err.message);
    if (/relation .* does not exist|column .* does not exist/i.test(String((err && err.message) || ''))) {
      return { status: 500, json: { ok: false, error: 'Calendar sync is not ready yet.' } };
    }
    return { status: 500, json: { ok: false, error: 'Server error' } };
  }
}
