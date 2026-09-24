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
    const { id, status } = req.body || {};
    const allowed = ['pending', 'confirmed', 'cancelled'];
    if (!id || !allowed.includes(status)) {
      return res.status(400).json({ ok: false, error: 'id and a valid status are required' });
    }

    const result = await sql`
      update bookings set status = ${status}
      where id = ${id} and tenant_id = ${auth.tenant_id}
      returning id, status
    `;
    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Booking not found' });
    }
    return res.status(200).json({ ok: true, booking: result.rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
