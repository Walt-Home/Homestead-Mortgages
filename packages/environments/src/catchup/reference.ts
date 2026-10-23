/**
 * The reference policy for catchup-posting: the rulebook followed
 * literally, through the calculator. It reads only the rendered task.
 * Reading a status, comparing two dates or two amounts is reading; every
 * charge held to the note, every sum and every installment's split is a
 * tool call. A charge on the same P&I as another is held to the same
 * amount, so each P&I is worked once; which charges are still owed and
 * which were collected above the note is a comparison, so each of the two
 * totals is one sum. Calls that wait on nothing else are made together in
 * one turn, as a model may make them. Held to the grader on every generated
 * task, it is the proof that each one can be posted from the rulebook and
 * the tool alone.
 */

import { ScriptedPolicy, type Call, type Json, type Step } from "../refi/reference.js";
import { calcAsk, together } from "../escrow/reference.js";
import { CATCHUP_SUBMIT_TOOL } from "./tools.js";

interface Charge {
  installment_due_date: string;
  collected_cents: number;
  installment_pi_cents: number;
}
interface Inst {
  due_date: string;
  pi_cents: number;
  escrow_cents: number;
  status: string;
}

export function* catchupSteps(p: Json, _call: Call): Step<Json> {
  const big = (x: string | number) => BigInt(x);
  const note = p["note"] as { late_charge: { pct: string; cap_cents: number | null } };
  const loan = p["loan"] as {
    note_rate_pct: string;
    upb_cents: number;
    lpi_date: string | null;
    suspense_cents: number;
    installments: Inst[];
  };
  const receipt = p["receipt"] as { amount_cents: number; received_on: string };
  const charges = [...(p["late_charges"] as Charge[])].sort((a, b) =>
    a.installment_due_date < b.installment_due_date ? -1 : 1,
  );
  const { pct, cap_cents: cap } = note.late_charge;

  // Step 1: each P&I's charge held to the note, the pool beside them (Step 2 waits on nothing).
  const bases = [...new Set(charges.map((f) => f.installment_pi_cents))];
  const [pool0, ...held] = (yield* together([
    calcAsk(`${receipt.amount_cents} + ${loan.suspense_cents}`),
    ...bases.map((pi) => {
      const raw = `round(${pi} * ${pct} / 100)`;
      return calcAsk(cap === null ? raw : `min(${raw}, ${cap})`);
    }),
  ])) as string[];
  const allowedOf = new Map(bases.map((pi, k) => [pi, held[k]!]));
  const allowed = charges.map((f) => allowedOf.get(f.installment_pi_cents)!);
  const owed = charges.flatMap((f, k) =>
    big(f.collected_cents) < big(allowed[k]!) ? [`(${allowed[k]!} - ${f.collected_cents})`] : [],
  );
  const over = charges.flatMap((f, k) =>
    big(f.collected_cents) > big(allowed[k]!) ? [`(${f.collected_cents} - ${allowed[k]!})`] : [],
  );
  const sums = (yield* together([
    ...(owed.length ? [calcAsk(owed.join(" + "))] : []),
    ...(over.length ? [calcAsk(over.join(" + "))] : []),
  ])) as string[];
  const lateDue = owed.length ? sums[0]! : "0";
  const refund = over.length ? sums[owed.length ? 1 : 0]! : "0";

  // Step 3: the open installments, oldest first, while the pool covers each.
  const open = loan.installments
    .filter((i) => i.status === "due")
    .sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
  let pool = pool0!;
  let upb = String(loan.upb_cents);
  let lpi = loan.lpi_date;
  const applied: Json[] = [];
  const paid = new Set<string>();
  for (const inst of open) {
    const [P, interest] = (yield* together([
      calcAsk(`${inst.pi_cents} + ${inst.escrow_cents}`),
      calcAsk(`round(${upb} * ${loan.note_rate_pct} / 1200)`),
    ])) as string[];
    if (big(pool) < big(P!)) break;
    const [principal, left] = (yield* together([
      calcAsk(`${inst.pi_cents} - ${interest!}`),
      calcAsk(`${pool} - ${P!}`),
    ])) as string[];
    const [after] = (yield* together([calcAsk(`${upb} - ${principal!}`)])) as string[];
    upb = after!;
    pool = left!;
    lpi = inst.due_date;
    paid.add(inst.due_date);
    applied.push({
      due_date: inst.due_date,
      kind: inst.due_date <= receipt.received_on ? "contractual" : "prepaid",
      interest_cents: interest!,
      principal_cents: principal!,
      escrow_cents: String(inst.escrow_cents),
    });
  }

  // Step 4
  const [latePaid] = (yield* together([calcAsk(`min(${pool}, ${lateDue})`)])) as string[];
  const [toSuspense, lateAfter] = (yield* together([
    calcAsk(`${pool} - ${latePaid!}`),
    calcAsk(`${lateDue} - ${latePaid!}`),
  ])) as string[];

  // Step 5
  return {
    installments: applied,
    late_charge_paid_cents: latePaid!,
    to_suspense_cents: toSuspense!,
    late_charges: charges.map((f, k) => ({
      installment_due_date: f.installment_due_date,
      allowed_cents: allowed[k]!,
    })),
    refund_due_cents: refund,
    late_charges_due_after_cents: lateAfter!,
    upb_after_cents: upb,
    lpi_after: lpi,
    current_after_posting: !open.some(
      (i) => !paid.has(i.due_date) && i.due_date <= receipt.received_on,
    ),
  };
}

export class CatchupReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference:catchup-rulebook", catchupSteps, CATCHUP_SUBMIT_TOOL);
  }
}
