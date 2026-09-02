#!/usr/bin/env node
/**
 * Turn Drew's spreadsheet into the requirement registry.
 *
 * `data/v1-build.csv` is the source of truth for WHAT the product must satisfy.
 * This script is the only thing that reads it, and it emits exactly one file:
 * `packages/requirements/src/generated.ts`.
 *
 * The generated file is committed. That is deliberate — the registry is the
 * spine every other package imports, and a build step that has to run before
 * TypeScript can resolve a type is a build step that will break somebody's
 * editor. `npm run requirements:verify` (wired into `npm run check`, and into
 * CI) regenerates in memory and fails on drift, so the committed copy cannot
 * silently diverge from the sheet.
 *
 * EVERY mapping below is exhaustive and throws on an unrecognised value. When
 * Drew edits the sheet, an added screen, source, condition or timing phrase
 * stops this script rather than landing as a silent default. That is the point:
 * a requirement that quietly maps to "universal" is a requirement we will apply
 * to borrowers it was never meant for.
 *
 *   node scripts/build-requirements.mjs            # write the registry
 *   node scripts/build-requirements.mjs --verify   # fail if it would change
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CSV = resolve(ROOT, "data/v1-build.csv");
const OUT = resolve(ROOT, "packages/requirements/src/generated.ts");

// ── CSV parsing ────────────────────────────────────────────────────────────
// Hand-rolled because the file has quoted fields containing commas and we do
// not want a dependency in a script that runs during `check`.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ── Exhaustive mappings ────────────────────────────────────────────────────
const SCREENS = {
  "1 Property & loan": { id: "property_loan", ordinal: 1 },
  "2 Identity": { id: "identity", ordinal: 2 },
  "3 Credit": { id: "credit", ordinal: 3 },
  "4 Bank": { id: "bank", ordinal: 4 },
  "5 Payroll": { id: "payroll", ordinal: 5 },
  "6 IRS transcript": { id: "irs_transcript", ordinal: 6 },
  "7 Upload fallback": { id: "upload_fallback", ordinal: 7 },
  "8 Decision": { id: "decision", ordinal: 8 },
  "9 Persistent consent": { id: "persistent_consent", ordinal: 9 },
};

const SOURCES = {
  "Borrower input": "borrower_input",
  "Connect: credit (soft pull)": "connect_credit",
  "Connect: bank (12-mo asset report)": "connect_bank",
  "Connect: payroll (consumer-permissioned)": "connect_payroll",
  "Connect: IRS transcript (4506-C)": "connect_irs",
  "E-sign": "esign",
  "Third-party order": "third_party_order",
  "Document upload (fallback)": "document_upload",
  "Derived internally": "derived",
};

const SEVERITIES = {
  "Regulatory violation": "regulatory_violation",
  "Repurchase / unsaleable": "repurchase_unsaleable",
  "Financial loss": "financial_loss",
  "Rework / delay": "rework_delay",
};

const CERTAINTY = {
  No: null,
  "Yes - assets": "assets",
  "Yes - income": "income",
  "Yes - employment": "employment",
};

/**
 * `Applies when` prose → a condition key the engine can evaluate.
 *
 * The key is what `packages/requirements/src/conditions.ts` implements as a
 * predicate over a loan file. Prose is preserved on every requirement so the
 * UI can explain, in Drew's own words, why a requirement is being asked for.
 */
