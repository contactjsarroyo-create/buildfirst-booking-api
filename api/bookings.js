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
      // Look up the unit type's base rate and how many physical units exist
      const unitTypeResult = await sql`
        SELECT base_rate, unit_count FROM unit_types
        WHERE id = ${unit_type_id} AND tenant_id = ${tenant_id}
      `;

      if (unitTypeResult.rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'unit_type not found for this tenant' });
      }

      const baseRate = Number(unitTypeResult.rows[0].base_rate);
      const unitCount = Number(unitTypeResult.rows[0].unit_count);

      const nights = Math.ceil(
        (new Date(check_out) - new Date(check_in)) / (1000 * 60 * 60 * 24)
      );

      if (nights <= 0) {
        return res.status(400).json({ ok: false, error: 'check_out must be after check_in' });
      }

      // Count existing confirmed bookings for this unit type that overlap the requested dates.
      // Overlap rule: existing.check_in < new.check_out AND existing.check_out > new.check_in
      const overlappingBookings = await sql`
        SELECT COUNT(*) FROM bookings
        WHERE unit_type_id = ${unit_type_id}
          AND tenant_id = ${tenant_id}
          AND status = 'confirmed'
          AND check_in < ${check_out}
          AND check_out > ${check_in}
      `;

      // Count any manual/OTA availability blocks that overlap the requested dates
      const overlappingBlocks = await sql`
        SELECT COUNT(*) FROM availability_blocks
        WHERE unit_type_id = ${unit_type_id}
          AND tenant_id = ${tenant_id}
          AND start_date < ${check_out}
          AND end_date > ${check_in}
      `;

      const bookedCount = Number(overlappingBookings.rows[0].count);
      const blockedCount = Number(overlappingBlocks.rows[0].count);

      if (blockedCount > 0) {
        return res.status(409).json({
          ok: false,
          error: 'These dates are blocked for this room type',
        });
      }

      if (bookedCount >= unitCount) {
        return res.status(409).json({
          ok: false,
          error: 'No rooms of this type are available for the selected dates',
        });
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