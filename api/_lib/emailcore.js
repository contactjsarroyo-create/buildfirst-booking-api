// Email template core: the defaults, the placeholder filling, the settings
// sanitizer and the HTML/text renderer used by booking emails.
//
// Pure functions only (no database, no network). The dashboard's "Booking
// Emails" editor contains a copy of the render section below (from
// "RENDER START" to "RENDER END") so its live preview is built by the same code
// that builds the real emails. Keep the two in step.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const URL_RE = /^https?:\/\/\S+$/i;
export const DEFAULT_COLOR = '#3b82f6';

export const EMAIL_KINDS = ['guest_received', 'guest_confirmed', 'owner_new'];

// Words a resort can drop into any text field, written like {guest_name}.
export const PLACEHOLDERS = [
  { key: 'guest_name', label: 'Guest name' },
  { key: 'first_name', label: 'Guest first name' },
  { key: 'resort_name', label: 'Resort name' },
  { key: 'reference', label: 'Booking reference' },
  { key: 'room', label: 'Room' },
  { key: 'check_in', label: 'Check-in date' },
  { key: 'check_out', label: 'Check-out date' },
  { key: 'nights', label: 'Number of nights' },
  { key: 'guests', label: 'Number of guests' },
  { key: 'total', label: 'Total amount' },
];

const GUEST_CLOSING = 'Questions? Just reply to this email and it will go to {resort_name}.';

export const EMAIL_DEFAULTS = {
  design: {
    color: '',
    show_logo: true,
    brand_text: '',
    copyright_name: '',
    from_name: '',
    reply_to: '',
  },
  templates: {
    guest_received: {
      subject: 'We received your booking at {resort_name}',
      heading: 'Thanks {first_name}, we got your booking',
      intro:
        '{resort_name} will review it and email you again once it is confirmed. Until then, this is a request and your dates are not guaranteed.',
      payment_title: 'How to pay',
      closing: GUEST_CLOSING,
      button_label: '',
      button_url: '',
      show_payment: true,
      show_request: true,
      show_policy: true,
    },
    guest_confirmed: {
      subject: 'Your booking at {resort_name} is confirmed',
      heading: "You're booked, {first_name}",
      intro: '{resort_name} has confirmed your booking. Here are your details.',
      payment_title: 'How to pay',
      closing: GUEST_CLOSING,
      button_label: '',
      button_url: '',
      show_payment: true,
      show_request: true,
      show_policy: true,
    },
    owner_new: {
      subject: 'New booking: {guest_name} ({check_in} to {check_out})',
      heading: 'New booking from {guest_name}',
      intro: '{resort_name} has a new booking. It is pending until you confirm it in your dashboard.',
      closing:
        'Reply to this email to write to the guest directly. You can turn these alerts off or change where they go under Booking Emails.',
      button_label: 'Open dashboard',
    },
  },
};

// Which fields each email accepts, with their maximum lengths.
// "keepEmpty" fields may be saved as blank on purpose (a resort that wants no
// closing note); every other text field falls back to the default when blank.
const TEXT_FIELDS = {
  subject: { max: 150, keepEmpty: false },
  heading: { max: 150, keepEmpty: false },
  intro: { max: 1000, keepEmpty: true },
  payment_title: { max: 80, keepEmpty: false },
  closing: { max: 1500, keepEmpty: true },
  button_label: { max: 40, keepEmpty: true },
  button_url: { max: 300, keepEmpty: true },
};
const TOGGLE_FIELDS = ['show_payment', 'show_request', 'show_policy'];
const KIND_FIELDS = {
  guest_received: [...Object.keys(TEXT_FIELDS), ...TOGGLE_FIELDS],
  guest_confirmed: [...Object.keys(TEXT_FIELDS), ...TOGGLE_FIELDS],
  owner_new: ['subject', 'heading', 'intro', 'closing', 'button_label'],
};

function cleanText(v, max) {
  return String(v).replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim().slice(0, max);
}

export function validEmail(v) {
  return typeof v === 'string' && v.length <= 200 && EMAIL_RE.test(v.trim());
}

