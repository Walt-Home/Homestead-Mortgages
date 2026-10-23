#!/usr/bin/env node
/**
 * Board a transfer package the life generator wrote through the servicing
 * app's own boarding, in process, and say for each label whether the gate
 * caught it.
 *
 *   node scripts/board-life-package.mjs                 the demo loan's four packages and one for each defect
 *   node scripts/board-life-package.mjs DIR [DIR ...]   packages already written
 *   node scripts/board-life-package.mjs --json DIR      the report as JSON
 *
 * A package is a directory of the thirteen files and its manifest.json, as
 * `npm run env:transfer-package -w @hm/environments -- --out DIR` writes them.
 * With no directory this writes, to a temporary directory first, the demo
 * loan's (clean, D-42, D-03 and the defective one with both) and one
 * training package for each defect in the life generator's registry, that
 * defect alone on its loan (`--each`).
 *
 * Nothing here is reimplemented and no database is touched. The files go
 * through the servicing app's own `decodeTransferBatch`
 * (src/domain/boarding/tape-codec.ts) and its `BoardingService`
 * (src/domain/boarding/service.ts) over in-memory stores, the way its own
 * demo-batch test runs the sample batch: every file ingested, the loans
 * staged and validated against the package's own trial balance, Fannie Mae
 * position and MERS lookup, and boarded on the transfer date. The
 * correspondence file is ingested as the `correspondence` tape kind the
 * service accepts (service.ts:22) and, like any file the decoder does not
 * name, changes nothing that boards; so do the columns the writer adds after
 * the layout's own.
 *
 * Every label in the manifest is reported, the root of each defect and each
 * symptom the writer found beside it. A label is caught when the gate raised
 * a hard failure or a warning on its loan. For each root the report also says
 * what boarded in the cell's place, read off `loan.boarded` and the staged
 * loan: the escrow flag, the loss-mitigation, bankruptcy and servicemember
 * flags, the ARM's caps, the delinquency boarding derived from the payment
 * history and the balance; and, for the late-charge cap, the mortgage
 * insurance's date and the flood zone, that no package can board one, because
 * the decoder has no field for it. Today it shows what
 * docs/synthetic-data-defects.md says: the gate catches none of the ten.
 *
 * The servicing app's source is TypeScript run as its Dockerfile runs it, with
 * Node's type stripping; on a Node that needs the flag this script re-runs
 * itself with it.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STRIP = "--experimental-strip-types";
if (!process.execArgv.includes(STRIP) && !process.env.HM_BOARD_LIFE_STRIPPED) {
  const r = spawnSync(
    process.execPath,
    [
      STRIP,
      "--disable-warning=ExperimentalWarning",
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: "inherit", env: { ...process.env, HM_BOARD_LIFE_STRIPPED: "1" } },
  );
  process.exit(r.status ?? 1);
}

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(app, "../..");
const load = (path) => import(pathToFileURL(join(app, path)).href);
const { decodeTransferBatch } = await load("src/domain/boarding/tape-codec.ts");
const { BoardingService } = await load("src/domain/boarding/service.ts");
const { FakePositions, batchContext } = await load("src/domain/boarding/fixtures.ts");
const { MemoryEventStore, FixedClock } = await load("src/kernel/events/index.ts");
const { MemoryLedger } = await load("src/kernel/ledger/ledger.ts");

/** The files a package holds, each with the tape kind the boarding service ingests it as. */
const KINDS = {
  "boarding_tape.final.csv": "final",
  "payment_history.csv": "payment_history",
  "escrow_history.csv": "escrow_history",
  "escrow_analysis.csv": "escrow_analysis",
  "lossmit_file.csv": "lossmit",
  "fc_bk_file.csv": "fc_bk",
  "consents_file.csv": "consents",
  "images_manifest.csv": "images_manifest",
  "trial_balance.csv": "trial_balance",
  "correspondence_file.csv": "correspondence",
};
/** The two external positions and the restricted file: read by the decoder, not ingested as tapes. */
const POSITIONS = ["fnma_position.csv", "mers_lookup.csv", "fair_lending.csv"];

