import { sql } from '@vercel/postgres';
import { setCors, getAuth } from './_lib/helpers.js';
import { computeQuote } from './_lib/pricing.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAYMENT_CHANNEL_KEYS = ['paymongo', 'bank_transfer', 'gcash', 'maya', 'qr_code'];

export default async function handler(req, res) {
  if (setCors(req, res, 'GET, POST, OPTIONS')) return;

  if (req.method === 'GET') {
    const auth = getAuth(req);
    if (!auth) {
      return res.status(401).json({ ok: false, error: 'Missing or invalid authorization token' });
    }
    try {
      const result = await sql`
        SELECT * FROM bookings WHERE tenant_id = ${auth.tenant_id}
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
    const payment_channel = b.payment_channel ? String(b.payment_channel).trim() : null;
    const payment_reference = b.payment_reference ? String(b.payment_reference).trim().slice(0, 200) : null;

    if (!b.tenant_id || !b.unit_type_id || !guest_name || !guest_email || !b.check_in || !b.check_out) {
      return res.status(400).json({
        ok: false,
        error: 'tenant_id, unit_type_id, guest_name, guest_email, check_in, check_out are required',
      });
    }
    if (!EMAIL_RE.test(guest_email)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid email address' });
    }
    if (!payment_channel || !PAYMENT_CHANNEL_KEYS.includes(payment_channel)) {
      return res.status(400).json({
        ok: false,
        error: `payment_channel is required and must be one of: ${PAYMENT_CHANNEL_KEYS.join(', ')}`,
      });
    }

    try {
      // Confirm the tenant actually has this channel enabled before accepting the booking.
      const settingsResult = await sql`
        SELECT payment_channels FROM tenant_settings WHERE tenant_id = ${b.tenant_id}
      `;
      const channels = settingsResult.rows[0] ? settingsResult.rows[0].payment_channels : null;
      const channelConfig = channels ? channels[payment_channel] : null;
      if (!channelConfig || channelConfig.enabled !== true) {
        return res.status(400).json({ ok: false, error: 'That payment method is not available for this resort' });
      }

      const q = await computeQuote(b);
      if (!q.ok) {
        return res.status(q.status).json({ ok: false, error: q.error });
      }

      const result = await sql`
        INSERT INTO bookings (
          tenant_id, unit_type_id, room_id, guest_name, guest_email, guest_phone,
          check_in, check_out, guests, special_requests, base_amount, addons_amount,
          vat_amount, discount_amount, total_amount, promo_code_id,
          payment_channel, payment_reference
        )
        VALUES (
          ${q.tenant_id}, ${q.unit_type_id}, ${q.room_id}, ${guest_name}, ${guest_email}, ${guest_phone},
          ${q.check_in}, ${q.check_out}, ${q.guests}, ${special_requests}, ${q.base_amount}, ${q.addons_amount},
          ${q.vat_amount}, ${q.discount_amount}, ${q.total_amount}, ${q.promo_code_id},
          ${payment_channel}, ${payment_reference}
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
