import { sql } from '@vercel/postgres';
import { del } from '@vercel/blob';
import { releaseStorage } from './limits.js';

// ------------------------------------------------------------
// Uploaded-file bookkeeping: every image we put in Vercel Blob gets a row in
// uploaded_files, so the owner can see what is using their storage, delete
// files, and so the daily cleanup knows what has expired.
//
//   kind 'guest_upload'    photo a guest attached to a booking. Auto-deleted
//                          N days after check-out (tenant_settings.image_retention_days).
//   kind 'question_image'  reference image the owner attached to a booking-form
//                          question. Never auto-deleted, owner deletes manually.
//
// tenants.storage_bytes stays the running total used for plan limits;
// this file keeps it in step (releaseStorage) whenever a file is removed.
// ------------------------------------------------------------

export const RETENTION_OPTIONS = [7, 14, 30, 60, 90, 0]; // 0 = keep until the owner deletes
export const DEFAULT_RETENTION_DAYS = 30;
// A guest photo that never got attached to a finished booking is junk.
export const ORPHAN_HOURS = 48;
// The dashboard warns about photos that will be deleted within this many days.
export const NOTICE_DAYS = 7;
// What a booking's answer is replaced with after its photo is deleted.
export const REMOVED_MARKER = '__removed__';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v) {
  return UUID_RE.test(String(v));
}

export async function recordFile(tenantId, kind, url, bytes) {
  await sql`
    insert into uploaded_files (tenant_id, kind, url, bytes)
    values (${tenantId}, ${kind}, ${url}, ${bytes}::bigint)
  `;
}

// Records a just-uploaded file. If that fails, the blob and the reserved
// space are rolled back so nothing is left counted but untracked.
export async function recordFileOrRollback(tenantId, kind, url, bytes) {
  try {
    await recordFile(tenantId, kind, url, bytes);
  } catch (err) {
    try {
      await del(url);
    } catch (e) {
      console.error(e);
    }
    await releaseStorage(tenantId, bytes);
    throw err;
  }
}

// Ties freshly uploaded guest photos to the booking that used them.
export async function linkFilesToBooking(tenantId, bookingId, urls) {
  for (const url of urls) {
    await sql`
      update uploaded_files
      set booking_id = ${String(bookingId)}
      where tenant_id = ${tenantId}
        and kind = 'guest_upload'
        and booking_id is null
        and url = ${url}
    `;
  }
}

// Removes every place a deleted file was referenced, so nothing points at a
// dead link: booking answers become REMOVED_MARKER, and a question's
// reference image is dropped from the booking form.
async function scrubReferences(tenantId, url) {
  await sql`
    update bookings set custom_field_responses = (
      select coalesce(
        jsonb_object_agg(
          e.key,
          case when e.value = to_jsonb(${url}::text) then to_jsonb(${REMOVED_MARKER}::text) else e.value end
        ),
        '{}'::jsonb
      )
      from jsonb_each(custom_field_responses) e
    )
    where tenant_id = ${tenantId}
      and jsonb_typeof(custom_field_responses) = 'object'
      and position(${url} in custom_field_responses::text) > 0
  `;
  await sql`
    update tenant_settings set custom_fields = (
      select coalesce(
        jsonb_agg(
          case when t.elem->>'image_url' = ${url} then t.elem - 'image_url' else t.elem end
          order by t.n
        ),
        '[]'::jsonb
      )
      from jsonb_array_elements(custom_fields) with ordinality as t(elem, n)
    )
    where tenant_id = ${tenantId}
      and jsonb_typeof(custom_fields) = 'array'
      and position(${url} in custom_fields::text) > 0
  `;
}

// Deletes files completely: the blob, every reference, the tracking row, and
// the bytes counted against the tenant. Blobs go first. If that throws,
// nothing else has changed and the caller can just try again.
// files: [{ id, tenant_id, url, bytes }]. Returns how many were removed.
export async function removeFiles(files) {
  if (!files.length) return 0;
  await del(files.map((f) => f.url));

  let removed = 0;
  for (const f of files) {
    await scrubReferences(f.tenant_id, f.url);
    const gone = await sql`delete from uploaded_files where id = ${f.id} returning id`;
    if (gone.rows.length > 0) {
      await releaseStorage(f.tenant_id, Number(f.bytes) || 0);
      removed++;
    }
  }
  return removed;
}

