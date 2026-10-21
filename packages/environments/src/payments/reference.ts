/**
 * The reference policy for payments-posting: the rulebook followed
 * literally, through the tools. Reading a status, a date or a flag is
 * reading; every sum, interest figure and grace end is a tool call. Held to
 * the grader on every generated task, it is the proof that each month can
 * be posted from the rulebook and the tools alone.
 */

import type { ToolCall } from "../episode.js";
import { ScriptedPolicy, type Call, type Json, type Step } from "../refi/reference.js";
import { PAYMENTS_SUBMIT_TOOL } from "./tools.js";

interface Inst {
  due_date: string;
  pi: string;
  escrow: string;
  status: string;
}
interface Overlay {
  kind: string;
  from: string;
  to?: string | null;
  defaulted_on?: string | null;
}

const HOLD_OUTCOME: Readonly<Record<string, string>> = {
  bankruptcy: "held_bk",
  foreclosure_post_referral: "held_fc",
  noe_dispute: "held_dispute",
};

/** Independent calls made together in one turn, as a model may make them; read back by id. */
let batches = 0;
function* each<R>(name: string, inputs: readonly Json[], key: string): Step<R[]> {
  if (inputs.length === 0) return [];
  const batch = ++batches;
  const calls: ToolCall[] = inputs.map((input, k) => ({ id: `each-${batch}-${k}`, name, input }));
  const observations = yield calls;
  return calls.map((c) => {
    const o = observations.find((x) => x.call_id === c.id);
    if (!o || o.is_error) throw new Error(`${name} failed: ${o?.content ?? "no observation"}`);
    return (JSON.parse(o.content) as Record<string, R>)[key] as R;
  });
}

