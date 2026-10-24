/**
 * boarding-triage: the ports are the servicing app's files but for their
 * imports; the layout's code lists are the codec's; every package the
 * generator keeps passes the gate's own rules and has its defects found and
 * its clean loans passed by the reference through the tools, on the
 * held-out suite, a training suite and the demo loan's four packages; every
 * one of the ten defects is drawn above its floor; the grader reads the label
 * manifest as the servicing app's demo-batch test reads the sample's designed
 * outcomes, and tells a defect's root from its symptoms; the servicing app's
 * own boarding, run in process by apps/servicing/scripts/board-life-package.mjs,
 * catches none of the ten; and the held-out suite is pinned.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { runEpisode } from "../episode.js";
import { sha256, toJsonLine } from "../record.js";
import { drawsHeldoutStream } from "../heldout-guard.js";
import {
  BOARDING_FINGERPRINT,
  BOARDING_HELDOUT_SUITE,
  BOARDING_PLAN_NAMES,
  BOARDING_TOOLS,
  BoardingReferencePolicy,
  COLUMNS,
  EXTRA_FINDINGS_CAP,
  FLOOD_ZONES,
  YES_NO_COLUMNS,
  boardingPayload,
  boardingPlanOf,
  boardingSpecTasks,
  boardingTriage,
  drawBoardingTask,
  executeBoardingTool,
  expectedTriage,
  gateFailures,
  generateBoardingSuite,
  generateBoardingTask,
  gradeTriage,
  parseTriageSubmission,
  renderBoardingTask,
  type BoardingTask,
  type TriageAnswer,
  type TriageFinding,
} from "../boarding/index.js";
import { oneOfEach } from "../boarding/one-of-each.js";
import { encodeFinalTapeRow, parseCsv } from "../boarding/ported/tape-codec.js";
import {
  DEFECTS,
  defaultCalibration,
  demoLoan,
  packageManifest,
  PACKAGE_FILES,
  type PackageFile,
  type PackageManifest,
} from "../life/index.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/* The ports: each file is its source but for the import statements (PORTED_FROM). */
function split(text: string): { imports: string[]; body: string } {
  const imports: string[] = [];
  const body: string[] = [];
  for (const line of text.split("\n")) (line.startsWith("import ") ? imports : body).push(line);
  return { imports, body: body.join("\n") };
}
const rewritten = (statement: string) =>
  statement
    .replace(/"\.\.\/\.\.\/kernel\/(calendar|money)\/[a-z-]+\.ts"/g, '"@hm/kernel/$1"')
    .replace(/"\.\/types\.ts"/g, '"../../pmi/ported/types.js"')
    .replace(/"\.\/([a-z0-9-]+)\.ts"/g, '"./$1.js"');

let heldout: BoardingTask[] = [];
let train: BoardingTask[] = [];
let spec: BoardingTask[] = [];
let each: { id: string; task: BoardingTask }[] = [];

beforeAll(() => {
  heldout = generateBoardingSuite(
    BOARDING_HELDOUT_SUITE.split,
    BOARDING_HELDOUT_SUITE.seed,
    BOARDING_HELDOUT_SUITE.n,
  );
  train = generateBoardingSuite("train", 7, 300);
  spec = boardingSpecTasks();
  each = oneOfEach();
}, 600_000);

