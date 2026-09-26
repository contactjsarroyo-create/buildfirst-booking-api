import { sql } from '@vercel/postgres';
import { setCors, getAuth, num, text } from './_lib/helpers.js';

export default async function handler(req, res) {
  if (setCors(req, res, 'GET, POST, PUT, OPTIONS')) return;

  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const resource = req.query && req.query.resource === 'rooms' ? 'rooms' : 'unit_types';

  try {
    if (resource === 'rooms') {
      return await handleRooms(req, res, auth);
    }

    if (req.method === 'GET') {
      const typesResult = await sql`
        select id, name, description, capacity_guests, base_rate, unit_count, is_active, display_order
        from unit_types
        where tenant_id = ${auth.tenant_id}
        order by display_order, created_at
      `;
      // Attach each room type's individual rooms so the dashboard can show
      // and manage them without a second request.
      const roomsResult = await sql`
        select id, unit_type_id, label, is_active
        from rooms
        where tenant_id = ${auth.tenant_id}
        order by label
      `;
      const roomsByType = {};
      for (const r of roomsResult.rows) {
        if (!roomsByType[r.unit_type_id]) roomsByType[r.unit_type_id] = [];
        roomsByType[r.unit_type_id].push(r);
      }
      const unit_types = typesResult.rows.map((t) => ({
        ...t,
        rooms: roomsByType[t.id] || [],
      }));
      return res.status(200).json({ ok: true, unit_types });
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

// Individual room CRUD, reached via /api/unit-types?resource=rooms
// Merged into this file instead of a new route to stay under Vercel's
// 12-function cap on the Hobby plan.
async function handleRooms(req, res, auth) {
  if (req.method === 'POST') {
    const b = req.body || {};
    const unit_type_id = text(b.unit_type_id);
    const label = text(b.label);

    if (!unit_type_id || !label) {
      return res.status(400).json({ ok: false, error: 'unit_type_id and label are required' });
    }

    // Confirm the unit type actually belongs to this tenant before attaching a room to it.
    const typeCheck = await sql`
      select id from unit_types where id = ${unit_type_id} and tenant_id = ${auth.tenant_id}
    `;
    if (typeCheck.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Room type not found' });
    }

    const result = await sql`
      insert into rooms (tenant_id, unit_type_id, label)
      values (${auth.tenant_id}, ${unit_type_id}, ${label})
      returning id
    `;
    return res.status(200).json({ ok: true, id: result.rows[0].id });
  }

  if (req.method === 'PUT') {
    const b = req.body || {};
    if (!b.id) return res.status(400).json({ ok: false, error: 'id is required' });

    const label = text(b.label);
    const active = b.is_active === false ? false : true;
    if (!label) return res.status(400).json({ ok: false, error: 'label is required' });

    const result = await sql`
      update rooms set label = ${label}, is_active = ${active}::boolean
      where id = ${b.id} and tenant_id = ${auth.tenant_id}
      returning id
    `;
    if (result.rows.length === 0) return res.status(404).json({ ok: false, error: 'Not found' });
    return res.status(200).json({ ok: true, id: result.rows[0].id });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
