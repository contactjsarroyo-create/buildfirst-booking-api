// Booking emails: the guest's "we got your booking" and "confirmed" emails and
// the owner's "new booking" alert.
//
// Everything here is best effort and NEVER throws. A mail problem must never
// fail or lose a booking. Every send is written to the email_log table, and the
// tenant's monthly plan cap (limits.js, "emails") is counted from that log.
//
// Per-tenant switches live in tenant_settings.email_config (jsonb):
//   { notify_email, owner_new, guest_received, guest_confirmed }
// A missing key means "on". notify_email overrides the owner's login email.

import { sql } from '@vercel/postgres';
import { sendEmail, appLink } from './email.js';
import { getAccount, countEmailsThisMonth } from './limits.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_COLOR = '#3b82f6';

// Vercel Hobby kills a function after 10 seconds. The caller waits at most this
// long for mail so a slow provider can never turn a saved booking into an error.
export const EMAIL_WAIT_MS = 4000;
const SEND_TIMEOUT_MS = 3500;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LEGACY_CHANNEL_NAMES = {
  bank_transfer: 'Bank transfer',
  gcash: 'GCash',
  maya: 'Maya',
  qr_code: 'QR code',
  paymongo: 'Online payment',
};

// Resolves to whatever `promise` resolves to, or to undefined after `ms`.
export function withTimeout(promise, ms = EMAIL_WAIT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------
function esc(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function oneLine(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function validEmail(v) {
  return typeof v === 'string' && v.length <= 200 && EMAIL_RE.test(v.trim());
}

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

// A DATE column can come back as a Date (built in the server's local time) or a string.
function ymd(v) {
  if (!v) return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

function prettyDate(v) {
  const s = ymd(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return `${DAYS[wd]}, ${MONTHS[mo - 1]} ${d}, ${y}`;
}

function prettyTime(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  if (!m) return '';
  let h = Number(m[1]);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`;
}

function nightsOf(booking) {
  if (booking.nights !== undefined && booking.nights !== null && Number(booking.nights) > 0) {
    return Number(booking.nights);
  }
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd(booking.check_in));
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd(booking.check_out));
  if (!a || !b) return null;
  const diff = Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3]);
  return Math.round(diff / 86400000);
}

function money(amount, currency) {
  const v = Number(amount) || 0;
  const [whole, dec] = v.toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cur = String(currency || 'PHP').toUpperCase();
  const symbol = cur === 'PHP' ? '₱' : cur === 'USD' ? '$' : cur + ' ';
  return `${symbol}${grouped}.${dec}`;
}

function shortRef(id) {
  return String(id || '').slice(0, 8).toUpperCase();
}

function channelName(key, channel) {
  if (channel && channel.name) return channel.name;
  return LEGACY_CHANNEL_NAMES[key] || 'Manual payment';
}

// ------------------------------------------------------------
// HTML + plain text rendering
// ------------------------------------------------------------
// rows:   [[label, value], ...]      blocks: [{ title, lines: [...] }, ...]
// Every value is escaped here, so callers pass raw text.
function render({ brand, color, heading, intro, rows, blocks, button, footer }) {
  const accent = HEX_RE.test(color || '') ? color : DEFAULT_COLOR;

  const rowsHtml = (rows || [])
    .filter((r) => r[1] !== undefined && r[1] !== null && String(r[1]) !== '')
    .map(
      (r, i) =>
        `<tr><td style="padding:9px 14px 9px 0;font-size:13px;color:#6b7280;vertical-align:top;width:36%;${i === 0 ? '' : 'border-top:1px solid #eef0f3;'}">${esc(
          r[0]
        )}</td><td style="padding:9px 0;font-size:13.5px;font-weight:600;color:#111827;vertical-align:top;${i === 0 ? '' : 'border-top:1px solid #eef0f3;'}">${esc(
          r[1]
        ).replace(/\n/g, '<br>')}</td></tr>`
    )
    .join('');

  const blocksHtml = (blocks || [])
    .filter((b) => b && b.lines && b.lines.length)
    .map(
      (b) =>
        `<div style="background:#f7f7fa;border-radius:12px;padding:14px 16px;margin:16px 0 0 0;"><div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:6px;">${esc(
          b.title
        )}</div>${b.lines
          .map((l) => `<div style="font-size:13px;line-height:1.6;color:#374151;">${esc(l).replace(/\n/g, '<br>')}</div>`)
          .join('')}</div>`
    )
    .join('');

  const buttonHtml = button
    ? `<div style="margin:24px 0 0 0;"><a href="${esc(button.link)}" style="display:inline-block;background:#3b82f6;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;">${esc(
        button.label
      )}</a></div>`
    : '';

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#111827;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;">
      <div style="height:4px;background:${accent};"></div>
      <div style="padding:28px 32px 32px 32px;">
        <div style="font-size:12px;font-weight:700;letter-spacing:1.5px;color:#6b7280;text-transform:uppercase;margin-bottom:14px;">${esc(brand)}</div>
        <h1 style="font-size:20px;line-height:1.3;margin:0 0 10px 0;">${esc(heading)}</h1>
        <p style="font-size:14px;line-height:1.6;margin:0 0 20px 0;color:#374151;">${esc(intro)}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${rowsHtml}</table>
        ${blocksHtml}
        ${buttonHtml}
        <p style="font-size:12px;line-height:1.6;margin:24px 0 0 0;color:#6b7280;">${esc(footer)}</p>
      </div>
    </div>
  </body>
</html>`;

  const textParts = [heading, '', intro, ''];
  (rows || [])
    .filter((r) => r[1] !== undefined && r[1] !== null && String(r[1]) !== '')
    .forEach((r) => textParts.push(`${r[0]}: ${r[1]}`));
  (blocks || [])
    .filter((b) => b && b.lines && b.lines.length)
    .forEach((b) => {
      textParts.push('', b.title);
      b.lines.forEach((l) => textParts.push(l));
    });
  if (button) textParts.push('', `${button.label}: ${button.link}`);
  textParts.push('', footer);

  return { html, text: textParts.join('\n') };
}

// ------------------------------------------------------------
// Loading what the emails need. Each lookup is independent and
// falls back to "nothing", so one missing table or column costs
// a line in the email, never the whole email.
// ------------------------------------------------------------
async function safe(label, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    console.error(`bookingEmails: ${label} lookup failed`, err && err.message);
    return fallback;
  }
}

async function loadContext(tenantId, booking) {
  const [tenant, settings, owner, unitType, room, addons] = await Promise.all([
    safe('tenant', async () => (await sql`select name, currency from tenants where id = ${tenantId}`).rows[0] || {}, {}),
    safe(
      'settings',
      async () =>
        (
          await sql`
            select primary_color, checkin_time::text as checkin_time, checkout_time::text as checkout_time,
                   cancellation_policy, payment_channels, custom_fields, email_config
            from tenant_settings where tenant_id = ${tenantId}
          `
        ).rows[0] || {},
      {}
    ),
    safe('owner', async () => (await sql`select email from tenant_users where tenant_id = ${tenantId} limit 1`).rows[0] || {}, {}),
    booking.unit_type_id
      ? safe(
          'room type',
          async () => (await sql`select name from unit_types where id = ${booking.unit_type_id}`).rows[0] || {},
          {}
        )
      : Promise.resolve({}),
    booking.room_id
      ? safe('room', async () => (await sql`select label from rooms where id = ${booking.room_id}`).rows[0] || {}, {})
      : Promise.resolve({}),
    safe(
      'add-ons',
      async () =>
        (
          await sql`
            select a.name, ba.quantity
            from booking_addons ba join addons a on a.id = ba.addon_id
            where ba.booking_id = ${booking.id}
          `
        ).rows,
      []
    ),
  ]);

  const config = settings.email_config && typeof settings.email_config === 'object' ? settings.email_config : {};
  const notify = validEmail(config.notify_email) ? config.notify_email.trim() : null;
  const ownerTo = notify || (validEmail(owner.email) ? owner.email.trim() : null);

  return {
    resort: oneLine(tenant.name) || 'the resort',
    currency: tenant.currency || 'PHP',
    color: settings.primary_color,
    checkinTime: prettyTime(settings.checkin_time),
    checkoutTime: prettyTime(settings.checkout_time),
    cancellationPolicy: settings.cancellation_policy || '',
    channels: settings.payment_channels && typeof settings.payment_channels === 'object' ? settings.payment_channels : {},
    customFields: Array.isArray(settings.custom_fields) ? settings.custom_fields : [],
    config,
    ownerTo,
    roomType: unitType.name || '',
    roomLabel: room.label || '',
    addons: Array.isArray(addons) ? addons : [],
  };
}

// ------------------------------------------------------------
// Building the messages
// ------------------------------------------------------------
function addonsText(ctx) {
  return ctx.addons
    .filter((a) => a && a.name)
    .map((a) => (Number(a.quantity) > 1 ? `${a.name} x${a.quantity}` : a.name))
    .join(', ');
}

function paymentBlock(booking, ctx) {
  const key = booking.payment_channel;
  if (!key) return null;
  if (booking.payment_status === 'paid') {
    return { title: 'Payment', lines: ['Payment received. Thank you.'] };
  }
  if (key === 'paymongo') {
    return { title: 'Payment', lines: ['Payment method: Online payment (PayMongo).'] };
  }
  const ch = ctx.channels[key];
  const lines = [`Pay to: ${channelName(key, ch)}`];
  if (ch && ch.account_name) lines.push(`Account name: ${ch.account_name}`);
  if (ch && ch.account_number) lines.push(`Account number: ${ch.account_number}`);
  if (ch && ch.instructions) lines.push(ch.instructions);
  if (booking.payment_reference) lines.push(`Your reference: ${booking.payment_reference}`);
  return { title: 'How to pay', lines };
}

function guestRows(booking, ctx) {
  const nights = nightsOf(booking);
  const inTime = ctx.checkinTime ? ` (from ${ctx.checkinTime})` : '';
  const outTime = ctx.checkoutTime ? ` (by ${ctx.checkoutTime})` : '';
  const rows = [
    ['Booking reference', shortRef(booking.id)],
    ['Room', ctx.roomType],
    ['Check-in', prettyDate(booking.check_in) + inTime],
    ['Check-out', prettyDate(booking.check_out) + outTime],
    ['Nights', nights],
    ['Guests', booking.guests],
    ['Add-ons', addonsText(ctx)],
  ];
  if (Number(booking.discount_amount) > 0) {
    rows.push(['Discount', '-' + money(booking.discount_amount, ctx.currency)]);
  }
  rows.push(['Total', money(booking.total_amount, ctx.currency)]);
  return rows;
}

function guestBlocks(booking, ctx, { withPayment }) {
  const blocks = [];
  if (withPayment) {
    const pay = paymentBlock(booking, ctx);
    if (pay) blocks.push(pay);
  }
  if (booking.special_requests) {
    blocks.push({ title: 'Your request', lines: [String(booking.special_requests)] });
  }
  if (ctx.cancellationPolicy) {
    blocks.push({ title: 'Cancellation policy', lines: [String(ctx.cancellationPolicy)] });
  }
  return blocks;
}

function firstName(booking) {
  return oneLine(booking.guest_name).split(' ')[0] || 'there';
}

function guestFooter(ctx) {
  return `Questions? Just reply to this email and it will go to ${ctx.resort}. Sent for ${ctx.resort} through Buildfirst.`;
}

function guestReceivedMessage(booking, ctx) {
  const body = render({
    brand: ctx.resort,
    color: ctx.color,
    heading: `Thanks ${firstName(booking)}, we got your booking`,
    intro: `${ctx.resort} will review it and email you again once it is confirmed. Until then, this is a request and your dates are not guaranteed.`,
    rows: guestRows(booking, ctx),
    blocks: guestBlocks(booking, ctx, { withPayment: true }),
    footer: guestFooter(ctx),
  });
  return { subject: oneLine(`We received your booking at ${ctx.resort}`), ...body };
}

function guestConfirmedMessage(booking, ctx) {
  const body = render({
    brand: ctx.resort,
    color: ctx.color,
    heading: `You're booked, ${firstName(booking)}`,
    intro: `${ctx.resort} has confirmed your booking. Here are your details.`,
    rows: guestRows(booking, ctx),
    blocks: guestBlocks(booking, ctx, { withPayment: true }),
    footer: guestFooter(ctx),
  });
  return { subject: oneLine(`Your booking at ${ctx.resort} is confirmed`), ...body };
}

function ownerAnswers(booking, ctx) {
  const answers = booking.custom_field_responses && typeof booking.custom_field_responses === 'object' ? booking.custom_field_responses : {};
  const rows = [];
  for (const field of ctx.customFields) {
    if (!field || !field.key) continue;
    const raw = answers[field.key];
    if (raw === undefined || raw === null || raw === '') continue;
    let value;
    if (field.type === 'image_upload') value = 'Photo uploaded (open the booking in your dashboard to view it)';
    else if (field.type === 'checkbox') value = raw === true ? 'Yes' : 'No';
    else value = String(raw);
    rows.push([field.label || field.key, value]);
  }
  return rows;
}

function ownerNewBookingMessage(booking, ctx) {
  const nights = nightsOf(booking);
  const room = ctx.roomLabel ? `${ctx.roomType} (${ctx.roomLabel})` : ctx.roomType;
  const ch = booking.payment_channel ? ctx.channels[booking.payment_channel] : null;
  const rows = [
    ['Guest', oneLine(booking.guest_name)],
    ['Email', booking.guest_email],
    ['Phone', booking.guest_phone],
    ['Room', room],
    ['Check-in', prettyDate(booking.check_in)],
    ['Check-out', prettyDate(booking.check_out)],
    ['Nights', nights],
    ['Guests', booking.guests],
    ['Add-ons', addonsText(ctx)],
    ['Total', money(booking.total_amount, ctx.currency)],
    ['Payment method', booking.payment_channel ? channelName(booking.payment_channel, ch) : ''],
    ['Payment reference', booking.payment_reference],
    ['Special requests', booking.special_requests],
    ...ownerAnswers(booking, ctx),
    ['Booking reference', shortRef(booking.id)],
  ];
  const body = render({
    brand: 'Buildfirst',
    color: ctx.color,
    heading: `New booking from ${oneLine(booking.guest_name)}`,
    intro: `${ctx.resort} has a new booking. It is pending until you confirm it in your dashboard.`,
    rows,
    blocks: [],
    button: { label: 'Open dashboard', link: appLink({}) },
    footer: 'Reply to this email to write to the guest directly. You can turn these alerts off or change where they go under Account Settings.',
  });
  return { subject: oneLine(`New booking: ${booking.guest_name} (${ymd(booking.check_in)} to ${ymd(booking.check_out)})`), ...body };
}

// ------------------------------------------------------------
// Sending, with the monthly plan cap and the log
// ------------------------------------------------------------
async function logEmail(tenantId, kind, to, status) {
  try {
    await sql`
      insert into email_log (tenant_id, kind, to_email, status)
      values (${tenantId}, ${kind}, ${to}, ${status})
    `;
  } catch (err) {
    console.error('bookingEmails: could not write email_log', err && err.message);
  }
}

// jobs: [{ kind, to, message, fromName, replyTo }] in priority order: when the
// cap runs out, the first jobs win. Returns how many were actually sent.
async function sendJobs(tenantId, account, jobs) {
  let limit = Number(account && account.limits && account.limits.emails);
  if (!Number.isFinite(limit)) limit = Infinity;
  let used = await countEmailsThisMonth(tenantId);

  const runnable = [];
  const skipped = [];
  for (const job of jobs) {
    if (used < limit) {
      runnable.push(job);
      used += 1;
    } else {
      skipped.push(job);
    }
  }

  let sent = 0;
  await Promise.all([
    ...runnable.map(async (job) => {
      const r = await sendEmail({
        to: job.to,
        subject: job.message.subject,
        html: job.message.html,
        text: job.message.text,
        fromName: job.fromName,
        replyTo: job.replyTo,
        timeoutMs: SEND_TIMEOUT_MS,
      });
      if (r.ok) sent += 1;
      await logEmail(tenantId, job.kind, job.to, r.ok ? 'sent' : 'failed');
    }),
    ...skipped.map((job) => logEmail(tenantId, job.kind, job.to, 'skipped_limit')),
  ]);
  return sent;
}

// ------------------------------------------------------------
// Public entry points
// ------------------------------------------------------------

// Called right after a guest's booking is saved. Owner alert first, so it wins
// if the plan's email cap is nearly used up.
export async function sendBookingCreatedEmails(tenantId, booking, accountIn) {
  try {
    const account = accountIn || (await getAccount(tenantId));
    if (!account || !account.can_book) return;
    const ctx = await loadContext(tenantId, booking);

    const jobs = [];
    if (ctx.config.owner_new !== false && ctx.ownerTo) {
      jobs.push({
        kind: 'owner_new_booking',
        to: ctx.ownerTo,
        message: ownerNewBookingMessage(booking, ctx),
        replyTo: validEmail(booking.guest_email) ? booking.guest_email.trim() : undefined,
      });
    }
    if (ctx.config.guest_received !== false && validEmail(booking.guest_email)) {
      jobs.push({
        kind: 'guest_received',
        to: booking.guest_email.trim(),
        message: guestReceivedMessage(booking, ctx),
        fromName: `${ctx.resort} via Buildfirst`,
        replyTo: ctx.ownerTo || undefined,
      });
    }
    if (jobs.length === 0) return;
    await sendJobs(tenantId, account, jobs);
  } catch (err) {
    console.error('bookingEmails: created emails failed', err && err.message);
  }
}

// Called when the owner sets a booking to confirmed. Sends at most once per
// booking (bookings.confirmed_email_sent_at is claimed before sending, and put
// back if nothing could be sent). Returns true if the guest was emailed.
export async function sendBookingConfirmedEmail(tenantId, bookingId) {
  try {
    const found = await sql`select * from bookings where id = ${bookingId} and tenant_id = ${tenantId}`;
    const booking = found.rows[0];
    if (!booking || booking.status !== 'confirmed' || booking.confirmed_email_sent_at) return false;
    if (!validEmail(booking.guest_email)) return false;

    const account = await getAccount(tenantId);
    if (!account || !account.can_book) return false;

    const ctx = await loadContext(tenantId, booking);
    if (ctx.config.guest_confirmed === false) return false;

    const claim = await sql`
      update bookings set confirmed_email_sent_at = now()
      where id = ${booking.id} and tenant_id = ${tenantId} and confirmed_email_sent_at is null
      returning id
    `;
    if (claim.rows.length === 0) return false;

    const sent = await sendJobs(tenantId, account, [
      {
        kind: 'guest_confirmed',
        to: booking.guest_email.trim(),
        message: guestConfirmedMessage(booking, ctx),
        fromName: `${ctx.resort} via Buildfirst`,
        replyTo: ctx.ownerTo || undefined,
      },
    ]);
    if (sent === 0) {
      await sql`
        update bookings set confirmed_email_sent_at = null
        where id = ${booking.id} and tenant_id = ${tenantId}
      `;
    }
    return sent > 0;
  } catch (err) {
    console.error('bookingEmails: confirmed email failed', err && err.message);
    return false;
  }
}
