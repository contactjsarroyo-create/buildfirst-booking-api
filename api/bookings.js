import { sql } from '@vercel/postgres';
import { put } from '@vercel/blob';
import { setCors, getAuth } from './_lib/helpers.js';
import { computeQuote } from './_lib/pricing.js';
import { getAccount, countBookingsThisMonth, reserveStorage, releaseStorage } from './_lib/limits.js';
import { recordFileOrRollback, linkFilesToBooking } from './_lib/storage.js';
import { sendBookingCreatedEmails, withTimeout } from './_lib/bookingemails.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// "paymongo" is the built-in channel. Channels a tenant creates themselves are stored
// under keys that start with "custom_" (see settings.js). The old fixed keys are still
// accepted so a resort that hasn't re-saved its payment settings yet keeps working.
const LEGACY_PAYMENT_CHANNEL_KEYS = ['bank_transfer', 'gcash', 'maya', 'qr_code'];
const CUSTOM_CHANNEL_KEY_RE = /^custom_[a-z0-9_]{1,50}$/;

function isValidPaymentChannelKey(key) {
  return key === 'paymongo' || LEGACY_PAYMENT_CHANNEL_KEYS.includes(key) || CUSTOM_CHANNEL_KEY_RE.test(key);
}

// Kept in sync with settings.js's CUSTOM_FIELD_TYPES.
const CUSTOM_FIELD_TYPES = ['text', 'textarea', 'select', 'checkbox', 'number', 'date', 'phone', 'image_upload'];
// A guest-uploaded image answer is only ever a URL our own upload action
// generated, so this is a sanity check, not a security boundary.
const IMAGE_URL_RE = /^https:\/\/.+/;

// Message shown to guests when the resort can't take bookings. Deliberately
// vague: guests shouldn't see the resort's billing state.
const GUEST_CLOSED_MESSAGE = 'This resort is not accepting bookings right now';

// ------------------------------------------------------------
// Guest-facing image upload for an image_upload custom question answer.
// Public / no auth — mirrors settings.js's authenticated reference-image
// upload, but writes under guest-uploads/ instead of
// custom-question-images/, and checks the tenant exists + is bookable
// instead of checking a JWT, since there's no login here.
// Guest uploads count against the resort's photo storage limit.
// Kept in this file rather than a new route file: the project is at
// Vercel Hobby's 12-serverless-function cap.
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

async function handleGuestImageUpload(req, res) {
  const b = req.body || {};
  if (!b.tenant_id || !UUID_RE.test(String(b.tenant_id))) {
    return res.status(400).json({ ok: false, error: 'A valid tenant_id is required' });
  }

  const account = await getAccount(b.tenant_id);
  if (!account) {
    return res.status(404).json({ ok: false, error: 'Resort not found' });
  }
  if (!account.can_book) {
    return res.status(403).json({ ok: false, error: GUEST_CLOSED_MESSAGE });
  }

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
  const reserved = await reserveStorage(b.tenant_id, size, account.limits.storage_bytes);
  if (!reserved) {
    return res.status(403).json({
      ok: false,
      error: "This resort can't accept more photo uploads right now. Please contact them directly.",
      code: 'storage_full',
    });
  }

  const ext = ALLOWED_IMAGE_TYPES[parsed.mime];
  const pathname = `guest-uploads/${b.tenant_id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  let blob;
  try {
    blob = await put(pathname, parsed.buffer, { access: 'public', contentType: parsed.mime });
  } catch (err) {
    await releaseStorage(b.tenant_id, size);
    throw err;
  }
  // Track the file so the owner can see/delete it and the daily cleanup can
  // expire it. It gets tied to its booking when the booking is submitted.
  await recordFileOrRollback(b.tenant_id, 'guest_upload', blob.url, size);
  return res.status(200).json({ ok: true, url: blob.url });
}

// ------------------------------------------------------------
// Validates a guest's custom_field_responses against the tenant's
// custom_fields definitions. Unknown keys (not defined by the tenant)
// are silently dropped rather than erroring, since the widget and the
// tenant's saved fields could briefly be out of sync. Returns
// { values, error }: error is set (values null) only when a defined
// field fails validation, since that should block the booking rather
// than silently lose the guest's answer.
// ------------------------------------------------------------
function validateCustomFieldResponses(customFields, responses) {
  const fields = Array.isArray(customFields) ? customFields : [];
  const input = responses && typeof responses === 'object' && !Array.isArray(responses) ? responses : {};

  const out = {};

  for (const field of fields) {
    const raw = input[field.key];
    const isEmpty = raw === undefined || raw === null || raw === '';

    if (isEmpty) {
      if (field.required) {
        return { values: null, error: `"${field.label}" is required` };
      }
      continue;
    }

    switch (field.type) {
      case 'select': {
        const options = Array.isArray(field.options) ? field.options : [];
        if (!options.includes(raw)) {
          return { values: null, error: `"${field.label}" must be one of: ${options.join(', ')}` };
        }
        out[field.key] = raw;
        break;
      }
      case 'checkbox': {
        out[field.key] = raw === true || raw === 'true';
        break;
      }
      case 'number': {
        const n = Number(raw);
        if (Number.isNaN(n)) {
          return { values: null, error: `"${field.label}" must be a number` };
        }
        out[field.key] = n;
        break;
      }
      case 'date': {
        if (!DATE_RE.test(String(raw))) {
          return { values: null, error: `"${field.label}" must be a date in YYYY-MM-DD format` };
        }
        out[field.key] = String(raw);
        break;
      }
      case 'phone': {
        const phone = String(raw).trim().slice(0, 40);
        if (phone.replace(/[^0-9]/g, '').length < 7) {
          return { values: null, error: `"${field.label}" doesn't look like a valid phone number` };
        }
        out[field.key] = phone;
        break;
      }
      case 'image_upload': {
        const url = String(raw).trim();
        if (!IMAGE_URL_RE.test(url)) {
          return { values: null, error: `"${field.label}" must be an uploaded image` };
        }
        out[field.key] = url;
        break;
      }
      case 'textarea': {
        out[field.key] = String(raw).trim().slice(0, 2000);
        break;
      }
      case 'text':
      default: {
        out[field.key] = String(raw).trim().slice(0, 500);
        break;
      }
    }
  }

  return { values: out, error: null };
}

