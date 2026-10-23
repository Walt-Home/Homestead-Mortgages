/**
 * The reference policy for tape-intake: the rulebook's checks, in its order,
 * through the tools. It reads only what a model reads: the rendered task and
 * what the tools return. The layout is looked up, both tapes are read and
 * compared, every odd date is parsed as the reader parses it, and every
 * figure is a calculate call; comparing two cells is reading. Calls that wait
 * on nothing else go together in one turn, as a model may make them. Held to
 * the grader on every generated task, it is the proof that each delivery's
 * defects can be found, and a clean one passed, from the rulebook and the
 * tools alone.
 */

import type { ToolCall } from "../episode.js";
import { ScriptedPolicy, type Json, type Step } from "../refi/reference.js";
import type { Ask, IntakeDefect, IntakeFinding, IntakeVerdict } from "./grader.js";
import { INTAKE_SUBMIT_TOOL } from "./tools.js";

type Want = readonly [name: string, input: Json];

let batches = 0;
/** Independent calls made together in one turn; each answer as the tool wrote it. */
function* together(wants: readonly Want[]): Step<string[]> {
  if (wants.length === 0) return [];
  const batch = ++batches;
  const calls: ToolCall[] = wants.map(([name, input], k) => ({
    id: `intake-${batch}-${k}`,
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

interface LayoutCol {
  letter: string;
  header: string;
  required: boolean;
}
interface Rows {
  columns: { letter: string; header: string }[];
  rows: { row: number; cells: string[] }[];
}
interface Compared {
  headers_differing: unknown[];
  loans_only_on_last_loaded: string[];
  loans_only_on_delivery: string[];
  loans_differing: unknown[];
}

const norm = (h: string) => h.trim().replace(/\s+/g, " ").toLowerCase();
const MDY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const monthsOf = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return y! * 12 + (m! - 1);
};
const ymOf = (n: number) => `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}`;
const lastDayOf = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return `${m}/${d}/${y}`;
};
const isoToMdy = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}/${d}/${y}`;
};
const keystrokeApart = (a: string, b: string) => {
  if (a.length !== b.length || a === b) return false;
  const at = [...a].flatMap((c, i) => (c === b[i] ? [] : [i]));
  return (
    at.length === 1 ||
    (at.length === 2 && at[1] === at[0]! + 1 && a[at[0]!] === b[at[1]!] && a[at[1]!] === b[at[0]!])
  );
};

const DATE_COLUMNS = [
  "IPD",
  "Next Due Date",
  "Date Maturity",
  "Date Payment Due First",
  "Orig Date Closing",
  "Orig Maturity Date",
] as const;
const FIRSTS = new Set([
  "IPD",
  "Next Due Date",
  "Date Maturity",
  "Date Payment Due First",
  "Orig Maturity Date",
]);
const FIXED = new Set([
  "Date Maturity",
  "Date Payment Due First",
  "Orig Date Closing",
  "Orig Maturity Date",
]);
const WIDTHS: Readonly<Record<string, number>> = { "Property Zip Code": 5, "Pay String": 12 };
/** The columns the checks read. */
const READ = [
  "Servicer Loan Number",
  "As of Date",
  "Property Zip Code",
  "Current T&I Payment Amt",
  "Total Due",
  "Pay String",
  ...DATE_COLUMNS,
  "Cash Flow Month 12 (Most Recent Month)",
  "Servicing Status",
  "PMI Flag",
  "SRV Asset Escrow Balance",
] as const;

/** The rulebook's checks over a rendered delivery's payload. */
export function* intakeSteps(p: Json): Step<Json> {
  const d = p["delivery"] as { for_month: string; headers: string[] };
  const last = p["last_loaded"] as { for_month: string };
  const M = d.for_month;
  const findings: IntakeFinding[] = [];
  const effects: ("none" | "corrected" | "hold")[] = [];
  const find = (
    defect: IntakeDefect,
    month: string,
    loan: string | null,
    column: string | null,
    says: string | null,
    truth: string | null,
    ask: Ask,
    effect: "none" | "corrected" | "hold",
  ) => {
    findings.push({ defect, month, loan, column, says, truth, ask });
    effects.push(effect);
  };
  const submit = (): Json => {
    const verdict: IntakeVerdict = effects.includes("hold")
      ? "hold"
      : effects.includes("corrected")
        ? "load_after_correction"
        : "load";
    return { verdict, findings: findings as unknown as Json[] };
  };

  // The layout, and the two tapes beside each other.
  const [layoutText, comparedText] = yield* together([
    ["lookup_layout", {}],
    ["compare_months", {}],
  ]);
  const layout = (JSON.parse(layoutText!) as { columns: LayoutCol[] }).columns;
  const letter = (header: string) => layout.find((c) => c.header === header)!.letter;
  const cmp = JSON.parse(comparedText!) as Compared;

  // 1a: a month never delivered between the last tape and this one.
  for (let m = monthsOf(last.for_month) + 1; m < monthsOf(M); m++)
    find("T-01", ymOf(m), null, null, null, null, "send_missing_month", "none");
  // 1b: last month's tape again.
  if (
    cmp.headers_differing.length === 0 &&
    cmp.loans_differing.length === 0 &&
    cmp.loans_only_on_delivery.length === 0 &&
    cmp.loans_only_on_last_loaded.length === 0
  ) {
    find("T-01", M, null, null, null, null, "send_this_month", "hold");
    return submit();
  }

  // 2: each header against the layout's for its column.
  d.headers.forEach((h, i) => {
    const c = layout[i]!;
    if (norm(h) !== norm(c.header))
      find(
        "T-02",
        M,
        null,
        c.header,
        h,
        c.header,
        "restore_header",
        c.required ? "hold" : "corrected",
      );
  });

  // The cells the remaining checks read, from both tapes, by letter.
  const cols = READ.map(letter);
  const [delText, lastText] = yield* together([
    ["read_rows", { file: "delivery", columns: cols }],
    ["read_rows", { file: "last_loaded", columns: cols }],
  ]);
  const at = (rows: Rows) =>
    rows.rows.map(
      (r) =>
        Object.fromEntries(READ.map((h, k) => [h, r.cells[k] ?? ""])) as Record<string, string>,
    );
  const del = at(JSON.parse(delText!) as Rows);
  const prev = at(JSON.parse(lastText!) as Rows);
  const prevOf = new Map(prev.map((r) => [r["Servicer Loan Number"]!, r]));

  // 3: codes shorter than their width.
  for (const [col, width] of Object.entries(WIDTHS)) {
    const short = del.find((r) => /^\d+$/.test(r[col]!) && r[col]!.length < width);
    if (short)
      find(
        "T-03",
        M,
        null,
        col,
        short[col]!,
        short[col]!.padStart(width, "0"),
        "export_codes_as_text",
        "corrected",
      );
  }

  // 4: date columns. An odd form is parsed as the reader parses it; a day-first column is found by its own rules.
  const odd = new Map<string, string>();
  const dayFirst = new Set<string>();
  for (const col of DATE_COLUMNS) {
    for (const r of del) {
      const cell = r[col]!;
      if (cell === "") continue;
      const m = MDY.exec(cell);
      if (!m) {
        odd.set(col, cell);
        break;
      }
      const [a, b] = [Number(m[1]), Number(m[2])];
      const before = prevOf.get(r["Servicer Loan Number"]!)?.[col];
      if (
        a > 12 ||
        (FIRSTS.has(col) && b !== 1) ||
        (FIXED.has(col) && before !== undefined && before !== cell)
      ) {
        dayFirst.add(col);
        break;
      }
    }
  }
  // Every cell of an odd column parsed as the reader parses it, in one turn: the first is the finding's, and all of
  // them are the column's dates for the checks on the partner's records.
  const cells = [...odd.keys()].flatMap((col) => [
    ...new Set(del.map((r) => r[col]!).filter((c) => c !== "")),
  ]);
  const parsed = yield* together(cells.map((cell): Want => ["parse_date", { cell }]));
  const readsAs = new Map(
    cells.map((cell, k) => [
      cell,
      (JSON.parse(parsed[k]!) as { reads_as: string | null }).reads_as,
    ]),
  );
  for (const [col, cell] of odd) {
    const reads = readsAs.get(cell)!;
    find(
      "T-04",
      M,
      null,
      col,
      cell,
      reads === null ? null : isoToMdy(reads),
      "export_dates_in_layout",
      "none",
    );
  }
  for (const col of dayFirst) {
    const first = del.find((r) => {
      const m = MDY.exec(r[col]!);
      return m !== null && m[1] !== m[2];
    })!;
    const [a, b, y] = first[col]!.split("/");
    find(
      "T-04",
      M,
      null,
      col,
      first[col]!,
      `${b}/${a}/${y}`,
      "export_dates_in_layout",
      "corrected",
    );
  }
  // The delivery's dates as checks 2 to 5 correct them: an odd form as the reader reads it, a day-first column swapped.
  for (const r of del) {
    for (const col of odd.keys()) {
      const reads = r[col] ? readsAs.get(r[col]!) : null;
      if (reads) r[col] = isoToMdy(reads);
    }
    for (const col of dayFirst) {
      const m = MDY.exec(r[col]!);
      if (m) r[col] = `${m[2]}/${m[1]}/${m[3]}`;
    }
  }

  // 5: the as-of.
  const end = lastDayOf(M);
  if (del.length > 0 && del[0]!["As of Date"] !== end)
    find(
      "T-05",
      M,
      null,
      "As of Date",
      del[0]!["As of Date"]!,
      end,
      "write_month_end_as_of",
      "corrected",
    );

  // 6 to 8: the partner's records, on each loan Active on both tapes. The figures in one turn.
  const active = del.filter((r) => {
    const q = prevOf.get(r["Servicer Loan Number"]!);
    return (
      r["Servicing Status"] === "Active" && q !== undefined && q["Servicing Status"] === "Active"
    );
  });
  const moved = (r: Record<string, string>) => {
    const q = prevOf.get(r["Servicer Loan Number"]!)!;
    const a = MDY.exec(q["Next Due Date"]!);
    const b = MDY.exec(r["Next Due Date"]!);
    return a && b ? Number(b[3]) * 12 + Number(b[1]) - (Number(a[3]) * 12 + Number(a[1])) : 0;
  };
  const [mm] = M.split("-").slice(1).map(Number);
  const escrowed = active.filter(
    (r) => Number(prevOf.get(r["Servicer Loan Number"]!)!["Current T&I Payment Amt"]) > 0,
  );
  const renewal = escrowed.filter((r) => {
    const c = MDY.exec(r["Orig Date Closing"]!);
    return r["PMI Flag"] === "N" && c !== null && Number(c[1]) === mm;
  });
  const payers = active.filter(
    (r) =>
      r["Cash Flow Month 12 (Most Recent Month)"] === "0.00" &&
      r["Next Due Date"] === prevOf.get(r["Servicer Loan Number"]!)!["Next Due Date"],
  );
  const pairs = payers.flatMap((a) =>
    active
      .filter((b) => keystrokeApart(a["Servicer Loan Number"]!, b["Servicer Loan Number"]!))
      .map((b) => [a, b] as const),
  );
  const q = (r: Record<string, string>) => prevOf.get(r["Servicer Loan Number"]!)!;
  const cash = "Cash Flow Month 12 (Most Recent Month)";
  // Comparing two figures is reading: the lesser T&I, and which Total Dues to try, are read off the cells.
  const lesser = (a: string, b: string) => (Number(a) <= Number(b) ? a : b);
  const ti = "Current T&I Payment Amt";
  /** The Total Dues to try for a pair, in the rulebook's order: [payer's, the other's]. */
  const tries = (a: Record<string, string>, b: Record<string, string>) =>
    [
      [q(a)["Total Due"]!, q(b)["Total Due"]!],
      [q(a)["Total Due"]!, b["Total Due"]!],
      [a["Total Due"]!, q(b)["Total Due"]!],
      [a["Total Due"]!, b["Total Due"]!],
    ] as const;
  const figures = yield* together([
    ...escrowed.map((r): Want => [
      "calculate",
      {
        expression: `(${q(r)["SRV Asset Escrow Balance"]}) - (${r["SRV Asset Escrow Balance"]}) - 12 * (${q(r)[ti]})`,
      },
    ]),
    ...renewal.map((r): Want => [
      "calculate",
      {
        expression: `(${q(r)["SRV Asset Escrow Balance"]}) + (${lesser(q(r)[ti]!, r[ti]!)}) * ${moved(r)} - (${r["SRV Asset Escrow Balance"]})`,
      },
    ]),
    ...pairs.flatMap(([a, b]): Want[] =>
      tries(a, b).flatMap(([da, db]): Want[] => [
        ["calculate", { expression: `(${b[cash]}) - (${db}) - (${da})` }],
        ["calculate", { expression: `(${b[cash]}) - (${da})` }],
      ]),
    ),
  ]);
  const value = (k: number) => (JSON.parse(figures[k]!) as { value: string }).value;
  escrowed.forEach((r, k) => {
    if (Number(value(k)) > 0)
      find(
        "V-01",
        M,
        r["Servicer Loan Number"]!,
        "SRV Asset Escrow Balance",
        r["SRV Asset Escrow Balance"]!,
        null,
        "research_disbursement",
        "none",
      );
  });
  renewal.forEach((r, k) => {
    if (Number(value(escrowed.length + k)) <= 0)
      find(
        "V-02",
        M,
        r["Servicer Loan Number"]!,
        "SRV Asset Escrow Balance",
        r["SRV Asset Escrow Balance"]!,
        null,
        "confirm_insurance_billing",
        "none",
      );
  });
  const base = escrowed.length + renewal.length;
  pairs.forEach(([a, b], k) => {
    const at = tries(a, b).findIndex((_, n) => Number(value(base + 8 * k + 2 * n)) === 0);
    if (at < 0) return;
    const [da] = tries(a, b)[at]!;
    find("D-25", M, a["Servicer Loan Number"]!, cash, a[cash]!, da, "move_payment", "none");
    const truth = value(base + 8 * k + 2 * at + 1);
    find("D-25", M, b["Servicer Loan Number"]!, cash, b[cash]!, truth, "move_payment", "none");
  });
  return submit();
}

export class IntakeReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference", intakeSteps, INTAKE_SUBMIT_TOOL);
  }
}
