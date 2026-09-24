import { sql } from '@vercel/postgres';
import { setCors, getAuth, num, text } from './_lib/helpers.js';

export default async function handler(req, res) {
  if (setCors(req, res, 'GET, POST, PUT, OPTIONS')) return;

  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  try {
    if (req.method === 'GET') {
      const result = await sql`
        select id, code, discount_percent, discount_amount,
               valid_from::text as valid_from, valid_to::text as valid_to,
               max_uses, times_used, is_active
        from promo_codes
        where tenant_id = ${auth.tenant_id}
        order by code
      `;
      return res.status(200).json({ ok: true, promos: result.rows });
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      const b = req.body || {};
      const code = text(b.code) ? text(b.code).toUpperCase() : null;
      const percent = num(b.discount_percent);
      const amount = num(b.discount_amount);
      const validFrom = text(b.valid_from);
      const validTo = text(b.valid_to);
      const maxUses = num(b.max_uses);
      const active = b.is_active === false ? false : true;

      if (!code || (percent === null && amount === null)) {
        return res.status(400).json({ ok: false, error: 'Code and a discount (percent or flat amount) are required' });
      }
      if (percent !== null && (percent <= 0 || percent > 100)) {
        return res.status(400).json({ ok: false, error: 'Percent must be between 1 and 100' });
      }

      if (req.method === 'POST') {
        const result = await sql`
          insert into promo_codes (tenant_id, code, discount_percent, discount_amount, valid_from, valid_to, max_uses, times_used, is_active)
          values (${auth.tenant_id}, ${code}, ${percent}::numeric, ${amount}::numeric, ${validFrom}::date, ${validTo}::date, ${maxUses}::integer, 0, ${active}::boolean)
          returning id
        `;
        return res.status(200).json({ ok: true, id: result.rows[0].id });
      }

      if (!b.id) return res.status(400).json({ ok: false, error: 'id is required' });
      const result = await sql`
        update promo_codes set
          code = ${code},
          discount_percent = ${percent}::numeric,
          discount_amount = ${amount}::numeric,
          valid_from = ${validFrom}::date,
          valid_to = ${validTo}::date,
          max_uses = ${maxUses}::integer,
          is_active = ${active}::boolean
        where id = ${b.id} and tenant_id = ${auth.tenant_id}
        returning id
      `;
      if (result.rows.length === 0) return res.status(404).json({ ok: false, error: 'Not found' });
      return res.status(200).json({ ok: true, id: result.rows[0].id });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
