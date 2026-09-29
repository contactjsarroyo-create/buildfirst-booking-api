import { sql } from '@vercel/postgres';
import { put } from '@vercel/blob';
import { setCors, getAuth, num, text } from './_lib/helpers.js';
import {
  getAccount,
  getUsage,
  publicAccount,
  planLimit,
  blocked,
  reserveStorage,
  releaseStorage,
  formatBytes,
} from './_lib/limits.js';
import {
  RETENTION_OPTIONS,
  NOTICE_DAYS,
  isUuid,
  recordFileOrRollback,
  removeTenantFiles,
  getRetention,
  setRetention,
  expiringSoonCount,
  storageBreakdown,
  listFiles,
} from './_lib/storage.js';
import { sanitizeEmailConfig, EMAIL_DEFAULTS, PLACEHOLDERS } from './_lib/emailcore.js';
import { sendTestEmail } from './_lib/bookingemails.js';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const FONT_WHITELIST = [
  'Inter',
  'Poppins',
  'Playfair Display',
  'Montserrat',
  'Lora',
  'Work Sans',
  'DM Sans',
  'Cormorant Garamond',
];
const MODE_WHITELIST = ['light', 'dark', 'auto'];

// Validates an incoming theme object and returns a clean version with only
// known keys, or null if the input isn't a usable object at all.
// Invalid individual fields are dropped rather than failing the whole request,
// except mode/font/radius which fall back to a sane default if invalid.
function sanitizeTheme(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  const out = {};

  out.mode = MODE_WHITELIST.includes(input.mode) ? input.mode : 'auto';

  const colorFields = ['background', 'surface', 'text', 'muted_text', 'border'];
  for (const field of colorFields) {
    const v = input[field];
    if (typeof v === 'string' && HEX_RE.test(v)) {
      out[field] = v;
    } else {
      out[field] = null;
    }
  }

  out.font = FONT_WHITELIST.includes(input.font) ? input.font : 'Inter';

  const radiusNum = num(input.radius);
  out.radius = radiusNum === null ? 8 : Math.min(24, Math.max(0, Math.round(radiusNum)));

  return out;
}

// ------------------------------------------------------------
// Payment channels: which ways a guest can pay this tenant.
// "paymongo" has no manual fields (future automatic integration).
// Every other channel is a tenant-created "custom" channel: the tenant
// types any name they want (GCash, BPI, Maya, ...) plus an account name,
// account number and optional instructions shown to the guest at checkout.
// Custom channels are stored under keys that start with "custom_".
// ------------------------------------------------------------
const CUSTOM_CHANNEL_KEY_RE = /^custom_[a-z0-9_]{1,50}$/;
const MAX_CUSTOM_CHANNELS = 20;
const CUSTOM_CHANNEL_TEXT_FIELDS = ['account_name', 'account_number', 'instructions'];

function sanitizePaymentChannels(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  const out = {};

  const pm = input.paymongo;
  out.paymongo = { enabled: !!(pm && pm.enabled === true) };

  let customCount = 0;
  for (const key of Object.keys(input)) {
    if (!CUSTOM_CHANNEL_KEY_RE.test(key)) continue;
    if (customCount >= MAX_CUSTOM_CHANNELS) break;

    const ch = input[key];
    if (!ch || typeof ch !== 'object' || Array.isArray(ch)) continue;

    const name = typeof ch.name === 'string' ? ch.name.trim().slice(0, 100) : '';
    if (!name) continue; // a channel with no name can't be shown to guests

    const entry = { custom: true, enabled: ch.enabled === true, name };
    for (const field of CUSTOM_CHANNEL_TEXT_FIELDS) {
      const v = ch[field];
      entry[field] = typeof v === 'string' ? v.trim().slice(0, 500) : '';
    }
    out[key] = entry;
    customCount++;
  }
  return out;
}

// ------------------------------------------------------------
// Custom fields: tenant-defined questions asked on the guest-details
// step of the booking widget. Stored as an ordered array; each
// booking stores its answers keyed by `key` in
// bookings.custom_field_responses.
// MAX_CUSTOM_FIELDS is the absolute ceiling (the Pro plan's limit);
// each plan's own, lower limit is enforced in the PUT handler below.
// ------------------------------------------------------------
const CUSTOM_FIELD_TYPES = ['text', 'textarea', 'select', 'checkbox', 'number', 'date', 'phone', 'image_upload'];
const CUSTOM_FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,49}$/;
const MAX_CUSTOM_FIELDS = 40;
// Reference images are only ever URLs we generated ourselves (via the
// upload endpoint below), so this is a sanity check against garbage
// input, not a security boundary.
const IMAGE_URL_RE = /^https:\/\/.+/;

