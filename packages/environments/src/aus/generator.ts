/**
 * Synthetic loan files, seeded: no borrower's data, ever.
 *
 * Each task is a function of (split, suite seed, index). A file is made the
 * way an underwriter receives one: one or two borrowers with their own
 * credit reports, asset reports and, sometimes, tax transcripts; the
 * household's income; a property; a loan on it, priced on the eighth grid
 * against the week its rate was set; and on a refinance the loan it pays
 * off. The lender's two estimates are the engine's own figures for that
 * loan (`housingPitia`, and the fee schedule's total). Then the file is
 * aimed, in turn by index, at one edge of the decision:
 *   - standard: a purchase or a refinance, nothing aimed;
 *   - ltv_eighty: a loan of exactly 80% of value, and one a dollar or more
 *     over it that still shows 80.00, where the APR is refused;
 *   - ltv_maximum: exactly at each maximum (97, 90, 85, 95 with a
 *     non-occupant co-borrower, 97 on a refinance) and a hundredth over it;
 *   - dti: the back-end ratio at 45.00, at 45.01 and at 50.00, with joint
 *     debts, excluded payments and income whose continuance is pending;
 *   - scores: three, two and one bureau scores, a low bureau the middle
 *     score passes over, an own score at 620, two borrowers whose average
 *     lands on a half, and a report with no scores;
 *   - seasoning: each minimum (24, 48, 84) met and missed by a month,
 *     discharge falling back to filing, an older record that decides behind
 *     a later one, and records on the co-borrower's report;
 *   - rate_set: late Sunday in New York, the year's first and the table's
 *     last days, an adjustable rate, a 25-year term, a prepayment penalty;
 *   - price_tests: spreads just under the HPML line and each General QM
 *     threshold, at the tier bounds, the jumbo line and on manufactured
 *     homes, second homes and investment properties;
 *   - small_loan: the $37,307.23 line where the flat fees make a primary
 *     loan high-cost, and the second home's points-and-fees counteroffer;
 *   - ntb: a refinance's scheduled payment, a saving of nothing, and the
 *     recoup at 60.0 and 60.1 months;
 *   - reserves: second homes, investment properties and extra financed
 *     properties at their requirement and a tenth under it, retirement at
 *     60%, joint and unused accounts;
 *   - ipc: contributions exactly at each cap and a hundredth over it, and
 *     the 75% and 90% band lines;
 *   - transcripts: the variance at 10.00 and 10.01 either way, two
 *     borrowers' latest years, and a borrower without one;
 *   - missing: a borrower without a credit report, no asset reports, no
 *     established income, and a wage earner with no base wage.
 *
 * What v1 leaves out is in docs/environments.md; `ausInScope` runs on the
 * engine's own derivations and keeps a file only outside every region where
 * the engine raises a question of policy. A file is then kept only once the
 * reference, working through the tools, lands exactly where the engine does;
 * the tests hold both to zero misses on unfiltered draws.
 */

import {
  DerivationLog,
  FEE_SCHEDULE,
  annualPercentageRate,
  closingCosts,
  housingPitia,
  lookupApor,
} from "@hm/underwriting";
import { addDays, addMonths, parts, plainDate, ymd, type PlainDate } from "@hm/kernel/calendar";
import { levelPaymentPct, monthsBetween } from "@hm/refi-review";
import { rngFor, type Rng } from "../rng.js";
import { solveNow } from "../refi/reference.js";
import type { Split } from "../refi/task.js";
import { FROZEN_APOR_TABLE } from "./apor-frozen.js";
import {
  BLOCKABLE,
  FINDING_CODES,
  analyzeAus,
  derivation,
  expectedAus,
  fileOf,
  gradeAusAgainst,
  parseAusSubmission,
  type AusAnalysis,
} from "./grader.js";
import { ausSteps } from "./reference.js";
import {
  AUS_ENVIRONMENT_NAME,
  AUS_ENVIRONMENT_VERSION,
  ausPayload,
  type Account,
  type AusBorrower,
  type AusTask,
  type Bureau,
  type ExistingLoan,
  type IncomeSource,
  type IncomeType,
  type Occupancy,
  type PropertyType,
  type PublicRecord,
  type Tradeline,
  type TradelineType,
} from "./task.js";
import { executeAusTool } from "./tools.js";

