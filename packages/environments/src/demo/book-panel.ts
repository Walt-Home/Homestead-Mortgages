/**
 * The demo page's book panel: a book the life generator draws from
 * calibration.json, read against every test in calibration-acceptance.json.
 *
 * Each test gives our figure, the public figure (or the design choice) it is
 * held to, the tolerance and whether the book is within it. A test the book
 * cannot be read on says why instead of passing or failing: a figure the
 * generator does not make yet (returned payments, call notes, foreclosure) or
 * a target that describes another kind of book (loan ages, for a book that
 * starts at origination). The book is smaller than most tests' sample floors,
 * and each row says whether its floor is met: a figure below its floor is
 * read for direction, not as a verdict.
 *
 * The readings follow calibrationCheck and the calibration's own tests: the
 * payment shares over installments on loans current at the due date, the
 * arrival bins on due dates that are a business day following one, the
 * quarter-end readings after the book's first year. Where a test's measure
 * needs a counting rule the acceptance file does not state, the row says the
 * rule it was read with.
 */

import type { Calibration, CalibrationFile, CalibrationKey } from "../life/calibration.js";
import { arrivals, calibrationCheck, type ArrivalRow, type CheckRow } from "../life/check.js";
import { DEFECTS } from "../life/defects.js";
import { generate, type LifeBook } from "../life/generate.js";
import type { LoanLife } from "../life/simulate.js";

/* ── the acceptance file ─────────────────────────────────────────────────── */

export interface AcceptanceTest {
  readonly id: string;
  readonly measure: string;
  readonly key: CalibrationKey;
  readonly reads?: readonly CalibrationKey[];
  readonly target: Readonly<Record<string, unknown>> & {
    readonly path?: string;
    readonly compare: string;
    readonly formula?: string;
    readonly expected?: number;
    readonly also?: string;
  };
  readonly sample_floor: { readonly count: number; readonly of: string };
  readonly tolerance: {
    readonly value: number;
    readonly unit: string;
    readonly kind: string;
    readonly reason: string;
  };
}

export interface AcceptanceFile {
  readonly version: string;
  readonly calibration_version: string;
  readonly sample: string;
  readonly tests: readonly AcceptanceTest[];
}

/* ── what the page shows ─────────────────────────────────────────────────── */

export interface PageBookPart {
  readonly label: string;
  readonly ours: string;
  readonly target: string;
  readonly tolerance: string;
  /** null: not measured, and `note` says why. */
  readonly pass: boolean | null;
}

export interface PageBookRow {
  readonly id: string;
  readonly measure: string;
  readonly key: string;
  /** The target's provenance: the calibration entry's kind, or the acceptance file's own design choice. */
  readonly kind: "public" | "design choice";
  readonly parts: readonly PageBookPart[];
  readonly pass: boolean | null;
  readonly floor: {
    readonly count: number;
    readonly of: string;
    readonly ours: number | null;
    readonly met: boolean | null;
  };
  readonly note: string;
}

export interface PageBook {
  readonly seed: string;
  readonly loans: number;
  readonly loan_years: number;
  readonly receipts: number;
  readonly late_charges: number;
  readonly analyses: number;
  readonly contacts: number;
  readonly calibration_version: string;
  readonly acceptance_version: string;
  readonly rows: readonly PageBookRow[];
  readonly passed: number;
  readonly failed: number;
  readonly unmeasured: number;
}

/* ── reading ─────────────────────────────────────────────────────────────── */

const at = (v: unknown, path: string): unknown =>
  path === ""
    ? v
    : path
        .split(".")
        .reduce<unknown>(
          (x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined),
          v,
        );
const num = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what} is not a number`);
  return v;
};

const pct = (x: number, places = 2) => `${(x * 100).toFixed(places)}%`;
const pts = (x: number) => `±${(x * 100).toFixed(1)} pts`;
const rel = (x: number) => `±${Math.round(x * 100)}%`;
const fixed = (x: number, places = 2) => x.toFixed(places);
const dollars = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}`;

