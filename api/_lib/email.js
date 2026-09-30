// Sends transactional email through Resend's HTTP API (no npm package needed).
//
// Env vars (Vercel > Settings > Environment Variables):
//   RESEND_API_KEY  required. Create it in the Resend dashboard.
//   EMAIL_FROM      the sender, e.g.  Buildfirst <no-reply@buildfirst.digital>
//                   The domain must be verified in Resend, otherwise Resend
//                   only delivers to your own Resend account email.
//   APP_URL         the full URL of the Framer login page that email links
//                   open, e.g.  https://yoursite.com/dashboard

const DEFAULT_APP_URL = 'https://grounded-operations-212858.framer.app/dashboard';
const SEND_TIMEOUT_MS = 8000;

// Builds a link to the login page with query params, e.g. ?verify=TOKEN
export function appLink(params) {
  const url = new URL(process.env.APP_URL || DEFAULT_APP_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

// Builds the From header. With a fromName the sender shows as
// "Sunset Cove via Buildfirst" but still uses the verified address from EMAIL_FROM.
function buildFrom(fromName) {
  const base = process.env.EMAIL_FROM || 'Buildfirst <onboarding@resend.dev>';
  if (!fromName) return base;
  const match = /<([^>]+)>/.exec(base);
  const address = (match ? match[1] : base).trim();
  const name = String(fromName)
    .replace(/["<>\\\r\n]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  if (!name) return base;
  return `"${name}" <${address}>`;
}

// Returns { ok: true } or { ok: false, error }. Never throws.
//   replyTo    optional address replies should go to
//   fromName   optional display name for the sender
//   timeoutMs  optional, defaults to 8 seconds
export async function sendEmail({ to, subject, html, text, replyTo, fromName, timeoutMs }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('sendEmail: RESEND_API_KEY is not set');
    return { ok: false, error: 'not_configured' };
  }

  const from = buildFrom(fromName);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || SEND_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html,
        text,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`sendEmail: Resend returned ${res.status}: ${detail}`);
      return { ok: false, error: `resend_${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error('sendEmail: request failed', err && err.message);
    return { ok: false, error: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

function layout(heading, intro, buttonLabel, link, footnote) {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#111827;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <div style="font-size:12px;font-weight:700;letter-spacing:1.5px;color:#3b82f6;margin-bottom:16px;">BUILDFIRST</div>
      <h1 style="font-size:20px;margin:0 0 12px 0;">${heading}</h1>
      <p style="font-size:14px;line-height:1.6;margin:0 0 24px 0;color:#374151;">${intro}</p>
      <a href="${link}" style="display:inline-block;background:#3b82f6;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;">${buttonLabel}</a>
      <p style="font-size:12px;line-height:1.6;margin:24px 0 0 0;color:#6b7280;">${footnote}</p>
      <p style="font-size:12px;line-height:1.6;margin:12px 0 0 0;color:#6b7280;">If the button does not work, copy this link into your browser:<br><span style="word-break:break-all;">${link}</span></p>
    </div>
  </body>
</html>`;
}

export function verificationEmail(link) {
  return {
    subject: 'Confirm your email for Buildfirst',
    html: layout(
      'Confirm your email',
      'Thanks for signing up. Tap the button below to confirm your email address and activate your account.',
      'Confirm email',
      link,
      'This link expires in 24 hours. If you did not create a Buildfirst account, you can ignore this email.'
    ),
    text:
      `Confirm your email for Buildfirst\n\n` +
      `Thanks for signing up. Open this link to confirm your email address and activate your account:\n${link}\n\n` +
      `This link expires in 24 hours. If you did not create a Buildfirst account, you can ignore this email.`,
  };
}

export function resetEmail(link) {
  return {
    subject: 'Reset your Buildfirst password',
    html: layout(
      'Reset your password',
      'We got a request to reset the password for your Buildfirst account. Tap the button below to choose a new one.',
      'Choose a new password',
      link,
      'This link expires in 1 hour and can only be used once. If you did not ask for this, you can ignore this email and your password will stay the same.'
    ),
    text:
      `Reset your Buildfirst password\n\n` +
      `We got a request to reset the password for your Buildfirst account. Open this link to choose a new one:\n${link}\n\n` +
      `This link expires in 1 hour and can only be used once. If you did not ask for this, you can ignore this email and your password will stay the same.`,
  };
}

function esc(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Sent when an owner adds a staff login. The link opens the same page as
// "reset password", where the person chooses their own password.
export function staffInviteEmail(link, resortName) {
  const name = String(resortName || 'a resort').slice(0, 100);
  return {
    subject: `You have been invited to ${name} on Buildfirst`,
    html: layout(
      `Join ${esc(name)}`,
      `You have been invited to help manage bookings for ${esc(name)}. Tap the button below to choose your password and log in.`,
      'Choose my password',
      link,
      'This link expires in 7 days and can only be used once. If you were not expecting this, you can ignore this email.'
    ),
    text:
      `You have been invited to ${name} on Buildfirst\n\n` +
      `You have been invited to help manage bookings for ${name}. Open this link to choose your password and log in:\n${link}\n\n` +
      `This link expires in 7 days and can only be used once. If you were not expecting this, you can ignore this email.`,
  };
}
