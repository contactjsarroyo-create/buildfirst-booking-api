import { sql } from '@vercel/postgres';
import jwt from 'jsonwebtoken';
import { computeQuote } from './_lib/pricing.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
      console.error(err);
      return res.status(500).json({ ok: false, error: 'Server error' });
    }
  }

  if (req.method === 'POST') {
    // POST stays open with no login required - this is the public guest-facing
    // booking widget, not the dashboard. tenant_id comes from the widget's config.
    const b = req.body || {};
    const guest_name = String(b.guest_name || '').trim().slice(0, 120);
    const guest_email = String(b.guest_email || '').trim().slice(0, 200);
    const guest_phone = b.guest_phone ? String(b.guest_phone).trim().slice(0, 40) : null;
    const special_requests = b.special_requests ? String(b.special_requests).trim().slice(0, 1000) : null;

    if (!b.tenant_id || !b.unit_type_id || !guest_name || !guest_email || !b.check_in || !b.check_out) {
      return res.status(400).json({
        ok: false,
        error: 'tenant_id, unit_type_id, guest_name, guest_email, check_in, check_out are required',
      });
    }
    if (!EMAIL_RE.test(guest_email)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid email address' });
    }

    try {
      const q = await computeQuote(b);
      if (!q.ok) {
        return res.status(q.status).json({ ok: false, error: q.error });
      }

      const result = await sql`
        INSERT INTO bookings (
          tenant_id, unit_type_id, guest_name, guest_email, guest_phone,
          check_in, check_out, guests, special_requests, base_amount, addons_amount,
          vat_amount, discount_amount, total_amount, promo_code_id
        )
        VALUES (
          ${q.tenant_id}, ${q.unit_type_id}, ${guest_name}, ${guest_email}, ${guest_phone},
          ${q.check_in}, ${q.check_out}, ${q.guests}, ${special_requests}, ${q.base_amount}, ${q.addons_amount},
          ${q.vat_amount}, ${q.discount_amount}, ${q.total_amount}, ${q.promo_code_id}
        )
        RETURNING *
      `;
      const booking = result.rows[0];

      for (const addon of q.valid_addons) {
        await sql`
          INSERT INTO booking_addons (booking_id, addon_id, quantity, price_at_booking)
          VALUES (${booking.id}, ${addon.id}, 1, ${addon.price})
        `;
      }

      if (q.promo_code_id) {
        await sql`
          UPDATE promo_codes SET times_used = times_used + 1 WHERE id = ${q.promo_code_id}
        `;
      }

      return res.status(201).json({ ok: true, booking });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ ok: false, error: 'Server error' });
    }
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
