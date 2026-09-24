import { sql } from '@vercel/postgres';
import { setCors, getAuth, num, text } from './_lib/helpers.js';

export default async function handler(req, res) {
  if (setCors(req, res, 'GET, PUT, OPTIONS')) return;

  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  try {
    if (req.method === 'GET') {
      const t = await sql`
        select name, slug, plan, currency from tenants where id = ${auth.tenant_id}
      `;
      const s = await sql`
        select logo_url, primary_color, embed_domain,
               checkin_time::text as checkin_time, checkout_time::text as checkout_time,
               cancellation_policy, deposit_percent, vat_percent,
               min_stay_nights, booking_window_days
        from tenant_settings where tenant_id = ${auth.tenant_id}
      `;
      return res.status(200).json({
        ok: true,
        tenant: t.rows[0] || null,
        settings: s.rows[0] || null,
      });
    }

    if (req.method === 'PUT') {
      const b = req.body || {};
      const name = text(b.name);
      const vals = {
        logo_url: text(b.logo_url),
        primary_color: text(b.primary_color),
        embed_domain: text(b.embed_domain),
        checkin_time: text(b.checkin_time) || '14:00',
        checkout_time: text(b.checkout_time) || '12:00',
        cancellation_policy: text(b.cancellation_policy),
        deposit_percent: num(b.deposit_percent) ?? 0,
        vat_percent: num(b.vat_percent) ?? 12,
        min_stay_nights: Math.floor(num(b.min_stay_nights) ?? 1),
        booking_window_days: Math.floor(num(b.booking_window_days) ?? 365),
      };

      if (vals.vat_percent < 0 || vals.vat_percent > 100 || vals.deposit_percent < 0 || vals.deposit_percent > 100) {
        return res.status(400).json({ ok: false, error: 'Percentages must be between 0 and 100' });
      }

      if (name) {
        await sql`update tenants set name = ${name}, updated_at = now() where id = ${auth.tenant_id}`;
      }

      const existing = await sql`select tenant_id from tenant_settings where tenant_id = ${auth.tenant_id}`;

      if (existing.rows.length === 0) {
        await sql`
          insert into tenant_settings
            (tenant_id, logo_url, primary_color, embed_domain, checkin_time, checkout_time,
             cancellation_policy, deposit_percent, vat_percent, min_stay_nights, booking_window_days, updated_at)
          values
            (${auth.tenant_id}, ${vals.logo_url}, ${vals.primary_color}, ${vals.embed_domain},
             ${vals.checkin_time}::time, ${vals.checkout_time}::time, ${vals.cancellation_policy},
             ${vals.deposit_percent}::numeric, ${vals.vat_percent}::numeric,
             ${vals.min_stay_nights}::integer, ${vals.booking_window_days}::integer, now())
        `;
      } else {
        await sql`
          update tenant_settings set
            logo_url = ${vals.logo_url},
            primary_color = ${vals.primary_color},
            embed_domain = ${vals.embed_domain},
            checkin_time = ${vals.checkin_time}::time,
            checkout_time = ${vals.checkout_time}::time,
            cancellation_policy = ${vals.cancellation_policy},
            deposit_percent = ${vals.deposit_percent}::numeric,
            vat_percent = ${vals.vat_percent}::numeric,
            min_stay_nights = ${vals.min_stay_nights}::integer,
            booking_window_days = ${vals.booking_window_days}::integer,
            updated_at = now()
          where tenant_id = ${auth.tenant_id}
        `;
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
