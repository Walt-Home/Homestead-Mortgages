/**
 * The tools: refi's level payment, date steps and exact calculator, and one
 * more, the principal a level payment supports, rounded down to the cent —
 * the closed form Step 9 begins from, computed exactly as the engine
 * computes it. None of them runs a waterfall step or decides anything.
 */

import { Decimal, ratePercent } from "@hm/kernel/money";
import type { ToolSpec } from "../episode.js";
import { TOOLS, executeTool } from "../refi/tools.js";

export const FLEX_SUBMIT_TOOL = "submit_evaluation";

const REUSED = [
  "level_payment",
  "date_add",
  "days_between",
  "end_of_month",
  "whole_months_between",
  "calculate",
];
const CENTS = { type: "string", pattern: "^-?\\d+$", description: 'Integer cents, e.g. "126413".' };
const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD." };
const orNull = (schema: unknown) => ({ anyOf: [schema, { type: "null" }] });

export const FLEX_TOOLS: readonly ToolSpec[] = [
  ...TOOLS.filter((t) => REUSED.includes(t.name)),
  {
    name: "annuity_principal",
    description:
      "The principal that a level monthly payment repays over a number of months at an annual rate: payment × ((1 + r)^n − 1) ÷ (r × (1 + r)^n), with r = the annual rate ÷ 12, computed exactly and rounded DOWN to the cent.",
    input_schema: {
      type: "object",
      properties: {
        payment_cents: CENTS,
        annual_rate_pct: {
          type: "string",
          pattern: "^\\d{1,2}(\\.\\d{1,3})?$",
          description: 'Annual percentage, e.g. "6.500".',
        },
        months: { type: "integer", minimum: 1, maximum: 600 },
      },
      required: ["payment_cents", "annual_rate_pct", "months"],
      additionalProperties: false,
    },
  },
  {
    name: FLEX_SUBMIT_TOOL,
    description:
      "Submit the evaluation. Call it once, when every field is decided; a figure the evaluation does not have is null. A valid submission ends the task.",
    input_schema: {
      type: "object",
      properties: {
        decision: { type: "string", enum: ["offer", "denied"] },
        denial_reason: orNull({
          type: "string",
          enum: [
            "FNMA_D23206_TRIAL_FAILED_12M",
            "FNMA_D23206_THREE_PRIOR_MODS",
            "INV_FNMA_F127_PI_RULE",
          ],
        }),
        mir_pct: orNull({ type: "string", pattern: "^\\d{1,2}\\.\\d{3}$" }),
        gross_upb_cents: orNull(CENTS),
        mtmltv_pct: orNull({ type: "string", pattern: "^\\d{1,4}\\.\\d{2}$" }),
        target_pi_cents: orNull(CENTS),
        rate_pct: orNull({ type: "string", pattern: "^\\d{1,2}\\.\\d{3}$" }),
        term_months: orNull({ type: "integer" }),
        forborne_cents: orNull(CENTS),
        ib_upb_cents: orNull(CENTS),
        pi_cents: orNull(CENTS),
        reduction_pct: orNull({ type: "string", pattern: "^-?\\d{1,4}\\.\\d{4}$" }),
        post_mod_ib_mtmltv_pct: orNull({ type: "string", pattern: "^\\d{1,4}\\.\\d{2}$" }),
        exhaustion_offer: orNull({ type: "boolean" }),
        trial_months: orNull({ type: "integer" }),
        first_trial_due_on: orNull(DATE),
        last_trial_due_on: orNull(DATE),
        trial_payment_cents: orNull(CENTS),
        effective_on: orNull(DATE),
        capitalization_on: orNull(DATE),
        maturity_on: orNull(DATE),
        incentive_deadline: orNull(DATE),
      },
      required: [
        "decision",
        "denial_reason",
        "mir_pct",
        "gross_upb_cents",
        "mtmltv_pct",
        "target_pi_cents",
        "rate_pct",
        "term_months",
        "forborne_cents",
        "ib_upb_cents",
        "pi_cents",
        "reduction_pct",
        "post_mod_ib_mtmltv_pct",
        "exhaustion_offer",
        "trial_months",
        "first_trial_due_on",
        "last_trial_due_on",
        "trial_payment_cents",
        "effective_on",
        "capitalization_on",
        "maturity_on",
        "incentive_deadline",
      ],
      additionalProperties: false,
    },
  },
];

/** The engine's own closed form (flexmod.ts solveUpb, before its verify loop), floored to the cent. */
export function annuityPrincipal(paymentCents: bigint, ratePct: string, months: number): bigint {
  const r = ratePercent(ratePct).div(Decimal.fromInt(12));
  const growth = Decimal.ONE.add(r).pow(months);
  return Decimal.ratio(paymentCents, 100n)
    .mul(growth.sub(Decimal.ONE))
    .div(r.mul(growth))
    .toCents("FLOOR");
}

export function executeFlexTool(name: string, raw: unknown): string {
  if (name === "annuity_principal") {
    const i = (raw ?? {}) as Record<string, unknown>;
    const p = i["payment_cents"];
    const rate = i["annual_rate_pct"];
    const n = i["months"];
    if (typeof p !== "string" || !/^\d+$/.test(p))
      throw new TypeError('payment_cents must be integer cents as a string, e.g. "126413"');
    if (typeof rate !== "string" || !/^\d{1,2}(\.\d{1,3})?$/.test(rate) || Number(rate) <= 0)
      throw new TypeError('annual_rate_pct must be a positive annual percentage, e.g. "6.500"');
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 600)
      throw new TypeError("months must be a whole number from 1 to 600");
    return JSON.stringify({ principal_cents: annuityPrincipal(BigInt(p), rate, n).toString() });
  }
  if (!REUSED.includes(name)) {
    throw new TypeError(
      `no tool named ${JSON.stringify(name)}; the tools are ${FLEX_TOOLS.map((t) => t.name).join(", ")}`,
    );
  }
  return executeTool(name, raw);
}
