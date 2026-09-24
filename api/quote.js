import { setCors } from './_lib/helpers.js';
import { computeQuote } from './_lib/pricing.js';

export default async function handler(req, res) {
  if (setCors(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const q = await computeQuote(req.body || {});
    if (!q.ok) {
      return res.status(q.status).json({ ok: false, error: q.error });
    }
    return res.status(200).json({
      ok: true,
      nights: q.nights,
      guests: q.guests,
      base_rate: q.base_rate,
      base_amount: q.base_amount,
      addons_amount: q.addons_amount,
      discount_amount: q.discount_amount,
      vat_percent: q.vat_percent,
      vat_amount: q.vat_amount,
      total_amount: q.total_amount,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