const CONDITIONS = {
  Universal: "universal",
  "Cash-out refinance": "cash_out_refinance",
  "Community property state": "community_property_state",
  "Electronic delivery used": "electronic_delivery",
  "Borrower LEP": "borrower_lep",
  "Refinance only": "refinance",
  "Purchase only": "purchase",
  "Borrowed funds used": "borrowed_funds_used",
  "Prior significant derogatory": "prior_significant_derogatory",
  "Dispute flag on report": "dispute_flag",
  "Deposit exceeds 50% of monthly income": "large_deposit_present",
  "Retirement assets used": "retirement_assets_used",
  "Thin or no credit file": "thin_credit_file",
  "12-month asset verification report available": "asset_report_available",
  "Renter with limited or no mortgage history": "renter_limited_mortgage_history",
  "Wage earner": "wage_earner",
  "Retirement income used": "retirement_income_used",
  "Investment income used": "investment_income_used",
  "OT, bonus or commission present": "variable_income_present",
  "Gap over 30 days in 2 years": "employment_gap",
  "Military borrower": "military_borrower",
  "Self-employed; variable; rental": "self_employed_variable_or_rental",
  "Gift used": "gift_funds_used",
  "Prior bankruptcy": "prior_bankruptcy",
  "Recent derogatory present": "recent_derogatory",
  "Inquiries in last 90 days": "recent_inquiries",
  "SSN mismatch or fraud alert": "ssn_mismatch_or_fraud_alert",
  "Support income used": "support_income_used",
  "RSU or stock comp used": "equity_comp_used",
  "Refi; state or investor requires": "refi_ntb_required",
  "Reserves required": "reserves_required",
  "Seller or lender credits present": "ipc_present",
  "AUS Refer or ineligible": "aus_refer_or_ineligible",
  "Overlays exist for the product": "overlays_exist",
  "Denial or counteroffer": "denial_or_counteroffer",
};

/**
 * `Timing constraint` prose → a structured constraint.
 *
 * Two shapes matter to the engine. `before`/`after` with a `refs` array build
 * the dependency graph that decides what order work can happen in. `deadline`
 * carries a clock the product must actually run — miss one and the failure
 * severity on that row is "Regulatory violation", not a nag.
 */
const TIMING = {
  "Starts 3-business-day LE clock": { kind: "starts_clock", clock: "le_3_business_day" },
  "At application": { kind: "at", event: "application" },
  "At application and before funding": { kind: "at", event: "application_and_before_funding" },
  "Before any verification pull": { kind: "before", event: "any_verification_pull" },
  "Before first electronic disclosure": { kind: "before", event: "first_electronic_disclosure" },
  "Before closing": { kind: "before", event: "closing" },
  "After LE receipt": { kind: "after", event: "le_receipt" },
  "With LE": { kind: "with", event: "le_delivery" },
  "After credit, income and asset intake": { kind: "after", event: "intake_complete" },
  "3 business days from application": {
    kind: "deadline",
    from: "application",
    amount: 3,
    unit: "business_days",
  },
  "Within 30 days of complete application": {
    kind: "deadline",
    from: "complete_application",
    amount: 30,
    unit: "calendar_days",
  },
};

const REQ_ID = /^[A-Z]{2,3}-\d{3}$/;

function parseTiming(prose) {
  if (TIMING[prose]) return { ...TIMING[prose], prose };

  let m = /^Before ([A-Z]{2,3}-\d{3})$/.exec(prose);
  if (m) return { kind: "before", refs: [m[1]], prose };

  m = /^After ([A-Z]{2,3}-\d{3})$/.exec(prose);
  if (m) return { kind: "after", refs: [m[1]], prose };

  m = /^3 business days from ([A-Z]{2,3}-\d{3})$/.exec(prose);
  if (m)
    return {
      kind: "deadline",
      from: "requirement",
      refs: [m[1]],
      amount: 3,
      unit: "business_days",
      prose,
    };

  throw new Error(`Unrecognised timing constraint: ${JSON.stringify(prose)}`);
}

function lookup(map, key, column) {
  if (!(key in map)) {
    throw new Error(
      `Unrecognised ${column}: ${JSON.stringify(key)}\n` +
        `  Add it to scripts/build-requirements.mjs and implement any predicate it needs.`,
    );
  }
  return map[key];
}