export default async function handler(req, res) {
  if (setCors(req, res, 'GET, POST, OPTIONS')) return;

  if (req.method === 'GET') {
    const auth = getAuth(req);
    if (!auth) {
      return res.status(401).json({ ok: false, error: 'Missing or invalid authorization token' });
    }
    try {
      const result = await sql`
        SELECT * FROM bookings WHERE tenant_id = ${auth.tenant_id}
      `;
      return res.status(200).json({ ok: true, bookings: result.rows });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ ok: false, error: 'Server error' });
    }
  }

  if (req.method === 'POST') {
    // POST stays open with no login required - this is the public guest-facing
    // booking widget, not the dashboard. tenant_id comes from the widget's config.
    const b = req.body || {};

    // A single sibling action multiplexed onto POST rather than a new route
    // file — the project is at Vercel Hobby's 12-function cap. Must be
    // explicit (action: 'upload_image') so it can never be confused with a
    // real booking submission.
    if (b.action === 'upload_image') {
      try {
        return await handleGuestImageUpload(req, res);
      } catch (err) {
        console.error(err);
        return res.status(500).json({ ok: false, error: 'Server error' });
      }
    }

    const guest_name = String(b.guest_name || '').trim().slice(0, 120);
    const guest_email = String(b.guest_email || '').trim().slice(0, 200);
    const guest_phone = b.guest_phone ? String(b.guest_phone).trim().slice(0, 40) : null;
    const special_requests = b.special_requests ? String(b.special_requests).trim().slice(0, 1000) : null;
    const payment_channel = b.payment_channel ? String(b.payment_channel).trim() : null;
    const payment_reference = b.payment_reference ? String(b.payment_reference).trim().slice(0, 200) : null;

    if (!b.tenant_id || !b.unit_type_id || !guest_name || !guest_email || !b.check_in || !b.check_out) {
      return res.status(400).json({
        ok: false,
        error: 'tenant_id, unit_type_id, guest_name, guest_email, check_in, check_out are required',
      });
    }
    if (!UUID_RE.test(String(b.tenant_id))) {
      return res.status(400).json({ ok: false, error: 'A valid tenant_id is required' });
    }
    if (!EMAIL_RE.test(guest_email)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid email address' });
    }
    if (!payment_channel || !isValidPaymentChannelKey(payment_channel)) {
      return res.status(400).json({ ok: false, error: 'Please choose a valid payment method' });
    }

    try {
      // Trial / plan gate: expired trials and inactive accounts take no new
      // bookings, and every plan has a monthly booking cap.
      const account = await getAccount(b.tenant_id);
      if (!account) {
        return res.status(404).json({ ok: false, error: 'Resort not found' });
      }
      if (!account.can_book) {
        return res.status(403).json({ ok: false, error: GUEST_CLOSED_MESSAGE, code: account.blocked_code });
      }
      const bookingsThisMonth = await countBookingsThisMonth(b.tenant_id);
      if (bookingsThisMonth >= account.limits.bookings_per_month) {
        return res.status(403).json({
          ok: false,
          error: 'This resort has reached its booking limit for this month. Please contact them directly to book.',
          code: 'booking_limit',
        });
      }

      // Confirm the tenant actually has this channel enabled before accepting the booking,
      // and grab custom_fields in the same query so we can validate the guest's answers.
      const settingsResult = await sql`
        SELECT payment_channels, custom_fields, details_config FROM tenant_settings WHERE tenant_id = ${b.tenant_id}
      `;
      const channels = settingsResult.rows[0] ? settingsResult.rows[0].payment_channels : null;
      const channelConfig = channels ? channels[payment_channel] : null;
      if (!channelConfig || channelConfig.enabled !== true) {
        return res.status(400).json({ ok: false, error: 'That payment method is not available for this resort' });
      }

      // The resort can make the payment reference required (or hide it) from the
      // booking form editor. PayMongo never asks for one.
      const formConfig =
        settingsResult.rows[0] && settingsResult.rows[0].details_config ? settingsResult.rows[0].details_config : {};
      if (payment_channel !== 'paymongo' && formConfig.reference_mode === 'required' && !payment_reference) {
        const referenceLabel = formConfig.reference_label || 'Payment reference';
        return res.status(400).json({ ok: false, error: `"${referenceLabel}" is required` });
      }

      const customFields = settingsResult.rows[0] ? settingsResult.rows[0].custom_fields : [];
      const { values: customFieldResponses, error: customFieldError } = validateCustomFieldResponses(
        customFields,
        b.custom_field_responses
      );
      if (customFieldError) {
        return res.status(400).json({ ok: false, error: customFieldError });
      }

      const q = await computeQuote(b);
      if (!q.ok) {
        return res.status(q.status).json({ ok: false, error: q.error });
      }

      const result = await sql`
        INSERT INTO bookings (
          tenant_id, unit_type_id, room_id, guest_name, guest_email, guest_phone,
          check_in, check_out, guests, special_requests, base_amount, addons_amount,
          vat_amount, discount_amount, total_amount, promo_code_id,
          payment_channel, payment_reference, custom_field_responses
        )
        VALUES (
          ${q.tenant_id}, ${q.unit_type_id}, ${q.room_id}, ${guest_name}, ${guest_email}, ${guest_phone},
          ${q.check_in}, ${q.check_out}, ${q.guests}, ${special_requests}, ${q.base_amount}, ${q.addons_amount},
          ${q.vat_amount}, ${q.discount_amount}, ${q.total_amount}, ${q.promo_code_id},
          ${payment_channel}, ${payment_reference}, ${JSON.stringify(customFieldResponses)}::jsonb
        )
        RETURNING *
      `;
      const booking = result.rows[0];

      // Tie any guest photos in this booking to it (used for the retention
      // clock). Best effort: a failure here must never lose the booking.
      try {
        const photoKeys = (Array.isArray(customFields) ? customFields : [])
          .filter((f) => f && f.type === 'image_upload')
          .map((f) => f.key);
        const photoUrls = photoKeys
          .map((k) => customFieldResponses[k])
          .filter((u) => typeof u === 'string' && u);
        if (photoUrls.length > 0) {
          await linkFilesToBooking(b.tenant_id, booking.id, photoUrls);
        }
      } catch (linkErr) {
        console.error(linkErr);
      }

      for (const addon of q.valid_addons) {
        await sql`
          INSERT INTO booking_addons (booking_id, addon_id, quantity, price_at_booking)
          VALUES (${booking.id}, ${addon.id}, 1, ${addon.price})
        `;
      }

      if (q.promo_code_id) {
        await sql`
          UPDATE promo_codes SET times_used = times_used + 1 WHERE id = ${q.promo_code_id}
        `;
      }

      // Booking emails (owner alert + guest "we got your booking"). Must finish
      // before we answer, because Vercel can stop the function once the response
      // is sent. Never throws, and waits at most a few seconds, so a mail problem
      // can't fail or delay the booking beyond that.
      await withTimeout(sendBookingCreatedEmails(b.tenant_id, booking, account));

      return res.status(201).json({ ok: true, booking });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ ok: false, error: 'Server error' });
    }
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
