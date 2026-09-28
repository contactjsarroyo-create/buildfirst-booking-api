import { sql } from '@vercel/postgres';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { setCors } from '../_lib/helpers.js';
import { resolveAccount, publicAccount } from '../_lib/limits.js';

export default async function handler(req, res) {
  if (setCors(req, res, 'POST, OPTIONS')) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const body = req.body || {};
  const password = typeof body.password === 'string' ? body.password : '';
  // Signup stores emails lowercased, so compare lowercased here too.
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'email and password are required' });
  }

  try {
    const userResult = await sql`
      SELECT u.id, u.tenant_id, u.email, u.role, u.password_hash,
             t.plan, t.status, t.trial_ends_at, t.storage_bytes::float8 AS storage_bytes
      FROM tenant_users u
      JOIN tenants t ON t.id = u.tenant_id
      WHERE lower(u.email) = ${email}
    `;

    if (userResult.rows.length === 0) {
      return res.status(401).json({ ok: false, error: 'Invalid email or password' });
    }

    const user = userResult.rows[0];
    const passwordMatches = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatches) {
      return res.status(401).json({ ok: false, error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { tenant_id: user.tenant_id, user_id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Login is never blocked by an expired trial: the owner can still get in
    // to see their bookings. The dashboard uses `account.state` to show the
    // trial banner or the "pick a plan" screen.
    const account = resolveAccount({ id: user.tenant_id, ...user });

    return res.status(200).json({
      ok: true,
      token,
      tenant_id: user.tenant_id,
      role: user.role,
      account: publicAccount(account),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
