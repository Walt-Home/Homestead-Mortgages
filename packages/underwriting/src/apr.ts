/**
 * The annual percentage rate, and the loans this will not state one for.
 *
 * **APR is not the note rate.** It is the rate at which the amount the borrower
 * actually receives — the loan less everything they pay at closing for the
 * privilege of the credit — grows into the payments they actually make.
 * Regulation Z fixes the method: Appendix J solves for the unit-period rate
 * that discounts the payment stream back to the amount financed, and the annual
 * figure is that rate multiplied by the number of unit periods in a year.
 *
 * Substituting the note rate for it would be the single most attractive wrong
 * answer available in this package. Every input needed for it is on the file,
 * the result is a plausible number in a plausible band, and three legal tests —
 * General QM, HPML, HOEPA — are decided on the difference between it and the
 * APOR. The gap it would hide, measured against this lender's own schedule on a
 * 30-year loan: 7 basis points at $806,500, 9 at $400,000, 15 at $150,000, 32
 * at $60,000, and 71 at $25,000. So the substitution passes on the loan sizes
 * anybody would think to check it against, and is wrong by two thirds of a
 * point on a small one — where the flat fees are most of the balance and the
 * HOEPA fee trigger is what the loan is actually failing.
 *
 * ── What this computes faithfully ─────────────────────────────────────────
 *
 * A single advance, monthly payments, equal periods, a fixed rate and full
 * amortization — the transaction Appendix J's regular-period case describes
 * exactly, and the only kind of loan V1 quotes.
 *
 * ── What it refuses, and why refusing beats estimating ────────────────────
 *
 * **Anything that does not amortize that way.** An adjustable rate needs the
 * composite-rate rules; a balloon or an interest-only period is a different
 * payment stream. There is no approximation offered for either.
 *
 * **Any loan carrying mortgage insurance.** MI premiums are finance charges
 * under §1026.4(b)(5), they are part of the payment stream, and they stop when
 * the loan reaches 78% of original value — so an APR computed without them is
 * understated, and one computed WITH them is only as good as the premium.
 * `GUIDELINES.mortgageInsurance` says of itself that it is an estimate: real
 * premiums come off an insurer's rate card and vary by score, term, coverage
 * and product.
 *
 * The size of that doubt was measured rather than assumed. Moving the estimated
 * premium by a fifth either way, and solving the full payment stream with the
 * premium ending at 78% of original value, moves the APR by 37 basis points at
 * 95% LTV, 39 at 98%, and 22 at 90%. Regulation Z's tolerance on a disclosed
 * APR for a regular transaction is an eighth of a point — 12.5 basis points,
 * §1026.22(a)(2) — so the estimate alone is three times the whole allowance
 * exactly where mortgage insurance matters. (It falls inside tolerance around
 * 85% LTV and below, which is not the case this is about.) An APR that
 * uncertain also decides HPML: at 95% LTV with the premium included the spread
 * over this week's APOR lands within a basis point or two of the 1.5-point
 * line, so the rate card would be choosing the answer.
 *
 * So an APR for a loan above 80% LTV is blocked rather than stated, and the
 * compliance tests that need one block with it. That is the whole of why a
 * high-LTV file still refers — and it is a vendor gap, not a defect: a real
 * mortgage-insurance rate card closes it and nothing else will.
 *
 * ── What it leaves out, and the bound on doing so ─────────────────────────
 *
 * Interest from disbursement to the first full period — the odd days — is a
 * prepaid finance charge, and no file here carries a disbursement date to
 * compute it from. It is omitted rather than assumed, and the omission is
 * bounded: a full month of it on a conforming loan at a market rate is under
 * six tenths of a percent of the loan amount, which moves the APR by around
 * five hundredths of a point — under half of the eighth-point tolerance above,
 * in the one direction that understates. `APR_OMITS` is recorded on the
 * derivation so the stated figure says what it does not include.
 */

import { round } from "./derive.js";

/** What the stated APR does not include. Recorded beside every figure. */
export const APR_OMITS =
  "excludes interest from disbursement to the first payment period, which no file dates yet";

