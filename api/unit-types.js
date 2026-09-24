import { sql } from '@vercel/postgres';
import { setCors, getAuth, num, text } from './_lib/helpers.js';

export default async function handler(req, res) {
  if (setCors(req, res, 'GET, POST, PUT, OPTIONS')) return;

  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  try {
    if (req.method === 'GET') {
      const result = await sql`
        select id, name, description, capacity_guests, base_rate, unit_count, is_active, display_order
        from unit_types
        where tenant_id = ${auth.tenant_id}
        order by display_order, created_at
      `;
      return res.status(200).json({ ok: true, unit_types: result.rows });
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      const b = req.body || {};
      const name = text(b.name);
      const description = text(b.description);
      const capacity = num(b.capacity_guests);
      const rate = num(b.base_rate);
      const count = num(b.unit_count);
      const active = b.is_active === false ? false : true;

      if (!name || rate === null || rate < 0 || count === null || count < 0) {
        return res.status(400).json({ ok: false, error: 'Name, a valid rate and a valid unit count are required' });
      }

      if (req.method === 'POST') {
        const result = await sql`
          insert into unit_types (tenant_id, name, description, capacity_guests, base_rate, unit_count, is_active)
          values (${auth.tenant_id}, ${name}, ${description}, ${capacity}::integer, ${rate}::numeric, ${Math.floor(count)}::integer, ${active}::boolean)
          returning id
        `;
        return res.status(200).json({ ok: true, id: result.rows[0].id });
      }

      if (!b.id) return res.status(400).json({ ok: false, error: 'id is required' });
      const result = await sql`
        update unit_types set
          name = ${name},
          description = ${description},
          capacity_guests = ${capacity}::integer,
          base_rate = ${rate}::numeric,
          unit_count = ${Math.floor(count)}::integer,
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
