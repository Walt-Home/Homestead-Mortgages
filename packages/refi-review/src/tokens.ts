/**
 * The review's figures as tokens, and what the tokens stand for.
 *
 * Doug's §33.2 rule 4 hands the refinance analyst the day's facts as
 * `{{facts.<key>}}` tokens and never a figure: the model writes the token,
 * the surface fills it. Ported here, pure, so the analyst's turn (which
 * writes tokens) and the page (which fills them) read one list and cannot
 * disagree about which figures exist. The keys are his, one per fact the
 * review carries; a key whose fact is null on the day is absent, so the
 * model is never given a token that stands for nothing.
 */

import type { ReviewFacts } from "./engine.js";

export const REVIEW_TOKEN_KEYS = [
  "rate_now",
  "candidate_rate",
  "rate_delta",
  "upb",
  "value",
  "value_as_of",
  "ltv",
  "remaining_term",
  "payment_now",
  "candidate_payment",
  "monthly_delta",
  "npv",
  "breakeven",
  "seven_year_delta",
  "days_delinquent",
  "watch_rate",
] as const;
export type ReviewTokenKey = (typeof REVIEW_TOKEN_KEYS)[number];

/** The token for each key, or null where the day's facts have no figure behind it. */
export function reviewTokens(f: ReviewFacts): Record<ReviewTokenKey, string | null> {
  const t = (k: ReviewTokenKey, present: boolean): string | null =>
    present ? `{{facts.${k}}}` : null;
  return {
    rate_now: t("rate_now", true),
    candidate_rate: t("candidate_rate", f.candidate_rate_pct !== null),
    rate_delta: t("rate_delta", f.rate_delta_bps !== null),
    upb: t("upb", true),
    value: t("value", true),
    value_as_of: t("value_as_of", true),
    ltv: t("ltv", true),
    remaining_term: t("remaining_term", true),
    payment_now: t("payment_now", true),
    candidate_payment: t("candidate_payment", f.candidate_pi_cents !== null),
    monthly_delta: t("monthly_delta", f.monthly_delta_cents !== null),
    npv: t("npv", f.npv_cents !== null),
    breakeven: t("breakeven", f.breakeven_months !== null),
    seven_year_delta: t("seven_year_delta", f.seven_year_delta_cents !== null),
    days_delinquent: t("days_delinquent", true),
    watch_rate: t("watch_rate", f.watch_rate_pct !== undefined),
  };
}

/** "6.250" → "6.25%"; the trailing zeros a three-decimal rate carries are not part of the rate. */
export function pctWords(pct: string): string {
  const n = Number(pct);
  if (!Number.isFinite(n)) return `${pct}%`;
  return `${n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

/** Cents as dollars a person reads: whole when whole, two places otherwise, the sign in front of the dollar. */
export function usdWords(cents: string): string {
  const n = BigInt(cents);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const dollars = abs / 100n;
  const rest = abs % 100n;
  const whole = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = rest === 0n ? `$${whole}` : `$${whole}.${rest.toString().padStart(2, "0")}`;
  return neg ? `-${body}` : body;
}

const monthsWords = (n: number) => `${n} month${n === 1 ? "" : "s"}`;

/** The tokens' values, keyed `facts.<key>`: the engine's figures, formatted for a person. */
export function reviewTokenValues(f: ReviewFacts): Record<string, string> {
  const ltv = Number(f.ltv);
  const out: Record<string, string> = {
    "facts.rate_now": pctWords(f.note_rate_pct),
    "facts.upb": usdWords(f.upb_cents),
    "facts.value": usdWords(f.value_cents),
    "facts.value_as_of": f.value_as_of,
    "facts.ltv": Number.isFinite(ltv) ? `${(ltv * 100).toFixed(2)}%` : f.ltv,
    "facts.remaining_term": monthsWords(f.remaining_term_months),
    "facts.payment_now": usdWords(f.pi_cents),
    "facts.days_delinquent": String(f.days_delinquent),
  };
  if (f.candidate_rate_pct !== null) out["facts.candidate_rate"] = pctWords(f.candidate_rate_pct);
  if (f.rate_delta_bps !== null) out["facts.rate_delta"] = `${f.rate_delta_bps} basis points`;
  if (f.candidate_pi_cents !== null)
    out["facts.candidate_payment"] = usdWords(f.candidate_pi_cents);
  if (f.monthly_delta_cents !== null) out["facts.monthly_delta"] = usdWords(f.monthly_delta_cents);
  if (f.npv_cents !== null) out["facts.npv"] = usdWords(f.npv_cents);
  if (f.breakeven_months !== null) out["facts.breakeven"] = monthsWords(f.breakeven_months);
  if (f.seven_year_delta_cents !== null)
    out["facts.seven_year_delta"] = usdWords(f.seven_year_delta_cents);
  if (f.watch_rate_pct !== undefined) out["facts.watch_rate"] = pctWords(f.watch_rate_pct);
  return out;
}

export const TOKEN = /\{\{([a-zA-Z0-9_.:-]+)\}\}/g;

/** The tokens in a text that the day's facts do not stand behind. Empty for a text the surface can fill whole. */
export function unknownTokens(text: string, f: ReviewFacts): string[] {
  const known = reviewTokenValues(f);
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const key = m[1]!;
    if (!(key in known) && !out.includes(key)) out.push(key);
  }
  return out;
}

/** The text with every token the facts stand behind filled; a token they do not is left as written. */
export function fillReviewTokens(text: string, f: ReviewFacts): string {
  const values = reviewTokenValues(f);
  return text.replace(TOKEN, (whole, key: string) => values[key] ?? whole);
}