const solveAll = async (tasks: readonly BoardingTask[]) => {
  const misses: string[] = [];
  let turns = 0;
  let calls = 0;
  for (const task of tasks) {
    const r = await runEpisode(boardingTriage, task, new BoardingReferencePolicy());
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

const roots = (t: BoardingTask) => t.labels.filter((l) => l.root_cause);
/** The registry's defects that sit in a transfer package: the first ten, not the errors made in the history after boarding. */
const inPackages = Object.keys(DEFECTS).filter((k) => DEFECTS[k]!.package !== null);
const taskOf = (id: string) => each.find((x) => x.id === id)!.task;

describe("boarding-triage", () => {
  it("ports the servicing app's codec, gate and MIN check but for their import statements", () => {
    for (const file of ["tape-codec", "rules", "min"]) {
      const original = split(
        readFileSync(here(`../../../../apps/servicing/src/domain/boarding/${file}.ts`), "utf8"),
      );
      const port = split(readFileSync(here(`../boarding/ported/${file}.ts`), "utf8"));
      expect(port.body, file).toBe(original.body);
      expect(port.imports, file).toEqual(original.imports.map(rewritten));
    }
  });

  it("reads its code lists from the codec: the Y/N columns are the ones its encoder writes Y or N", () => {
    const loan = decodeOne();
    const truthy = {
      ...loan,
      mers_eligible: true,
      escrowed: true,
      nib_separated: true,
      bankruptcy: { active: true },
      foreclosure: { active: true },
      lossmit: { in_process: true },
      scra: { active: true },
      tax_parcel_verified: true,
      mi: { flag: true },
      flood_determination_life_of_loan: true,
      sii: { present: true, complete: true },
      fair_lending_present: true,
      acp_enrolled: true,
      fees_itemized: true,
      mers_investor_is_fnma: true,
    };
    const row = encodeFinalTapeRow(truthy);
    expect(
      Object.keys(row)
        .filter((k) => row[k] === "Y")
        .sort(),
    ).toEqual([...YES_NO_COLUMNS].sort());
    const codes = Object.fromEntries(
      COLUMNS.filter((c) => c.file === "boarding_tape.final.csv" && c.format === "code").map(
        (c) => [c.column, c.codes],
      ),
    );
    expect(codes).toEqual({
      remittance_type: ["A/A", "S/A", "S/S"],
      interest_method: ["30_360", "actual_360", "actual_365", "daily_simple"],
      amortization: ["fixed", "arm", "step", "balloon", "interest_only", "buydown"],
      occupancy: ["owner_occupied", "second_home", "investment"],
      flood_zone: [...FLOOD_ZONES],
    });
    for (const f of PACKAGE_FILES) {
      const header = spec[0]!.files[f].split("\n")[0]!.split(",");
      expect(
        COLUMNS.filter((c) => c.file === f).map((c) => c.column),
        f,
      ).toEqual(header);
    }
  });

  it("gives tools that read and look up, and none that checks or decides", () => {
    expect(BOARDING_TOOLS.map((t) => t.name)).toEqual([
      "read_file",
      "code_list",
      "calculate",
      "submit_triage",
    ]);
    const t = spec[3]!;
    const loan = t.loans[0]!;
    expect(() => executeBoardingTool("read_file", { file: "fair_lending.csv" }, t)).toThrow(
      /restricted/,
    );
    expect(() =>
      executeBoardingTool("read_file", { file: "payment_history.csv", loan: "P0" }, t),
    ).toThrow(/no loan/);
    expect(() => executeBoardingTool("read_file", { file: "payment_history.csv" })).toThrow(
      /without one/,
    );
    const history = parseCsv(
      executeBoardingTool("read_file", { file: "payment_history.csv", loan }, t),
    );
    expect(history.every((r) => r["transferor_loan_number"] === loan)).toBe(true);
    const tape = parseCsv(t.files["boarding_tape.final.csv"])[0]!;
    const fnma = parseCsv(executeBoardingTool("read_file", { file: "fnma_position.csv", loan }, t));
    expect(fnma.map((r) => r["fnma_loan_number"])).toEqual([tape["fnma_loan_number"]]);
    const escrowed = JSON.parse(
      executeBoardingTool("code_list", { file: "boarding_tape.final.csv", column: "escrowed" }),
    ) as {
      columns: { codes: string[]; format: string }[];
    };
    expect(escrowed.columns[0]).toMatchObject({ format: "yes_no", codes: ["Y", "N"] });
    expect(() =>
      executeBoardingTool("code_list", { file: "boarding_tape.final.csv", column: "nope" }),
    ).toThrow(/no column/);
    expect(
      JSON.parse(executeBoardingTool("calculate", { expression: "round(2275.44 * 5 / 100, 2)" })),
    ).toEqual({ value: "113.77" });
  });

  it("keeps only packages the gate passes, each loan of them", () => {
    for (const t of [...heldout, ...spec, ...each.map((x) => x.task)])
      for (const [loan, failed] of gateFailures(t))
        expect([t.id, loan, failed]).toEqual([t.id, loan, []]);
  });

  it("draws every plan in turn, every defect above its floor, and clean loans that look like the defects", () => {
    const plans = new Map<string, number>();
    for (const t of heldout)
      plans.set(boardingPlanOf(t.index), (plans.get(boardingPlanOf(t.index)) ?? 0) + 1);
    expect([...plans.keys()].sort()).toEqual([...BOARDING_PLAN_NAMES].sort());
    for (const n of plans.values())
      expect(n).toBe(BOARDING_HELDOUT_SUITE.n / BOARDING_PLAN_NAMES.length);
    // Each of the ten on at least 20 of the 200 packages: the floor every defect is drawn above.
    const planted = new Map<string, number>();
    for (const t of heldout)
      for (const l of roots(t)) planted.set(l.defect_id, (planted.get(l.defect_id) ?? 0) + 1);
    expect(Object.fromEntries([...planted].sort())).toEqual({
      "D-01": 20,
      "D-03": 40,
      "D-12": 20,
      "D-15": 20,
      "D-18": 20,
      "D-24": 30,
      "D-25": 20,
      "D-35": 30,
      "D-37": 20,
      "D-42": 40,
    });
    expect([...planted.keys()].sort()).toEqual(inPackages.sort());
    for (const n of planted.values()) expect(n).toBeGreaterThanOrEqual(20);
    // The clean loans are the negatives, drawn to look like the defects beside them.
    const look = { cap: 0, no_escrow: 0, arm: 0, scra: 0, bk: 0, lm: 0, mi: 0, flood: 0 };
    let clean = 0;
    for (const t of heldout) {
      const defective = new Set(t.labels.map((l) => l.loan));
      for (const row of parseCsv(t.files["boarding_tape.final.csv"])) {
        if (defective.has(row["transferor_loan_number"]!)) continue;
        clean++;
        if (row["late_charge_max"]) look.cap++;
        if (row["escrowed"] === "N") look.no_escrow++;
        if (row["amortization"] === "arm") look.arm++;
        if (row["scra_active"] === "Y") look.scra++;
        if (row["bk_active"] === "Y") look.bk++;
        if (row["lm_in_process"] === "Y") look.lm++;
        if (row["mi_flag"] === "Y") look.mi++;
        if (row["flood_zone"] === "AE") look.flood++;
      }
    }
    expect(clean).toBe(130);
    expect(look).toEqual({
      cap: 52,
      no_escrow: 30,
      arm: 15,
      scra: 5,
      bk: 9,
      lm: 10,
      mi: 41,
      flood: 19,
    });
  });

  it("is solved by the reference on the held-out suite, a training suite, the demo loan's packages and one of each", async () => {
    for (const tasks of [heldout, train, spec, each.map((x) => x.task)]) {
      const r = await solveAll(tasks);
      expect(r.misses).toEqual([]);
      expect(r.turns).toBeLessThanOrEqual(3);
      expect(r.calls).toBeLessThanOrEqual(18);
    }
  });

  it("grades the demo loan's packages: the clean one passed, each defect found with its handling", () => {
    expect(
      spec.map((t) =>
        expectedTriage(t).findings.map((f) => [f.field, f.says, f.truth, f.handling]),
      ),
    ).toEqual([
      [],
      [["escrowed", "Yes", "Y", "correct"]],
      [["late_charge_max", "", "50.00", "query"]],
      [
        ["late_charge_max", "", "50.00", "query"],
        ["escrowed", "Yes", "Y", "correct"],
      ],
    ]);
  });

  it("labels each of the ten at its root, with what a reviewer should do and what follows from it", () => {
    expect(
      each.map(({ id, task }) => {
        const r = roots(task);
        expect(r.length).toBe(1);
        const l = r[0]!;
        return [id, l.file_or_table, l.field, l.handling];
      }),
    ).toEqual([
      ["D-42", "boarding_tape.final.csv", "escrowed", "correct"],
      ["D-35", "boarding_tape.final.csv", "lm_in_process", "correct"],
      ["D-03", "boarding_tape.final.csv", "late_charge_max", "query"],
      ["D-01", "boarding_tape.final.csv", "arm_initial_cap_bps", "query"],
      ["D-12", "boarding_tape.final.csv", "scra_active", "correct"],
      ["D-37", "boarding_tape.final.csv", "bk_active", "correct"],
      ["D-18", "boarding_tape.final.csv", "mi_termination_date", "query"],
      ["D-24", "payment_history.csv", "due_date", "hold"],
      ["D-25", "payment_history.csv", "principal", "query"],
      ["D-15", "boarding_tape.final.csv", "flood_zone", "correct"],
    ]);
    const symptoms = (id: string) => [
      ...new Set(
        taskOf(id)
          .labels.filter((l) => !l.root_cause)
          .map((l) => `${l.file_or_table} ${l.field}`),
      ),
    ];
    // A flag left off beside its details, a cap, a zone, a date: the cell alone.
    for (const id of ["D-42", "D-35", "D-03", "D-01", "D-37", "D-18", "D-15"])
      expect(symptoms(id)).toEqual([]);
    // What a reviewer's checks flag because of a root, though it holds what it should.
    expect(symptoms("D-24")).toEqual(["boarding_tape.final.csv next_due_date"]);
    expect(symptoms("D-12")).toEqual(["boarding_tape.final.csv pi_payment"]);
    // A misapplied payment reaches the row beside it, every later split, and every balance the books feed.
    expect(symptoms("D-25")).toEqual(
      expect.arrayContaining([
        "payment_history.csv escrow",
        "boarding_tape.final.csv upb",
        "trial_balance.csv upb_as_of_t_minus_1",
        "fnma_position.csv upb",
      ]),
    );
    // D-24's row is one the loan never had, before its first payment and the note.
    const d24 = roots(taskOf("D-24"))[0]!;
    const tape24 = parseCsv(taskOf("D-24").files["boarding_tape.final.csv"])[0]!;
    expect(d24.true_value).toBeNull();
    expect(d24.planted_value! < tape24["first_payment_date"]!).toBe(true);
    expect(d24.planted_value! < tape24["origination_date"]!).toBe(true);
    // D-25's root says what the statement's P&I owed the principal.
    const d25 = roots(taskOf("D-25"))[0]!;
    expect([d25.planted_value, Number(d25.true_value) > 0]).toEqual(["0.00", true]);
  });

  it("grades a root apart from its symptoms: a symptom alone earns part of the credit at most, the root covers them", () => {
    for (const id of ["D-24", "D-12", "D-25"]) {
      const t = taskOf(id);
      const root = expectedTriage(t).findings;
      const symptom = t.labels
        .filter((l) => !l.root_cause)
        .map((l): TriageFinding => ({
          loan: l.loan,
          file: l.file_or_table,
          field: l.field,
          row: l.file_or_table === "boarding_tape.final.csv" ? null : l.row,
          says: l.planted_value,
          truth: l.true_value,
          handling: l.handling,
        }))[0]!;
      const grade = (findings: readonly TriageFinding[]) => gradeTriage(t, { findings });
      const alone = grade([symptom]);
      expect([id, alone.pass]).toEqual([id, false]);
      expect(alone.score).toBeGreaterThan(grade([]).score);
      expect(alone.fields.find((f) => f.field.endsWith(": traced"))?.ok).toBe(true);
      expect(alone.fields.find((f) => f.field.endsWith(": found"))?.ok).toBe(false);
      // The root covers its symptoms; named beside it, a symptom is neither required nor extra.
      expect(grade(root).pass).toBe(true);
      const both = grade([...root, symptom]);
      expect(both.pass).toBe(true);
      expect(both.fields.find((f) => f.field === "extra findings")?.got).toBe("0");
    }
    // A payment-history finding names its row; without one it is an error to correct, not a grade.
    const r24 = expectedTriage(taskOf("D-24")).findings[0]!;
    expect(parseTriageSubmission({ findings: [{ ...r24, row: null }] }).ok).toBe(false);
    expect(parseTriageSubmission({ findings: [r24] }).ok).toBe(true);
    // The wrong row is not the root.
    const elsewhere = gradeTriage(taskOf("D-24"), { findings: [{ ...r24, row: "2031-01-01" }] });
    expect(elsewhere.pass).toBe(false);
  });

  it("grades as the sample's test does: planted defects found, a clean loan passed, extra findings up to a cap", () => {
    const t = heldout.find((x) => boardingPlanOf(x.index) === "batch_mixed")!;
    const right = expectedTriage(t);
    const grade = (a: TriageAnswer | null) => gradeTriage(t, a);
    expect(grade(right).pass).toBe(true);
    // Nothing: every planted field missed, the clean loans passed.
    const none = grade({ findings: [] });
    expect(none.pass).toBe(false);
    expect(none.fields.filter((f) => !f.ok).length).toBe(8);
    expect([grade(null).pass, grade(null).score]).toEqual([false, 0]);
    // Money and blanks read leniently; a code exactly.
    const loose = right.findings.map((f) =>
      f.field === "late_charge_max" ? { ...f, says: null, truth: `$${Number(f.truth)}` } : f,
    );
    expect(grade({ findings: loose }).pass).toBe(true);
    const lower = right.findings.map((f) => (f.field === "escrowed" ? { ...f, truth: "y" } : f));
    expect(
      grade({ findings: lower })
        .fields.filter((f) => !f.ok)
        .map((f) => f.field),
    ).toEqual([expect.stringMatching(/escrowed: truth$/)]);
    // Querying where the package does not conflict with itself earns nothing; correcting a money term neither.
    const queried = right.findings.map((f) => ({
      ...f,
      handling: f.handling === "correct" ? ("query" as const) : ("correct" as const),
    }));
    expect(
      grade({ findings: queried })
        .fields.filter((f) => !f.ok)
        .map((f) => f.field.split(": ")[1]),
    ).toEqual(["handling", "handling"]);
    // Extra findings: up to the cap, then not; a duplicate is one.
    const clean = t.loans.find((n) => !t.labels.some((l) => l.loan === n))!;
    const note = {
      loan: clean,
      file: "consents_file.csv",
      field: "esign_evidence",
      says: "Y",
      truth: "Y",
      handling: "board_as_is" as const,
    };
    expect(
      grade({ findings: [...right.findings, ...Array(EXTRA_FINDINGS_CAP).fill(note)] }).pass,
    ).toBe(true);
    expect(
      grade({ findings: [...right.findings, ...Array(EXTRA_FINDINGS_CAP + 1).fill(note)] }).pass,
    ).toBe(false);
    expect(grade({ findings: [...right.findings, ...right.findings] }).pass).toBe(true);
    // Holding or correcting a clean loan fails it.
    const held = grade({ findings: [...right.findings, { ...note, handling: "hold" }] });
    expect(held.fields.filter((f) => !f.ok).map((f) => f.field)).toEqual([`${clean}: passed`]);
    // A malformed submission is an error to correct, not a grade.
    expect(parseTriageSubmission({ findings: [{ loan: "x" }] }).ok).toBe(false);
    expect(parseTriageSubmission({ findings: [{ ...note, handling: "ignore" }] }).ok).toBe(false);
    expect(parseTriageSubmission({}).ok).toBe(false);
  });

  it("gives floors to read a score against: nothing found, the flags alone, and no history or statement read", () => {
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const empty = heldout.map((t) => gradeTriage(t, { findings: [] }));
    expect(empty.filter((g) => g.pass).length).toBe(20);
    expect(Number(mean(empty.map((g) => g.score)).toFixed(3))).toBeLessThan(0.3);
    // Every flag that is a code (checks 1 and 5), and nothing else.
    const FLAGS = new Set(["escrowed", "lm_in_process", "bk_active", "scra_active"]);
    const flags = heldout.map((t) =>
      gradeTriage(t, { findings: expectedTriage(t).findings.filter((f) => FLAGS.has(f.field)) }),
    );
    expect(flags.filter((g) => g.pass).length).toBe(70);
    // Every check that reads the tape and the short files alone (1, 2, 5 and 6), and no payment history or
    // correspondence.
    const shown = heldout.map((t) =>
      gradeTriage(t, {
        findings: expectedTriage(t).findings.filter(
          (f) => FLAGS.has(f.field) || f.field.startsWith("arm_"),
        ),
      }),
    );
    expect(shown.filter((g) => g.pass).length).toBe(80);
  });

  it("is what the servicing app's own boarding does not catch, run in process on the demo's packages and one of each", () => {
    const out = mkdtempSync(join(tmpdir(), "boarding-triage-"));
    const write = (
      name: string,
      files: Readonly<Record<PackageFile, string>>,
      manifest: PackageManifest,
    ) => {
      const dir = join(out, name);
      mkdirSync(dir);
      for (const f of PACKAGE_FILES) writeFileSync(join(dir, f), files[f]);
      writeFileSync(join(dir, "manifest.json"), toJsonLine(manifest));
      return dir;
    };
    const demo = demoLoan(defaultCalibration());
    const dirs = [
      ...Object.entries(demo.packages).map(([name, pkg]) => write(name, pkg.files, pkg.manifest)),
      ...each.map(({ id, task }) =>
        write(`each-${id}`, task.files, packageManifest(task.batch, task.files, task.labels)),
      ),
    ];
    const r = spawnSync(
      process.execPath,
      [here("../../../../apps/servicing/scripts/board-life-package.mjs"), "--json", ...dirs],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    expect(r.stderr).toBe("");
    const reports = JSON.parse(r.stdout) as {
      package: string;
      boarded: number;
      refused: number;
      loans: {
        loan: string;
        status: string;
        hard: string[];
        warnings: string[];
        boarded_escrowed: boolean;
        boarded_lossmit_in_process: boolean;
        boarded_bk_active: boolean;
        boarded_scra_active: boolean;
        boarded_regx_days_delinquent: number;
      }[];
      labels: {
        defect_id: string;
        root_cause: boolean;
        caught: boolean;
        boarded_as: string | null;
      }[];
    }[];
    const by = Object.fromEntries(reports.map((x) => [x.package.split("/").at(-1)!, x]));
    for (const x of reports) {
      expect([x.boarded, x.refused]).toEqual([1, 0]);
      expect(x.loans[0]!.hard).toEqual([]);
      expect(x.loans[0]!.warnings).toEqual([]);
    }
    expect(by["clean"]!.loans[0]!.boarded_escrowed).toBe(true);
    expect(by["D-03"]!.loans[0]!.boarded_escrowed).toBe(true);
    expect(by["D-42"]!.loans[0]!.boarded_escrowed).toBe(false);
    expect(by["defective"]!.labels.map((l) => [l.defect_id, l.caught])).toEqual([
      ["D-03", false],
      ["D-42", false],
    ]);
    expect(by["D-42"]!.labels[0]!.boarded_as).toBe("loan.boarded escrowed=false (D-31)");
    // The gate catches none of the ten, at the root or beside it.
    const planted = reports.flatMap((x) => x.labels);
    expect(
      [...new Set(planted.filter((l) => l.root_cause).map((l) => l.defect_id))].sort(),
    ).toEqual(inPackages.sort());
    expect(planted.filter((l) => l.caught)).toEqual([]);
    // And boards each flag the package left off as off.
    const loan = (id: string) => by[`each-${id}`]!.loans[0]!;
    expect(loan("D-35").boarded_lossmit_in_process).toBe(false);
    expect(loan("D-37").boarded_bk_active).toBe(false);
    expect(loan("D-12").boarded_scra_active).toBe(false);
    // D-24's phantom row boards a loan behind that the tape says is not.
    const tape = parseCsv(taskOf("D-24").files["boarding_tape.final.csv"])[0]!;
    expect(tape["next_due_date"]! > taskOf("D-24").batch.transfer_date).toBe(true);
    expect(loan("D-24").boarded_regx_days_delinquent).toBeGreaterThan(0);
    expect(by["each-D-24"]!.labels.find((l) => l.root_cause)!.boarded_as).toMatch(
      /days delinquent/,
    );
  });

  it("pins what a model is told", () => {
    // Any edit to the rulebook or the tools changes what every model is told: bump
    // BOARDING_ENVIRONMENT_VERSION with this pin.
    expect(BOARDING_FINGERPRINT.environment).toMatchInlineSnapshot(`
      {
        "name": "boarding-triage",
        "rulebook_sha256": "80f4b7aa5a15211692ec3d4ab88e9edf50bca37f2a1ef34ae65d410530bdff46",
        "tools_sha256": "ebe3db070186cd12f5d6d18f9e6f607c3ae06e8d65d574429c1286f4ab4a101e",
        "version": "1.1.0",
      }
    `);
    expect(renderBoardingTask(spec[3]!)).not.toMatch(/D-42|D-03|label|planted/);
    expect(JSON.stringify(boardingPayload(spec[3]!))).not.toContain("sha256");
  });

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump BOARDING_ENVIRONMENT_VERSION, then the pin.
    expect(sha256(heldout.map(toJsonLine).join(""))).toMatchInlineSnapshot(
      `"eb9db31d2f2b733769b7105d5de98c15266e1c5ac68d092b9412b1a1ba9d18bb"`,
    );
  });

  it("rebuilds a task from its coordinates, and never draws a held-out package into training", () => {
    expect(toJsonLine(generateBoardingTask("train", 7, 17))).toBe(toJsonLine(train[17]));
    const fp = (t: BoardingTask) => sha256(t.files["boarding_tape.final.csv"]);
    const held = new Set(heldout.map(fp));
    expect(train.filter((t) => held.has(fp(t)))).toEqual([]);
    expect(drawsHeldoutStream(heldout[0]!.id)).toBe(true);
    expect(drawsHeldoutStream("boarding-triage/1.0.0/heldout/1/0")).toBe(true);
    const { attempts } = drawBoardingTask("train", 7, 3);
    expect(attempts).toBeGreaterThanOrEqual(1);
  });
});

/** One staged loan: the clean demo package's, as the writer encodes it and the decoder reads it back. */
function decodeOne() {
  return demoLoan(defaultCalibration()).packages.clean.loans[0]!;
}
