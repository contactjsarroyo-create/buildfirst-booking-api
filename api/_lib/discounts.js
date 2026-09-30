// Senior citizen and PWD discounts (Philippines): 20% off plus the VAT taken
// off, for that one person's own use. Pure calculations only, no database.
// The Front Desk action "add_discount" (frontdesk.js) uses these.
//
// Prices in this product are VAT-EXCLUSIVE and VAT is added on top, so:
//   VAT rate of a booking = vat_amount / (room + add-ons - promo discount).
// A resort that is not VAT-registered has VAT (%) at 0, so its bookings carry
// no VAT and nothing is removed for VAT (only the 20%).
// This is not tax advice: an accountant must check two sample bills first.

export const DISCOUNT_RATE = 0.2;

export const PERSON_TYPES = {
  senior: 'Senior citizen',
  pwd: 'PWD',
};

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function vatRateOf(b) {
  const taxable =
    (Number(b.base_amount) || 0) + (Number(b.addons_amount) || 0) - (Number(b.discount_amount) || 0);
  if (!(taxable > 0)) return 0;
  const r = (Number(b.vat_amount) || 0) / taxable;
  return r > 0 ? Math.round(r * 10000) / 10000 : 0;
}

// One person's share of the ROOM price (add-ons are not touched).
// share = room price / guests in the room.
// If the resort's own promo is already above 20%, the guest keeps the higher
// promo and only the VAT is taken off.
// Returns { basis, discount_part, vat_part, amount, exempt_sale }:
//   basis         the person's share of the room price (before VAT)
//   discount_part the extra discount to give now (20% minus any promo already given)
//   vat_part      the VAT that was charged on their share, now taken off
//   amount        discount_part + vat_part = how much the bill goes down
//   exempt_sale   what the person really pays for their share (VAT-exempt)
export function roomDiscount(b) {
  const base = Number(b.base_amount) || 0;
  const addons = Number(b.addons_amount) || 0;
  const promo = Number(b.discount_amount) || 0;
  const guests = Math.max(1, Math.floor(Number(b.guests)) || 1);
  const rate = vatRateOf(b);
  const share = base / guests;
  const promoPct = base + addons > 0 ? Math.min(1, promo / (base + addons)) : 0;
  const pct = Math.max(DISCOUNT_RATE, promoPct);
  const discountPart = (pct - promoPct) * share;
  const vatPart = share * (1 - promoPct) * rate;
  return {
    basis: round2(share),
    discount_part: round2(discountPart),
    vat_part: round2(vatPart),
    amount: round2(discountPart + vatPart),
    exempt_sale: round2(share * (1 - pct)),
  };
}

// A person's own food, drinks and services, entered as the amount on the bill.
// When the resort charges VAT, that amount is treated as VAT-inclusive.
export function itemsDiscount(amount, vatRate) {
  const a = Number(amount) || 0;
  const exVat = a / (1 + (Number(vatRate) || 0));
  const vatPart = a - exVat;
  const discountPart = exVat * DISCOUNT_RATE;
  return {
    basis: round2(a),
    discount_part: round2(discountPart),
    vat_part: round2(vatPart),
    amount: round2(discountPart + vatPart),
    exempt_sale: round2(exVat - discountPart),
  };
}
