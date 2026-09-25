import { sql } from '@vercel/postgres';
import { setCors, text, isBookableStatus } from './_lib/helpers.js';

export default async function handler(req, res) {
  if (setCors(req, res, 'GET, OPTIONS')) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const slug = text(req.query && req.query.slug);
    if (!slug) {
      return res.status(400).json({ ok: false, error: 'slug is required' });
    }

    const t = await sql`
      SELECT id, name, currency, status FROM tenants
      WHERE LOWER(slug) = ${slug.toLowerCase()}
    `;
    if (t.rows.length === 0 || !isBookableStatus(t.rows[0].status)) {
      return res.status(404).json({ ok: false, error: 'Resort not found' });
    }
    const tenant = t.rows[0];

    const s = await sql`
      SELECT primary_color, logo_url,
             checkin_time::text AS checkin_time, checkout_time::text AS checkout_time,
             cancellation_policy, vat_percent, min_stay_nights, booking_window_days,
             theme
      FROM tenant_settings WHERE tenant_id = ${tenant.id}
    `;
    const settings = s.rows[0] || {};

    const units = await sql`
      SELECT id, name, description, capacity_guests, base_rate
      FROM unit_types
      WHERE tenant_id = ${tenant.id} AND is_active = true
      ORDER BY display_order, created_at
    `;
    const addons = await sql`
      SELECT id, name, price FROM addons
      WHERE tenant_id = ${tenant.id} AND is_active = true
      ORDER BY name
    `;

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      tenant: { id: tenant.id, name: tenant.name, currency: tenant.currency },
      settings: {
        primary_color: settings.primary_color || null,
        logo_url: settings.logo_url || null,
        checkin_time: settings.checkin_time ? String(settings.checkin_time).slice(0, 5) : '14:00',
        checkout_time: settings.checkout_time ? String(settings.checkout_time).slice(0, 5) : '12:00',
        cancellation_policy: settings.cancellation_policy || null,
        vat_percent: settings.vat_percent !== undefined && settings.vat_percent !== null ? Number(settings.vat_percent) : 12,
        min_stay_nights: settings.min_stay_nights || 1,
        booking_window_days: settings.booking_window_days || 365,
        theme: settings.theme || null,
      },
      unit_types: units.rows,
      addons: addons.rows,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
