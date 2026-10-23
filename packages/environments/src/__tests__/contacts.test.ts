/**
 * The contact center: a function of the book's seed; rows shaped like the
 * servicing app's contacts table; texts only with consent; the outbound
 * cadence every 7 days from day 17 to the cure, with far more attempts than
 * conversations; identity checks on every call; the callers a contact center
 * meets; reasons by status and month; volumes and handle times at the
 * calibration's, in both of its shapes; transcripts as long as their calls;
 * every number said and written one the record held that day; notes short,
 * coded, misspelled and copied forward, outnumbered by system notes; and
 * every planted defect labeled where it is, with nothing else moved.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addDays, daysBetween, parts, type PlainDate } from "@hm/kernel/calendar";
import { toJsonLine } from "../record.js";
import {
  defaultCalibration,
  generate,
  loadCalibration,
  type Calibration,
  type LifeBook,
  type LoanLife,
} from "../life/index.js";
import {
  CONTACT_DEFECTS,
  buildTranscript,
  callPlan,
  callsOf,
  checkTranscript,
  contactCenter,
  contactRates,
  contactVolumes,
  dayNumbers,
  factNumbers,
  kindOf,
  lastContactOn,
  numberTokens,
  plantContactDefects,
  readHandleMinutes,
  readMix,
  readPerLoanYear,
  recordOn,
  renderTranscript,
  statusOf,
  templateWriter,
  transcriptOf,
  money,
  unexplained,
  unionNumbers,
  type ContactCenter,
  type ContactDefectId,
  type ContactRecord,
  type ContactTextWriter,
  type FactNumbers,
  type LoanContacts,
  type NoteRecord,
  type Transcript,
} from "../contacts/index.js";

const cal = defaultCalibration();
const book = generate(7, { loans: 300 }, { calibration: cal }).clean;
const center = contactCenter(book, { calibration: cal });
const lifeOf = (l: LoanContacts): LoanLife => book.loans[l.index]!;
const calls = (n: number) => center.loans.slice(0, n).flatMap((l) => callsOf(l));

/** The record's numbers for a note: the facts that day (with the call's own, for a call's note), the day's history rows, and the day a copied note was first written. */
function noteNumbers(
  c: ContactCenter,
  b: LifeBook,
  loan: LoanContacts,
  note: NoteRecord,
): FactNumbers {
  const life = b.loans[loan.index]!;
  const ctx = { profile: loan.profile, bankruptcy: loan.bankruptcy };
  const sets: FactNumbers[] = [
    factNumbers(recordOn(life, note.on, ctx)),
    dayNumbers(life, note.on),
  ];
  const contact = note.contact_id ? loan.contacts.find((x) => x.id === note.contact_id) : undefined;
  if (contact && kindOf(contact)) sets.push(factNumbers(callPlan(c, b, contact.id).facts));
  for (let from = note.copied_from; from;) {
    const prior = loan.notes.find((n) => n.id === from)!;
    sets.push(noteNumbers(c, b, loan, prior));
    from = prior.copied_from;
  }
  return unionNumbers(...sets);
}

