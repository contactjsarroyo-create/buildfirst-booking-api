import { sql } from '@vercel/postgres';

export default async function handler(req, res) {
  const { tenant_id } = req.query;

  if (!tenant_id) {
    return res.status(400).json({ ok: false, error: 'tenant_id is required' });
  }

  try {
    const result = await sql`
      SELECT * FROM bookings WHERE tenant_id = ${tenant_id}
    `;
    res.status(200).json({ ok: true, bookings: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
