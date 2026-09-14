/**
 * The `Applies when` column, made executable.
 *
 * Every condition key in the registry has a predicate here, and the predicate
 * returns THREE states, not two:
 *
 *   true   — this requirement applies to this borrower
 *   false  — it does not, and we know that
 *   null   — we cannot know yet, because the data that decides it has not
 *            arrived
 *
 * The third state is the whole reason this file exists. At screen 1 we do not
 * know whether the credit report carries a dispute flag, so CRD-014 is not
 * "inapplicable" — it is undetermined. Collapsing null to false would tell a
 * borrower they are finished when the credit pull is about to add four more
 * requirements, and telling somebody they are done and then reopening the file
 * is the single worst thing this product can do.
 */

import type { Borrower, LoanFile } from "@hm/shared";
import { COMMUNITY_PROPERTY_STATES, RESIDENCE_HISTORY_MONTHS } from "@hm/shared";
import type { ConditionKey } from "./types.js";

/** true / false / not-yet-knowable. */
export type Applicability = boolean | null;

type Predicate = (file: LoanFile) => Applicability;

/**
 * True of anybody makes it true; false only once it is false of everybody.
 *
 * `some()` over a three-valued answer would read "nobody has asked him" as a
 * no, which is rule 2's mistake wearing a second borrower's name. One person
 * saying they rent has to survive the other person's silence, and one person's
 * silence has to leave the file undetermined rather than settle it — the same
 * reason `null` exists at all.
 */
function ofAnyBorrower(
  borrowers: readonly Borrower[],
  of: (b: Borrower) => Applicability,
): Applicability {
  if (borrowers.length === 0) return null;
  const answers = borrowers.map(of);
  if (answers.includes(true)) return true;
  return answers.includes(null) ? null : false;
}

/** Months back from today, for "recent" windows the sheet leaves in prose. */
function monthsAgo(iso: string, now: Date): number {
  const then = new Date(iso);
  return (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth());
}

function daysAgo(iso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
}

const SIGNIFICANT_DEROGATORY = new Set(["foreclosure", "short_sale", "deed_in_lieu"]);

/**
 * A tradeline count below this reads as a thin file. Fannie's own rule is
 * expressed as "insufficient tradelines to generate a score", which is a
 * bureau behaviour rather than a number; three is the industry proxy and is
 * the number CRD-013's own evidence column implies by asking for three
 * alternative references.
 */
const THIN_FILE_TRADELINE_COUNT = 3;

