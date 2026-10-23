/**
 * One loan, drawn: the note, the borrower, the property, the escrow lines and
 * their bills, the ARM and mortgage-insurance terms. Fannie Mae conventional
 * only: a first lien on a one-unit principal residence, 30 years, monthly, due
 * on the first; a fixed rate or a SOFR ARM (5/6, 7/6 or 10/6 on the plan's
 * caps); borrower-paid monthly MI above 80 % loan-to-value.
 *
 * Every draw is made every time, in one order, whether or not the loan uses
 * it, so a pinned term (`LoanPins`) or a calibration change moves only what
 * it names and never the draws after it.
 *
 * What the calibration does not say is a design choice, named here: the
 * balance (a lognormal around $350,000, at most the 2025 conforming limit of
 * $806,500), the MI coverage by loan-to-value and its premium, the share of
 * notes with a dollar late-charge cap and its size, flood insurance on 6 % of
 * loans, a second tax line on half, the ARM product mix and margin, how much
 * each borrower's habits vary from the book's rates, names and addresses.
 */

import { addDays, addMonths, daysInMonth, parts, ymd, type PlainDate } from "@hm/kernel/calendar";
import { levelPayment, ratePercent, type Cents } from "@hm/kernel/money";
import type { Rng } from "../rng.js";
import type { Bin, Rates } from "./calibration.js";
import { INDEX_NAME, normal } from "./feeds.js";

export type Persona = "autopay" | "early";
export type ArmProduct = "5/6" | "7/6" | "10/6";
export type LineBasis = "tax" | "hazard" | "flood" | "mi";
export type LineFrequency = "annual" | "semiannual" | "monthly";

export interface ArmTerms {
  readonly product: ArmProduct;
  readonly index: typeof INDEX_NAME;
  readonly margin_pct: string;
  readonly initial_cap_pct: string;
  readonly periodic_cap_pct: string;
  readonly lifetime_cap_pct: string;
  readonly lookback_days: number;
  /** The first change date: the due date of the last payment at the initial rate. */
  readonly first_change: PlainDate;
  readonly period_months: number;
  readonly fixed_period_months: number;
}

export interface MiTerms {
  readonly annual_cents: Cents;
  /** The annual premium as a percent of the original balance. */
  readonly rate_pct: string;
  readonly coverage_pct: number;
  readonly company: string;
  readonly borrower_paid: true;
}

export interface Bill {
  readonly on: PlainDate;
  readonly amount: Cents;
}

export interface EscrowLine {
  readonly line_type: "tax_county" | "tax_school" | "hazard" | "flood" | "mi_borrower_paid";
  readonly frequency: LineFrequency;
  readonly basis: LineBasis;
  readonly bills: readonly Bill[];
}

export interface Party {
  readonly party_id: string;
  readonly position: number;
  readonly given_name: string;
  readonly surname: string;
  readonly date_of_birth: PlainDate;
  readonly same_address_as_base: boolean;
  readonly liability: "individual" | "joint";
}

export interface Property {
  readonly street: string;
  readonly city: string;
  readonly state: string;
  readonly zip: string;
  readonly property_type: "single_family";
  readonly units: 1;
  readonly occupancy: "principal";
}

/** The note's late-charge terms (the Uniform Note's paragraph 6(A)). */
export interface LateChargeTerms {
  readonly pct: string;
  readonly grace_days: number;
  /** A dollar ceiling some notes carry; null when the note has none. */
  readonly cap_cents: Cents | null;
  readonly basis: "pi";
}

/** A line before its bills: the schedule and the drawn growth, so scenario events can be applied. */
export interface LineSpec {
  readonly line_type: EscrowLine["line_type"];
  readonly frequency: LineFrequency;
  readonly basis: LineBasis;
  /** Calendar months (1–12) of the year's bills, and their day. */
  readonly months: readonly number[];
  readonly day: number;
  /** The first year's annual amount, in cents. */
  readonly first_annual: number;
  /** Growth for each following year, as a share. */
  readonly growth: readonly number[];
}

