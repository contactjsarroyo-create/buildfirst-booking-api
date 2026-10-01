import { sql } from '@vercel/postgres';

// Price rules (weekend prices, seasons, holidays) for a room type.
// A rule: name, days (0 = Sunday ... 6 = Saturday; empty = every day),
// optional start_date and end_date, kind ('fixed' = a new price per night,
// 'percent' = percent up or down from the normal price), amount, min_stay.
//
// Each night gets ONE price:
//   1. A rule with dates beats a rule without dates.
//   2. If two rules are still equal, the one added last wins.
//   3. No rule fits: the normal price.

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function dayNumber(ds) {
  return Math.round(Date.parse(ds + 'T00:00:00Z') / 86400000);
}

function dayString(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

function weekday(ds) {
  return new Date(ds + 'T00:00:00Z').getUTCDay();
}

export async function loadRules(tenantId, unitTypeId) {
  const r = await sql`
    SELECT id::text AS id, unit_type_id::text AS unit_type_id, name, days,
           start_date::text AS start_date, end_date::text AS end_date,
           kind, amount::float8 AS amount, min_stay
    FROM price_rules
    WHERE tenant_id = ${tenantId} AND unit_type_id = ${unitTypeId}
    ORDER BY created_at, id
  `;
  return r.rows;
}

export async function loadRulesByType(tenantId) {
  const r = await sql`
    SELECT id::text AS id, unit_type_id::text AS unit_type_id, name, days,
           start_date::text AS start_date, end_date::text AS end_date,
           kind, amount::float8 AS amount, min_stay
    FROM price_rules
    WHERE tenant_id = ${tenantId}
    ORDER BY created_at, id
  `;
  const out = {};
  r.rows.forEach((row) => {
    (out[row.unit_type_id] = out[row.unit_type_id] || []).push(row);
  });
  return out;
}

// The rule that sets the price for one night, or null.
export function ruleForNight(rules, date) {
  const dow = weekday(date);
  let best = null;
  let bestDated = false;
  (rules || []).forEach((rule) => {
    const days = Array.isArray(rule.days) ? rule.days : [];
    if (days.length > 0 && !days.includes(dow)) return;
    if (rule.start_date && date < rule.start_date) return;
    if (rule.end_date && date > rule.end_date) return;
    const dated = !!(rule.start_date || rule.end_date);
    if (!best || dated >= bestDated) {
      best = rule;
      bestDated = dated;
    }
  });
  return best;
}

export function nightPrice(baseRate, rule) {
  const base = Number(baseRate) || 0;
  if (!rule) return round2(base);
  if (rule.kind === 'percent') return round2(Math.max(0, base * (1 + Number(rule.amount) / 100)));
  return round2(Math.max(0, Number(rule.amount)));
}

// Price every night of a stay. Returns { nightly: [{date, price, rule}], total }.
export function priceStay(baseRate, rules, checkIn, nights) {
  const start = dayNumber(checkIn);
  const nightly = [];
  let total = 0;
  for (let i = 0; i < nights; i++) {
    const date = dayString(start + i);
    const rule = ruleForNight(rules, date);
    const price = nightPrice(baseRate, rule);
    total += price;
    nightly.push({ date, price, rule: rule ? rule.name : null });
  }
  return { nightly, total: round2(total) };
}

// The minimum stay a rule asks for, judged by the check-in night. 0 = none.
export function ruleMinStay(rules, checkIn) {
  const rule = ruleForNight(rules, checkIn);
  return rule && rule.min_stay ? Number(rule.min_stay) : 0;
}

// For the booking widget: only the dates whose price differs from the normal
// price, for the next `days` days. { 'YYYY-MM-DD': price }
export function priceOverrides(baseRate, rules, fromDate, days) {
  const out = {};
  if (!rules || rules.length === 0) return out;
  const start = dayNumber(fromDate);
  const base = round2(baseRate);
  for (let i = 0; i <= days; i++) {
    const date = dayString(start + i);
    const price = nightPrice(baseRate, ruleForNight(rules, date));
    if (price !== base) out[date] = price;
  }
  return out;
}

// For the booking widget: minimum stays set by rules, per date.
export function minStayOverrides(rules, fromDate, days) {
  const out = {};
  if (!rules || !rules.some((r) => r.min_stay)) return out;
  const start = dayNumber(fromDate);
  for (let i = 0; i <= days; i++) {
    const date = dayString(start + i);
    const m = ruleMinStay(rules, date);
    if (m > 1) out[date] = m;
  }
  return out;
}