export const ausTaskId = (split: Split, suiteSeed: number, index: number): string =>
  `${AUS_ENVIRONMENT_NAME}/${AUS_ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

export const AUS_EDGES = [
  "standard",
  "ltv_eighty",
  "ltv_maximum",
  "dti",
  "scores",
  "seasoning",
  "rate_set",
  "price_tests",
  "small_loan",
  "ntb",
  "reserves",
  "ipc",
  "transcripts",
  "missing",
] as const;
export type AusEdge = (typeof AUS_EDGES)[number];
export const ausEdgeOf = (index: number): AusEdge => AUS_EDGES[index % AUS_EDGES.length]!;

/* ── exact arithmetic, in cents and rationals ─────────────────────────── */

const cents = (dollars: number): bigint => BigInt(Math.round(dollars * 100));
const floorDiv = (a: bigint, b: bigint): bigint => {
  const q = a / b;
  return q * b > a ? q - 1n : q;
};
/** n ÷ d (d > 0) rounded half up to `places`, scaled by 10^places, and whether it was a tie. */
export function roundedExactly(
  n: bigint,
  d: bigint,
  places: number,
): { scaled: bigint; tie: boolean } {
  const x = n * 10n ** BigInt(places);
  const q = floorDiv(x, d);
  const twice = 2n * (x - q * d);
  return { scaled: twice >= d ? q + 1n : q, tie: twice === d };
}
/** The sign of n ÷ d − line, with line a decimal string. */
function versus(n: bigint, d: bigint, line: string): number {
  const neg = line.startsWith("-");
  const [i, f = ""] = (neg ? line.slice(1) : line).split(".");
  const den = 10n ** BigInt(f.length);
  const num = BigInt(`${i}${f}`) * (neg ? -1n : 1n);
  const diff = n * den - num * d;
  return diff > 0n ? 1 : diff < 0n ? -1 : 0;
}
const scaledOf = (x: number, places: number): bigint => BigInt(Math.round(x * 10 ** places));

/* ── the guard ────────────────────────────────────────────────────────── */

const WAGE: readonly IncomeType[] = ["base_wage", "overtime", "bonus", "commission"];
const VARIABLE: readonly IncomeType[] = [
  "overtime",
  "bonus",
  "commission",
  "self_employment",
  "rental",
];
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONFORMING_LIMIT = 83_275_000;
const HIGH_BALANCE_LIMIT = 124_912_500;

const tradelineKey = (t: Tradeline) =>
  `${t.creditor.trim().toLowerCase()}|${t.type}|${t.opened_on}`;
const accountKey = (a: Account) => `${a.institution.trim().toLowerCase()}|${a.type}|${a.mask}`;

/** Each key seen twice must be one joint item: identical, on two borrowers' reports. */
function sharedKeysAreJoint<T>(
  items: readonly { readonly owner: number; readonly item: T }[],
  key: (x: T) => string,
): boolean {
  const seen = new Map<string, { owner: number; item: T }[]>();
  for (const x of items) seen.set(key(x.item), [...(seen.get(key(x.item)) ?? []), x]);
  for (const group of seen.values()) {
    if (group.length === 1) continue;
    if (new Set(group.map((g) => g.owner)).size !== group.length) return false;
    const first = JSON.stringify(group[0]!.item);
    if (group.some((g) => JSON.stringify(g.item) !== first)) return false;
  }
  return true;
}

/** The figure a derivation input names, in whole cents. */
const inCents = (d: AusAnalysis["decision"], id: string, label: string, input: string) =>
  cents(derivation(d, id, label)!.inputs[input] as number);

/**
 * v1's guard: the reason a file is out of scope, or null when it is in.
 *
 * It runs on the task and on the engine's own derivations, and keeps a file
 * only where the engine does nothing its own documents question
 * (docs/decisions.md, "Seasoning is counted in UTC, and the record that
 * decides is the one tested") and nothing turns on a reading the rulebook
 * cannot state as the engine does. Each clause names what it keeps out:
 *   - a borrower's own score under 620: a score under the minimum is never
 *     made ineligible, and is referred only through the illustrative pricing
 *     grid's floor;
 *   - a back-end ratio over 50 (exactly or as rounded): the engine's
 *     maximum is a finding of the income category, not of eligibility;
 *   - eligible assets short of the funds to close, or funds to close below
 *     zero: the engine never compares the two, and a refinance's cash back
 *     is added to its reserves;
 *   - a non-QM or higher-priced result: neither raises a finding;
 *   - a refinance of a second home or investment property: the maximum LTV
 *     on a refinance ignores occupancy;
 *   - a household with no wage income: INC-004 blocks every file without a
 *     base wage, where the sheet scopes it to wage earners;
 *   - transcripts on a household with no variable, self-employed or rental
 *     income: the sheet scopes INC-009 to those, the engine runs it on
 *     everyone;
 *   - asset reports from some borrowers and not others: ability to repay
 *     reads Borrower 1's report, not the household's;
 *   - (every refinance is one whose investor requires a net tangible
 *     benefit: the engine tests it on all of them, the sheet where a state
 *     or investor requires it; the rulebook states the requirement);
 *   - a bright line (the back-end ratio at 45 and 50, LTV against its
 *     maximum and the 75 and 90 bands, the contribution cap, the transcript
 *     variance at 10, the reserve months, the 60-month recoup) where the
 *     rounded figure and the exact one fall on different sides, and any
 *     figure the engine rounds that lands exactly on a half, where binary
 *     rounding and decimal rounding part;
 *   - a seasoning record dated on the 1st or after the decision's day of
 *     the month, where counting calendar months and counting whole months
 *     part, and two records of one kind with the same margin or date;
 *   - two different tradelines or accounts sharing the key a joint one is
 *     known by;
 *   - a two-to-four-unit property over 75% or a manufactured home over 80%,
 *     a loan over the conforming limit above 80% or over the high-balance
 *     limit, and junior liens over the maximum: the engine's maximum reads
 *     purpose and occupancy alone, and tests the first lien alone;
 *   - junior liens on a purchase: funds to close takes no second lien's
 *     proceeds;
 *   - a finding or a blocked requirement the rulebook does not name.
 */
export function ausOutOfScope(
  task: AusTask,
  analyze: (t: AusTask) => AusAnalysis = analyzeAus,
): string | null {
  if (!INSTANT.test(task.decided_at) || !INSTANT.test(task.product.rate_set_at))
    return "an instant not written as YYYY-MM-DDTHH:MM:SS.sssZ";
  const borrowers = task.borrowers;
  if (borrowers.length < 1 || borrowers.length > 2) return "one or two borrowers";
  if (task.loan.purpose !== "purchase" && task.property.occupancy !== "primary_residence")
    return "a refinance of a second home or investment property";
  if (task.loan.purpose === "purchase" && task.loan.existing_loan !== null)
    return "a purchase with a loan to pay off";
  if (task.loan.purpose !== "purchase" && task.loan.existing_loan === null)
    return "a refinance with no loan to pay off";
  if (
    task.loan.purpose === "purchase" &&
    task.loan.junior_lien_balance_cents + task.loan.junior_lien_credit_limit_cents > 0
  )
    return "junior liens on a purchase";
  for (const b of borrowers) {
    if (!b.credit || b.credit.scores.length === 0) continue;
    const sorted = b.credit.scores.map((s) => s.score).sort((x, y) => x - y);
    if ((sorted.length >= 3 ? sorted[1]! : sorted[0]!) < 620 || sorted.length > 3)
      return "an own score under 620";
  }
  const types = task.income_sources.map((s) => s.type);
  if (!types.some((t) => WAGE.includes(t))) return "a household with no wage income";
  if (borrowers.every((b) => b.transcripts.length > 0) && !types.some((t) => VARIABLE.includes(t)))
    return "transcripts on a household with no variable, self-employed or rental income";
  for (const b of borrowers)
    if (new Set(b.transcripts.map((t) => t.tax_year)).size !== b.transcripts.length)
      return "two transcripts for one tax year";
  const withAssets = borrowers.filter((b) => b.assets !== null).length;
  if (withAssets !== 0 && withAssets !== borrowers.length)
    return "asset reports from some borrowers and not others";
  for (const b of borrowers)
    for (const a of b.assets?.accounts ?? [])
      if ((a.type === "retirement") !== (a.vested_balance_cents !== null))
        return "a vested balance on an account that is not a retirement account, or none on one that is";

  // Seasoning: whole months and calendar months agree, and no record ties another.
  const decidedOn = plainDate(task.decided_at.slice(0, 10));
  const day = parts(decidedOn).d;
  const records = borrowers.flatMap((b) => b.credit?.public_records ?? []);
  const measured = records.map((r) => {
    const reference = r.type === "bankruptcy" ? (r.discharged_on ?? r.date) : r.date;
    const minimum =
      r.type === "bankruptcy" ? (r.chapter === "13" ? 24 : 48) : r.type === "foreclosure" ? 84 : 48;
    return { r, reference, minimum, kind: r.type === "bankruptcy" ? "b" : "d" };
  });
  for (const m of measured) {
    if (![m.r.date, m.r.discharged_on ?? m.r.date].every((x) => DATE.test(x)))
      return "a record date not written as YYYY-MM-DD";
    const d = parts(plainDate(m.reference)).d;
    if (d < 2 || d > day) return "a seasoning record dated on the 1st or after the decision's day";
    if (m.reference > decidedOn) return "a seasoning record after the decision";
    if (m.r.discharged_on !== null && m.r.discharged_on < m.r.date)
      return "a discharge before its filing";
    if (m.r.type !== "bankruptcy" && (m.r.chapter !== null || m.r.discharged_on !== null))
      return "a chapter or discharge on a record that is not a bankruptcy";
  }
  for (const kind of ["b", "d"]) {
    const xs = measured.filter((m) => m.kind === kind);
    const margins = xs.map((m) => monthsBetween(plainDate(m.reference), decidedOn) - m.minimum);
    if (
      new Set(margins).size !== xs.length ||
      new Set(xs.map((m) => m.reference)).size !== xs.length
    )
      return "two seasoning records of one kind with the same margin or date";
  }
  if (
    !sharedKeysAreJoint(
      borrowers.flatMap((b, owner) =>
        (b.credit?.tradelines ?? []).map((item) => ({ owner, item })),
      ),
      tradelineKey,
    ) ||
    !sharedKeysAreJoint(
      borrowers.flatMap((b, owner) => (b.assets?.accounts ?? []).map((item) => ({ owner, item }))),
      accountKey,
    )
  )
    return "two different tradelines or accounts sharing one key";

  // The collateral the engine's maximum does not read.
  const loan = BigInt(task.loan.amount_cents);
  const value = BigInt(task.property.value_cents);
  if (task.property.type === "two_to_four_unit" && loan * 100n > value * 75n)
    return "a two-to-four-unit property over 75%";
  if (task.property.type === "manufactured" && loan * 100n > value * 80n)
    return "a manufactured home over 80%";
  if (loan > BigInt(CONFORMING_LIMIT) && loan * 100n > value * 80n)
    return "a loan over the conforming limit above 80%";
  if (loan > BigInt(HIGH_BALANCE_LIMIT)) return "a loan over the high-balance limit";

  // The engine's own derivations.
  let x: AusAnalysis;
  try {
    x = analyze(task);
  } catch (e) {
    return `the engine refused the file: ${e instanceof Error ? e.message : String(e)}`;
  }
  const d = x.decision;
  if (d.compliance.qmStatus === "non_qm") return "a non-QM result";
  if (d.compliance.isHpml === true) return "a higher-priced result";
  const maxLtv = x.maxLtv!;
  const line = value * BigInt(maxLtv);
  const junior = BigInt(task.loan.junior_lien_credit_limit_cents);
  if ((loan + junior) * 100n > line && loan * 100n <= line) return "junior liens over the maximum";

  /** A figure the engine rounded: the same as exact half-up, and not a tie. */
  const sameRounding = (engine: number, n: bigint, den: bigint, places: number) => {
    const exact = roundedExactly(n, den, places);
    return !exact.tie && exact.scaled === scaledOf(engine, places);
  };
  /** A bright line the rounded figure and the exact one fall on the same side of. */
  const sameSide = (engineAbove: boolean, n: bigint, den: bigint, line: string, orEqual = false) =>
    engineAbove === (orEqual ? versus(n, den, line) >= 0 : versus(n, den, line) > 0);

  const pitia = cents(d.ratios.housingPitia!);
  // Debt-to-income.
  if (d.ratios.dtiFront !== null) {
    const income = inCents(d, "UW-004", "Front-end DTI", "total_qualifying_income");
    if (!sameRounding(d.ratios.dtiFront, pitia * 100n, income, 2))
      return "a front-end ratio on a half";
  }
  if (d.ratios.dtiBack !== null) {
    const back = derivation(d, "UW-004", "Back-end DTI")!;
    const n =
      (cents(back.inputs["housing_PITIA"] as number) +
        cents(back.inputs["monthly_liabilities"] as number)) *
      100n;
    const den = cents(back.inputs["total_qualifying_income"] as number);
    if (!sameRounding(d.ratios.dtiBack, n, den, 2)) return "a back-end ratio on a half";
    if (d.ratios.dtiBack > 50 || versus(n, den, "50") > 0) return "a back-end ratio over 50";
    if (!sameSide(d.ratios.dtiBack > 45, n, den, "45"))
      return "a back-end ratio whose rounding crosses 45";
  }
  // Loan-to-value, the maximum and the contribution bands.
  for (const [label, extra] of [
    ["LTV", 0n],
    ["CLTV", BigInt(task.loan.junior_lien_balance_cents)],
    ["HCLTV", BigInt(task.loan.junior_lien_credit_limit_cents)],
  ] as const) {
    const v = derivation(d, "UW-005", label)!.value as number;
    if (!sameRounding(v, (loan + extra) * 100n, value, 2)) return `a ${label} on a half`;
  }
  const ltv = d.ratios.ltv!;
  if (!sameSide(ltv > maxLtv, loan * 100n, value, String(maxLtv)))
    return "an LTV whose rounding crosses its maximum";
  if (
    !sameSide(ltv >= 90.01, loan * 100n, value, "90") ||
    !sameSide(ltv >= 75.01, loan * 100n, value, "75")
  )
    return "an LTV whose rounding crosses a contribution band";
  const ipc = derivation(d, "AST-016", "Interested party contributions")!;
  const ipcN = BigInt(task.loan.interested_party_contributions_cents) * 100n;
  if (!sameRounding(ipc.value as number, ipcN, value, 2)) return "a contribution ratio on a half";
  if (
    !sameSide(
      (ipc.value as number) > (ipc.inputs["cap_percent"] as number),
      ipcN,
      value,
      String(ipc.inputs["cap_percent"]),
    )
  )
    return "a contribution ratio whose rounding crosses its cap";
  // The transcript variance.
  const variance = derivation(d, "INC-009", "Transcript reconciliation");
  if (variance) {
    const annual = cents(variance.inputs["documented_annual_income"] as number);
    const wages = cents(variance.inputs["transcript_wages"] as number);
    const v = variance.value as number;
    if (!sameRounding(v, (annual - wages) * 100n, wages, 2))
      return "a transcript variance on a half";
    if (
      !sameSide(v > 10, (annual - wages) * 100n, wages, "10") ||
      !sameSide(v < -10, (wages - annual) * 100n, wages, "10")
    )
      return "a transcript variance whose rounding crosses 10";
  }
  // Funds and reserves.
  const funds = cents(derivation(d, "AST-002", "Funds to close")!.value as number);
  if (funds < 0n) return "funds to close below zero";
  const post = derivation(d, "AST-004", "Eligible post-close assets");
  if (post && !post.blockedBy?.length) {
    const eligible = cents(post.inputs["eligible_assets"] as number);
    if (eligible < funds) return "eligible assets short of the funds to close";
    const actual = d.reserves.actualMonths!;
    if (!sameRounding(actual, eligible - funds, pitia, 1)) return "reserve months on a half";
    if (
      !sameSide(
        actual >= d.reserves.requiredMonths!,
        eligible - funds,
        pitia,
        String(d.reserves.requiredMonths),
        true,
      )
    )
      return "reserve months whose rounding crosses the requirement";
  }
  // The recoup.
  const ntb = d.compliance.netTangibleBenefit;
  if (ntb?.recoupMonths !== null && ntb?.recoupMonths !== undefined) {
    const closing = BigInt(task.lender_estimates.closing_costs_cents);
    const saving = cents(ntb.paymentDelta);
    if (!sameRounding(ntb.recoupMonths, closing, saving, 1)) return "a recoup on a half";
    if (!sameSide(ntb.recoupMonths > 60, closing, saving, "60"))
      return "a recoup whose rounding crosses 60 months";
  }
  // Last, what nothing above has named.
  const codes = (d.aus?.findings ?? []).map((f) => f.code);
  if (codes.some((c) => !(FINDING_CODES as readonly string[]).includes(c)))
    return "a finding the rulebook does not name";
  const blocked = d.derivations.filter((v) => v.blockedBy?.length).map((v) => v.requirementId);
  if (blocked.some((b) => !(BLOCKABLE as readonly string[]).includes(b)))
    return "a blocked requirement the rulebook does not name";
  return null;
}

export const ausInScope = (task: AusTask, analyze?: (t: AusTask) => AusAnalysis): boolean =>
  ausOutOfScope(task, analyze) === null;

/** Whether the rulebook followed through the tools lands exactly where the engine does. */
export function ausFairToGrade(task: AusTask): boolean {
  const payload = JSON.parse(JSON.stringify(ausPayload(task))) as Record<string, unknown>;
  let byRules: unknown;
  try {
    byRules = solveNow(ausSteps, payload, executeAusTool);
  } catch {
    return false;
  }
  const parsed = parseAusSubmission(byRules);
  return (
    parsed.ok &&
    gradeAusAgainst(expectedAus(task), parsed.answer, task.loan.purpose !== "purchase").pass
  );
}

/* ── the pieces of a file ─────────────────────────────────────────────── */

const FIRST_NAMES = [
  "Avery",
  "Jordan",
  "Morgan",
  "Riley",
  "Casey",
  "Quinn",
  "Rowan",
  "Sage",
  "Emerson",
  "Hayden",
  "Parker",
  "Reese",
  "Dakota",
  "Skyler",
  "Finley",
  "Harper",
  "Kendall",
  "Logan",
  "Marlowe",
  "Noel",
];
const LAST_NAMES = [
  "Ashdown",
  "Brightwater",
  "Calloway",
  "Delacroix",
  "Ellery",
  "Fairbanks",
  "Galloway",
  "Hartwell",
  "Ingram",
  "Juniper",
  "Kingsley",
  "Lockhart",
  "Merriweather",
  "Northcott",
  "Oakhurst",
  "Pemberton",
];
const CREDITORS: Readonly<Record<TradelineType, readonly string[]>> = {
  revolving: [
    "Northfield Card Services",
    "Lakeside Rewards Visa",
    "Copperline Card",
    "Bluewater Mastercard",
  ],
  auto: ["Harbor Auto Finance", "Ridgeway Motor Credit", "Summit Auto Lending"],
  student: ["Cardinal Student Loans", "Pinecrest Education Finance"],
  installment: ["Meadowbrook Personal Loans", "Tidewater Installment Credit"],
  mortgage: ["Granite Home Loans", "Westfield Mortgage Servicing", "Prairie Lending"],
  heloc: ["Keystone Equity Line", "Redwood Bank HELOC"],
};
const BANKS = [
  "First Prairie Bank",
  "Coastline Credit Union",
  "Granite Trust",
  "Meridian Savings",
  "Harborview Bank",
];
const BROKERS = ["Redwood Brokerage", "Lakeshore Investments"];
const PLANS = ["Keystone 401(k) Plan", "Summit Retirement Trust"];
const BUREAUS: readonly Bureau[] = ["equifax", "experian", "transunion"];

/** Whole dollars from lo to hi, in cents. */
const dollars = (r: Rng, lo: number, hi: number) => r.int(lo, hi) * 100;
const at = (day: PlainDate, h: number, m: number) =>
  `${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
const openedOn = (r: Rng) => ymd(r.int(2012, 2025), r.int(1, 12), r.int(2, 28));

/** A date k months before `on`, on a day of the month from the 2nd to `on`'s own. */
function monthsBefore(r: Rng, on: PlainDate, k: number): PlainDate {
  const { y, m } = parts(addMonths(plainDate(`${on.slice(0, 7)}-01`), -k));
  return ymd(y, m, r.int(2, parts(on).d));
}

type MutableCredit = {
  scores: { bureau: Bureau; score: number }[];
  tradelines: Mutable<Tradeline>[];
  public_records: PublicRecord[];
};
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** A mutable draft of the task, before the lender's estimates. */
interface Draft {
  rate_set_at: string;
  decided_at: string;
  borrowers: {
    name: string;
    occupies_property: boolean;
    credit: MutableCredit | null;
    assets: { accounts: Account[] } | null;
    transcripts: { tax_year: number; wages_cents: number }[];
  }[];
  income: Mutable<IncomeSource>[];
  property: Mutable<AusTask["property"]>;
  loan: Mutable<Omit<AusTask["loan"], "existing_loan">> & { existing_loan: ExistingLoan | null };
  product: Mutable<Omit<AusTask["product"], "rate_set_at">>;
}

function taskOf(draft: Draft, id: string, split: Split, suiteSeed: number, index: number): AusTask {
  const bare: AusTask = {
    id,
    split,
    suite_seed: suiteSeed,
    index,
    decided_at: draft.decided_at,
    borrowers: draft.borrowers.map((b): AusBorrower => ({
      name: b.name,
      occupies_property: b.occupies_property,
      credit: b.credit
        ? {
            scores: b.credit.scores.map((s) => ({ ...s })),
            tradelines: b.credit.tradelines.map((t) => ({ ...t })),
            public_records: b.credit.public_records.map((p) => ({ ...p })),
          }
        : null,
      assets: b.assets ? { accounts: b.assets.accounts.map((a) => ({ ...a })) } : null,
      transcripts: b.transcripts.map((t) => ({ ...t })),
    })),
    income_sources: draft.income.map((s) => ({ ...s })),
    property: { ...draft.property },
    loan: {
      ...draft.loan,
      existing_loan: draft.loan.existing_loan ? { ...draft.loan.existing_loan } : null,
    },
    product: { ...draft.product, rate_set_at: draft.rate_set_at },
    lender_estimates: { housing_payment_cents: 0, closing_costs_cents: 0 },
  };
  return { ...bare, lender_estimates: estimatesOf(bare) };
}

/** The engine's own housing payment and fee-schedule total for the loan, which the task gives as the lender's. */
export function estimatesOf(task: AusTask): AusTask["lender_estimates"] {
  const pitia = housingPitia(fileOf(task), new DerivationLog());
  const costs = closingCosts(FEE_SCHEDULE, task.loan.amount_cents / 100);
  if (pitia === null || costs === null) throw new RangeError(`${task.id}: no estimates`);
  return {
    housing_payment_cents: Number(cents(pitia)),
    closing_costs_cents: Number(cents(costs.total)),
  };
}

const closingOf = (loanCents: number) =>
  Number(cents(closingCosts(FEE_SCHEDULE, loanCents / 100)!.total));
/** Points and fees (and the prepaid finance charges) on the production schedule, in cents. */
const pointsAndFeesOf = (loanCents: number) =>
  Number(cents(closingCosts(FEE_SCHEDULE, loanCents / 100)!.pointsAndFees));

/* ── the rate ─────────────────────────────────────────────────────────── */

/** The APOR for the week the rate was set in New York, if the table holds it. */
function aporFor(rateSetAt: string, term: number): number | null {
  const found = lookupApor(FROZEN_APOR_TABLE, new Date(rateSetAt), term, "Fixed");
  return found.found ? found.rate : null;
}

/** The spread, in thousandths, of a note rate's APR over the APOR. */
function spreadMilli(loanCents: number, note: number, term: number, apor: number): number | null {
  const apr = annualPercentageRate({
    loanAmount: loanCents / 100,
    noteRate: note,
    termMonths: term,
    amortization: "Fixed",
    prepaidFinanceCharges: pointsAndFeesOf(loanCents) / 100,
    mortgageInsuranceApplies: false,
  });
  return apr.computed ? Math.round(apr.apr * 1000) - Math.round(apor * 1000) : null;
}

/**
 * A note rate on the eighth grid: the one whose spread is nearest `aim`
 * among those strictly under `under` (both in thousandths), or, where no
 * spread can be measured, one near the market.
 */
function noteRateFor(r: Rng, d: Draft, aim: number, under: number): string {
  const term = d.product.term_months;
  const apor = aporFor(d.rate_set_at, term);
  const measured =
    apor !== null &&
    d.product.amortization === "Fixed" &&
    BigInt(d.loan.amount_cents) * 100n <= BigInt(d.property.value_cents) * 80n;
  if (!measured) {
    const market = aporFor(d.rate_set_at, 360) ?? 6.5;
    return (Math.round((market + r.int(-6, 8) / 8) * 8) / 8).toFixed(3);
  }
  let best: { note: number; gap: number } | null = null;
  for (let e = Math.round((apor - 3) * 8); e <= Math.round((apor + 7) * 8); e++) {
    const note = e / 8;
    if (note < 2.5) continue;
    const s = spreadMilli(d.loan.amount_cents, note, term, apor);
    if (s === null || s >= under) continue;
    const gap = Math.abs(s - aim);
    if (!best || gap < best.gap) best = { note, gap };
  }
  if (!best) throw new RangeError("no note rate on the grid reaches under the line");
  return best.note.toFixed(3);
}

/* ── the base file ───────────────────────────────────────────────────── */

/** What an edge's case asks of the file before anything else is drawn. */
interface Shape {
  purpose?: "purchase" | "rate_term_refinance";
  occupancy?: Occupancy;
  type?: PropertyType;
  borrowers?: 1 | 2;
  /** The LTV in hundredths of a percent (9700 is 97.00%), before any aim. */
  ltvBp?: number;
  value?: number;
  loan?: number;
  term?: number;
  amortization?: "Fixed" | "AdjustableRate";
  /** The spread aimed at and the line it stays strictly under, in thousandths. */
  spread?: { aim: number; under: number };
  rateSetAt?: string;
  penalty?: boolean;
  nonOccupant?: boolean;
  /** The back-end ratio aimed at: exact bounds, both included, in hundredths of a percent. */
  dti?: readonly [number, number];
  /** Reserve months past the requirement aimed at: exact bounds [lo, hi), in hundredths of a month. */
  months?: readonly [number, number];
  financed?: number;
  /** Interested-party contributions aimed at, in hundredths of a percent of the value. */
  ipcBp?: number;
}

/**
 * Each edge whose cases a wrong reading of one rule turns on takes them in a
 * set order, by its own count, so the held-out suite (about fourteen of each
 * edge) carries at least three of every such case.
 */
const LTV_MAXIMUM_CASES = [
  ["purchase", 0],
  ["non_occupant", 1],
  ["second_home", 1],
  ["investment", 0],
  ["non_occupant", 1],
  ["refinance", 1],
  ["purchase", 1],
  ["non_occupant", 0],
  ["second_home", 0],
  ["investment", 1],
  ["non_occupant", 1],
  ["refinance", 0],
] as const;
const RATE_SET_CASES = [
  "late_sunday",
  "new_years_eve",
  "last_day_held",
  "late_sunday",
  "new_years_eve",
  "past_the_table",
  "new_years_day",
  "adjustable_or_25_years",
  "prepayment_penalty",
] as const;
const IPC_CASES = [
  ["band75", 0],
  ["cap9", 0],
  ["band90", 0],
  ["cap6", 1],
  ["band75", 0],
  ["cap3", 0],
  ["band75", 1],
  ["cap2", 0],
  ["band90", 0],
  ["cap9", 1],
  ["band75", 0],
  ["cap6", 0],
  ["band90", 1],
  ["cap3", 1],
  ["cap2", 1],
] as const;

/** A decision two to forty days after the rate was set, on the 2nd to the 28th, by day in UTC. */
function decisionAfter(r: Rng, rateSetAt: string): string {
  let day = addDays(plainDate(rateSetAt.slice(0, 10)), r.int(2, 40));
  const { y, m, d } = parts(day);
  if (d > 28) day = ymd(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 2);
  else if (d === 1) day = ymd(y, m, 2);
  return at(day, r.int(12, 20), r.int(0, 59));
}

/** A quote in New York business hours on a day from 2026-01-02 to 2026-09-17. */
const anyRateSet = (r: Rng): string =>
  at(addDays(plainDate("2026-01-02"), r.int(0, 258)), r.int(13, 22), r.int(0, 59));

/**
 * A whole-hundred-dollar loan at an LTV, kept on the same side of 80% as
 * the LTV asked for: at or under it rounds down, over it rounds up.
 */
function loanFor(value: number, ltvBp: number): number {
  const exact = (value * ltvBp) / 10_000 / 10_000;
  let loan = (ltvBp <= 8000 ? Math.floor(exact) : Math.ceil(exact)) * 10_000;
  if (ltvBp > 8000 && loan * 100 <= value * 80) loan += 10_000;
  return untie(loan, value);
}

function skeleton(r: Rng, shape: Shape): Draft {
  const purpose = shape.purpose ?? (r.chance(0.3) ? "rate_term_refinance" : "purchase");
  const occupancy: Occupancy =
    purpose !== "purchase"
      ? "primary_residence"
      : (shape.occupancy ??
        r.weighted<Occupancy>([
          ["primary_residence", 80],
          ["second_home", 10],
          ["investment", 10],
        ]));
  const max = occupancy === "primary_residence" ? 9700 : occupancy === "second_home" ? 9000 : 8500;
  let ltvBp = shape.ltvBp ?? (r.chance(0.68) ? r.int(4500, 8000) : r.int(8001, max));
  // Over 80%, a loan stays within the conforming limit.
  const value =
    shape.value ??
    Math.min(
      dollars(r, 18, 120) * 10_000,
      ltvBp > 8000 ? Math.floor((80_000_000 * 10_000) / ltvBp / 1_000_000) * 1_000_000 : Infinity,
    );
  let loan = shape.loan ?? loanFor(value, ltvBp);
  if (shape.loan === undefined && loan > CONFORMING_LIMIT && ltvBp > 8000) {
    ltvBp = r.int(5000, 8000);
    loan = loanFor(value, ltvBp);
  }
  let type: PropertyType =
    shape.type ??
    r.weighted<PropertyType>([
      ["single_family", 64],
      ["condo", 15],
      ["townhouse", 11],
      ["two_to_four_unit", 5],
      ["manufactured", 5],
    ]);
  if (type === "two_to_four_unit" && loan * 100 > value * 75) type = "single_family";
  if (type === "manufactured" && loan * 100 > value * 80) type = "single_family";
  const count = shape.borrowers ?? (r.chance(0.35) ? 2 : 1);
  const last = r.pick(LAST_NAMES);
  const firsts = [...FIRST_NAMES];
  const names = Array.from({ length: count }, () => {
    const first = firsts.splice(r.int(0, firsts.length - 1), 1)[0]!;
    return `${first} ${count === 2 && r.chance(0.4) ? r.pick(LAST_NAMES) : last}`;
  });
  const rateSetAt = shape.rateSetAt ?? anyRateSet(r);
  const draft: Draft = {
    rate_set_at: rateSetAt,
    decided_at: decisionAfter(r, rateSetAt),
    borrowers: names.map((name, k) => ({
      name,
      occupies_property:
        occupancy === "primary_residence" && !(k === 1 && shape.nonOccupant === true),
      credit: null,
      assets: null,
      transcripts: [],
    })),
    income: [],
    property: {
      type,
      occupancy,
      value_cents: value,
      financed_properties: shape.financed ?? (occupancy === "primary_residence" ? 1 : r.int(1, 3)),
    },
    loan: {
      purpose,
      amount_cents: loan,
      junior_lien_balance_cents: 0,
      junior_lien_credit_limit_cents: 0,
      interested_party_contributions_cents: 0,
      existing_loan: null,
    },
    product: {
      term_months:
        shape.term ??
        r.weighted<number>([
          [360, 74],
          [180, 16],
          [240, 5],
          [120, 5],
        ]),
      amortization: shape.amortization ?? "Fixed",
      note_rate_pct: "6.500",
      prepayment_penalty: shape.penalty ?? false,
    },
  };
  const under = occupancy === "primary_residence" ? (loan > CONFORMING_LIMIT ? 2250 : 1500) : 2250;
  const spread = shape.spread ?? { aim: r.int(-600, under - 250), under };
  draft.product.note_rate_pct = noteRateFor(r, draft, spread.aim, spread.under);
  return draft;
}

/* ── credit ───────────────────────────────────────────────────────── */

function scoresOf(r: Rng, own: number): MutableCredit["scores"] {
  const count = r.weighted<number>([
    [3, 75],
    [2, 15],
    [1, 10],
  ]);
  const scores =
    count === 3
      ? [own - r.int(0, 40), own, Math.min(850, own + r.int(0, 30))]
      : count === 2
        ? [own, Math.min(850, own + r.int(0, 40))]
        : [own];
  // Listed in bureau order, not by score.
  const listed = r.chance(0.5) ? scores : [...scores].reverse();
  return listed.map((score, k) => ({ bureau: BUREAUS[k]!, score }));
}

function tradeline(r: Rng, type: TradelineType, payment: number): Tradeline {
  const revolving = type === "revolving" || type === "heloc";
  const limit = revolving ? r.int(4, 80) * 50_000 : null;
  return {
    creditor: r.pick(CREDITORS[type]),
    type,
    opened_on: openedOn(r),
    balance_cents: revolving
      ? Math.round((limit! * r.int(5, 60)) / 100 / 100) * 100
      : dollars(r, 2_000, 60_000),
    credit_limit_cents: limit,
    monthly_payment_cents: payment,
    dti_exclusion: null,
  };
}

/** A tradeline whose key no other in the household has. */
function unique(r: Rng, t: Tradeline, keys: Set<string>): Tradeline {
  while (keys.has(tradelineKey(t))) t = { ...t, opened_on: openedOn(r) };
  keys.add(tradelineKey(t));
  return t;
}

function debtsFor(r: Rng, n: number, keys: Set<string>): Tradeline[] {
  return Array.from({ length: n }, () => {
    const type = r.weighted<TradelineType>([
      ["revolving", 50],
      ["auto", 22],
      ["student", 18],
      ["installment", 10],
    ]);
    const payment =
      type === "revolving"
        ? dollars(r, 25, 220)
        : type === "auto"
          ? dollars(r, 260, 690)
          : dollars(r, 90, 480);
    return unique(r, tradeline(r, type, payment), keys);
  });
}

/** Every borrower a credit report with an own score, and a few debts; the keys the household uses. */
function giveCredit(r: Rng, d: Draft, ownScores?: readonly number[]): Set<string> {
  const keys = new Set<string>();
  d.borrowers.forEach((b, k) => {
    b.credit = {
      scores: scoresOf(r, ownScores?.[k] ?? r.int(640, 810)),
      tradelines: debtsFor(r, r.int(0, 4), keys),
      public_records: [],
    };
  });
  return keys;
}

/** The other financed properties: a mortgage each on Borrower 1's report, and the rents. */
function otherProperties(r: Rng, d: Draft, keys: Set<string>) {
  for (let k = 1; k < d.property.financed_properties; k++) {
    d.borrowers[0]!.credit!.tradelines.push(
      unique(r, tradeline(r, "mortgage", dollars(r, 900, 2_600)), keys),
    );
    // A home of their own when this one is not; the rest are let.
    if (!(k === 1 && d.property.occupancy !== "primary_residence"))
      d.income.push({
        type: "rental",
        monthly_cents: dollars(r, 900, 2_800),
        continuance_established: true,
      });
  }
}

/** The household's monthly liabilities as the rulebook counts them, in cents. */
function liabilitiesOf(d: Draft): number {
  const seen = new Set<string>();
  let sum = 0;
  for (const b of d.borrowers)
    for (const t of b.credit?.tradelines ?? []) {
      if (seen.has(tradelineKey(t))) continue;
      seen.add(tradelineKey(t));
      if (t.dti_exclusion === null) sum += t.monthly_payment_cents;
    }
  return sum;
}

/* ── income ───────────────────────────────────────────────────────── */

/**
 * The qualifying income that puts the back-end ratio inside [lo, hi]
 * (hundredths of a percent, exactly) without its rounding landing on a half
 * or crossing 45: in whole dollars where the window allows, and to the cent
 * where it is narrower than a dollar of income (a salary over twelve months
 * is seldom whole dollars).
 */
function incomeFor(debt: number, pitia: number, window: readonly [number, number]): number {
  const n = BigInt(debt) * 10_000n;
  const mid = (window[0] + window[1]) / 2;
  for (const step of [100, 1]) {
    const start = Math.ceil((debt * 10_000) / mid / step) * step;
    for (let k = 0; k < 4_000; k++) {
      const total = start + (k % 2 === 0 ? (k / 2) * step : -((k + 1) / 2) * step);
      const income = BigInt(total);
      if (versus(n, income, String(window[0])) < 0 || versus(n, income, String(window[1])) > 0)
        continue;
      const exact = roundedExactly(BigInt(debt) * 100n, income, 2);
      if (exact.tie || roundedExactly(BigInt(pitia) * 100n, income, 2).tie) continue;
      if (versus(BigInt(debt) * 100n, income, "45") > 0 !== exact.scaled > 4500n) continue;
      return total;
    }
  }
  throw new RangeError(`no income puts ${debt} inside ${window.join("..")}`);
}

/**
 * The household's income, sized so the back-end ratio lands in `window`.
 * The lead source (Borrower 1's base wage, or their variable pay when there
 * is none) takes what the others leave.
 */
function giveIncome(
  r: Rng,
  d: Draft,
  pitia: number,
  window: readonly [number, number],
  opts: { base?: boolean; variable?: boolean; pending?: boolean } = {},
) {
  const total = incomeFor(pitia + liabilitiesOf(d), pitia, window);
  const share = (lo: number, hi: number) =>
    Math.max(100, Math.round((total * r.int(lo, hi)) / 100 / 100) * 100);
  // Rents already on the file are a share of the household's income, never most of it.
  const rents = d.income.filter((s) => s.continuance_established === true);
  for (const s of rents) s.monthly_cents = share(5, Math.floor(30 / rents.length));
  const already = rents.reduce((a, s) => a + s.monthly_cents, 0);
  const extra: Mutable<IncomeSource>[] = [];
  if ((opts.base ?? true) && d.borrowers.length === 2 && r.chance(0.7))
    extra.push({ type: "base_wage", monthly_cents: share(15, 30), continuance_established: true });
  if (opts.variable ?? r.chance(0.25))
    extra.push({
      type: r.pick(["overtime", "bonus", "commission"] as const),
      monthly_cents: share(4, 10),
      continuance_established: true,
    });
  if (r.chance(0.1))
    extra.push({
      type: r.pick(["social_security", "pension"] as const),
      monthly_cents: share(4, 10),
      continuance_established: true,
    });
  const lead = total - already - extra.reduce((a, s) => a + s.monthly_cents, 0);
  if (lead < total / 5) throw new RangeError("no room left for the lead income");
  d.income.unshift(
    {
      type:
        (opts.base ?? true) ? "base_wage" : r.pick(["commission", "overtime", "bonus"] as const),
      monthly_cents: lead,
      continuance_established: true,
    },
    ...extra,
  );
  if (opts.pending ?? r.chance(0.12))
    d.income.push({
      type: r.pick(["bonus", "commission", "self_employment"] as const),
      monthly_cents: dollars(r, 300, 2_000),
      continuance_established: r.chance(0.5) ? null : false,
    });
}

/* ── assets ───────────────────────────────────────────────────────── */

function account(r: Rng, type: Account["type"], balance: number, used = true): Account {
  return {
    institution:
      type === "brokerage"
        ? r.pick(BROKERS)
        : type === "retirement"
          ? r.pick(PLANS)
          : r.pick(BANKS),
    type,
    mask: String(r.int(1000, 9999)),
    balance_cents: balance,
    vested_balance_cents: type === "retirement" ? balance : null,
    used_to_qualify: used,
  };
}

/**
 * Asset reports for every borrower, holding eligible assets of the funds to
 * close plus a number of months of the housing payment inside [lo, hi)
 * (hundredths of a month), never on a half.
 */
function giveAssets(
  r: Rng,
  d: Draft,
  funds: number,
  pitia: number,
  months: readonly [number, number],
  opts: { retirement?: boolean; joint?: boolean; unused?: boolean } = {},
) {
  const p = BigInt(pitia);
  let eligible = Number((BigInt(funds) * 100n + p * BigInt(months[0]) + 9_999n) / 10_000n) * 100;
  for (let k = 0; ; k++) {
    const post = BigInt(eligible - funds);
    const inside = post * 100n >= p * BigInt(months[0]) && post * 100n < p * BigInt(months[1]);
    if (inside && !roundedExactly(post, p, 1).tie) break;
    if (k > 100_000) throw new RangeError("no whole-dollar balance lands inside the window");
    eligible += 100;
  }
  const accounts: Account[][] = d.borrowers.map(() => []);
  const keys = new Set<string>();
  const add = (owner: number, a: Account): Account => {
    while (keys.has(accountKey(a))) a = { ...a, mask: String(r.int(1000, 9999)) };
    keys.add(accountKey(a));
    accounts[owner]!.push(a);
    return a;
  };
  const owner = () => r.int(0, d.borrowers.length - 1);
  let counted = 0;
  if ((opts.retirement ?? r.chance(0.25)) && eligible >= 500_000) {
    // A vested balance in whole multiples of $5, so 60% of it is whole dollars.
    const part = Math.floor((eligible * r.int(10, 50)) / 100 / 300) * 300;
    if (part > 0) {
      add(owner(), account(r, "retirement", (part * 10) / 6));
      counted += part;
    }
  }
  if (r.chance(0.3) && eligible - counted >= 300_000) {
    const part = Math.floor(((eligible - counted) * r.int(10, 40)) / 100 / 100) * 100;
    add(owner(), account(r, r.pick(["savings", "brokerage", "money_market"] as const), part));
    counted += part;
  }
  if (opts.unused ?? r.chance(0.15))
    add(owner(), account(r, "savings", dollars(r, 500, 20_000), false));
  const checking = account(r, "checking", eligible - counted);
  if ((opts.joint ?? r.chance(0.5)) && d.borrowers.length === 2) {
    const joint = add(0, checking);
    accounts[1]!.push({ ...joint });
  } else add(owner(), checking);
  d.borrowers.forEach((b, k) => (b.assets = { accounts: accounts[k]! }));
}

/* ── the edges ────────────────────────────────────────────────────── */

/** Funds to close in cents, as the rulebook computes it. */
const fundsOf = (d: Draft, closing: number) =>
  (d.loan.purpose === "purchase" ? d.property.value_cents : d.loan.existing_loan!.balance_cents) +
  closing -
  d.loan.interested_party_contributions_cents -
  d.loan.amount_cents;

/** A loan amount nudged a dollar at a time until its LTV is not on a half. */
function untie(loan: number, value: number): number {
  while (roundedExactly(BigInt(loan) * 100n, BigInt(value), 2).tie) loan += 100;
  return loan;
}

/** A value for a loan that must stay where it is, raised a step at a time until its LTV is not on a half. */
function valueAbove(loan: number, value: number, step: number): number {
  while (roundedExactly(BigInt(loan) * 100n, BigInt(value), 2).tie) value += step;
  return value;
}

/** The shape an edge's case asks for, before anything is drawn. */
function shapeFor(r: Rng, edge: AusEdge, sub: number): Shape {
  switch (edge) {
    case "standard":
      return {};
    case "ltv_eighty": {
      // Exactly 80%, a dollar to four over (still 80.00), ten to twenty over, or under.
      const value = dollars(r, 20, 120) * 5_000;
      const at80 = (value * 8) / 10;
      const over = [0, r.int(1, 4) * 100, r.int(10, 20) * 100, -r.int(1, 30) * 100][sub % 4]!;
      const occupancy =
        sub % 3 === 2 ? r.pick(["second_home", "investment"] as const) : "primary_residence";
      return {
        value,
        loan: untie(at80 + over, value),
        occupancy,
        purpose:
          occupancy === "primary_residence" && sub % 5 === 4 ? "rate_term_refinance" : "purchase",
      };
    }
    case "ltv_maximum": {
      const [kind, over] = LTV_MAXIMUM_CASES[sub % LTV_MAXIMUM_CASES.length]!;
      const max = {
        purchase: 97,
        second_home: 90,
        investment: 85,
        non_occupant: 95,
        refinance: 97,
      }[kind];
      const value = dollars(r, 20, 85) * 10_000;
      return {
        value,
        loan: (value / 10_000) * (max * 100 + over),
        occupancy: kind === "second_home" || kind === "investment" ? kind : "primary_residence",
        purpose: kind === "refinance" ? "rate_term_refinance" : "purchase",
        nonOccupant: kind === "non_occupant",
        ...(kind === "non_occupant" ? { borrowers: 2 as const } : {}),
      };
    }
    case "dti": {
      const windows: readonly (readonly [number, number])[] = [
        [4499.6, 4500],
        [4500.6, 4501.4],
        [4999.6, 5000],
        [4502, 4998],
      ];
      return {
        ltvBp: r.int(5000, 8000),
        dti: windows[sub % 4]!,
        ...(sub % 3 === 0 ? { borrowers: 2 as const } : {}),
      };
    }
    case "scores":
      return { ltvBp: r.int(5000, 8000), borrowers: sub % 6 === 3 || sub % 6 === 5 ? 2 : 1 };
    case "seasoning":
      return { ltvBp: r.int(5000, 8000), ...(sub % 4 === 3 ? { borrowers: 2 as const } : {}) };
    case "rate_set": {
      const kind = RATE_SET_CASES[sub % RATE_SET_CASES.length]!;
      const shape: Shape = {
        ltvBp: r.int(5000, 8000),
        occupancy: "primary_residence",
        purpose: "purchase",
      };
      if (kind === "late_sunday") {
        // Late Sunday in New York is early Monday in UTC: the week before.
        const monday = addDays(plainDate("2026-01-05"), 7 * r.int(0, 36));
        shape.rateSetAt = at(monday, r.int(0, monday < "2026-03-09" ? 4 : 3), r.int(0, 59));
      } else if (kind === "new_years_eve") {
        // New Year's Eve in New York: a 2025 rate, whose thresholds the engine does not hold.
        shape.rateSetAt = at(plainDate("2026-01-01"), r.int(0, 4), r.int(0, 59));
      } else if (kind === "new_years_day") {
        shape.rateSetAt = at(plainDate("2026-01-01"), r.int(5, 9), r.int(0, 59));
      } else if (kind === "last_day_held") {
        // 2026-09-20 in New York, the last day the table's last week reaches.
        shape.rateSetAt = r.chance(0.5)
          ? at(plainDate("2026-09-21"), r.int(0, 3), r.int(0, 59))
          : at(plainDate("2026-09-20"), r.int(12, 22), r.int(0, 59));
      } else if (kind === "past_the_table") {
        shape.rateSetAt = at(
          addDays(plainDate("2026-09-21"), r.int(0, 3)),
          r.int(4, 20),
          r.int(0, 59),
        );
      } else if (kind === "adjustable_or_25_years") {
        if (Math.floor(sub / RATE_SET_CASES.length) % 2 === 0)
          shape.amortization = "AdjustableRate";
        else shape.term = 300;
      } else {
        shape.penalty = true;
        shape.occupancy = r.chance(0.5) ? "primary_residence" : "second_home";
      }
      return shape;
    }
    case "price_tests": {
      const kind = sub % 7;
      const valueFor = (loan: number) =>
        valueAbove(loan, Math.ceil((loan * 100) / 75 / 100_000) * 100_000, 100_000);
      if (kind === 0)
        return {
          ltvBp: r.int(5000, 8000),
          occupancy: "primary_residence",
          spread: { aim: r.int(1250, 1499), under: 1500 },
        };
      if (kind === 1 || kind === 2) {
        const loan =
          kind === 1
            ? r.pick([CONFORMING_LIMIT, CONFORMING_LIMIT + 100])
            : dollars(r, 832_760, 1_200_000);
        return {
          loan,
          value: valueFor(loan),
          occupancy: "primary_residence",
          purpose: "purchase",
          spread:
            loan > CONFORMING_LIMIT
              ? { aim: r.int(1500, 2249), under: 2250 }
              : { aim: 1499, under: 1500 },
        };
      }
      const occupancy = r.pick(["second_home", "investment"] as const);
      if (kind === 3)
        return {
          ltvBp: r.int(5000, 8000),
          value: dollars(r, 30, 120) * 10_000,
          occupancy,
          purpose: "purchase",
          spread: { aim: r.int(1500, 2249), under: 2250 },
        };
      if (kind === 4) {
        const loan = r.pick([13_795_700, 13_795_800, 8_277_500, dollars(r, 82_800, 137_900)]);
        return {
          loan,
          value: valueFor(loan),
          occupancy,
          purpose: "purchase",
          spread:
            loan >= 13_795_800
              ? { aim: 2249, under: 2250 }
              : { aim: r.int(2300, 3499), under: 3500 },
        };
      }
      if (kind === 5) {
        const loan = r.pick([8_277_400, dollars(r, 40_000, 82_700)]);
        return {
          loan,
          value: valueFor(loan),
          occupancy,
          purpose: "purchase",
          spread: { aim: r.int(3500, 6499), under: 6500 },
        };
      }
      const loan = dollars(r, 40_000, 137_900);
      return {
        loan,
        value: valueFor(loan),
        occupancy,
        type: "manufactured",
        purpose: "purchase",
        spread: { aim: r.int(2300, 6499), under: 6500 },
      };
    }
    case "small_loan": {
      const kind = sub % 5;
      const loan =
        kind === 0
          ? r.pick([3_730_700, 3_730_800])
          : kind === 2
            ? r.pick([2_759_100, 2_759_200, 1_724_600])
            : dollars(r, 20_000, 37_307);
      const ltv = r.chance(0.6) ? r.int(5000, 8000) : r.int(8001, 9500);
      const primary = kind < 3;
      return {
        loan,
        value: valueAbove(loan, Math.ceil((loan * 10_000) / ltv / 100) * 100, 100),
        occupancy: primary ? "primary_residence" : r.pick(["second_home", "investment"] as const),
        purpose: primary && r.chance(0.2) ? "rate_term_refinance" : "purchase",
        type: r.pick(["single_family", "condo"] as const),
        spread: { aim: r.int(-200, 1300), under: 1500 },
      };
    }
    case "ntb":
      return {
        purpose: "rate_term_refinance",
        ltvBp: r.chance(0.7) ? r.int(5000, 8000) : r.int(8001, 9700),
      };
    case "reserves": {
      const kind = sub % 4;
      return {
        ltvBp: r.int(5000, 8000),
        purpose: "purchase",
        occupancy: kind === 0 ? "second_home" : kind === 1 ? "investment" : "primary_residence",
        financed: kind >= 2 ? r.int(2, 5) : r.chance(0.6) ? 1 : r.int(2, 3),
        months: Math.floor(sub / 4) % 2 === 0 ? [0, 5] : [-15, -5],
      };
    }
    case "ipc": {
      const [kind, over] = IPC_CASES[sub % IPC_CASES.length]!;
      const value = dollars(r, 25, 85) * 10_000;
      // The band lines: exactly 75.00% or 90.00%, or a hundredth over, with 7% or 4% contributed.
      if (kind === "band75" || kind === "band90")
        return {
          value,
          loan: (value / 10_000) * ((kind === "band75" ? 7500 : 9000) + over),
          purpose: "purchase",
          occupancy: "primary_residence",
          ipcBp: kind === "band75" ? 700 : 400,
        };
      // A cap: exactly at it, or a hundredth over.
      const bp = {
        cap9: r.int(5000, 7500),
        cap6: r.int(7501, 9000),
        cap3: r.int(9001, 9700),
        cap2: r.int(5000, 8500),
      }[kind];
      return {
        value,
        loan: (value / 10_000) * bp,
        purpose: "purchase",
        occupancy: kind === "cap2" ? "investment" : "primary_residence",
        ipcBp: Number(kind.slice(3)) * 100 + over,
      };
    }
    case "transcripts":
      return {
        ltvBp: r.int(5000, 8000),
        ...(sub % 3 === 0 || sub % 6 === 5 ? { borrowers: 2 as const } : {}),
      };
    case "missing": {
      const kind = sub % 5;
      // Ability to repay goes undocumented on four of the five, so the APR is refused there too:
      // a file never tests non-QM on a missing report.
      if (kind === 3) return { ltvBp: r.int(5000, 8000) };
      return {
        ltvBp: r.int(8001, 9500),
        occupancy: "primary_residence",
        purpose: "purchase",
        ...(kind === 0 ? { borrowers: 2 as const } : {}),
      };
    }
  }
}

/**
 * Bankruptcies and derogatories, each a month either side of its minimum,
 * or an older record deciding behind a later one. Seven kinds, met and
 * missed in turn: every pair once in fourteen.
 */
function seasoningRecords(r: Rng, d: Draft, sub: number) {
  const on = plainDate(d.decided_at.slice(0, 10));
  const kind = sub % 7;
  const miss = sub % 2 === 1;
  const owner = d.borrowers.length === 2 && r.chance(0.5) ? 1 : 0;
  const push = (rec: PublicRecord, who = owner) =>
    d.borrowers[who]!.credit!.public_records.push(rec);
  const bankruptcy = (
    chapter: PublicRecord["chapter"],
    months: number,
    discharged = true,
  ): PublicRecord => {
    const reference = monthsBefore(r, on, months);
    if (!discharged) return { type: "bankruptcy", date: reference, chapter, discharged_on: null };
    const filed = addMonths(reference, -(chapter === "13" ? r.int(36, 60) : r.int(3, 6)));
    return { type: "bankruptcy", date: filed, chapter, discharged_on: reference };
  };
  const derogatory = (
    type: "foreclosure" | "short_sale" | "deed_in_lieu",
    months: number,
  ): PublicRecord => ({
    type,
    date: monthsBefore(r, on, months),
    chapter: null,
    discharged_on: null,
  });
  const atMinimum = (minimum: number) => minimum - (miss ? 1 : 0);
  /** Two months whose margins against two minimums differ. */
  const apart = (
    lo1: number,
    hi1: number,
    min1: number,
    lo2: number,
    hi2: number,
    min2: number,
  ) => {
    const a = r.int(lo1, hi1);
    let b = r.int(lo2, hi2);
    while (b - min2 === a - min1) b = b + 1 > hi2 ? lo2 : b + 1;
    return [a, b] as const;
  };
  switch (kind) {
    case 0:
      // Chapter 7, 11, or none given: all 48 months.
      push(bankruptcy(r.pick(["7", "7", "11", null] as const), atMinimum(48)));
      break;
    case 1:
      push(bankruptcy("13", atMinimum(24)));
      break;
    case 2:
      push(derogatory("foreclosure", atMinimum(84)));
      break;
    case 3:
      push(derogatory(r.pick(["short_sale", "deed_in_lieu"] as const), atMinimum(48)));
      break;
    case 4: {
      // No discharge: the filing date is the reference.
      const chapter = r.pick(["7", "13"] as const);
      push(bankruptcy(chapter, atMinimum(chapter === "13" ? 24 : 48), false));
      break;
    }
    case 5: {
      // A later chapter 13 past its 24 months, and an older chapter 7 short of its 48, or past
      // them by less than the chapter 13 is past its own: the older one decides either way.
      const [m13, m7] = miss ? apart(25, 35, 24, 38, 47, 48) : apart(30, 40, 24, 49, 53, 48);
      push(bankruptcy("13", m13));
      push(bankruptcy("7", m7), d.borrowers.length - 1);
      break;
    }
    default: {
      // A foreclosure and a later short sale or deed in lieu; the older foreclosure decides.
      const [mf, ms] = miss ? apart(70, 83, 84, 49, 60, 48) : apart(85, 88, 84, 55, 72, 48);
      push(derogatory("foreclosure", mf));
      push(derogatory(r.pick(["short_sale", "deed_in_lieu"] as const), ms), d.borrowers.length - 1);
    }
  }
}

/** Transcripts for a household with variable income, the variance aimed at ±10. */
function transcriptsFor(r: Rng, d: Draft, sub: number) {
  const kind = sub % 6;
  const documented = 12 * d.income.reduce((a, s) => a + s.monthly_cents, 0);
  const windows: readonly (readonly [string, string])[] = [
    ["9.996", "10"],
    ["10.006", "10.014"],
    ["-10", "-9.996"],
    ["-10.014", "-10.006"],
    ["-6", "6"],
    ["-6", "6"],
  ];
  const [lo, hi] = windows[kind]!;
  const target = (Number(lo) + Number(hi)) / 2 + (kind >= 4 ? r.int(-500, 500) / 100 : 0);
  const start = Math.round(documented / (1 + target / 100) / 100) * 100;
  let wages = start;
  for (let k = 0; ; k++) {
    wages = start + (k % 2 === 0 ? (k / 2) * 100 : -((k + 1) / 2) * 100);
    const n = BigInt(documented - wages) * 100n;
    const w = BigInt(wages);
    if (versus(n, w, lo) >= 0 && versus(n, w, hi) <= 0 && !roundedExactly(n, w, 2).tie) break;
    if (k > 100_000) throw new RangeError("no whole-dollar wages land inside the window");
  }
  const year = Number(d.decided_at.slice(0, 4)) - 1;
  const split =
    d.borrowers.length === 2 ? [Math.round((wages * r.int(40, 70)) / 100 / 100) * 100] : [wages];
  if (d.borrowers.length === 2) split.push(wages - split[0]!);
  d.borrowers.forEach((b, k) => {
    b.transcripts = [{ tax_year: year, wages_cents: split[k]! }];
    if (r.chance(0.5))
      b.transcripts.unshift({
        tax_year: year - 1,
        wages_cents: Math.round((split[k]! * r.int(80, 120)) / 100 / 100) * 100,
      });
  });
  // A borrower without a transcript: the check does not run.
  if (kind === 5) d.borrowers[d.borrowers.length - 1]!.transcripts = [];
}

/** One candidate file; the caller keeps it only if it is in scope and fair to grade. */
export function drawAusCandidate(
  r: Rng,
  id: string,
  split: Split,
  suiteSeed: number,
  index: number,
): AusTask {
  const edge = ausEdgeOf(index);
  const sub = Math.floor(index / AUS_EDGES.length);
  const shape = shapeFor(r, edge, sub);
  const d = skeleton(r, shape);
  // The estimates first: everything sized below is sized against them.
  const pitia = taskOf(d, id, split, suiteSeed, index).lender_estimates.housing_payment_cents;
  const closing = closingOf(d.loan.amount_cents);
  const missing = edge === "missing" ? sub % 5 : -1;

  if (d.loan.purpose === "purchase") {
    // Interested-party contributions: under the cap, or aimed at it on the ipc edge.
    const loan = BigInt(d.loan.amount_cents) * 100n;
    const value = BigInt(d.property.value_cents);
    const cap =
      d.property.occupancy === "investment"
        ? 2
        : loan > value * 90n
          ? 3
          : loan > value * 75n
            ? 6
            : 9;
    if (shape.ipcBp !== undefined) {
      // The ipc edge's values are whole multiples of $10,000, so this is exact.
      d.loan.interested_party_contributions_cents = (d.property.value_cents / 10_000) * shape.ipcBp;
    } else if (r.chance(0.45)) {
      let ipc = Math.floor((d.property.value_cents * r.int(20, cap * 100 - 40)) / 1_000_000) * 100;
      while (roundedExactly(BigInt(ipc) * 100n, value, 2).tie) ipc -= 100;
      d.loan.interested_party_contributions_cents = ipc;
    }
  } else {
    // A refinance pays off its loan, and keeps a home-equity line behind it now and then.
    const kind = edge === "ntb" ? sub % 5 : 4;
    const pi = Number(
      levelPaymentPct(BigInt(d.loan.amount_cents), d.product.note_rate_pct, d.product.term_months),
    );
    let saving =
      kind === 1
        ? -dollars(r, 0, 120)
        : kind === 2
          ? Math.ceil(closing / 60)
          : kind === 3
            ? Math.floor((closing * 1_000) / 60_120)
            : Math.ceil(closing / r.int(8, 45));
    while (saving > 0 && roundedExactly(BigInt(closing), BigInt(saving), 1).tie) saving += 1;
    d.loan.existing_loan = {
      balance_cents: r.chance(0.5)
        ? d.loan.amount_cents - closing
        : d.loan.amount_cents - dollars(r, 0, 3_000),
      rate_pct: r.chance(0.8)
        ? (Number(d.product.note_rate_pct) + r.int(2, 16) / 8).toFixed(3)
        : null,
      monthly_payment_cents: pi + saving,
      payment_basis: kind === 0 ? "scheduled_payment" : "principal_and_interest",
    };
    const room = Math.floor((d.property.value_cents * 95) / 100 / 100) * 100 - d.loan.amount_cents;
    if (room > 2_000_000 && r.chance(0.15)) {
      // Neither combined ratio on a half.
      const value = BigInt(d.property.value_cents);
      const loan = BigInt(d.loan.amount_cents);
      const tied = (x: number) => roundedExactly((loan + BigInt(x)) * 100n, value, 2).tie;
      let line = Math.min(room, dollars(r, 10_000, 80_000));
      while (tied(line)) line -= 100;
      let drawn = Math.round((line * r.int(10, 100)) / 100 / 100) * 100;
      while (tied(drawn)) drawn -= 100;
      d.loan.junior_lien_credit_limit_cents = line;
      d.loan.junior_lien_balance_cents = drawn;
    }
  }

  // Credit.
  const kindOfScores = sub % 6;
  const ownScores =
    edge !== "scores"
      ? undefined
      : kindOfScores === 3
        ? (() => {
            const a = r.int(625, 760);
            const b = r.int(625, 800);
            return [a, (a + b) % 2 === 0 ? b + 1 : b];
          })()
        : kindOfScores === 5
          ? [620, 2 * r.int(350, 407) + 1]
          : [r.int(620, 700)];
  const keys = giveCredit(r, d, ownScores);
  if (edge === "scores") {
    const c = d.borrowers[0]!.credit!;
    // A low bureau the middle score passes over; an own score of 620 on two; one score.
    if (kindOfScores === 0)
      c.scores = [
        { bureau: "equifax", score: r.int(560, 619) },
        { bureau: "experian", score: 620 },
        { bureau: "transunion", score: r.int(621, 700) },
      ];
    if (kindOfScores === 1)
      c.scores = [
        { bureau: "experian", score: r.int(621, 760) },
        { bureau: "transunion", score: 620 },
      ];
    if (kindOfScores === 2) c.scores = [{ bureau: "transunion", score: r.int(620, 790) }];
    if (kindOfScores === 4) d.borrowers[d.borrowers.length - 1]!.credit!.scores = [];
  }
  otherProperties(r, d, keys);
  if (edge === "dti" && d.borrowers.length === 2) {
    const joint = unique(r, tradeline(r, "auto", dollars(r, 300, 650)), keys);
    d.borrowers[0]!.credit!.tradelines.push(joint);
    d.borrowers[1]!.credit!.tradelines.push({ ...joint });
  }
  const own = d.borrowers[0]!.credit!.tradelines.filter((t) => t.type !== "mortgage");
  if ((edge === "dti" || r.chance(0.12)) && own.length > 0) {
    const t = r.pick(own);
    const shared =
      d.borrowers.length === 2 &&
      d.borrowers[1]!.credit!.tradelines.some((x) => tradelineKey(x) === tradelineKey(t));
    if (!shared)
      t.dti_exclusion =
        t.type === "revolving"
          ? "paid_by_another_party"
          : r.pick(["paid_by_another_party", "fewer_than_ten_payments_left"] as const);
  }
  if (edge === "seasoning") seasoningRecords(r, d, sub);

  // Income.
  const from = r.int(1800, 4200);
  giveIncome(r, d, pitia, shape.dti ?? [from, from + 60], {
    base: missing !== 3,
    ...(edge === "transcripts" || missing === 3 ? { variable: true } : {}),
    ...(edge === "dti" ? { pending: true } : {}),
  });
  if (missing === 2)
    for (const s of d.income) s.continuance_established = r.chance(0.5) ? null : false;
  if (edge === "transcripts") transcriptsFor(r, d, sub);

  // Assets.
  const required =
    (d.property.occupancy === "primary_residence"
      ? 0
      : d.property.occupancy === "second_home"
        ? 2
        : 6) +
    2 * (d.property.financed_properties - 1);
  const ahead = r.int(60, 2_400);
  const months: readonly [number, number] = shape.months
    ? [required * 100 + shape.months[0], required * 100 + shape.months[1]]
    : [required * 100 + ahead, required * 100 + ahead + 50];
  if (missing !== 1)
    giveAssets(
      r,
      d,
      fundsOf(d, closing),
      pitia,
      months,
      edge === "reserves"
        ? { retirement: r.chance(0.6), joint: r.chance(0.6), unused: r.chance(0.5) }
        : {},
    );
  else if (r.chance(0.4)) d.product.amortization = "AdjustableRate";

  // A missing credit report, last, so nothing above was sized on it.
  if (missing === 0) d.borrowers[1]!.credit = null;
  if (missing === 4) {
    d.borrowers[0]!.credit = null;
    if (d.borrowers.length === 2 && r.chance(0.5)) d.borrowers[1]!.credit = null;
  }
  return taskOf(d, id, split, suiteSeed, index);
}

/* ── drawing ──────────────────────────────────────────────────────── */

const ATTEMPTS = 40;

/** One task, rebuilt from its coordinates alone; `attempts` says how many draws it took. */
export function drawAusTask(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): { task: AusTask; attempts: number } {
  const id = ausTaskId(split, suiteSeed, index);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const task = drawAusCandidate(
      rngFor(attempt === 0 ? id : `${id}#${attempt}`),
      id,
      split,
      suiteSeed,
      index,
    );
    if (ausInScope(task) && ausFairToGrade(task)) return { task, attempts: attempt + 1 };
  }
  throw new Error(`${id}: no file fair to grade in ${ATTEMPTS} draws`);
}