// ── Build ──────────────────────────────────────────────────────────────────
const rows = parseCsv(readFileSync(CSV, "utf8"));
const header = rows.findIndex((r) => r[0] === "req_id");
if (header === -1) throw new Error("No req_id header row found in data/v1-build.csv");

const requirements = [];
for (const r of rows.slice(header + 1)) {
  const id = (r[0] ?? "").trim();
  if (!id) continue;
  if (!REQ_ID.test(id)) throw new Error(`Malformed req_id: ${JSON.stringify(id)}`);

  const screen = lookup(SCREENS, (r[1] ?? "").trim(), "Screen");
  requirements.push({
    id,
    family: id.slice(0, id.indexOf("-")),
    screen: screen.id,
    screenOrdinal: screen.ordinal,
    source: lookup(SOURCES, (r[2] ?? "").trim(), "Source"),
    statement: (r[3] ?? "").trim(),
    fields: (r[4] ?? "").trim(),
    // The sheet writes alternative evidence with semicolons; a comma inside a
    // single item ("paystub + W-2 combination") is not a separator.
    evidence: (r[5] ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean),
    condition: lookup(CONDITIONS, (r[6] ?? "").trim(), "Applies when"),
    conditionProse: (r[6] ?? "").trim(),
    dayOneCertainty: lookup(CERTAINTY, (r[7] ?? "").trim(), "Day 1 Certainty"),
    failureSeverity: lookup(SEVERITIES, (r[8] ?? "").trim(), "Failure severity"),
    timing: parseTiming((r[9] ?? "").trim()),
  });
}

// ── Integrity checks ───────────────────────────────────────────────────────
const ids = new Set(requirements.map((r) => r.id));
const dupes = requirements.map((r) => r.id).filter((id, i, a) => a.indexOf(id) !== i);
if (dupes.length) throw new Error(`Duplicate req_ids: ${[...new Set(dupes)].join(", ")}`);

// Timing constraints that point at a requirement this sheet never defines.
// CLS-* is the closing-stage family and lives in a sheet we do not have yet;
// these are recorded rather than thrown so the registry still builds, and
// exposed as `danglingReferences` so nothing pretends the graph is complete.
const dangling = [];
for (const r of requirements) {
  for (const ref of r.timing.refs ?? []) {
    if (!ids.has(ref)) dangling.push({ from: r.id, to: ref });
  }
}

const banner = `// GENERATED by scripts/build-requirements.mjs from data/v1-build.csv.
// Do not edit. Run \`npm run requirements:build\` after changing the sheet.
// \`npm run requirements:verify\` fails if this file and the sheet disagree.`;

const out = `${banner}

import type { Requirement, DanglingReference } from "./types.js";

export const REQUIREMENTS: readonly Requirement[] = ${JSON.stringify(requirements, null, 2)} as const;

/**
 * Timing constraints pointing at requirements no row in this sheet defines.
 * Every one is a CLS-* closing-stage requirement from a sheet that does not
 * exist yet. They are not errors; they are the seam where V1 hands off.
 */
export const DANGLING_REFERENCES: readonly DanglingReference[] = ${JSON.stringify(dangling, null, 2)} as const;
`;

const verify = process.argv.includes("--verify");
if (verify) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    console.error(
      "✗ packages/requirements/src/generated.ts is missing. Run: npm run requirements:build",
    );
    process.exit(1);
  }
  if (current !== out) {
    console.error(
      "✗ generated.ts is out of date with data/v1-build.csv. Run: npm run requirements:build",
    );
    process.exit(1);
  }
  console.log(`✓ ${requirements.length} requirements, registry matches the sheet`);
} else {
  writeFileSync(OUT, out);
  console.log(
    `✓ wrote ${requirements.length} requirements to packages/requirements/src/generated.ts`,
  );
  if (dangling.length) {
    console.log(`  ${dangling.length} dangling reference(s) to undefined requirements:`);
    for (const d of dangling) console.log(`    ${d.from} → ${d.to}`);
  }
}
