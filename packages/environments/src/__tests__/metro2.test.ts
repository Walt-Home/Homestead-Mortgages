/**
 * metro2-furnishing: the grader is the servicing app's Metro 2 engine and no
 * other (each port is its file byte for byte but the import statements, and
 * the ledger is pmi's port of the same file), and the conventions it
 * restates are held to the servicing app's own lines; it gives §8.1's worked
 * example and test cases to the character; every generated window can be
 * furnished from the rulebook and the tools, on unfiltered draws too; the
 * guard keeps out each place the engine departs from its spec, each
 * reproduced here; and each edge and configuration that decides an answer
 * turns up.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  addDays,
  addMonths,
  daysBetween,
  parts,
  plainDate,
  type PlainDate,
} from "@hm/kernel/calendar";
import { balanceAfter } from "@hm/refi-review";
import { describe, expect, it } from "vitest";
import { runEpisode } from "../episode.js";
import { sha256, toJsonLine } from "../record.js";
import { rngFor } from "../rng.js";
import { applyFifo } from "../pmi/ported/delinquency.js";
import {
  METRO2_EDGES,
  METRO2_HELDOUT_SUITE,
  METRO2_RULEBOOK,
  METRO2_SPEC_CASES,
  Metro2ReferencePolicy,
  asOfOf,
  delinquencyBegan,
  drawMetro2Candidate,
  drawMetro2Task,
  expectedMetro2,
  furnish,
  generateMetro2Suite,
  generateMetro2Task,
  gradeMetro2Against,
  ledgerAsOf,
  metro2EdgeOf,
  metro2FairToGrade,
  metro2Furnishing,
  metro2InScope,
  metro2OutOfScope,
  metro2Payload,
  metro2SpecTasks,
  metro2TaskId,
  parseMetro2Submission,
  referralEnded,
  stateFor,
  type ConsumerAnswer,
  type FurnishedRecord,
  type InForce,
  type Metro2Answer,
  type Metro2Month,
  type Metro2Task,
  type MonthRecord,
} from "../metro2/index.js";
import {
  buildSnapshot,
  carryPhp,
  metro2Money,
  paymentRatingForDays,
  renderBase,
  statusForDays,
} from "../metro2/ported/metro2.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * A file's import statements, each joined onto one line (metro2.ts:10-13 spans four), and the rest of
 * the file. A statement ends on the line that names its module.
 */
function split(text: string): { imports: string[]; body: string } {
  const imports: string[] = [];
  const body: string[] = [];
  let open: string[] | null = null;
  for (const line of text.split("\n")) {
    if (open) {
      open.push(line);
      if (/ from "[^"]+";$/.test(line)) {
        imports.push(open.join("\n"));
        open = null;
      }
    } else if (line.startsWith("import ")) {
      if (/ from "[^"]+";$/.test(line)) imports.push(line);
      else open = [line];
    } else body.push(line);
  }
  return { imports, body: body.join("\n") };
}
/** The three rewrites a port may carry (PORTED_FROM). */
const rewritten = (statement: string) =>
  statement
    .replace(/"\.\.\/\.\.\/kernel\/(calendar|money)\/[a-z-]+\.ts"/g, '"@hm/kernel/$1"')
    .replace(/"\.\/([a-z0-9-]+)\.ts"/g, '"./$1.js"')
    .replace(/"\.\.\/boarding\/([a-z-]+)\.ts"/g, '"../../pmi/ported/$1.js"');
