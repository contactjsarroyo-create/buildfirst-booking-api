import { sql } from '@vercel/postgres';
import { put } from '@vercel/blob';
import { setCors, getAuth, num, text } from './_lib/helpers.js';
import { getAccount, getUsage, planLimit, reserveStorage, releaseStorage } from './_lib/limits.js';
import { recordFileOrRollback, removeFiles, isUuid } from './_lib/storage.js';


// Short room code from a room type's name: "Standard Room" -> SR, "Deluxe
// Ocean Suite" -> DOS. A single word uses its first two letters ("Villa" ->
// VI). Numbers keep counting up per code across the whole account, so codes
// never repeat (SR01, SR02, ... even if two types share the same letters).
function roomPrefix(name) {
  const words = String(name || '')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w && !/^\d+$/.test(w));
  let p = '';
  if (words.length >= 2) p = words.slice(0, 4).map((w) => w[0]).join('');
  else if (words.length === 1) p = words[0].slice(0, 2);
  p = p.toUpperCase();
  return p || 'RM';
}

async function createRoomsForType(tenantId, unitTypeId, name, count) {
  if (!count || count < 1) return;
  const prefix = roomPrefix(name);
  const existing = await sql`select label from rooms where tenant_id = ${tenantId}`;
  const re = new RegExp('^' + prefix + '(\\d+)$');
  let max = 0;
  for (const row of existing.rows) {
    const m = re.exec(row.label || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  for (let i = 1; i <= count; i++) {
    const label = prefix + String(max + i).padStart(2, '0');
    await sql`
      insert into rooms (tenant_id, unit_type_id, label)
      values (${tenantId}, ${unitTypeId}, ${label})
    `;
  }
}

export default async function handler(req, res) {
  if (setCors(req, res, 'GET, POST, PUT, DELETE, OPTIONS')) return;

  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const rq = req.query && req.query.resource;
  const resource = rq === 'rooms' ? 'rooms' : rq === 'photos' ? 'photos' : 'unit_types';

  try {
    if (resource === 'rooms') {
      return await handleRooms(req, res, auth);
    }
    if (resource === 'photos') {
      return await handlePhotos(req, res, auth);
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
      // Room photos, in the order the owner arranged them.
      const photosResult = await sql`
        select p.id, p.unit_type_id, p.url
        from unit_type_photos p
        join unit_types u on u.id = p.unit_type_id
        where u.tenant_id = ${auth.tenant_id}
        order by p.display_order, p.id
      `;
      const photosByType = {};
      for (const p of photosResult.rows) {
        if (!photosByType[p.unit_type_id]) photosByType[p.unit_type_id] = [];
        photosByType[p.unit_type_id].push({ id: p.id, url: p.url });
      }
      const unit_types = typesResult.rows.map((t) => ({
        ...t,
        rooms: roomsByType[t.id] || [],
        photos: photosByType[t.id] || [],
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

      const newCount = Math.floor(count);
      const account = await getAccount(auth.tenant_id);
      if (!account) return res.status(404).json({ ok: false, error: 'Account not found' });
      const usage = await getUsage(auth.tenant_id);
      const limits = account.limits;

      if (req.method === 'POST') {
        if (usage.unit_types >= limits.unit_types) {
          return planLimit(
            res,
            account,
            `Your ${account.label} allows up to ${limits.unit_types} room types.`,
            'unit_types'
          );
        }
        if (usage.unit_count_total + newCount > limits.rooms) {
          return planLimit(
            res,
            account,
            `Your ${account.label} allows up to ${limits.rooms} rooms in total.`,
            'rooms'
          );
        }
        const result = await sql`
          insert into unit_types (tenant_id, name, description, capacity_guests, base_rate, unit_count, is_active)
          values (${auth.tenant_id}, ${name}, ${description}, ${capacity}::integer, ${rate}::numeric, ${newCount}::integer, ${active}::boolean)
          returning id
        `;
        const newId = result.rows[0].id;
        // Create the individual rooms (SR01, SR02, ...) to match the count.
        // If that fails, remove the half-made room type so nothing is left over.
        try {
          await createRoomsForType(auth.tenant_id, newId, name, newCount);
        } catch (roomErr) {
          console.error(roomErr);
          await sql`delete from rooms where unit_type_id = ${newId} and tenant_id = ${auth.tenant_id}`;
          await sql`delete from unit_types where id = ${newId} and tenant_id = ${auth.tenant_id}`;
          return res.status(500).json({ ok: false, error: 'Could not create the rooms for this room type' });
        }
        return res.status(200).json({ ok: true, id: newId, rooms_created: newCount });
      }

      if (!b.id) return res.status(400).json({ ok: false, error: 'id is required' });

      // Only block when the unit count is going UP past the limit, so a tenant
      // who is over their limit (e.g. after a downgrade) can still edit rates.
      const old = await sql`
        select unit_count from unit_types where id = ${b.id} and tenant_id = ${auth.tenant_id}
      `;
      if (old.rows.length === 0) return res.status(404).json({ ok: false, error: 'Not found' });
      const oldCount = old.rows[0].unit_count || 0;
      const newTotal = usage.unit_count_total - oldCount + newCount;
      if (newCount > oldCount && newTotal > limits.rooms) {
        return planLimit(
          res,
          account,
          `Your ${account.label} allows up to ${limits.rooms} rooms in total.`,
          'rooms'
        );
      }

      const result = await sql`
        update unit_types set
          name = ${name},
          description = ${description},
          capacity_guests = ${capacity}::integer,
          base_rate = ${rate}::numeric,
          unit_count = ${newCount}::integer,
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

    // Plan limit on the total number of individual rooms.
    const account = await getAccount(auth.tenant_id);
    if (!account) return res.status(404).json({ ok: false, error: 'Account not found' });
    const countResult = await sql`
      select count(*)::int as n from rooms where tenant_id = ${auth.tenant_id}
    `;
    if (countResult.rows[0].n >= account.limits.rooms) {
      return planLimit(
        res,
        account,
        `Your ${account.label} allows up to ${account.limits.rooms} rooms in total.`,
        'rooms'
      );
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

// ------------------------------------------------------------
// Room photos, reached via /api/unit-types?resource=photos
//   POST   { unit_type_id, image_base64 }   add a photo (data URL, jpg/png/webp, 4MB)
//   PUT    { unit_type_id, ids: [photoId, ...] }   save a new order (first = cover photo)
//   DELETE ?id=<photoId>                     remove a photo completely
// Each photo is tracked in uploaded_files (kind 'room_photo') so it counts
// toward the plan's storage limit and shows in the Storage tab. Room photos
// are never auto-deleted; the owner removes them. The photo list itself
// (order) lives in unit_type_photos. Merged here to stay under the
// 12-function cap.
// ------------------------------------------------------------
const MAX_PHOTOS_PER_TYPE = 8;
const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

function parsePhotoDataUrl(input) {
  if (typeof input !== 'string') return null;
  const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(input.trim());
  if (!match) return null;
  return { mime: match[1], buffer: Buffer.from(match[2], 'base64') };
}

async function handlePhotos(req, res, auth) {
  if (req.method === 'POST') {
    const b = req.body || {};
    const unitTypeId = text(b.unit_type_id);
    if (!unitTypeId || !isUuid(unitTypeId)) {
      return res.status(400).json({ ok: false, error: 'unit_type_id is required' });
    }
    const typeCheck = await sql`
      select id from unit_types where id = ${unitTypeId} and tenant_id = ${auth.tenant_id}
    `;
    if (typeCheck.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Room type not found' });
    }

    const account = await getAccount(auth.tenant_id);
    if (!account) return res.status(404).json({ ok: false, error: 'Account not found' });

    const parsed = parsePhotoDataUrl(b.image_base64);
    if (!parsed) {
      return res.status(400).json({ ok: false, error: 'Please choose a JPG, PNG or WEBP image' });
    }
    if (parsed.buffer.length > MAX_PHOTO_BYTES) {
      return res.status(400).json({ ok: false, error: 'That photo is too big. Please use one under 4MB.' });
    }

    const countResult = await sql`
      select count(*)::int as n, coalesce(max(display_order), -1)::int as top
      from unit_type_photos where unit_type_id = ${unitTypeId}
    `;
    if (countResult.rows[0].n >= MAX_PHOTOS_PER_TYPE) {
      return res.status(400).json({
        ok: false,
        error: `You can add up to ${MAX_PHOTOS_PER_TYPE} photos per room type. Remove one to add another.`,
      });
    }

    const size = parsed.buffer.length;
    const reserved = await reserveStorage(auth.tenant_id, size, account.limits.storage_bytes);
    if (!reserved) {
      return planLimit(
        res,
        account,
        `Your ${account.label} photo storage is full. Delete some photos in the Storage tab or upgrade your plan.`,
        'storage'
      );
    }

    const ext = PHOTO_TYPES[parsed.mime];
    const pathname = `room-photos/${auth.tenant_id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    let blob;
    try {
      blob = await put(pathname, parsed.buffer, { access: 'public', contentType: parsed.mime });
    } catch (err) {
      await releaseStorage(auth.tenant_id, size);
      throw err;
    }
    await recordFileOrRollback(auth.tenant_id, 'room_photo', blob.url, size);

    const inserted = await sql`
      insert into unit_type_photos (unit_type_id, url, display_order)
      values (${unitTypeId}, ${blob.url}, ${countResult.rows[0].top + 1}::integer)
      returning id
    `;
    return res.status(200).json({ ok: true, id: inserted.rows[0].id, url: blob.url });
  }

  if (req.method === 'PUT') {
    const b = req.body || {};
    const unitTypeId = text(b.unit_type_id);
    const ids = Array.isArray(b.ids) ? b.ids.map((x) => String(x)) : [];
    if (!unitTypeId || !isUuid(unitTypeId) || ids.length === 0 || !ids.every(isUuid)) {
      return res.status(400).json({ ok: false, error: 'unit_type_id and ids are required' });
    }
    const typeCheck = await sql`
      select id from unit_types where id = ${unitTypeId} and tenant_id = ${auth.tenant_id}
    `;
    if (typeCheck.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Room type not found' });
    }
    for (let i = 0; i < ids.length; i++) {
      await sql`
        update unit_type_photos set display_order = ${i}::integer
        where id = ${ids[i]} and unit_type_id = ${unitTypeId}
      `;
    }
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const id = text(req.query && req.query.id);
    if (!id || !isUuid(id)) return res.status(400).json({ ok: false, error: 'id is required' });

    const found = await sql`
      select p.id, p.url from unit_type_photos p
      join unit_types u on u.id = p.unit_type_id
      where p.id = ${id} and u.tenant_id = ${auth.tenant_id}
    `;
    if (found.rows.length === 0) return res.status(404).json({ ok: false, error: 'Photo not found' });
    const url = found.rows[0].url;

    const file = await sql`
      select id, tenant_id, url, bytes::float8 as bytes from uploaded_files
      where tenant_id = ${auth.tenant_id} and kind = 'room_photo' and url = ${url}
    `;
    try {
      if (file.rows.length > 0) {
        // Removes the image, the photo row, the tracking row and the bytes.
        await removeFiles(file.rows);
      } else {
        await sql`delete from unit_type_photos where id = ${id}`;
      }
    } catch (err) {
      console.error(err);
      return res.status(500).json({ ok: false, error: 'Could not delete right now. Nothing was changed, please try again.' });
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