const within = (ours: number, target: number, tol: number, kind: "abs" | "rel"): boolean =>
  kind === "abs"
    ? Math.abs(ours - target) <= tol + 1e-12
    : Math.abs(ours / target - 1) <= tol + 1e-12;

/** Failed when any part failed, passed when every part passed, and otherwise not a verdict. */
const overall = (parts: readonly PageBookPart[]): boolean | null =>
  parts.some((p) => p.pass === false) ? false : parts.every((p) => p.pass === true) ? true : null;

/** ln C(n, k) p^k (1-p)^(n-k), summed into the central interval a count must fall in. */
function binomialInterval(n: number, p: number, confidence: number): [number, number] {
  if (n === 0) return [0, 0];
  const lnFact: number[] = [0];
  for (let i = 1; i <= n; i++) lnFact.push(lnFact[i - 1]! + Math.log(i));
  const pmf = (k: number) =>
    p === 0
      ? k === 0
        ? 1
        : 0
      : Math.exp(
          lnFact[n]! - lnFact[k]! - lnFact[n - k]! + k * Math.log(p) + (n - k) * Math.log(1 - p),
        );
  const tail = (1 - confidence) / 2;
  let lo = 0;
  let acc = pmf(0);
  while (acc < tail && lo < n) acc += pmf(++lo);
  let hi = n;
  acc = pmf(n);
  while (acc < tail && hi > 0) acc += pmf(--hi);
  return [lo, hi];
}

const STATUS_OF: Readonly<Record<string, "current" | "d30" | "d60" | "d90_plus">> = {
  current: "current",
  "30": "d30",
  "60": "d60",
  "90": "d90_plus",
  "120+": "d90_plus",
};
const isOpen = (s: string) => s === "current" || s === "delinquent";

export interface BookPanelOptions {
  /** calibration.json, read. */
  readonly calibration: Calibration;
  /** calibration.json as written, for the values the tests read by path. */
  readonly file: CalibrationFile;
  readonly acceptance: AcceptanceFile;
  readonly loans: number;
  readonly seed: string;
}

