/**
 * The reference policy for boarding-triage: the rulebook's four checks made
 * on every loan, through the tools. It reads only what a model reads: the
 * rendered package, and what the tools return. Every code list is looked up,
 * the payment history and the correspondence are read file by file, and
 * every figure is a calculate call; comparing two cells is reading. Calls
 * that wait on nothing else go together in one turn, as a model may make
 * them. Held to the grader on every generated task, it is the proof that each
 * package's defects can be found, and its clean loans passed, from the
 * rulebook and the tools alone.
 */

import { cents } from "@hm/kernel/money";
import type { ToolCall } from "../episode.js";
import { ScriptedPolicy, type Json, type Step } from "../refi/reference.js";
import type { Handling } from "../life/defects.js";
import { parseCsv } from "./ported/tape-codec.js";
import type { TriageFinding } from "./grader.js";
import { BOARDING_SUBMIT_TOOL } from "./tools.js";

type Row = Record<string, string>;
type Want = readonly [name: string, input: Json];

let batches = 0;
/** Independent calls made together in one turn; each answer as the tool wrote it. */
function* together(wants: readonly Want[]): Step<string[]> {
  if (wants.length === 0) return [];
  const batch = ++batches;
  const calls: ToolCall[] = wants.map(([name, input], k) => ({
    id: `boarding-${batch}-${k}`,
    name,
    input,
  }));
  const observations = yield calls;
  return calls.map((c) => {
    const o = observations.find((x) => x.call_id === c.id);
    if (!o || o.is_error) throw new Error(`${c.name} failed: ${o?.content ?? "no observation"}`);
    return o.content;
  });
}

const TAPE = "boarding_tape.final.csv";
const CORRESPONDENCE = "correspondence_file.csv";
const HISTORY = "payment_history.csv";
const money = (s: string) => cents(s);

/** The rulebook's checks over a rendered package's payload. */
export function* boardingSteps(p: Json): Step<Json> {
  const transfer = p["transfer"] as { loans: string[] };
  const files = p["files"] as Record<string, Row[]>;
  const tape = files[TAPE]!;
  const lines = files["escrow_history.csv"]!;
  const analyses = files["escrow_analysis.csv"]!;

  // The tape's code lists, and each loan's payment history and correspondence, in one turn.
  const read = yield* together([
    ["code_list", { file: TAPE }],
    ...transfer.loans.flatMap((loan): Want[] => [
      ["read_file", { file: HISTORY, loan }],
      ["read_file", { file: CORRESPONDENCE, loan }],
    ]),
  ]);
  const columns = (
    JSON.parse(read[0]!) as { columns: { column: string; codes: string[] | null }[] }
  ).columns;
  const history = new Map<string, Row[]>();
  const letters = new Map<string, Row[]>();
  transfer.loans.forEach((loan, k) => {
    history.set(loan, parseCsv(read[1 + 2 * k]!));
    letters.set(loan, parseCsv(read[2 + 2 * k]!));
  });

  const findings: TriageFinding[] = [];
  const at = new Set<string>();
  const find = (f: TriageFinding) => {
    const k = `${f.loan}|${f.file}|${f.field}`;
    if (at.has(k)) return;
    at.add(k);
    findings.push(f);
  };

  // What the escrow files say the escrow flag is: Y with lines, an analysis and a payment; N with none; else unsettled.
  const escrowFiles = (loan: string, row: Row): "Y" | "N" | null => {
    const has = [
      lines.some((l) => l["transferor_loan_number"] === loan),
      analyses.some((a) => a["transferor_loan_number"] === loan),
      money(row["escrow_payment"] || "0") > 0n,
    ];
    return has.every(Boolean) ? "Y" : has.every((x) => !x) ? "N" : null;
  };

  const latest = (loan: string): Row => {
    const statements = letters.get(loan)!.filter((r) => r["kind"] === "periodic_statement");
    return statements.reduce((a, b) => (b["sent_on"]! > a["sent_on"]! ? b : a));
  };

  // The figures, in one turn: each loan's uncapped fee on its latest statement, and its payment.
  const figures = yield* together(
    tape.flatMap((row): Want[] => {
      const s = latest(row["transferor_loan_number"]!);
      return [
        ["calculate", { expression: `round(${s["pi"]} * ${row["late_charge_pct"]} / 100, 2)` }],
        ["calculate", { expression: `${row["pi_payment"]} + ${row["escrow_payment"]}` }],
      ];
    }),
  );

  tape.forEach((row, k) => {
    const loan = row["transferor_loan_number"]!;
    // Check 1: every coded cell holds one of its codes.
    for (const c of columns) {
      if (!c.codes) continue;
      const v = row[c.column] ?? "";
      if (c.codes.includes(v)) continue;
      const truth =
        c.column === "escrowed"
          ? escrowFiles(loan, row)
          : c.column === "mi_flag"
            ? lines.some((l) => l["transferor_loan_number"] === loan && l["line_type"] === "mi")
              ? "Y"
              : null
            : null;
      find({
        loan,
        file: TAPE,
        field: c.column,
        says: v,
        truth,
        handling: truth === null ? "query" : "correct",
      });
    }
    // Check 2: the escrow cells agree with the escrow files.
    const flag = row["escrowed"];
    if (flag === "Y" || flag === "N") {
      const files = escrowFiles(loan, row);
      if (files !== flag)
        find({ loan, file: TAPE, field: "escrowed", says: flag, truth: files, handling: "query" });
    }
    const mi = lines.some((l) => l["transferor_loan_number"] === loan && l["line_type"] === "mi");
    if (mi && row["mi_flag"] !== "Y")
      find({
        loan,
        file: TAPE,
        field: "mi_flag",
        says: row["mi_flag"] ?? "",
        truth: "Y",
        handling: "correct",
      });

    // Check 3: the tape's late-charge terms give the latest statement's fee.
    const s = latest(loan);
    const uncapped = money(JSON.parse(figures[2 * k]!).value as string);
    const cap = row["late_charge_max"] ? money(row["late_charge_max"]) : null;
    const fee = money(s["late_fee"]!);
    const given = cap !== null && cap < uncapped ? cap : uncapped;
    if (fee !== given) {
      const missingCap = cap === null && fee < uncapped;
      find({
        loan,
        file: TAPE,
        field: missingCap ? "late_charge_max" : "late_charge_pct",
        says: missingCap ? "" : row["late_charge_pct"]!,
        truth: missingCap ? s["late_fee"]! : null,
        handling: "query" as Handling,
      });
    }

    // Check 4: the next due date and the payment agree with the payment history.
    const unpaid = history.get(loan)!.find((h) => !h["received_on"]);
    if (!unpaid || unpaid["due_date"] !== row["next_due_date"])
      find({
        loan,
        file: TAPE,
        field: "next_due_date",
        says: row["next_due_date"]!,
        truth: unpaid?.["due_date"] ?? null,
        handling: "query",
      });
    else if (
      money(JSON.parse(figures[2 * k + 1]!).value as string) !== money(unpaid["scheduled_amount"]!)
    )
      find({
        loan,
        file: TAPE,
        field: "pi_payment",
        says: row["pi_payment"]!,
        truth: null,
        handling: "query",
      });
  });
  return { findings: findings as unknown as Json[] };
}

export class BoardingReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference", boardingSteps, BOARDING_SUBMIT_TOOL);
  }
}
