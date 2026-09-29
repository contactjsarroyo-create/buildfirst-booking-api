// One-time tokens for "verify email" and "reset password" links.
// The raw token only ever exists in the email link. The database stores a
// SHA-256 hash, so a leaked database cannot be used to take over accounts.
import crypto from 'crypto';
import { sql } from '@vercel/postgres';

const TTL_MINUTES = { verify: 24 * 60, reset: 60 };
// Minimum gap between two emails of the same kind for the same user.
const COOLDOWN_SECONDS = 60;

export function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// Creates a fresh token for a user and invalidates their older unused ones.
// Returns { token } or { throttled: true } if one was issued under a minute ago.
export async function issueToken(userId, purpose) {
  const uid = String(userId);
  const ttl = TTL_MINUTES[purpose];
  if (!ttl) throw new Error(`Unknown token purpose: ${purpose}`);

  const recent = await sql`
    select 1 from auth_tokens
    where user_id = ${uid} and purpose = ${purpose}
      and created_at > now() - (${COOLDOWN_SECONDS}::int * interval '1 second')
    limit 1
  `;
  if (recent.rows.length > 0) return { throttled: true };

  // Housekeeping: drop this user's unused tokens and anything long expired.
  await sql`delete from auth_tokens where user_id = ${uid} and purpose = ${purpose} and used_at is null`;
  await sql`delete from auth_tokens where expires_at < now() - interval '7 days'`;

  const raw = crypto.randomBytes(32).toString('hex');
  await sql`
    insert into auth_tokens (user_id, purpose, token_hash, expires_at)
    values (${uid}, ${purpose}, ${hashToken(raw)}, now() + (${ttl}::int * interval '1 minute'))
  `;
  return { token: raw };
}

// Looks a token up without consuming it.
// Returns { id, user_id, used, expired } or null if it does not exist.
export async function findToken(raw, purpose) {
  if (typeof raw !== 'string' || raw.length < 32 || raw.length > 200) return null;
  const result = await sql`
    select id, user_id, used_at is not null as used, expires_at < now() as expired
    from auth_tokens
    where token_hash = ${hashToken(raw)} and purpose = ${purpose}
  `;
  return result.rows[0] || null;
}

// Marks a token as used. Returns true only for the one caller that won,
// so a link cannot be used twice even if two requests arrive together.
export async function consumeToken(id) {
  const result = await sql`
    update auth_tokens set used_at = now()
    where id = ${id} and used_at is null
    returning id
  `;
  return result.rows.length > 0;
}