export function bookPanel(o: BookPanelOptions): PageBook {
  const cal = o.calibration;
  const value = (key: CalibrationKey) => {
    const e = o.file.rates[key];
    if (!e) throw new Error(`calibration.json has no ${key}`);
    return e.value;
  };
  const kindOf = (key: CalibrationKey): "public" | "design choice" =>
    o.file.rates[key]?.kind === "public" ? "public" : "design choice";

  // Every defect the registry holds, planted at the file's rate over its eligible loans.
  const res = generate(
    o.seed,
    { loans: o.loans },
    { calibration: cal, defects: Object.keys(DEFECTS) },
  );
  const book: LifeBook = res.clean;
  const loans = book.loans;
  const check = calibrationCheck(book, cal);
  const row = (key: CalibrationKey, use: CheckRow["use"]) => {
    const r = check.find((x) => x.key === key && x.use === use);
    if (!r) throw new Error(`calibrationCheck has no ${use} row for ${key}`);
    return r;
  };
  const arrived = arrivals(book);
  const clear = arrived.filter((a) => a.clear);
  const openMonths = loans.flatMap((l) => l.months.filter((m) => isOpen(m.status)));
  const loanYears = openMonths.length / 12;
  const borrowerReceipts = loans.flatMap((l) =>
    l.receipts.filter((r) => r.mode !== "partial_rest" && r.mode !== "payoff"),
  );
  const contacts = loans.flatMap((l) => l.contacts);
  const fees = loans.reduce((s, l) => s + l.fees.length, 0);

  const floorOurs: Readonly<Record<string, number>> = {
    installments: arrived.length,
    "loan-years": loanYears,
    receipts: borrowerReceipts.length,
    "loan-months": arrived.length,
    loans: loans.length,
    "conventional loans": loans.length,
    "escrowed loans": loans.filter((l) => l.draw.escrowed).length,
    calls: contacts.length,
    "complaint or error-notice contacts": contacts.length,
  };

  // Quarter-ends after the book's first year, over loans open at each.
  const firstMonth = loans.reduce(
    (m, l) => (l.months[0]!.month < m ? l.months[0]!.month : m),
    "9999-99",
  );
  const afterYear = `${Number(firstMonth.slice(0, 4)) + 1}${firstMonth.slice(4)}`;
  const quarterEnds = new Map<
    string,
    { open: number; d30: number; d60: number; d90_plus: number }
  >();
  for (const l of loans)
    for (const m of l.months) {
      if (
        !isOpen(m.status) ||
        m.month < afterYear ||
        !["03", "06", "09", "12"].includes(m.month.slice(5))
      )
        continue;
      const q = quarterEnds.get(m.month) ?? { open: 0, d30: 0, d60: 0, d90_plus: 0 };
      q.open++;
      const s = STATUS_OF[m.mba_status];
      if (s && s !== "current") q[s]++;
      quarterEnds.set(m.month, q);
    }
  const qAvg = (k: "d30" | "d60" | "d90_plus" | "all") => {
    const qs = [...quarterEnds.values()];
    return (
      qs.reduce(
        (s, q) => s + (k === "all" ? q.d30 + q.d60 + q.d90_plus : q[k]) / Math.max(1, q.open),
        0,
      ) / Math.max(1, qs.length)
    );
  };

  const rows: PageBookRow[] = [];
  for (const t of o.acceptance.tests) {
    const parts: PageBookPart[] = [];
    let note = "";
    let kind = kindOf(t.key);
    const tv = t.tolerance.value;
    const part = (
      label: string,
      ours: number | null,
      target: number,
      kindOfTol: "abs" | "rel",
      fmt: (x: number) => string,
      tolText: string,
    ) =>
      parts.push({
        label,
        ours: ours === null ? "not made" : fmt(ours),
        target: fmt(target),
        tolerance: tolText,
        pass: ours === null ? null : within(ours, target, tv, kindOfTol),
      });
    switch (t.id) {
      case "payment-arrival-day": {
        const bins = at(value(t.key), t.target.path ?? "") as Record<string, number>;
        const share = (f: (a: ArrivalRow) => boolean) =>
          clear.filter(f).length / Math.max(1, clear.length);
        const inGrace = (lo: number, hi: number) => (a: ArrivalRow) =>
          a.arrival === "within_grace" &&
          Number(a.on!.slice(8, 10)) >= lo &&
          Number(a.on!.slice(8, 10)) <= hi;
        const ours: Record<string, number> = {
          before_due: share((a) => a.arrival === "before_due"),
          due_day: share((a) => a.arrival === "due_day"),
          days_2_to_5: share(inGrace(2, 5)),
          days_6_to_10: share(inGrace(6, 10)),
          // Grace that ends on a day off runs to the next business day, and a payment then is still within it.
          days_11_to_16: share(inGrace(11, 31)),
          days_17_to_month_end: share((a) => a.arrival === "after_grace"),
          not_in_month: share((a) => a.arrival === "not_in_month"),
        };
        for (const [bin, target] of Object.entries(bins))
          part(bin.replace(/_/g, " "), ours[bin] ?? null, target, "abs", (x) => pct(x, 1), pts(tv));
        note =
          "Read on due dates that are a business day following one, as the calibration's own test reads them. The bins are a design choice: no public source gives the day a payment arrives.";
        break;
      }
      case "payment-within-grace": {
        const r = row("payment.late_within_grace_share", "drawn");
        part(
          "within grace",
          r.realized,
          num(value(t.key), t.key),
          "abs",
          (x) => pct(x, 1),
          pts(tv),
        );
        break;
      }
      case "late-fees-per-loan-year": {
        const r = row("payment.late_after_grace_share", "drawn");
        part(
          "late charges a loan-year",
          12 * r.realized,
          num(t.target.expected, t.id),
          "rel",
          (x) => fixed(x, 3),
          rel(tv),
        );
        note = "Twelve times the share of installments on current loans that drew a late charge.";
        break;
      }
      case "partial-payments": {
        const r = row("payment.partial_share", "drawn");
        part(
          "short receipts",
          r.realized,
          num(at(value(t.key), t.target.path ?? ""), t.id),
          "rel",
          (x) => pct(x, 2),
          rel(tv),
        );
        break;
      }
      case "returned-payments": {
        part(
          "returned receipts",
          0,
          num(at(value(t.key), t.target.path ?? ""), t.id),
          "rel",
          (x) => pct(x, 2),
          rel(tv),
        );
        note =
          "Fails: the generator returns no payment yet. It reads the share and does not draw it, and no environment posts a returned debit yet.";
        break;
      }
      case "missed-months": {
        const r = row("payment.missed_month_share", "check");
        part(
          "months with nothing received",
          r.realized,
          num(value(t.key), t.key),
          "rel",
          (x) => pct(x, 2),
          rel(tv),
        );
        note =
          "Not drawn, so it is read as a check. The public quarterly roll makes a current borrower miss about 0.36% of months; the file's 1.2% is a design choice its own note bounds below at 0.28%. Drawing it would put three times the New York Fed's roll on the book.";
        break;
      }
      case "delinquency-stock": {
        const v = value(t.key);
        const buckets = at(v, t.target.path ?? "") as Record<string, number>;
        for (const b of ["d30", "d60", "d90_plus"] as const)
          part(
            b.replace("d", "").replace("_plus", "+") + " days",
            qAvg(b),
            num(buckets[b], b),
            "abs",
            (x) => pct(x, 2),
            pts(tv),
          );
        parts.push({
          label: "total",
          ours: pct(qAvg("all")),
          target: pct(num(at(v, "total"), "total")),
          tolerance: pts(0.01),
          pass: Math.abs(qAvg("all") - num(at(v, "total"), "total")) <= 0.01 + 1e-12,
        });
        note =
          "The target is all loans, FHA and VA among them; this book is conventional only, so it should sit below it. The next row is the conventional figure.";
        break;
      }
      case "conventional-delinquency": {
        part(
          "one payment or more past due",
          qAvg("all"),
          num(value(t.key), t.key),
          "abs",
          (x) => pct(x, 2),
          pts(tv),
        );
        note =
          "Averaged over the quarter-ends after the book's first year. A monthly cure of 16% against a repeat miss of 33% runs deeper than MBA's buckets show.";
        break;
      }
      case "quarterly-transitions": {
        const roll = row("delinquency.roll_current_to_30", "check");
        const cure = row("delinquency.cure_from_30", "check");
        const v = value(t.key);
        const target = num(at(v, "trailing_8_quarter_mean.to_30_60_late"), "roll");
        const cureTarget = num(
          at(value("delinquency.cure_from_30"), "trailing_8_quarter_mean.to_current"),
          "cure",
        );
        parts.push({
          label: "current → 30 to 60 days",
          ours: pct(roll.realized),
          target: pct(target),
          tolerance: rel(tv),
          pass: within(roll.realized, target, tv, "rel"),
        });
        parts.push({
          label: "30 to 60 days → current",
          ours: pct(cure.realized, 1),
          target: pct(cureTarget, 1),
          tolerance: pts(0.08),
          pass: within(cure.realized, cureTarget, 0.08, "abs"),
        });
        note =
          "Each quarter-end against the next. A quarter-end also finds loans behind that missed nothing (the rest of a partial still to come), so the roll reads above the monthly chain's.";
        break;
      }
      case "contacts-per-loan-year-by-status": {
        const byStatus = at(t.target, "by_status_per_loan_year") as Record<string, number>;
        const months = { current: 0, d30: 0, d60: 0, d90_plus: 0 };
        const calls = { current: 0, d30: 0, d60: 0, d90_plus: 0 };
        for (const l of loans) {
          const status = new Map(l.months.map((m) => [m.month, m]));
          for (const m of l.months)
            if (isOpen(m.status)) months[STATUS_OF[m.mba_status] ?? "current"]++;
          for (const c of l.contacts) {
            const m = status.get(c.on.slice(0, 7));
            if (m && isOpen(m.status)) calls[STATUS_OF[m.mba_status] ?? "current"]++;
          }
        }
        part(
          "all loans",
          contacts.length / loanYears,
          num(at(value(t.key), "inquiries_per_loan_year"), t.id),
          "abs",
          (x) => fixed(x, 2),
          `±${tv} a loan-year`,
        );
        for (const s of ["current", "d30", "d60", "d90_plus"] as const) {
          const ours = months[s] > 0 ? calls[s] / (months[s] / 12) : null;
          parts.push({
            label: `${s === "current" ? "current" : s.replace("d", "").replace("_plus", "+") + " days"} (design choice)`,
            ours: ours === null ? "no loan-months" : fixed(ours, 2),
            target: fixed(num(byStatus[s], s), 1),
            tolerance: "±25%",
            pass: ours === null ? null : within(ours, num(byStatus[s], s), 0.25, "rel"),
          });
        }
        parts.push({
          label: "foreclosure (design choice)",
          ours: "none generated",
          target: fixed(num(byStatus["foreclosure"], "foreclosure"), 1),
          tolerance: "±25%",
          pass: null,
        });
        note =
          "Each call is counted in the status of its month's month-end. The book's calls are the borrower's own: a borrower who is behind calls three times as often, and nothing else rises with delinquency until the servicer's outreach and loss-mitigation follow-up are generated. The split by status is the acceptance file's design choice; the CFPB gives none.";
        break;
      }
      case "contact-reason-mix": {
        const shares = at(value(t.key), t.target.path ?? "") as Record<string, number>;
        const counts = new Map<string, number>();
        for (const c of contacts) counts.set(c.reason, (counts.get(c.reason) ?? 0) + 1);
        for (const [reason, target] of Object.entries(shares))
          part(
            reason.replace(/_/g, " "),
            (counts.get(reason) ?? 0) / Math.max(1, contacts.length),
            target,
            "abs",
            (x) => pct(x, 1),
            pts(tv),
          );
        const top = (m: Record<string, number>) =>
          Object.entries(m)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([k]) => k);
        const ourTop = top(Object.fromEntries(counts));
        parts.push({
          label: "the three largest, in order",
          ours: ourTop.map((k) => k.replace(/_/g, " ")).join(", "),
          target: top(shares)
            .map((k) => k.replace(/_/g, " "))
            .join(", "),
          tolerance: "same order",
          pass: ourTop.join() === top(shares).join(),
        });
        kind = "public";
        note =
          "The mix is of complaints, a skewed proxy for why people call: every call draws its reason from it, so disputes are as common in a current borrower's calls as in complaints.";
        break;
      }
      case "call-note-length": {
        const v = value(t.key) as { min: number; max: number };
        const byMonth = new Map<string, { n: number; minutes: number }>();
        for (const c of contacts) {
          const m = c.on.slice(0, 7);
          const x = byMonth.get(m) ?? { n: 0, minutes: 0 };
          x.n++;
          x.minutes += c.minutes;
          byMonth.set(m, x);
        }
        const avgs = [...byMonth.values()].map((x) => x.minutes / x.n);
        const lo = Math.min(...avgs);
        const hi = Math.max(...avgs);
        parts.push({
          label: "each month's average handle time",
          ours: `${fixed(lo, 1)} to ${fixed(hi, 1)} min`,
          target: `${v.min} to ${v.max} min`,
          tolerance: `±${tv} min`,
          pass: lo >= v.min - tv && hi <= v.max + tv,
        });
        parts.push({
          label: "median note length (design choice)",
          ours: "no notes yet",
          target: "150 to 800 characters",
          tolerance: "inside the band",
          pass: null,
        });
        note =
          "Half measured: call notes and transcripts arrive in a later wave, with the contacts layer. The handle time is the public part.";
        break;
      }
      case "transactions-per-loan-year": {
        let tx = 0;
        for (const l of loans) {
          for (const r of l.receipts) {
            if (r.mode === "payoff") continue;
            tx += 1;
            if (r.curtailment > 0n) tx += 1;
          }
          tx += l.fees.length;
          tx += l.disbursements.filter(
            (d) => d.kind === "bill" && d.line !== "mi_borrower_paid",
          ).length;
        }
        part(
          "transactions a loan-year",
          tx / loanYears,
          num(t.target.expected, t.id),
          "rel",
          (x) => fixed(x, 2),
          rel(tv),
        );
        kind = "design choice";
        note =
          "Counted as every receipt (each half of a partial), one more for each that carried extra principal, every late charge, and every tax, hazard and flood disbursement; the monthly mortgage-insurance premium, which the formula leaves out, is not counted. The target is a formula over design choices.";
        break;
      }
      case "defect-rates-by-field": {
        const rates = value(t.key) as Record<string, { rate: number; field: string; per: string }>;
        const planted = new Map<string, number>();
        for (const p of res.planted) planted.set(p.defect_id, (planted.get(p.defect_id) ?? 0) + 1);
        const rooted = new Set(
          res.labels.filter((l) => l.root_cause).map((l) => `${l.loan}|${l.defect_id}`),
        );
        const allLabeled = res.planted.every((p) => rooted.has(`${p.loan}|${p.defect_id}`));
        let notYet = 0;
        for (const [id, r] of Object.entries(rates)) {
          const def = DEFECTS[id];
          if (!def) {
            notYet++;
            continue;
          }
          const eligible = loans.filter(
            (l: LoanLife) =>
              def.eligible(l.draw) && (!def.requires_transfer || l.transfer_in_on !== null),
          ).length;
          const k = planted.get(id) ?? 0;
          if (eligible === 0) {
            parts.push({
              label: `${id}, ${r.field}`,
              ours: "no eligible loan",
              target: `${pct(r.rate, 1)} of each ${r.per}`,
              tolerance: "99% binomial interval",
              pass: null,
            });
            continue;
          }
          const [lo, hi] = binomialInterval(eligible, r.rate, tv);
          parts.push({
            label: `${id}, ${r.field}`,
            ours: `${k} of ${eligible} eligible`,
            target: `${pct(r.rate, 1)}: ${lo} to ${hi} of ${eligible}`,
            tolerance: "99% binomial interval",
            pass: lo <= k && k <= hi && allLabeled,
          });
        }
        parts.push({
          label: `${notYet} more defects with a rate`,
          ours: "not in the generator's registry yet",
          target: "each at its own rate",
          tolerance: "99% binomial interval",
          pass: null,
        });
        note =
          "Planted at the file's rates. D-42 enters only through a transfer package, and this book's loans are ours from their first payment, so none is eligible. Every rate is a design choice until a validation sample.";
        break;
      }
      case "note-rate-distribution": {
        const buckets = at(value(t.key), t.target.path ?? "") as Record<string, number>;
        const rates = loans.map((l) => Number(l.draw.note_rate_pct));
        const inBucket: Record<string, (x: number) => boolean> = {
          lt_3: (x) => x < 3,
          "3_to_4": (x) => x >= 3 && x < 4,
          "4_to_5": (x) => x >= 4 && x < 5,
          "5_to_6": (x) => x >= 5 && x < 6,
          ge_6: (x) => x >= 6,
        };
        for (const [b, target] of Object.entries(buckets)) {
          const f = inBucket[b];
          part(
            b.replace(/_/g, " "),
            f ? rates.filter(f).length / rates.length : null,
            target,
            "abs",
            (x) => pct(x, 1),
            pts(tv),
          );
        }
        break;
      }
      case "ltv-distribution": {
        const buckets = at(value(t.key), t.target.path ?? "") as Record<string, number>;
        const ltv = loans.map((l) => l.draw.ltv_pct);
        const inBucket: Record<string, (x: number) => boolean> = {
          le_60: (x) => x <= 60,
          "60_to_70": (x) => x > 60 && x <= 70,
          "70_to_80": (x) => x > 70 && x <= 80,
          "80_to_90": (x) => x > 80 && x <= 90,
          "90_to_100": (x) => x > 90 && x <= 100,
          gt_100: (x) => x > 100,
        };
        for (const [b, target] of Object.entries(buckets)) {
          const f = inBucket[b];
          part(
            b.replace(/_/g, " "),
            f ? ltv.filter(f).length / ltv.length : null,
            target,
            "abs",
            (x) => pct(x, 1),
            pts(tv),
          );
        }
        note =
          "Fails by design for now: the generator draws loan-to-value at origination, and the target is mark-to-market, a seasoned book after house prices moved. The generator has no house-price path to meet it with.";
        break;
      }
      case "loan-age-distribution": {
        const buckets = at(value(t.key), t.target.path ?? "") as Record<string, number>;
        for (const [b, target] of Object.entries(buckets))
          parts.push({
            label: b.replace(/_/g, " "),
            ours: "not measured",
            target: pct(target, 1),
            tolerance: pts(tv),
            pass: null,
          });
        note =
          "Not measured. This book is originated from March 2026, so every loan's age is its time since then; the generator reads the age distribution only when a scenario boards a book by transfer.";
        break;
      }
      case "arm-share": {
        part(
          "adjustable-rate loans",
          loans.filter((l) => l.draw.arm).length / loans.length,
          num(at(value(t.key), t.target.path ?? ""), t.id),
          "abs",
          (x) => pct(x, 1),
          pts(tv),
        );
        note = "All loans' share, 4.3%. Enterprise loans alone are 1.1%.";
        break;
      }
      case "escrow-share": {
        part(
          "loans with an escrow account",
          loans.filter((l) => l.draw.escrowed).length / loans.length,
          num(value(t.key), t.key),
          "abs",
          (x) => pct(x, 1),
          pts(tv),
        );
        note =
          "A design choice: the ACS asks it, but only its microdata answers, which was not read.";
        break;
      }
      case "escrow-medians": {
        const escrowed = loans.filter((l) => l.draw.escrowed);
        const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
        const firstYear = (l: LoanLife, basis: string) =>
          l.draw.line_specs
            .filter((s) => s.basis === basis)
            .reduce((s, x) => s + x.first_annual, 0);
        part(
          "tax, first year",
          median(escrowed.map((l) => firstYear(l, "tax"))),
          100 * num(at(value(t.key), "with_mortgage_usd"), t.id),
          "rel",
          dollars,
          rel(tv),
        );
        part(
          "hazard insurance, first year",
          median(escrowed.map((l) => firstYear(l, "hazard"))),
          100 * num(at(value("escrow.insurance_annual_median"), "with_mortgage_usd"), t.id),
          "rel",
          dollars,
          rel(tv),
        );
        note = "The ACS medians are 2024's; the book bills its first year at them.";
        break;
      }
      default:
        parts.push({ label: t.measure, ours: "not read", target: "", tolerance: "", pass: null });
        note = "The page has no reading for this test yet.";
    }
    const floorOurs0 = floorOurs[t.sample_floor.of];
    rows.push({
      id: t.id,
      measure: t.measure,
      key: t.key,
      kind,
      parts,
      pass: overall(parts),
      floor: {
        count: t.sample_floor.count,
        of: t.sample_floor.of,
        ours: floorOurs0 === undefined ? null : Math.round(floorOurs0),
        met: floorOurs0 === undefined ? null : floorOurs0 >= t.sample_floor.count,
      },
      note,
    });
  }

  return {
    seed: o.seed,
    loans: loans.length,
    loan_years: Math.round(loanYears),
    receipts: borrowerReceipts.length,
    late_charges: fees,
    analyses: loans.reduce((s, l) => s + l.analyses.length, 0),
    contacts: contacts.length,
    calibration_version: cal.version,
    acceptance_version: o.acceptance.version,
    rows,
    passed: rows.filter((r) => r.pass === true).length,
    failed: rows.filter((r) => r.pass === false).length,
    unmeasured: rows.filter((r) => r.pass === null).length,
  };
}
