import { sql } from '@vercel/postgres';
import { decryptText } from './crypto.js';

// Guest records (CRM): one profile per guest across stays.
// Lives in _lib so it adds no serverless function (Vercel Hobby cap is 12).
// bookings.js serves the reads (?resource=guests / guest) and
// booking-update.js runs the actions (PATCH with a "guest_..." action).
// Permission checks (Bookings view / edit) happen in those two files first.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const GUEST_ACTIONS = [
  'guest_create',
  'guest_update',
  'guest_blacklist',
  'guest_merge',
  'guest_delete',
];

function fail(status, error, extra) {
  return { status, json: { ok: false, error, ...(extra || {}) } };
}

function done(json) {
  return { status: 200, json: { ok: true, ...(json || {}) } };
}

export function normEmail(v) {
  return String(v === undefined || v === null ? '' : v).trim().toLowerCase().slice(0, 200);
}

// Last 10 digits of a phone number, so 0917 123 4567 and +63 917 123 4567
// match. Numbers with fewer than 7 digits are too short to match on.
export function phoneKey(v) {
  const digits = String(v === undefined || v === null ? '' : v).replace(/[^0-9]/g, '');
  if (digits.length < 7) return '';
  return digits.slice(-10);
}

function cleanName(v) {
  return String(v === undefined || v === null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, 120);
}

function cleanPhone(v) {
  const s = String(v === undefined || v === null ? '' : v).trim().slice(0, 40);
  return s || null;
}

// ------------------------------------------------------------
// MATCHING
// ------------------------------------------------------------
// Finds the guest profile for a booking, or creates one. Matching rules:
//   - with an email: the profile with that email (case-insensitive)
//   - without an email: a profile with the same phone number
//   - a name only: always a new profile
// Returns { id, is_blacklisted } or null. Never throws: a problem here must
// never stop a booking from being saved.
export async function linkGuest(tenantId, info) {
  try {
    const name = cleanName(info && info.name) || 'Guest';
    const email = normEmail(info && info.email);
    const phone = cleanPhone(info && info.phone);
    const pk = phoneKey(phone);

    let found = null;
    if (email) {
      const r = await sql`
        select id, is_blacklisted, phone from guests
        where tenant_id = ${tenantId} and email = ${email} limit 1
      `;
      found = r.rows[0] || null;
    } else if (pk) {
      const r = await sql`
        select id, is_blacklisted, phone from guests
        where tenant_id = ${tenantId} and phone_key = ${pk}
        order by created_at limit 1
      `;
      found = r.rows[0] || null;
    }

    if (found) {
      // Fill in a phone number the profile did not have yet.
      if (!found.phone && phone) {
        await sql`
          update guests set phone = ${phone}, phone_key = ${pk}, updated_at = now()
          where id = ${found.id} and tenant_id = ${tenantId}
        `;
      }
      return { id: found.id, is_blacklisted: found.is_blacklisted === true };
    }

    try {
      const ins = await sql`
        insert into guests (tenant_id, name, email, phone, phone_key)
        values (${tenantId}, ${name}, ${email}, ${phone}, ${pk})
        returning id, is_blacklisted
      `;
      return { id: ins.rows[0].id, is_blacklisted: false };
    } catch (raceErr) {
      // Two bookings for the same new email at the same moment: use the winner.
      if (email) {
        const r = await sql`
          select id, is_blacklisted from guests
          where tenant_id = ${tenantId} and email = ${email} limit 1
        `;
        if (r.rows[0]) return { id: r.rows[0].id, is_blacklisted: r.rows[0].is_blacklisted === true };
      }
      throw raceErr;
    }
  } catch (err) {
    console.error('linkGuest', err && err.message);
    return null;
  }
}

// Links a freshly saved booking to its guest profile. Best effort.
export async function attachGuestToBooking(tenantId, bookingId, info) {
  const g = await linkGuest(tenantId, info);
  if (!g) return null;
  try {
    await sql`
      update bookings set guest_id = ${g.id}
      where id = ${bookingId} and tenant_id = ${tenantId}
    `;
  } catch (err) {
    console.error('attachGuestToBooking', err && err.message);
    return null;
  }
  return g;
}

// ------------------------------------------------------------
// READS
// ------------------------------------------------------------
// "Stays" are confirmed bookings that were not marked as no-shows.
export async function listGuests(tenantId) {
  const r = await sql`
    select g.id, g.name, g.email, g.phone, g.is_blacklisted, g.blacklist_reason,
           (g.notes is not null and g.notes <> '') as has_notes,
           coalesce(s.stays, 0)::int as stays,
           s.first_stay, s.last_stay,
           coalesce(s.total_booked, 0) as total_booked,
           coalesce(s.upcoming, 0)::int as upcoming
    from guests g
    left join lateral (
      select count(*) filter (where b.status = 'confirmed' and b.no_show_at is null) as stays,
             min(b.check_in) filter (where b.status = 'confirmed' and b.no_show_at is null)::text as first_stay,
             max(b.check_out) filter (where b.status = 'confirmed' and b.no_show_at is null)::text as last_stay,
             sum(b.total_amount) filter (where b.status = 'confirmed' and b.no_show_at is null) as total_booked,
             count(*) filter (where b.status = 'confirmed' and b.no_show_at is null
                              and b.checked_out_at is null and b.check_out >= current_date) as upcoming
      from bookings b where b.guest_id = g.id and b.tenant_id = g.tenant_id
    ) s on true
    where g.tenant_id = ${tenantId}
    order by s.last_stay desc nulls last, lower(g.name)
    limit 2000
  `;
  return { ok: true, guests: r.rows };
}