export interface LoanDraw {
  readonly loan_id: string;
  readonly index: number;
  readonly servicer_loan_number: string;
  readonly prior_servicer_loan_number: string;
  readonly fnma_loan_number: string;
  readonly min: string;
  readonly note_date: PlainDate;
  readonly first_due: PlainDate;
  readonly term_months: 360;
  readonly maturity: PlainDate;
  readonly orig_upb_cents: Cents;
  readonly note_rate_pct: string;
  readonly initial_pi_cents: Cents;
  readonly value_cents: Cents;
  readonly ltv_pct: number;
  readonly property: Property;
  readonly parties: readonly Party[];
  readonly persona: Persona;
  /** How much more or less often than the book's rates this borrower pays late (mean 1). */
  readonly lateness: number;
  /** How much more or less often than the book's rate this borrower misses a payment (mean 1). */
  readonly fragility: number;
  readonly late_charge: LateChargeTerms;
  readonly escrowed: boolean;
  readonly line_specs: readonly LineSpec[];
  readonly mi: MiTerms | null;
  readonly arm: ArmTerms | null;
  /** The loan's age when a book boarded by transfer reaches us, in months (read only then). */
  readonly boarding_age_months: number;
}

/** Terms a scenario may pin on a loan; everything else is drawn. */
export interface LoanPins {
  readonly arm?: ArmProduct | null;
  readonly escrowed?: boolean;
  readonly ltv_pct?: number;
  readonly note_rate_pct?: string;
  readonly orig_upb_cents?: Cents | number;
  readonly late_charge_cap_cents?: Cents | number | null;
  readonly persona?: Persona;
  /** Pin both habit multipliers at 1, or at the values given. */
  readonly lateness?: number;
  readonly fragility?: number;
}

/* ── small draws ─────────────────────────────────────────────────────────── */

export function pickBin(r: Rng, bs: readonly Bin[]): number {
  let u = r.next();
  const v = r.next();
  for (const b of bs) {
    if (u < b.weight) return b.lo + (b.hi - b.lo) * v;
    u -= b.weight;
  }
  const last = bs[bs.length - 1]!;
  return last.lo + (last.hi - last.lo) * v;
}

const digits = (r: Rng, n: number): string => {
  let s = String(r.int(1, 9));
  for (let i = 1; i < n; i++) s += String(r.int(0, 9));
  return s;
};
const eighth = (pct: number): string => (Math.round(pct * 8) / 8).toFixed(3);
const lognormalMeanOne = (r: Rng, sigma: number): number =>
  Math.exp(sigma * normal(r) - (sigma * sigma) / 2);

/** States, weighted, with a city and a ZIP prefix each: invented addresses, real places. */
const STATES: readonly (readonly [string, number, string, string])[] = [
  ["CA", 12, "Sacramento", "958"],
  ["TX", 10, "Austin", "787"],
  ["FL", 8, "Orlando", "328"],
  ["NY", 5, "Albany", "122"],
  ["IL", 4, "Springfield", "627"],
  ["PA", 4, "Harrisburg", "171"],
  ["OH", 4, "Columbus", "432"],
  ["GA", 4, "Atlanta", "303"],
  ["NC", 4, "Raleigh", "276"],
  ["MI", 3, "Lansing", "489"],
  ["NJ", 3, "Trenton", "086"],
  ["VA", 3, "Richmond", "232"],
  ["WA", 3, "Olympia", "985"],
  ["AZ", 3, "Phoenix", "850"],
  ["MA", 2, "Worcester", "016"],
  ["CO", 3, "Denver", "802"],
];
const STREETS = [
  "Maple",
  "Oak",
  "Cedar",
  "Elm",
  "Pine",
  "Willow",
  "Birch",
  "Lake",
  "Hill",
  "Park",
  "River",
  "Meadow",
];
const SUFFIXES = ["Street", "Avenue", "Road", "Lane", "Drive", "Court"];
const GIVEN = [
  "James",
  "Maria",
  "Robert",
  "Linda",
  "Michael",
  "Patricia",
  "David",
  "Jennifer",
  "Carlos",
  "Aisha",
  "Wei",
  "Priya",
  "Daniel",
  "Emily",
  "Kevin",
  "Grace",
];
const SURNAMES = [
  "Smith",
  "Johnson",
  "Garcia",
  "Brown",
  "Lee",
  "Martinez",
  "Davis",
  "Nguyen",
  "Patel",
  "Wilson",
  "Anderson",
  "Thomas",
  "Moore",
  "Clark",
  "Lewis",
  "Young",
];

/** The note's percent where the servicing app's state table caps it lower (docs/synthetic-data-defects.md, D-04). */
const STATE_LATE_PCT: Readonly<Record<string, string>> = { NY: "2", NC: "4" };