// Cleans the whole email_config object. Returns { config, error }.
// Only known keys survive. A template field that is missing, or blank where a
// blank is not allowed, is left out so the default text is used.
export function sanitizeEmailConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { config: null, error: 'email_config must be an object' };
  }
  const notify = typeof input.notify_email === 'string' ? input.notify_email.trim() : '';
  if (notify && !validEmail(notify)) {
    return { config: null, error: 'Please enter a valid notification email address' };
  }

  // ---- design
  const d = input.design && typeof input.design === 'object' && !Array.isArray(input.design) ? input.design : {};
  const design = {};
  if (typeof d.color === 'string' && HEX_RE.test(d.color.trim())) design.color = d.color.trim();
  if (d.show_logo === false) design.show_logo = false;
  for (const [key, max] of [
    ['brand_text', 60],
    ['copyright_name', 80],
    ['from_name', 60],
  ]) {
    if (typeof d[key] === 'string') {
      const v = cleanText(d[key], max).replace(/\n+/g, ' ');
      if (v) design[key] = v;
    }
  }
  if (typeof d.reply_to === 'string' && d.reply_to.trim()) {
    if (!validEmail(d.reply_to)) {
      return { config: null, error: 'Please enter a valid reply-to email address' };
    }
    design.reply_to = d.reply_to.trim();
  }

  // ---- templates
  const templates = {};
  const tin = input.templates && typeof input.templates === 'object' && !Array.isArray(input.templates) ? input.templates : {};
  for (const kind of EMAIL_KINDS) {
    const src = tin[kind];
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    const out = {};
    for (const field of KIND_FIELDS[kind]) {
      if (TOGGLE_FIELDS.includes(field)) {
        if (src[field] === false) out[field] = false;
        continue;
      }
      if (typeof src[field] !== 'string') continue;
      const spec = TEXT_FIELDS[field];
      let v = cleanText(src[field], spec.max);
      if (field === 'subject') v = v.replace(/\n+/g, ' ');
      if (field === 'heading' || field === 'payment_title' || field === 'button_label') v = v.replace(/\n+/g, ' ');
      if (v === '' && !spec.keepEmpty) continue;
      if (field === 'button_url' && v && !URL_RE.test(v)) {
        return { config: null, error: 'The button link must start with https://' };
      }
      out[field] = v;
    }
    if (Object.keys(out).length) templates[kind] = out;
  }

  return {
    config: {
      notify_email: notify || null,
      owner_new: input.owner_new !== false,
      guest_received: input.guest_received !== false,
      guest_confirmed: input.guest_confirmed !== false,
      design,
      templates,
    },
    error: null,
  };
}

// ============================================================
// RENDER START (copied into the dashboard's email editor)
// ============================================================
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

// Replaces {placeholders} with values. Unknown words are left as typed.
export function fillText(str, vars) {
  return String(str === undefined || str === null ? '' : str).replace(/\{([a-z_]+)\}/g, (m, k) =>
    vars && vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m
  );
}

// The saved text for one email, with defaults filling anything not customized.
export function templateFor(kind, config, defaults) {
  const base = (defaults || EMAIL_DEFAULTS).templates[kind] || {};
  const saved = config && config.templates && config.templates[kind] ? config.templates[kind] : {};
  return { ...base, ...saved };
}

