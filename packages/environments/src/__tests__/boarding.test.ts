/**
 * boarding-triage: the ports are the servicing app's files but for their
 * imports; the layout's code lists are the codec's; every package the
 * generator keeps passes the gate's own rules and has its defects found and
 * its clean loans passed by the reference through the tools, on the
 * held-out suite, a training suite and the demo loan's four packages; the
 * grader reads the label manifest as the servicing app's demo-batch test
 * reads the sample's designed outcomes; the servicing app's own boarding,
 * run in process by apps/servicing/scripts/board-life-package.mjs, catches
 * neither planted defect; and the held-out suite is pinned.
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
} from "../boarding/index.js";
import { encodeFinalTapeRow, parseCsv } from "../boarding/ported/tape-codec.js";
import { defaultCalibration, demoLoan, PACKAGE_FILES } from "../life/index.js";

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

beforeAll(() => {
  heldout = generateBoardingSuite(
    BOARDING_HELDOUT_SUITE.split,
    BOARDING_HELDOUT_SUITE.seed,
    BOARDING_HELDOUT_SUITE.n,
  );
  train = generateBoardingSuite("train", 7, 300);
  spec = boardingSpecTasks();
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
    for (const t of [...heldout, ...spec])
      for (const [loan, failed] of gateFailures(t))
        expect([t.id, loan, failed]).toEqual([t.id, loan, []]);
  });

  it("draws every plan in turn, with the clean loans drawn to look like the defects", () => {
    const plans = new Map<string, number>();
    for (const t of heldout)
      plans.set(boardingPlanOf(t.index), (plans.get(boardingPlanOf(t.index)) ?? 0) + 1);
    expect([...plans.keys()].sort()).toEqual([...BOARDING_PLAN_NAMES].sort());
    for (const n of plans.values())
      expect(n).toBe(BOARDING_HELDOUT_SUITE.n / BOARDING_PLAN_NAMES.length);
    let cappedClean = 0;
    let noEscrowClean = 0;
    let planted = 0;
    let clean = 0;
    for (const t of heldout) {
      const defective = new Set(t.labels.map((l) => l.loan));
      planted += t.labels.length;
      for (const row of parseCsv(t.files["boarding_tape.final.csv"])) {
        if (defective.has(row["transferor_loan_number"]!)) continue;
        clean++;
        if (row["late_charge_max"]) cappedClean++;
        if (row["escrowed"] === "N") noEscrowClean++;
      }
    }
    expect(planted).toBe(200);
    expect(clean).toBe(250);
    expect(cappedClean).toBe(120);
    expect(noEscrowClean).toBe(79);
  });

  it("is solved by the reference on the held-out suite, a training suite and the demo loan's packages", async () => {
    for (const tasks of [heldout, train, spec]) {
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

  it("gives floors to read a score against: nothing found, and every Y/N cell checked but no statement read", () => {
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const empty = heldout.map((t) => gradeTriage(t, { findings: [] }));
    expect(empty.filter((g) => g.pass).length).toBe(50);
    expect(Number(mean(empty.map((g) => g.score)).toFixed(3))).toBeLessThan(0.5);
    const codesOnly = heldout.map((t) =>
      gradeTriage(t, {
        findings: expectedTriage(t).findings.filter((f) => f.field === "escrowed"),
      }),
    );
    expect(codesOnly.filter((g) => g.pass).length).toBe(100);
  });

  it("is what the servicing app's own boarding does not catch, run in process on the demo's packages", () => {
    const out = mkdtempSync(join(tmpdir(), "boarding-triage-"));
    const demo = demoLoan(defaultCalibration());
    const dirs = Object.entries(demo.packages).map(([name, pkg]) => {
      const dir = join(out, name);
      mkdirSync(dir);
      for (const f of PACKAGE_FILES) writeFileSync(join(dir, f), pkg.files[f]);
      writeFileSync(join(dir, "manifest.json"), toJsonLine(pkg.manifest));
      return dir;
    });
    const r = spawnSync(
      process.execPath,
      [here("../../../../apps/servicing/scripts/board-life-package.mjs"), "--json", ...dirs],
      { encoding: "utf8" },
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
      }[];
      labels: { defect_id: string; caught: boolean; boarded_as: string }[];
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
  });

  it("pins what a model is told", () => {
    // Any edit to the rulebook or the tools changes what every model is told: bump
    // BOARDING_ENVIRONMENT_VERSION with this pin.
    expect(BOARDING_FINGERPRINT.environment).toMatchInlineSnapshot(`
      {
        "name": "boarding-triage",
        "rulebook_sha256": "6562cd8248cfa478715482cd6a1486a624d557c2d3bdeb8f71fa29d8b5d5e6ba",
        "tools_sha256": "75d39666542187afb706ae72f8121ba72d33c235d7f9a9798ff46ae36c01809e",
        "version": "1.0.0",
      }
    `);
    expect(renderBoardingTask(spec[3]!)).not.toMatch(/D-42|D-03|label|planted/);
    expect(JSON.stringify(boardingPayload(spec[3]!))).not.toContain("sha256");
  });

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump BOARDING_ENVIRONMENT_VERSION, then the pin.
    expect(sha256(heldout.map(toJsonLine).join(""))).toMatchInlineSnapshot(
      `"04e61695598a4299f9e390fee80d0dc59462d8f4b33c33a781213397fb05a0fc"`,
    );
  });

  it("rebuilds a task from its coordinates, and never draws a held-out package into training", () => {
    expect(toJsonLine(generateBoardingTask("train", 7, 17))).toBe(toJsonLine(train[17]));
    const fp = (t: BoardingTask) => sha256(t.files["boarding_tape.final.csv"]);
    const held = new Set(heldout.map(fp));
    expect(train.filter((t) => held.has(fp(t)))).toEqual([]);
    expect(drawsHeldoutStream(heldout[0]!.id)).toBe(true);
    const { attempts } = drawBoardingTask("train", 7, 3);
    expect(attempts).toBeGreaterThanOrEqual(1);
  });
});

/** One staged loan: the clean demo package's, as the writer encodes it and the decoder reads it back. */
function decodeOne() {
  return demoLoan(defaultCalibration()).packages.clean.loans[0]!;
}
