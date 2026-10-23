/**
 * Synthetic calls, seeded: no borrower's data, ever.
 *
 * Each task is a function of (split, suite seed, index). Its call comes from
 * the contact center over a small life book (one loan, or a few for a call
 * few loans make), both seeded from the task's key: a loan that falls behind
 * (or one that does not, or one that reached us by transfer already behind,
 * which makes the servicer a debt collector for it, or one whose borrower
 * files for bankruptcy), its contacts, and one of its calls with its
 * transcript, its note and the dialer's facts. The task is
 * aimed, in turn by index, at one edge, and within an edge its arms are taken
 * in turn too:
 *
 *   - eight clean calls, the negatives: an inbound conversation, an outbound
 *     collection call, a caller nobody verified (three ways), a voicemail, an
 *     AI voice call (a consenting mobile, or a landline under its cap), an
 *     active-duty servicemember told of the protections, a call during a
 *     bankruptcy case, and a debt collector's call;
 *   - the contact center's eight call and note defects, C-01 to C-08,
 *     planted by `plantContactDefects`;
 *   - fourteen of ours, Q-01 to Q-14: an AI voice that does not say it is
 *     automated; a dial that fails consent, the landline cap, the time zone
 *     (early and late), the call count (a debt collector's 7 and the
 *     policy's 5), a cease (oral and written), a bankruptcy or counsel; a
 *     servicemember not told; a threat; modification terms offered; a second
 *     voicemail in 7 days; a copy-library line read whole; and an invented
 *     figure.
 *
 * A draw is kept only when it is fair to grade (`judge`): the call without
 * the plant draws no finding and its note matches; the planted call draws
 * the plant's finding where it was planted, and nothing else but the
 * symptoms the plant names; and the rubric finds exactly the same on the
 * recognizer's text and labels as on what was said, by whom. Where the
 * recognizer's noise moves a finding, or the contact center's own dialer
 * dialed outside the rubric's window or over a state's cap, the draw is
 * redrawn, and docs/environments.md says so.
 */

import { addDays, type PlainDate } from "@hm/kernel/calendar";
import { rngFor, type Rng } from "../rng.js";
import type { LifeBook } from "../life/generate.js";
import type { Scenario, ScenarioEvent } from "../life/scenario.js";
import type { LoanLife } from "../life/simulate.js";
import {
  callPlan,
  callsOf,
  kindOf,
  plantContactDefects,
  slotsOf,
  transcriptOf,
  type BankruptcyCase,
  type CallKind,
  type CallPlan,
  type ContactCenter,
  type ContactDefectId,
  type ContactRecord,
  type LoanContacts,
  type ProfilePins,
  type Turn,
} from "../contacts/index.js";
import {
  CALL_TEMPLATES,
  digitRuns,
  figureRuns,
  inVoiceWindow,
  localTime,
  reviewCall,
  type CallFacts,
  type CallNote,
  type CallReview,
  type PreDialFacts,
  type RubricItem,
} from "../calls/index.js";
import type { Split } from "../refi/task.js";
import {
  AREA_ZONES,
  callFacts,
  heardLines,
  noteOf,
  preDialOf,
  priorInstants,
  recordsFor,
  saidLines,
  transcriptLines,
  underReview,
  zoneOf,
} from "./materials.js";
import {
  aiIntroduction,
  insertTurn,
  inventedLine,
  lowerEngine,
  militaryScript,
  negotiationLine,
  replaceTurn,
  templateLine,
  threatLine,
} from "./overlay.js";
import { CALL_QA_ENVIRONMENT_NAME, CALL_QA_ENVIRONMENT_VERSION, type CallQaTask } from "./task.js";
import { rebuild } from "./view.js";