export const CONDITIONS: Record<ConditionKey, Predicate> = {
  universal: () => true,

  purchase: (f) => (f.loan ? f.loan.purpose === "purchase" : null),

  refinance: (f) => (f.loan ? f.loan.purpose !== "purchase" : null),

  cash_out_refinance: (f) => (f.loan ? f.loan.purpose === "cash_out_refinance" : null),

  community_property_state: (f) =>
    f.property ? COMMUNITY_PROPERTY_STATES.includes(f.property.address.state) : null,

  electronic_delivery: (f) => f.deliveryMethod === "electronic",

  borrower_lep: (f) =>
    f.borrowers.length === 0 ? null : f.borrowers.some((b) => b.preferredLanguage !== "en"),

  borrowed_funds_used: (f) => (f.assets ? f.assets.borrowedFunds.length > 0 : null),

  prior_significant_derogatory: (f) =>
    f.credit ? f.credit.publicRecords.some((r) => SIGNIFICANT_DEROGATORY.has(r.type)) : null,

  dispute_flag: (f) => (f.credit ? f.credit.tradelines.some((t) => t.disputed) : null),

  /**
   * "Deposit exceeds 50% of monthly income" needs both halves. If we have the
   * asset report but no income yet we genuinely cannot answer — the same
   * $4,000 deposit is sourceable or not depending on a number screen 5 has
   * not returned.
   */
  large_deposit_present: (f) => {
    if (!f.assets) return null;
    const monthlyIncome = f.incomeSources.reduce((sum, s) => sum + s.monthlyAmount, 0);
    if (monthlyIncome === 0) return null;
    return f.assets.largeDeposits.some((d) => d.amount > monthlyIncome * 0.5);
  },

  retirement_assets_used: (f) =>
    f.assets ? f.assets.accounts.some((a) => a.type === "retirement" && a.usedForQualifying) : null,

  thin_credit_file: (f) =>
    f.credit
      ? f.credit.scores.length === 0 || f.credit.tradelines.length < THIN_FILE_TRADELINE_COUNT
      : null,

  asset_report_available: (f) => f.assets !== null,

  /**
   * Anybody on the file who rents and has no mortgage rating in the last 12
   * months. Owning already settles one person as false; renting plus a
   * mortgage tradeline does too. The rent history is asked for once and covers
   * whoever pays it, so one renter makes it apply to the file.
   *
   * A null basis is "we have not asked", and it answers null. The test used to
   * be `=== "own"` alone, which made everybody else a renter — and while the
   * column carried a NOT NULL default of `"rent"` that was every borrower in
   * the product. Treating unknown as renting is the two-valued mistake rule 2
   * exists to stop: it lets the engine answer a question about somebody's
   * housing that nobody has put to them.
   */
  renter_limited_mortgage_history: (f) => {
    // The file carries ONE credit report and that report carries no party.
    // Every pull mints its token from the first borrower, so the tradelines
    // are hers and nobody else's — judging a co-borrower by them retires his
    // rent history on the strength of her mortgage, which is the borrowed
    // evidence this predicate was made per-borrower to stop. Until a report
    // exists per borrower, everybody but her answers null: "we have not
    // pulled his credit" has to stay distinguishable from "he has a mortgage".
    const whoseCreditThisIs = f.borrowers[0];
    return ofAnyBorrower(f.borrowers, (borrower) => {
      if (borrower.currentHousing === null) return null;
      if (borrower.currentHousing === "own") return false;
      if (borrower !== whoseCreditThisIs || !f.credit) return null;
      const hasMortgageHistory = f.credit.tradelines.some(
        (t) => t.type === "mortgage" && t.paymentHistory.length >= 12,
      );
      return !hasMortgageHistory;
    });
  },

  wage_earner: (f) =>
    f.employment.length === 0 && f.incomeSources.length === 0
      ? null
      : f.incomeSources.some((s) => s.type === "base_wage"),

  retirement_income_used: (f) =>
    f.incomeSources.length === 0
      ? null
      : f.incomeSources.some(
          (s) => s.type === "retirement" || s.type === "pension" || s.type === "social_security",
        ),

  investment_income_used: (f) =>
    f.incomeSources.length === 0
      ? null
      : f.incomeSources.some((s) => s.type === "investment" || s.type === "dividend"),

  variable_income_present: (f) =>
    f.incomeSources.length === 0
      ? null
      : f.incomeSources.some(
          (s) => s.type === "overtime" || s.type === "bonus" || s.type === "commission",
        ),

  employment_gap: (f) => {
    if (!f.payroll) return null;
    const now = new Date();
    return f.payroll.gaps.some((g) => g.days > 30 && monthsAgo(g.startDate, now) <= 24);
  },

  military_borrower: (f) =>
    f.borrowers.length === 0 ? null : f.borrowers.some((b) => b.isMilitary),

  self_employed_variable_or_rental: (f) =>
    f.incomeSources.length === 0
      ? null
      : f.incomeSources.some(
          (s) =>
            s.type === "self_employment" ||
            s.type === "rental" ||
            s.type === "overtime" ||
            s.type === "bonus" ||
            s.type === "commission",
        ),

  gift_funds_used: (f) => (f.assets ? f.assets.gifts.length > 0 : null),

  prior_bankruptcy: (f) =>
    f.credit ? f.credit.publicRecords.some((r) => r.type === "bankruptcy") : null,

  /**
   * "Recent derogatory present". The sheet does not define recent; 24 months
   * is the window every agency guide uses for a derogatory that needs a
   * letter of explanation, and it matches the 24 months of payment history the
   * tri-merge returns.
   */
  recent_derogatory: (f) => {
    if (!f.credit) return null;
    const now = new Date();
    const recentRecord = f.credit.publicRecords.some((r) => monthsAgo(r.date, now) <= 24);
    const recentLate = f.credit.tradelines.some((t) => t.maxDelinquency > 0);
    return recentRecord || recentLate;
  },

  recent_inquiries: (f) => {
    if (!f.credit) return null;
    const now = new Date();
    return f.credit.inquiries.some((i) => daysAgo(i.date, now) <= 90);
  },

  ssn_mismatch_or_fraud_alert: (f) =>
    f.credit ? f.credit.ssnMismatch || f.credit.fraudAlert : null,

  support_income_used: (f) =>
    f.incomeSources.length === 0
      ? null
      : f.incomeSources.some((s) => s.type === "alimony" || s.type === "child_support"),

  equity_comp_used: (f) =>
    f.incomeSources.length === 0
      ? null
      : f.incomeSources.some((s) => s.type === "equity_compensation"),

  /**
   * "Refi; state or investor requires". The state list and the investor
   * overlay list are both product configuration we do not have yet, so this
   * answers null on a refinance rather than guessing. It is the one condition
   * whose false case we cannot currently prove.
   */
  refi_ntb_required: (f) => {
    if (!f.loan) return null;
    if (f.loan.purpose === "purchase") return false;
    return null;
  },

  reserves_required: (f) => {
    const required = f.decision?.reserves.requiredMonths;
    return required === undefined || required === null ? null : required > 0;
  },

  ipc_present: (f) => (f.loan ? f.loan.interestedPartyContributions > 0 : null),

  aus_refer_or_ineligible: (f) => {
    const rec = f.decision?.aus?.recommendation;
    if (!rec) return null;
    return rec === "refer" || rec === "refer_with_caution" || rec === "approve_ineligible";
  },

  overlays_exist: (f) => (f.product ? f.product.overlays.length > 0 : null),

  denial_or_counteroffer: (f) => {
    const outcome = f.decision?.outcome;
    // `referred` is "cannot know yet", exactly like `pending`. A referral has
    // decided nothing, so whether a notice is owed is still an open question —
    // and answering `false` would let a file that is about to be declined
    // report itself as having no adverse-action obligation.
    if (!outcome || outcome === "pending" || outcome === "referred") return null;
    return outcome === "denied" || outcome === "counteroffer";
  },

  /*
   * The three conditions that read the borrower's own declaration.
   *
   * Every one of them is null until the declaration exists, and that is the
   * whole reason they are conditions rather than checks inside an evaluator.
   * "We have not asked you yet" and "you told us no" are different facts about
   * a person, and the follow-up questions are the place where collapsing them
   * would say a borrower is finished with questions nobody has put to them.
   *
   * They read the declaration and nothing else. A credit report showing no
   * bankruptcy does not answer M, a property record showing no prior deed does
   * not answer the homeowner question, and a file with neither answers
   * neither — which is why none of these predicates so much as looks at a
   * snapshot.
   *
   * All three are `ofAnyBorrower`, and each for its own reason rather than by
   * one rule. The follow-up questions they gate are asked of whoever triggered
   * them: one person's bankruptcy needs its chapters, one person's prior
   * property needs its usage, one person's recent move needs the address
   * before it. A file-level read took those answers from borrower 1, so a
   * co-borrower's declared bankruptcy left `declared_bankruptcy` false and
   * APP-024 off the outstanding list entirely — while the review screen showed
   * him the bankruptcy he had declared, above the signature.
   *
   * Whether every borrower ANSWERED is a different question, and it is
   * APP-022, APP-023 and APP-026 in `satisfaction.ts` that ask it.
   */
  declared_homeowner_past_three_years: (f) =>
    ofAnyBorrower(f.borrowers, (b) =>
      b.declaration ? b.declaration.homeownerPastThreeYears === "Yes" : null,
    ),

  declared_bankruptcy: (f) =>
    ofAnyBorrower(f.borrowers, (b) => (b.declaration ? b.declaration.bankruptcy : null)),

  current_residence_under_two_years: (f) =>
    ofAnyBorrower(f.borrowers, (b) => {
      const current = b.residences.find((r) => r.residencyType === "Current");
      return current ? current.durationMonths < RESIDENCE_HISTORY_MONTHS : null;
    }),
};

export function evaluateCondition(key: ConditionKey, file: LoanFile): Applicability {
  return CONDITIONS[key](file);
}