export async function getGuest(tenantId, guestId) {
  if (!UUID_RE.test(String(guestId || ''))) return fail(400, 'A valid guest is required');
  const g = await sql`
    select id, name, email, phone, notes, preferences, is_blacklisted, blacklist_reason,
           blacklisted_at, created_at
    from guests where id = ${guestId} and tenant_id = ${tenantId}
  `;
  if (g.rows.length === 0) return fail(404, 'Guest not found');
  const stays = await sql`
    select b.id, b.check_in::text as check_in, b.check_out::text as check_out, b.nights, b.guests,
           b.status, b.payment_status, b.total_amount, b.source,
           b.checked_in_at, b.checked_out_at, b.no_show_at, b.owner_note, b.special_requests,
           b.guest_id_type, b.guest_id_number,
           ut.name as type_name, r.label as room_label
    from bookings b
    left join unit_types ut on ut.id = b.unit_type_id
    left join rooms r on r.id = b.room_id
    where b.guest_id = ${guestId} and b.tenant_id = ${tenantId}
    order by b.check_in desc
    limit 500
  `;
  // ID numbers are stored encrypted; show them as plain text to the signed-in team.
  const staysOut = stays.rows.map((s) => (s.guest_id_number ? { ...s, guest_id_number: decryptText(s.guest_id_number) } : s));
  return done({ guest: g.rows[0], bookings: staysOut });
}

// Extra guest facts for a set of booking rows (Front Desk cards and the
// Bookings list): is the guest a repeat guest, are they on the blacklist, and
// what ID did they show last time. `rows` need id, guest_id, check_in.
// Returns the same rows with guest_* fields added. Never throws: if the guest
// tables are not there yet the rows come back unchanged.
export async function addGuestInfo(tenantId, rows) {
  try {
    const ids = [...new Set(rows.map((r) => r.guest_id).filter(Boolean).map(String))];
    if (ids.length === 0) return rows;
    const json = JSON.stringify(ids);
    const gr = await sql`
      select id::text as id, is_blacklisted, blacklist_reason, notes, preferences
      from guests
      where tenant_id = ${tenantId}
        and id::text in (select jsonb_array_elements_text(${json}::jsonb))
    `;
    const br = await sql`
      select id::text as id, guest_id::text as guest_id, check_in::text as check_in,
             guest_id_type, guest_id_number
      from bookings
      where tenant_id = ${tenantId} and status = 'confirmed' and no_show_at is null
        and guest_id::text in (select jsonb_array_elements_text(${json}::jsonb))
    `;
    const byGuest = new Map(gr.rows.map((g) => [g.id, g]));
    return rows.map((row) => {
      const g = row.guest_id ? byGuest.get(String(row.guest_id)) : null;
      if (!g) return row;
      const mine = br.rows.filter((b) => b.guest_id === String(row.guest_id) && b.id !== String(row.id));
      const earlier = mine.filter((b) => b.check_in < String(row.check_in));
      const withId = mine
        .filter((b) => b.guest_id_number)
        .sort((a, b) => (a.check_in < b.check_in ? 1 : -1))[0];
      return {
        ...row,
        guest_blacklisted: g.is_blacklisted === true,
        guest_blacklist_reason: g.blacklist_reason || null,
        guest_notes: g.notes || null,
        guest_preferences: g.preferences || null,
        guest_other_stays: mine.length,
        guest_earlier_stays: earlier.length,
        guest_last_id_type: withId ? withId.guest_id_type : null,
        guest_last_id_number: withId ? decryptText(withId.guest_id_number) : null,
      };
    });
  } catch (err) {
    console.error('addGuestInfo', err && err.message);
    return rows;
  }
}

// ------------------------------------------------------------
// ACTIONS
// ------------------------------------------------------------
export async function guestAction(auth, body) {
  try {
    return await run(auth, body || {});
  } catch (err) {
    console.error('guestAction', err);
    return fail(500, 'Server error');
  }
}

