import { sql } from '@vercel/postgres';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const { tenant_id } = req.query;
    if (!tenant_id) {
      return res.status(400).json({ ok: false, error: 'tenant_id is required' });
    }
    try {
      const result = await sql`
        SELECT * FROM bookings WHERE tenant_id = ${tenant_id}
      `;
      return res.status(200).json({ ok: true, bookings: result.rows });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  if (req.method === 'POST') {
    const {
      tenant_id,
      unit_type_id,
      guest_name,
      guest_email,
      guest_phone,
      check_in,
      check_out,
      guests,
    } = req.body || {};

    if (!tenant_id || !unit_type_id || !guest_name || !guest_email || !check_in || !check_out) {
      return res.status(400).json({
        ok: false,
        error: 'tenant_id, unit_type_id, guest_name, guest_email, check_in, check_out are required',
      });
    }

    try {
      // Look up the unit type's base rate (server-side, never trust a client-sent price)
      const unitTypeResult = await sql`
        SELECT base_rate FROM unit_types
        WHERE id = ${unit_type_id} AND tenant_id = ${tenant_id}
      `;

      if (unitTypeResult.rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'unit_type not found for this tenant' });
      }

      const baseRate = Number(unitTypeResult.rows[0].base_rate);
      const nights = Math.ceil(
        (new Date(check_out) - new Date(check_in)) / (1000 * 60 * 60 * 24)
      );

      if (nights <= 0) {
        return res.status(400).json({ ok: false, error: 'check_out must be after check_in' });
      }

      const baseAmount = baseRate * nights;
      const totalAmount = baseAmount; // add addons/vat/discount later

      const result = await sql`
        INSERT INTO bookings (
          tenant_id, unit_type_id, guest_name, guest_email, guest_phone,
          check_in, check_out, guests, base_amount, total_amount
        )
        VALUES (
          ${tenant_id}, ${unit_type_id}, ${guest_name}, ${guest_email}, ${guest_phone || null},
          ${check_in}, ${check_out}, ${guests || 1}, ${baseAmount}, ${totalAmount}
        )
        RETURNING *
      `;

      return res.status(201).json({ ok: true, booking: result.rows[0] });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}