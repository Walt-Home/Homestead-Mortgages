/**
 * The reference policy for escrow-history: Step 0 through the tools, then
 * escrow-analysis's reference over the account it read.
 */

import { ScriptedPolicy, type Call, type Json, type Step } from "../refi/reference.js";
import { escrowSteps } from "../escrow/reference.js";
import { ESCROW_SUBMIT_TOOL } from "../escrow/tools.js";

interface Posting {
  on: string;
  type: "deposit" | "disbursement";
  line_type: string | null;
  amount_cents: number;
  description: string;
}

export function* historySteps(p: Json, call: Call): Step<Json> {
  const calc = (expression: string) => call<string>("calculate", { expression }, "value");
  const ledger = p["ledger"] as {
    opened: { on: string; balance_cents: number };
    posted: Posting[];
    scheduled: Posting[];
  };
  const yearStart = p["year_start"] as string;
  const from = yield* call<string>("date_add", { date: yearStart, months: -12 }, "date");
  const all = [...ledger.posted, ...ledger.scheduled];

  const lines: Json[] = [];
  for (const l of p["lines"] as Json[]) {
    const paid = all
      .filter(
        (x) =>
          x.type === "disbursement" &&
          x.line_type === l["line_type"] &&
          x.on >= from &&
          x.on < yearStart,
      )
      .sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
    const total = paid.length
      ? yield* calc(paid.map((x) => String(x.amount_cents)).join(" + "))
      : "0";
    lines.push({
      ...l,
      prior_year_annual_cents: Number(total),
      prior_disbursed_on: paid.map((x) => x.on),
    });
  }
  const signed = ledger.posted.map((x) => `${x.type === "deposit" ? "+" : "-"} ${x.amount_cents}`);
  const balance = yield* calc(`${ledger.opened.balance_cents} ${signed.join(" ")}`);
  const of = (type: Posting["type"]) =>
    ledger.scheduled
      .filter((x) => x.type === type)
      .map((x) => ({ on: x.on, amount_cents: x.amount_cents, description: x.description }));

  return yield* escrowSteps(
    {
      ...p,
      lines,
      ledger: {
        balance_cents: Number(balance),
        deposits: of("deposit"),
        disbursements: of("disbursement"),
      },
    },
    call,
  );
}

export class HistoryReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference:escrow-history-rulebook", historySteps, ESCROW_SUBMIT_TOOL);
  }
}
