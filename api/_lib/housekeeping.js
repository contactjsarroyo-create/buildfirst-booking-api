import { sql } from '@vercel/postgres';

// Housekeeping: rooms that need cleaning, problems reported on a room
// (maintenance), and lost and found. Lives in _lib so it adds no serverless
// function (Vercel Hobby cap is 12). blocks.js serves it:
//   GET  /api/blocks?resource=housekeeping   -> getHousekeeping
//   POST /api/blocks?resource=housekeeping   -> housekeepingAction (body.action)
// The permission check (area 'housekeeping') happens in blocks.js before
// anything here runs. Nothing here returns guest names or money.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A broken room stays blocked until someone marks it as fixed. The block is
// given a long end date so it does not run out by itself.
const BLOCK_DAYS = 730;

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

function fail(status, error, extra) {
  return { status, json: { ok: false, error, ...(extra || {}) } };
}

function done(json) {
  return { status: 200, json: { ok: true, ...(json || {}) } };
}

async function whoIs(auth) {
  try {
    const r = await sql`
      select email from tenant_users
      where id::text = ${String(auth.user_id)} and tenant_id::text = ${String(auth.tenant_id)}
      limit 1
    `;
    return r.rows[0] && r.rows[0].email ? String(r.rows[0].email).slice(0, 120) : null;
  } catch (err) {
    return null;
  }
}

// ------------------------------------------------------------
// READ: everything the Housekeeping screen needs in one go
// ------------------------------------------------------------
export async function getHousekeeping(tenantId) {
  const today = await tenantToday(tenantId);

  const roomsResult = await sql`
    select r.id, r.label, r.unit_type_id, r.housekeeping_status, ut.name as type_name
    from rooms r join unit_types ut on ut.id = r.unit_type_id
    where r.tenant_id = ${tenantId} and r.is_active = true and ut.is_active = true
    order by ut.name, r.label
  `;
  const inHouse = await sql`
    select room_id::text as room_id, check_out::text as check_out
    from bookings
    where tenant_id = ${tenantId} and checked_in_at is not null and checked_out_at is null
      and room_id is not null
  `;
  const arrivals = await sql`
    select room_id::text as room_id
    from bookings
    where tenant_id = ${tenantId} and checked_in_at is null and status = 'confirmed'
      and no_show_at is null and is_archived = false and room_id is not null
      and check_in <= ${today}::date and check_out > ${today}::date
  `;
  const blocksResult = await sql`
    select unit_type_id, room_ids::text[] as room_ids from availability_blocks
    where tenant_id = ${tenantId} and start_date <= ${today}::date and end_date >= ${today}::date
  `;
  const problemsResult = await sql`
    select m.id, m.room_id::text as room_id, m.title, m.note, m.status, m.blocks_room,
           m.reported_by, m.created_at, m.fixed_at, m.fixed_by,
           r.label as room_label, ut.name as type_name
    from maintenance_requests m
    join rooms r on r.id = m.room_id
    left join unit_types ut on ut.id = r.unit_type_id
    where m.tenant_id = ${tenantId}
      and (m.status = 'open' or m.fixed_at > now() - interval '30 days')
    order by (m.status = 'open') desc, m.created_at desc
    limit 200
  `;
  const lostResult = await sql`
    select l.id, l.description, l.found_where, l.room_id::text as room_id, l.found_on::text as found_on,
           l.status, l.resolved_note, l.resolved_at, l.logged_by, l.created_at,
           r.label as room_label
    from lost_items l
    left join rooms r on r.id = l.room_id
    where l.tenant_id = ${tenantId}
      and (l.status = 'kept' or l.resolved_at > now() - interval '60 days')
    order by (l.status = 'kept') desc, l.created_at desc
    limit 300
  `;

  const openProblems = problemsResult.rows.filter((p) => p.status === 'open');

  const rooms = roomsResult.rows.map((r) => {
    const stay = inHouse.rows.find((b) => b.room_id === r.id);
    const blocked = blocksResult.rows.some(
      (bl) => bl.unit_type_id === r.unit_type_id && (!bl.room_ids || bl.room_ids.includes(r.id))
    );
    const arrives = arrivals.rows.some((b) => b.room_id === r.id);
    const problem = openProblems.find((p) => p.room_id === r.id);
    let status = 'clean';
    if (stay) status = 'occupied';
    else if (blocked) status = 'out_of_order';
    else if (r.housekeeping_status === 'dirty') status = 'dirty';
    return {
      id: r.id,
      label: r.label,
      unit_type_id: r.unit_type_id,
      type_name: r.type_name,
      status,
      arrives_today: arrives,
      leaves_today: !!(stay && stay.check_out <= today),
      problem: problem ? problem.title : null,
    };
  });

  return {
    ok: true,
    today,
    rooms,
    problems: problemsResult.rows,
    lost_items: lostResult.rows,
  };
}

// ------------------------------------------------------------
// ACTIONS
// ------------------------------------------------------------
export async function housekeepingAction(auth, body) {
  try {
    return await run(auth, body || {});
  } catch (err) {
    console.error('housekeepingAction', err);
    return fail(500, 'Server error');
  }
}