export const generateAusTask = (split: Exclude<Split, "spec">, suiteSeed: number, index: number) =>
  drawAusTask(split, suiteSeed, index).task;

export function generateAusSuite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): AusTask[] {
  return Array.from({ length: n }, (_, i) => generateAusTask(split, suiteSeed, i));
}

export const AUS_HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 200 };

/* ── the worked cases ─────────────────────────────────────────────── */

type Case = Omit<AusTask, "id" | "split" | "suite_seed" | "index" | "lender_estimates">;

/**
 * The file the map of the engine was verified on: one borrower scoring 740,
 * 750 and 760, $15,000 a month of base wage, a $400,000 purchase of a
 * $500,000 house at 6.5% over 30 years, the rate set at noon in New York on
 * Monday 15 June 2026 and the decision five days later; $150,000 in checking.
 */
const MINIMAL: Case = {
  decided_at: "2026-06-20T12:00:00.000Z",
  borrowers: [
    {
      name: "Avery Ashdown",
      occupies_property: true,
      credit: {
        scores: [
          { bureau: "equifax", score: 740 },
          { bureau: "experian", score: 750 },
          { bureau: "transunion", score: 760 },
        ],
        tradelines: [],
        public_records: [],
      },
      assets: {
        accounts: [
          {
            institution: "First Prairie Bank",
            type: "checking",
            mask: "4821",
            balance_cents: 15_000_000,
            vested_balance_cents: null,
            used_to_qualify: true,
          },
        ],
      },
      transcripts: [],
    },
  ],
  income_sources: [{ type: "base_wage", monthly_cents: 1_500_000, continuance_established: true }],
  property: {
    type: "single_family",
    occupancy: "primary_residence",
    value_cents: 50_000_000,
    financed_properties: 1,
  },
  loan: {
    purpose: "purchase",
    amount_cents: 40_000_000,
    junior_lien_balance_cents: 0,
    junior_lien_credit_limit_cents: 0,
    interested_party_contributions_cents: 0,
    existing_loan: null,
  },
  product: {
    term_months: 360,
    amortization: "Fixed",
    note_rate_pct: "6.500",
    prepayment_penalty: false,
    rate_set_at: "2026-06-15T16:00:00.000Z",
  },
};

