/**
 * The reference policy for escrow-review: escrow-analysis's reference
 * through Step 9 and its anomalies, then each billed line's variance against
 * last year through the calculator, and the flag. It reads only the
 * rendered task; the history beside the inputs is read by nothing it does,
 * as the rulebook says.
 */

import { ScriptedPolicy, type Call, type Json, type Step } from "../refi/reference.js";
import { calcAsk, escrowSteps, together } from "../escrow/reference.js";
import { REVIEW_SUBMIT_TOOL } from "./tools.js";

interface Line {
  line_type: string;
  prior_year_annual_cents: number;
  known_bills?: { amount_cents: number }[];
}

export function* escrowReviewSteps(p: Json, call: Call): Step<Json> {
  const a = yield* escrowSteps(p, call);
  // Step 10's bill variance: each line with bills and a prior year, side by side.
  const billed = (p["lines"] as Line[]).filter(
    (l) => (l.known_bills ?? []).length > 0 && l.prior_year_annual_cents > 0,
  );
  const variances = (yield* together(
    billed.map((l) => {
      const sum = l.known_bills!.map((b) => String(b.amount_cents)).join(" + ");
      return calcAsk(
        `floor(abs(${sum} - ${l.prior_year_annual_cents}) * 10000 / ${l.prior_year_annual_cents})`,
      );
    }),
  )) as string[];
  const anomalies = [...(a["anomalies"] as string[])];
  if (variances.some((v) => BigInt(v) > 2000n)) anomalies.push("bill_variance_gt_20pct");
  const shortage = a["decision"] === "shortage";
  return {
    annual_cents: a["annual_cents"],
    base_payment_cents: a["base_payment_cents"],
    target_at_start_cents: a["target_at_start_cents"],
    projected_actual_cents: a["projected_actual_cents"],
    decision: a["decision"],
    surplus_cents: a["surplus_cents"],
    shortage_cents: shortage ? a["shortage_cents"] : null,
    deficiency_cents: shortage ? a["deficiency_cents"] : null,
    repayment_months: shortage ? a["repayment_months"] : null,
    new_payment_cents: a["new_payment_cents"],
    effective_on: a["effective_on"],
    anomalies,
    // Step 11
    flag_stands: anomalies.length > 0,
  };
}

export class ReviewReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference:escrow-review-rulebook", escrowReviewSteps, REVIEW_SUBMIT_TOOL);
  }
}