async function run(auth, body) {
  const tenantId = auth.tenant_id;
  const action = String(body.action || '');

  if (action === 'guest_create') {
    const name = cleanName(body.name);
    if (!name) return fail(400, "Please enter the guest's name.");
    const email = normEmail(body.email);
    if (email && !EMAIL_RE.test(email)) return fail(400, 'That email address does not look right.');
    const phone = cleanPhone(body.phone);
    if (email) {
      const dupe = await sql`select id from guests where tenant_id = ${tenantId} and email = ${email}`;
      if (dupe.rows.length > 0) {
        return fail(409, 'A guest with this email already exists.', { existing_id: dupe.rows[0].id });
      }
    }
    const ins = await sql`
      insert into guests (tenant_id, name, email, phone, phone_key)
      values (${tenantId}, ${name}, ${email}, ${phone}, ${phoneKey(phone)})
      returning id
    `;
    return done({ id: ins.rows[0].id });
  }

  const id = body.id;
  if (!id || !UUID_RE.test(String(id))) return fail(400, 'A valid guest is required');
  const cur = await sql`select * from guests where id = ${id} and tenant_id = ${tenantId}`;
  if (cur.rows.length === 0) return fail(404, 'Guest not found');
  const guest = cur.rows[0];

  if (action === 'guest_update') {
    const name = body.name !== undefined ? cleanName(body.name) : guest.name;
    if (!name) return fail(400, "Please enter the guest's name.");
    let email = guest.email;
    if (body.email !== undefined) {
      email = normEmail(body.email);
      if (email && !EMAIL_RE.test(email)) return fail(400, 'That email address does not look right.');
      if (email && email !== guest.email) {
        const dupe = await sql`
          select id from guests where tenant_id = ${tenantId} and email = ${email} and id <> ${id}
        `;
        if (dupe.rows.length > 0) {
          return fail(409, 'Another guest profile already uses this email. Use "Merge with another guest" instead.', {
            existing_id: dupe.rows[0].id,
          });
        }
      }
    }
    const phone = body.phone !== undefined ? cleanPhone(body.phone) : guest.phone;
    const notes =
      body.notes !== undefined ? String(body.notes || '').replace(/\u0000/g, '').trim().slice(0, 4000) || null : guest.notes;
    const prefs =
      body.preferences !== undefined
        ? String(body.preferences || '').replace(/\u0000/g, '').trim().slice(0, 1000) || null
        : guest.preferences;
    await sql`
      update guests set name = ${name}, email = ${email}, phone = ${phone}, phone_key = ${phoneKey(phone)},
        notes = ${notes}, preferences = ${prefs}, updated_at = now()
      where id = ${id} and tenant_id = ${tenantId}
    `;
    return done({});
  }

  if (action === 'guest_blacklist') {
    if (typeof body.blacklisted !== 'boolean') return fail(400, 'blacklisted must be true or false');
    if (body.blacklisted) {
      const reason = String(body.reason || '').replace(/\u0000/g, '').trim().slice(0, 300);
      if (!reason) return fail(400, 'Please write the reason, so your team knows why.');
      await sql`
        update guests set is_blacklisted = true, blacklist_reason = ${reason},
          blacklisted_at = now(), updated_at = now()
        where id = ${id} and tenant_id = ${tenantId}
      `;
    } else {
      await sql`
        update guests set is_blacklisted = false, blacklist_reason = null,
          blacklisted_at = null, updated_at = now()
        where id = ${id} and tenant_id = ${tenantId}
      `;
    }
    return done({});
  }

  if (action === 'guest_merge') {
    // Merges the profile in "id" INTO the profile in "into_id", then removes "id".
    const intoId = body.into_id;
    if (!intoId || !UUID_RE.test(String(intoId))) return fail(400, 'Please choose the guest to merge into.');
    if (String(intoId) === String(id)) return fail(400, 'Please choose a different guest.');
    const tgt = await sql`select * from guests where id = ${intoId} and tenant_id = ${tenantId}`;
    if (tgt.rows.length === 0) return fail(404, 'The other guest was not found.');
    const t = tgt.rows[0];

    const notes =
      [t.notes, guest.notes].filter((n) => n && String(n).trim()).join('\n\n').slice(0, 4000) || null;
    const prefs = t.preferences || guest.preferences || null;
    const blacklisted = t.is_blacklisted === true || guest.is_blacklisted === true;
    const reason = t.is_blacklisted ? t.blacklist_reason : guest.is_blacklisted ? guest.blacklist_reason : null;
    const email = t.email || guest.email || '';
    const phone = t.phone || guest.phone || null;

    await sql`update bookings set guest_id = ${intoId} where guest_id = ${id} and tenant_id = ${tenantId}`;
    await sql`delete from guests where id = ${id} and tenant_id = ${tenantId}`;
    await sql`
      update guests set email = ${email}, phone = ${phone}, phone_key = ${phoneKey(phone)},
        notes = ${notes}, preferences = ${prefs}, is_blacklisted = ${blacklisted},
        blacklist_reason = ${reason},
        blacklisted_at = case when ${blacklisted} then coalesce(blacklisted_at, now()) else null end,
        updated_at = now()
      where id = ${intoId} and tenant_id = ${tenantId}
    `;
    return done({ id: intoId });
  }

  if (action === 'guest_delete') {
    const used = await sql`
      select 1 from bookings where guest_id = ${id} and tenant_id = ${tenantId} limit 1
    `;
    if (used.rows.length > 0) {
      return fail(409, 'This guest has bookings, so the profile cannot be removed. You can merge it into another profile instead.');
    }
    await sql`delete from guests where id = ${id} and tenant_id = ${tenantId}`;
    return done({});
  }

  return fail(400, 'Unknown action');
}
