import { sql } from '@vercel/postgres';
import jwt from 'jsonwebtoken';

function getTenantIdFromAuth(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return payload.tenant_id;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    const tenant_id = getTenantIdFromAuth(req);
    if (!tenant_id) {
      return res.status(401).json({ ok: false, error: 'Missing or invalid authorization token' });
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
    // POST stays open with no login required — this is the public guest-facing
    // booking widget, not the dashboard. tenant_id comes from the widget's embed config.
    const {
      tenant_id,
      unit_type_id,
      guest_name,
      guest_email,
      guest_phone,
      check_in,
      check_out,
      guests,
      addon_ids,
      promo_code,
    } = req.body || {};

    if (!tenant_id || !unit_type_id || !guest_name || !guest_email || !check_in || !check_out) {
      return res.status(400).json({
        ok: false,
        error: 'tenant_id, unit_type_id, guest_name, guest_email, check_in, check_out are required',
      });
    }

    try {
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

      const overlappingBookings = await sql`
        SELECT COUNT(*) FROM bookings
        WHERE unit_type_id = ${unit_type_id}
          AND tenant_id = ${tenant_id}
          AND status = 'confirmed'
          AND check_in < ${check_out}
          AND check_out > ${check_in}
      `;
      const overlappingBlocks = await sql`
        SELECT COUNT(*) FROM availability_blocks
        WHERE unit_type_id = ${unit_type_id}
          AND tenant_id = ${tenant_id}
          AND start_date < ${check_out}
          AND end_date > ${check_in}
      `;
      if (Number(overlappingBlocks.rows[0].count) > 0) {
        return res.status(409).json({ ok: false, error: 'These dates are blocked for this room type' });
      }
      if (Number(overlappingBookings.rows[0].count) >= unitCount) {
        return res.status(409).json({ ok: false, error: 'No rooms of this type are available for the selected dates' });
      }

      let addonsAmount = 0;
      const validAddons = [];
      if (Array.isArray(addon_ids) && addon_ids.length > 0) {
        const addonsResult = await sql`
          SELECT id, price FROM addons
          WHERE tenant_id = ${tenant_id} AND id = ANY(${addon_ids}) AND is_active = true
        `;
        for (const row of addonsResult.rows) {
          const price = Number(row.price);
          addonsAmount += price;
          validAddons.push({ id: row.id, price });
        }
        if (validAddons.length !== addon_ids.length) {
          return res.status(400).json({ ok: false, error: 'One or more addon_ids are invalid or inactive' });
        }
      }

      const baseAmount = baseRate * nights;
      const preDiscountSubtotal = baseAmount + addonsAmount;

      let discountAmount = 0;
      let promoCodeId = null;
      if (promo_code) {
        const promoResult = await sql`
          SELECT id, discount_percent, discount_amount, valid_from, valid_to, max_uses, times_used, is_active
          FROM promo_codes
          WHERE tenant_id = ${tenant_id} AND code = ${promo_code}
        `;
        if (promoResult.rows.length === 0) {
          return res.status(400).json({ ok: false, error: 'Invalid promo code' });
        }
        const promo = promoResult.rows[0];
        const today = new Date().toISOString().slice(0, 10);

        if (!promo.is_active) {
          return res.status(400).json({ ok: false, error: 'This promo code is no longer active' });
        }
        if (promo.valid_from && today < promo.valid_from) {
          return res.status(400).json({ ok: false, error: 'This promo code is not yet valid' });
        }
        if (promo.valid_to && today > promo.valid_to) {
          return res.status(400).json({ ok: false, error: 'This promo code has expired' });
        }
        if (promo.max_uses !== null && promo.times_used >= promo.max_uses) {
          return res.status(400).json({ ok: false, error: 'This promo code has reached its usage limit' });
        }

        if (promo.discount_percent) {
          discountAmount = preDiscountSubtotal * (Number(promo.discount_percent) / 100);
        } else if (promo.discount_amount) {
          discountAmount = Number(promo.discount_amount);
        }
        promoCodeId = promo.id;
      }

      const settingsResult = await sql`
        SELECT vat_percent FROM tenant_settings WHERE tenant_id = ${tenant_id}
      `;
      const vatPercent = settingsResult.rows.length > 0
        ? Number(settingsResult.rows[0].vat_percent)
        : 12.00;

      const taxableAmount = preDiscountSubtotal - discountAmount;
      const vatAmount = taxableAmount * (vatPercent / 100);
      const totalAmount = taxableAmount + vatAmount;

      const result = await sql`
        INSERT INTO bookings (
          tenant_id, unit_type_id, guest_name, guest_email, guest_phone,
          check_in, check_out, guests, base_amount, addons_amount,
          vat_amount, discount_amount, total_amount, promo_code_id
        )
        VALUES (
          ${tenant_id}, ${unit_type_id}, ${guest_name}, ${guest_email}, ${guest_phone || null},
          ${check_in}, ${check_out}, ${guests || 1}, ${baseAmount}, ${addonsAmount},
          ${vatAmount}, ${discountAmount}, ${totalAmount}, ${promoCodeId}
        )
        RETURNING *
      `;
      const booking = result.rows[0];

      for (const addon of validAddons) {
        await sql`
          INSERT INTO booking_addons (booking_id, addon_id, quantity, price_at_booking)
          VALUES (${booking.id}, ${addon.id}, 1, ${addon.price})
        `;
      }

      if (promoCodeId) {
        await sql`
          UPDATE promo_codes SET times_used = times_used + 1 WHERE id = ${promoCodeId}
        `;
      }

      return res.status(201).json({ ok: true, booking });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
