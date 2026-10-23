/**
 * A book of loan-decades from a seed and a scenario, and its defective twin.
 *
 * `generate(seed, scenario, { defects })` draws every loan, runs each one's
 * history (`simulateLoan`), and, when defects are asked for, runs each planted
 * loan again from the same draws with the defect boarded. The twin book is
 * the clean book with those loans replaced; the labels name the root cause
 * and every symptom. Nothing reads a clock: the same seed, scenario and
 * calibration give the same book, byte for byte, run to run and machine to
 * machine (the draws use only the rng streams and V8's own Math functions).
 *
 * Every stream hangs off `life/<version>/<seed>`, so a change to what the
 * generator draws is a new version and moves every book.
 */

import { addMonths, endOfMonth, parts, type PlainDate } from "@hm/kernel/calendar";
import type { IndexObs } from "../arm/ported/arm.js";
import { hash32, rngFor } from "../rng.js";
import { loadCalibration, type Calibration } from "./calibration.js";
import { defectById, rootLabel, symptomLabels, type DefectLabel } from "./defects.js";
import { buildLines, drawLoan, type BillChange, type LoanDraw } from "./draw.js";
import { indexFeed, marketPath, type MarketMonth } from "./feeds.js";
import { normalizeScenario, scriptFor, type NormalScenario, type Scenario } from "./scenario.js";
import { simulateLoan, type LifeMoment, type LoanLife, type SimContext } from "./simulate.js";

/** Bump on any change to what the generator draws or how a history is computed. */
export const LIFE_VERSION = "1.1.0";

export interface LifeBook {
  readonly seed: string;
  readonly version: string;
  readonly scenario: NormalScenario;
  readonly calibration: {
    readonly version: string;
    readonly path: string | null;
    readonly warnings: readonly string[];
  };
  readonly index_feed: readonly IndexObs[];
  readonly market: readonly MarketMonth[];
  readonly loans: readonly LoanLife[];
}

/** A defect to plant: its id, and either the loans (by book index) or a rate over the eligible ones. */
export type DefectRequest =
  string | { readonly id: string; readonly loans?: readonly number[]; readonly rate?: number };

export interface Planted {
  readonly loan: string;
  readonly index: number;
  readonly defect_id: string;
  readonly on: PlainDate;
}

export interface LifeResult {
  readonly clean: LifeBook;
  /** The clean book with every planted loan's twin in its place, or null when no defect was asked for. */
  readonly defective: LifeBook | null;
  readonly planted: readonly Planted[];
  readonly labels: readonly DefectLabel[];
}

export interface GenerateOptions {
  readonly defects?: readonly DefectRequest[];
  /** The calibration to draw from; default, `calibration.json` beside this module (or every default without it). */
  readonly calibration?: Calibration;
  /** Shown each loan's receipts and analyses as they come, in the clean history and in its twin. */
  readonly observe?: (loan: number, history: "clean" | "twin", moment: LifeMoment) => void;
}

interface Prepared {
  readonly draw: LoanDraw;
  readonly lines: ReturnType<typeof buildLines>;
  readonly script: ReturnType<typeof scriptFor>;
  readonly transferIn: PlainDate | null;
}

const monthsFrom = (a: PlainDate, b: PlainDate) => {
  const pa = parts(a);
  const pb = parts(b);
  return (pb.y - pa.y) * 12 + (pb.m - pa.m);
};