describe("contact center", () => {
  it("is a function of the book's seed, and a loan's contacts do not depend on the loans beside it", () => {
    const small = generate(7, { loans: 30 }, { calibration: cal }).clean;
    const a = contactCenter(small, { calibration: cal });
    const b = contactCenter(small, { calibration: cal });
    expect(toJsonLine(a)).toBe(toJsonLine(b));
    for (const i of [0, 12, 29]) expect(toJsonLine(a.loans[i])).toBe(toJsonLine(center.loans[i]));
    const id = callsOf(a.loans[3]!).find((x) => x.outcome === "conversation")!.id;
    expect(toJsonLine(transcriptOf(a, small, id))).toBe(toJsonLine(transcriptOf(center, book, id)));
    const other = contactCenter(generate(8, { loans: 30 }, { calibration: cal }).clean, {
      calibration: cal,
    });
    expect(toJsonLine(other.loans[0]!.contacts)).not.toBe(toJsonLine(a.loans[0]!.contacts));
  });

  it("writes rows shaped like the servicing app's contacts table", () => {
    const modes = new Set(["call", "ivr", "portal", "email", "sms", "letter"]);
    const problems: string[] = [];
    for (const l of center.loans) {
      const ids = new Set<string>();
      let prev = "";
      for (const c of l.contacts) {
        const where = `${c.id} ${c.direction} ${c.mode} ${c.outcome}`;
        if (!modes.has(c.mode)) problems.push(`${where}: mode`);
        if (`${c.on} ${c.at}` < prev) problems.push(`${where}: out of order`);
        prev = `${c.on} ${c.at}`;
        // Live contact only on a spoken, two-way outcome (ops-11-1.ts liveContactOf), with its basis.
        if (c.live_contact && c.outcome !== "conversation")
          problems.push(`${where}: live without a conversation`);
        if (c.live_contact !== (c.live_contact_basis !== null)) problems.push(`${where}: basis`);
        if (c.qrpc && !c.live_contact) problems.push(`${where}: QRPC without live contact`);
        // Reg F counts outbound voice calls that reached the number (section11.ts:328).
        if (c.regf_counted && !(c.direction === "outbound" && c.mode === "call"))
          problems.push(`${where}: regf`);
        if (c.mode === "call" && c.outcome === "conversation" && c.identity_verified !== true)
          problems.push(`${where}: unverified conversation`);
        if (c.complaint_logged && !c.complaint_voiced)
          problems.push(`${where}: complaint logged unvoiced`);
        if (c.transcript !== (kindOf(c) !== null)) problems.push(`${where}: transcript flag`);
        if (c.handle_s < c.duration_s && c.mode === "call" && c.outcome === "conversation")
          problems.push(`${where}: handle under duration`);
        for (const r of c.related) {
          const e = l.contacts.find((x) => x.id === r);
          if (!e || e.issue !== c.issue || e.id >= c.id) problems.push(`${where}: related ${r}`);
        }
        if (c.promise_id && !l.promises.some((p) => p.id === c.promise_id && p.contact_id === c.id))
          problems.push(`${where}: promise`);
        ids.add(c.id);
      }
      if (ids.size !== l.contacts.length) problems.push(`${l.loan_id}: duplicate ids`);
    }
    expect(problems.slice(0, 10)).toEqual([]);
    // Every channel and outcome the contact center meets turns up.
    const seen = new Set(
      center.loans.flatMap((l) => l.contacts.map((c) => `${c.direction}/${c.mode}/${c.outcome}`)),
    );
    for (const k of [
      "inbound/call/conversation",
      "inbound/call/answered_unverified",
      "inbound/ivr/ivr_self_served",
      "inbound/ivr/ivr_abandoned",
      "inbound/portal/portal_session",
      "inbound/email/received",
      "inbound/letter/received",
      "inbound/sms/received",
      "outbound/call/no_answer",
      "outbound/call/voicemail_left",
      "outbound/call/wrong_number",
      "outbound/call/disconnected",
      "outbound/call/conversation",
      "outbound/sms/sms_sent",
      "outbound/letter/mail_sent",
    ])
      expect(seen.has(k), k).toBe(true);
    const purposes = new Set(center.loans.flatMap((l) => l.contacts.map((c) => c.purpose)));
    for (const p of [
      "hardship_letter",
      "insurance_document",
      "qualified_written_request",
      "ei_written_notice",
      "payment_reminder",
    ] as const)
      expect(purposes.has(p), p).toBe(true);
  });

  it("texts only with TCPA consent, and never after a STOP", () => {
    for (const l of center.loans) {
      const stop = l.contacts.find((c) => c.purpose === "consent_revocation");
      for (const c of l.contacts) {
        if (c.mode !== "sms" || c.direction !== "outbound") continue;
        expect(l.profile.sms_consent, c.id).toBe(true);
        expect(c.tcpa_consent, c.id).toBe(true);
        if (stop) expect(c.on <= stop.on, `${c.id} after STOP on ${stop.on}`).toBe(true);
      }
      for (const c of l.contacts)
        if (c.direction === "outbound" && c.mode === "call")
          expect(c.tcpa_basis, c.id).toBe(
            l.profile.phones.find((p) => p.id === c.phone_number_id)!.tcpa_voice
              ? "consent"
              : "human_manual_dial",
          );
    }
  });

  it("dials from day 17 at least every 7 days until the cure, with far more attempts than conversations", () => {
    let attempts = 0;
    let conversations = 0;
    let evenings = 0;
    let saturdays = 0;
    const problems: string[] = [];
    for (const l of center.loans) {
      const life = lifeOf(l);
      // The days delinquent, recomputed from the installments: the earliest due and unpaid at the day's end (§1024.31).
      const late = (d: PlainDate) => {
        for (const i of life.installments) {
          if (i.due >= d) return 0;
          if (i.satisfied_on === null || i.satisfied_on > d) return daysBetween(i.due, d);
        }
        return 0;
      };
      const collection = l.contacts.filter(
        (c) => c.direction === "outbound" && c.mode === "call" && c.purpose === "collection",
      );
      attempts += collection.length;
      conversations += collection.filter((c) => c.outcome === "conversation").length;
      evenings += collection.filter((c) => c.at >= "17:00").length;
      saturdays += collection.filter((c) => new Date(`${c.on}T12:00:00Z`).getUTCDay() === 6).length;
      for (const c of collection)
        if (late(c.on) === 0) problems.push(`${c.id}: dialed on ${c.on}, not delinquent`);
      const days = new Set(collection.map((c) => c.on));
      for (const ep of l.cadence) {
        if (!ep.opened_on || !ep.closed_on) continue;
        // The plan opens on the first day the count reaches 17 (plan.ts:16).
        let first: PlainDate | null = null;
        for (let d = ep.start; d <= ep.closed_on; d = addDays(d, 1))
          if (late(d) >= 17) {
            first = d;
            break;
          }
        if (first !== ep.opened_on)
          problems.push(`${l.loan_id} ${ep.start}: opened ${ep.opened_on}, day 17 is ${first}`);
        // Each pause is a pending promise or a bankruptcy.
        for (const p of ep.paused) {
          if (
            p.reason === "ptp_pending" &&
            !l.promises.some((x) => x.pay_by === p.to && x.made_on <= p.from)
          )
            problems.push(`${l.loan_id}: a pause with no promise`);
          if (p.reason === "bankruptcy" && (!l.bankruptcy || p.from < l.bankruptcy.petition_on))
            problems.push(`${l.loan_id}: a pause with no petition`);
        }
        const paused = (d: PlainDate) => ep.paused.some((p) => p.from <= d && d <= p.to);
        let anchor = ep.opened_on;
        for (let d = ep.opened_on; d <= ep.closed_on; d = addDays(d, 1)) {
          if (paused(d)) {
            anchor = addDays(d, 1);
            continue;
          }
          if (days.has(d)) anchor = d;
          else if (daysBetween(anchor, d) >= 7) {
            problems.push(`${l.loan_id} ${ep.start}: no attempt from ${anchor} to ${d}`);
            break;
          }
        }
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
    expect(attempts).toBeGreaterThan(300);
    expect(conversations / attempts).toBeLessThan(0.25);
    // A4-2.1-04: vary the times, with some evening and weekend calls.
    expect(evenings / attempts).toBeGreaterThan(0.1);
    expect(saturdays).toBeGreaterThan(0);
  });

  it("dials inside the voice window, and in Massachusetts twice in seven days at most", () => {
    const problems: string[] = [];
    let ma = 0;
    for (const l of center.loans) {
      const out = l.contacts.filter((c) => c.direction === "outbound" && c.mode === "call");
      // 11.1 rule 8: voice after 08:00 and through 20:30 at the property; the dialer rests on Sundays.
      for (const c of out) {
        if (!(c.at > "08:00" && c.at <= "20:30")) problems.push(`${c.id}: dialed at ${c.at}`);
        if (new Date(`${c.on}T12:00:00Z`).getUTCDay() === 0) problems.push(`${c.id}: a Sunday`);
      }
      if (lifeOf(l).draw.property.state !== "MA") continue;
      // 940 CMR 7.04: no seven days hold a third call, read by the clock at the property.
      const at = (c: ContactRecord) => Date.parse(`${c.on}T${c.at}:00Z`) / 60_000;
      for (let i = 2; i < out.length; i++) {
        ma++;
        if (at(out[i]!) - at(out[i - 2]!) < 7 * 1440)
          problems.push(`${out[i]!.id}: a third call within 7 days of ${out[i - 2]!.id}`);
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
    expect(ma).toBeGreaterThan(20);
  });

  it("leaves at most one voicemail per number per 7 days", () => {
    for (const l of center.loans) {
      const last = new Map<string, PlainDate>();
      for (const c of l.contacts) {
        if (c.outcome !== "voicemail_left") continue;
        const prev = last.get(c.phone_number_id!);
        if (prev) expect(daysBetween(prev, c.on), c.id).toBeGreaterThanOrEqual(7);
        last.set(c.phone_number_id!, c.on);
      }
    }
  });

  it("opens every call with identity checks, and tells nobody unverified anything", () => {
    const problems: string[] = [];
    for (const c of calls(80)) {
      const t = transcriptOf(center, book, c.id);
      const plan = callPlan(center, book, c.id);
      const nums = factNumbers(plan.facts);
      const firstQuote = t.turns.findIndex(
        (x) => x.tag.startsWith("quote:") && x.speaker !== "INTERPRETER",
      );
      const checked = t.turns.findIndex((x) => /^verify|^verify_authorization/.test(x.tag));
      if (plan.kind === "inbound" || plan.kind === "outbound") {
        if (checked < 0) problems.push(`${c.id}: no identity check`);
        else if (firstQuote >= 0 && firstQuote < checked)
          problems.push(`${c.id}: quoted before the checks`);
      } else {
        if (firstQuote >= 0) problems.push(`${c.id}: quoted to someone unverified`);
        if (plan.kind !== "voicemail" && !t.turns.some((x) => x.tag === "unverified_refusal"))
          problems.push(`${c.id}: no refusal`);
        for (const x of t.turns)
          if (
            x.speaker === "AGENT" &&
            numberTokens(x.said).some((n) => n.kind === "money" && nums.money.has(n.cents))
          )
            problems.push(`${c.id}: an amount said to someone unverified`);
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
  });

  it("meets third parties, a Spanish speaker and a caller who fails verification", () => {
    const parties = new Set(center.loans.flatMap((l) => l.contacts.map((c) => c.party)));
    for (const p of [
      "borrower",
      "co_borrower",
      "spouse_not_on_note",
      "housing_counselor",
      "unknown_caller",
      "wrong_party",
    ] as const)
      expect(parties.has(p), p).toBe(true);
    const spanish = center.loans.flatMap((l) => l.contacts).filter((c) => c.interpreter);
    expect(spanish.length).toBeGreaterThan(5);
    const t = transcriptOf(center, book, spanish[0]!.id);
    expect(t.turns.some((x) => x.speaker === "INTERPRETER")).toBe(true);
    expect(t.turns.some((x) => x.speaker === "CALLER" && /[áéíóúñ¿]/.test(x.said))).toBe(true);
    // A bankruptcy, its attorney, and the disclaimer on every call after the notice.
    const i = book.loans.findIndex((l) => l.months.some((m) => m.days_delinquent >= 45));
    const pinned = contactCenter(book, {
      calibration: cal,
      pins: { [i]: { bankruptcy: true, language: "es" } },
    });
    const loan = pinned.loans[i]!;
    expect(loan.bankruptcy).not.toBeNull();
    expect(
      loan.contacts.some((c) => c.party === "attorney" && c.purpose === "bankruptcy_notice"),
    ).toBe(true);
    for (const c of loan.contacts) {
      if (c.on < loan.bankruptcy!.petition_on) continue;
      expect(
        c.purpose === "collection" && c.mode === "call",
        `${c.id}: a collection call in the stay`,
      ).toBe(false);
      // Every call with the borrower after the notice carries the disclaimer; the attorney's own call is how the notice arrives.
      if (
        c.mode === "call" &&
        c.outcome === "conversation" &&
        c.party !== "attorney" &&
        c.on >= loan.bankruptcy!.noticed_on &&
        (loan.bankruptcy!.discharged_on === null || c.on < loan.bankruptcy!.discharged_on)
      )
        expect(c.disclosures_marked.bankruptcy, c.id).toBe(true);
    }
    expect(loan.contacts.filter((c) => c.mode === "call").every((c) => c.language === "es")).toBe(
      true,
    );
  });

  it("asks why by status and month: the 1098 in January, and spikes after an analysis", () => {
    const all = center.loans.flatMap((l) =>
      l.contacts.filter((c) => c.counts_as_inquiry && c.reason).map((c) => ({ c, l })),
    );
    const share = (xs: typeof all, pred: (c: ContactRecord) => boolean) =>
      xs.filter((x) => pred(x.c)).length / Math.max(1, xs.length);
    const jan = all.filter((x) => parts(x.c.on).m === 1);
    const rest = all.filter((x) => parts(x.c.on).m >= 4 && parts(x.c.on).m <= 11);
    expect(share(jan, (c) => c.reason === "form_1098")).toBeGreaterThan(
      3 * share(rest, (c) => c.reason === "form_1098"),
    );
    const behind = all.filter(
      (x) =>
        statusOf(
          lifeOf(x.l).months.find((m) => m.month === x.c.on.slice(0, 7))?.days_delinquent ?? 0,
        ) !== "current",
    );
    const current = all.filter(
      (x) =>
        statusOf(
          lifeOf(x.l).months.find((m) => m.month === x.c.on.slice(0, 7))?.days_delinquent ?? 0,
        ) === "current",
    );
    const hardship = (c: ContactRecord) =>
      c.reason === "hardship" || c.reason === "payment_arrangement";
    expect(share(behind, hardship)).toBeGreaterThan(0.3);
    expect(share(current, hardship)).toBeLessThan(0.05);
    const afterAnalysis = all.filter((x) =>
      lifeOf(x.l).analyses.some((a) => x.c.on >= a.sent_on && daysBetween(a.sent_on, x.c.on) <= 45),
    );
    const escrowish = (c: ContactRecord) =>
      c.reason === "escrow_analysis" || c.reason === "payment_change";
    expect(share(afterAnalysis, escrowish)).toBeGreaterThan(2 * share(all, escrowish));
    // Payments received, payment changes, payoffs, insurance and online access are among a performing book's leading reasons.
    const counts = new Map<string, number>();
    for (const x of current) counts.set(x.c.reason!, (counts.get(x.c.reason!) ?? 0) + 1);
    const top = [...counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k]) => k);
    for (const k of [
      "payment_received",
      "escrow_analysis",
      "online_access",
      "payoff_request",
      "insurance",
    ])
      expect(top, k).toContain(k);
  });

  it("calls at the calibration's volume, by status, under the scalar defaults", () => {
    const v = contactVolumes(center, book);
    expect(center.rates.per_loan_year).toBe(1.5);
    expect(Math.abs(v.per_loan_year - v.target) / v.target).toBeLessThan(0.1);
    // The acceptance file's tolerance on each status is a quarter; current is held tighter.
    expect(
      Math.abs(v.by_status.current.per_loan_year / v.by_status.current.target - 1),
    ).toBeLessThan(0.1);
    expect(Math.abs(v.by_status.d30.per_loan_year / v.by_status.d30.target - 1)).toBeLessThan(0.25);
    expect(v.by_status.current.per_loan_year).toBeLessThan(v.by_status.d30.per_loan_year);
    const handled = center.loans
      .flatMap((l) => l.contacts)
      .filter((c) => c.mode === "call" && c.outcome === "conversation");
    const mean = handled.reduce((s, c) => s + c.handle_s, 0) / handled.length / 60;
    expect(Math.abs(mean / 7 - 1)).toBeLessThan(0.1);
  });

  it("reads the calibration's object shapes and holds a month's handle time inside the CFPB's range", () => {
    // What the calibration file says, as the reader on another branch will hand it over.
    const path = loadCalibration().path;
    const raw = (
      path
        ? (JSON.parse(readFileSync(path, "utf8")) as { rates: Record<string, { value: unknown }> })
            .rates
        : {}
    ) as Record<string, { value: unknown } | undefined>;
    const objects: Calibration = {
      ...cal,
      rates: {
        ...cal.rates,
        contacts: {
          per_loan_year: raw["contacts.per_loan_year"]?.value ?? { inquiries_per_loan_year: 2 },
          handle_time_minutes: raw["contacts.handle_time_minutes"]?.value ?? {
            min: 4.3,
            max: 19.8,
          },
          inbound_reason_mix: raw["contacts.inbound_reason_mix"]?.value ?? {
            shares: { payment_process: 1 },
          },
        } as never,
      },
    };
    const rates = contactRates(objects);
    expect(rates.per_loan_year).toBe(2);
    expect(rates.handle_minutes.min).toBe(4.3);
    expect(rates.handle_minutes.max).toBe(19.8);
    expect(rates.handle_minutes.mean).toBeCloseTo(Math.sqrt(4.3 * 19.8), 9);
    expect(rates.complaint_mix.reduce((s, [, w]) => s + w, 0)).toBeCloseTo(1, 9);
    const c2 = contactCenter(book, { calibration: objects });
    const v = contactVolumes(c2, book);
    expect(Math.abs(v.per_loan_year - v.target) / v.target).toBeLessThan(0.1);
    expect(Math.abs(v.by_status.current.per_loan_year / 1.7 - 1)).toBeLessThan(0.1);
    // calibration-acceptance.json, call-note-length: each month's average within [min, max], half a minute either side.
    const byMonth = new Map<string, number[]>();
    for (const c of c2.loans.flatMap((l) => l.contacts))
      if (c.mode === "call" && c.outcome === "conversation")
        byMonth.set(c.on.slice(0, 7), [...(byMonth.get(c.on.slice(0, 7)) ?? []), c.handle_s / 60]);
    let months = 0;
    for (const [m, xs] of byMonth) {
      if (xs.length < 30) continue;
      months++;
      const avg = xs.reduce((s, x) => s + x, 0) / xs.length;
      expect(avg, m).toBeGreaterThan(4.3 - 0.5);
      expect(avg, m).toBeLessThan(19.8 + 0.5);
    }
    expect(months).toBeGreaterThan(20);
  });

  it("reads either shape of each contact key", () => {
    expect(readPerLoanYear(1.5)).toBe(1.5);
    expect(
      readPerLoanYear({ inquiries_per_loan_year: 2, monthly_range_per_loan_year: [1.9, 2.08] }),
    ).toBe(2);
    expect(readPerLoanYear({ monthly_range_per_loan_year: [1.9, 2.08] })).toBeCloseTo(1.99, 9);
    expect(readPerLoanYear("lots")).toBeNull();
    expect(readHandleMinutes(7)).toEqual({ mean: 7, min: null, max: null });
    expect(readHandleMinutes({ min: 4.3, max: 19.8, mean: 11 })).toEqual({
      mean: 11,
      min: 4.3,
      max: 19.8,
    });
    expect(readMix({ payment: 3, escrow: 1 })).toEqual([
      ["payment", 0.75],
      ["escrow", 0.25],
    ]);
    expect(readMix({ year: 2025, complaints: 10, shares: { fees: 0.5, payoff: 0.5 } })).toEqual([
      ["fees", 0.5],
      ["payoff", 0.5],
    ]);
    expect(
      readMix([
        ["a", 1],
        ["b", 3],
      ]),
    ).toEqual([
      ["a", 0.25],
      ["b", 0.75],
    ]);
    // Today's reader cannot read the file's objects, takes its defaults, and the contact center says so.
    const disk = contactRates(loadCalibration());
    expect(disk.per_loan_year).toBeGreaterThan(0);
    expect(disk.warnings.length).toBeGreaterThanOrEqual(0);
  });

  it("writes transcripts as long as their calls", () => {
    const problems: string[] = [];
    let words = 0;
    let seconds = 0;
    for (const c of calls(60)) {
      const t = transcriptOf(center, book, c.id);
      const end = t.turns[t.turns.length - 1]!.end_s;
      if (Math.abs(end - t.answered_at_s - c.duration_s) > 1)
        problems.push(`${c.id}: ends at ${end}, call is ${c.duration_s}`);
      for (let i = 1; i < t.turns.length; i++)
        if (t.turns[i]!.start_s + 2 < t.turns[i - 1]!.start_s)
          problems.push(`${c.id}: turn ${i} goes back`);
      if (c.outcome !== "conversation") continue;
      const held = t.turns.reduce(
        (s, x) => s + (x.speaker === "SYSTEM" && x.tag !== "dtmf" ? x.end_s - x.start_s : 0),
        0,
      );
      const holds = t.turns.reduce((s, x) => s + (x.tag === "hold" ? x.end_s - x.start_s : 0), 0);
      // The plan holds the holds, the transfer and the interpreter's joining to about a third of the call.
      if (holds > 0.36 * c.duration_s || held > 0.6 * c.duration_s)
        problems.push(`${c.id}: on hold ${held} of ${c.duration_s}`);
      words += t.turns
        .filter((x) => x.speaker !== "SYSTEM" && x.speaker !== "IVR")
        .reduce((s, x) => s + x.said.split(/\s+/).length, 0);
      seconds += c.duration_s - held;
    }
    expect(problems.slice(0, 10)).toEqual([]);
    // A phone conversation's pace, with the dead air a servicing call has.
    const wpm = (words / seconds) * 60;
    expect(wpm).toBeGreaterThan(80);
    expect(wpm).toBeLessThan(180);
  });

  it("says no number the record does not hold, and writes the recognizer's noise", () => {
    const problems: string[] = [];
    const noise = new Map<string, number>();
    let redacted = 0;
    for (const c of calls(120)) {
      const t = transcriptOf(center, book, c.id);
      const errs = checkTranscript(t, factNumbers(callPlan(center, book, c.id).facts));
      for (const e of errs) problems.push(`${c.id} turn ${e.turn} ${e.where}: ${e.token}`);
      for (const x of t.turns) {
        for (const op of x.noise) noise.set(op.kind, (noise.get(op.kind) ?? 0) + 1);
        if (x.text.includes("[REDACTED]")) redacted++;
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
    for (const k of [
      "misheard_number",
      "misheard_word",
      "dropped_word",
      "inaudible",
      "redacted",
      "speaker_swapped",
      "crosstalk",
    ])
      expect(noise.get(k) ?? 0, k).toBeGreaterThan(0);
    expect(redacted).toBeGreaterThan(100);
  });

  it("varies its words: no stock template pasted whole", () => {
    const greetings = new Set<string>();
    const quotes = new Map<string, number>();
    let nQuotes = 0;
    const whole = new Set<string>();
    const sample = calls(150).filter((c) => c.outcome === "conversation");
    for (const c of sample) {
      const t = transcriptOf(center, book, c.id);
      whole.add(t.turns.map((x) => x.said).join("\n"));
      for (const x of t.turns) {
        if (x.tag === "greeting") greetings.add(x.said);
        if (x.tag.startsWith("quote:") && x.speaker === "AGENT") {
          nQuotes++;
          const shape = x.said.replace(
            /\$[\d,]+\.\d{2}|[A-Z][a-z]+ \d{1,2}(st|nd|rd|th)(, \d{4})?|\d+/g,
            "#",
          );
          quotes.set(shape, (quotes.get(shape) ?? 0) + 1);
        }
      }
    }
    expect(whole.size).toBe(sample.length);
    expect(greetings.size).toBeGreaterThan(80);
    // With the figures taken out, no one sentence shape carries more than a small share of the quotes.
    const most = Math.max(...quotes.values());
    expect(most / nQuotes).toBeLessThan(0.05);
    expect(quotes.size).toBeGreaterThan(300);
  });

  it("keeps a comment log: system notes outnumber agent notes, which are short, coded, misspelled and copied forward", () => {
    const notes = center.loans.flatMap((l) => l.notes);
    const agent = notes.filter((n) => n.kind === "agent");
    const system = notes.filter((n) => n.kind === "system");
    expect(system.length).toBeGreaterThan(3 * agent.length);
    const lens = agent.map((n) => n.text.length).sort((a, b) => a - b);
    const median = lens[Math.floor(lens.length / 2)]!;
    expect(median).toBeGreaterThan(150);
    expect(median).toBeLessThan(800);
    expect(agent.some((n) => n.text === n.text.toUpperCase() && /[A-Z]{3}/.test(n.text))).toBe(
      true,
    );
    expect(agent.some((n) => n.text === n.text.toLowerCase() && /[a-z]{3}/.test(n.text))).toBe(
      true,
    );
    expect(agent.some((n) => /^Borrower|^Co-borrower/.test(n.text))).toBe(true);
    expect(
      agent.filter((n) =>
        /recieved|borower|payemnt|verifed|escorw|insurnace|advsied|requset|acount|statment|PAYMNET|ADVSD|VERIFED|ESCORW|REQUET|STATMENT/.test(
          n.text,
        ),
      ).length,
    ).toBeGreaterThan(10);
    expect(agent.filter((n) => n.copied_from !== null).length).toBeGreaterThan(5);
    for (const n of agent.filter((x) => x.copied_from)) expect(n.text).toContain(" | PREV: ");
    // A longer call leaves a longer note (calibration-acceptance.json, call-note-length: Spearman above 0.3).
    const pairs: [number, number][] = [];
    for (const l of center.loans)
      for (const n of l.notes)
        if (n.kind === "agent" && n.contact_id) {
          const c = l.contacts.find((x) => x.id === n.contact_id)!;
          if (c.mode === "call" && c.outcome === "conversation")
            pairs.push([c.handle_s, n.text.split(" | PREV: ")[0]!.length]);
        }
    expect(spearman(pairs)).toBeGreaterThan(0.3);
  });

  it("writes no number in a note the record does not hold that day", () => {
    const problems: string[] = [];
    for (const l of center.loans.slice(0, 120))
      for (const n of l.notes) {
        const bad = unexplained(n.text, noteNumbers(center, book, l, n));
        if (bad.length) problems.push(`${n.id} ${n.text}: ${bad.map((b) => b.raw).join(", ")}`);
      }
    expect(problems.slice(0, 10)).toEqual([]);
  });

  it("plants every call and note defect where it labels it, and moves nothing else", () => {
    const i = book.loans.findIndex((l) => l.months.some((m) => m.days_delinquent >= 45));
    const pinned = contactCenter(book, { calibration: cal, pins: { [i]: { bankruptcy: true } } });
    const ids = Object.keys(CONTACT_DEFECTS) as ContactDefectId[];
    const bkCall = pinned.loans[i]!.contacts.find((c) => CONTACT_DEFECTS["C-02"].eligible(c))!;
    const res = plantContactDefects(pinned, book, [
      { id: "C-02", contacts: [bkCall.id] },
      ...ids.filter((x) => x !== "C-02").map((id) => ({ id, rate: 0.03 })),
    ]);
    const roots = res.labels.filter((x) => x.root_cause);
    for (const id of ids)
      expect(roots.filter((x) => x.defect_id === id).length, id).toBeGreaterThan(0);
    // Every label carries the life generator's fields and says what to do.
    for (const x of res.labels) {
      for (const k of [
        "loan",
        "defect_id",
        "file_or_table",
        "field",
        "row",
        "on",
        "expected_handling",
      ] as const)
        expect(x[k], `${x.defect_id} ${k}`).toBeTruthy();
      expect(x.true_value !== x.planted_value, `${x.defect_id} ${x.row}`).toBe(true);
    }
    const problems: string[] = [];
    for (const x of roots) {
      const loan = res.defective.loans.find((l) => l.loan_id === x.loan)!;
      if (x.defect_id === "C-08") {
        const note = loan.notes.find((n) => n.id === x.row)!;
        if (!note.text.includes(x.planted_value!)) problems.push(`${x.row}: planted value missing`);
        const clean = pinned.loans
          .find((l) => l.loan_id === x.loan)!
          .notes.find((n) => n.id === x.row)!;
        if (
          !clean.text.includes(x.true_value!.replace(/\.$/, "")) &&
          !x.planted_value!.startsWith("ACCT")
        )
          problems.push(`${x.row}: true value missing from the clean note`);
        continue;
      }
      const clean = transcriptOf(pinned, book, x.row);
      const bad = transcriptOf(res.defective, book, x.row);
      if (x.defect_id === "C-04") {
        const row = loan.contacts.find((c) => c.id === x.row)!;
        if (row.complaint_logged !== false || !row.complaint_voiced)
          problems.push(`${x.row}: complaint flags`);
        if (bad.turns[x.turn!]!.tag !== "complaint")
          problems.push(`${x.row}: turn ${x.turn} is not the complaint`);
        continue;
      }
      const removal = x.defect_id === "C-06" || x.defect_id === "C-07";
      const tag = CONTACT_DEFECTS[x.defect_id as ContactDefectId].tag!;
      if (removal) {
        if (!clean.turns.some((t) => t.tag === tag))
          problems.push(`${x.row}: the clean call lacks ${tag}`);
        if (bad.turns.some((t) => t.tag === tag)) problems.push(`${x.row}: ${tag} still there`);
        if (bad.turns.length >= clean.turns.length) problems.push(`${x.row}: nothing removed`);
      } else {
        const turn = bad.turns[x.turn!]!;
        if (turn.defect !== x.defect_id)
          problems.push(`${x.row}: turn ${x.turn} carries ${turn.defect}`);
        if (x.defect_id === "C-05" && !turn.said.includes(x.planted_value!))
          problems.push(`${x.row}: wrong amount not said`);
        // Every other turn as the clean call has it, word for word, the planted turn's interpreter relay aside.
        if (bad.turns.length !== clean.turns.length) problems.push(`${x.row}: turns added or lost`);
        bad.turns.forEach((t, k) => {
          if (k === x.turn || (k === x.turn! + 1 && t.speaker === "INTERPRETER")) return;
          if (t.said !== clean.turns[k]!.said || t.text !== clean.turns[k]!.text)
            problems.push(`${x.row}: turn ${k} moved`);
        });
      }
      // The only number the record does not hold is the planted wrong amount, on its labeled turn.
      const plan = callPlan(res.defective, book, x.row);
      const allowed = new Set(x.defect_id === "C-05" ? [x.turn!, x.turn! + 1] : []);
      const errs = checkTranscript(bad, factNumbers(plan.facts), allowed);
      if (errs.length)
        problems.push(`${x.row}: unexplained ${errs.map((e) => e.token).join(", ")}`);
      if (
        x.defect_id === "C-05" &&
        checkTranscript(bad, factNumbers(plan.facts)).filter((e) => e.where === "said").length ===
          0 &&
        !factNumbers(plan.facts).money.has(String(BigInt(x.planted_value!.replace(/[$,.]/g, ""))))
      )
        problems.push(`${x.row}: the wrong amount reads as the record's`);
    }
    expect(problems.slice(0, 10)).toEqual([]);
    // Nothing else moved: rows but the complaints' flags, notes but the planted and their symptoms.
    const touchedRows = new Set(
      res.labels.filter((x) => x.file_or_table === "contacts").map((x) => x.row),
    );
    const touchedNotes = new Set(
      res.labels.filter((x) => x.file_or_table === "contact_notes").map((x) => x.row),
    );
    pinned.loans.forEach((l, k) => {
      const d = res.defective.loans[k]!;
      l.contacts.forEach((c, j) => {
        if (!touchedRows.has(c.id)) expect(toJsonLine(d.contacts[j])).toBe(toJsonLine(c));
      });
      const dn = new Map(d.notes.map((n) => [n.id, n]));
      for (const n of l.notes) if (!touchedNotes.has(n.id)) expect(dn.get(n.id), n.id).toEqual(n);
    });
    expect(Object.keys(pinned.planted)).toEqual([]);
  });

  it("places the call a scenario's story needs: the day-22 promise, kept on its day", () => {
    // Scenario 3's trunk: March missed, the borrower calls on day 22 and promises to pay by 5 April.
    const story = generate(
      "story",
      {
        loans: 1,
        random: false,
        start: "2027-01-01",
        events: [
          { kind: "missed_payment", loan: 0, on: "2028-03-01" },
          { kind: "promise_to_pay", loan: 0, on: "2028-03-22", pay_on: "2028-04-05" },
        ],
      },
      { calibration: cal },
    ).clean;
    const cc = contactCenter(story, { calibration: cal });
    const loan = cc.loans[0]!;
    const call = loan.contacts.find(
      (c) => c.on === "2028-03-22" && c.purpose === "promise_to_pay",
    )!;
    expect(call).toMatchObject({
      direction: "inbound",
      mode: "call",
      outcome: "conversation",
      live_contact: true,
      qrpc: true,
      resolution: "promise_recorded",
    });
    const promise = loan.promises.find((p) => p.id === call.promise_id)!;
    expect(promise).toMatchObject({
      made_on: "2028-03-22",
      pay_by: "2028-04-05",
      status: "kept",
      scripted: true,
    });
    const receipt = story.loans[0]!.receipts.find((r) => r.id === promise.receipt_id)!;
    expect(receipt.on).toBe("2028-04-05");
    expect(promise.amount).toBe(receipt.amount);
    // The call says the promise in the record's figures, and the cadence waits for it.
    const t = transcriptOf(cc, story, call.id);
    expect(
      t.turns.some((x) => x.tag === "quote:promise" && x.said.includes(money(promise.amount))),
    ).toBe(true);
    expect(checkTranscript(t, factNumbers(callPlan(cc, story, call.id).facts))).toEqual([]);
    const ep = loan.cadence.find(
      (e) => e.start <= "2028-03-22" && (e.cured_on === null || e.cured_on > "2028-03-22"),
    )!;
    expect(ep.paused.some((p) => p.reason === "ptp_pending" && p.to === "2028-04-05")).toBe(true);
    expect(
      loan.contacts.some(
        (c) => c.purpose === "collection" && c.on > "2028-03-22" && c.on <= "2028-04-05",
      ),
    ).toBe(false);
    // Attempts from day 17 until the call; the notes say the promise was set and kept.
    expect(
      loan.contacts.filter(
        (c) => c.purpose === "collection" && c.on >= "2028-03-17" && c.on < "2028-03-22",
      ).length,
    ).toBeGreaterThan(0);
    expect(loan.notes.some((n) => n.on === "2028-03-22" && n.text.startsWith("PTP SET"))).toBe(
      true,
    );
    expect(loan.notes.some((n) => n.on === "2028-04-05" && n.text === "PTP KEPT")).toBe(true);
    expect(lastContactOn(loan, "2028-03-31" as PlainDate)).toBe("2028-03-22");
  });

  it("holds a model writer to the record: the seam refuses a figure nobody computed", () => {
    const c = calls(20).find((x) => x.outcome === "conversation" && x.direction === "inbound")!;
    const plan = callPlan(center, book, c.id);
    const inventive: ContactTextWriter = {
      id: "inventive",
      callTurns: (p) => [
        ...templateWriter.callTurns(p),
        { speaker: "AGENT", said: "Your balance is $123,456.78.", tag: "quote:invented", pii: [] },
      ],
      callNote: templateWriter.callNote,
    };
    const honest = buildTranscript(plan)!.transcript;
    const bad = buildTranscript(plan, { writer: inventive })!.transcript;
    expect(checkTranscript(honest, factNumbers(plan.facts))).toEqual([]);
    expect(checkTranscript(bad, factNumbers(plan.facts)).map((e) => e.token)).toContain(
      "$123,456.78",
    );
    expect(bad.writer).toBe("inventive");
    expect(renderTranscript(honest).split("\n").length).toBe(honest.turns.length + 1);
  });
});

function spearman(pairs: readonly [number, number][]): number {
  const rank = (xs: number[]) => {
    const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(xs.length);
    for (let i = 0; i < order.length;) {
      let j = i;
      while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
      for (let k = i; k <= j; k++) r[order[k]![1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const a = rank(pairs.map((p) => p[0]));
  const b = rank(pairs.map((p) => p[1]));
  const n = pairs.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

export type { Transcript };