/** Fannie Mae's standard coverage for a 30-year loan, and an invented premium rate, by loan-to-value. */
function miFor(ltv: number): { coverage: number; ratePct: number } {
  if (ltv <= 85) return { coverage: 12, ratePct: 0.3 };
  if (ltv <= 90) return { coverage: 25, ratePct: 0.45 };
  if (ltv <= 95) return { coverage: 30, ratePct: 0.6 };
  return { coverage: 35, ratePct: 0.75 };
}

const CONFORMING_LIMIT_CENTS = 80_650_000n;
const NOTE_CAP_SHARE = 0.15;
const NOTE_CAPS_CENTS = [1_500n, 2_500n, 3_500n, 5_000n];
const FLOOD_SHARE = 0.06;
const SCHOOL_TAX_SHARE = 0.5;
const COBORROWER_SHARE = 0.45;
const EARLY_PERSONA_SHARE = 0.35;
const VALUE_ANCHOR = 45_000_000; // cents: the home whose tax and premium are the medians

export interface DrawContext {
  readonly rates: Rates;
  /** The first payment of the book's first cohort. */
  readonly start: PlainDate;
  readonly cohort_months: number;
  readonly years: number;
}

/** The loan at book index `i`, drawn from `r`. */
export function drawLoan(
  r: Rng,
  ctx: DrawContext,
  id: string,
  i: number,
  pins: LoanPins = {},
): LoanDraw {
  const R = ctx.rates;
  // The dates: a first payment on the first of a month in the cohort, closing in the month two before it.
  const offset = r.int(0, Math.max(0, ctx.cohort_months - 1));
  const first_due = addMonths(ctx.start, offset);
  const closingMonth = addMonths(first_due, -2);
  const note_date = addDays(closingMonth, r.int(0, 27));
  const maturity = addMonths(first_due, 359);

  // The note.
  const rateDraw = eighth(Math.min(12, Math.max(1, pickBin(r, R.book.note_rate))));
  const ltvDraw = Math.min(97, Math.max(20, Math.round(pickBin(r, R.book.ltv) * 100) / 100));
  const upbDraw =
    BigInt(Math.round(Math.exp(Math.log(35_000_000) + 0.5 * normal(r)) / 10_000)) * 10_000n;
  const note_rate_pct = pins.note_rate_pct ?? rateDraw;
  const ltv_pct = pins.ltv_pct ?? ltvDraw;
  const pinnedUpb = pins.orig_upb_cents !== undefined ? BigInt(pins.orig_upb_cents) : null;
  const orig_upb_cents =
    pinnedUpb ??
    (upbDraw < 6_000_000n
      ? 6_000_000n
      : upbDraw > CONFORMING_LIMIT_CENTS
        ? CONFORMING_LIMIT_CENTS
        : upbDraw);
  const value_cents = (orig_upb_cents * 10_000n) / BigInt(Math.round(ltv_pct * 100));

  // The components, all drawn whether used or not.
  const uEscrow = r.next();
  const uMi = r.next();
  const uArm = r.next();
  const product = r.weighted<ArmProduct>([
    ["5/6", 6],
    ["7/6", 3],
    ["10/6", 1],
  ]);
  const margin = r.pick(["2.750", "3.000"]);
  const uFlood = r.next();
  const uSchool = r.next();
  const uCap = r.next();
  const capCents = r.pick(NOTE_CAPS_CENTS);
  const taxNoise = normal(r);
  const insNoise = normal(r);
  const floodNoise = normal(r);
  const taxMonth = r.int(1, 6);
  const taxDay = r.pick([1, 15]);
  const schoolMonth = r.int(1, 12);
  const taxGrowth: number[] = [];
  const insGrowth: number[] = [];
  const schoolGrowth: number[] = [];
  const floodGrowth: number[] = [];
  for (let y = 0; y < ctx.years + 2; y++) {
    taxGrowth.push(Math.max(-0.05, R.escrow.tax_growth_yoy + 0.02 * normal(r)));
    insGrowth.push(Math.max(-0.1, R.escrow.insurance_growth_yoy + 0.03 * normal(r)));
    schoolGrowth.push(Math.max(-0.05, R.escrow.tax_growth_yoy + 0.02 * normal(r)));
    floodGrowth.push(Math.max(0, 0.08 + 0.03 * normal(r)));
  }
  const personaDraw: Persona = r.chance(EARLY_PERSONA_SHARE) ? "early" : "autopay";
  const latenessDraw = lognormalMeanOne(r, 0.8);
  const fragilityDraw = lognormalMeanOne(r, 0.8);
  const coborrower = r.chance(COBORROWER_SHARE);
  const b2SameAddress = r.chance(0.9);
  const names = [
    r.pick(GIVEN),
    r.pick(SURNAMES),
    r.pick(GIVEN),
    r.chance(0.7) ? null : r.pick(SURNAMES),
  ];
  const ages = [r.int(25, 65), r.int(25, 65)];
  const birthDays = [r.int(0, 364), r.int(0, 364)];
  const state = r.weighted(STATES.map((s) => [s, s[1]] as const));
  const streetNo = r.int(100, 9899);
  const street = `${streetNo} ${r.pick(STREETS)} ${r.pick(SUFFIXES)}`;
  const zip = state[3] + digits(r, 2).padStart(2, "0");
  const fnma = digits(r, 10);
  const min = "1000001" + digits(r, 11);
  const servicerNo = "70" + digits(r, 8);
  const priorNo = "P" + digits(r, 9);
  const boardingAge = Math.max(0, Math.round(pickBin(r, R.book.loan_age_months)));

  // MI above 80 %; borrower-paid on the share of those loans that brings the book to the calibration's MI share.
  const above80 = R.book.ltv.reduce(
    (s, b) =>
      s + (b.hi <= 80 ? 0 : b.lo >= 80 ? b.weight : (b.weight * (b.hi - 80)) / (b.hi - b.lo)),
    0,
  );
  const miBorrowerPaid =
    ltv_pct > 80 && uMi < Math.min(1, R.mi.share_of_loans / Math.max(above80, 1e-9));
  const escrowed = pins.escrowed ?? (miBorrowerPaid || uEscrow < R.escrow.share_of_loans);
  const armProduct =
    pins.arm !== undefined ? pins.arm : uArm < R.arm.share_of_outstanding ? product : null;

  let mi: MiTerms | null = null;
  if (miBorrowerPaid && escrowed) {
    const m = miFor(ltv_pct);
    const annual = ((orig_upb_cents * BigInt(Math.round(m.ratePct * 1000))) / 100_000n / 12n) * 12n;
    mi = {
      annual_cents: annual,
      rate_pct: m.ratePct.toFixed(3),
      coverage_pct: m.coverage,
      company: `MI-${1 + (Number(fnma.slice(-1)) % 6)}`,
      borrower_paid: true,
    };
  }

  let arm: ArmTerms | null = null;
  if (armProduct) {
    const years = Number(armProduct.split("/")[0]);
    arm = {
      product: armProduct,
      index: INDEX_NAME,
      margin_pct: margin,
      initial_cap_pct: armProduct === "5/6" ? "2.000" : "5.000",
      periodic_cap_pct: "1.000",
      lifetime_cap_pct: "5.000",
      lookback_days: 45,
      first_change: addMonths(first_due, years * 12 - 1),
      period_months: 6,
      fixed_period_months: years * 12,
    };
  }

  // Escrow lines: taxes semiannual (and a school tax on half), hazard at each anniversary of closing, flood on a few, MI monthly.
  const line_specs: LineSpec[] = [];
  if (escrowed) {
    const scale = (Number(value_cents) / VALUE_ANCHOR) ** 0.7;
    line_specs.push({
      line_type: "tax_county",
      frequency: "semiannual",
      basis: "tax",
      months: [taxMonth, taxMonth + 6],
      day: taxDay,
      first_annual:
        R.escrow.tax_annual_median_cents *
        scale *
        Math.exp(0.35 * taxNoise) *
        (uSchool < SCHOOL_TAX_SHARE ? 0.7 : 1),
      growth: taxGrowth,
    });
    if (uSchool < SCHOOL_TAX_SHARE)
      line_specs.push({
        line_type: "tax_school",
        frequency: "annual",
        basis: "tax",
        months: [schoolMonth],
        day: 1,
        first_annual: R.escrow.tax_annual_median_cents * scale * Math.exp(0.35 * taxNoise) * 0.3,
        growth: schoolGrowth,
      });
    const nd = parts(note_date);
    line_specs.push({
      line_type: "hazard",
      frequency: "annual",
      basis: "hazard",
      months: [nd.m],
      day: Math.min(nd.d, 28),
      first_annual:
        R.escrow.insurance_annual_median_cents *
        (Number(value_cents) / VALUE_ANCHOR) ** 0.6 *
        Math.exp(0.3 * insNoise),
      growth: insGrowth,
    });
    if (uFlood < FLOOD_SHARE)
      line_specs.push({
        line_type: "flood",
        frequency: "annual",
        basis: "flood",
        months: [nd.m],
        day: Math.min(nd.d, 28),
        first_annual: 90_000 * Math.exp(0.5 * floodNoise),
        growth: floodGrowth,
      });
    if (mi)
      line_specs.push({
        line_type: "mi_borrower_paid",
        frequency: "monthly",
        basis: "mi",
        months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        day: 1,
        first_annual: Number(mi.annual_cents),
        growth: [],
      });
  }

  const parties: Party[] = [];
  const dob = (k: number): PlainDate =>
    addDays(ymd(parts(note_date).y - ages[k]!, 1, 1), birthDays[k]!);
  parties.push({
    party_id: `${id}-B1`,
    position: 1,
    given_name: names[0]!,
    surname: names[1]!,
    date_of_birth: dob(0),
    same_address_as_base: true,
    liability: coborrower ? "joint" : "individual",
  });
  if (coborrower)
    parties.push({
      party_id: `${id}-B2`,
      position: 2,
      given_name: names[2]!,
      surname: names[3] ?? names[1]!,
      date_of_birth: dob(1),
      same_address_as_base: b2SameAddress,
      liability: "joint",
    });

  const pinnedCap = pins.late_charge_cap_cents;
  const cap_cents =
    pinnedCap !== undefined
      ? pinnedCap === null
        ? null
        : BigInt(pinnedCap)
      : uCap < NOTE_CAP_SHARE
        ? capCents
        : null;
  return {
    loan_id: id,
    index: i,
    servicer_loan_number: servicerNo,
    prior_servicer_loan_number: priorNo,
    fnma_loan_number: fnma,
    min,
    note_date,
    first_due,
    term_months: 360,
    maturity,
    orig_upb_cents,
    note_rate_pct,
    initial_pi_cents: levelPayment(orig_upb_cents, ratePercent(note_rate_pct), 360),
    value_cents,
    ltv_pct,
    property: {
      street,
      city: state[2],
      state: state[0],
      zip,
      property_type: "single_family",
      units: 1,
      occupancy: "principal",
    },
    parties,
    persona: pins.persona ?? personaDraw,
    lateness: pins.lateness ?? latenessDraw,
    fragility: pins.fragility ?? fragilityDraw,
    late_charge: { pct: STATE_LATE_PCT[state[0]] ?? "5", grace_days: 15, cap_cents, basis: "pi" },
    escrowed,
    line_specs,
    mi,
    arm,
    boarding_age_months: boardingAge,
  };
}

