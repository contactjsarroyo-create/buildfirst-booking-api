import { sql } from '@vercel/postgres';
import { setCors, getAuth, text } from './_lib/helpers.js';

export default async function handler(req, res) {
  if (setCors(req, res, 'GET, POST, DELETE, OPTIONS')) return;

  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  try {
    if (req.method === 'GET') {
      const result = await sql`
        select b.id, b.unit_type_id, u.name as unit_type_name,
               b.start_date::text as start_date, b.end_date::text as end_date,
               b.reason, b.source
        from availability_blocks b
        left join unit_types u on u.id = b.unit_type_id
        where b.tenant_id = ${auth.tenant_id}
        order by b.start_date
      `;
      return res.status(200).json({ ok: true, blocks: result.rows });
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      const unitTypeId = text(b.unit_type_id);
      const startDate = text(b.start_date);
      const endDate = text(b.end_date);
      const reason = text(b.reason);

      if (!unitTypeId || !startDate || !endDate) {
        return res.status(400).json({ ok: false, error: 'Room type, start date and end date are required' });
      }
      if (endDate < startDate) {
        return res.status(400).json({ ok: false, error: 'End date must be on or after start date' });
      }

      const owns = await sql`
        select id from unit_types where id = ${unitTypeId} and tenant_id = ${auth.tenant_id}
      `;
      if (owns.rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Room type not found' });
      }

      const result = await sql`
        insert into availability_blocks (tenant_id, unit_type_id, start_date, end_date, reason, source)
        values (${auth.tenant_id}, ${unitTypeId}, ${startDate}::date, ${endDate}::date, ${reason}, 'manual')
        returning id
      `;
      return res.status(200).json({ ok: true, id: result.rows[0].id });
    }

    if (req.method === 'DELETE') {
      const id = (req.query && req.query.id) || (req.body && req.body.id);
      if (!id) return res.status(400).json({ ok: false, error: 'id is required' });
      const result = await sql`
        delete from availability_blocks
        where id = ${id} and tenant_id = ${auth.tenant_id} and source = 'manual'
        returning id
      `;
      if (result.rows.length === 0) return res.status(404).json({ ok: false, error: 'Not found' });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
