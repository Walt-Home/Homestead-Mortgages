/**
 * The engine's reason codes in plain words — his words, so a reason reads
 * the same here and on his platform. Never a figure: a fire-rule miss such
 * as `rate_delta_bps -25 < 25` is matched by its prefix and said without
 * the number, which belongs on the facts and not in a sentence.
 */

import type { ReviewVerdict } from "./engine.js";

export const REASON_WORDS: Readonly<Record<string, string>> = {
  rate_delta: "the rate reduction clears the program's floor",
  npv_positive: "the savings over the holding period are positive",
  seven_year_delta_positive: "the total cost over seven years is lower",
  prescreen: "the loan passes the eligibility prescreen",
  state_rule: "the state's borrower's-interest rule is met",
  no_benefit: "the numbers are not there today",
  prescreen_failed: "the eligibility prescreen is not met",
  state_rule_failed: "the state's borrower's-interest rule is not met",
  not_priceable: "no rate on today's sheet covers the costs",
  not_priced: "the candidate could not be priced",
  cooldown: "the homeowner declined an offer recently",
  frequency_cap: "the homeowner has had the program's offers for the year",
  premium_recapture_window: "the loan is inside the investor's recapture window",
  marketing_suppression: "the homeowner asked not to be solicited",
  not_active: "the loan is not active",
  bankruptcy_active: "an active bankruptcy",
  foreclosure_referred: "a foreclosure referral",
  lossmit_plan_active: "a loss-mitigation plan in process",
  deceased_or_sii_pending: "a pending successor-in-interest matter",
  transfer_out_pending: "a servicing transfer pending",
  delinquent: "the loan is not current",
  not_in_universe: "the loan is not in today's universe",
  implausible_value: "the tape carries a value that does not read right",
  value_stale: "the value on file is too old",
  declined: "the homeowner declined the offer",
  expired: "the offer expired",
};

export function reasonsInWords(reasons: readonly string[]): string[] {
  return reasons.map(
    (r) =>
      REASON_WORDS[r] ??
      (r.startsWith("rate_delta_bps")
        ? "the rate reduction is under the program's floor"
        : r.startsWith("npv_cents")
          ? "the savings over the holding period are not positive"
          : r.startsWith("seven_year")
            ? "the total cost over seven years is not lower"
            : r.startsWith("lifetime_interest")
              ? "a new full term would cost more in interest and the same-term option does not save enough"
              : r.startsWith("pricing_refused")
                ? "pricing refused the candidate"
                : r
                    .replace(/[\d$%.,-]+/g, "")
                    .replace(/_/g, " ")
                    .trim()),
  );
}

export const VERDICT_WORDS: Readonly<Record<ReviewVerdict, string>> = {
  candidate: "a candidate today: the engine's offer is ready",
  watching: "watching: the loan is current and eligible, the numbers are not there today",
  not_now: "not now",
  excluded: "excluded from today's review",
};
