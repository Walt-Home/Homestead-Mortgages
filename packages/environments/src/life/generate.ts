/**
 * A book of loan-decades from a seed and a scenario, and its defective twin.
 *
 * `generate(seed, scenario, { defects })` draws every loan, runs each one's
 * history (`simulateLoan`), and, when defects are asked for, runs each planted
 * loan again from the same draws with the defect boarded. The twin book is
 * the clean book with those loans replaced; the labels name the root cause
 * and every symptom. A loan may carry two defects: its twin boards both, and
 * a symptom is labeled for each defect whose own twin shows it, or for the
 * pair when neither does alone. Nothing reads a clock: the same seed, scenario and
 * calibration give the same book, byte for byte, run to run and machine to
 * machine (the draws use only the rng streams and V8's own Math functions).
 *
 * Every stream hangs off `life/<version>/<seed>`, so a change to what the
 * generator draws is a new version and moves every book.
 */

import { addMonths, endOfMonth, parts, plainDate, type PlainDate } from "@hm/kernel/calendar";
import type { IndexObs } from "../arm/ported/arm.js";
import { hash32, rngFor } from "../rng.js";
import { loadCalibration, type Calibration } from "./calibration.js";
import {
  defectById,
  defectKey,
  differences,
  rootLabel,
  type DefectDefinition,
  type DefectLabel,
  type Difference,
} from "./defects.js";
import { buildLines, drawLoan, type BillChange, type LoanDraw } from "./draw.js";
import { indexFeed, marketPath, type MarketMonth } from "./feeds.js";
import { normalizeScenario, scriptFor, type NormalScenario, type Scenario } from "./scenario.js";
import {
  simulateLoan,
  type HistoryError,
  type LifeMoment,
  type LoanLife,
  type SimContext,
} from "./simulate.js";

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

/**
 * A defect to plant: its key in the registry (`DEFECTS`: the catalog's id, or
 * a form of it, `D-25/wrong-loan`), and either the loans (by book index) or a
 * rate. A defect that enters at boarding, or in the prior servicer's books
 * before it, is planted on each eligible loan at the rate. A history error is
 * made on each event it can be made on at the rate (each bill, each receipt),
 * and on a named loan on the first such event on or after `at` ("YYYY-MM" or
 * a date), or on one drawn when `at` is absent. `with` names, for each loan in
 * `loans`, the loan a partnered error (D-25/wrong-loan) lands on; without it,
 * the first loan after it in the book that it can land on.
 */
export type DefectRequest =
  | string
  | {
      readonly id: string;
      readonly loans?: readonly number[];
      readonly rate?: number;
      readonly at?: string;
      readonly with?: readonly number[];
    };

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