/** A multiplier on a line's bills from a dated scenario event (a reassessment, a premium increase). */
export interface BillChange {
  readonly basis: "tax" | "hazard";
  readonly on: PlainDate;
  /** The change in percent: 25 raises every bill on or after `on` by a quarter. */
  readonly pct: number;
}

/** Each line's bills from the first payment through `through`, with the scenario's changes applied. */
export function buildLines(
  d: LoanDraw,
  changes: readonly BillChange[],
  through: PlainDate,
): EscrowLine[] {
  const y0 = parts(d.first_due).y;
  const out: EscrowLine[] = [];
  for (const s of d.line_specs) {
    const bills: Bill[] = [];
    const yEnd = parts(through).y;
    let annual = s.first_annual;
    for (let y = y0; y <= yEnd; y++) {
      if (y > y0) annual *= 1 + (s.growth[y - y0 - 1] ?? 0);
      const total = BigInt(Math.round(annual));
      const n = BigInt(s.months.length);
      const per = s.basis === "mi" ? BigInt(Math.round(s.first_annual)) / 12n : total / n;
      s.months.forEach((mo, k) => {
        const yy = y + Math.floor((mo - 1) / 12);
        const mm = ((mo - 1) % 12) + 1;
        const on = ymd(yy, mm, Math.min(s.day, daysInMonth(yy, mm)));
        if (on < d.first_due || on > through) return;
        let amount =
          s.basis === "mi" ? per : k === s.months.length - 1 ? total - per * (n - 1n) : per;
        for (const c of changes)
          if (c.basis === s.basis && on >= c.on)
            amount = (amount * BigInt(Math.round((100 + c.pct) * 1000))) / 100_000n;
        bills.push({ on, amount });
      });
    }
    bills.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
    out.push({ line_type: s.line_type, frequency: s.frequency, basis: s.basis, bills });
  }
  return out;
}
