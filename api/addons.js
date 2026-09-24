import { sql } from '@vercel/postgres';
import { setCors, getAuth, num, text } from './_lib/helpers.js';

export default async function handler(req, res) {
  if (setCors(req, res, 'GET, POST, PUT, OPTIONS')) return;

  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  try {
    if (req.method === 'GET') {
      const result = await sql`
        select id, name, price, is_active
        from addons
        where tenant_id = ${auth.tenant_id}
        order by name
      `;
      return res.status(200).json({ ok: true, addons: result.rows });
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      const b = req.body || {};
      const name = text(b.name);
      const price = num(b.price);
      const active = b.is_active === false ? false : true;

      if (!name || price === null || price < 0) {
        return res.status(400).json({ ok: false, error: 'Name and a valid price are required' });
      }

      if (req.method === 'POST') {
        const result = await sql`
          insert into addons (tenant_id, name, price, is_active)
          values (${auth.tenant_id}, ${name}, ${price}::numeric, ${active}::boolean)
          returning id
        `;
        return res.status(200).json({ ok: true, id: result.rows[0].id });
      }

      if (!b.id) return res.status(400).json({ ok: false, error: 'id is required' });
      const result = await sql`
        update addons set
          name = ${name},
          price = ${price}::numeric,
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