// preview: null for real emails. In the dashboard preview it is { active }, and
// every editable part gets a data-field (so a click can jump to its input) and
// the active one gets an outline. Real emails carry none of that.
function render(m) {
  const preview = m.preview || null;
  const accent = HEX_RE.test(m.color || '') ? m.color : DEFAULT_COLOR;
  const mark = (field, style) => {
    if (!preview) return `style="${style}"`;
    const on = preview.active === field;
    return `data-field="${field}" style="${style}cursor:pointer;${on ? 'outline:2px solid #6d3ff2;outline-offset:3px;border-radius:4px;' : ''}"`;
  };
  const para = (text) => esc(text).replace(/\n/g, '<br>');

  const rows = (m.rows || []).filter((r) => r[1] !== undefined && r[1] !== null && String(r[1]) !== '');
  const rowsHtml = rows
    .map(
      (r, i) =>
        `<tr><td style="padding:9px 14px 9px 0;font-size:13px;color:#6b7280;vertical-align:top;width:36%;${i === 0 ? '' : 'border-top:1px solid #eef0f3;'}">${esc(
          r[0]
        )}</td><td style="padding:9px 0;font-size:13.5px;font-weight:600;color:#111827;vertical-align:top;${i === 0 ? '' : 'border-top:1px solid #eef0f3;'}">${esc(
          r[1]
        ).replace(/\n/g, '<br>')}</td></tr>`
    )
    .join('');

  const blocks = (m.blocks || []).filter((b) => b && b.lines && b.lines.length);
  const blocksHtml = blocks
    .map(
      (b) =>
        `<div style="background:#f7f7fa;border-radius:12px;padding:14px 16px;margin:16px 0 0 0;"><div ${
          b.field ? mark(b.field, 'font-size:13px;font-weight:700;color:#111827;margin-bottom:6px;') : 'style="font-size:13px;font-weight:700;color:#111827;margin-bottom:6px;"'
        }>${esc(b.title)}</div>${b.lines
          .map((l) => `<div style="font-size:13px;line-height:1.6;color:#374151;">${esc(l).replace(/\n/g, '<br>')}</div>`)
          .join('')}</div>`
    )
    .join('');

  const logoHtml = m.logoUrl
    ? `<img src="${esc(m.logoUrl)}" alt="" height="36" style="display:block;height:36px;max-width:180px;width:auto;margin:0 0 14px 0;border:0;">`
    : '';

  const introHtml = m.intro
    ? `<p ${mark('intro', 'font-size:14px;line-height:1.6;margin:0 0 20px 0;color:#374151;')}>${para(m.intro)}</p>`
    : preview
      ? `<p ${mark('intro', 'font-size:12px;line-height:1.6;margin:0 0 20px 0;color:#9ca3af;')}>(No intro text. Click to add one.)</p>`
      : '';

  const closingHtml = m.closing
    ? `<p ${mark('closing', 'font-size:13px;line-height:1.6;margin:24px 0 0 0;color:#4b5563;')}>${para(m.closing)}</p>`
    : preview
      ? `<p ${mark('closing', 'font-size:12px;line-height:1.6;margin:24px 0 0 0;color:#9ca3af;')}>(No closing note. Click to add one.)</p>`
      : '';

  const buttonHtml = m.button
    ? `<div style="margin:24px 0 0 0;"><a href="${esc(m.button.link)}" ${mark(
        'button_label',
        `display:inline-block;background:${accent};color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;`
      )}>${esc(m.button.label)}</a></div>`
    : '';

  const footerHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:28px 0 0 0;"><tr><td ${mark(
    'copyright_name',
    'padding:16px 0 0 0;border-top:1px solid #eef0f3;font-size:12px;color:#6b7280;vertical-align:middle;'
  )}>Copyright &copy; ${esc(m.year)} ${esc(m.copyrightName)}</td><td align="right" style="padding:16px 0 0 0;border-top:1px solid #eef0f3;font-size:12px;color:#9ca3af;vertical-align:middle;white-space:nowrap;">Powered by <a href="https://buildfirst.digital" style="display:inline-block;border:1px solid #111827;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;color:#111827;text-decoration:none;">Buildfirst</a></td></tr></table>`;

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#111827;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;">
      <div style="height:4px;background:${accent};"></div>
      <div style="padding:28px 32px 32px 32px;">
        ${logoHtml}
        <div ${mark('brand_text', 'font-size:12px;font-weight:700;letter-spacing:1.5px;color:#6b7280;text-transform:uppercase;margin-bottom:14px;')}>${esc(m.brand)}</div>
        <h1 ${mark('heading', 'font-size:20px;line-height:1.3;margin:0 0 10px 0;')}>${esc(m.heading)}</h1>
        ${introHtml}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${rowsHtml}</table>
        ${blocksHtml}
        ${buttonHtml}
        ${closingHtml}
        ${footerHtml}
      </div>
    </div>
  </body>
</html>`;

  const textParts = [m.heading, ''];
  if (m.intro) textParts.push(m.intro, '');
  rows.forEach((r) => textParts.push(`${r[0]}: ${r[1]}`));
  blocks.forEach((b) => {
    textParts.push('', b.title);
    b.lines.forEach((l) => textParts.push(l));
  });
  if (m.button) textParts.push('', `${m.button.label}: ${m.button.link}`);
  if (m.closing) textParts.push('', m.closing);
  textParts.push('', `Copyright (c) ${m.year} ${m.copyrightName}`, 'Powered by Buildfirst (https://buildfirst.digital)');

  return { html, text: textParts.join('\n') };
}
// ============================================================
// RENDER END
// ============================================================

export { render, esc, oneLine };