export const callQaTaskId = (split: Split, suiteSeed: number, index: number): string =>
  `${CALL_QA_ENVIRONMENT_NAME}/${CALL_QA_ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

/** The edges, clean and planted interleaved, so any run of indexes holds both. */
export const CALL_QA_EDGES = [
  "clean_outbound",
  "C-05",
  "Q-04",
  "clean_inbound",
  "C-01",
  "Q-10",
  "clean_ai",
  "Q-01",
  "C-07",
  "clean_voicemail",
  "Q-12",
  "C-03",
  "clean_bankruptcy",
  "C-02",
  "Q-07",
  "clean_dc",
  "C-06",
  "Q-05",
  "clean_unverified",
  "C-04",
  "Q-11",
  "clean_military",
  "Q-09",
  "C-08",
  "Q-02",
  "Q-03",
  "Q-06",
  "Q-08",
  "Q-13",
  "Q-14",
] as const;
export type CallQaEdge = (typeof CALL_QA_EDGES)[number];
export const callQaEdgeOf = (index: number): CallQaEdge =>
  CALL_QA_EDGES[index % CALL_QA_EDGES.length]!;
/** An edge's arm: taken in turn by index, so each arm's share of the edge is fixed. */
export const callQaArmOf = (index: number, arms: number): number =>
  Math.floor(index / CALL_QA_EDGES.length) % arms;

/** Our defects, numbered apart from the contact center's C-01 to C-08. */
export const CALL_QA_DEFECTS: Readonly<Record<string, string>> = {
  "Q-01": "An AI voice that does not say it is an automated assistant",
  "Q-02": "An AI-voice call to a mobile number without TCPA consent",
  "Q-03": "A fourth AI-voice call to a landline in 30 days without written consent",
  "Q-04": "A call outside the voice window in one of the borrower's time zones",
  "Q-05": "A call over the 7-day call cap",
  "Q-06": "A call after a cease",
  "Q-07": "A collection call during a bankruptcy case",
  "Q-08": "A call to a borrower represented by counsel",
  "Q-09": "An active-duty servicemember not told of the protections",
  "Q-10": "A threat",
  "Q-11": "Modification terms offered on the call",
  "Q-12": "A second voicemail on a number within 7 days",
  "Q-13": "A copy-library line read whole",
  "Q-14": "A figure the record does not hold",
};

/* ── the loan a call is drawn from ──────────────────────────────────────── */

type Loan = "performing" | "delinquent" | "debt_collector" | "bankruptcy" | "spouse" | "long";

/** One loan, two and a half years from its first payment, behind the way the edge needs. */
export const HISTORY_MONTHS = 30;
/** Five years, for a call a loan makes rarely: a complaint voiced is about one handled call in twenty-five. */
export const LONG_HISTORY_MONTHS = 60;

/** A book of `n` such loans, each behind in its own months, and the contact center's pins for each. */
function scenarioFor(r: Rng, loan: Loan, n: number): { scenario: Scenario; pins: ProfilePins } {
  // A spouse not on the note, not authorized: the caller a desk most often cannot verify.
  const pins: ProfilePins =
    loan === "bankruptcy"
      ? { language: "en", bankruptcy: true }
      : loan === "spouse"
        ? { language: "en", spouse: { name: "Jordan Ellis", authorized: false } }
        : { language: "en" };
  const long = loan === "long";
  const events: ScenarioEvent[] = [];
  for (let i = 0; i < n; i++) {
    if (loan === "performing") continue;
    if (loan === "debt_collector") {
      const t = r.int(6, 14);
      events.push(
        { kind: "missed_payment", loan: i, month: t - 2 },
        { kind: "missed_payment", loan: i, month: t - 1 },
        { kind: "transfer_in", loan: i, month: t, day: r.int(2, 20) },
      );
      continue;
    }
    const k = r.int(3, 20);
    const second = loan === "bankruptcy" || r.chance(0.6);
    events.push({ kind: "missed_payment", loan: i, month: k });
    if (second) events.push({ kind: "missed_payment", loan: i, month: k + 1 });
    if (long) events.push({ kind: "missed_payment", loan: i, month: k + r.int(18, 30) });
  }
  return {
    scenario: {
      loans: n,
      months: long ? LONG_HISTORY_MONTHS : HISTORY_MONTHS,
      ...(events.length ? { events } : {}),
    },
    pins,
  };
}

/* ── a draw in progress ─────────────────────────────────────────────────── */

/** A call as the generator assembles it: the turns and the row, the dialer's facts, the note. */
interface Mat {
  readonly turns: readonly Turn[];
  readonly call: CallFacts;
  readonly pre_dial: PreDialFacts | null;
  readonly note: CallNote | null;
  readonly copiedOn: PlainDate | null;
  /** A bankruptcy the plant puts on the record in place of the contact center's. */
  readonly bankruptcy: BankruptcyCase | null | undefined;
}

/** Where a plant is: an item on a line (or on none), or a figure in the note. */
export type Root =
  { readonly item: RubricItem; readonly line: number | null } | { readonly note: string };

interface Planted {
  readonly mat: Mat;
  readonly root: Root;
  /** Findings the plant brings with it beyond its root. */
  readonly symptoms: readonly RubricItem[];
}

interface Ctx {
  readonly key: string;
  readonly r: Rng;
  readonly arm: number;
  readonly life: LoanLife;
  readonly loan: LoanContacts;
  readonly center: ContactCenter;
  readonly c: ContactRecord;
  readonly plan: CallPlan;
  readonly book: LifeBook;
}

interface EdgeSpec {
  readonly arms: number;
  readonly loan: (arm: number) => Loan;
  /** Loans in the book a draw looks through: more for a call few loans make. */
  readonly loans?: number;
  /** Whether a call can carry the edge, from its row and plan. */
  readonly fits: (
    c: ContactRecord,
    kind: CallKind,
    x: { loan: LoanContacts; plan: CallPlan; arm: number },
  ) => boolean;
  /** The clean call and, for a planted edge, the planted one; null when this call cannot take it. */
  readonly build: (x: Ctx) => { base: Mat; planted: Planted | null } | null;
}

const conversation = (k: CallKind) => k === "inbound" || k === "outbound";
const isBorrower = (c: ContactRecord) => c.party === "borrower" || c.party === "co_borrower";

/** The call as the contact center has it, with a human voice and the property's own zone or another it passes in. */
function baseMat(
  x: Ctx,
  over: { voice?: "human" | "ai"; servicemember?: boolean; areaZone?: string } = {},
): Mat {
  const { c, life, loan, center } = x;
  const turns = transcriptOf(center, x.book, c.id).turns;
  const n = noteOf(loan, loan.notes, c, over.voice === "ai" ? "AIVOICE" : undefined);
  const pre =
    c.direction === "outbound"
      ? preDialOf(
          life,
          loan,
          c,
          over.areaZone ?? cleanAreaZone(x),
          over.voice === "ai" ? "ai_voice" : "human_voice",
        )
      : null;
  return {
    turns,
    call: callFacts(c, loan, over),
    pre_dial: pre,
    note: n?.note ?? null,
    copiedOn: n?.copiedOn ?? null,
    bankruptcy: undefined,
  };
}

/** Mostly the property's zone; now and then a number from another zone the call's time passes in. */
function cleanAreaZone(x: Ctx): string {
  const zone = zoneOf(x.life.draw.property.state);
  const r = rngFor(`${x.key}/area`);
  if (!r.chance(0.15)) return zone;
  const instant = preDialOf(x.life, x.loan, x.c, zone, "human_voice").dial_at;
  const ok = AREA_ZONES.filter((z) => z !== zone && inVoiceWindow(localTime(instant, z).time));
  return ok.length ? r.pick(ok) : zone;
}

const at = (turns: readonly Turn[], tag: string, speaker = "AGENT") =>
  turns.findIndex((t) => t.tag === tag && t.speaker === speaker);

/** The AI voice in place of the person: its introduction, with or without the disclosure; null when the call cannot be one. */
function asAi(x: Ctx, mat: Mat, disclose: boolean): Turn[] | null {
  const i = at(mat.turns, "intro");
  if (i < 0) return null;
  // An AI voice never gives a person's name for its own.
  if (
    mat.turns.some((t, k) => k !== i && t.speaker === "AGENT" && t.said.includes(x.plan.agent.name))
  )
    return null;
  return replaceTurn(
    mat.turns,
    i,
    aiIntroduction(rngFor(`${x.key}/ai`), slotsOf(x.plan), disclose),
    "intro",
    `${x.key}/ai`,
    lowerEngine(mat.turns),
  );
}

/** AI-voice attempts on the number before this one: `within` inside 30 days, `older` from 31 to 45 days back. */
function aiAttempts(x: Ctx, within: number, older: number): string[] {
  const r = rngFor(`${x.key}/ai-attempts`);
  const zone = zoneOf(x.life.draw.property.state);
  const pool = Array.from({ length: 28 }, (_, k) => k + 2);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = r.int(0, i);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const inside = pool.slice(0, within);
  const outside = Array.from({ length: older }, () => r.int(31, 45));
  const days = [...inside, ...outside].sort((a, b) => b - a);
  return priorInstants(
    x.c.on,
    zone,
    days,
    days.map(() => r.int(9 * 60, 19 * 60)),
  );
}

/** The AI arms: a consenting mobile (arm 0) or a landline (arm 1). */
const aiFits = (c: ContactRecord, kind: CallKind, x: { loan: LoanContacts; arm: number }) => {
  if (kind !== "outbound") return false;
  const phone = x.loan.profile.phones.find((p) => p.id === c.phone_number_id);
  return x.arm === 0 ? phone?.kind === "mobile" : phone?.kind === "landline";
};

function aiMat(x: Ctx, disclose: boolean, landlineWithin: number): Mat | null {
  const base = baseMat(x, { voice: "ai" });
  const turns = asAi(x, base, disclose);
  if (!turns || !base.pre_dial) return null;
  const pre: PreDialFacts = {
    ...base.pre_dial,
    ai_voice_attempts_at: aiAttempts(
      x,
      base.pre_dial.line_type === "landline" ? landlineWithin : 1,
      1,
    ),
  };
  return { ...base, turns, pre_dial: pre };
}

/** The contact center's own defect on this call: its transcript, row and note, and where the label puts it. */
function contactDefect(x: Ctx, id: ContactDefectId): { mat: Mat; root: Root } | null {
  const res = plantContactDefects(x.center, x.book, [{ id, contacts: [x.c.id] }]);
  const roots = res.labels.filter((l) => l.root_cause);
  if (roots.length !== 1) return null;
  const label = roots[0]!;
  const loan = res.defective.loans.find((l) => l.loan_id === x.loan.loan_id)!;
  const row = loan.contacts.find((y) => y.id === x.c.id)!;
  const base = baseMat(x);
  const turns = transcriptOf(res.defective, x.book, x.c.id).turns;
  const n = noteOf(loan, loan.notes, row);
  const mat: Mat = {
    ...base,
    turns,
    call: callFacts(row, loan),
    note: n?.note ?? null,
    copiedOn: n?.copiedOn ?? null,
  };
  const line = label.turn === null ? null : label.turn + 1;
  const item: Record<ContactDefectId, RubricItem | null> = {
    "C-01": "identity",
    "C-02": "bankruptcy_collection",
    "C-03": "credit_misstatement",
    "C-04": "complaint_not_logged",
    "C-05": "wrong_amount",
    "C-06": "collection_disclosure",
    "C-07": "recording_disclosure",
    "C-08": null,
  };
  const it = item[id];
  if (it === null) return { mat, root: { note: label.planted_value ?? "" } };
  const removed = label.planted_value === null;
  return { mat, root: { item: it, line: removed ? null : line } };
}

const C_SYMPTOMS: Readonly<Record<ContactDefectId, readonly RubricItem[]>> = {
  "C-01": [],
  // The demand replaces the bankruptcy disclaimer, so the disclaimer is missing too.
  "C-02": ["collection_disclosure"],
  "C-03": [],
  "C-04": [],
  "C-05": [],
  "C-06": [],
  "C-07": [],
  "C-08": [],
};

function cEdge(id: ContactDefectId, loan: Loan, fits: EdgeSpec["fits"]): EdgeSpec {
  return {
    arms: 1,
    loan: () => loan,
    fits,
    build: (x) => {
      const d = contactDefect(x, id);
      if (!d) return null;
      return { base: baseMat(x), planted: { mat: d.mat, root: d.root, symptoms: C_SYMPTOMS[id] } };
    },
  };
}

/** A pre-dial plant: the call as it was, the dialer's facts changed. */
function preDialEdge(
  loan: (arm: number) => Loan,
  arms: number,
  fits: EdgeSpec["fits"],
  item: RubricItem,
  change: (
    x: Ctx,
    pre: PreDialFacts,
    base: Mat,
  ) => { pre: PreDialFacts; mat?: Partial<Mat> } | null,
  symptoms: readonly RubricItem[] = [],
): EdgeSpec {
  return {
    arms,
    loan,
    fits,
    build: (x) => {
      const base = baseMat(x);
      if (!base.pre_dial) return null;
      const ch = change(x, base.pre_dial, base);
      if (!ch) return null;
      return {
        base,
        planted: {
          mat: { ...base, ...ch.mat, pre_dial: ch.pre },
          root: { item, line: null },
          symptoms,
        },
      };
    },
  };
}

/** A turn inserted or replaced: the clean call, and the call with the line, rooted where it went. */
function lineEdge(
  loan: (arm: number) => Loan,
  arms: number,
  fits: EdgeSpec["fits"],
  item: RubricItem,
  write: (x: Ctx, base: Mat) => { turns: Turn[]; line: number } | null,
): EdgeSpec {
  return {
    arms,
    loan,
    fits,
    build: (x) => {
      const base = baseMat(x);
      const w = write(x, base);
      if (!w) return null;
      return {
        base,
        planted: { mat: { ...base, turns: w.turns }, root: { item, line: w.line }, symptoms: [] },
      };
    },
  };
}

const delinquent = () => "delinquent" as const;
const outboundConversation: EdgeSpec["fits"] = (c, k) =>
  k === "outbound" && c.purpose === "collection";
const anyConversation: EdgeSpec["fits"] = (_c, k) => conversation(k);

/** A synthetic bankruptcy case, noticed before the call: what Q-07's dialer ignored. */
function bankruptcyBefore(x: Ctx): BankruptcyCase {
  const r = rngFor(`${x.key}/bk`);
  const petition = addDays(x.c.on, -r.int(4, 25));
  return {
    chapter: r.chance(0.7) ? 13 : 7,
    petition_on: petition,
    noticed_on: addDays(petition, r.int(1, 3)),
    discharged_on: null,
    attorney: r.pick(["Dana Whitfield", "Marcus Oyelaran", "Ellen Brightwater", "Tomas Reyes"]),
    firm: r.pick(["Whitfield Legal Group", "Harbor Debt Relief Law", "Brightwater & Cole"]),
    case_last4: String(r.int(1000, 9999)),
  };
}

export const EDGES: Readonly<Record<CallQaEdge, EdgeSpec>> = {
  /* ── clean ── */
  clean_outbound: {
    arms: 1,
    loan: delinquent,
    fits: outboundConversation,
    build: (x) => ({ base: baseMat(x), planted: null }),
  },
  clean_inbound: {
    arms: 2,
    loan: (arm) => (arm === 0 ? "performing" : "delinquent"),
    fits: (c, k) => k === "inbound" && c.purpose === "borrower_inquiry",
    build: (x) => ({ base: baseMat(x), planted: null }),
  },
  clean_unverified: {
    arms: 3,
    loans: 3,
    loan: (arm) => (arm === 0 ? "spouse" : "delinquent"),
    fits: (_c, k, x) =>
      x.arm === 0
        ? k === "inbound_unverified"
        : x.arm === 1
          ? k === "outbound_unverified" || k === "wrong_number"
          : k === "refused",
    build: (x) => ({ base: baseMat(x), planted: null }),
  },
  clean_voicemail: {
    arms: 1,
    loan: delinquent,
    fits: (_c, k) => k === "voicemail",
    build: (x) => ({ base: baseMat(x), planted: null }),
  },
  clean_ai: {
    arms: 2,
    loans: 2,
    loan: delinquent,
    fits: aiFits,
    build: (x) => {
      const m = aiMat(x, true, rngFor(`${x.key}/n`).int(0, 2));
      if (!m?.pre_dial) return null;
      if (m.pre_dial.line_type === "mobile" && !m.pre_dial.tcpa_voice_consent_active) return null;
      return { base: m, planted: null };
    },
  },
  clean_military: {
    arms: 2,
    loan: delinquent,
    fits: (c, k, x) => (x.arm === 0 ? k === "outbound" : k === "inbound") && isBorrower(c),
    build: (x) => {
      const base = baseMat(x, { servicemember: true });
      if (base.turns.some((t) => t.tag === "scra_check")) return null;
      const i = at(base.turns, "verify_ok");
      if (i < 0) return null;
      const turns = insertTurn(
        base.turns,
        i + 1,
        "AGENT",
        militaryScript(rngFor(`${x.key}/mil`), slotsOf(x.plan)),
        "military",
        `${x.key}/mil`,
        lowerEngine(base.turns),
      );
      return { base: { ...base, turns }, planted: null };
    },
  },
  clean_bankruptcy: {
    arms: 1,
    loan: () => "bankruptcy",
    fits: (c, k) => conversation(k) && c.disclosures_marked.bankruptcy,
    build: (x) => ({ base: baseMat(x), planted: null }),
  },
  clean_dc: {
    arms: 2,
    loan: () => "debt_collector",
    fits: (c, k, x) =>
      x.loan.profile.debt_collector && (x.arm === 0 ? k === "outbound" : k === "inbound"),
    build: (x) => ({ base: baseMat(x), planted: null }),
  },

  /* ── the contact center's defects ── */
  "C-01": cEdge(
    "C-01",
    "delinquent",
    (_c, k) => k === "inbound_unverified" || k === "outbound_unverified" || k === "wrong_number",
  ),
  "C-02": cEdge("C-02", "bankruptcy", (c, k) => conversation(k) && c.disclosures_marked.bankruptcy),
  "C-03": cEdge(
    "C-03",
    "delinquent",
    (_c, k, x) => conversation(k) && x.plan.needs.credit_question,
  ),
  "C-04": { ...cEdge("C-04", "long", (c, k) => conversation(k) && c.complaint_voiced), loans: 4 },
  "C-05": cEdge("C-05", "delinquent", anyConversation),
  "C-06": cEdge("C-06", "delinquent", (c, k) => conversation(k) && c.disclosures_marked.fdcpa),
  "C-07": cEdge("C-07", "delinquent", (_c, k) => k === "outbound"),
  "C-08": cEdge("C-08", "delinquent", (c, k) => k !== "voicemail" && c.human_agent !== null),

  /* ── ours ── */
  "Q-01": {
    arms: 2,
    loans: 2,
    loan: delinquent,
    fits: aiFits,
    build: (x) => {
      const base = aiMat(x, true, 1);
      const bad = aiMat(x, false, 1);
      if (
        !base ||
        !bad ||
        (base.pre_dial?.line_type === "mobile" && !base.pre_dial.tcpa_voice_consent_active)
      )
        return null;
      return {
        base,
        planted: { mat: bad, root: { item: "ai_disclosure", line: null }, symptoms: [] },
      };
    },
  },
  "Q-02": {
    arms: 1,
    loan: delinquent,
    fits: (c, k, x) => aiFits(c, k, { loan: x.loan, arm: 0 }),
    build: (x) => {
      const base = aiMat(x, true, 0);
      if (!base?.pre_dial || !base.pre_dial.tcpa_voice_consent_active) return null;
      return {
        base,
        planted: {
          mat: { ...base, pre_dial: { ...base.pre_dial, tcpa_voice_consent_active: false } },
          root: { item: "predial_consent", line: null },
          symptoms: [],
        },
      };
    },
  },
  "Q-03": {
    arms: 1,
    loans: 2,
    loan: delinquent,
    fits: (c, k, x) => aiFits(c, k, { loan: x.loan, arm: 1 }),
    build: (x) => {
      const base = aiMat(x, true, 2);
      const bad = aiMat(x, true, 3);
      if (!base || !bad) return null;
      return {
        base,
        planted: { mat: bad, root: { item: "predial_line_type", line: null }, symptoms: [] },
      };
    },
  },
  "Q-04": {
    loans: 2,
    ...preDialEdge(
      delinquent,
      2,
      (c) => c.direction === "outbound" && c.mode === "call",
      "predial_time_zone",
      (x, pre) => {
        const zone = zoneOf(x.life.draw.property.state);
        if (!inVoiceWindow(localTime(pre.dial_at, zone).time)) return null;
        // Early: a zone where the call landed at or before 08:00; late: one where it landed after 20:30.
        const bad = AREA_ZONES.filter((z) => {
          const t = localTime(pre.dial_at, z).time;
          return x.arm === 0 ? t <= "08:00" && t >= "04:00" : t > "20:30";
        });
        if (!bad.length) return null;
        const z = x.r.pick(bad);
        return { pre: { ...pre, time_zones: [zone, z] } };
      },
    ),
  },
  "Q-05": preDialEdge(
    (arm) => (arm === 0 ? "debt_collector" : "delinquent"),
    2,
    (c, _k, x) =>
      c.direction === "outbound" &&
      c.mode === "call" &&
      (x.arm === 0 ? x.loan.profile.debt_collector : !x.loan.profile.debt_collector),
    "predial_regf_count",
    (x, pre) => {
      if (pre.state === "MA") return null;
      const cap = x.arm === 0 ? 7 : 5;
      const zone = zoneOf(pre.state);
      const real = pre.counted_call_attempts_at.filter(
        (t) => Date.parse(pre.dial_at) - Date.parse(t) < 7 * 86_400_000,
      ).length;
      const need = cap - real;
      if (need <= 0) return null;
      const r = rngFor(`${x.key}/cap`);
      const days = Array.from({ length: need }, (_, k) => 1 + (k % 6));
      const extra = priorInstants(
        x.c.on,
        zone,
        days,
        days.map(() => r.int(9 * 60, 19 * 60)),
      );
      const all = [...pre.counted_call_attempts_at, ...extra].sort();
      return { pre: { ...pre, counted_call_attempts_at: all } };
    },
  ),
  "Q-06": preDialEdge(
    (arm) => (arm === 0 ? "delinquent" : "debt_collector"),
    2,
    (c, _k, x) =>
      c.direction === "outbound" &&
      c.mode === "call" &&
      (x.arm === 0 || x.loan.profile.debt_collector),
    "predial_cease",
    (x, pre) => ({
      pre: x.arm === 0 ? { ...pre, cease_active: true } : { ...pre, written_cease: true },
    }),
  ),
  "Q-07": preDialEdge(
    delinquent,
    1,
    outboundConversation,
    "predial_bankruptcy",
    (x, pre) => ({ pre: { ...pre, bk_active: true }, mat: { bankruptcy: bankruptcyBefore(x) } }),
    // The dialer ignored the case, and so did the call: the mini-Miranda, not the disclaimer, and a demand.
    ["collection_disclosure", "bankruptcy_collection"],
  ),
  "Q-08": preDialEdge(
    delinquent,
    2,
    (_c, k, x) => (x.arm === 0 ? k === "outbound" : k === "voicemail"),
    "predial_attorney",
    (_x, pre) => ({ pre: { ...pre, attorney_represented: true } }),
  ),
  "Q-09": {
    arms: 2,
    loan: delinquent,
    fits: (c, k, x) => (x.arm === 0 ? k === "outbound" : k === "inbound") && isBorrower(c),
    build: (x) => {
      const base = EDGES.clean_military.build(x);
      if (!base) return null;
      const bad = baseMat(x, { servicemember: true });
      if (bad.turns.some((t) => t.tag === "scra_check")) return null;
      return {
        base: base.base,
        planted: { mat: bad, root: { item: "military", line: null }, symptoms: [] },
      };
    },
  },
  "Q-10": lineEdge(delinquent, 1, outboundConversation, "threat", (x, base) => {
    const i = at(base.turns, "empathy");
    if (i < 0) return null;
    const turns = insertTurn(
      base.turns,
      i + 1,
      "AGENT",
      threatLine(rngFor(`${x.key}/threat`), slotsOf(x.plan)),
      "threat",
      `${x.key}/threat`,
      lowerEngine(base.turns),
    );
    return { turns, line: i + 2 };
  }),
  "Q-11": lineEdge(delinquent, 1, anyConversation, "negotiation", (x, base) => {
    const i = at(base.turns, "lossmit");
    if (i < 0) return null;
    const turns = replaceTurn(
      base.turns,
      i,
      negotiationLine(rngFor(`${x.key}/neg`), slotsOf(x.plan)),
      "negotiation",
      `${x.key}/neg`,
      lowerEngine(base.turns),
    );
    return { turns, line: i + 1 };
  }),
  "Q-12": {
    arms: 1,
    loan: delinquent,
    fits: (_c, k) => k === "voicemail",
    build: (x) => {
      const base = baseMat(x);
      const i = base.turns.findIndex((t) => t.speaker === "AGENT");
      if (!base.pre_dial || base.pre_dial.voicemails_to_number_7d !== 0 || i < 0) return null;
      return {
        base,
        planted: {
          mat: { ...base, pre_dial: { ...base.pre_dial, voicemails_to_number_7d: 1 } },
          root: { item: "voicemail", line: i + 1 },
          symptoms: [],
        },
      };
    },
  },
  "Q-13": lineEdge(delinquent, 2, anyConversation, "verbatim", (x, base) => {
    const i = at(base.turns, "empathy");
    if (i < 0) return null;
    const slots = slotsOf(x.plan);
    const usable = CALL_TEMPLATES.filter(
      (t) => !t.text.includes("{{date}}") || slots["oldest_due"] || slots["next_due"],
    );
    const t = usable[(x.arm + x.r.int(0, usable.length - 1)) % usable.length]!;
    const turns = replaceTurn(
      base.turns,
      i,
      templateLine(t, slots),
      "verbatim",
      `${x.key}/verbatim`,
      lowerEngine(base.turns),
    );
    return { turns, line: i + 1 };
  }),
  "Q-14": lineEdge(delinquent, 1, anyConversation, "provenance", (x, base) => {
    const idx = base.turns.map((t, k) => (t.speaker === "AGENT" ? k : -1)).filter((k) => k >= 0);
    const last = idx[idx.length - 1];
    if (last === undefined) return null;
    const { record } = recordsFor(x.life, x.loan, x.c.on, null, null);
    const sources = new Set<string>(figureRuns(record));
    for (const t of base.turns)
      if (t.speaker === "CALLER") for (const d of digitRuns(t.said)) sources.add(d);
    const r = rngFor(`${x.key}/invented`);
    const free = Array.from({ length: 49 }, (_, k) => k + 11).filter(
      (n) => !sources.has(String(n)),
    );
    if (!free.length) return null;
    const turns = insertTurn(
      base.turns,
      last,
      "AGENT",
      inventedLine(r, r.pick(free)),
      "invented",
      `${x.key}/invented`,
      lowerEngine(base.turns),
    );
    return { turns, line: last + 1 };
  }),
};

/* ── fair to grade ──────────────────────────────────────────────────────── */

const findingKeys = (r: CallReview) => r.findings.map((f) => `${f.item}@${f.line ?? "-"}`);
const noteKey = (r: CallReview) =>
  r.note === null ? "none" : `${r.note.matches}:${[...r.note.contradictions].sort().join("|")}`;
const sameReview = (a: CallReview, b: CallReview) =>
  JSON.stringify(findingKeys(a)) === JSON.stringify(findingKeys(b)) &&
  a.fails_outright === b.fails_outright &&
  noteKey(a) === noteKey(b) &&
  JSON.stringify(a.options_told) === JSON.stringify(b.options_told);

/** The two readings of a call: what was said, and what the recorder wrote. */
function readings(
  x: Ctx,
  m: Mat,
): {
  said: CallReview;
  heard: CallReview;
  task: Omit<CallQaTask, "id" | "split" | "suite_seed" | "index" | "source" | "planted">;
} {
  const bk = m.bankruptcy === undefined ? x.loan.bankruptcy : m.bankruptcy;
  const { record, copied } = recordsFor(x.life, x.loan, x.c.on, m.copiedOn, bk);
  const lines = transcriptLines(m.turns);
  const said = reviewCall(
    underReview(m.call, saidLines(m.turns), record, m.pre_dial, m.note, copied),
  );
  const heard = reviewCall(
    underReview(m.call, heardLines(lines), record, m.pre_dial, m.note, copied),
  );
  return {
    said,
    heard,
    task: {
      call: m.call,
      transcript: lines,
      record,
      pre_dial: m.pre_dial,
      note: m.note,
      copied_record: copied,
    },
  };
}

const rootFound = (root: Root, r: CallReview): boolean =>
  "note" in root
    ? r.note !== null &&
      !r.note.matches &&
      r.note.contradictions.some(
        (t) =>
          t === root.note || (/CURRENT|PAST DUE/.test(root.note) && /^(CURRENT|PAST DUE)$/.test(t)),
      )
    : r.findings.some((f) => f.item === root.item && f.line === root.line);

/**
 * Why a draw is not fair to grade, or [] when it is: the clean call draws a
 * finding or a note that does not match; the planted call misses its root
 * or draws a finding the plant does not bring; or the recorder's text and
 * labels read differently from what was said.
 */
export function judge(
  clean: { said: CallReview; heard: CallReview },
  planted: {
    said: CallReview;
    heard: CallReview;
    root: Root;
    symptoms: readonly RubricItem[];
  } | null,
): string[] {
  const out: string[] = [];
  if (clean.said.findings.length)
    out.push(`the clean call draws ${findingKeys(clean.said).join(", ")}`);
  if (clean.said.note && !clean.said.note.matches)
    out.push(`the clean note contradicts the record: ${clean.said.note.contradictions.join(", ")}`);
  if (!planted) {
    if (!sameReview(clean.said, clean.heard))
      out.push("the recorder's text reads differently from what was said");
    return out;
  }
  if (!rootFound(planted.root, planted.said))
    out.push(
      `the plant (${JSON.stringify(planted.root)}) is not found in ${findingKeys(planted.said).join(", ") || "nothing"}`,
    );
  const rootItem = "item" in planted.root ? planted.root.item : null;
  for (const f of planted.said.findings)
    if (f.item !== rootItem && !planted.symptoms.includes(f.item))
      out.push(`the plant brings ${f.item}@${f.line ?? "-"}, which it does not name`);
  if (!("note" in planted.root) && planted.said.note && !planted.said.note.matches)
    out.push("the planted call's note contradicts the record");
  if (!sameReview(planted.said, planted.heard))
    out.push("the recorder's text reads differently from what was said");
  return out;
}

/* ── the draw ───────────────────────────────────────────────────────────── */

/** How many calls of one book a draw tries before it draws another book. */
const CALLS_PER_LOAN = 6;

/**
 * One candidate: a loan from the key, the calls on it that fit, and the edge
 * built on each in a seeded order until one is fair to grade. It returns
 * that one with no issues, or the last one built with its issues, or null
 * when no call on the loan could take the edge.
 */
export function drawCallQaCandidate(
  key: string,
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): { task: CallQaTask; issues: string[] } | null {
  const edge = callQaEdgeOf(index);
  const spec = EDGES[edge];
  const arm = callQaArmOf(index, spec.arms);
  const r = rngFor(key);
  const { scenario, pins } = scenarioFor(r, spec.loan(arm), spec.loans ?? 1);
  const { book, center } = rebuild(key, scenario, pins);
  const candidates = center.loans.flatMap((loan, k) =>
    callsOf(loan)
      .filter((c) => {
        const kind = kindOf(c);
        if (!kind || c.language !== "en" || c.interpreter || c.purpose === "welcome") return false;
        const plan = callPlan(center, book, c.id);
        return plan.recording === "stereo" && spec.fits(c, kind, { loan, plan, arm });
      })
      .map((c) => ({ c, k })),
  );
  const order = [...candidates];
  for (let i = order.length - 1; i > 0; i--) {
    const j = r.int(0, i);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  let last: { task: CallQaTask; issues: string[] } | null = null;
  for (const { c, k } of order.slice(0, CALLS_PER_LOAN)) {
    const x: Ctx = {
      key: `${key}/${c.id}`,
      r: rngFor(`${key}/${c.id}/edge`),
      arm,
      life: book.loans[k]!,
      loan: center.loans[k]!,
      center,
      c,
      plan: callPlan(center, book, c.id),
      book,
    };
    const built = spec.build(x);
    if (!built) continue;
    const clean = readings(x, built.base);
    const planted = built.planted
      ? {
          ...readings(x, built.planted.mat),
          root: built.planted.root,
          symptoms: built.planted.symptoms,
        }
      : null;
    const issues = judge(clean, planted);
    const chosen = planted ?? clean;
    const task: CallQaTask = {
      id: callQaTaskId(split, suiteSeed, index),
      split,
      suite_seed: suiteSeed,
      index,
      ...chosen.task,
      source: {
        kind: "book",
        seed: key,
        scenario,
        pins,
        loan: k,
        bankruptcy: built.planted?.mat.bankruptcy ?? null,
      },
      planted: built.planted ? { defect: edge, arm } : null,
    };
    last = { task, issues };
    if (issues.length === 0) return last;
  }
  return last;
}

/** Draws from the task's own stream, and again from `${id}#n`, until a draw is fair to grade. */
export const MAX_ATTEMPTS = 60;