// Owner-triggered delete. Only ever touches this tenant's own files.
export async function removeTenantFiles(tenantId, ids) {
  const r = await sql`
    select id, tenant_id, url, bytes::float8 as bytes
    from uploaded_files
    where tenant_id = ${tenantId}
      and id = any(string_to_array(${ids.join(',')}, ',')::uuid[])
  `;
  return removeFiles(r.rows);
}

// Daily cleanup: guest photos past their retention window, plus abandoned
// uploads. Runs in batches so one run stays well inside the function's time
// limit; anything left over is picked up by the next run.
export async function expireFiles({ batchSize = 100, maxBatches = 3 } = {}) {
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const r = await sql`
      select f.id, f.tenant_id, f.url, f.bytes::float8 as bytes
      from uploaded_files f
      left join bookings b on b.id::text = f.booking_id and b.tenant_id = f.tenant_id
      left join tenant_settings s on s.tenant_id = f.tenant_id
      where f.kind = 'guest_upload' and (
        (f.booking_id is null and f.created_at < now() - (${ORPHAN_HOURS}::int * interval '1 hour'))
        or (b.id is not null
            and coalesce(s.image_retention_days, ${DEFAULT_RETENTION_DAYS}::int) > 0
            and b.check_out::date + coalesce(s.image_retention_days, ${DEFAULT_RETENTION_DAYS}::int)
                < (now() at time zone 'Asia/Manila')::date)
      )
      order by f.created_at
      limit ${batchSize}::int
    `;
    if (r.rows.length === 0) break;
    deleted += await removeFiles(r.rows);
    if (r.rows.length < batchSize) break;
  }
  return { deleted };
}

export async function getRetention(tenantId) {
  const r = await sql`select image_retention_days from tenant_settings where tenant_id = ${tenantId}`;
  if (r.rows.length === 0) return DEFAULT_RETENTION_DAYS;
  const d = r.rows[0].image_retention_days;
  return d === null || d === undefined ? DEFAULT_RETENTION_DAYS : Number(d);
}

// Returns false if the tenant has no settings row yet.
export async function setRetention(tenantId, days) {
  const r = await sql`
    update tenant_settings set image_retention_days = ${days}::int
    where tenant_id = ${tenantId}
    returning tenant_id
  `;
  return r.rows.length > 0;
}

// How many guest photos are already due, or due within NOTICE_DAYS.
export async function expiringSoonCount(tenantId) {
  const r = await sql`
    select count(*)::int as n
    from uploaded_files f
    join bookings b on b.id::text = f.booking_id and b.tenant_id = f.tenant_id
    left join tenant_settings s on s.tenant_id = f.tenant_id
    where f.tenant_id = ${tenantId}
      and f.kind = 'guest_upload'
      and coalesce(s.image_retention_days, ${DEFAULT_RETENTION_DAYS}::int) > 0
      and b.check_out::date + coalesce(s.image_retention_days, ${DEFAULT_RETENTION_DAYS}::int)
          <= (now() at time zone 'Asia/Manila')::date + ${NOTICE_DAYS}::int
  `;
  return r.rows[0].n;
}

export async function storageBreakdown(tenantId) {
  const r = await sql`
    select kind, count(*)::int as files, coalesce(sum(bytes), 0)::float8 as bytes
    from uploaded_files
    where tenant_id = ${tenantId}
    group by kind
  `;
  const out = {
    guest_upload: { files: 0, bytes: 0 },
    question_image: { files: 0, bytes: 0 },
  };
  for (const row of r.rows) {
    if (out[row.kind]) out[row.kind] = { files: row.files, bytes: Number(row.bytes) || 0 };
  }
  return out;
}

export async function listFiles(tenantId) {
  const r = await sql`
    select f.id, f.kind, f.url, f.bytes::float8 as bytes, f.created_at, f.booking_id,
           b.guest_name,
           case
             when f.kind = 'guest_upload' and b.id is not null
                  and coalesce(s.image_retention_days, ${DEFAULT_RETENTION_DAYS}::int) > 0
             then to_char(b.check_out::date + coalesce(s.image_retention_days, ${DEFAULT_RETENTION_DAYS}::int), 'YYYY-MM-DD')
           end as expires_on
    from uploaded_files f
    left join bookings b on b.id::text = f.booking_id and b.tenant_id = f.tenant_id
    left join tenant_settings s on s.tenant_id = f.tenant_id
    where f.tenant_id = ${tenantId}
    order by f.bytes desc
    limit 500
  `;
  return r.rows;
}
