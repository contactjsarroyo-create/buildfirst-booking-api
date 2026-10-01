import { withAlerts } from '../_lib/alerts.js';
import { sql } from '@vercel/postgres';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { setCors, getAuth } from '../_lib/helpers.js';
import { resolveAccount, publicAccount } from '../_lib/limits.js';
import { issueToken, findToken, consumeToken } from '../_lib/authtokens.js';
import { appLink, sendEmail, verificationEmail, resetEmail } from '../_lib/email.js';

// Vercel Hobby allows 12 functions and they are all used, so this one file
// handles every "existing account" auth action. The body's `action` picks one:
//   (none) or "login"  sign in
//   "verify"           confirm an email address from the link token
//   "resend"           send a new verification email
//   "forgot"           send a password reset email
//   "reset"            set a new password from the link token
// Signed-in actions (need the login token), used by Account Settings:
//   "profile"          the person's email, role and display name
//   "update_profile"   save the display name
//   "change_password"  change the password (needs the current one)

const MIN_PASSWORD_LENGTH = 8;

function cleanEmail(value) {
  // Signup stores emails lowercased, so compare lowercased here too.
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

async function findUserByEmail(email) {
  const result = await sql`
    select id, email, email_verified_at
    from tenant_users
    where lower(email) = ${email}
    limit 1
  `;
  return result.rows[0] || null;
}

async function handleLogin(body, res) {
  const password = typeof body.password === 'string' ? body.password : '';
  const email = cleanEmail(body.email);

  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'email and password are required' });
  }

  const userResult = await sql`
    SELECT u.id, u.tenant_id, u.email, u.role, u.password_hash, u.email_verified_at,
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

  // Only checked after the password is right, so this cannot be used to
  // find out which emails have accounts.
  if (!user.email_verified_at) {
    return res.status(403).json({
      ok: false,
      code: 'email_not_verified',
      error: 'Please confirm your email first. Check your inbox for the link.',
    });
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
}

async function handleVerify(body, res) {
  const token = typeof body.token === 'string' ? body.token : '';
  const record = await findToken(token, 'verify');

  if (!record) {
    return res.status(400).json({ ok: false, code: 'invalid_link', error: 'This link is not valid.' });
  }

  // Link already used (for example a mail scanner opened it first). If the
  // email is verified, that is a success from the person's point of view.
  if (record.used) {
    const check = await sql`
      select 1 from tenant_users where id::text = ${record.user_id} and email_verified_at is not null
    `;
    if (check.rows.length > 0) return res.status(200).json({ ok: true });
    return res.status(400).json({ ok: false, code: 'invalid_link', error: 'This link has already been used.' });
  }

  if (record.expired) {
    return res.status(400).json({ ok: false, code: 'expired', error: 'This link has expired. Request a new one below.' });
  }

  if (!(await consumeToken(record.id))) {
    return res.status(200).json({ ok: true });
  }

  await sql`
    update tenant_users set email_verified_at = now()
    where id::text = ${record.user_id} and email_verified_at is null
  `;
  return res.status(200).json({ ok: true });
}

// The two "send me an email" actions always answer the same way, whether or
// not the address has an account, so they cannot be used to look up emails.
async function handleResend(body, res) {
  const email = cleanEmail(body.email);
  if (!email) return res.status(400).json({ ok: false, error: 'Enter your email address' });

  const user = await findUserByEmail(email);
  if (user && !user.email_verified_at) {
    const issued = await issueToken(user.id, 'verify');
    if (issued.token) {
      const mail = verificationEmail(appLink({ verify: issued.token }));
      await sendEmail({ to: user.email, ...mail });
    }
  }

  return res.status(200).json({
    ok: true,
    message: 'If that account needs confirming, a new link is on its way. You can request another one after a minute.',
  });
}

async function handleForgot(body, res) {
  const email = cleanEmail(body.email);
  if (!email) return res.status(400).json({ ok: false, error: 'Enter your email address' });

  const user = await findUserByEmail(email);
  if (user) {
    const issued = await issueToken(user.id, 'reset');
    if (issued.token) {
      const mail = resetEmail(appLink({ reset: issued.token }));
      await sendEmail({ to: user.email, ...mail });
    }
  }

  return res.status(200).json({
    ok: true,
    message: 'If an account exists for that email, a reset link is on its way. You can request another one after a minute.',
  });
}

async function handleReset(body, res) {
  const token = typeof body.token === 'string' ? body.token : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }

  const record = await findToken(token, 'reset');
  if (!record || record.used) {
    return res.status(400).json({ ok: false, code: 'invalid_link', error: 'This reset link is not valid or was already used. Request a new one.' });
  }
  if (record.expired) {
    return res.status(400).json({ ok: false, code: 'expired', error: 'This reset link has expired. Request a new one.' });
  }

  // Hash first so a failure here does not burn the link.
  const passwordHash = await bcrypt.hash(password, 10);

  if (!(await consumeToken(record.id))) {
    return res.status(400).json({ ok: false, code: 'invalid_link', error: 'This reset link was already used. Request a new one.' });
  }

  // Opening the emailed link also proves the person owns the inbox, so an
  // unconfirmed account becomes confirmed here too.
  await sql`
    update tenant_users
    set password_hash = ${passwordHash},
        email_verified_at = coalesce(email_verified_at, now())
    where id::text = ${record.user_id}
  `;
  await sql`delete from auth_tokens where user_id = ${record.user_id} and purpose = 'reset'`;

  return res.status(200).json({ ok: true });
}

// ------------------------------------------------------------
// Signed-in account actions. They answer 401 only when the login token is
// bad (the dashboard then sends the person to sign in). A wrong current
// password is a 400, so it never logs them out.
// ------------------------------------------------------------
async function handleProfile(req, res) {
  const auth = await getAuth(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'Please sign in again' });

  let row;
  try {
    const r = await sql`
      select email, role, display_name from tenant_users
      where id::text = ${String(auth.user_id)} limit 1
    `;
    row = r.rows[0];
  } catch (colErr) {
    // display_name column not added yet: still show email and role.
    const r = await sql`
      select email, role from tenant_users
      where id::text = ${String(auth.user_id)} limit 1
    `;
    row = r.rows[0];
  }
  if (!row) return res.status(401).json({ ok: false, error: 'Please sign in again' });

  return res.status(200).json({
    ok: true,
    email: row.email,
    role: row.role,
    display_name: row.display_name || '',
  });
}

async function handleUpdateProfile(req, body, res) {
  const auth = await getAuth(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'Please sign in again' });

  const name = typeof body.display_name === 'string'
    ? body.display_name.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
    : '';

  try {
    await sql`
      update tenant_users set display_name = ${name || null}
      where id::text = ${String(auth.user_id)}
    `;
  } catch (colErr) {
    console.error('update_profile failed (display_name column missing?)', colErr && colErr.message);
    return res.status(500).json({ ok: false, error: 'Could not save your name yet. The account update has not been installed.' });
  }
  return res.status(200).json({ ok: true, display_name: name });
}

async function handleChangePassword(req, body, res) {
  const auth = await getAuth(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'Please sign in again' });

  const current = typeof body.current_password === 'string' ? body.current_password : '';
  const next = typeof body.new_password === 'string' ? body.new_password : '';

  if (!current) return res.status(400).json({ ok: false, error: 'Enter your current password' });
  if (next.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ ok: false, error: `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }

  const r = await sql`
    select password_hash from tenant_users
    where id::text = ${String(auth.user_id)} limit 1
  `;
  if (r.rows.length === 0) return res.status(401).json({ ok: false, error: 'Please sign in again' });

  const matches = await bcrypt.compare(current, r.rows[0].password_hash);
  if (!matches) return res.status(400).json({ ok: false, error: 'Your current password is not right.' });
  if (current === next) {
    return res.status(400).json({ ok: false, error: 'Choose a password that is different from your current one.' });
  }

  const passwordHash = await bcrypt.hash(next, 10);
  await sql`
    update tenant_users set password_hash = ${passwordHash}
    where id::text = ${String(auth.user_id)}
  `;
  // Any reset link sent earlier should not work any more.
  await sql`delete from auth_tokens where user_id = ${String(auth.user_id)} and purpose = 'reset'`;

  return res.status(200).json({ ok: true });
}

async function handler(req, res) {
  if (setCors(req, res, 'POST, OPTIONS')) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const body = req.body || {};
  const action = typeof body.action === 'string' ? body.action : 'login';

  try {
    switch (action) {
      case 'login':
        return await handleLogin(body, res);
      case 'verify':
        return await handleVerify(body, res);
      case 'resend':
        return await handleResend(body, res);
      case 'forgot':
        return await handleForgot(body, res);
      case 'reset':
        return await handleReset(body, res);
      case 'profile':
        return await handleProfile(req, res);
      case 'update_profile':
        return await handleUpdateProfile(req, body, res);
      case 'change_password':
        return await handleChangePassword(req, body, res);
      default:
        return res.status(400).json({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

export default withAlerts('login', handler);