async function run(auth, body) {
  const tenantId = auth.tenant_id;
  const action = String(body.action || '');

  // ---- rooms ----
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

  // ---- problems (maintenance) ----
  if (action === 'report_problem') {
    const roomId = String(body.room_id || '').toLowerCase();
    if (!UUID_RE.test(roomId)) return fail(400, 'Please choose a room.');
    const title = String(body.title || '').trim().slice(0, 120);
    if (!title) return fail(400, 'Please write what is wrong.');
    const note = body.note ? String(body.note).trim().slice(0, 500) : null;
    const blocksRoom = body.blocks_room !== false;

    const room = await sql`
      select id, unit_type_id from rooms where id = ${roomId} and tenant_id = ${tenantId}
    `;
    if (room.rows.length === 0) return fail(404, 'That room was not found.');
    const today = await tenantToday(tenantId);
    const by = await whoIs(auth);

    let blockId = null;
    if (blocksRoom) {
      const literal = '{' + roomId + '}';
      const b = await sql`
        insert into availability_blocks (tenant_id, unit_type_id, room_ids, start_date, end_date, reason, source)
        values (${tenantId}, ${room.rows[0].unit_type_id}, ${literal}::uuid[], ${today}::date,
                ${addDays(today, BLOCK_DAYS)}::date, ${'Broken: ' + title}, 'maintenance')
        returning id
      `;
      blockId = b.rows[0].id;
    }
    try {
      await sql`
        insert into maintenance_requests (tenant_id, room_id, title, note, blocks_room, block_id, reported_by)
        values (${tenantId}, ${roomId}, ${title}, ${note}, ${blocksRoom}, ${blockId}, ${by})
      `;
    } catch (err) {
      if (blockId) {
        await sql`delete from availability_blocks where id = ${blockId} and tenant_id = ${tenantId}`;
      }
      throw err;
    }
    // Blocking does not cancel anything. Tell the owner if guests are booked
    // into this room so they can move them.
    const affected = await sql`
      select count(*)::int as n from bookings
      where tenant_id = ${tenantId} and room_id = ${roomId} and status = 'confirmed'
        and checked_out_at is null and check_out > ${today}::date
    `;
    return done({ affected_bookings: affected.rows[0].n });
  }

  if (action === 'mark_fixed' || action === 'delete_problem') {
    if (!UUID_RE.test(String(body.id || ''))) return fail(400, 'Please choose a valid problem.');
    const found = await sql`
      select id, status, block_id from maintenance_requests
      where id = ${body.id} and tenant_id = ${tenantId}
    `;
    if (found.rows.length === 0) return fail(404, 'That problem was not found.');
    const m = found.rows[0];
    if (action === 'mark_fixed' && m.status !== 'open') {
      return fail(400, 'This problem is already marked as fixed.');
    }
    // Free the room first, so a failure never leaves it blocked with the
    // problem shown as fixed.
    if (m.block_id && (action === 'delete_problem' ? m.status === 'open' : true)) {
      await sql`
        delete from availability_blocks
        where id = ${m.block_id} and tenant_id = ${tenantId} and source = 'maintenance'
      `;
    }
    if (action === 'mark_fixed') {
      const by = await whoIs(auth);
      await sql`
        update maintenance_requests set status = 'fixed', fixed_at = now(), fixed_by = ${by}
        where id = ${body.id} and tenant_id = ${tenantId}
      `;
    } else {
      await sql`delete from maintenance_requests where id = ${body.id} and tenant_id = ${tenantId}`;
    }
    return done({});
  }

  // ---- lost and found ----
  if (action === 'log_item') {
    const description = String(body.description || '').trim().slice(0, 200);
    if (!description) return fail(400, 'Please write what was found.');
    const foundWhere = body.found_where ? String(body.found_where).trim().slice(0, 120) : null;
    let roomId = null;
    if (body.room_id) {
      roomId = String(body.room_id).toLowerCase();
      if (!UUID_RE.test(roomId)) return fail(400, 'Please choose a valid room.');
      const own = await sql`select 1 from rooms where id = ${roomId} and tenant_id = ${tenantId}`;
      if (own.rows.length === 0) return fail(404, 'That room was not found.');
    }
    const today = await tenantToday(tenantId);
    let foundOn = today;
    if (body.found_on) {
      const d = String(body.found_on);
      if (!DATE_RE.test(d)) return fail(400, 'Dates must be in YYYY-MM-DD format');
      foundOn = d > today ? today : d;
    }
    const by = await whoIs(auth);
    await sql`
      insert into lost_items (tenant_id, description, found_where, room_id, found_on, logged_by)
      values (${tenantId}, ${description}, ${foundWhere}, ${roomId}, ${foundOn}::date, ${by})
    `;
    return done({});
  }

  if (action === 'resolve_item') {
    if (!UUID_RE.test(String(body.id || ''))) return fail(400, 'Please choose a valid item.');
    if (body.status !== 'returned' && body.status !== 'thrown_away') {
      return fail(400, 'Please choose returned or thrown away.');
    }
    const note = body.note ? String(body.note).trim().slice(0, 200) : null;
    const r = await sql`
      update lost_items set status = ${body.status}, resolved_note = ${note}, resolved_at = now()
      where id = ${body.id} and tenant_id = ${tenantId} and status = 'kept'
      returning id
    `;
    if (r.rows.length === 0) return fail(404, 'That item was not found, or it is already closed.');
    return done({});
  }

  if (action === 'reopen_item') {
    if (!UUID_RE.test(String(body.id || ''))) return fail(400, 'Please choose a valid item.');
    const r = await sql`
      update lost_items set status = 'kept', resolved_note = null, resolved_at = null
      where id = ${body.id} and tenant_id = ${tenantId} and status <> 'kept'
      returning id
    `;
    if (r.rows.length === 0) return fail(404, 'That item was not found, or it is already being kept.');
    return done({});
  }

  if (action === 'delete_item') {
    if (!UUID_RE.test(String(body.id || ''))) return fail(400, 'Please choose a valid item.');
    const r = await sql`
      delete from lost_items where id = ${body.id} and tenant_id = ${tenantId} returning id
    `;
    if (r.rows.length === 0) return fail(404, 'That item was not found.');
    return done({});
  }

  return fail(400, 'Unknown action');
}
