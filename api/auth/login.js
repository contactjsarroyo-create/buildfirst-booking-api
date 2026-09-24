import { sql } from '@vercel/postgres';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'email and password are required' });
  }

  try {
    const userResult = await sql`
      SELECT id, tenant_id, email, role, password_hash
      FROM tenant_users
      WHERE email = ${email}
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

    return res.status(200).json({
      ok: true,
      token,
      tenant_id: user.tenant_id,
      role: user.role,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
