import { sql } from '@vercel/postgres';
import { setCors, text, isBookableStatus } from './_lib/helpers.js';

// Matches the shape in settings.js's CHANNEL_FIELDS — keep them in sync if either changes.
const DEFAULT_PAYMENT_CHANNELS = {
  paymongo: { enabled: false },
  bank_transfer: { enabled: false, bank_name: null, account_name: null, account_number: null, instructions: null },
  gcash: { enabled: false, account_name: null, number: null, instructions: null },
  maya: { enabled: false, account_name: null, number: null, instructions: null },
  qr_code: { enabled: false, image_url: null, label: null },
};

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

    // Look up by public_slug first (the customizable, guest-facing link),
    // falling back to the original internal slug so any widget page still
    // pointed at the old value keeps working.
    const t = await sql`
      SELECT id, name, currency, status, public_slug FROM tenants
      WHERE LOWER(public_slug) = ${slug.toLowerCase()} OR LOWER(slug) = ${slug.toLowerCase()}
      ORDER BY (LOWER(public_slug) = ${slug.toLowerCase()}) DESC
      LIMIT 1
    `;
    if (t.rows.length === 0 || !isBookableStatus(t.rows[0].status)) {
      return res.status(404).json({ ok: false, error: 'Resort not found' });
    }
    const tenant = t.rows[0];

    const s = await sql`
      SELECT primary_color, logo_url,
             checkin_time::text AS checkin_time, checkout_time::text AS checkout_time,
             cancellation_policy, vat_percent, min_stay_nights, booking_window_days,
             theme, payment_channels, custom_fields, widget_template
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
      tenant: {
        id: tenant.id,
        name: tenant.name,
        currency: tenant.currency,
        public_slug: tenant.public_slug,
      },
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
        payment_channels: settings.payment_channels || DEFAULT_PAYMENT_CHANNELS,
        custom_fields: settings.custom_fields || [],
        widget_template: settings.widget_template || 'standard',
      },
      unit_types: units.rows,
      addons: addons.rows,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
