/**
 * tape-intake: a partner's monthly tape, as the desk receives it, reviewed
 * before it is loaded. The reader's profile is ported but for one import;
 * the desk's reading of every delivery is the reader's own; the tools read,
 * compare, parse and look up, and decide nothing; the reference finds exactly
 * what each delivery carries on the held-out suite, a training suite and the
 * spec's cases; and the grader reads the labels as the servicing app's own
 * test reads designed outcomes.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { M3_V1, readBook } from "@hm/partner-book";
import { runEpisode } from "../episode.js";
import { drawsHeldoutStream } from "../heldout-guard.js";
import { sha256, toJsonLine } from "../record.js";
import { toCsvText } from "../life/index.js";
import {
  ASKS,
  EXTRA_FINDINGS_CAP,
  INTAKE_ARMS,
  INTAKE_DEFECTS,
  INTAKE_FINGERPRINT,
  INTAKE_HELDOUT_SUITE,
  INTAKE_SPEC_CASES,
  INTAKE_TOOLS,
  IntakeReferencePolicy,
  LAYOUT,
  drawIntakeTask,
  executeIntakeTool,
  generateIntakeSuite,
  generateIntakeTask,
  gradeIntakeAgainst,
  intakeArmOf,
  intakePayload,
  intakeSpecTasks,
  intakeVerdict,
  letterOf,
  parseIntakeSubmission,
  renderIntakeTask,
  tapeIntake,
  type IntakeAnswer,
  type IntakeFinding,
  type TapeIntakeTask,
} from "../tape-intake/index.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

let heldout: TapeIntakeTask[] = [];
let train: TapeIntakeTask[] = [];
let spec: TapeIntakeTask[] = [];

beforeAll(() => {
  heldout = generateIntakeSuite(
    INTAKE_HELDOUT_SUITE.split,
    INTAKE_HELDOUT_SUITE.seed,
    INTAKE_HELDOUT_SUITE.n,
  );
  train = generateIntakeSuite("train", 7, 300);
  spec = intakeSpecTasks();
}, 600_000);

const solveAll = async (tasks: readonly TapeIntakeTask[]) => {
  const misses: string[] = [];
  let turns = 0;
  let calls = 0;
  for (const task of tasks) {
    const r = await runEpisode(tapeIntake, task, new IntakeReferencePolicy());
    turns = Math.max(turns, r.turns);
    calls = Math.max(calls, r.tool_calls);
    if (!r.grade.pass)
      misses.push(
        `${task.id}: ${r.outcome} ${r.grade.fields
          .filter((f) => !f.ok)
          .map((f) => f.field)
          .join(", ")}`,
      );
  }
  return { misses, turns, calls };
};

const answerOf = (t: TapeIntakeTask): IntakeAnswer => ({
  verdict: t.expected.verdict,
  findings: t.expected.findings.map(({ defect, month, loan, column, says, truth, ask }) => ({
    defect,
    month,
    loan,
    column,
    says,
    truth,
    ask,
  })),
});
const grade = (t: TapeIntakeTask, a: IntakeAnswer | null) => gradeIntakeAgainst(t.expected, a);
const history = new Set(["V-01", "V-02", "D-25"]);

describe("tape-intake", () => {
  it("ports the reader's profile but for one import, and the serial-date section word for word", () => {
    const lines = (t: string) => t.split("\n");
    const body = (t: string) =>
      lines(t)
        .filter((l) => !l.startsWith("import "))
        .join("\n");
    const imports = (t: string) => lines(t).filter((l) => l.startsWith("import "));
    const original = readFileSync(here("../../../partner-book/src/m3-v1.ts"), "utf8");
    const port = readFileSync(here("../tape-intake/ported/m3-v1.ts"), "utf8");
    expect(body(port)).toBe(body(original));
    expect(imports(port)).toEqual(
      imports(original).map((l) => l.replace('"./vendored/xlsx.js"', '"./xlsx-serial.js"')),
    );
    const vendored = readFileSync(here("../../../partner-book/src/vendored/xlsx.ts"), "utf8");
    const serial = readFileSync(here("../tape-intake/ported/xlsx-serial.ts"), "utf8");
    const section = serial.slice(serial.indexOf("// ───────── Excel serial dates")).trimEnd();
    expect(section).toMatch(
      /^\/\/ ───────── Excel serial dates[\s\S]*excelSerialToIsoDate[\s\S]*\}$/,
    );
    expect(vendored).toContain(section);
  });

  it("gives tools that read, compare, parse and look up, and none that checks or decides", () => {
    expect(INTAKE_TOOLS.map((t) => t.name)).toEqual([
      "read_rows",
      "compare_months",
      "parse_date",
      "lookup_layout",
      "calculate",
      "submit_intake",
    ]);
    const t = spec.find((x) => x.expected.findings.some((f) => f.defect === "T-02"))!;
    const run = (name: string, input: unknown) => JSON.parse(executeIntakeTool(name, input, t));
    // The layout: 118 columns by letter, A to DN, the profile's headers in order.
    expect(LAYOUT.map((c) => c.letter).at(-1)).toBe("DN");
    expect(letterOf(25)).toBe("Z");
    expect(letterOf(26)).toBe("AA");
    const layout = run("lookup_layout", {}) as { columns: { header: string }[] };
    expect(layout.columns.length).toBe(118);
    expect(run("lookup_layout", { column: "x" }).columns[0].header).toBe("Next Due Date");
    expect(run("lookup_layout", { column: "pay string" }).columns[0]).toMatchObject({
      letter: "Z",
      type: "text",
    });
    expect(() => executeIntakeTool("lookup_layout", { column: "Nope" })).toThrow(/no column/);
    // Rows, by letter or by the file's own header, for some loans or all.
    const loan = t.delivery.rows[1]![2]!;
    const rows = run("read_rows", { file: "delivery", loans: [loan], columns: ["C", "B"] });
    expect(rows.rows).toEqual([{ row: 2, cells: [loan, t.delivery.rows[1]![1]] }]);
    expect(run("read_rows", { file: "last_loaded" }).rows.length).toBe(t.last_loaded.rows.length);
    expect(() => run("read_rows", { file: "delivery", columns: ["Next Due Date"] })).toThrow(
      /no column "Next Due Date"/,
    );
    expect(() => run("read_rows", { file: "delivery", loans: ["0000000000"] })).toThrow(/no loan/);
    expect(() => run("read_rows", { file: "both" })).toThrow(/file must be/);
    // A comparison names the cells that differ, and says nothing about whether they should.
    const cmp = run("compare_months", {});
    expect(cmp.headers_differing).toEqual([
      { letter: "X", last_loaded: "Next Due Date", delivery: expect.any(String) },
    ]);
    const one = run("compare_months", { loan, columns: ["B"] });
    expect(one.cells).toEqual([
      {
        letter: "B",
        header: "As of Date",
        last_loaded: expect.any(String),
        delivery: t.delivery.rows[1]![1],
      },
    ]);
    // A date as the reader reads it, on the day asked, or the delivery's.
    expect(run("parse_date", { cell: "5/1/57" })).toMatchObject({
      reads_as: "2057-05-01",
      form: "m/d/yy",
    });
    expect(run("parse_date", { cell: "5/1/57", read_on: "1990-01-01" }).reads_as).toBe(
      "1957-05-01",
    );
    expect(run("parse_date", { cell: "57101" })).toMatchObject({
      reads_as: "2056-05-01",
      form: "excel serial",
    });
    expect(run("parse_date", { cell: "15/3/2026" })).toMatchObject({ reads_as: null, form: null });
    expect(() => executeIntakeTool("read_rows", { file: "delivery" })).toThrow(/without one/);
    expect(JSON.parse(executeIntakeTool("calculate", { expression: "12 * 412.50" }))).toEqual({
      value: "4950",
    });
  });

  it("shows the desk's reading of every delivery exactly as the reader itself reads it", () => {
    const utf8 = (s: string) => new TextEncoder().encode(s);
    let refused = 0;
    let exceptions = 0;
    for (const t of [...heldout, ...spec]) {
      const d = t.delivery;
      const r = readBook(
        M3_V1,
        "partner",
        `${d.for_month}-28`,
        {
          filename: d.name,
          bytes: utf8(toCsvText({ filename: d.name, headers: d.headers, rows: d.rows })),
        },
        null,
      );
      const desk = t.desk_reading;
      expect(desk.refused?.missing_headers ?? null, t.id).toEqual(
        r.rejected?.missing_headers ?? null,
      );
      expect(
        desk.exceptions.map((e) => [e.row, e.servicer_loan_number, e.code, e.column]),
        t.id,
      ).toEqual(r.exceptions.map((e) => [e.row, e.servicer_loan_number, e.code, e.column ?? null]));
      expect(desk.rows_read).toBe(r.records.length);
      if (desk.refused) refused++;
      exceptions += desk.exceptions.length;
    }
    expect(refused).toBeGreaterThan(10);
    expect(exceptions).toBeGreaterThan(0);
  });

  it("takes every arm in turn, every defect in its forms, every verdict at a sixth or more", () => {
    const arms = new Map<string, number>();
    for (const t of heldout) arms.set(t.arm, (arms.get(t.arm) ?? 0) + 1);
    expect([...arms.keys()].sort()).toEqual([...INTAKE_ARMS].sort());
    for (const n of arms.values()) expect([12, 13]).toContain(n);
    for (const t of heldout) expect(t.arm).toBe(intakeArmOf(t.index));
    const verdicts = new Map<string, number>();
    for (const t of heldout)
      verdicts.set(t.expected.verdict, (verdicts.get(t.expected.verdict) ?? 0) + 1);
    for (const v of ["load", "load_after_correction", "hold"])
      expect(verdicts.get(v)!, v).toBeGreaterThan(heldout.length / 6);
    const found = heldout.flatMap((t) => t.expected.findings);
    expect(new Set(found.map((f) => f.defect))).toEqual(new Set(INTAKE_DEFECTS));
    expect(new Set(found.map((f) => f.ask))).toEqual(new Set(ASKS));
    // Each T-04 form, and the columns a spreadsheet reaches.
    const dates = heldout.flatMap((t) => t.expected.findings.filter((f) => f.defect === "T-04"));
    expect(new Set(dates.map((f) => f.effect))).toEqual(new Set(["none", "corrected"]));
    expect(new Set(dates.map((f) => f.column)).size).toBeGreaterThanOrEqual(5);
    expect(dates.some((f) => /^\d+\/\d+\/\d\d$/.test(f.says!))).toBe(true);
    expect(dates.some((f) => /^\d{5}$/.test(f.says!))).toBe(true);
    // Every delivery is a month of a partner's book: several loans, and history to compare.
    for (const t of heldout) {
      expect(t.delivery.rows.length).toBeGreaterThanOrEqual(5);
      expect(t.last_loaded.rows.length).toBeGreaterThanOrEqual(5);
    }
  });

  it("is solved by the reference on the held-out suite, a training suite and the spec's cases", async () => {
    for (const tasks of [heldout, train, spec]) {
      const r = await solveAll(tasks);
      expect(r.misses).toEqual([]);
      expect(r.turns).toBeLessThanOrEqual(6);
      expect(r.calls).toBeLessThanOrEqual(40);
    }
  }, 300_000);

  it("labels each finding as the delivery shows it", () => {
    const col = (t: TapeIntakeTask, header: string) => LAYOUT.findIndex((c) => c.header === header);
    for (const t of [...heldout, ...spec]) {
      for (const f of t.expected.findings) {
        if (f.defect === "T-01") continue;
        if (f.defect === "T-02") {
          expect(t.delivery.headers[col(t, f.column!)], t.id).toBe(f.says);
          continue;
        }
        const i = col(t, f.column!);
        const cells = t.delivery.rows.map((r) => r[i] ?? "");
        if (f.loan === null) {
          // The first row of the file the defect reaches.
          expect(cells, t.id).toContain(f.says);
          continue;
        }
        const row = t.delivery.rows.find((r) => r[2] === f.loan)!;
        expect(row[i], t.id).toBe(f.says);
      }
      // A T-01 month never delivered is the month between the last tape and this one.
      for (const f of t.expected.findings.filter(
        (x) => x.defect === "T-01" && x.ask === "send_missing_month",
      ))
        expect([t.last_loaded.for_month < f.month, f.month < t.delivery.for_month]).toEqual([
          true,
          true,
        ]);
    }
  });

  it("grades the spec's cases: each defect found with what the tape says, what is true and what to ask", () => {
    expect(spec.map((t) => t.arm)).toEqual(INTAKE_SPEC_CASES.map((c) => c.name));
    expect(
      spec.map((t) => [
        t.expected.verdict,
        ...t.expected.findings.map((f) => `${f.defect} ${f.column ?? "*"} ${f.ask} ${f.effect}`),
      ]),
    ).toEqual([
      ["load"],
      ["load", "T-01 * send_missing_month none"],
      ["hold", "T-01 * send_this_month hold"],
      ["hold", "T-02 Next Due Date restore_header hold"],
      ["load_after_correction", "T-02 Pay String restore_header corrected"],
      [
        "load_after_correction",
        ...spec[5]!.expected.findings
          .filter((f) => f.defect === "T-03")
          .map((f) => `T-03 ${f.column} export_codes_as_text corrected`),
        "T-04 Date Maturity export_dates_in_layout corrected",
      ],
      ["load", "T-04 Orig Date Closing export_dates_in_layout none"],
      ["load", "T-04 Next Due Date export_dates_in_layout none"],
      ["load_after_correction", "T-05 As of Date write_month_end_as_of corrected"],
      ["load_after_correction", "T-05 As of Date write_month_end_as_of corrected"],
      ["load", "V-01 SRV Asset Escrow Balance research_disbursement none"],
      ["load", "V-02 SRV Asset Escrow Balance confirm_insurance_billing none"],
      [
        "load",
        "D-25 Cash Flow Month 12 (Most Recent Month) move_payment none",
        "D-25 Cash Flow Month 12 (Most Recent Month) move_payment none",
      ],
    ]);
    // A payment posted elsewhere: the payer's cell is empty, and the two loans' numbers a keystroke apart.
    const [payer, lands] = spec[12]!.expected.findings;
    expect(payer!.says).toBe("0.00");
    expect(Number(lands!.says) - Number(lands!.truth)).toBeCloseTo(Number(payer!.truth), 2);
    expect(payer!.loan!.slice(0, -1)).toBe(lands!.loan!.slice(0, -1));
    // The as-of the export's day, after the month-end; and last month's end, the last tape's own as-of.
    const exported = spec[8]!.expected.findings[0]!;
    const [m, d, y] = exported.says!.split("/").map(Number);
    expect(
      `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` >
        `${spec[8]!.delivery.for_month}-28`,
    ).toBe(true);
    expect(spec[9]!.expected.findings[0]!.says).toBe(spec[9]!.last_loaded.rows[0]![1]);
  });

  it("grades as the sample's test does: defects found, a clean month passed, extra findings up to a cap", () => {
    const t = heldout.find((x) => x.arm === "misposted_as_of")!;
    const right = answerOf(t);
    expect(grade(t, right).pass).toBe(true);
    // Nothing found: every field of every finding missed, and the verdict.
    const none = grade(t, { verdict: "load", findings: [] });
    expect(none.pass).toBe(false);
    expect(none.fields.filter((f) => !f.ok).length).toBe(4 * 3 + 1);
    expect([grade(t, null).pass, grade(t, null).score]).toEqual([false, 0]);
    // Money, dates and headers read leniently; a column by its letter; a code exactly.
    const loose = right.findings.map((f): IntakeFinding =>
      f.defect === "D-25"
        ? {
            ...f,
            says: `$${Number(f.says).toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
            column: "BR",
          }
        : {
            ...f,
            truth: `${f.truth!.split("/")[2]}-${f.truth!.split("/")[0]!.padStart(2, "0")}-${f.truth!.split("/")[1]!.padStart(2, "0")}`,
            column: "as of date",
          },
    );
    expect(grade(t, { ...right, findings: loose }).pass).toBe(true);
    // The wrong ask, or the wrong verdict, fails that field alone.
    const asked = right.findings.map((f) =>
      f.defect === "T-05" ? { ...f, ask: "send_this_month" as const } : f,
    );
    expect(
      grade(t, { ...right, findings: asked })
        .fields.filter((f) => !f.ok)
        .map((f) => f.field.split(": ")[1]),
    ).toEqual(["ask"]);
    expect(
      grade(t, { ...right, verdict: "load" })
        .fields.filter((f) => !f.ok)
        .map((f) => f.field),
    ).toEqual(["verdict"]);
    // Extra findings: up to the cap, then not; a second finding on one is one.
    const note: IntakeFinding = {
      defect: "V-01",
      month: t.delivery.for_month,
      loan: t.delivery.rows[0]![2]!,
      column: "SRV Asset Escrow Balance",
      says: "1.00",
      truth: null,
      ask: "research_disbursement",
    };
    const extra = (n: number) =>
      grade(t, { ...right, findings: [...right.findings, ...Array(n).fill(note)] }).pass;
    expect([extra(EXTRA_FINDINGS_CAP), extra(EXTRA_FINDINGS_CAP + 1)]).toEqual([true, false]);
    expect(grade(t, { ...right, findings: [...right.findings, right.findings[0]!] }).pass).toBe(
      true,
    );
    // A clean month is passed by loading it with nothing found, and failed by holding it.
    const clean = heldout.find((x) => x.arm === "clean")!;
    expect(grade(clean, { verdict: "load", findings: [] }).pass).toBe(true);
    expect(grade(clean, { verdict: "hold", findings: [] }).pass).toBe(false);
    // A malformed submission is an error to correct, not a grade.
    expect(parseIntakeSubmission({ verdict: "load" }).ok).toBe(false);
    expect(parseIntakeSubmission({ verdict: "maybe", findings: [] }).ok).toBe(false);
    expect(
      parseIntakeSubmission({ verdict: "load", findings: [{ ...note, defect: "D-28" }] }).ok,
    ).toBe(false);
    expect(
      parseIntakeSubmission({ verdict: "load", findings: [{ ...note, month: "2027" }] }).ok,
    ).toBe(false);
    expect(
      parseIntakeSubmission({ verdict: "load", findings: [{ ...note, ask: "call" }] }).ok,
    ).toBe(false);
  });

  it("gives floors to read a score against: nothing found, and every stream check but no record read", () => {
    const empty = heldout.filter((t) => grade(t, { verdict: "load", findings: [] }).pass).length;
    const streamOnly = heldout.filter((t) => {
      const a = answerOf(t);
      return grade(t, { ...a, findings: a.findings.filter((f) => !history.has(f.defect)) }).pass;
    }).length;
    expect(empty).toBe(heldout.filter((t) => t.expected.findings.length === 0).length);
    expect(streamOnly).toBe(
      heldout.filter((t) => !t.expected.findings.some((f) => history.has(f.defect))).length,
    );
    expect({ empty, streamOnly }).toEqual({ empty: 25, streamOnly: 140 });
  });

  it("pins what a model is told", () => {
    // Any edit to the rulebook or the tools changes what every model is told: bump
    // INTAKE_ENVIRONMENT_VERSION with this pin.
    expect(INTAKE_FINGERPRINT.environment).toMatchInlineSnapshot(`
      {
        "name": "tape-intake",
        "rulebook_sha256": "c9caa356d21a4f33bf4aab99a1fe75d7f788f67b0b8cdef110e6444229cbd69f",
        "tools_sha256": "bb706a5e61e43776d59b9d6e47e929aa7e0cbf9cbb7061c047f8e37156e1b4e7",
        "version": "1.0.0",
      }
    `);
    const rendered = renderIntakeTask(spec[13 - 1]!);
    expect(rendered).not.toMatch(/T-0\d|V-0\d|D-25|label|planted|keystroke|misposted/);
    for (const t of spec) expect(JSON.stringify(intakePayload(t))).not.toMatch(/"expected"|"arm"/);
  });

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump INTAKE_ENVIRONMENT_VERSION, then the pin.
    expect(sha256(heldout.map(toJsonLine).join(""))).toMatchInlineSnapshot(
      `"09804de6524ba06a7fd9bb0402b61c8b76ffda548abc48c5a0c83d24aa6e0c2e"`,
    );
  });

  it("rebuilds a task from its coordinates, and never draws a held-out delivery into training", () => {
    expect(toJsonLine(generateIntakeTask("train", 7, 17))).toBe(toJsonLine(train[17]));
    const fp = (t: TapeIntakeTask) => sha256(toJsonLine(t.delivery.rows));
    const held = new Set(heldout.map(fp));
    expect(train.filter((t) => held.has(fp(t)))).toEqual([]);
    expect(drawsHeldoutStream(heldout[0]!.id)).toBe(true);
    const { attempts } = drawIntakeTask("train", 7, 3);
    expect(attempts).toBeGreaterThanOrEqual(1);
    expect(intakeVerdict(heldout.find((t) => t.arm === "clean")!)).toBe("clean");
  });
});