// Returns { fields, error }. fields is null if input is fundamentally
// unusable; error is set (and fields null) if a specific problem should
// be reported back to the caller rather than silently dropped, since
// broken custom fields could otherwise silently stop bookings from
// working (unlike theme/payment_channels which degrade gracefully).
function sanitizeCustomFields(input) {
  if (input === null) return { fields: [], error: null };
  if (!Array.isArray(input)) {
    return { fields: null, error: 'custom_fields must be an array' };
  }
  if (input.length > MAX_CUSTOM_FIELDS) {
    return { fields: null, error: `custom_fields cannot exceed ${MAX_CUSTOM_FIELDS} entries` };
  }

  const out = [];
  const seenKeys = new Set();

  for (let i = 0; i < input.length; i++) {
    const f = input[i];
    if (!f || typeof f !== 'object') {
      return { fields: null, error: `custom_fields[${i}] must be an object` };
    }

    const key = typeof f.key === 'string' ? f.key.trim().toLowerCase() : '';
    if (!CUSTOM_FIELD_KEY_RE.test(key)) {
      return {
        fields: null,
        error: `custom_fields[${i}].key must be lowercase letters/numbers/underscores, starting with a letter (got: "${f.key}")`,
      };
    }
    if (seenKeys.has(key)) {
      return { fields: null, error: `custom_fields has a duplicate key: "${key}"` };
    }
    seenKeys.add(key);

    const label = typeof f.label === 'string' ? f.label.trim().slice(0, 200) : '';
    if (!label) {
      return { fields: null, error: `custom_fields[${i}] (key: "${key}") needs a label` };
    }

    const type = CUSTOM_FIELD_TYPES.includes(f.type) ? f.type : null;
    if (!type) {
      return {
        fields: null,
        error: `custom_fields[${i}] (key: "${key}") type must be one of: ${CUSTOM_FIELD_TYPES.join(', ')}`,
      };
    }

    const required = f.required === true;

    const entry = { key, label, type, required };

    // Optional reference image the tenant attached while building the
    // question (e.g. a photo shown alongside "Which building do you
    // prefer?"). Valid on any question type, not just image_upload.
    if (typeof f.image_url === 'string' && f.image_url.trim()) {
      const imageUrl = f.image_url.trim();
      if (!IMAGE_URL_RE.test(imageUrl)) {
        return {
          fields: null,
          error: `custom_fields[${i}] (key: "${key}") has an invalid image_url`,
        };
      }
      entry.image_url = imageUrl;
    }

    if (type === 'select') {
      const options = Array.isArray(f.options)
        ? f.options
            .filter((o) => typeof o === 'string' && o.trim())
            .map((o) => o.trim().slice(0, 100))
            .slice(0, 30)
        : [];
      if (options.length === 0) {
        return {
          fields: null,
          error: `custom_fields[${i}] (key: "${key}") is type "select" but has no options`,
        };
      }
      entry.options = options;
    }

    out.push(entry);
  }

  return { fields: out, error: null };
}

// ------------------------------------------------------------
// Guest-details section config: lets the tenant rename the "Your details"
// heading/labels and choose whether phone and special requests are hidden,
// optional, or required. Name and email are always asked (the confirmation
// email needs the address), so they only get renamable labels.
// Unknown keys are dropped; blank labels fall back to the widget defaults.
// ------------------------------------------------------------
const DETAILS_MODES = ['hidden', 'optional', 'required'];
const DETAILS_LABEL_KEYS = [
  'title', 'name_label', 'email_label', 'phone_label', 'requests_label',
  'dates_title', 'guests_label', 'rooms_title', 'addons_title', 'promo_label',
  'payment_title', 'reference_label', 'reference_placeholder', 'policy_label',
];
const DETAILS_MODE_KEYS = ['phone_mode', 'requests_mode', 'reference_mode'];
// Order of the form's sections. Each custom question is a repeated "q" token
// (the Nth "q" is the Nth entry of custom_fields). The widget fills in any
// section that is missing, so a bad list can never hide part of the form.
const SECTION_ORDER_TOKENS = ['dates', 'guests', 'rooms', 'extras', 'details', 'q', 'payment', 'policy'];
const MAX_SECTION_ORDER = 60;

function sanitizeDetailsConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const key of DETAILS_LABEL_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim().slice(0, 100);
  }
  for (const key of DETAILS_MODE_KEYS) {
    if (DETAILS_MODES.includes(input[key])) out[key] = input[key];
  }
  if (Array.isArray(input.section_order)) {
    const order = input.section_order
      .filter((t) => typeof t === 'string' && SECTION_ORDER_TOKENS.includes(t))
      .slice(0, MAX_SECTION_ORDER);
    if (order.length > 0) out.section_order = order;
  }
  return out;
}

// ------------------------------------------------------------
// Widget template + public slug
// ------------------------------------------------------------
const WIDGET_TEMPLATE_WHITELIST = ['standard', 'calendar_prices'];
const PUBLIC_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/; // lowercase, digits, hyphens; no leading/trailing hyphen

// ------------------------------------------------------------
// Reference-image upload for the custom-question builder. Authenticated —
// this is the tenant attaching a photo while building a question in the
// dashboard, not a guest uploading anything (that flow lives in
// bookings.js instead, since it must work without a login).
// Images arrive as a base64 data URL rather than multipart/form-data,
// since that's simplest to send from a Framer code component. This keeps
// the whole request under Vercel's serverless body-size limit, which
// caps how large an image can be — see MAX_IMAGE_BYTES.
// Uploads count against the tenant's plan storage limit.
// ------------------------------------------------------------
const ALLOWED_IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB

function parseImageDataUrl(input) {
  if (typeof input !== 'string') return null;
  const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(input.trim());
  if (!match) return null;
  const mime = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  return { mime, buffer };
}

// ------------------------------------------------------------
// Storage: usage meter, file list, deleting files, and the guest-photo
// auto-cleanup setting. Reached via /api/settings?resource=storage
// (merged here to stay under Vercel's 12-function Hobby cap).
//   GET     usage + files (add &summary=1 for just the numbers)
//   DELETE  &id=<file id>  or  &ids=<id>,<id>,...  (max 50)
//   PUT     { image_retention_days }  7, 14, 30, 60, 90, or 0 = never
// Deleting is allowed even when the trial has ended, so an owner can
// always free up space.
// ------------------------------------------------------------
async function handleStorage(req, res, auth) {
  const account = await getAccount(auth.tenant_id);
  if (!account) return res.status(404).json({ ok: false, error: 'Account not found' });

  if (req.method === 'GET') {
    const [retention, expiring] = await Promise.all([
      getRetention(auth.tenant_id),
      expiringSoonCount(auth.tenant_id),
    ]);
    const out = {
      ok: true,
      used_bytes: account.storage_bytes,
      limit_bytes: account.limits.storage_bytes,
      plan_label: account.label,
      retention_days: retention,
      retention_options: RETENTION_OPTIONS,
      expiring_soon: expiring,
      notice_days: NOTICE_DAYS,
    };
    if (req.query.summary === '1') return res.status(200).json(out);
    out.breakdown = await storageBreakdown(auth.tenant_id);
    out.files = await listFiles(auth.tenant_id);
    return res.status(200).json(out);
  }

  if (req.method === 'DELETE') {
    const raw = String(req.query.ids || req.query.id || '');
    const ids = raw.split(',').map((x) => x.trim()).filter(Boolean);
    if (ids.length === 0 || ids.length > 50 || !ids.every(isUuid)) {
      return res.status(400).json({ ok: false, error: 'Choose between 1 and 50 files to delete' });
    }
    let deleted;
    try {
      deleted = await removeTenantFiles(auth.tenant_id, ids);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ ok: false, error: 'Could not delete right now. Nothing was changed, please try again.' });
    }
    const after = await getAccount(auth.tenant_id);
    return res.status(200).json({ ok: true, deleted, used_bytes: after ? after.storage_bytes : 0 });
  }

  if (req.method === 'PUT') {
    const days = Number((req.body || {}).image_retention_days);
    if (!RETENTION_OPTIONS.includes(days)) {
      return res.status(400).json({
        ok: false,
        error: `image_retention_days must be one of: ${RETENTION_OPTIONS.join(', ')} (0 = never delete)`,
      });
    }
    const saved = await setRetention(auth.tenant_id, days);
    if (!saved) {
      return res.status(404).json({ ok: false, error: 'Save your account settings once first, then try again.' });
    }
    return res.status(200).json({ ok: true, retention_days: days });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}

