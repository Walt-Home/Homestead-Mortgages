/**
 * The reference policy for escrow-history: Step 0 through the tools, then
 * escrow-analysis's reference over the account it read. Each line's sum and
 * the run-date balance wait on nothing but last year's start, so they are
 * one turn.
 */

import { ScriptedPolicy, type Call, type Json, type Step } from "../refi/reference.js";
import { calcAsk, escrowSteps, together } from "../escrow/reference.js";
import { ESCROW_SUBMIT_TOOL } from "../escrow/tools.js";

interface Posting {
  on: string;
  type: "deposit" | "disbursement";
  line_type: string | null;
  amount_cents: number;
  description: string;
}

export function* historySteps(p: Json, call: Call): Step<Json> {
  const ledger = p["ledger"] as {
    opened: { on: string; balance_cents: number };
    posted: Posting[];
    scheduled: Posting[];
  };
  const yearStart = p["year_start"] as string;
  const from = yield* call<string>("date_add", { date: yearStart, months: -12 }, "date");
  const all = [...ledger.posted, ...ledger.scheduled];

  const paidBy = (p["lines"] as Json[]).map((l) =>
    all
      .filter(
        (x) =>
          x.type === "disbursement" &&
          x.line_type === l["line_type"] &&
          x.on >= from &&
          x.on < yearStart,
      )
      .sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0)),
  );
  const signed = ledger.posted.map((x) => `${x.type === "deposit" ? "+" : "-"} ${x.amount_cents}`);
  const sums = (yield* together([
    ...paidBy
      .filter((paid) => paid.length > 0)
      .map((paid) => calcAsk(paid.map((x) => String(x.amount_cents)).join(" + "))),
    calcAsk(`${ledger.opened.balance_cents} ${signed.join(" ")}`),
  ])) as string[];
  const balance = sums.at(-1)!;
  let read = 0;
  const lines: Json[] = (p["lines"] as Json[]).map((l, i) => {
    const paid = paidBy[i]!;
    const total = paid.length ? sums[read++]! : "0";
    return {
      ...l,
      prior_year_annual_cents: Number(total),
      prior_disbursed_on: paid.map((x) => x.on),
    };
  });
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