export function drawCallQaTask(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): { task: CallQaTask; attempts: number } {
  const id = callQaTaskId(split, suiteSeed, index);
  for (let a = 0; a < MAX_ATTEMPTS; a++) {
    const got = drawCallQaCandidate(a === 0 ? id : `${id}#${a}`, split, suiteSeed, index);
    if (got && got.issues.length === 0) return { task: got.task, attempts: a + 1 };
  }
  throw new Error(`${id}: no fair ${callQaEdgeOf(index)} call in ${MAX_ATTEMPTS} draws`);
}

export const generateCallQaTask = (
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): CallQaTask => drawCallQaTask(split, suiteSeed, index).task;

export function generateCallQaSuite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): CallQaTask[] {
  return Array.from({ length: n }, (_, i) => generateCallQaTask(split, suiteSeed, i));
}

export const CALL_QA_HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 210 };

/**
 * A contact-center call as the rubric reads it, said and heard, with a human
 * voice and the property's own zone: what the tests hold the contact
 * center's clean calls and its planted defects to, outside any draw.
 */
export function reviewContactCall(
  center: ContactCenter,
  book: LifeBook,
  contactId: string,
): { said: CallReview; heard: CallReview } {
  const k = center.loans.findIndex((l) => l.contacts.some((c) => c.id === contactId));
  if (k < 0) throw new RangeError(`no contact ${contactId} in this center`);
  const loan = center.loans[k]!;
  const c = loan.contacts.find((x) => x.id === contactId)!;
  const x: Ctx = {
    key: `review/${contactId}`,
    r: rngFor(`review/${contactId}`),
    arm: 0,
    life: book.loans[k]!,
    loan,
    center,
    c,
    plan: callPlan(center, book, contactId),
    book,
  };
  const r = readings(x, baseMat(x, { areaZone: zoneOf(x.life.draw.property.state) }));
  return { said: r.said, heard: r.heard };
}
