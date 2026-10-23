/**
 * The reference policy for boarding-triage: the rulebook's ten checks made on
 * every loan, through the tools. It reads only what a model reads: the
 * rendered package, and what the tools return. Every code list is looked up,
 * the payment history and the correspondence are read file by file, and
 * every figure is a calculate call; comparing two cells, and counting years
 * on a date, is reading. Calls that wait on nothing else go together in one
 * turn, as a model may make them. It reports each defect at its root and
 * leaves out what follows from one it found, as the rulebook asks. Held to
 * the grader on every generated task, it is the proof that each package's
 * defects can be found, and its clean loans passed, from the rulebook and the
 * tools alone.
 */

import { addMonths, type PlainDate } from "@hm/kernel/calendar";
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

/** Check 6's plans: the years at the initial rate, and the caps in basis points. */
const ARM_PLANS = [
  { years: 5, initial: "200", periodic: "100", lifetime: "500" },
  { years: 7, initial: "500", periodic: "100", lifetime: "500" },
  { years: 10, initial: "500", periodic: "100", lifetime: "500" },
] as const;

/** The rulebook's checks over a rendered package's payload. */
export function* boardingSteps(p: Json): Step<Json> {
  const transfer = p["transfer"] as { loans: string[] };
  const files = p["files"] as Record<string, Row[]>;
  const tape = files[TAPE]!;
  const lines = files["escrow_history.csv"]!;
  const analyses = files["escrow_analysis.csv"]!;
  const lossmit = files["lossmit_file.csv"]!;
  const fcbk = files["fc_bk_file.csv"]!;

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
    const k = `${f.loan}|${f.file}|${f.field}|${f.row ?? ""}`;
    if (at.has(k)) return;
    at.add(k);
    findings.push(f);
  };
  const onTape = (
    loan: string,
    field: string,
    says: string,
    truth: string | null,
    handling: Handling,
  ) => find({ loan, file: TAPE, field, row: null, says, truth, handling });

  // What the escrow files say the escrow flag is: Y with lines, an analysis and a payment; N with none; else unsettled.
  const escrowFiles = (loan: string, row: Row): "Y" | "N" | null => {
    const has = [
      lines.some((l) => l["transferor_loan_number"] === loan),
      analyses.some((a) => a["transferor_loan_number"] === loan),
      money(row["escrow_payment"] || "0") > 0n,
    ];
    return has.every(Boolean) ? "Y" : has.every((x) => !x) ? "N" : null;
  };
  const kind = (loan: string, k: string) => letters.get(loan)!.filter((r) => r["kind"] === k);
  const latest = (loan: string): Row =>
    kind(loan, "periodic_statement").reduce((a, b) => (b["sent_on"]! > a["sent_on"]! ? b : a));
  /** Check 10's rows: a paid row whose escrow is more than its statement billed. */
  const misapplied = (loan: string): { row: Row; statement: Row }[] => {
    const statements = new Map(kind(loan, "periodic_statement").map((s) => [s["due_date"]!, s]));
    return history.get(loan)!.flatMap((h) => {
      const s = statements.get(h["due_date"]!);
      if (!h["received_on"] || !h["escrow"] || !s) return [];
      return money(h["escrow"]) > money(s["escrow"] || "0") ? [{ row: h, statement: s }] : [];
    });
  };

  // The figures, in one turn: each loan's uncapped fee on its latest statement, its payment, and what check 10's
  // rows should have applied to principal.
  const wants: Want[] = tape.flatMap((row): Want[] => {
    const loan = row["transferor_loan_number"]!;
    const s = latest(loan);
    return [
      ["calculate", { expression: `round(${s["pi"]} * ${row["late_charge_pct"]} / 100, 2)` }],
      ["calculate", { expression: `${row["pi_payment"]} + ${row["escrow_payment"]}` }],
      ...misapplied(loan).map((m): Want => [
        "calculate",
        { expression: `${m.statement["pi"]} - ${m.row["interest"]}` },
      ]),
    ];
  });
  const figures = yield* together(wants);
  let next = 0;
  const figure = () => money(JSON.parse(figures[next++]!).value as string);
  const asMoney = (c: bigint) => {
    const sign = c < 0n ? "-" : "";
    const a = c < 0n ? -c : c;
    return `${sign}${a / 100n}.${String(a % 100n).padStart(2, "0")}`;
  };

  for (const row of tape) {
    const loan = row["transferor_loan_number"]!;
    const uncapped = figure();
    const payment = figure();
    const split = misapplied(loan).map((m) => ({ ...m, principal: figure() }));

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
      onTape(loan, c.column, v, truth, truth === null ? "query" : "correct");
    }
    // Check 2: the escrow cells agree with the escrow files.
    const flag = row["escrowed"];
    if (flag === "Y" || flag === "N") {
      const files = escrowFiles(loan, row);
      if (files !== flag) onTape(loan, "escrowed", flag, files, "query");
    }
    const mi = lines.some((l) => l["transferor_loan_number"] === loan && l["line_type"] === "mi");
    if (mi && row["mi_flag"] !== "Y") onTape(loan, "mi_flag", row["mi_flag"] ?? "", "Y", "correct");

    // Check 3: the tape's late-charge terms give the latest statement's fee.
    const s = latest(loan);
    const cap = row["late_charge_max"] ? money(row["late_charge_max"]) : null;
    const fee = money(s["late_fee"]!);
    const given = cap !== null && cap < uncapped ? cap : uncapped;
    if (fee !== given) {
      const missingCap = cap === null && fee < uncapped;
      onTape(
        loan,
        missingCap ? "late_charge_max" : "late_charge_pct",
        missingCap ? "" : row["late_charge_pct"]!,
        missingCap ? s["late_fee"]! : null,
        "query",
      );
    }

    // Check 5: each flag agrees with the details beside it.
    if (lossmit.some((x) => x["transferor_loan_number"] === loan) && row["lm_in_process"] === "N")
      onTape(loan, "lm_in_process", "N", "Y", "correct");
    const bk = fcbk.find((x) => x["transferor_loan_number"] === loan);
    if (
      bk &&
      bk["bk_chapter"] &&
      bk["bk_case_number"] &&
      bk["bk_filed_on"] &&
      row["bk_active"] === "N"
    )
      onTape(loan, "bk_active", "N", "Y", "correct");
    const scraOff = !!row["scra_rate_cap_reason"] && row["scra_active"] === "N";
    if (scraOff) onTape(loan, "scra_active", "N", "Y", "correct");

    // Check 6: an ARM's caps are its plan's.
    if (row["amortization"] === "arm") {
      const first = row["first_payment_date"] as PlainDate;
      const plan = ARM_PLANS.find(
        (x) => addMonths(first, x.years * 12 - 1) === row["arm_next_change_date"],
      );
      if (plan)
        for (const [col, want] of [
          ["arm_initial_cap_bps", plan.initial],
          ["arm_periodic_cap_bps", plan.periodic],
          ["arm_lifetime_cap_bps", plan.lifetime],
        ] as const)
          if (row[col] !== want) onTape(loan, col, row[col] ?? "", want, "query");
    }

    // Check 7: the mortgage insurance's terms are its disclosure's.
    const disclosure = kind(loan, "mi_disclosure")[0];
    if (row["mi_flag"] === "Y" && disclosure) {
      if (money(row["mi_original_value"] || "0") !== money(disclosure["amount"] || "0"))
        onTape(
          loan,
          "mi_original_value",
          row["mi_original_value"] ?? "",
          disclosure["amount"]!,
          "query",
        );
      if (row["mi_termination_date"] !== disclosure["due_date"])
        onTape(
          loan,
          "mi_termination_date",
          row["mi_termination_date"] ?? "",
          disclosure["due_date"]!,
          "query",
        );
    }

    // Check 8: the flood zone is the determination's.
    const determination = kind(loan, "flood_determination")[0];
    if (determination && row["flood_zone"] !== determination["detail"])
      onTape(loan, "flood_zone", row["flood_zone"] ?? "", determination["detail"]!, "correct");

    // Check 9: the history is the loan's own; a row before the first payment is one it never had.
    const rows = history.get(loan)!;
    const phantoms = rows.filter((h) => h["due_date"]! < row["first_payment_date"]!);
    for (const h of phantoms)
      find({
        loan,
        file: HISTORY,
        field: "due_date",
        row: h["due_date"]!,
        says: h["due_date"]!,
        truth: null,
        handling: "hold",
      });

    // Check 10: each payment split as its statement billed it.
    for (const m of split)
      find({
        loan,
        file: HISTORY,
        field: "principal",
        row: m.row["due_date"]!,
        says: m.row["principal"]!,
        truth: asMoney(m.principal),
        handling: "query",
      });

    // Check 4: the next due date and the payment agree with the payment history. What a phantom row moves follows
    // from it, and a servicemember's capped payments are compared by date alone (or follow from the flag left off).
    if (phantoms.length > 0) continue;
    const unpaid = rows.find((h) => !h["received_on"]);
    if (!unpaid || unpaid["due_date"] !== row["next_due_date"])
      onTape(loan, "next_due_date", row["next_due_date"]!, unpaid?.["due_date"] ?? null, "query");
    else if (
      row["scra_active"] !== "Y" &&
      !scraOff &&
      payment !== money(unpaid["scheduled_amount"]!)
    )
      onTape(loan, "pi_payment", row["pi_payment"]!, null, "query");
  }
  return { findings: findings as unknown as Json[] };
}

export class BoardingReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference", boardingSteps, BOARDING_SUBMIT_TOOL);
  }
}
