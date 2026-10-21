/**
 * The regz-apr environment: regz-price-tests with the Appendix J solve taken
 * out of the tools.
 *
 * Everything else is regz-price-tests's — the quotes, the grader, the
 * other tools, every step but the third. In its place the model gets
 * refi's present-value tool and Step 3 says what the APR is: the rate at
 * which the payments' present value is the amount financed, to three
 * decimals, rounded half up. Finding it is a search a compliance analyst
 * runs when checking a disclosed APR, and it is the arithmetic every one of
 * the price tests stands on.
 *
 * Fair to grade by construction, as regz-price-tests is: a quote is kept
 * only once the reference, searching through these tools, lands on the
 * engine's APR and every answer after it.
 */

import type { Environment } from "../episode.js";
import { sha256 } from "../record.js";
import { TOOLS, executeTool } from "../refi/tools.js";
import type { Call, Step } from "../refi/reference.js";
import type { Split } from "../refi/task.js";
import { ScriptedPolicy } from "../refi/reference.js";
import {
  REGZ_FINGERPRINT,
  REGZ_RULEBOOK,
  REGZ_SUBMIT_TOOL,
  REGZ_TOOLS,
  drawRegzTask,
  executeRegzTool,
  regzPriceTests,
  regzStepsWith,
  type AprStep,
  type RegzAnswer,
  type RegzDraw,
  type RegzTask,
} from "../regz/index.js";

export const REGZ_APR_ENVIRONMENT_NAME = "regz-apr";
/**
 * Bump on any change to Step 3, the tools or the search, or to anything regz-price-tests's version covers.
 *
 * 1.1.0 (21 Oct 2026): with regz-price-tests 1.1.0.
 */
export const REGZ_APR_ENVIRONMENT_VERSION = "1.1.0";

const STEP_THREE_TOOL =
  "Otherwise the APR is annual_percentage_rate(loan amount, note rate, term_months, prepaid_finance_charges).";
export const STEP_THREE_SEARCH = `Otherwise the APR is Regulation Z Appendix J's, and you find it yourself:
- The amount financed is the loan amount − prepaid_finance_charges. The payment is level_payment(loan amount, note rate, term_months).
- The APR is the annual rate at which present_value(the payment, that rate, term_months) equals the amount financed, rounded half up to three decimals. present_value falls as the rate rises: a rate whose present value is more than the amount financed is below the APR, and one whose present value is not more is at or above it.
- So let r be the highest three-decimal rate whose present value is more than the amount financed. The APR is r + 0.001 when present_value at r + 0.0005 is the amount financed or more, and r when it is less.`;

export const REGZ_APR_RULEBOOK = REGZ_RULEBOOK.replace(STEP_THREE_TOOL, STEP_THREE_SEARCH);

export const REGZ_APR_TOOLS = [
  ...REGZ_TOOLS.filter((t) => t.name !== "annual_percentage_rate" && t.name !== REGZ_SUBMIT_TOOL),
  ...TOOLS.filter((t) => t.name === "present_value"),
  ...REGZ_TOOLS.filter((t) => t.name === REGZ_SUBMIT_TOOL),
];

export function executeRegzAprTool(name: string, raw: unknown): string {
  if (name === "present_value") return executeTool(name, raw);
  if (name === "annual_percentage_rate" || !REGZ_APR_TOOLS.some((t) => t.name === name)) {
    throw new TypeError(
      `no tool named ${JSON.stringify(name)}; the tools are ${REGZ_APR_TOOLS.map((t) => t.name).join(", ")}`,
    );
  }
  return executeRegzTool(name, raw);
}

/** Step 3's search, through the tools: bracket on whole points, halve to the thousandth, read the half. */
export const aprBySearch: AprStep = function* (i, call: Call): Step<string> {
  const payment = yield* call<string>(
    "level_payment",
    { principal_cents: String(i.loanCents), annual_rate_pct: i.note, term_months: i.term },
    "payment_cents",
  );
  const financed = BigInt(
    yield* call<string>("calculate", { expression: `${i.loanCents} - ${i.prepaidCents}` }, "value"),
  );
  const pv = function* (rate: string): Step<bigint> {
    return BigInt(
      yield* call<string>(
        "present_value",
        { monthly_amount_cents: payment, annual_rate_pct: rate, months: i.term },
        "present_value_cents",
      ),
    );
  };
  const at = (milli: number) => (milli / 1000).toFixed(3);
  let lo = Math.round(Number(i.note) * 1000);
  while ((yield* pv(at(lo))) <= financed) lo -= 1000;
  let hi = lo + 1000;
  while ((yield* pv(at(hi))) > financed) hi += 1000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((yield* pv(at(mid))) > financed) lo = mid;
    else hi = mid;
  }
  const half = yield* pv(((lo * 10 + 5) / 10_000).toFixed(4));
  return at(half >= financed ? lo + 1 : lo);
};

export const regzAprSteps = regzStepsWith(aprBySearch);

export const regzAprTaskId = (split: Split, suiteSeed: number, index: number): string =>
  `${REGZ_APR_ENVIRONMENT_NAME}/${REGZ_APR_ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

export const REGZ_APR_DRAW: RegzDraw = {
  taskId: regzAprTaskId,
  steps: regzAprSteps,
  execute: executeRegzAprTool,
};

export const generateRegzAprTask = (
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
) => drawRegzTask(split, suiteSeed, index, REGZ_APR_DRAW).task;

export function generateRegzAprSuite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): RegzTask[] {
  return Array.from({ length: n }, (_, i) => generateRegzAprTask(split, suiteSeed, i));
}

export const REGZ_APR_HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 200 };

export const regzApr: Environment<RegzTask, RegzAnswer> = {
  ...regzPriceTests,
  name: REGZ_APR_ENVIRONMENT_NAME,
  version: REGZ_APR_ENVIRONMENT_VERSION,
  system: REGZ_APR_RULEBOOK,
  tools: REGZ_APR_TOOLS,
  execute: executeRegzAprTool,
};

export const REGZ_APR_FINGERPRINT = {
  environment: {
    name: REGZ_APR_ENVIRONMENT_NAME,
    version: REGZ_APR_ENVIRONMENT_VERSION,
    rulebook_sha256: sha256(REGZ_APR_RULEBOOK),
    tools_sha256: sha256(JSON.stringify(REGZ_APR_TOOLS)),
  },
  grader: REGZ_FINGERPRINT.grader,
} as const;

export class RegzAprReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference:regz-apr-rulebook", regzAprSteps, REGZ_SUBMIT_TOOL);
  }
}