// ------------------------------------------------------------
// Booking emails: the on/off switches, where owner alerts go, and the
// resort's own wording and look, all stored in tenant_settings.email_config.
// Reached via /api/settings?resource=emails (merged here to stay under
// Vercel's 12-function cap). It never touches any other setting.
//   GET   current config + the defaults + numbers for the editor
//   PUT   { email_config }
//   POST  { email_config, kind, to }   sends a test email from unsaved edits
// The cleaning rules live in _lib/emailcore.js.
// ------------------------------------------------------------
async function handleEmails(req, res, auth) {
  if (req.method === 'GET') {
    const t = await sql`select name from tenants where id = ${auth.tenant_id}`;
    const s = await sql`select logo_url, primary_color, email_config from tenant_settings where tenant_id = ${auth.tenant_id}`;
    const owner = await sql`select email from tenant_users where tenant_id = ${auth.tenant_id} limit 1`;
    const account = await getAccount(auth.tenant_id);
    let emailsUsed = null;
    if (account) {
      const usage = await getUsage(auth.tenant_id);
      emailsUsed = usage.emails_this_month;
    }
    const row = s.rows[0] || {};
    return res.status(200).json({
      ok: true,
      resort_name: (t.rows[0] && t.rows[0].name) || '',
      logo_url: row.logo_url || '',
      primary_color: row.primary_color || '',
      owner_email: (owner.rows[0] && owner.rows[0].email) || '',
      config: row.email_config && typeof row.email_config === 'object' ? row.email_config : {},
      defaults: EMAIL_DEFAULTS,
      placeholders: PLACEHOLDERS,
      emails_used: emailsUsed,
      emails_limit: account && account.limits ? account.limits.emails : null,
      has_settings: !!s.rows[0],
    });
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    const b = req.body || {};
    const { config, error } = sanitizeEmailConfig(b.email_config);
    if (error) return res.status(400).json({ ok: false, error });

    if (req.method === 'POST') {
      const result = await sendTestEmail(auth.tenant_id, String(b.kind || ''), String(b.to || ''), config);
      if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
      return res.status(200).json({ ok: true });
    }

    const saved = await sql`
      update tenant_settings set email_config = ${JSON.stringify(config)}::jsonb, updated_at = now()
      where tenant_id = ${auth.tenant_id}
      returning tenant_id
    `;
    if (saved.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Save your account settings once first, then try again.' });
    }
    return res.status(200).json({ ok: true, config });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}

export default async function handler(req, res) {
  if (setCors(req, res, 'GET, PUT, POST, DELETE, OPTIONS')) return;

  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  try {
    if (req.query && req.query.resource === 'storage') {
      return await handleStorage(req, res, auth);
    }
    if (req.query && req.query.resource === 'emails') {
      return await handleEmails(req, res, auth);
    }

    if (req.method === 'GET') {
      const t = await sql`
        select name, slug, public_slug, plan, currency from tenants where id = ${auth.tenant_id}
      `;
      const s = await sql`
        select logo_url, primary_color, embed_domain,
               checkin_time::text as checkin_time, checkout_time::text as checkout_time,
               cancellation_policy, deposit_percent, vat_percent,
               min_stay_nights, booking_window_days, theme, payment_channels,
               custom_fields, widget_template, details_config, email_config
        from tenant_settings where tenant_id = ${auth.tenant_id}
      `;

      // Account state, plan limits and current usage, for the dashboard's
      // trial banner, "pick a plan" screen and usage meters.
      const account = await getAccount(auth.tenant_id);
      let accountJson = null;
      let usageJson = null;
      let limitsJson = null;
      if (account) {
        const usage = await getUsage(auth.tenant_id);
        accountJson = publicAccount(account);
        limitsJson = account.limits;
        usageJson = {
          unit_types: usage.unit_types,
          rooms: Math.max(usage.rooms, usage.unit_count_total),
          custom_fields: usage.custom_fields,
          bookings_this_month: usage.bookings_this_month,
          storage_bytes: usage.storage_bytes,
          emails_this_month: usage.emails_this_month,
        };
      }

      return res.status(200).json({
        ok: true,
        tenant: t.rows[0] || null,
        settings: s.rows[0] || null,
        account: accountJson,
        limits: limitsJson,
        usage: usageJson,
      });
    }

    if (req.method === 'PUT') {
      const b = req.body || {};
      const name = text(b.name);
      const vals = {
        logo_url: text(b.logo_url),
        primary_color: text(b.primary_color),
        embed_domain: text(b.embed_domain),
        checkin_time: text(b.checkin_time) || '14:00',
        checkout_time: text(b.checkout_time) || '12:00',
        cancellation_policy: text(b.cancellation_policy),
        deposit_percent: num(b.deposit_percent) ?? 0,
        vat_percent: num(b.vat_percent) ?? 12,
        min_stay_nights: Math.floor(num(b.min_stay_nights) ?? 1),
        booking_window_days: Math.floor(num(b.booking_window_days) ?? 365),
      };

      if (vals.vat_percent < 0 || vals.vat_percent > 100 || vals.deposit_percent < 0 || vals.deposit_percent > 100) {
        return res.status(400).json({ ok: false, error: 'Percentages must be between 0 and 100' });
      }

      // ---- public_slug: only touch tenants.public_slug if the request
      // included the key. Validate format, then try the update and
      // translate a unique-constraint violation into a friendly 409.
      if (Object.prototype.hasOwnProperty.call(b, 'public_slug')) {
        const rawSlug = typeof b.public_slug === 'string' ? b.public_slug.trim().toLowerCase() : '';
        if (!PUBLIC_SLUG_RE.test(rawSlug)) {
          return res.status(400).json({
            ok: false,
            error: 'public_slug must be lowercase letters, numbers, and hyphens only (no leading/trailing hyphen), 1-63 characters',
          });
        }
        try {
          await sql`update tenants set public_slug = ${rawSlug}, updated_at = now() where id = ${auth.tenant_id}`;
        } catch (err) {
          if (err && err.code === '23505') {
            return res.status(409).json({ ok: false, error: 'That booking link is already taken. Please choose another.' });
          }
          throw err;
        }
      }

      if (name) {
        await sql`update tenants set name = ${name}, updated_at = now() where id = ${auth.tenant_id}`;
      }

      const existing = await sql`
        select tenant_id, theme, payment_channels, custom_fields, widget_template, details_config
        from tenant_settings where tenant_id = ${auth.tenant_id}
      `;

      // Only touch theme / payment_channels / custom_fields / widget_template
      // if the request actually included that key. Otherwise keep whatever
      // is already saved.
      let themeToSave = existing.rows.length > 0 ? existing.rows[0].theme : null;
      if (Object.prototype.hasOwnProperty.call(b, 'theme')) {
        themeToSave = sanitizeTheme(b.theme);
      }
      const themeJson = themeToSave === null ? null : JSON.stringify(themeToSave);

      let channelsToSave = existing.rows.length > 0 ? existing.rows[0].payment_channels : null;
      if (Object.prototype.hasOwnProperty.call(b, 'payment_channels')) {
        channelsToSave = sanitizePaymentChannels(b.payment_channels);
      }
      const channelsJson = channelsToSave === null ? null : JSON.stringify(channelsToSave);

      let customFieldsToSave = existing.rows.length > 0 ? existing.rows[0].custom_fields : [];
      if (Object.prototype.hasOwnProperty.call(b, 'custom_fields')) {
        const { fields, error } = sanitizeCustomFields(b.custom_fields);
        if (error) {
          return res.status(400).json({ ok: false, error });
        }

        // Plan limit on custom questions. Only blocks when the list is
        // growing past the limit, so a tenant who is over it (after a
        // downgrade) can still edit or trim their questions.
        const existingCount =
          existing.rows.length > 0 && Array.isArray(existing.rows[0].custom_fields)
            ? existing.rows[0].custom_fields.length
            : 0;
        if (fields.length > existingCount) {
          const account = await getAccount(auth.tenant_id);
          if (account && fields.length > account.limits.custom_fields) {
            return planLimit(
              res,
              account,
              `Your ${account.label} allows up to ${account.limits.custom_fields} custom questions.`,
              'custom_fields'
            );
          }
        }

        customFieldsToSave = fields;
      }
      const customFieldsJson = JSON.stringify(customFieldsToSave || []);

      let widgetTemplateToSave = existing.rows.length > 0 ? existing.rows[0].widget_template : 'standard';
      if (Object.prototype.hasOwnProperty.call(b, 'widget_template')) {
        if (!WIDGET_TEMPLATE_WHITELIST.includes(b.widget_template)) {
          return res.status(400).json({
            ok: false,
            error: `widget_template must be one of: ${WIDGET_TEMPLATE_WHITELIST.join(', ')}`,
          });
        }
        widgetTemplateToSave = b.widget_template;
      }

      let detailsToSave = existing.rows.length > 0 && existing.rows[0].details_config ? existing.rows[0].details_config : {};
      if (Object.prototype.hasOwnProperty.call(b, 'details_config')) {
        detailsToSave = sanitizeDetailsConfig(b.details_config);
      }
      const detailsJson = JSON.stringify(detailsToSave);

      if (existing.rows.length === 0) {
        await sql`
          insert into tenant_settings
            (tenant_id, logo_url, primary_color, embed_domain, checkin_time, checkout_time,
             cancellation_policy, deposit_percent, vat_percent, min_stay_nights, booking_window_days,
             theme, payment_channels, custom_fields, widget_template, details_config, updated_at)
          values
            (${auth.tenant_id}, ${vals.logo_url}, ${vals.primary_color}, ${vals.embed_domain},
             ${vals.checkin_time}::time, ${vals.checkout_time}::time, ${vals.cancellation_policy},
             ${vals.deposit_percent}::numeric, ${vals.vat_percent}::numeric,
             ${vals.min_stay_nights}::integer, ${vals.booking_window_days}::integer,
             ${themeJson}::jsonb, ${channelsJson}::jsonb, ${customFieldsJson}::jsonb,
             ${widgetTemplateToSave}, ${detailsJson}::jsonb, now())
        `;
      } else {
        await sql`
          update tenant_settings set
            logo_url = ${vals.logo_url},
            primary_color = ${vals.primary_color},
            embed_domain = ${vals.embed_domain},
            checkin_time = ${vals.checkin_time}::time,
            checkout_time = ${vals.checkout_time}::time,
            cancellation_policy = ${vals.cancellation_policy},
            deposit_percent = ${vals.deposit_percent}::numeric,
            vat_percent = ${vals.vat_percent}::numeric,
            min_stay_nights = ${vals.min_stay_nights}::integer,
            booking_window_days = ${vals.booking_window_days}::integer,
            theme = ${themeJson}::jsonb,
            payment_channels = ${channelsJson}::jsonb,
            custom_fields = ${customFieldsJson}::jsonb,
            widget_template = ${widgetTemplateToSave},
            details_config = ${detailsJson}::jsonb,
            updated_at = now()
          where tenant_id = ${auth.tenant_id}
        `;
      }

      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST') {
      // Reference-image upload for a custom question. auth is already
      // required above for every method on this endpoint.
      const b = req.body || {};

      const account = await getAccount(auth.tenant_id);
      if (!account) return res.status(404).json({ ok: false, error: 'Account not found' });
      if (!account.can_book) return blocked(res, account);

      const parsed = parseImageDataUrl(b.image_base64);
      if (!parsed) {
        return res.status(400).json({
          ok: false,
          error: 'image_base64 must be a data URL for a JPEG, PNG, or WEBP image',
        });
      }
      if (parsed.buffer.length > MAX_IMAGE_BYTES) {
        return res.status(400).json({ ok: false, error: 'Image is too large — please use one under 4MB' });
      }

      const size = parsed.buffer.length;
      const reserved = await reserveStorage(auth.tenant_id, size, account.limits.storage_bytes);
      if (!reserved) {
        return planLimit(
          res,
          account,
          `Your ${account.label} includes ${formatBytes(account.limits.storage_bytes)} of photo storage and it's full.`,
          'storage'
        );
      }

      const ext = ALLOWED_IMAGE_TYPES[parsed.mime];
      const pathname = `custom-question-images/${auth.tenant_id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      let blob;
      try {
        blob = await put(pathname, parsed.buffer, { access: 'public', contentType: parsed.mime });
      } catch (err) {
        await releaseStorage(auth.tenant_id, size);
        throw err;
      }
      await recordFileOrRollback(auth.tenant_id, 'question_image', blob.url, size);
      return res.status(200).json({ ok: true, url: blob.url });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