const borrower1 = MINIMAL.borrowers[0]!;
const withCredit = (credit: Partial<NonNullable<AusBorrower["credit"]>>): AusBorrower => ({
  ...borrower1,
  credit: { ...borrower1.credit!, ...credit },
});
const debt = (
  creditor: string,
  type: TradelineType,
  payment: number,
  opened: string,
): Tradeline => ({
  creditor,
  type,
  opened_on: opened,
  balance_cents: payment * 30,
  credit_limit_cents: type === "revolving" ? payment * 100 : null,
  monthly_payment_cents: payment,
  dti_exclusion: null,
});
const coBorrower = (credit: AusBorrower["credit"]): AusBorrower => ({
  name: "Rowan Ashdown",
  occupies_property: true,
  credit,
  assets: { accounts: [] },
  transcripts: [],
});
const small = (amount: number): Case => ({
  ...MINIMAL,
  property: { ...MINIMAL.property, value_cents: 5_000_000 },
  loan: { ...MINIMAL.loan, amount_cents: amount },
  income_sources: [{ type: "base_wage", monthly_cents: 600_000, continuance_established: true }],
});

/** Each worked case and what it shows, in the order `ausSpecTasks` builds them. */
export const AUS_SPEC_CASES: readonly { readonly name: string; readonly file: Case }[] = [
  {
    name: "The minimal file: $400,000 on $500,000 at 6.5%, DTI 20.88, APR 6.587 against 6.57, clear to close",
    file: MINIMAL,
  },
  {
    name: "$400,010 on $500,000: the LTV shows 80.00, the loan is over 80%, and the APR is refused",
    file: { ...MINIMAL, loan: { ...MINIMAL.loan, amount_cents: 40_001_000 } },
  },
  {
    name: "$485,050 on $500,000: 97.01% against the 97% maximum, a counteroffer",
    file: { ...MINIMAL, loan: { ...MINIMAL.loan, amount_cents: 48_505_000 } },
  },
  {
    name: "$3,619 a month of debts: a back-end ratio of 45.01, approved with conditions",
    file: {
      ...MINIMAL,
      borrowers: [
        withCredit({
          tradelines: [
            debt("Harbor Auto Finance", "auto", 200_000, "2023-04-11"),
            debt("Northfield Card Services", "revolving", 161_900, "2019-09-03"),
          ],
        }),
      ],
    },
  },
  {
    name: "$37,307 on $50,000: points and fees over 5%, high-cost, denied",
    file: small(3_730_700),
  },
  {
    name: "$37,308 on $50,000: a dollar more, and the fees pass",
    file: small(3_730_800),
  },
  {
    name: "A chapter 7 discharged 15 June 2022, decided 20 June 2026: 48 months, met",
    file: {
      ...MINIMAL,
      borrowers: [
        withCredit({
          public_records: [
            { type: "bankruptcy", date: "2022-02-14", chapter: "7", discharged_on: "2022-06-15" },
          ],
        }),
      ],
    },
  },
  {
    name: "An older chapter 7, 44 months back, decides behind a chapter 13 30 months back",
    file: {
      ...MINIMAL,
      borrowers: [
        withCredit({
          public_records: [
            { type: "bankruptcy", date: "2019-03-12", chapter: "13", discharged_on: "2023-12-15" },
            { type: "bankruptcy", date: "2022-06-09", chapter: "7", discharged_on: "2022-10-15" },
          ],
        }),
      ],
    },
  },
  {
    name: "Two borrowers whose own scores are 750 and 665: 665 prices, 708 is tested",
    file: {
      ...MINIMAL,
      borrowers: [
        borrower1,
        coBorrower({
          scores: [
            { bureau: "equifax", score: 671 },
            { bureau: "experian", score: 665 },
            { bureau: "transunion", score: 640 },
          ],
          tradelines: [],
          public_records: [],
        }),
      ],
    },
  },
  {
    name: "A refinance of $300,000 at 6% saving $98.75 a month: $5,925 recouped in 60.0 months",
    file: {
      ...MINIMAL,
      loan: {
        ...MINIMAL.loan,
        purpose: "rate_term_refinance",
        amount_cents: 30_000_000,
        existing_loan: {
          balance_cents: 29_407_500,
          rate_pct: "7.250",
          monthly_payment_cents: 189_740,
          payment_basis: "principal_and_interest",
        },
      },
      product: { ...MINIMAL.product, note_rate_pct: "6.000" },
    },
  },
  {
    name: "The rate set at 23:30 on Sunday 14 June in New York: the week of 8 June",
    file: {
      ...MINIMAL,
      product: { ...MINIMAL.product, rate_set_at: "2026-06-15T03:30:00.000Z" },
    },
  },
  {
    name: "A co-borrower with no credit report, at 90%: the debts cannot be counted, referred",
    file: {
      ...MINIMAL,
      loan: { ...MINIMAL.loan, amount_cents: 45_000_000 },
      borrowers: [borrower1, coBorrower(null)],
    },
  },
];

/** The worked cases as tasks, each with the engine's own estimates. */
export function ausSpecTasks(): AusTask[] {
  return AUS_SPEC_CASES.map(({ file }, index) => {
    const bare: AusTask = {
      id: `${AUS_ENVIRONMENT_NAME}/${AUS_ENVIRONMENT_VERSION}/spec/0/${index}`,
      split: "spec",
      suite_seed: 0,
      index,
      ...file,
      lender_estimates: { housing_payment_cents: 0, closing_costs_cents: 0 },
    };
    return { ...bare, lender_estimates: estimatesOf(bare) };
  });
}