/** What boarded in a root's place, read off loan.boarded and the staged loan; null for a symptom. */
function boardedAs(l, x) {
  if (l.root_cause === false) return null;
  if (l.field === "escrowed")
    return `loan.boarded escrowed=${x.boarded_escrowed}${l.produces ? ` (${l.produces})` : ""}`;
  if (l.field === "late_charge_max")
    return `no cap (the decoder reads none); the note's is ${l.true_value}`;
  if (l.field === "lm_in_process")
    return `loan.boarded lossmit_in_process=${x.boarded_lossmit_in_process}, so no case opens, though the details stage (${x.staged_lossmit.application_status}, received ${x.staged_lossmit.received_on})`;
  if (l.field === "bk_active")
    return `loan.boarded bk_active=${x.boarded_bk_active}, the case's details dropped (staged ${JSON.stringify(x.staged_bankruptcy)})`;
  if (l.field === "scra_active") return `loan.boarded scra_active=${x.boarded_scra_active}`;
  if (l.field === "arm_initial_cap_bps")
    return `staged arm.initial_cap_bps=${x.staged_arm_initial_cap_bps}; the note's is ${l.true_value}`;
  if (l.field === "mi_termination_date")
    return "no MI date or value (the decoder reads neither, and loan.boarded carries no MI record)";
  if (l.field === "flood_zone") return "no flood zone (the decoder reads none)";
  if (l.file_or_table === "payment_history.csv" && l.field === "due_date")
    return `loan.boarded ${x.boarded_regx_days_delinquent} days delinquent, the earliest unpaid ${x.boarded_earliest_unpaid}, where the tape's next due date is ${x.staged_next_due_date}`;
  if (l.file_or_table === "payment_history.csv" && l.field === "principal")
    return `the tape's balance, ${x.staged_upb} cents, which keeps the misapplied principal`;
  return null;
}

function board(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const files = Object.fromEntries(
    [...Object.keys(KINDS), ...POSITIONS].map((f) => [f, readFileSync(join(dir, f), "utf8")]),
  );
  const b = manifest.batch;
  const decoded = decodeTransferBatch(files);

  const clock = new FixedClock(`${b.transfer_date}T09:00:00.000Z`);
  const events = new MemoryEventStore(clock);
  const ext = new FakePositions();
  for (const p of decoded.fnma) ext.fnmaRows.set(p.fnma_loan_number, p);
  for (const t of decoded.trialBalance) ext.tb.set(t.transferor_loan_number, t.upb_cents);
  for (const m of decoded.mers) ext.mersRows.set(m.min, m);
  // The fake's license list is the sample's fifteen states; a written package's are licensed too.
  for (const l of decoded.loans) if (l.property.state) ext.licensedStates.add(l.property.state);
  const svc = new BoardingService({
    events,
    ledger: new MemoryLedger(),
    ext,
    clock,
    clearingAccountId: "CUST-CLEARING",
  });
  svc.openBatch(
    batchContext({
      batch_id: b.batch_id,
      transfer_date: b.transfer_date,
      transferor_servicer_number: b.transferor_servicer_number,
      partner_servicer_number: b.partner_servicer_number,
      acceptable_mers_org_ids: new Set([b.partner_mers_org_id, b.transferor_mers_org_id]),
    }),
  );
  const tapes = Object.entries(KINDS).map(([f, kind]) => ({
    file: f,
    kind,
    status: svc.ingestTape(b.batch_id, kind, files[f], files[f].split("\n").length - 2).status,
  }));
  const staged = svc.stage(b.batch_id, decoded.loans);
  svc.validate(b.batch_id);
  const result = svc.board(b.batch_id, { finalTapeReconciled: true });
  const boardedEvents = new Map(
    events.ofType("loan.boarded").map((e) => [e.payload.batch_loan_id, e.payload]),
  );

  const loans = staged.map((bl) => {
    const n = bl.staged.transferor_loan_number;
    const fails = (sev) =>
      bl.validations
        .filter((v) => v.severity === sev && v.result === "fail" && !v.waived)
        .map((v) => v.code);
    const boarded = boardedEvents.get(bl.id);
    const at = (k) => (boarded ? boarded[k] : null);
    return {
      loan: n,
      status: bl.status,
      hard: fails("hard"),
      warnings: fails("warning"),
      boarded_escrowed: at("escrowed"),
      // A staged loan has no late-charge cap field (domain/boarding/types.ts), so nothing a tape carries boards one.
      boarded_late_charge_cap: null,
      // The flags and the 1.7 facts loan.boarded carries (service.ts:357-366).
      boarded_lossmit_in_process: at("lossmit_in_process"),
      boarded_bk_active: at("bk_active"),
      boarded_scra_active: at("scra_active"),
      // The delinquency boarding derives from the payment history, oldest first (service.ts:345-347).
      boarded_regx_days_delinquent: at("regx_days_delinquent"),
      boarded_earliest_unpaid: at("earliest_unpaid_due_date"),
      // What stages from the cells boarding has a field for.
      staged_next_due_date: bl.staged.next_due_date,
      staged_upb: bl.staged.upb_cents,
      staged_bankruptcy: bl.staged.bankruptcy,
      staged_lossmit: bl.staged.lossmit,
      staged_arm_initial_cap_bps: bl.staged.arm ? bl.staged.arm.initial_cap_bps : null,
    };
  });
  const byLoan = new Map(loans.map((l) => [l.loan, l]));
  const labels = manifest.labels.map((l) => {
    const x = byLoan.get(l.loan);
    const caught = x.hard.length > 0 || x.warnings.length > 0;
    return {
      loan: l.loan,
      defect_id: l.defect_id,
      root_cause: l.root_cause !== false,
      file: l.file_or_table,
      field: l.field,
      row: l.row,
      package_says: l.planted_value,
      true_value: l.true_value,
      caught,
      by: [...x.hard, ...x.warnings],
      boarded_as: boardedAs(l, x),
    };
  });
  return {
    package: dir,
    batch_id: b.batch_id,
    transfer_date: b.transfer_date,
    tapes,
    boarded: result.boarded.length,
    refused: result.refused.length,
    loans,
    labels,
    clean: manifest.designed_outcomes.clean.map((n) => ({
      loan: n,
      passed: byLoan.get(n).hard.length === 0,
      ...byLoan.get(n),
    })),
  };
}

