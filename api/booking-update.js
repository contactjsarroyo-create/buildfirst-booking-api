import { sql } from '@vercel/postgres';
import { setCors, getAuth } from './_lib/helpers.js';

export default async function handler(req, res) {
  if (setCors(req, res, 'PATCH, OPTIONS')) return;
  if (req.method !== 'PATCH') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  try {
    const { id, status, mark_paid, archived } = req.body || {};
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
    if (status === undefined && !mark_paid && archived === undefined) {
      return res.status(400).json({ ok: false, error: 'Provide a status, mark_paid, and/or archived' });
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

    const final = await sql`
      select id, status, payment_status, payment_confirmed_at, is_archived
      from bookings
      where id = ${id} and tenant_id = ${auth.tenant_id}
    `;
    if (final.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Booking not found' });
    }
    return res.status(200).json({ ok: true, booking: final.rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