export function generate(
  seed: string | number,
  scenario: Scenario = {},
  opts: GenerateOptions = {},
): LifeResult {
  const cal = opts.calibration ?? loadCalibration();
  const sc = normalizeScenario(scenario);
  const key = `life/${LIFE_VERSION}/${seed}`;
  const lastFirstDue = addMonths(sc.start, sc.cohort_months - 1);
  const through = endOfMonth(addMonths(lastFirstDue, sc.months + 1));
  const feed = indexFeed(key, addMonths(sc.start, -3), through);
  const marketFrom = addMonths(sc.start, -1);
  const market = marketPath(key, cal.rates, marketFrom, monthsFrom(marketFrom, through) + 1);
  const ctx: SimContext = {
    key,
    rates: cal.rates,
    random: sc.random,
    months: sc.months,
    feed,
    market,
  };
  const drawCtx = {
    rates: cal.rates,
    start: sc.start,
    cohort_months: sc.cohort_months,
    years: Math.ceil(sc.months / 12) + 2,
  };
  const tag = hash32(key).toString(16).padStart(8, "0");

  const prepared: Prepared[] = [];
  const loans: LoanLife[] = [];
  for (let i = 0; i < sc.loans; i++) {
    const id = `LN-${tag}-${String(i).padStart(5, "0")}`;
    let draw = drawLoan(rngFor(`${key}/loan/${i}/draw`), drawCtx, id, i, sc.pins[i]);
    if (!sc.random.growth) {
      const R = cal.rates.escrow;
      const flat = (basis: string) =>
        basis === "tax"
          ? R.tax_growth_yoy
          : basis === "hazard"
            ? R.insurance_growth_yoy
            : basis === "flood"
              ? 0.08
              : 0;
      draw = {
        ...draw,
        line_specs: draw.line_specs.map((l) => ({
          ...l,
          growth: l.growth.map(() => flat(l.basis)),
        })),
      };
    }
    const script = scriptFor(sc, i, draw);
    const changes: BillChange[] = [
      ...script.tax.map((t) => ({ basis: "tax" as const, on: t.on, pct: t.pct })),
      ...script.insurance.map((t) => ({ basis: "hazard" as const, on: t.on, pct: t.pct })),
    ];
    const lines = buildLines(draw, changes, endOfMonth(addMonths(draw.first_due, sc.months + 13)));
    const age = draw.boarding_age_months;
    const transferIn =
      script.transfer_in?.on ??
      (sc.boarding === "book" && age > 0 ? addMonths(draw.first_due, age) : null);
    prepared.push({ draw, lines, script, transferIn });
    const observe = opts.observe;
    loans.push(
      simulateLoan(
        ctx,
        draw,
        lines,
        script,
        transferIn,
        observe ? { observe: (m) => observe(i, "clean", m) } : {},
      ),
    );
  }
  const clean: LifeBook = {
    seed: String(seed),
    version: LIFE_VERSION,
    scenario: sc,
    calibration: { version: cal.version, path: cal.path, warnings: cal.warnings },
    index_feed: feed,
    market,
    loans,
  };
  if (!opts.defects || opts.defects.length === 0)
    return { clean, defective: null, planted: [], labels: [] };

  // Where each defect goes: the loans named, or each eligible loan at the defect's rate from its own stream.
  const placed = new Map<number, string>();
  for (const req of opts.defects) {
    const r = typeof req === "string" ? { id: req } : req;
    const def = defectById(r.id);
    const rate =
      r.rate ??
      cal.rates.defects.field_error_rates[def.id] ??
      cal.rates.defects.field_error_rates[def.field] ??
      cal.rates.defects.field_error_rates["*"] ??
      0;
    const targets =
      r.loans ??
      prepared.flatMap((p, i) =>
        def.eligible(p.draw) && rngFor(`${key}/defects/${def.id}/${i}`).next() < rate ? [i] : [],
      );
    for (const i of targets) {
      const p = prepared[i];
      if (!p) throw new RangeError(`${def.id}: loan ${i} is not in a book of ${sc.loans}`);
      if (!def.eligible(p.draw))
        throw new RangeError(
          `${def.id} cannot be planted on loan ${i}: ${def.title.toLowerCase()} needs a note it applies to`,
        );
      const already = placed.get(i);
      if (already && already !== def.id)
        throw new RangeError(
          `loan ${i} already carries ${already}; this wave plants one defect per loan`,
        );
      placed.set(i, def.id);
    }
  }
  const planted: Planted[] = [];
  const labels: DefectLabel[] = [];
  const twins = new Map<string, LoanLife>();
  for (const [i, id] of [...placed].sort((a, b) => a[0] - b[0])) {
    const def = defectById(id);
    const p = prepared[i]!;
    const observe = opts.observe;
    const twin = simulateLoan(ctx, p.draw, p.lines, p.script, p.transferIn, {
      boarded: def.boarded,
      ...(observe ? { observe: (m: LifeMoment) => observe(i, "twin", m) } : {}),
    });
    const c = loans[i]!;
    twins.set(c.loan_id, twin);
    planted.push({ loan: c.loan_id, index: i, defect_id: id, on: twin.boarded.on });
    labels.push(rootLabel(twin, def), ...symptomLabels(c, twin, def));
  }
  const defective: LifeBook = { ...clean, loans: loans.map((l) => twins.get(l.loan_id) ?? l) };
  return { clean, defective, planted, labels };
}