export function* paymentsSteps(p: Json, call: Call): Step<Json> {
  const calc = (expression: string) => call<string>("calculate", { expression }, "value");
  const big = (x: string | number) => BigInt(x);
  const loan = p["loan"] as Record<string, unknown>;
  const window = p["window"] as { from: string; through: string };
  const receipts = p["receipts"] as Record<string, unknown>[];

  const pct = String(loan["note_rate_pct"]);
  const lcPct = String(loan["late_charge_pct"] ?? "5");
  const graceDays = Number(loan["late_charge_grace_days"] ?? 15);
  const cap = loan["late_charge_cap_cents"] == null ? null : String(loan["late_charge_cap_cents"]);
  const piti = loan["late_charge_basis"] === "piti";
  const overlays = (loan["overlays"] ?? []) as Overlay[];
  const shield = (loan["transfer_shield_until"] ?? null) as string | null;
  const holds = (loan["holds"] ?? []) as string[];
  const trial = loan["trial_active"] === true;
  const fiftyEligibleLoan =
    loan["escrowed"] === true &&
    String(loan["instrument_date"]) >= "1999-03-01" &&
    loan["lien"] === "first" &&
    loan["opted_out_of_50_rule"] !== true;

  let upb = String(loan["upb_cents"]);
  let lpi = (loan["lpi_date"] ?? null) as string | null;
  let suspense = String(loan["suspense_unapplied_cents"]);
  let lcDue = String(loan["late_charges_due_cents"]);
  let partialCount = Number(loan["partial_count_12m"]);
  const insts: Inst[] = (loan["installments"] as Record<string, unknown>[]).map((x) => ({
    due_date: String(x["due_date"]),
    pi: String(x["pi_cents"]),
    escrow: String(x["escrow_cents"]),
    status: String(x["status"]),
  }));
  const fees = ((loan["fees"] ?? []) as Record<string, unknown>[]).map((f) => ({
    due: String(f["installment_due_date"]),
    state: String(f["state"]),
    type: String(f["fee_type"]),
  }));
  const active = (kind: string, due: string) =>
    overlays.find((o) => o.kind === kind && o.from <= due && (o.to == null || o.to >= due));

  // Grace ends never change, so each installment's run day (grace end + 1) is found once, all of
  // them side by side. Only those days and the receipts' days change anything, so only they are
  // visited, in date order.
  const plains = yield* each<string>(
    "date_add",
    insts.map((i) => ({ date: i.due_date, days: graceDays })),
    "date",
  );
  const graceEnds = yield* each<string>(
    "next_business_day",
    plains.map((date) => ({ date })),
    "date",
  );
  const runDays = yield* each<string>(
    "date_add",
    graceEnds.map((date) => ({ date, days: 1 })),
    "date",
  );
  const runDay = new Map(insts.map((i, k) => [i.due_date, runDays[k]!]));
  const days = [...new Set([...runDay.values(), ...receipts.map((r) => String(r["received_on"]))])]
    .filter((d) => d >= window.from && d <= window.through)
    .sort();

  const posted: Json[] = [];
  const runs: Json[] = [];
  for (const d of days) {
    // Step 2
    for (const i of insts) {
      if (runDay.get(i.due_date) !== d) continue;
      const run = (outcome: string, amount: string | null) =>
        runs.push({ installment_due_date: i.due_date, run_on: d, outcome, amount_cents: amount });
      if (
        fees.some((f) => f.type === "late_charge" && f.due === i.due_date && f.state !== "reversed")
      ) {
        run("not_assessed", null);
        continue;
      }
      const basis = piti ? yield* calc(`${i.pi} + ${i.escrow}`) : i.pi;
      let received = basis;
      if (i.status !== "satisfied" && i.status !== "prepaid") {
        // The suspense held for it: what is left once each earlier installment still due has taken
        // its basis, oldest first. Nothing held, or nothing left, needs no tool.
        let left = suspense;
        for (const j of insts) {
          if (big(left) === 0n) break;
          if (j.status !== "due" || j.due_date >= i.due_date) continue;
          const b = piti ? yield* calc(`${j.pi} + ${j.escrow}`) : j.pi;
          left = big(left) > big(b) ? yield* calc(`${left} - ${b}`) : "0";
        }
        received = big(left) > big(basis) ? basis : left;
      }
      if (big(received) >= big(basis)) {
        run("not_assessed", null);
        continue;
      }
      if (shield && i.due_date <= shield) {
        run("not_assessed", null);
        continue;
      }
      const fb = overlays.find((o) => o.kind === "forbearance_active" && o.from <= i.due_date);
      if (
        fb &&
        (fb.to == null || fb.to >= i.due_date) &&
        (!fb.defaulted_on || i.due_date < fb.defaulted_on)
      ) {
        run("not_assessed", null);
        continue;
      }
      let amount = yield* calc(`round(${basis} * ${lcPct} / 100)`);
      if (cap !== null && big(amount) > big(cap)) amount = cap;
      if (active("bankruptcy_active", i.due_date)) {
        fees.push({ due: i.due_date, state: "accrued_suspended", type: "late_charge" });
        run("accrued_suspended", amount);
        continue;
      }
      if (active("foreclosure_referred", i.due_date)) {
        run("not_assessed", null);
        continue;
      }
      fees.push({ due: i.due_date, state: "assessed", type: "late_charge" });
      lcDue = yield* calc(`${lcDue} + ${amount}`);
      run("assessed", amount);
    }

    for (const rc of receipts.filter((x) => x["received_on"] === d)) {
      const amount = String(rc["amount_cents"]);
      const designation = String(rc["designation"]);
      const reserved = rc["curtailment_cents"] == null ? "0" : String(rc["curtailment_cents"]);
      const text = rc["instruction_text"] == null ? null : String(rc["instruction_text"]);
      const received = d;
      // Step 3
      const refused = text !== null && /second|2nd|subordinate|junior|heloc/i.test(text);
      const result: Json = {
        payment_id: String(rc["payment_id"]),
        installments: [],
        late_charge_paid_cents: "0",
        curtailment_cents: "0",
        to_suspense_cents: amount,
        suspense_used_cents: "0",
        partial_hold: false,
        redirected_curtailment: false,
        refused_instruction: refused,
      };
      // Step 4
      if (holds.length > 0 || trial) {
        suspense = yield* calc(`${suspense} + ${amount}`);
        posted.push({
          ...result,
          outcome: holds.length > 0 ? (HOLD_OUTCOME[holds[0]!] ?? "held_other") : "held_trial",
        });
        continue;
      }
      // Step 5
      let pool = yield* calc(`${amount} + ${suspense}`);
      const used = suspense;
      suspense = "0";
      // Step 6
      const open = insts
        .filter((i) => i.status === "due")
        .sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
      const current = !open.some((i) => i.due_date <= received);
      const separate = designation === "curtailment" && current && open.length > 0;
      const applied: Json[] = [];
      let fifty = false;
      const apply = function* (i: Inst, short: string): Step<void> {
        const interest = yield* calc(`round(${upb} * ${pct} / 1200)`);
        const principal = yield* calc(`${i.pi} - ${interest}`);
        const escrow = short === "0" ? i.escrow : yield* calc(`${i.escrow} - ${short}`);
        upb = yield* calc(`${upb} - ${principal}`);
        lpi = i.due_date;
        const kind = i.due_date > received ? "prepaid" : "contractual";
        i.status = kind === "prepaid" ? "prepaid" : "satisfied";
        applied.push({
          due_date: i.due_date,
          kind,
          interest_cents: interest,
          principal_cents: principal,
          escrow_cents: escrow,
        });
      };
      if (!separate) {
        for (const i of open) {
          const P = yield* calc(`${i.pi} + ${i.escrow}`);
          const available = i.due_date > received ? yield* calc(`${pool} - ${reserved}`) : pool;
          if (big(available) < big(P)) break;
          pool = yield* calc(`${pool} - ${P}`);
          yield* apply(i, "0");
        }
      }
      // Step 7
      if (applied.length === 0 && open.length > 0 && !separate) {
        const i = open[0]!;
        const P = yield* calc(`${i.pi} + ${i.escrow}`);
        const short = yield* calc(`${P} - ${pool}`);
        if (big(short) <= 5000n && fiftyEligibleLoan && partialCount < 3) {
          yield* apply(i, short);
          pool = "0";
          partialCount += 1;
          fifty = true;
        } else {
          suspense = pool;
          posted.push({ ...result, outcome: "unapplied", partial_hold: true });
          continue;
        }
      }
      // Step 8
      let curtailed = false;
      if (big(pool) > 0n) {
        const instruction =
          designation === "curtailment" ||
          big(reserved) > 0n ||
          (text !== null && !refused && /principal|curtail/i.test(text));
        const stillDue = insts.some((i) => i.status === "due" && i.due_date <= received);
        if (instruction && stillDue) {
          result["redirected_curtailment"] = true;
        } else if (instruction) {
          const c = big(reserved) > 0n && big(reserved) < big(pool) ? reserved : pool;
          upb = yield* calc(`${upb} - ${c}`);
          pool = yield* calc(`${pool} - ${c}`);
          result["curtailment_cents"] = c;
          curtailed = true;
        } else {
          const lc = big(pool) < big(lcDue) ? pool : lcDue;
          if (big(lc) > 0n) {
            pool = yield* calc(`${pool} - ${lc}`);
            lcDue = yield* calc(`${lcDue} - ${lc}`);
          }
          result["late_charge_paid_cents"] = lc;
        }
      }
      if (big(pool) > 0n) suspense = yield* calc(`${suspense} + ${pool}`);
      // Step 9
      const outcome =
        applied.length === 0
          ? curtailed
            ? "curtailment"
            : "unapplied"
          : applied.every((a) => a["kind"] === "prepaid")
            ? "prepaid"
            : fifty
              ? "applied_with_50_rule"
              : "applied";
      posted.push({
        ...result,
        outcome,
        installments: applied,
        to_suspense_cents: pool,
        suspense_used_cents: used,
      });
    }
  }

  return {
    receipts: posted,
    late_charge_runs: runs,
    final: {
      upb_cents: upb,
      lpi_date: lpi,
      suspense_cents: suspense,
      late_charges_due_cents: lcDue,
      partial_count_12m: partialCount,
      installments: [...insts]
        .sort((a, b) => (a.due_date < b.due_date ? -1 : 1))
        .map((i) => ({ due_date: i.due_date, status: i.status })),
    },
  };
}

export class PaymentsReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference:payments-rulebook", paymentsSteps, PAYMENTS_SUBMIT_TOOL);
  }
}