export interface AprInputs {
  readonly loanAmount: number;
  /** The note rate, in percent. */
  readonly noteRate: number;
  readonly termMonths: number;
  /** The product's amortization type, spelled as Desktop Underwriter spells it. */
  readonly amortization: string;
  /** §1026.4 charges paid at closing, out of the fee schedule. */
  readonly prepaidFinanceCharges: number;
  /** Whether this loan carries mortgage insurance. See the header. */
  readonly mortgageInsuranceApplies: boolean;
}

export type AprResult =
  | {
      readonly computed: true;
      /** In percent, to three places. */
      readonly apr: number;
      readonly amountFinanced: number;
      readonly monthlyPayment: number;
    }
  | { readonly computed: false; readonly reason: string };

/** Present value of `n` payments of `payment` at monthly rate `i`. */
function presentValue(payment: number, i: number, n: number): number {
  if (i === 0) return payment * n;
  return (payment * (1 - Math.pow(1 + i, -n))) / i;
}

export function annualPercentageRate(inputs: AprInputs): AprResult {
  const { loanAmount, noteRate, termMonths, prepaidFinanceCharges } = inputs;

  if (inputs.amortization !== "Fixed") {
    return {
      computed: false,
      reason: `an annual percentage rate for a ${inputs.amortization} product (Appendix J's regular-period method describes a fixed-rate, fully amortizing loan)`,
    };
  }
  if (inputs.mortgageInsuranceApplies) {
    return {
      computed: false,
      reason:
        "an annual percentage rate for a loan carrying mortgage insurance (the premium is a finance charge and this engine holds only an estimated rate card)",
    };
  }
  if (!Number.isFinite(loanAmount) || loanAmount <= 0) {
    return { computed: false, reason: "a loan amount" };
  }
  if (!Number.isFinite(noteRate) || noteRate <= 0) {
    return { computed: false, reason: "a note rate" };
  }
  if (!Number.isInteger(termMonths) || termMonths <= 0) {
    return { computed: false, reason: "a term in whole months" };
  }
  if (!Number.isFinite(prepaidFinanceCharges) || prepaidFinanceCharges < 0) {
    return { computed: false, reason: "a fee schedule" };
  }

  const amountFinanced = round(loanAmount - prepaidFinanceCharges, 2);
  if (amountFinanced <= 0) {
    return {
      computed: false,
      reason: "an amount financed (the prepaid finance charges exceed the loan)",
    };
  }

  const noteMonthly = noteRate / 100 / 12;
  const monthlyPayment = loanAmount / presentValue(1, noteMonthly, termMonths);

  // Bisection rather than Newton: the present value is strictly decreasing in
  // the rate, so a bracket is all the method needs and it cannot wander off a
  // bad derivative. The note rate is a sound lower bound, because the amount
  // financed can only be smaller than the loan.
  //
  // The upper bound is FOUND rather than asserted. It used to be a flat 1 —
  // 100% a month — on the reasoning that no mortgage reaches it. Some inputs
  // this function accepts do: a $1,600 loan carries $1,598 of prepaid finance
  // charges off this lender's schedule, leaving $2.00 financed against a $9.85
  // payment, whose true unit-period root is about 492% a month. Bisection
  // against a bracket that excludes the root does not fail — it converges on
  // the bound and returns it, so the engine recorded a computed APR of exactly
  // 1200.000%, a fabricated number with a derivation behind it. Doubling until
  // the root is actually straddled costs a handful of iterations and makes the
  // comment true.
  let lo = noteMonthly;
  let hi = 1;
  for (let widen = 0; presentValue(monthlyPayment, hi, termMonths) > amountFinanced; widen += 1) {
    if (widen >= 40) {
      return {
        computed: false,
        reason:
          "an annual percentage rate the Appendix J solve could bracket " +
          "(the payment stream does not discount back to the amount financed at any rate this method reaches)",
      };
    }
    lo = hi;
    hi *= 2;
  }
  for (let step = 0; step < 200 && hi - lo > 1e-14; step += 1) {
    const mid = (lo + hi) / 2;
    if (presentValue(monthlyPayment, mid, termMonths) > amountFinanced) lo = mid;
    else hi = mid;
  }

  return {
    computed: true,
    apr: round(((lo + hi) / 2) * 12 * 100, 3),
    amountFinanced,
    monthlyPayment: round(monthlyPayment, 2),
  };
}
