/**
 * How a number is said, once, for every screen that says it.
 *
 * Three screens each defined the same money formatter locally, and two of them
 * then named the same engine figure two different things: the bank screen
 * called `ratios.totalQualifyingIncome` "Monthly income" and the review screen
 * called it "Verified income". One borrower's own two screens disagreed about
 * what to call the number their decision turns on. A formatter and a label
 * copied per screen are a formatter and a label that drift per screen.
 *
 * The two labels here are also the two claims on that row of the bank screen,
 * so they are derived together. Each is a statement about a RETRIEVAL — who
 * counted the balances, who worked out the income — and a retrieval that did
 * not happen cannot have established anything. That is why both take the
 * connector's mode from `disclosures.ts` rather than being constants: on a
 * fixture deployment "Verified assets" labels a made-up report, sitting one
 * row from a credit pill that correctly reads "Sample credit".
 */

import { modeOf, type ConnectorMode, type ConnectorModes } from "./disclosures.js";

/** Whole dollars. No screen in this product has a use for the cents. */
export const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

/** What the asset report was able to establish about the income in it. */
export type IncomeConfidence = "verified" | "estimated" | "insufficient";

/** Which retrieval last wrote an income row. `IncomeReportSource` in `@hm/shared`. */
export type IncomeReportSource = "bank" | "payroll";

/**
 * What stands behind `ratios.totalQualifyingIncome` on one file.
 *
 * Four answers rather than two, because the question has two independent ways
 * of going wrong and the old constant got both: "was this retrieved at all"
 * and "did the retrieval establish the income". A fixture answers the first
 * one no, whatever the report it invents says about the second.
 */
export type IncomeBasis = "sample" | "test_mode" | "verified" | "estimated";

/**
 * The rows the engine actually summed, asked what they came from.
 *
 * `totalQualifyingIncome` is "sum of income sources with an established
 * continuance", so those rows — not the bank report — are the figure's
 * provenance, and `LoanFile.qualifyingIncomeReportedBy` is that set already
 * filtered. The distinction is not academic: the payroll route REPLACES what
 * the bank inferred and retires the rest, while `assets` on the file stays
 * pointed at the older bank snapshot. Keyed on that snapshot, a borrower who
 * finished the payroll branch saw employer-reported income called estimated,
 * and the label was reading a report that was no longer the source of the
 * number under it.
 *
 * An empty list is the window between a bank pull returning and the file query
 * refetching. The report in hand is then the only thing behind the figure, so
 * the bank is who to ask about — which is also what the label did before any
 * of this.
 */
export function incomeBasis(args: {
  /** `qualifyingIncomeReportedBy`, one entry per row the engine summed. */
  readonly reportedBy: readonly (IncomeReportSource | null)[] | undefined;
  /** The asset report in hand, for what the BANK established about income. */
  readonly assets: unknown;
  readonly modes: ConnectorModes | null | undefined;
}): IncomeBasis {
  const said = args.reportedBy ?? [];
  // A row naming no income pull — its snapshot gone, or a kind that carries no
  // income — is read as the bank's: the weaker of the two answers, and the one
  // that cannot overclaim.
  const reporters: readonly IncomeReportSource[] = said.length
    ? [...new Set(said.map((r) => r ?? "bank"))]
    : ["bank"];

  const modes = reporters.map((r) => modeOf(args.modes, r));
  if (modes.includes("fixture")) return "sample";
  if (modes.includes("sandbox")) return "test_mode";
  // Payroll is the employer's own report, and the engine counted these rows,
  // so there is nothing left to qualify. The bank's is only ever as good as
  // what the report itself said it established — Plaid runs in Assets mode,
  // where `toAssetReport` says in its own words that it never produces the
  // verified answer. Anything that is not that answer, an absent one included,
  // is estimated: not knowing is not permission to claim the good one.
  if (reporters.includes("bank")) {
    return incomeConfidenceOf(args.assets) === "verified" ? "verified" : "estimated";
  }
  return "verified";
}

/**
 * `ratios.totalQualifyingIncome`, said according to what stands behind it.
 *
 * This was a constant reading "Verified income", and the argument written
 * under it was that the engine counts only income sources a retrieval
 * established a continuance for. That is a claim about the retrieval, and
 * nothing checked it — neither that the retrieval said so nor that it ever
 * happened.
 *
 * "Estimated" rather than a softer wording of the other word, because it has
 * to survive being read next to the assets label on the same row of the same
 * screen. Balances come off the accounts; income is worked out from what went
 * into them, and a borrower is entitled to see which of the two they are
 * looking at.
 */
export function qualifyingIncomeLabel(basis: IncomeBasis): string {
  if (basis === "sample") return "Sample income";
  if (basis === "test_mode") return "Test-mode income";
  return basis === "verified" ? "Verified income" : "Estimated income";
}

/**
 * The balances, said according to who counted them.
 *
 * Its row-mate above got the whole argument and this one was left a literal,
 * on the reasoning that balances ARE what the accounts evidence. True of a
 * Plaid deployment and false of this one: the fixture's accounts evidence
 * nothing, and "Verified assets" over an invented total is the same sentence
 * the income label was just stopped from writing.
 */
export function assetsLabel(mode: ConnectorMode): string {
  if (mode === "fixture") return "Sample assets";
  if (mode === "sandbox") return "Test-mode assets";
  return "Verified assets";
}

/**
 * What the bank does to income, for the two screens that say it.
 *
 * Screen 1 asks for a rough figure and screen 4 explains what connecting reads,
 * and both used to promise that we VERIFY what a borrower earns. Assets mode
 * has no income product; income is inferred from recurring deposits. One export
 * so the two screens cannot drift apart again, and so what they promise matches
 * the word `qualifyingIncomeLabel` puts on the number that comes out.
 */
export const INCOME_WORKED_OUT_FROM_BANK =
  "work out what you earn from what goes into your accounts";

/**
 * The confidence off whatever the file is carrying as its asset report.
 *
 * `LoanFileView.assets` is `unknown` — it is the connector's own domain object
 * handed through, and the web app has never had a type for it. Reading one
 * field out of it belongs here rather than in each screen, so that the two
 * screens rendering this label cannot disagree about what counts as verified.
 */
export function incomeConfidenceOf(assets: unknown): IncomeConfidence | null {
  const value = (assets as { incomeConfidence?: unknown } | null | undefined)?.incomeConfidence;
  return value === "verified" || value === "estimated" || value === "insufficient" ? value : null;
}

export const qualifyingIncome = (n: number) => `${money(n)}/mo`;
