import { sql } from '@vercel/postgres';
import { setCors, getAuth, staffCannot } from './_lib/helpers.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { sendBookingConfirmedEmail, withTimeout } from './_lib/bookingemails.js';
import { frontDeskAction } from './_lib/frontdesk.js';

export default async function handler(req, res) {
  if (setCors(req, res, 'PATCH, OPTIONS')) return;
  if (req.method !== 'PATCH') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const auth = await getAuth(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  // Every change here (confirm, cancel, paid, archive, seen, room, note) needs
  // Bookings "edit" for staff.
  if (staffCannot(auth, res, 'bookings', 'edit')) return;

  // Front Desk actions (check in / out, folio, walk-in, room status).
  if (req.body && req.body.action) {
    const r = await frontDeskAction(auth, req.body);
    return res.status(r.status).json(r.json);
  }

  try {
    const { id, status, mark_paid, archived, seen, room_id, note } = req.body || {};
    const allowedStatus = ['pending', 'confirmed', 'cancelled'];

    if (!id) {
      return res.status(400).json({ ok: false, error: 'id is required' });
    }
    if (status !== undefined && !allowedStatus.includes(status)) {
      return res.status(400).json({ ok: false, error: 'status must be one of: ' + allowedStatus.join(', ') });
    }
    if (archived !== undefined && typeof archived !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'archived must be true or false' });
    }
    if (seen !== undefined && typeof seen !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'seen must be true or false' });
    }
    if (room_id !== undefined && !UUID_RE.test(String(room_id))) {
      return res.status(400).json({ ok: false, error: 'Please choose a valid room' });
    }
    if (note !== undefined && note !== null && typeof note !== 'string') {
      return res.status(400).json({ ok: false, error: 'note must be text' });
    }
    if (
      status === undefined &&
      !mark_paid &&
      archived === undefined &&
      seen === undefined &&
      room_id === undefined &&
      note === undefined
    ) {
      return res.status(400).json({ ok: false, error: 'Provide a status, mark_paid, archived, seen, room_id and/or note' });
    }

    // Move the booking to another room. Nothing is changed unless the room
    // is free for every night of the stay. The price is not recalculated.
    if (room_id !== undefined) {
      const cur = await sql`
        select status, check_in::text as check_in, check_out::text as check_out
        from bookings where id = ${id} and tenant_id = ${auth.tenant_id}
      `;
      if (cur.rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Booking not found' });
      }
      if (cur.rows[0].status === 'cancelled') {
        return res.status(400).json({ ok: false, error: "A cancelled booking can't be moved to a room." });
      }
      const room = await sql`
        select id, unit_type_id, is_active from rooms
        where id = ${room_id} and tenant_id = ${auth.tenant_id}
      `;
      if (room.rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'That room was not found.' });
      }
      if (room.rows[0].is_active === false) {
        return res.status(400).json({ ok: false, error: 'That room is turned off. Turn it on first or pick another room.' });
      }
      const clash = await sql`
        select 1 from bookings
        where tenant_id = ${auth.tenant_id} and room_id = ${room_id} and id <> ${id}
          and status <> 'cancelled'
          and check_in < ${cur.rows[0].check_out}::date and check_out > ${cur.rows[0].check_in}::date
        limit 1
      `;
      if (clash.rows.length > 0) {
        return res.status(409).json({ ok: false, error: 'That room already has a booking on some of these dates.' });
      }
      const blockClash = await sql`
        select 1 from availability_blocks
        where tenant_id = ${auth.tenant_id} and unit_type_id = ${room.rows[0].unit_type_id}
          and start_date <= (${cur.rows[0].check_out}::date - 1) and end_date >= ${cur.rows[0].check_in}::date
          and (room_ids is null or ${room_id}::text = any(room_ids::text[]))
        limit 1
      `;
      if (blockClash.rows.length > 0) {
        return res.status(409).json({ ok: false, error: 'That room is blocked on some of these dates.' });
      }
      await sql`
        update bookings set room_id = ${room_id}, unit_type_id = ${room.rows[0].unit_type_id}
        where id = ${id} and tenant_id = ${auth.tenant_id}
      `;
    }

    // Private note for the resort team. Guests never see it.
    if (note !== undefined) {
      const cleanNote = note === null ? null : String(note).trim().slice(0, 2000) || null;
      const noteResult = await sql`
        update bookings set owner_note = ${cleanNote}
        where id = ${id} and tenant_id = ${auth.tenant_id}
        returning id
      `;
      if (noteResult.rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Booking not found' });
      }
    }

    // Status/payment updates first (unchanged logic), archiving is a separate
    // flag so it never overwrites or is overwritten by status/payment state.
    let result;
    if (status !== undefined && mark_paid) {
      result = await sql`
        update bookings set
          status = ${status},
          payment_status = 'paid',
          payment_confirmed_at = now()
        where id = ${id} and tenant_id = ${auth.tenant_id}
        returning id
      `;
    } else if (status !== undefined) {
      result = await sql`
        update bookings set status = ${status}
        where id = ${id} and tenant_id = ${auth.tenant_id}
        returning id
      `;
    } else if (mark_paid) {
      result = await sql`
        update bookings set
          payment_status = 'paid',
          payment_confirmed_at = now()
        where id = ${id} and tenant_id = ${auth.tenant_id}
        returning id
      `;
    }

    if ((status !== undefined || mark_paid) && result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Booking not found' });
    }

    if (archived !== undefined) {
      const archiveResult = await sql`
        update bookings set is_archived = ${archived}
        where id = ${id} and tenant_id = ${auth.tenant_id}
        returning id
      `;
      if (archiveResult.rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Booking not found' });
      }
    }

    // "Seen" is its own flag too: it records that the owner has looked at a
    // booking and never touches status, payment or archive state.
    if (seen !== undefined) {
      const seenResult = seen
        ? await sql`
            update bookings set seen_at = coalesce(seen_at, now())
            where id = ${id} and tenant_id = ${auth.tenant_id}
            returning id
          `
        : await sql`
            update bookings set seen_at = null
            where id = ${id} and tenant_id = ${auth.tenant_id}
            returning id
          `;
      if (seenResult.rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Booking not found' });
      }
    }

    const final = await sql`
      select * from bookings
      where id = ${id} and tenant_id = ${auth.tenant_id}
    `;
    if (final.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Booking not found' });
    }

    // Email the guest their confirmation once, when the owner confirms the
    // booking OR marks it as paid. sendBookingConfirmedEmail only sends for a
    // confirmed booking and never twice (confirmed_email_sent_at). Best effort:
    // never fails the update, and waits only a few seconds.
    let guestEmailed = false;
    if (status === 'confirmed' || mark_paid) {
      guestEmailed = (await withTimeout(sendBookingConfirmedEmail(auth.tenant_id, id))) === true;
    }

    return res.status(200).json({ ok: true, booking: final.rows[0], guest_emailed: guestEmailed });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
