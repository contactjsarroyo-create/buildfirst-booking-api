import { sql } from '@vercel/postgres';
import { setCors, getAuth, text } from './_lib/helpers.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  if (setCors(req, res, 'GET, POST, DELETE, OPTIONS')) return;

  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  try {
    if (req.method === 'GET') {
      const result = await sql`
        select b.id, b.unit_type_id, u.name as unit_type_name,
               b.start_date::text as start_date, b.end_date::text as end_date,
               b.reason, b.source, b.room_ids::text[] as room_ids
        from availability_blocks b
        left join unit_types u on u.id = b.unit_type_id
        where b.tenant_id = ${auth.tenant_id}
        order by b.start_date
      `;
      const roomsResult = await sql`
        select id::text as id, label from rooms where tenant_id = ${auth.tenant_id}
      `;
      const labelById = {};
      roomsResult.rows.forEach((r) => {
        labelById[r.id] = r.label;
      });
      // room_ids null = the whole room type is blocked.
      const blocks = result.rows.map((r) => ({
        ...r,
        room_labels: r.room_ids ? r.room_ids.map((id) => labelById[id]).filter(Boolean) : null,
      }));
      return res.status(200).json({ ok: true, blocks });
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
      if (!UUID_RE.test(unitTypeId)) {
        return res.status(400).json({ ok: false, error: 'Invalid room type' });
      }
      if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
        return res.status(400).json({ ok: false, error: 'Dates must be in YYYY-MM-DD format' });
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

      // room_ids omitted/empty = block the whole room type. Otherwise block only
      // the listed rooms. Selecting every active room is stored as a whole-type
      // block, so rooms added to the type later are covered too.
      let roomIds = null;
      if (Array.isArray(b.room_ids) && b.room_ids.length > 0) {
        const ids = Array.from(new Set(b.room_ids.map((x) => String(x).toLowerCase())));
        if (ids.some((id) => !UUID_RE.test(id))) {
          return res.status(400).json({ ok: false, error: 'Invalid room selection' });
        }
        const rooms = await sql`
          select id::text as id, is_active from rooms
          where unit_type_id = ${unitTypeId} and tenant_id = ${auth.tenant_id}
        `;
        const valid = new Set(rooms.rows.map((r) => r.id));
        if (ids.some((id) => !valid.has(id))) {
          return res.status(400).json({ ok: false, error: 'One or more rooms do not belong to this room type' });
        }
        const activeIds = rooms.rows.filter((r) => r.is_active !== false).map((r) => r.id);
        const coversAll = activeIds.length > 0 && activeIds.every((id) => ids.includes(id));
        roomIds = coversAll ? null : ids;
      }
      const roomIdsLiteral = roomIds ? '{' + roomIds.join(',') + '}' : null;

      const result = await sql`
        insert into availability_blocks (tenant_id, unit_type_id, room_ids, start_date, end_date, reason, source)
        values (${auth.tenant_id}, ${unitTypeId}, ${roomIdsLiteral}::uuid[], ${startDate}::date, ${endDate}::date, ${reason}, 'manual')
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