/** Each statement with its module path removed: what it imports, and how. */
const heads = (statements: string[]) => statements.map((s) => s.replace(/ from "[^"]+";$/, ""));

const service = (file: string) =>
  readFileSync(here(`../../../../apps/servicing/src/domain/${file}`), "utf8").split("\n");
/** A run of service lines, found by what the first holds, with the lines the grader cites them by. */
const serviceLines = (file: string, first: string, n: number) => {
  const all = service(file);
  const start = all.findIndex((l) => l.includes(first));
  if (start < 0) return `${file}: no line holding ${first}`;
  return [`${file}:${start + 1}-${start + n}`, ...all.slice(start, start + n)].join("\n");
};

const solveAll = async (tasks: readonly Metro2Task[]) => {
  const misses: string[] = [];
  let turns = 0;
  let calls = 0;
  for (const task of tasks) {
    const r = await runEpisode(metro2Furnishing, task, new Metro2ReferencePolicy());
    turns = Math.max(turns, r.turns);
    calls = Math.max(calls, r.tool_calls);
    if (!r.grade.pass) {
      const wrong = r.grade.fields
        .filter((f) => !f.ok)
        .map((f) => `${f.field} ${f.expected}/${f.got}`);
      misses.push(`${task.id} ${r.outcome} ${r.error ?? ""} ${wrong.join("; ")}`);
    }
  }
  return { misses, turns, calls };
};

/** The spec's cases, by their place in METRO2_SPEC_CASES (the test below holds the names to it). */
const SPEC = metro2SpecTasks();
const furnished = (r: MonthRecord | undefined): FurnishedRecord => {
  if (!r || !r.furnished) throw new Error("not furnished");
  return r;
};
const recordsOf = (t: Metro2Task) => expectedMetro2(t).records.map((r) => furnished(r));
const d = (s: string) => plainDate(s);
const P = 245_955n;
const forbearanceMay: InForce = {
  kind: "forbearance_plan",
  effective_on: plainDate("2027-05-01"),
  plan_payment_cents: 0n,
};
const referredJune: InForce = {
  kind: "foreclosure_referral",
  referred_on: plainDate("2027-06-10"),
};

/** A spec task with some of its months changed, or with months added after its window, each a copy of its last. */
function variant(
  t: Metro2Task,
  change: {
    months?: Record<string, { books?: Partial<Metro2Month["books"]>; in_force?: InForce[] }>;
    add?: readonly string[];
    receipts?: readonly (readonly [string, bigint])[];
    policy?: Partial<Metro2Task["policy"]>;
  },
): Metro2Task {
  const last = t.months[t.months.length - 1]!;
  const months = [...t.months, ...(change.add ?? []).map((month) => ({ ...last, month }))].map(
    (m) => {
      const c = change.months?.[m.month];
      return c
        ? { ...m, books: { ...m.books, ...c.books }, in_force: c.in_force ?? m.in_force }
        : m;
    },
  );
  const receipts = [
    ...t.receipts,
    ...(change.receipts ?? []).map(([on, amount]) => ({
      received_on: d(on),
      amount_cents: amount,
    })),
  ].sort((a, b) => (a.received_on < b.received_on ? -1 : a.received_on > b.received_on ? 1 : 0));
  return { ...t, months, receipts, policy: { ...t.policy, ...change.policy } };
}

const CLOSING_KINDS = ["payoff", "short_sale", "foreclosure_sale", "deed_in_lieu"];
const PHP_CHAR: Readonly<Record<string, string>> = {
  "11": "0",
  "71": "1",
  "78": "2",
  "80": "3",
  "82": "4",
  "83": "5",
  "84": "6",
};
const m2date = (x: PlainDate | null) =>
  x === null ? "00000000" : `${x.slice(5, 7)}${x.slice(8, 10)}${x.slice(0, 4)}`;

/**
 * An answer that never applies a receipt and never counts a day: every month-end is taken as current
 * (status 11 but for a closing or a workout's, nothing past due but a repayment plan's arrears, no DOFD,
 * a closing rated 0), and everything else is read off the task by the rulebook: the special comment, the
 * balance, payment, terms and K4 off the books and what is in force, the month's receipts summed, the
 * identifiers checked, the PHP carried with D for an omitted month, and the consumers' segments.
 */
function readingOnly(t: Metro2Task): Metro2Answer {
  const round = t.policy.metro2_rounding === "round";
  const money = (c: bigint) => metro2Money(c, round ? "round" : "truncate");
  const P_ = t.loan.pi_cents + t.loan.escrow_cents;
  let php = t.last_record
    ? (t.last_record.payment_history_profile + "B".repeat(24)).slice(0, 24)
    : null;
  let prior = t.last_record ? (PHP_CHAR[t.last_record.account_status] ?? "0") : "B";
  let special: string | null = null;
  const records: MonthRecord[] = t.months.map((m) => {
    const asOf = asOfOf(m.month);
    const here = php === null ? "B".repeat(24) : (prior + php).slice(0, 24);
    php = here;
    const errors: string[] = [];
    if (m.books.min === null) errors.push("K3_MIN_MISSING");
    else if (!/^\d{18}$/.test(m.books.min)) errors.push("MIN_NOT_18_DIGITS");
    if (!/^\d{10}$/.test(m.books.fnma_loan_number)) errors.push("K3_FNMA_LOAN_NUMBER");
    if (errors.length > 0) {
      prior = "D";
      return { month: m.month, furnished: false, hard_errors: errors.sort() };
    }
    let status = "11";
    let rating = "";
    let closed: PlainDate | null = null;
    let apd = 0n;
    let sc = "";
    let scheduled = P_;
    let balance =
      m.books.upb_cents + m.books.deferred_principal_cents + m.books.forborne_principal_cents;
    let terms =
      t.policy.terms_duration === "original"
        ? t.loan.original_term_months
        : m.books.remaining_term_months;
    let k4: FurnishedRecord["k4"] = null;
    const referral = m.in_force.some((e) => e.kind === "foreclosure_referral");
    let closing = false;
    for (const e of m.in_force) {
      if (e.kind === "forbearance_plan") {
        sc = "CP";
        scheduled = e.plan_payment_cents;
      } else if (e.kind === "repayment_plan") {
        apd = e.remaining_arrears_cents;
        if (e.plan_payment_cents < P_) sc = "AC";
      } else if (e.kind === "trial_plan") sc = "AC";
      else if (e.kind === "modification") {
        sc = "CO";
        scheduled = e.new_piti_cents;
        terms = e.new_term_months;
        if (m.books.forborne_principal_cents > 0n)
          k4 = {
            balloon_due_date: m2date(m.books.maturity_date),
            balloon_amount: money(m.books.forborne_principal_cents),
          };
      } else if (e.kind === "payment_deferral")
        k4 = {
          balloon_due_date: m2date(m.books.maturity_date),
          balloon_amount: money(m.books.deferred_principal_cents),
        };
      else if (CLOSING_KINDS.includes(e.kind) && "closed_on" in e) {
        closing = true;
        closed = e.closed_on;
        rating = "0";
        if (e.kind === "payoff") {
          status = "13";
          if (e.by_refinance) sc = "AS";
          balance = 0n;
        } else if (e.kind === "short_sale") {
          status = referral ? "65" : "13";
          sc = "AU";
          balance = 0n;
        } else {
          status = e.kind === "foreclosure_sale" ? "94" : "89";
          if (!e.deficiency_pursued) balance = 0n;
        }
      }
    }
    if (!closing && referral && sc === "") sc = "BO";
    const payoff = m.in_force.find((e) => e.kind === "payoff");
    const funds = payoff?.kind === "payoff" ? payoff.payoff_funds_cents : 0n;
    const paid =
      t.receipts
        .filter((r) => r.received_on.slice(0, 7) === m.month && r.received_on <= asOf)
        .reduce((a, r) => a + r.amount_cents, 0n) + funds;
    const dates = [
      ...t.receipts.filter((r) => r.received_on <= asOf).map((r) => r.received_on),
      ...(payoff && "closed_on" in payoff ? [payoff.closed_on] : []),
    ].sort();
    prior = PHP_CHAR[status] ?? "0";
    special = sc;
    return {
      month: m.month,
      furnished: true,
      account_status: status,
      payment_rating: rating,
      date_closed: m2date(closed),
      amount_past_due: money(apd),
      date_of_first_delinquency: "00000000",
      payment_history_profile: here,
      special_comment: sc,
      current_balance: money(balance),
      scheduled_monthly_payment: money(scheduled),
      terms_duration: String(terms).padStart(3, "0"),
      k4,
      actual_payment_amount: money(paid),
      date_of_last_payment: m2date(dates.at(-1) ?? null),
    };
  });
  const consumers: ConsumerAnswer[] =
    special === null
      ? []
      : t.consumers
          .filter((c) => !c.successor_in_interest)
          .sort((a, b) => a.position - b.position)
          .map((c) => ({
            party_id: c.party_id,
            segment: c.position === 1 ? "base" : c.same_address_as_base ? "J1" : "J2",
            ecoa: c.never_liable
              ? "Z"
              : c.deceased
                ? "X"
                : c.released
                  ? "T"
                  : c.liability === "guarantor"
                    ? "5"
                    : c.liability === "joint"
                      ? "2"
                      : "1",
            special_comment: c.released ? "H" : special!,
          }));
  return { records, consumers };
}

describe("metro2-furnishing", () => {
  it("grades with the servicing app's engine: each port is its file but for the import statements", () => {
    for (const file of ["metro2", "types"]) {
      const original = split(
        readFileSync(
          here(`../../../../apps/servicing/src/domain/credit-reporting/${file}.ts`),
          "utf8",
        ),
      );
      const port = split(readFileSync(here(`../metro2/ported/${file}.ts`), "utf8"));
      expect(port.body, file).toBe(original.body);
      expect(port.imports, file).toEqual(original.imports.map(rewritten));
      // The same names, imported the same way.
      expect(heads(port.imports), file).toEqual(heads(original.imports));
    }
    // metro2.ts's import from types.ts is four lines, and its last line takes the rewrite too.
    const metro2 = split(readFileSync(here("../metro2/ported/metro2.ts"), "utf8"));
    expect(metro2.imports).toHaveLength(5);
    expect(metro2.imports[4]!.split("\n")).toHaveLength(4);
    expect(metro2.imports[4]!.endsWith('} from "./types.js";')).toBe(true);
    // The ledger both files import is pmi's port of boarding/delinquency.ts, held byte for byte there too.
    const ledger = split(
      readFileSync(here("../../../../apps/servicing/src/domain/boarding/delinquency.ts"), "utf8"),
    );
    const pmi = split(readFileSync(here("../pmi/ported/delinquency.ts"), "utf8"));
    expect(pmi.body).toBe(ledger.body);
  });

  describe("gives §8.1's worked example and test cases to the character", () => {
    it("rule 13, January to April 2027: 11, 11 at 27 days with no DOFD, 71 at 58, 78 at 88 (8.1-T1, T2)", () => {
      const [jan, feb, mar, apr] = recordsOf(SPEC[0]!);
      expect(jan).toMatchObject({
        account_status: "11",
        amount_past_due: "000000000",
        date_of_first_delinquency: "00000000",
        current_balance: "000293063",
        scheduled_monthly_payment: "000002459",
        actual_payment_amount: "000002459",
        payment_history_profile: "0000000000000000000000BB",
      });
      expect(feb).toMatchObject({
        account_status: "11",
        amount_past_due: "000002459",
        date_of_first_delinquency: "00000000",
      });
      expect(feb!.payment_history_profile[0]).toBe("0");
      expect(mar).toMatchObject({
        account_status: "71",
        date_of_first_delinquency: "02012027",
        amount_past_due: "000004919",
      });
      expect(mar!.payment_history_profile[0]).toBe("0");
      expect(apr).toMatchObject({ account_status: "78", amount_past_due: "000007378" });
      expect(apr!.payment_history_profile.slice(0, 3)).toBe("100");
    });

    it("the forbearance frozen at 78 + CP, then the Payment Deferral's August (8.1-T3, T4)", () => {
      const [may, jun, jul, aug] = recordsOf(SPEC[1]!);
      for (const r of [may, jun, jul])
        expect(r).toMatchObject({
          account_status: "78",
          special_comment: "CP",
          amount_past_due: "000007378",
          scheduled_monthly_payment: "000000000",
          date_of_first_delinquency: "02012027",
        });
      expect(jul!.payment_history_profile.slice(0, 6)).toBe("222100");
      expect(aug).toEqual({
        month: "2027-08",
        furnished: true,
        account_status: "11",
        payment_rating: "",
        date_closed: "00000000",
        amount_past_due: "000000000",
        date_of_first_delinquency: "00000000",
        payment_history_profile: "222210000000000000000000",
        special_comment: "",
        current_balance: "000307500",
        scheduled_monthly_payment: "000002459",
        terms_duration: "360",
        k4: { balloon_due_date: "02012055", balloon_amount: "000014757" },
        actual_payment_amount: "000002459",
        date_of_last_payment: "08102027",
      });
    });

    it("the same months under contractual aging: 80, 82, 84 and PHP 43210 (8.1-T3)", () => {
      const rs = recordsOf(SPEC[2]!);
      expect(rs.map((r) => r.account_status)).toEqual(["80", "82", "84"]);
      expect(rs.every((r) => r.special_comment === "CP")).toBe(true);
      expect(rs[2]!.payment_history_profile.slice(0, 5)).toBe("43210");
      // The amount past due ages too, which the spec does not state.
      expect(rs.map((r) => r.amount_past_due)).toEqual(["000009838", "000012297", "000014757"]);
    });

    it("reinstated on 08-10: 11, 000292743, no K4, the same PHP (8.1-T5)", () => {
      expect(recordsOf(SPEC[3]!).at(-1)).toMatchObject({
        account_status: "11",
        current_balance: "000292743",
        k4: null,
        date_of_first_delinquency: "00000000",
        payment_history_profile: "222210000000000000000000",
      });
    });

    it("the Flex Modification: 11, CO, 480, 000002100, 000310000, K4 000030000 (8.1-T6)", () => {
      const sep = recordsOf(SPEC[4]!).at(-1)!;
      expect(sep).toMatchObject({
        account_status: "11",
        special_comment: "CO",
        terms_duration: "480",
        scheduled_monthly_payment: "000002100",
        current_balance: "000310000",
        amount_past_due: "000000000",
        date_of_first_delinquency: "00000000",
      });
      expect(sep.k4!.balloon_amount).toBe("000030000");
      // The trial months before it: AC, contractual aging, the DOFD kept.
      expect(
        recordsOf(SPEC[4]!)
          .slice(0, 3)
          .map((r) => [r.account_status, r.special_comment]),
      ).toEqual([
        ["82", "AC"],
        ["83", "AC"],
        ["83", "AC"],
      ]);
    });

    it("the short sale: 65 + AU rated 1 at 49 days (60 at the month-end), 13 + AU without a foreclosure (8.1-T7)", () => {
      const [, jun, jul] = recordsOf(SPEC[5]!);
      expect(jun!.special_comment).toBe("BO");
      expect(jul).toMatchObject({
        account_status: "65",
        special_comment: "AU",
        payment_rating: "1",
        current_balance: "000000000",
        amount_past_due: "000000000",
        date_closed: "07202027",
        date_of_first_delinquency: "06012027",
      });
      expect(statusForDays(60)).toBe("78");
      expect(recordsOf(SPEC[6]!).at(-1)).toMatchObject({
        account_status: "13",
        special_comment: "AU",
        payment_rating: "1",
      });
    });

    it("the foreclosure sale 94 rated 6 at 231 days, the deed in lieu 89, its deficiency, and the payoff 13 rated 0 (8.1-T8)", () => {
      expect(recordsOf(SPEC[7]!).at(-1)).toMatchObject({
        account_status: "94",
        payment_rating: "6",
        current_balance: "000000000",
        date_of_first_delinquency: "02012027",
        date_closed: "09202027",
      });
      expect(recordsOf(SPEC[8]!).at(-1)).toMatchObject({
        account_status: "89",
        payment_rating: "6",
        current_balance: "000000000",
        date_closed: "09202027",
      });
      expect(recordsOf(SPEC[9]!).at(-1)).toMatchObject({
        account_status: "89",
        current_balance: "000293063",
        amount_past_due: "000000000",
      });
      expect(recordsOf(SPEC[10]!).at(-1)).toMatchObject({
        account_status: "13",
        payment_rating: "0",
        date_of_first_delinquency: "00000000",
        current_balance: "000000000",
        date_closed: "09102027",
      });
    });

    it("a hand-off's PHP carried, and 24 B's with none (8.1-T15)", () => {
      expect(recordsOf(SPEC[11]!)[0]!.payment_history_profile).toBe(
        "0" + "000010000000000000000000".slice(0, 23),
      );
      expect(recordsOf(SPEC[11]!)[0]!.date_of_first_delinquency).toBe("00000000");
      expect(recordsOf(SPEC[12]!).map((r) => r.payment_history_profile)).toEqual([
        "B".repeat(24),
        "0" + "B".repeat(23),
        "00" + "B".repeat(22),
      ]);
    });

    it("no segment for the successor, T and H for the released borrower (8.1-T16)", () => {
      expect(
        expectedMetro2(SPEC[13]!).consumers.map((c) => [
          c.party_id,
          c.segment,
          c.ecoa,
          c.special_comment,
        ]),
      ).toEqual([
        ["A", "base", "2", ""],
        ["B", "J2", "2", ""],
        ["R", "J1", "T", "H"],
      ]);
    });

    it("rounding: $4,919.10 is 000004919 either way, $2,459.55 rounds to 000002460, $4,919.55 to 000004920 (8.1-T19)", () => {
      expect(metro2Money(491_910n)).toBe("000004919");
      expect(metro2Money(491_910n, "round")).toBe("000004919");
      expect(metro2Money(491_955n, "round")).toBe("000004920");
      expect(metro2Money(491_955n, "truncate")).toBe("000004919");
      const rounded = recordsOf(SPEC[14]!);
      expect(rounded.map((r) => r.amount_past_due)).toEqual([
        "000000000",
        "000002460",
        "000004919",
        "000007379",
      ]);
      expect(rounded[0]!.scheduled_monthly_payment).toBe("000002460");
    });

    it("8.2 rule 10's corrected variant: February 11 with nothing past due, March 71 from 03012027, April 78", () => {
      const [feb, mar, apr] = recordsOf(SPEC[15]!);
      expect(feb).toMatchObject({ account_status: "11", amount_past_due: "000000000" });
      expect(mar).toMatchObject({
        account_status: "71",
        date_of_first_delinquency: "03012027",
        amount_past_due: "000002459",
      });
      expect(apr).toMatchObject({ account_status: "78", amount_past_due: "000004919" });
      expect(apr!.payment_history_profile.slice(0, 2)).toBe("10");
    });

    it("a record that fails validation is omitted, and D follows in its place (8.1-T9)", () => {
      const rs = expectedMetro2(SPEC[16]!).records;
      expect(rs[1]).toEqual({
        month: "2027-02",
        furnished: false,
        hard_errors: ["MIN_NOT_18_DIGITS"],
      });
      expect(furnished(rs[2]).payment_history_profile).toBe("D00000000000000000000000");
      expect(furnished(rs[3]).payment_history_profile.slice(0, 2)).toBe("1D");
      expect(carryPhp({ php: "0".repeat(24), status: null, dofd: null, omitted: true })[0]).toBe(
        "D",
      );
    });

    it("a receipt on the month's last day counts at that month-end; on the next day, not (8.2 rule 10's variant)", () => {
      const onTheLast = variant(SPEC[15]!, { receipts: [["2027-03-31", P]] });
      const [, mar, apr] = recordsOf(onTheLast);
      expect(mar).toMatchObject({
        account_status: "11",
        amount_past_due: "000000000",
        date_of_first_delinquency: "00000000",
        date_of_last_payment: "03312027",
      });
      expect([apr!.account_status, apr!.amount_past_due]).toEqual(["11", "000002459"]);
      expect(apr!.payment_history_profile.slice(0, 3)).toBe("000");
      const onTheFirst = variant(SPEC[15]!, { receipts: [["2027-04-01", P]] });
      const [, mar2, apr2] = recordsOf(onTheFirst);
      expect(mar2).toMatchObject({
        account_status: "71",
        amount_past_due: "000002459",
        date_of_first_delinquency: "03012027",
      });
      expect(apr2!.payment_history_profile.slice(0, 3)).toBe("100");
      for (const t of [onTheLast, onTheFirst]) expect(metro2FairToGrade(t), t.id).toBe(true);
    });

    it("reads a null MIN as K3_MIN_MISSING alone, as the engine and the rulebook both say (8.1 rule 9)", () => {
      const missing = variant(SPEC[0]!, { months: { "2027-02": { books: { min: null } } } });
      expect(expectedMetro2(missing).records[1]).toEqual({
        month: "2027-02",
        furnished: false,
        hard_errors: ["K3_MIN_MISSING"],
      });
      const both = variant(SPEC[0]!, {
        months: { "2027-02": { books: { min: null, fnma_loan_number: "12345678901" } } },
      });
      expect(expectedMetro2(both).records[1]).toEqual({
        month: "2027-02",
        furnished: false,
        hard_errors: ["K3_FNMA_LOAN_NUMBER", "K3_MIN_MISSING"],
      });
      for (const t of [missing, both]) expect(metro2FairToGrade(t), t.id).toBe(true);
      expect(METRO2_RULEBOOK).toContain(
        "MIN_NOT_18_DIGITS: books.min is present and not exactly 18 digits (a null MIN is K3_MIN_MISSING alone)",
      );
    });

    it("gives AC only to a plan paying less than the installment: one paying exactly P carries none", () => {
      const plan = (pay: bigint) =>
        variant(SPEC[0]!, {
          months: {
            "2027-04": {
              in_force: [
                {
                  kind: "repayment_plan",
                  plan_payment_cents: pay,
                  remaining_arrears_cents: P * 2n,
                },
              ],
            },
          },
        });
      const at = (t: Metro2Task) => recordsOf(t).at(-1)!;
      expect([at(plan(P)).special_comment, at(plan(P)).amount_past_due]).toEqual(["", "000004919"]);
      expect(at(plan(P - 1n)).special_comment).toBe("AC");
      for (const pay of [P, P - 1n]) expect(metro2FairToGrade(plan(pay))).toBe(true);
    });

    it("are all in scope and solved by the rulebook, in the order the tests above read them", () => {
      for (const t of SPEC) {
        expect(metro2OutOfScope(t), t.id).toBeNull();
        expect(metro2FairToGrade(t), t.id).toBe(true);
      }
      expect(METRO2_SPEC_CASES.map((c) => c.name.split(":")[0])).toEqual([
        "8.1 rule 13",
        "8.1 rule 13",
        "8.1-T3",
        "8.1-T5",
        "8.1-T6",
        "8.1-T7",
        "8.1-T7",
        "8.1-T8",
        "8.1-T8",
        "8.1-T8",
        "8.1-T8",
        "8.1-T15",
        "8.1-T15",
        "8.1-T16",
        "8.1-T19",
        "8.2 rule 10",
        "8.1-T9",
      ]);
    });
  });

  it("holds the conventions it restates to the servicing app's own lines", () => {
    // A re-vendor that changes any of these fails here: revisit the grader, the rulebook and their citations.
    expect(serviceLines("early-intervention/ops.ts", "receipts after `as_of` are not yet in", 1))
      .toMatchInlineSnapshot(`
        "early-intervention/ops.ts:40-40
          const r = applyFifo(f.installments, f.receipts.filter((p) => p.received_on <= asOf));   // receipts after \`as_of\` are not yet in the ledger"
      `);
    expect(serviceLines("credit-reporting/ops.ts", "const errors = validateSnapshot(overlaid);", 2))
      .toMatchInlineSnapshot(`
        "credit-reporting/ops.ts:170-171
            const errors = validateSnapshot(overlaid);
            if (errors.length) { exceptions.push({ loan_id: id, errors, routed_to: "credit-reporting", sla: "same_day", resolution: "omitted_from_file", php_next_month: "D" }); omitted.push({ loan_id: id, reason: \`hard_error:\${errors.join(",")}\` }); continue; }"
      `);
    expect(serviceLines("credit-reporting/ops.ts", "export function phpAfterOmission(", 1))
      .toMatchInlineSnapshot(`
        "credit-reporting/ops.ts:182-182
        export function phpAfterOmission(s: Metro2Snapshot): string { return carryPhp({ php: s.php, status: null, dofd: s.dofd, omitted: true }); }"
      `);
    expect(serviceLines("operations-runtime/runners.ts", "const inMonth = posted.filter(", 2))
      .toMatchInlineSnapshot(`
        "operations-runtime/runners.ts:138-139
              const inMonth = posted.filter((p) => String(p.received_on ?? "").slice(0, 7) === asOf.slice(0, 7));
              const lastPayment = posted.map((p) => String(p.received_on ?? "")).filter((d) => /^\\d{4}-\\d{2}-\\d{2}$/.test(d)).sort().at(-1);"
      `);
    expect(
      serviceLines(
        "operations-runtime/runners.ts",
        "records.push({ snapshot: buildSnapshot(state)",
        1,
      ),
    ).toMatchInlineSnapshot(`
      "operations-runtime/runners.ts:145-145
            records.push({ snapshot: buildSnapshot(state), prior_status: null, prior_dofd: null });"
    `);
  });

  it("restates the engine's ledger and carries: the receipts' prefix, the hand-off's B's, D after an omission", () => {
    // D1: built over a ledger that holds April's receipt, March's amount past due reads as paid. The
    // 8.2 corrected variant with March paid on 04-05: the engine says 71 with nothing past due.
    const corrected = variant(SPEC[15]!, { receipts: [["2027-04-05", P]] });
    const march = corrected.months[1]!;
    const prior = furnish({ ...corrected, months: [corrected.months[0]!] }).records[0]!;
    expect(prior.furnished).toBe(true);
    const state = stateFor(corrected, march, null);
    const whole = applyFifo(corrected.installments, corrected.receipts).installments;
    const overWhole = renderBase(buildSnapshot({ ...state, installments: whole }));
    expect([overWhole["account_status"], overWhole["amount_past_due"]]).toEqual([
      "71",
      "000000000",
    ]);
    // Over the receipts on or before 03-31, as the harness builds it: 000002459, as rule 2 says.
    expect(furnished(expectedMetro2(corrected).records[1])).toMatchObject({
      account_status: "71",
      amount_past_due: "000002459",
      date_of_first_delinquency: "03012027",
    });
    // The forbearance's entry figures are the ledger's on 04-30: 78 and 7378.65, not May 1's 9838.20.
    expect(recordsOf(SPEC[1]!)[0]!.amount_past_due).toBe("000007378");
    // A hand-off's short PHP is padded with B before it is carried.
    const short = {
      ...SPEC[11]!,
      last_record: { ...SPEC[11]!.last_record!, payment_history_profile: "0100" },
    };
    expect(recordsOf(short)[0]!.payment_history_profile).toBe(`00100${"B".repeat(19)}`);
    expect(metro2FairToGrade(short)).toBe(true);
  });

  it("fails an answer one unit off on exactly that field, and charges for what is missing or extra", () => {
    const want = expectedMetro2(SPEC[1]!);
    const wrong = (answer: Metro2Answer) =>
      gradeMetro2Against(want, answer)
        .fields.filter((x) => !x.ok)
        .map((x) => x.field);
    const at = (k: number, change: Partial<FurnishedRecord>): Metro2Answer => ({
      ...want,
      records: want.records.map((r, i) => (i === k ? { ...furnished(r), ...change } : r)),
    });
    expect(wrong(want)).toEqual([]);
    expect(wrong(at(0, { amount_past_due: "000007379" }))).toEqual([
      "month[2027-05].amount_past_due",
    ]);
    expect(wrong(at(3, { current_balance: "000307501" }))).toEqual([
      "month[2027-08].terms_and_balance",
    ]);
    expect(
      wrong(at(3, { k4: { balloon_due_date: "02012055", balloon_amount: "000014758" } })),
    ).toEqual(["month[2027-08].terms_and_balance"]);
    expect(wrong(at(2, { date_of_first_delinquency: "03012027" }))).toEqual([
      "month[2027-07].dofd",
    ]);
    expect(wrong(at(1, { payment_history_profile: "122100000000000000000000" }))).toEqual([
      "month[2027-06].php",
    ]);
    expect(wrong(at(0, { special_comment: "" }))).toEqual(["month[2027-05].special_comment"]);
    expect(wrong(at(3, { date_of_last_payment: "08112027" }))).toEqual(["month[2027-08].payments"]);
    expect(wrong(at(3, { payment_rating: "0" }))).toEqual(["month[2027-08].status"]);
    expect(wrong(at(3, { account_status: "71" }))).toEqual(["month[2027-08].status"]);
    expect(wrong(at(3, { actual_payment_amount: "000002460" }))).toEqual([
      "month[2027-08].payments",
    ]);
    expect(wrong(at(3, { terms_duration: "361" }))).toEqual(["month[2027-08].terms_and_balance"]);
    // A closing's date and rating ride with its status (the foreclosure sale of 8.1-T8).
    const sale = expectedMetro2(SPEC[7]!);
    const saleWrong = (change: Partial<FurnishedRecord>) =>
      gradeMetro2Against(sale, {
        ...sale,
        records: sale.records.map((r, i) =>
          i === sale.records.length - 1 ? { ...furnished(r), ...change } : r,
        ),
      })
        .fields.filter((x) => !x.ok)
        .map((x) => x.field);
    expect(saleWrong({ date_closed: "09212027" })).toEqual(["month[2027-09].status"]);
    expect(saleWrong({ payment_rating: "5" })).toEqual(["month[2027-09].status"]);
    // An omitted month answered with its hard errors less one, or one more: its seven fields either way.
    const two = expectedMetro2(
      variant(SPEC[0]!, {
        months: { "2027-02": { books: { min: null, fnma_loan_number: "12345678901" } } },
      }),
    );
    const omittedWith = (want: Metro2Answer, hard_errors: string[]) => ({
      ...want,
      records: want.records.map((r, i) =>
        i === 1 ? { month: r.month, furnished: false as const, hard_errors } : r,
      ),
    });
    for (const errors of [["K3_FNMA_LOAN_NUMBER"], ["K3_MIN_MISSING"]])
      expect(
        gradeMetro2Against(two, omittedWith(two, errors)).fields.filter((f) => !f.ok),
      ).toHaveLength(7);
    const missing = expectedMetro2(
      variant(SPEC[0]!, { months: { "2027-02": { books: { min: null } } } }),
    );
    expect(
      gradeMetro2Against(
        missing,
        omittedWith(missing, ["K3_MIN_MISSING", "MIN_NOT_18_DIGITS"]),
      ).fields.filter((f) => !f.ok),
    ).toHaveLength(7);
    // A month left out costs its seven fields; one that is not in the task is a field of its own.
    expect(wrong({ ...want, records: want.records.slice(1) })).toHaveLength(7);
    const extra = { ...furnished(want.records[3]), month: "2027-09" };
    expect(wrong({ ...want, records: [...want.records, extra] })).toEqual(["month[2027-09]"]);
    // Omitting a furnished month costs what furnishing an omitted one does: seven fields either way.
    const omitted = expectedMetro2(SPEC[16]!);
    const furnishedAnyway = {
      ...omitted,
      records: omitted.records.map((r, i) =>
        i === 1 ? { ...furnished(omitted.records[0]), month: "2027-02" } : r,
      ),
    };
    const omittedAnyway = {
      ...omitted,
      records: omitted.records.map((r, i) =>
        i === 0
          ? { month: r.month, furnished: false as const, hard_errors: ["MIN_NOT_18_DIGITS"] }
          : r,
      ),
    };
    expect(gradeMetro2Against(omitted, furnishedAnyway).fields.filter((f) => !f.ok)).toHaveLength(
      7,
    );
    expect(gradeMetro2Against(omitted, omittedAnyway).fields.filter((f) => !f.ok)).toHaveLength(7);
    // The consumers' segments are one field, in any order.
    const segments = expectedMetro2(SPEC[13]!);
    expect(
      gradeMetro2Against(segments, { ...segments, consumers: [...segments.consumers].reverse() })
        .pass,
    ).toBe(true);
    expect(wrong({ ...want, consumers: [{ ...want.consumers[0]!, ecoa: "2" }] })).toEqual([
      "consumers",
    ]);
  });

  it("leaves the scheduled payment ungraded on a closing month, where the engine keeps the PITI", () => {
    for (const t of [SPEC[5]!, SPEC[6]!, SPEC[7]!, SPEC[8]!, SPEC[10]!]) {
      const want = expectedMetro2(t);
      const last = furnished(want.records.at(-1));
      expect(last.scheduled_monthly_payment).toBe("000002459");
      const zeroed = {
        ...want,
        records: want.records.map((r, i) =>
          i === want.records.length - 1 ? { ...last, scheduled_monthly_payment: "000000000" } : r,
        ),
      };
      expect(gradeMetro2Against(want, zeroed).pass).toBe(true);
    }
    // On any other month it is graded.
    const want = expectedMetro2(SPEC[0]!);
    const off = {
      ...want,
      records: want.records.map((r, i) =>
        i === 0 ? { ...furnished(r), scheduled_monthly_payment: "000000000" } : r,
      ),
    };
    expect(gradeMetro2Against(want, off).pass).toBe(false);
  });

  it("reads a submission strictly, as the schema says, and bounces what does not fit", () => {
    const want = expectedMetro2(SPEC[16]!);
    const ok = (x: unknown) => parseMetro2Submission(x).ok;
    const first = furnished(want.records[0]);
    const withFirst = (change: Record<string, unknown>) => ({
      ...want,
      records: [{ ...first, ...change }, ...want.records.slice(1)],
    });
    expect(ok(want)).toBe(true);
    expect(ok({ records: want.records })).toBe(false);
    expect(ok({ ...want, notes: "x" })).toBe(false);
    expect(ok({ ...want, records: [want.records[0], ...want.records] })).toBe(false);
    expect(ok(withFirst({ account_status: "12" }))).toBe(false);
    expect(ok(withFirst({ amount_past_due: "00000000" }))).toBe(false);
    expect(ok(withFirst({ amount_past_due: 0 }))).toBe(false);
    expect(ok(withFirst({ date_of_first_delinquency: "2027-02-01" }))).toBe(false);
    expect(ok(withFirst({ payment_history_profile: "0".repeat(23) }))).toBe(false);
    expect(ok(withFirst({ payment_history_profile: "0".repeat(23) + "X" }))).toBe(false);
    expect(ok(withFirst({ terms_duration: "36" }))).toBe(false);
    expect(ok(withFirst({ payment_rating: "7" }))).toBe(false);
    expect(ok(withFirst({ special_comment: "XX" }))).toBe(false);
    expect(ok(withFirst({ k4: { balloon_due_date: "02012055" } }))).toBe(false);
    expect(ok(withFirst({ remarks: "" }))).toBe(false);
    expect(ok(withFirst({ month: "2027-13" }))).toBe(false);
    const { k4: _k4, ...noK4 } = first;
    expect(ok({ ...want, records: [noK4, ...want.records.slice(1)] })).toBe(false);
    const omitted = (hard_errors: unknown, more: Record<string, unknown> = {}) => ({
      ...want,
      records: want.records.map((r, i) =>
        i === 1 ? { month: r.month, furnished: false, hard_errors, ...more } : r,
      ),
    });
    expect(ok(omitted(["MIN_NOT_18_DIGITS"]))).toBe(true);
    expect(ok(omitted([]))).toBe(false);
    expect(ok(omitted(["MIN_TOO_SHORT"]))).toBe(false);
    expect(ok(omitted(["MIN_NOT_18_DIGITS", "MIN_NOT_18_DIGITS"]))).toBe(false);
    expect(ok(omitted(["MIN_NOT_18_DIGITS"], { account_status: "11" }))).toBe(false);
    const consumer = want.consumers[0]!;
    expect(ok({ ...want, consumers: [consumer, consumer] })).toBe(false);
    expect(ok({ ...want, consumers: [{ ...consumer, segment: "J3" }] })).toBe(false);
    expect(ok({ ...want, consumers: [{ ...consumer, ecoa: "3" }] })).toBe(false);
    expect(ok({ ...want, consumers: [{ ...consumer, cii: "" }] })).toBe(false);
    // The hard errors in any order; the parser sorts them.
    const two = omitted(["MIN_NOT_18_DIGITS", "K3_FNMA_LOAN_NUMBER"]);
    const parsed = parseMetro2Submission(two);
    expect(parsed.ok && parsed.answer.records[1]).toEqual({
      month: "2027-02",
      furnished: false,
      hard_errors: ["K3_FNMA_LOAN_NUMBER", "MIN_NOT_18_DIGITS"],
    });
  });

  it("passes nothing that never applies a receipt or counts a day, and states the floor that answer sets", () => {
    const tasks = generateMetro2Suite("heldout", 1, 200);
    const money = (c: bigint) => (c / 100n).toString().padStart(9, "0");
    const grades = (f: (t: Metro2Task) => Metro2Answer) =>
      tasks.map((t) => gradeMetro2Against(expectedMetro2(t), f(t)));
    const mean = (f: (t: Metro2Task) => Metro2Answer) =>
      grades(f).reduce((a, g) => a + g.score, 0) / tasks.length;
    const nothing = mean((t) => ({
      records: t.months.map((m) => ({
        month: m.month,
        furnished: true,
        account_status: "11",
        payment_rating: "",
        date_closed: "00000000",
        amount_past_due: "000000000",
        date_of_first_delinquency: "00000000",
        payment_history_profile: "B".repeat(24),
        special_comment: "",
        current_balance: "000000000",
        scheduled_monthly_payment: "000000000",
        terms_duration: "000",
        k4: null,
        actual_payment_amount: "000000000",
        date_of_last_payment: "00000000",
      })),
      consumers: [],
    }));
    // The last record repeated every month, and the books read: the balance, the payment, the terms.
    const forward = mean((t) => ({
      records: t.months.map((m) => ({
        month: m.month,
        furnished: true,
        account_status: t.last_record?.account_status ?? "11",
        payment_rating: "",
        date_closed: "00000000",
        amount_past_due: "000000000",
        date_of_first_delinquency: t.last_record?.date_of_first_delinquency ?? "00000000",
        payment_history_profile: (t.last_record?.payment_history_profile ?? "").padEnd(24, "B"),
        special_comment: t.last_record?.special_comment ?? "",
        current_balance: money(m.books.upb_cents),
        scheduled_monthly_payment: money(t.loan.pi_cents + t.loan.escrow_cents),
        terms_duration: String(
          t.policy.terms_duration === "original"
            ? t.loan.original_term_months
            : m.books.remaining_term_months,
        ).padStart(3, "0"),
        k4: null,
        actual_payment_amount: "000000000",
        date_of_last_payment: "00000000",
      })),
      consumers: [],
    }));
    // Everything but the ledger read off the task: the floor docs/environments.md states, and it passes
    // no task, because every window has a month-end whose ledger decides a graded field.
    const reading = grades(readingOnly);
    const floor = reading.reduce((a, g) => a + g.score, 0) / tasks.length;
    expect(reading.filter((g) => g.pass)).toHaveLength(0);
    // About 0.23, 0.40 and 0.65, as docs/environments.md states them.
    expect(nothing).toBeGreaterThan(0.17);
    expect(nothing).toBeLessThan(0.28);
    expect(forward).toBeGreaterThan(nothing);
    expect(forward).toBeLessThan(0.45);
    expect(floor).toBeGreaterThan(0.6);
    expect(floor).toBeLessThan(0.72);
    // And on training draws: no window passes it.
    for (const t of generateMetro2Suite("train", 5, 600))
      expect(gradeMetro2Against(expectedMetro2(t), readingOnly(t)).pass, t.id).toBe(false);
  });

  it("can be solved from the rulebook and the tools: the reference passes the held-out suite and the spec", async () => {
    const r = await solveAll([
      ...SPEC,
      ...generateMetro2Suite("heldout", METRO2_HELDOUT_SUITE.seed, METRO2_HELDOUT_SUITE.n),
    ]);
    expect(r.misses).toEqual([]);
    // Inside the episode's 80 turns even for a model that makes one tool call a turn: the
    // reference's call count, submission included, is that model's turn count.
    expect(r.calls).toBeLessThan(70);
    expect(r.turns).toBeLessThan(40);
  }, 120_000);

  it("can be solved on a training suite from another seed", async () => {
    const r = await solveAll(generateMetro2Suite("train", 11, 300));
    expect(r.misses).toEqual([]);
    expect(r.calls).toBeLessThan(70);
  }, 120_000);

  it("is fair to grade on every first draw, and stays out of the engine's regions of doubt", () => {
    const draws = Array.from({ length: 600 }, (_, i) => drawMetro2Task("train", 3, i));
    expect(draws.filter((x) => x.attempts > 1).map((x) => x.task.id)).toEqual([]);
    for (const { task } of draws) expect(metro2InScope(task)).toBe(true);
  }, 120_000);

  it("holds the rulebook to the engine on candidates nothing filtered", () => {
    // The fairness filter would hide a disagreement; the candidates it would see show none.
    const unfair: string[] = [];
    for (let i = 0; i < 2_000; i++) {
      const id = metro2TaskId("train", 99, i);
      const task = drawMetro2Candidate(rngFor(id), id, "train", 99, i);
      if (!metro2InScope(task) || !metro2FairToGrade(task)) unfair.push(id);
    }
    expect(unfair).toEqual([]);
  }, 120_000);

  describe("keeps out each place the engine departs from its spec, each reproduced", () => {
    const why = (t: Metro2Task) => metro2OutOfScope(t);

    it("admits the spec's own cases", () => {
      expect(SPEC.map(why)).toEqual(SPEC.map(() => null));
    });

    it("D2: a modification carried into a month it does not cure stays 11, CO, nothing past due", () => {
      const mod = SPEC[4]!;
      const carried = variant(mod, { add: ["2027-10", "2027-11"] });
      const [oct, nov] = recordsOf(carried).slice(-2);
      // October and November unpaid after the modification: the spec's November is 71, the engine's 11.
      expect([oct!.account_status, oct!.amount_past_due, oct!.special_comment]).toEqual([
        "11",
        "000000000",
        "CO",
      ]);
      expect([nov!.account_status, nov!.date_of_first_delinquency]).toEqual(["11", "00000000"]);
      expect(why(carried)).toMatch(/^D2:/);
      // Paid after it, the same months are what the spec says, and admitted.
      const paid = variant(mod, {
        add: ["2027-10"],
        receipts: [["2027-10-02", 210_000n]],
      });
      expect(why(paid)).toBeNull();
    });

    it("D3: a forbearance that ends with installments unpaid jumps three buckets, 78 to 84", () => {
      const deferred = SPEC[1]!;
      // No deferral and no August payment: the plan simply ends.
      const unresolved = {
        ...variant(deferred, { months: { "2027-08": { in_force: [] } } }),
        receipts: deferred.receipts.filter((x) => x.received_on !== "2027-08-10"),
      };
      const aug = furnished(expectedMetro2(unresolved).records.at(-1));
      // The spec resumes aging from the frozen 78 (to 80); the engine reads the ledger, 211 days.
      expect([aug.account_status, aug.amount_past_due]).toEqual(["84", "000017216"]);
      expect(why(unresolved)).toMatch(/^D3:/);
      // A trial in its place is the same contractual aging.
      const trial = variant(deferred, {
        months: {
          "2027-08": { in_force: [{ kind: "trial_plan", trial_payment_cents: 210_000n }] },
        },
      });
      expect(why(trial)).toMatch(/^D3:/);
      // Reinstated, nothing is unpaid, and the month is admitted (8.1-T5).
      expect(why(SPEC[3]!)).toBeNull();
    });

    it("D12: a catch-up that leaves 1 to 29 days blanks the DOFD, and the next delinquency re-anchors later", () => {
      // Feb-1 missed; February and March paid 04-10; April never paid.
      const t = variant(SPEC[0]!, { receipts: [["2027-04-10", P * 2n]], add: ["2027-05"] });
      const [, , mar, apr, may] = recordsOf(t);
      expect([mar!.account_status, mar!.date_of_first_delinquency]).toEqual(["71", "02012027"]);
      expect([apr!.account_status, apr!.date_of_first_delinquency]).toEqual(["11", "00000000"]);
      expect([may!.account_status, may!.date_of_first_delinquency]).toEqual(["78", "04012027"]);
      // Never current since February 1: the delinquency began then, and rule 3 keeps that date.
      expect(delinquencyBegan(t, d("2027-05-31"))).toBe("2027-02-01");
      expect(why(t)).toMatch(/^D12:/);
    });

    it("D13: closing funds in the ledger move the payment rating; a receipt on the closing date is refused", () => {
      // A payoff on 06-15 of a loan 134 days late, the funds as a receipt or not.
      const base = variant(SPEC[0]!, {
        add: ["2027-05", "2027-06"],
        months: {
          "2027-06": {
            in_force: [
              {
                kind: "payoff",
                closed_on: d("2027-06-15"),
                by_refinance: true,
                payoff_funds_cents: 30_000_000n,
              },
            ],
          },
        },
      });
      expect(furnished(expectedMetro2(base).records.at(-1))).toMatchObject({
        payment_rating: "4",
        date_of_first_delinquency: "02012027",
      });
      expect(why(base)).toBeNull();
      const inLedger = variant(base, { receipts: [["2027-06-15", P * 5n]] });
      expect(furnished(expectedMetro2(inLedger).records.at(-1))).toMatchObject({
        payment_rating: "0",
        date_of_first_delinquency: "00000000",
      });
      expect(why(inLedger)).toMatch(/^D13:/);
    });

    it("a closing current at its date, with an installment unpaid at the month-end, would furnish 13 with a DOFD", () => {
      // September's installment not paid before the 09-10 payoff.
      const payoff = SPEC[10]!;
      const t = {
        ...payoff,
        receipts: payoff.receipts.filter((x) => x.received_on !== "2027-09-01"),
      };
      expect(furnished(expectedMetro2(t).records.at(-1))).toMatchObject({
        account_status: "13",
        payment_rating: "0",
        date_of_first_delinquency: "09012027",
      });
      expect(why(t)).toMatch(/^a closing current at its date/);
    });

    it("a freeze at 30 days or more whose arrears are paid is omitted, then re-anchored later: a hard error no input satisfies", () => {
      // Five installments paid 06-20 under the freeze at 78.
      const t = variant(SPEC[1]!, {
        receipts: [["2027-06-20", P * 5n]],
        months: { "2027-08": { in_force: [forbearanceMay] } },
      });
      const [, jun, jul] = expectedMetro2(t).records;
      expect(jun).toEqual({ month: "2027-06", furnished: false, hard_errors: ["DOFD_REQUIRED"] });
      expect(furnished(jul)).toMatchObject({
        account_status: "78",
        special_comment: "CP",
        amount_past_due: "000007378",
        date_of_first_delinquency: "07012027",
      });
      expect(furnished(jul).payment_history_profile.slice(0, 2)).toBe("D2");
      expect(why(t)).toBe("a hard error the books cannot cause: DOFD_REQUIRED");
    });

    it("a deed in lieu or foreclosure sale with nothing unpaid needs a DOFD no input can give", () => {
      const current = SPEC[10]!;
      for (const kind of ["deed_in_lieu", "foreclosure_sale"] as const) {
        const t = variant(current, {
          months: {
            "2027-09": {
              in_force: [{ kind, closed_on: d("2027-09-10"), deficiency_pursued: false }],
            },
          },
        });
        const last = expectedMetro2(t).records.at(-1)!;
        expect(last).toMatchObject({ furnished: false, hard_errors: ["DOFD_REQUIRED"] });
        expect(why(t)).toMatch(/DOFD_REQUIRED/);
      }
    });

    it("D15: a zero balance before a closing would be E, which the engine never furnishes", () => {
      const t = variant(SPEC[0]!, { months: { "2027-01": { books: { upb_cents: 0n } } } });
      const jan = buildSnapshot(stateFor(t, t.months[0]!, null));
      expect(carryPhp(jan)[0]).toBe("0");
      expect(why(t)).toMatch(/^D15:/);
    });

    it("refuses a closing before the window's last month, and two plans in force at once", () => {
      const closed = variant(SPEC[10]!, { add: ["2027-10"] });
      expect(why(closed)).toBe("a closing before the last month");
      const two = variant(SPEC[0]!, {
        months: {
          "2027-03": {
            in_force: [
              { kind: "trial_plan", trial_payment_cents: P },
              { kind: "repayment_plan", plan_payment_cents: P, remaining_arrears_cents: P },
            ],
          },
        },
      });
      expect(why(two)).toBe("two plans, workouts or closings in force at once");
    });

    it("a referral the loan has been cured of, or one beside a workout, would still be BO on a current loan", () => {
      // 8.1-T8's referral of 06-10, and every installment paid 08-05: the engine furnishes 11, nothing past due, BO.
      const cured = variant(SPEC[7]!, {
        receipts: [["2027-08-05", P * 7n]],
        months: { "2027-09": { in_force: [referredJune] } },
      });
      const [, , , aug] = recordsOf(cured);
      expect([aug!.account_status, aug!.amount_past_due, aug!.special_comment]).toEqual([
        "11",
        "000000000",
        "BO",
      ]);
      expect(
        referralEnded(cured.installments, cured.receipts, d("2027-06-10"), d("2027-08-31")),
      ).toBe(true);
      expect(why(cured)).toBe(
        "a foreclosure referral in force after the delinquency it was made on ended",
      );
      // 8.1-T4's deferral beside a referral: 8.1 rule 7 gives it a blank comment, the engine BO.
      const deferred = variant(SPEC[1]!, {
        months: {
          "2027-08": {
            in_force: [
              { kind: "payment_deferral", completed_on: d("2027-08-15") },
              { kind: "foreclosure_referral", referred_on: d("2027-07-20") },
            ],
          },
        },
      });
      expect(furnished(expectedMetro2(deferred).records.at(-1)).special_comment).toBe("BO");
      expect(why(deferred)).toBe("a foreclosure referral in force beside a workout");
      // A referral dated after a short sale's closing.
      const after = variant(SPEC[5]!, {
        months: {
          "2027-07": {
            in_force: [
              { kind: "short_sale", closed_on: d("2027-07-20") },
              { kind: "foreclosure_referral", referred_on: d("2027-07-25") },
            ],
          },
        },
      });
      expect(why(after)).toBe("a foreclosure referral after the closing date");
    });

    it("never hands the engine a disaster case, a charge-off or a transfer out", () => {
      // D11d: a trial with a disaster case open reports AC where 8.3-Q2 gives AW.
      const trial = variant(SPEC[0]!, {
        months: { "2027-03": { in_force: [{ kind: "trial_plan", trial_payment_cents: P }] } },
      });
      const state = stateFor(trial, trial.months[2]!, null);
      expect(state.disaster_case_open).toBeUndefined();
      expect(buildSnapshot({ ...state, disaster_case_open: true }).special_comment).toBe("AC");
      const kinds = new Set<string>();
      for (const t of generateMetro2Suite("train", 2, 240))
        for (const m of t.months) kinds.add(stateFor(t, m, null).condition.kind);
      expect([...kinds].filter((k) => k === "charge_off" || k === "transfer_out")).toEqual([]);
    });
  });

  it("holds every rare outcome in the held-out suite", () => {
    const tasks = generateMetro2Suite("heldout", 1, 200);
    const records = tasks.flatMap((t) => expectedMetro2(t).records);
    const furnishedOnes = records.filter((r): r is FurnishedRecord => r.furnished);
    for (const status of ["13", "65", "89", "94"])
      expect(
        furnishedOnes.filter((r) => r.account_status === status).length,
        status,
      ).toBeGreaterThan(1);
    for (const special of ["AS", "AU", "CO", "CP", "AC", "BO"])
      expect(
        furnishedOnes.filter((r) => r.special_comment === special).length,
        special,
      ).toBeGreaterThan(1);
    expect(records.filter((r) => !r.furnished).length).toBeGreaterThan(5);
    expect(furnishedOnes.filter((r) => r.k4 !== null).length).toBeGreaterThan(5);
    expect(tasks.filter((t) => t.last_record === null).length).toBeGreaterThan(1);
    expect(
      tasks.filter((t) => (t.last_record?.payment_history_profile.length ?? 24) < 24).length,
    ).toBeGreaterThan(1);
    for (const policy of ["freeze", "contractual_aging"])
      expect(
        tasks.filter(
          (t) =>
            t.policy.forbearance_status === policy &&
            t.months.some((m) => m.in_force.some((e) => e.kind === "forbearance_plan")),
        ).length,
        policy,
      ).toBeGreaterThan(1);
  });

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump METRO2_ENVIRONMENT_VERSION, then the pin.
    expect(
      sha256(generateMetro2Suite("heldout", 1, 200).map(toJsonLine).join("")),
    ).toMatchInlineSnapshot(`"8ca49c2ee3165b6b8f41fa015ea62860dee4813603bfc0b155d9d8f6c6fba9f1"`);
  });

  it("rebuilds a task from its coordinates, and never draws a held-out window into training", () => {
    expect(toJsonLine(generateMetro2Task("train", 7, 17))).toBe(
      toJsonLine(generateMetro2Suite("train", 7, 30)[17]),
    );
    const fp = (t: Metro2Task) => toJsonLine(metro2Payload(t));
    const held = new Set(generateMetro2Suite("heldout", 1, 200).map(fp));
    expect(generateMetro2Suite("train", 1, 1000).filter((t) => held.has(fp(t)))).toEqual([]);
  }, 60_000);

  describe("each edge and configuration that decides an answer turns up", () => {
    const runs = generateMetro2Suite("train", 1, 1200).map((t, i) => ({
      t,
      a: expectedMetro2(t),
      edge: metro2EdgeOf(i),
    }));
    type Run = (typeof runs)[number];
    const count = (f: (x: Run) => boolean) => runs.filter(f).length;
    interface Month {
      t: Metro2Task;
      m: Metro2Month;
      k: number;
      r: MonthRecord;
      state: ReturnType<typeof stateFor>;
      days: number;
      unpaid: number;
    }
    const months: Month[] = runs.flatMap(({ t, a }) => {
      const out: Month[] = [];
      furnish(t, {
        month(m, state) {
          const k = t.months.indexOf(m);
          const unpaid = state.installments.filter(
            (i) =>
              i.due_date <= state.as_of &&
              (i.satisfied_on === null || i.satisfied_on > state.as_of),
          );
          const days = unpaid.length
            ? (Date.parse(state.as_of) - Date.parse(unpaid[0]!.due_date)) / 86_400_000
            : 0;
          out.push({ t, m, k, r: a.records[k]!, state, days, unpaid: unpaid.length });
        },
      });
      return out;
    });
    const fm = months.filter((x) => x.r.furnished) as (Month & { r: FurnishedRecord })[];
    const countMonths = (f: (x: Month & { r: FurnishedRecord }) => boolean) => fm.filter(f).length;
    const kinds = (x: Month) => x.m.in_force.map((e) => e.kind);
    const closingDays = (x: Month) => {
      const c = x.m.in_force.find((e) => "closed_on" in e) as { closed_on: PlainDate } | undefined;
      if (!c) return null;
      const unpaid = x.state.installments.find(
        (i) =>
          i.due_date <= c.closed_on && (i.satisfied_on === null || i.satisfied_on > c.closed_on),
      );
      return unpaid ? (Date.parse(c.closed_on) - Date.parse(unpaid.due_date)) / 86_400_000 : 0;
    };

    it("cycles through every edge, a hundred windows each", () => {
      expect(new Set(runs.map((x) => x.edge))).toEqual(new Set(METRO2_EDGES));
      expect(count((x) => x.t.months.length === 3)).toBeGreaterThan(150);
      expect(count((x) => x.t.months.length === 6)).toBeGreaterThan(150);
    });

    it("draws every status v1 furnishes, and month-ends on each side of every bucket's edge", () => {
      for (const [status, n] of [
        ["11", 1000],
        ["71", 200],
        ["78", 300],
        ["80", 200],
        ["82", 200],
        ["83", 200],
        ["84", 300],
        ["13", 40],
        ["65", 10],
        ["89", 15],
        ["94", 20],
      ] as const)
        expect(
          countMonths((x) => x.r.account_status === status),
          status,
        ).toBeGreaterThan(n);
      for (const [days, n] of [
        [29, 60],
        [30, 100],
        [59, 25],
        [60, 150],
        [89, 40],
        [90, 50],
        [119, 40],
        [120, 40],
        [149, 10],
        [150, 60],
      ] as const)
        expect(months.filter((x) => x.days === days).length, `${days} days`).toBeGreaterThan(n);
      // 59 days at a month-end only with February 2028: two installments due Jan-1 or Feb-1 2028.
      expect(
        months.filter((x) => x.days === 59 && x.state.as_of.startsWith("2028-0")).length,
      ).toBeGreaterThan(20);
      // One installment unpaid: 11 at 27 to 29 days with an amount past due and no DOFD, 71 at 30.
      expect(
        countMonths(
          (x) =>
            x.r.account_status === "11" && x.unpaid === 1 && x.r.amount_past_due !== "000000000",
        ),
      ).toBeGreaterThan(60);
      expect(countMonths((x) => x.r.account_status === "71" && x.unpaid === 1)).toBeGreaterThan(40);
    });

    it("draws closings rated at the closing date on each side of each bucket's edge", () => {
      const at = (n: number) => months.filter((x) => closingDays(x) === n).length;
      for (const [lo, hi] of [
        [59, 60],
        [89, 90],
        [119, 120],
        [149, 150],
        [179, 180],
      ] as const) {
        expect(at(lo), `${lo} days at closing`).toBeGreaterThan(3);
        expect(at(hi), `${hi} days at closing`).toBeGreaterThan(3);
      }
      expect(at(179) + at(180)).toBeGreaterThan(25);
      // Rated at the closing date, not the month-end: they differ.
      expect(
        countMonths(
          (x) => x.r.payment_rating !== "" && x.r.payment_rating !== paymentRatingForDays(x.days),
        ),
      ).toBeGreaterThan(40);
      for (const [code, special, n] of [
        ["13", "AS", 5],
        ["13", "", 8],
        ["13", "AU", 15],
        ["65", "AU", 10],
      ] as const)
        expect(
          countMonths((x) => x.r.account_status === code && x.r.special_comment === special),
          `${code} ${special}`,
        ).toBeGreaterThan(n);
      expect(
        countMonths((x) => x.r.account_status === "13" && x.r.payment_rating === "0"),
      ).toBeGreaterThan(10);
      expect(
        countMonths(
          (x) => ["89", "94"].includes(x.r.account_status) && x.r.current_balance !== "000000000",
        ),
      ).toBeGreaterThan(5);
      expect(
        countMonths(
          (x) => ["89", "94"].includes(x.r.account_status) && x.r.current_balance === "000000000",
        ),
      ).toBeGreaterThan(30);
    });

    it("draws the DOFD set, kept through a partial catch-up, and reset after a cure", () => {
      const before = (x: Month): string | null => {
        if (x.k === 0) return x.t.last_record?.date_of_first_delinquency ?? "00000000";
        const p = months.find((y) => y.t === x.t && y.k === x.k - 1)!.r;
        return p.furnished ? p.date_of_first_delinquency : null;
      };
      // Set: a DOFD where the record before had none.
      expect(
        countMonths(
          (x) => x.r.date_of_first_delinquency !== "00000000" && before(x) === "00000000",
        ),
      ).toBeGreaterThan(100);
      // Kept: the DOFD older than the oldest installment unpaid, because a catch-up paid some.
      expect(
        countMonths((x) => {
          const dofd = x.r.date_of_first_delinquency;
          const oldest = x.state.installments.find(
            (i) =>
              i.due_date <= x.state.as_of &&
              (i.satisfied_on === null || i.satisfied_on > x.state.as_of),
          );
          return (
            dofd !== "00000000" &&
            oldest !== undefined &&
            `${dofd.slice(4)}-${dofd.slice(0, 2)}-${dofd.slice(2, 4)}` < oldest.due_date
          );
        }),
      ).toBeGreaterThan(200);
      // Reset: a window with a DOFD, then a month current, then a later DOFD.
      expect(
        count(({ a }) => {
          const rs = a.records.filter((r): r is FurnishedRecord => r.furnished);
          const first = rs.findIndex((r) => r.date_of_first_delinquency !== "00000000");
          const cured = rs.findIndex(
            (r, i) => i > first && r.amount_past_due === "000000000" && r.account_status === "11",
          );
          return (
            first >= 0 &&
            cured > first &&
            rs
              .slice(cured)
              .some(
                (r) =>
                  r.date_of_first_delinquency > "00000000" &&
                  r.date_of_first_delinquency !== rs[first]!.date_of_first_delinquency,
              )
          );
        }),
      ).toBeGreaterThan(15);
    });

    it("draws part payments in the pool, completed after the month-end, prepayments and double payments", () => {
      const P_ = (t: Metro2Task) => t.loan.pi_cents + t.loan.escrow_cents;
      expect(
        runs.flatMap(({ t }) => t.receipts.filter((x) => x.amount_cents < P_(t))).length,
      ).toBeGreaterThan(400);
      expect(
        runs.flatMap(({ t }) => t.receipts.filter((x) => x.amount_cents === P_(t) * 2n)).length,
      ).toBeGreaterThan(30);
      // An installment the month-end reported unpaid, satisfied within five days after it.
      expect(
        countMonths((x) =>
          applyFifo(x.t.installments, x.t.receipts).installments.some(
            (i) =>
              i.due_date <= x.state.as_of &&
              i.satisfied_on !== null &&
              i.satisfied_on > x.state.as_of &&
              daysBetween(x.state.as_of, i.satisfied_on) <= 5,
          ),
        ),
      ).toBeGreaterThan(15);
      // Prepaid: an installment satisfied in a month before its own.
      expect(
        count(({ t }) =>
          applyFifo(t.installments, t.receipts).installments.some(
            (i) => i.satisfied_on !== null && i.satisfied_on.slice(0, 7) < i.due_date.slice(0, 7),
          ),
        ),
      ).toBeGreaterThan(15);
    });

    it("draws forbearance frozen and aging, entered current, at 1 to 29 days and at 30 or more", () => {
      const fb = months.filter((x) => x.state.condition.kind === "forbearance");
      const entry = (x: Month) =>
        x.state.condition.kind === "forbearance" ? x.state.condition : null;
      expect(fb.filter((x) => x.t.policy.forbearance_status === "freeze").length).toBeGreaterThan(
        150,
      );
      expect(
        fb.filter((x) => x.t.policy.forbearance_status === "contractual_aging").length,
      ).toBeGreaterThan(100);
      // Frozen where the ledger would say otherwise.
      expect(
        fb.filter(
          (x) =>
            x.t.policy.forbearance_status === "freeze" &&
            x.r.furnished &&
            x.r.account_status !== statusForDays(x.days),
        ).length,
      ).toBeGreaterThan(100);
      expect(
        fb.filter(
          (x) => entry(x)!.entry_status === "11" && entry(x)!.entry_amount_past_due_cents === 0n,
        ).length,
      ).toBeGreaterThan(20);
      expect(
        fb.filter(
          (x) => entry(x)!.entry_status === "11" && entry(x)!.entry_amount_past_due_cents > 0n,
        ).length,
      ).toBeGreaterThan(20);
      for (const s of ["71", "78", "80", "82"])
        expect(fb.filter((x) => entry(x)!.entry_status === s).length, s).toBeGreaterThan(15);
      expect(
        fb.filter(
          (x) => (x.m.in_force[0] as { plan_payment_cents: bigint }).plan_payment_cents > 0n,
        ).length,
      ).toBeGreaterThan(60);
      // Ended by a reinstatement (nothing unpaid, no condition) and by a deferral, each with the plan the month before.
      const after = (kind: string) =>
        months.filter(
          (x) =>
            x.k > 0 &&
            x.t.months[x.k - 1]!.in_force.some((e) => e.kind === "forbearance_plan") &&
            (kind === "none" ? x.m.in_force.length === 0 : kinds(x).includes(kind as never)),
        ).length;
      expect(after("none")).toBeGreaterThan(10);
      expect(after("payment_deferral")).toBeGreaterThan(20);
    });

    it("draws repayment plans with and without AC, trials, and both under a referral", () => {
      const plan = fm.filter((x) => x.state.condition.kind === "repayment_plan");
      expect(plan.filter((x) => x.r.special_comment === "AC").length).toBeGreaterThan(30);
      expect(plan.filter((x) => x.r.special_comment === "").length).toBeGreaterThan(20);
      expect(plan.filter((x) => x.r.special_comment === "BO").length).toBeGreaterThan(10);
      // The amount past due is the plan's arrears, not the ledger's.
      expect(
        plan.filter(
          (x) =>
            x.r.amount_past_due !==
            metro2Money(
              BigInt(x.unpaid) * (x.t.loan.pi_cents + x.t.loan.escrow_cents),
              x.t.policy.metro2_rounding,
            ),
        ).length,
      ).toBeGreaterThan(40);
      const trial = fm.filter((x) => x.state.condition.kind === "trial");
      expect(trial.length).toBeGreaterThan(150);
      expect(trial.filter((x) => kinds(x).includes("foreclosure_referral")).length).toBeGreaterThan(
        20,
      );
      // After a failed trial, contractual and AC gone.
      expect(
        fm.filter(
          (x) =>
            x.k > 0 &&
            x.t.months[x.k - 1]!.in_force.some((e) => e.kind === "trial_plan") &&
            x.m.in_force.every((e) => e.kind === "foreclosure_referral"),
        ).length,
      ).toBeGreaterThan(10);
    });

    it("draws modifications and deferrals, with K4 and without, each ending the referral before it", () => {
      expect(countMonths((x) => x.r.special_comment === "CO" && x.r.k4 !== null)).toBeGreaterThan(
        30,
      );
      expect(countMonths((x) => x.r.special_comment === "CO" && x.r.k4 === null)).toBeGreaterThan(
        30,
      );
      expect(
        countMonths((x) => x.r.special_comment === "CO" && x.r.terms_duration === "480"),
      ).toBeGreaterThan(40);
      expect(
        countMonths((x) => x.r.special_comment === "CO" && x.r.terms_duration === "360"),
      ).toBeGreaterThan(10);
      const deferral = fm.filter((x) => x.state.condition.kind === "deferral");
      expect(deferral.length).toBeGreaterThan(60);
      expect(deferral.every((x) => x.r.k4 !== null && x.r.account_status === "11")).toBe(true);
      // A workout ends the foreclosure (13.3): a referral before it, and none in force beside it.
      const referredBefore = (x: Month) =>
        x.k > 0 && x.t.months[x.k - 1]!.in_force.some((e) => e.kind === "foreclosure_referral");
      expect(
        fm.filter(
          (x) => ["deferral", "modification"].includes(x.state.condition.kind) && referredBefore(x),
        ).length,
      ).toBeGreaterThan(10);
      expect(
        fm.filter(
          (x) =>
            ["deferral", "modification"].includes(x.state.condition.kind) &&
            kinds(x).includes("foreclosure_referral"),
        ),
      ).toEqual([]);
      // BO only while the delinquency runs: never on a month-end with nothing unpaid.
      expect(countMonths((x) => x.r.special_comment === "BO")).toBeGreaterThan(200);
      expect(countMonths((x) => x.r.special_comment === "BO" && x.unpaid === 0)).toBe(0);
    });

    it("draws a prior servicer's hand-off, full and short, and a loan boarded with none", () => {
      expect(count(({ t }) => t.last_record === null)).toBeGreaterThan(25);
      expect(
        count(
          ({ t }) =>
            t.last_record?.furnished_by === "prior_servicer" &&
            t.last_record.payment_history_profile.length < 24,
        ),
      ).toBeGreaterThan(15);
      expect(
        count(
          ({ t }) =>
            t.last_record?.furnished_by === "prior_servicer" &&
            t.last_record.payment_history_profile.length === 24,
        ),
      ).toBeGreaterThan(15);
      const first = (a: Metro2Answer) => (a.records[0]!.furnished ? a.records[0] : null);
      expect(
        count(({ a }) => first(a)?.payment_history_profile === "B".repeat(24)),
      ).toBeGreaterThan(25);
      // A hand-off's delinquency carried: its DOFD kept in the first month.
      expect(
        count(
          ({ t, a }) =>
            t.last_record?.furnished_by === "prior_servicer" &&
            t.last_record.date_of_first_delinquency !== "00000000" &&
            first(a)?.date_of_first_delinquency === t.last_record.date_of_first_delinquency,
        ),
      ).toBeGreaterThan(5);
    });

    it("draws every identifier error, omitted, with D in the next month's PHP", () => {
      const omitted = months
        .filter((x) => !x.r.furnished)
        .map((x) => x.r as Extract<MonthRecord, { furnished: false }>);
      for (const e of ["K3_MIN_MISSING", "MIN_NOT_18_DIGITS", "K3_FNMA_LOAN_NUMBER"])
        expect(omitted.filter((r) => r.hard_errors.includes(e)).length, e).toBeGreaterThan(20);
      expect(omitted.filter((r) => r.hard_errors.length === 2).length).toBeGreaterThan(5);
      expect(countMonths((x) => x.r.payment_history_profile[0] === "D")).toBeGreaterThan(60);
      expect(countMonths((x) => x.r.payment_history_profile.startsWith("DD"))).toBeGreaterThan(5);
    });

    it("draws every consumer segment and ECOA the rules give", () => {
      const segs = runs.flatMap(({ a }) => a.consumers);
      for (const [segment, ecoa, n] of [
        ["base", "1", 300],
        ["base", "2", 150],
        ["J1", "2", 100],
        ["J2", "2", 50],
      ] as const)
        expect(segs.filter((c) => c.segment === segment && c.ecoa === ecoa).length).toBeGreaterThan(
          n,
        );
      expect(
        segs.filter((c) => c.ecoa === "T" && c.special_comment === "H").length,
      ).toBeGreaterThan(20);
      expect(
        segs.filter((c) => c.ecoa !== "T" && c.special_comment === "H").length,
      ).toBeGreaterThan(3);
      for (const [ecoa, n] of [
        ["X", 10],
        ["Z", 10],
        ["5", 5],
      ] as const)
        expect(segs.filter((c) => c.ecoa === ecoa).length, ecoa).toBeGreaterThan(n);
      expect(
        count(
          ({ t, a }) =>
            t.consumers.some((c) => c.successor_in_interest) &&
            a.consumers.length < t.consumers.length,
        ),
      ).toBeGreaterThan(10);
    });

    it("draws both roundings where they differ, and both terms", () => {
      const cents = (x: Month & { r: FurnishedRecord }) =>
        [x.state.pi_cents + x.state.escrow_cents, x.state.upb_cents].map((c) => c % 100n);
      expect(
        countMonths(
          (x) => x.t.policy.metro2_rounding === "round" && cents(x).some((c) => c >= 50n),
        ),
      ).toBeGreaterThan(300);
      expect(
        countMonths((x) => x.t.policy.metro2_rounding === "round" && cents(x)[0] === 50n),
      ).toBeGreaterThan(30);
      expect(
        countMonths(
          (x) => x.t.policy.metro2_rounding === "truncate" && cents(x).some((c) => c >= 50n),
        ),
      ).toBeGreaterThan(500);
      expect(count(({ t }) => t.policy.terms_duration === "remaining")).toBeGreaterThan(250);
    });

    /* What the reference and the engine both copy from the task, so neither would notice it wrong. */
    const monthsApart = (a: PlainDate, b: PlainDate) => {
      const x = parts(a);
      const y = parts(b);
      return (y.y - x.y) * 12 + (y.m - x.m);
    };
    const unpaidAt = (t: Metro2Task, on: PlainDate, strictly = false) =>
      applyFifo(
        t.installments,
        t.receipts.filter((r) => (strictly ? r.received_on < on : r.received_on <= on)),
      ).installments.filter(
        (i) => i.due_date <= on && (i.satisfied_on === null || i.satisfied_on > on),
      );

    it("keeps the books the note and the ledger make them, a modification's month apart", () => {
      for (const { t } of runs) {
        const term = t.loan.original_term_months;
        let left: number | null = null;
        for (const m of t.months) {
          if (m.in_force.some((e) => e.kind === "modification")) continue;
          // The note's first payment, from the term left.
          const first = addMonths(
            plainDate(`${m.month}-01`),
            -(term - m.books.remaining_term_months - 1),
          );
          expect(m.books.maturity_date, t.id).toBe(addMonths(first, term - 1));
          const asOf = asOfOf(m.month);
          const paid = ledgerAsOf(t, asOf).filter(
            (i) => i.satisfied_on !== null && i.satisfied_on <= asOf,
          ).length;
          expect(m.books.upb_cents, `${t.id} ${m.month}`).toBe(
            balanceAfter(
              t.loan.original_amount_cents,
              t.loan.note_rate_pct,
              t.loan.pi_cents,
              monthsApart(first, t.installments[0]!.due_date) + paid,
            ),
          );
          if (left !== null) expect(m.books.remaining_term_months, t.id).toBe(left - 1);
          left = m.books.remaining_term_months;
        }
      }
    });

    it("hands over a last record the ledger agrees with: its status, and a DOFD exactly when it is past 29 days", () => {
      let checked = 0;
      for (const { t } of runs) {
        const last = t.last_record;
        if (!last) continue;
        expect(last.account_status === "11", t.id).toBe(
          last.date_of_first_delinquency === "00000000",
        );
        // Contractual status but under the freeze.
        if (last.special_comment === "CP") continue;
        const on = asOfOf(last.month);
        const oldest = unpaidAt(t, on)[0];
        expect(last.account_status, t.id).toBe(
          statusForDays(oldest ? daysBetween(oldest.due_date, on) : 0),
        );
        checked++;
      }
      expect(checked).toBeGreaterThan(900);
    });

    it("pays a payoff with funds, which the month's actual payment counts", () => {
      let payoffs = 0;
      for (const { t, a } of runs)
        for (const [k, m] of t.months.entries())
          for (const e of m.in_force) {
            if (e.kind !== "payoff") continue;
            payoffs++;
            expect(e.payoff_funds_cents > m.books.upb_cents, t.id).toBe(true);
            const paid = BigInt(furnished(a.records[k]).actual_payment_amount) * 100n;
            expect(paid + 100n > e.payoff_funds_cents, t.id).toBe(true);
          }
      expect(payoffs).toBeGreaterThan(30);
    });

    it("refers a loan 121 days or more into its delinquency, and keeps the referral only while that delinquency runs", () => {
      const referrals = new Set<string>();
      for (const { t } of runs)
        for (const m of t.months)
          for (const e of m.in_force) {
            if (e.kind !== "foreclosure_referral") continue;
            expect(
              referralEnded(t.installments, t.receipts, e.referred_on, asOfOf(m.month)),
              t.id,
            ).toBe(false);
            if (referrals.has(`${t.id} ${e.referred_on}`)) continue;
            referrals.add(`${t.id} ${e.referred_on}`);
            const oldest = unpaidAt(t, e.referred_on)[0];
            expect(oldest, t.id).toBeDefined();
            expect(daysBetween(oldest!.due_date, e.referred_on), t.id).toBeGreaterThanOrEqual(121);
          }
      expect(referrals.size).toBeGreaterThan(100);
      // A cure ends one: a referral in force one month, gone the next with no workout or closing.
      const referral = (m: Metro2Month) =>
        m.in_force.some((e) => e.kind === "foreclosure_referral");
      expect(
        count(({ t }) =>
          t.months.some(
            (m, k) =>
              k > 0 &&
              referral(t.months[k - 1]!) &&
              !referral(m) &&
              m.in_force.every((e) => e.kind === "repayment_plan"),
          ),
        ),
      ).toBeGreaterThan(5);
    });

    it("draws workouts the servicing app could grant: a trial before every modification, 2 to 6 installments deferred, 12 months seasoned", () => {
      let mods = 0;
      let trialBeforeWindow = 0;
      let deferrals = 0;
      let sixBehind = 0;
      for (const { t } of runs) {
        const P_ = t.loan.pi_cents + t.loan.escrow_cents;
        for (const [k, m] of t.months.entries())
          for (const e of m.in_force) {
            if (e.kind === "trial_plan") expect(e.trial_payment_cents < P_, t.id).toBe(true);
            if (e.kind === "modification") {
              mods++;
              // 12.8: three trial months before it, the last record carrying AC for one before the window.
              for (let i = Math.max(0, k - 3); i < k; i++)
                expect(
                  t.months[i]!.in_force.some((x) => x.kind === "trial_plan"),
                  t.id,
                ).toBe(true);
              if (k < 3) {
                expect(t.last_record?.special_comment, t.id).toBe("AC");
                trialBeforeWindow++;
              }
              expect(e.new_piti_cents < P_, t.id).toBe(true);
              expect(m.books.maturity_date, t.id).toBe(
                addMonths(e.effective_on, e.new_term_months - 1),
              );
              expect(m.books.remaining_term_months, t.id).toBe(e.new_term_months);
              // Evaluated the month before the trial, a year or more after the note.
              expect(
                monthsApart(t.loan.note_date, addMonths(e.effective_on, -4)),
                t.id,
              ).toBeGreaterThanOrEqual(13);
            }
            if (e.kind === "payment_deferral") {
              deferrals++;
              const deferred = unpaidAt(t, e.completed_on).length;
              expect(m.books.deferred_principal_cents, t.id).toBe(P_ * BigInt(deferred));
              expect(deferred, t.id).toBeGreaterThanOrEqual(2);
              expect(deferred, t.id).toBeLessThanOrEqual(6);
              // Evaluated at the month-end before: six behind then, the installment is paid first (12.6 rule 4).
              const evaluated = addDays(plainDate(`${m.month}-01`), -1);
              const behind = unpaidAt(t, evaluated).length;
              expect(behind, t.id).toBeLessThanOrEqual(6);
              if (behind === 6) {
                sixBehind++;
                expect(deferred, t.id).toBe(6);
              }
              expect(monthsApart(t.loan.note_date, evaluated), t.id).toBeGreaterThanOrEqual(13);
            }
          }
      }
      expect(mods).toBeGreaterThan(60);
      expect(trialBeforeWindow).toBeGreaterThan(5);
      expect(deferrals).toBeGreaterThan(60);
      expect(sixBehind).toBeGreaterThan(3);
    });

    it("fails a trial only by a payment missed: nothing comes in the month a trial ends without a modification", () => {
      let failed = 0;
      for (const { t } of runs) {
        const trial = t.months.map((m) => m.in_force.some((e) => e.kind === "trial_plan"));
        const last = trial.lastIndexOf(true);
        if (last < 0 || last === t.months.length - 1) continue;
        const next = t.months[last + 1]!;
        if (next.in_force.some((e) => e.kind === "modification")) continue;
        failed++;
        expect(
          t.receipts.filter((r) => r.received_on.slice(0, 7) === next.month),
          t.id,
        ).toEqual([]);
      }
      expect(failed).toBeGreaterThan(15);
    });

    it("runs every repayment plan in its window, a plan's arrears falling and a partial payment agreement's growing", () => {
      for (const { t, edge } of runs) {
        const P_ = t.loan.pi_cents + t.loan.escrow_cents;
        const plans = t.months.map((m) => m.in_force.find((e) => e.kind === "repayment_plan"));
        if (edge === "repayment_plan") expect(plans.some(Boolean), t.id).toBe(true);
        for (let k = 1; k < plans.length; k++) {
          const [was, now] = [plans[k - 1], plans[k]];
          if (was?.kind !== "repayment_plan" || now?.kind !== "repayment_plan") continue;
          if (now.plan_payment_cents < P_)
            expect(now.remaining_arrears_cents - was.remaining_arrears_cents, t.id).toBe(
              P_ - now.plan_payment_cents,
            );
          else expect(now.remaining_arrears_cents < was.remaining_arrears_cents, t.id).toBe(true);
        }
      }
    });

    it("draws consumer flags only as 8.1 rule 5 allows them together, a liable consumer on every tradeline", () => {
      for (const { t, a } of runs) {
        for (const c of t.consumers) {
          if (c.successor_in_interest)
            expect(Boolean(c.released || c.deceased || c.never_liable), t.id).toBe(false);
          if (c.released) expect(Boolean(c.never_liable) || c.position === 1, t.id).toBe(false);
          if (c.position === 1) expect(Boolean(c.never_liable || c.released), t.id).toBe(false);
        }
        if (a.consumers.length > 0)
          expect(
            a.consumers.some((c) => ["1", "2", "5", "X"].includes(c.ecoa)),
            t.id,
          ).toBe(true);
      }
    });

    it("draws receipts on a month's last day that its month-end counts, and on a forbearance's eve", () => {
      // A receipt dated on the as_of decides the month-end's unpaid installments: "on or before".
      expect(
        months.filter((x) => unpaidAt(x.t, x.state.as_of, true).length !== x.unpaid).length,
      ).toBeGreaterThan(40);
      // And the entry figures, on the day before the plan.
      expect(
        count(({ t }) =>
          t.months.some((m) =>
            m.in_force.some((e) => {
              if (e.kind !== "forbearance_plan") return false;
              const eve = addDays(e.effective_on, -1);
              return unpaidAt(t, eve, true).length !== unpaidAt(t, eve).length;
            }),
          ),
        ),
      ).toBeGreaterThan(5);
    });
  });
});
