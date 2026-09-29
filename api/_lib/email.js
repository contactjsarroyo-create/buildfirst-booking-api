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

// Returns { ok: true } or { ok: false, error }. Never throws.
export async function sendEmail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('sendEmail: RESEND_API_KEY is not set');
    return { ok: false, error: 'not_configured' };
  }

  const from = process.env.EMAIL_FROM || 'Buildfirst <onboarding@resend.dev>';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
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