/** Where a difference sits: its table, row and field. */
const placeOf = (x: Difference) => `${x.file_or_table}|${x.row}|${x.field}`;

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
    outreach: sc.outreach,
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

  // Where each defect goes. One that enters at boarding or before it: the loans named, or each eligible loan at the
  // defect's rate from its own stream; a rate per unit (D-25's per receipt) is the chance that a loan of `units` such
  // units carries one. A history error: on events of the clean history, which the twin shares until the error.
  interface Entry {
    readonly def: DefectDefinition;
    readonly errors: HistoryError[];
    readonly roots: Difference[];
  }
  const placed = new Map<number, Entry[]>();
  const entryOf = (i: number, def: DefectDefinition): Entry => {
    const list = placed.get(i) ?? [];
    let e = list.find((x) => x.def === def);
    if (!e) {
      e = { def, errors: [], roots: [] };
      list.push(e);
      placed.set(i, list);
    }
    return e;
  };
  const fits = (def: DefectDefinition, p: Prepared, c: LoanLife) =>
    def.eligible(p.draw) &&
    (!def.requires_transfer || p.transferIn !== null) &&
    (def.applies?.(c) ?? true);
  const refuse = (def: DefectDefinition, i: number, why: string) =>
    new RangeError(`${def.id} cannot be planted on loan ${i}: ${why}`);
  for (const req of opts.defects) {
    const r = typeof req === "string" ? { id: req } : req;
    const def = defectById(r.id);
    const rate =
      r.rate ??
      cal.rates.defects.field_error_rates[def.id] ??
      cal.rates.defects.field_error_rates[def.field] ??
      cal.rates.defects.field_error_rates["*"] ??
      0;
    const h = def.history;
    if (h === null && (r.at !== undefined || r.with !== undefined))
      throw new RangeError(`${def.id} enters at boarding: it takes no date and no second loan`);
    if (r.with !== undefined && !(h?.partnered && r.loans && r.with.length === r.loans.length))
      throw new RangeError(
        `${def.id}: "with" names the loan each of "loans" lands on, for an error that moves money between loans`,
      );
    const check = (i: number) => {
      const p = prepared[i];
      if (!p) throw new RangeError(`${def.id}: loan ${i} is not in a book of ${sc.loans}`);
      if (!def.eligible(p.draw))
        throw refuse(def, i, `${def.title.toLowerCase()} needs a note it applies to`);
      if (def.requires_transfer && p.transferIn === null)
        throw refuse(
          def,
          i,
          h === null
            ? "it enters through a transfer package, and the loan was never transferred"
            : "it is made on a loan transferred to us, and this one never was",
        );
      if (def.applies && !def.applies(loans[i]!))
        throw refuse(def, i, `its history lacks what the defect needs (${def.title})`);
    };
    if (h === null) {
      const targets =
        r.loans ??
        prepared.flatMap((p, i) => {
          if (!fits(def, p, loans[i]!)) return [];
          const units = def.units?.(loans[i]!) ?? 1;
          const chance = units === 1 ? rate : 1 - Math.pow(1 - rate, units);
          return rngFor(`${key}/defects/${def.id}/${i}`).next() < chance ? [i] : [];
        });
      for (const i of targets) {
        check(i);
        entryOf(i, def);
      }
      continue;
    }
    const at = r.at === undefined ? null : plainDate(r.at.length === 7 ? `${r.at}-01` : r.at);
    const make = (i: number, k: string, partner: number | null): boolean => {
      const made = h.make({
        loans,
        index: i,
        key: k,
        partner,
        r: rngFor(`${key}/defects/${def.id}/${i}/${k}`),
      });
      if (!made) return false;
      for (const x of made) {
        if (x.index !== i) check(x.index);
        const e = entryOf(x.index, def);
        e.errors.push(x.error);
        e.roots.push(x.root);
      }
      return true;
    };
    if (r.loans) {
      r.loans.forEach((i, n) => {
        check(i);
        const events = h.candidates(loans[i]!).filter((c) => at === null || c.on >= at);
        const event =
          at !== null
            ? events[0]
            : events.length
              ? events[rngFor(`${key}/defects/${def.id}/${i}/event`).int(0, events.length - 1)]
              : undefined;
        if (!event)
          throw refuse(
            def,
            i,
            `its history has nothing it can be made on${at ? ` from ${at}` : ""}`,
          );
        if (!make(i, event.key, r.with?.[n] ?? null))
          throw refuse(
            def,
            i,
            `it cannot be made on ${event.key}: no loan it can land on that day`,
          );
      });
      continue;
    }
    prepared.forEach((p, i) => {
      if (!fits(def, p, loans[i]!)) return;
      for (const c of h.candidates(loans[i]!))
        if (
          (at === null || c.on >= at) &&
          rngFor(`${key}/defects/${def.id}/${i}/${c.key}/at`).next() < rate
        )
          make(i, c.key, null);
    });
  }
  const planted: Planted[] = [];
  const labels: DefectLabel[] = [];
  const twins = new Map<string, LoanLife>();
  // The observer sees the twin the book carries; the one-defect twins that only sort a pair's symptoms are not shown.
  const twinOf = (
    p: Prepared,
    clean: LoanLife,
    es: readonly Entry[],
    observe?: (m: LifeMoment) => void,
  ) => {
    const prior = es.flatMap((e) => (e.def.priorHistory ? [e.def.priorHistory(clean)] : []));
    if (prior.length > 1)
      throw new RangeError(
        `${clean.loan_id}: one change to the prior servicer's history at a time`,
      );
    return simulateLoan(ctx, p.draw, p.lines, p.script, p.transferIn, {
      boarded: (t) => es.reduce((x, e) => e.def.boarded(x, p.draw), t),
      ...(prior[0] ? { history: prior[0] } : {}),
      ...(es.some((e) => e.errors.length > 0) ? { errors: es.flatMap((e) => e.errors) } : {}),
      ...(observe ? { observe } : {}),
    });
  };
  for (const [i, unsorted] of [...placed].sort((a, b) => a[0] - b[0])) {
    // In the registry's keys' order, which is the ids' but for the two forms of D-25.
    const es = [...unsorted].sort((a, b) => {
      const [ka, kb] = [defectKey(a.def), defectKey(b.def)];
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const p = prepared[i]!;
    const observe = opts.observe;
    const c = loans[i]!;
    const twin = twinOf(p, c, es, observe ? (m) => observe(i, "twin", m) : undefined);
    twins.set(c.loan_id, twin);
    for (const { def, roots } of es) {
      if (def.history === null) {
        const root = rootLabel(twin, def, c);
        planted.push({ loan: c.loan_id, index: i, defect_id: def.id, on: root.on });
        labels.push(root);
        continue;
      }
      for (const x of roots) {
        planted.push({ loan: c.loan_id, index: i, defect_id: def.id, on: x.on });
        labels.push({
          loan: c.loan_id,
          defect_id: def.id,
          ...x,
          expected_handling: def.handling,
          root_cause: true,
        });
      }
    }
    // A history error's root is a row of the history, which the comparison finds again: it is the root, not a symptom.
    const rooted = new Set(es.flatMap((e) => e.roots.map(placeOf)));
    const diff = (t: LoanLife) => differences(c, t).filter((x) => !rooted.has(placeOf(x)));
    if (es.length === 1) {
      const def = es[0]!.def;
      for (const x of diff(twin))
        labels.push({
          loan: c.loan_id,
          defect_id: def.id,
          ...x,
          expected_handling: def.symptomHandling(x.file_or_table, x.field, x.row),
          root_cause: false,
        });
      continue;
    }
    // Two defects on one loan: a symptom belongs to each defect whose own twin shows it, and to the pair when
    // neither does alone (the two meet: a fee on a payment that only the missing escrow made short).
    const defs = es.map((e) => e.def);
    const alone = es.map((e) => ({
      def: e.def,
      at: new Set(diff(twinOf(p, c, [e])).map(placeOf)),
    }));
    for (const x of diff(twin)) {
      const owners = alone.filter((a) => a.at.has(placeOf(x))).map((a) => a.def);
      const base = { loan: c.loan_id, ...x, root_cause: false };
      if (owners.length === 0)
        labels.push({
          ...base,
          defect_id: defs.map((d) => d.id).join("+"),
          expected_handling: `Downstream of ${defs.map((d) => d.id).join(" and ")} together: corrects when both are.`,
        });
      for (const def of owners)
        labels.push({
          ...base,
          defect_id: def.id,
          expected_handling: def.symptomHandling(x.file_or_table, x.field, x.row),
        });
    }
  }
  const defective: LifeBook = { ...clean, loans: loans.map((l) => twins.get(l.loan_id) ?? l) };
  return { clean, defective, planted, labels };
}