const args = process.argv.slice(2);
const json = args.includes("--json");
let dirs = args.filter((a) => a !== "--json");
if (dirs.length === 0) {
  const out = mkdtempSync(join(tmpdir(), "life-packages-"));
  const w = spawnSync("npx", ["tsx", "src/boarding/package-cli.ts", "--out", out, "--each"], {
    cwd: join(repo, "packages/environments"),
    stdio: json ? "ignore" : "inherit",
  });
  if (w.status !== 0) process.exit(w.status ?? 1);
  dirs = readdirSync(out)
    .sort()
    .map((d) => join(out, d));
}
for (const d of dirs)
  if (!existsSync(join(d, "manifest.json"))) {
    console.error(`${d} is not a package: it has no manifest.json`);
    process.exit(2);
  }

const reports = dirs.map((d) => board(resolve(d)));
if (json) {
  console.log(JSON.stringify(reports, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
} else {
  for (const r of reports) {
    console.log(`\n${r.package}  (${r.batch_id}, transfer ${r.transfer_date})`);
    console.log(`  tapes: ${r.tapes.map((t) => `${t.kind} ${t.status}`).join(", ")}`);
    console.log(`  boarded ${r.boarded} of ${r.loans.length}, refused ${r.refused}`);
    for (const l of r.loans)
      console.log(
        `  ${l.loan}: ${l.status}; hard ${l.hard.join(",") || "none"}; warnings ${l.warnings.join(",") || "none"}; boarded escrowed=${l.boarded_escrowed}, ${l.boarded_regx_days_delinquent} days delinquent`,
      );
    if (r.labels.length === 0) console.log("  nothing planted: a clean twin");
    for (const l of r.labels.filter((x) => x.root_cause))
      console.log(
        `  ${l.defect_id} ${l.loan} ${l.file} ${l.field}${l.file === "boarding_tape.final.csv" ? "" : ` ${l.row}`}: the package says ${JSON.stringify(l.package_says)}, the truth is ${JSON.stringify(l.true_value)}; caught: ${l.caught ? `yes (${l.by.join(", ")})` : "no"}; boarded as ${l.boarded_as}`,
      );
    const symptoms = r.labels.filter((x) => !x.root_cause);
    if (symptoms.length)
      console.log(
        `  ${symptoms.length} ${symptoms.length === 1 ? "symptom" : "symptoms"} beside the root (${[...new Set(symptoms.map((x) => `${x.file} ${x.field}`))].join("; ")}); caught: ${symptoms.some((x) => x.caught) ? "yes" : "no"}`,
      );
  }
  const roots = reports.flatMap((r) => r.labels.filter((l) => l.root_cause));
  const ids = [...new Set(roots.map((l) => l.defect_id))].sort();
  console.log(
    `\n${roots.length} planted (${ids.join(", ")}), ${roots.filter((l) => l.caught).length} caught by the gate.`,
  );
}
