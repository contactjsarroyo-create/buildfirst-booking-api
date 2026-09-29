import { sql } from '@vercel/postgres';
import bcrypt from 'bcryptjs';
import { setCors, text } from '../_lib/helpers.js';
import { issueToken } from '../_lib/authtokens.js';
import { appLink, sendEmail, verificationEmail } from '../_lib/email.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PLAN_WHITELIST = ['starter', 'growth', 'pro'];
// Keep in sync with TRIAL_DAYS in DashboardSignup.tsx.
// The trial runs on Starter limits; `plan` below is the plan they move to after it.
const TRIAL_DAYS = 7;

function slugify(name) {
  const base = String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'resort';
}

// Finds a slug that isn't taken yet, trying "base", then "base-2", "base-3", ...
async function findAvailableSlug(base) {
  for (let i = 0; i < 30; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const existing = await sql`select 1 from tenants where slug = ${candidate}`;
    if (existing.rows.length === 0) return candidate;
  }
  return null;
}

export default async function handler(req, res) {
  if (setCors(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const b = req.body || {};
    const resortName = text(b.resort_name);
    const email = text(b.email) ? text(b.email).toLowerCase() : null;
    const password = typeof b.password === 'string' ? b.password : '';
    const plan = PLAN_WHITELIST.includes(b.plan) ? b.plan : 'starter';

    if (!resortName || !email || !password) {
      return res.status(400).json({ ok: false, error: 'Resort name, email and password are required' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid email address' });
    }
    if (password.length < 8) {
      return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
    }

    const existingUser = await sql`select id from tenant_users where lower(email) = ${email}`;
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ ok: false, error: 'An account with this email already exists' });
    }

    const slug = await findAvailableSlug(slugify(resortName));
    if (!slug) {
      return res.status(400).json({ ok: false, error: 'Could not generate a unique address for this resort name, try a different name' });
    }

    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const passwordHash = await bcrypt.hash(password, 10);

    const tenantResult = await sql`
      insert into tenants (slug, name, plan, status, timezone, currency, trial_ends_at, created_at, updated_at)
      values (${slug}, ${resortName}, ${plan}, 'onboarding', 'Asia/Manila', 'PHP', ${trialEndsAt.toISOString()}::timestamptz, now(), now())
      returning id, slug
    `;
    const tenant = tenantResult.rows[0];

    const userResult = await sql`
      insert into tenant_users (tenant_id, email, role, password_hash, created_at)
      values (${tenant.id}, ${email}, 'owner', ${passwordHash}, now())
      returning id
    `;
    const userId = userResult.rows[0].id;

    // No login token yet: the account has to confirm its email first.
    // If the email fails to send, the account still exists and the person can
    // request another link from the login page ("resend").
    let emailSent = false;
    const issued = await issueToken(userId, 'verify');
    if (issued.token) {
      const mail = verificationEmail(appLink({ verify: issued.token }));
      const sent = await sendEmail({ to: email, ...mail });
      emailSent = sent.ok;
    }

    return res.status(201).json({
      ok: true,
      needs_verification: true,
      email_sent: emailSent,
      email,
      slug: tenant.slug,
      trial_ends_at: trialEndsAt.toISOString(),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
