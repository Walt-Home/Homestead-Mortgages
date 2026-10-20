/**
 * The grader is the engine.
 *
 * What a task should conclude is `reviewLoan` run on the task's inputs, at
 * grading time, outside anything a policy can reach. The answer is held to
 * it field by field: the verdict, the reasons as a set, and — for a
 * candidate — every figure the disclosure states, to the cent; for a loan
 * being watched, the watch rate. A pass is every field right. The score is
 * the share right, recorded beside the pass and never instead of it.
 */

import { reviewLoan, type Review, type ReviewVerdict } from "@hm/refi-review";
import type { FieldGrade, Grade, Parsed } from "../episode.js";
import { OFFER_FIELDS, type OfferCentsField } from "./tools.js";
import type { RefiTask } from "./task.js";

export interface RefiOffer extends Readonly<Record<OfferCentsField, string>> {
  readonly rate_delta_bps: string;
  readonly present_same_term_first: boolean;
}

/** The review's four verdicts, and the tape variant's fifth for a row the tape cannot describe. */
export type RefiVerdict = ReviewVerdict | "not_reviewable";

export interface RefiAnswer {
  readonly verdict: RefiVerdict;
  readonly reasons: readonly string[];
  readonly offer: RefiOffer | null;
  readonly watch_rate_pct: string | null;
}

/** The engine's reason strings as the rulebook's codes: a fire-rule miss carries its figure, the code does not. */
export function reasonCode(engineReason: string): string {
  if (engineReason.startsWith("rate_delta_bps ")) return "rate_delta_below_floor";
  if (engineReason.startsWith("npv_cents ")) return "npv_not_positive";
  if (engineReason.startsWith("seven_year_total_cost_delta")) return "seven_year_not_lower";
  if (engineReason.startsWith("lifetime_interest_delta")) return "reset_costs_more";
  return engineReason;
}

export const expectedReview = (task: RefiTask): Review =>
  reviewLoan(task.loan, {
    as_of: task.review_date,
    rate: task.quote,
    gate_facts: task.gate_facts,
    exceptions: task.exceptions,
  });

const bps = (n: number | string): string => Number(n).toFixed(1);

export function expectedAnswer(review: Review): RefiAnswer {
  const o = review.offer;
  return {
    verdict: review.verdict,
    reasons: review.reasons.map(reasonCode),
    offer: o
      ? {
          loan_amount_cents: o.loan_amount_cents,
          new_pi_cents: o.new_pi_cents,
          pi_delta_cents: o.pi_delta_cents,
          cash_back_cents: o.cash_back_cents,
          cash_back_cap_cents: o.cash_back_cap_cents,
          lifetime_interest_existing_cents: o.lifetime_interest_existing_cents,
          lifetime_interest_new_cents: o.lifetime_interest_new_cents,
          same_term_pi_cents: o.same_term_pi_cents,
          same_term_lifetime_interest_cents: o.same_term_lifetime_interest_cents,
          npv_cents: o.npv_cents,
          seven_year_total_cost_delta_cents: o.seven_year_total_cost_delta_cents,
          rate_delta_bps: bps(o.rate_delta_bps),
          present_same_term_first: o.present_same_term_first,
        }
      : null,
    watch_rate_pct: review.verdict === "watching" ? (review.facts.watch_rate_pct ?? null) : null,
  };
}

const reasonSet = (rs: readonly string[]): string => [...new Set(rs)].sort().join(",");

export function gradeAnswer(task: RefiTask, answer: RefiAnswer | null): Grade {
  return gradeAgainst(expectedAnswer(expectedReview(task)), answer);
}

/** An answer held to the expected one, field by field. */
export function gradeAgainst(want: RefiAnswer, answer: RefiAnswer | null): Grade {
  const fields: FieldGrade[] = [];
  const check = (field: string, expected: string, got: string | null) =>
    fields.push({ field, expected, got, ok: got === expected });

  check("verdict", want.verdict, answer?.verdict ?? null);
  check("reasons", reasonSet(want.reasons), answer ? reasonSet(answer.reasons) : null);
  if (want.offer) {
    for (const f of OFFER_FIELDS) check(`offer.${f}`, want.offer[f], answer?.offer?.[f] ?? null);
    check("offer.rate_delta_bps", want.offer.rate_delta_bps, answer?.offer?.rate_delta_bps ?? null);
    check(
      "offer.present_same_term_first",
      String(want.offer.present_same_term_first),
      answer?.offer ? String(answer.offer.present_same_term_first) : null,
    );
  }
  if (want.watch_rate_pct)
    check("watch_rate_pct", want.watch_rate_pct, answer?.watch_rate_pct ?? null);

  const right = fields.filter((f) => f.ok).length;
  return { pass: right === fields.length, score: right / fields.length, fields };
}

/* ── the submission, read strictly ──────────────────────────────────────── */

const VERDICTS: readonly RefiVerdict[] = ["candidate", "watching", "not_now", "excluded"];

const centsText = (v: unknown): string | null =>
  typeof v === "string" && /^-?\d+$/.test(v.trim())
    ? BigInt(v.trim()).toString()
    : typeof v === "number" && Number.isSafeInteger(v)
      ? String(v)
      : null;

export function parseSubmission(
  raw: unknown,
  verdicts: readonly RefiVerdict[] = VERDICTS,
): Parsed<RefiAnswer> {
  const fail = (error: string): Parsed<RefiAnswer> => ({
    ok: false,
    error: `${error}. Nothing was submitted; fix it and call submit_review again.`,
  });
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return fail("the submission must be an object");
  const s = raw as Record<string, unknown>;
  const verdict = s["verdict"];
  if (typeof verdict !== "string" || !verdicts.includes(verdict as RefiVerdict)) {
    return fail(`verdict must be one of ${verdicts.join(", ")}`);
  }
  const reasons = s["reasons"];
  if (!Array.isArray(reasons) || !reasons.every((r) => typeof r === "string")) {
    return fail("reasons must be a list of reason codes");
  }
  const offerRaw = s["offer"] ?? null;
  let offer: RefiOffer | null = null;
  if (offerRaw !== null) {
    if (typeof offerRaw !== "object" || Array.isArray(offerRaw))
      return fail("offer must be an object or null");
    const o = offerRaw as Record<string, unknown>;
    const out: Record<string, string | boolean> = {};
    for (const f of OFFER_FIELDS) {
      const c = centsText(o[f]);
      if (c === null) return fail(`offer.${f} must be integer cents as a string`);
      out[f] = c;
    }
    const r = o["rate_delta_bps"];
    if (
      !(typeof r === "number" && Number.isFinite(r)) &&
      !(typeof r === "string" && /^-?\d+(\.\d+)?$/.test(r))
    ) {
      return fail("offer.rate_delta_bps must be a number");
    }
    out["rate_delta_bps"] = bps(r as number | string);
    if (typeof o["present_same_term_first"] !== "boolean") {
      return fail("offer.present_same_term_first must be true or false");
    }
    out["present_same_term_first"] = o["present_same_term_first"];
    offer = out as unknown as RefiOffer;
  }
  const w = s["watch_rate_pct"] ?? null;
  if (w !== null && !(typeof w === "string" && /^\d{1,2}\.\d{3}$/.test(w))) {
    return fail('watch_rate_pct must be a rate with three decimals, such as "6.750", or null');
  }
  return {
    ok: true,
    answer: {
      verdict: verdict as RefiVerdict,
      reasons: reasons.map((r: string) => r.trim()),
      offer,
      watch_rate_pct: w,
    },
  };
}
