/**
 * The join between the nineteen states and the four screens.
 *
 * The resolver is the piece the product did not have, and the reason it is
 * worth testing on its own is that almost every failure it prevents is a
 * failure of AGREEMENT rather than of rendering: a control promising reasons
 * that the destination will not print, a lead claiming a decision the machine
 * never applied, a Loan Estimate date under a decline. None of those look
 * wrong in the card that shows them. They only look wrong beside the screen
 * they lead to, which is why the tests below ask `endingFor` the same question
 * the review screen asks it, rather than asserting strings.
 *
 * Three things the suite is built around:
 *
 * 1. **Totality.** Every state in the machine resolves, and lands in exactly
 *    one of the three groups. `adverse_action_pending` is the one a ranking
 *    written from `TERMINAL` drops on the floor, and it is the one this page
 *    most has to get right.
 *
 * 2. **The invariants are asked of every state at once**, not of the states
 *    somebody remembered. A rule with an exception is written as a list of the
 *    exceptions, so a twentieth state joining one is a failing test rather
 *    than a discovery.
 *
 * 3. **Nothing here retypes a string the copy module owns.** Where a body is
 *    asserted it is asserted against the constant, because a test holding its
 *    own copy of a sentence is the drift the copy module exists to end.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { APPLICATION_STATES, TERMINAL, type ApplicationState } from "@hm/shared";
import {
  DESTINATIONS,
  ESTIMATE_AHEAD,
  NEW_APPLICATION,
  canStart,
  modeForRow,
  rankFiles,
  readOnly,
  screenFor,
  standingFor,
  type HomeContext,
  type Standing,
} from "../home.js";
import type { FileRow, LoanFileResponse } from "../file.js";
import { applied, endingFor } from "../endings.js";
import { entryFor } from "../states.js";
import {
  ADVERSE_WITHOUT_DATE,
  APPROVED_BODY,
  ESTIMATE_PENDING_BODY,
  FUNDED_BODY,
  FUNDED_WITHOUT_HISTORY,
  NOTHING_WAITING,
  OPEN_THIS_FILE,
  READ_AND_SIGN,
  READ_THE_REASONS,
  READ_YOUR_ESTIMATE,
  SEE_EVERYTHING,
  SEE_WHERE_THIS_STANDS,
  UNKNOWN_STANDING_LEAD,
  UNSIGNED_BODY,
} from "../home-copy.js";
import { ADVERSE_COPY, COUNTEROFFER_COPY, REFERRED_COPY, SIGN_LEAD } from "../outcomes.js";
import { PERSONA_READ_ONLY } from "../auth.js";

const STATES = APPLICATION_STATES as readonly ApplicationState[];

const NOW = "2026-09-11T16:00:00.000Z";

function row(over: Partial<FileRow> = {}): FileRow {
  return {
    id: "f1",
    stage: "bank",
    isDemo: false,
    mine: true,
    createdAt: "2026-09-07T15:14:00.000Z",
    purpose: "PURCHASE",
    loanAmount: null,
    valueOrPrice: null,
    propertyCity: "Austin",
    propertyState: "TX",
    borrowers: [{ firstName: "Maya", lastName: "Okafor" }],
    decisions: [],
    applicationState: null,
    signed: false,
    owes: null,
    ...over,
  };
}

/** A row sitting in one state, with the terminal flag the machine gives it. */
function at(status: string, over: Partial<FileRow> = {}): FileRow {
  return row({
    applicationState: {
      status,
      statusEnteredAt: "2026-09-09T12:00:00.000Z",
      terminal: TERMINAL.includes(status as ApplicationState),
    },
    ...over,
  });
}

/**
 * The single-file read, which only the primary card makes.
 *
 * Four fields wide, because four is what the resolver reads off it: the intent
 * latch, the decision's ratios, the ledger and the clocks. The rest of a very
 * wide wire shape is cast away rather than written out, which keeps a test
 * about a resolver from becoming a second declaration of the response.
 */
function read(
  over: {
    intentToProceedAt?: string | null;
    ratios?: { housingPitia: number | null; dtiBack: number | null } | null;
    ledger?: readonly { event: string; reasonCode: string | null; to: string }[];
    clocks?: readonly { kind: string }[];
    loanEstimate?: { dueAt: string } | null;
    status?: string;
  } = {},
): LoanFileResponse {
  return {
    file: {
      intentToProceedAt: over.intentToProceedAt ?? null,
      decision: over.ratios ? { outcome: "clear_to_close", ratios: over.ratios } : null,
    },
    applicationState: {
      status: over.status ?? "in_underwriting",
      statusEnteredAt: "2026-09-09T12:00:00.000Z",
      terminal: false,
      ledger: over.ledger ?? [],
      clocks: over.clocks ?? [],
      loanEstimate: over.loanEstimate
        ? { dueAt: over.loanEstimate.dueAt, tolled: true, tollingReason: "no_delivery_channel" }
        : null,
      scenario: null,
    },
  } as unknown as LoanFileResponse;
}

const ctx = (over: Partial<HomeContext> & { row: FileRow }): HomeContext => ({
  file: undefined,
  user: null,
  ...over,
});

const standing = (over: Partial<HomeContext> & { row: FileRow }): Standing =>
  standingFor(ctx(over));

/**
 * One resolved card, under a name a failing invariant can be read off.
 *
 * The state and the name are two fields because the rules below are of two
 * kinds: some are about a state and some are about a state in a particular
 * condition — signed, read, read and come back empty — and a single string
 * cannot be compared against `APPLICATION_STATES` and still say which of the
 * four `approved` cards broke a rule.
 */
interface Case {
  status: string;
  label: string;
  card: Standing;
}

/** Every state, resolved with nothing read and no decision recorded. */
const EVERY_STATE: Case[] = STATES.map((status) => ({
  status,
  label: status,
  card: standing({ row: at(status) }),
}));

/** A ledger with a row on it, because an empty one is not a record. */
const LEDGER = [{ event: "application_started", reasonCode: null, to: "intake_received" }];

/**
 * Every state again, with the single-file read landed.
 *
 * Asking the invariants of the unread cards alone asks them of half the page.
 * The history block, both clocks and three of the four `approved` cards only
 * exist once `GET /files/:id` answers, so a matrix built entirely from
 * `file: undefined` cannot see a card that goes silent the moment it does —
 * which is exactly what the intent latch does, and it is the one card where
 * silence sits over the only intent control in the product.
 */
const EVERY_READ_CARD: Case[] = STATES.map((status) => ({
  status,
  label: `${status}, read`,
  card: standing({ row: at(status), file: read({ status, ledger: LEDGER }) }),
}));

const INTENT_RECORDED = "2026-09-10T12:00:00.000Z";
const RATIOS = { housingPitia: 2400, dtiBack: 0.38 };

/**
 * Both matrices, plus the states that are more than one situation.
 *
 * `in_underwriting` unsigned is the borrower's move and signed is ours, and
 * the invariants have to hold of both — asking them of the unsigned card alone
 * would leave the most common file in the product unchecked. `approved` is
 * five: unsigned, which is the signature card and is in the read matrix
 * already, then the four a signature makes possible — waiting on its read,
 * that read come back empty, the intent already recorded, and the estimate
 * ready to read.
 */
const EVERY_CARD: Case[] = [
  ...EVERY_STATE,
  ...EVERY_READ_CARD,
  {
    status: "in_underwriting",
    label: "in_underwriting, signed",
    card: standing({ row: at("in_underwriting", { signed: true }) }),
  },
  {
    status: "in_underwriting",
    label: "in_underwriting, signed and read",
    card: standing({
      row: at("in_underwriting", { signed: true }),
      file: read({ ledger: LEDGER }),
    }),
  },
  {
    status: "approved",
    label: "approved, read still out",
    card: standing({ row: at("approved", { signed: true }), file: undefined }),
  },
  {
    status: "approved",
    label: "approved, read came back empty",
    card: standing({ row: at("approved", { signed: true }), file: null }),
  },
  {
    status: "approved",
    label: "approved, signed and read",
    card: standing({
      row: at("approved", { signed: true }),
      file: read({ status: "approved", ledger: LEDGER }),
    }),
  },
  {
    status: "approved",
    label: "approved, intent recorded",
    card: standing({
      row: at("approved", { signed: true }),
      file: read({ status: "approved", ledger: LEDGER, intentToProceedAt: INTENT_RECORDED }),
    }),
  },
  {
    status: "approved",
    label: "approved, estimate ready",
    card: standing({
      row: at("approved", {
        signed: true,
        decisions: [{ outcome: "clear_to_close", ausRecommendation: "Approve" }],
      }),
      file: read({ status: "approved", ledger: LEDGER, ratios: RATIOS }),
    }),
  },
];

afterEach(() => {
  vi.useRealTimers();
});

describe("every state the machine has", () => {
  it("has words in the catalog for the resolver to read", () => {
    // Sixteen of the nineteen leads come straight off the catalog, and the
    // fallback below is a defense rather than a shrug: a state that reached it
    // would render "Your application" as its heading and nobody would know why.
    for (const status of STATES) {
      expect(entryFor(status)?.heading, status).toBeTruthy();
    }
    expect(entryFor("a_state_nobody_wrote")?.heading).toBeUndefined();
  });

  it("resolves to something a card can render", () => {
    for (const { status, card } of EVERY_STATE) {
      expect(card.lead.length, status).toBeGreaterThan(0);
      expect(card.body.length, status).toBeGreaterThan(0);
    }
  });

  it("resolves for a file with no application at all", () => {
    const card = standing({ row: row({ applicationState: null }) });
    expect(card.lead.length).toBeGreaterThan(0);
    expect(card.body.length).toBeGreaterThan(0);
    expect(card.mode).toBe("us");
  });

  it("lands in exactly one of the three groups", () => {
    const groups = { you: 0, us: 0, ended: 0 };
    for (const status of STATES) groups[modeForRow(at(status))] += 1;
    expect(groups.you + groups.us + groups.ended).toBe(STATES.length);
    expect(groups.you).toBeGreaterThan(0);
    expect(groups.us).toBeGreaterThan(0);
    expect(groups.ended).toBeGreaterThan(0);
  });

  it("counts a decline awaiting its notice as an ending, though it is not terminal", () => {
    // The state a ranking written from `TERMINAL` alone drops on the floor:
    // the machine keeps it live until the notice goes out, and to the person
    // it happened to it is over.
    expect(TERMINAL).not.toContain("adverse_action_pending");
    expect(modeForRow(at("adverse_action_pending"))).toBe("ended");
    expect(standing({ row: at("adverse_action_pending") }).mode).toBe("ended");
  });

  it("counts a screening hold as a wait rather than as an ending", () => {
    // A hold is not a decision. Grouping it with the endings would paint five
    // terminal states and one live one the same, and tell somebody whose file
    // can still move that it cannot.
    expect(modeForRow(at("suspended"))).toBe("us");
    expect(standing({ row: at("suspended") }).mode).toBe("us");
  });

  it("ranks a status it has never heard of rather than dropping it", () => {
    const unknown = at("some_state_added_later");
    expect(modeForRow(unknown)).toBe("us");
    expect(standing({ row: unknown }).lead).toBe(UNKNOWN_STANDING_LEAD);
    expect(standing({ row: unknown }).body.length).toBeGreaterThan(0);
  });
});

describe("the card and the screen it leads to never claim different things", () => {
  /** Status x outcome x signed, which is every input the two can disagree on. */
  const MATRIX = STATES.flatMap((status) =>
    ([null, "denied", "counteroffer", "referred", "clear_to_close"] as const).flatMap((outcome) =>
      [false, true].map((signed) => {
        const listed = at(status, {
          signed,
          decisions: outcome ? [{ outcome, ausRecommendation: "Refer" }] : [],
        });
        return {
          status,
          outcome,
          signed,
          row: listed,
          card: standing({
            row: listed,
            file: read({ ratios: { housingPitia: 2400, dtiBack: 0.38 } }),
          }),
          ending: endingFor({
            signed,
            outcome,
            state: at(status).applicationState,
            ratios: { housingPitia: 2400, dtiBack: 0.38 },
            branches: [],
          }),
        };
      }),
    ),
  );

  it("is asking this of a matrix somebody would notice emptying", () => {
    expect(MATRIX.length).toBe(STATES.length * 5 * 2);
    expect(MATRIX.some((m) => m.card.control?.label === READ_THE_REASONS)).toBe(true);
    expect(MATRIX.some((m) => m.card.control?.label === READ_YOUR_ESTIMATE)).toBe(true);
  });

  it("promises the reasons only where the reasons render", () => {
    // The red control landing on "We're reviewing this ourselves", which is
    // the contradiction this page exists to end arriving across two surfaces
    // instead of across one screen. It is reachable: neither declined state
    // stops the shell opening a branch page, where a decision is posted
    // unconditionally and lands `referred` over the decline.
    for (const { status, card, ending } of MATRIX) {
      if (card.control?.label === READ_THE_REASONS) expect(ending, status).toBe("adverse");
    }
  });

  it("promises the Loan Estimate only where the estimate renders", () => {
    for (const { status, card, ending } of MATRIX) {
      if (card.control?.label === READ_YOUR_ESTIMATE) expect(ending, status).toBe("estimate");
    }
  });

  it("falls back to the destination's own name when the two come apart", () => {
    const declined = at("adverse_action_pending", {
      decisions: [{ outcome: "referred", ausRecommendation: "Refer" }],
    });
    const card = standing({ row: declined });
    expect(card.control?.label).toBe(SEE_WHERE_THIS_STANDS);
    expect(card.lead).toBe(ADVERSE_COPY.headline);
  });

  it("keeps the counteroffer's words and drops its label when they come apart", () => {
    // A branch page posting a decision does not un-counteroffer an application
    // the machine actually moved, so the state keeps its words. What it loses
    // is a control promising a decision the review screen will not render.
    const both = (outcome: "counteroffer" | "referred") =>
      standing({
        row: at("counteroffer_outstanding", {
          decisions: [{ outcome, ausRecommendation: "Refer" }],
        }),
      });
    expect(both("counteroffer").lead).toBe(COUNTEROFFER_COPY.headline);
    expect(both("referred").lead).toBe(COUNTEROFFER_COPY.headline);
    expect(both("counteroffer").control?.weight).toBe("primary");
    expect(both("referred").control?.label).toBe(SEE_WHERE_THIS_STANDS);
  });

  it("names a decided word only where the machine took it", () => {
    // `applied` is the one implementation of "was this word actually taken",
    // and the two leads that name a decision are the two it guards.
    for (const { status, card } of MATRIX) {
      if (card.lead === COUNTEROFFER_COPY.headline) {
        expect(applied("counteroffer", at(status).applicationState), status).toBe(true);
      }
      if (card.lead === ADVERSE_COPY.headline) {
        expect(applied("denied", at(status).applicationState), status).toBe(true);
      }
    }
  });

  /**
   * The states where nobody has been asked for a signature yet.
   *
   * `endingFor` answers null for any unsigned file it has not already decided,
   * and null is what makes the review screen render the panel asking for one.
   * On these four the borrower is still walking the screens that come before
   * it, so a card with nothing to press is saying something true. Past them
   * the same silence sits over a screen that is still asking — which is how an
   * approved file nobody had signed came to read that nothing was waiting on
   * them, over the only route to the signature it was waiting for. The list is
   * written out so a twentieth state joining it fails here.
   */
  const BEFORE_THE_SIGNATURE = ["draft", "intake_received", "in_processing", "awaiting_borrower"];

  it("never goes quiet over a screen still asking for the signature", () => {
    const quiet = MATRIX.filter(
      ({ status, card, ending }) =>
        ending === null &&
        !BEFORE_THE_SIGNATURE.includes(status) &&
        !card.pending &&
        card.control === null,
    ).map(({ status, outcome }) => `${status} / ${outcome}`);
    expect(quiet).toEqual([]);
  });

  it("puts a file in the list where its own card says it stands", () => {
    // The row carries `signed` and does not carry `intentToProceedAt`, so the
    // one split the two may legitimately disagree about is the one that latch
    // decides. Any other disagreement is a file whose place in the list and
    // whose card describe two different situations to one person on one page.
    for (const { status, signed, row: listed, card } of MATRIX) {
      if (status === "approved" && signed) continue;
      expect(card.mode, `${status}, signed=${signed}`).toBe(modeForRow(listed));
    }
  });

  it("sends every control somewhere the router actually has", () => {
    const allowed = new Set([NEW_APPLICATION, ...DESTINATIONS.map((d) => `/f/f1/${d}`)]);
    for (const { status, card } of MATRIX) {
      if (card.control)
        expect(allowed.has(card.control.to), `${status}: ${card.control.to}`).toBe(true);
      if (card.quiet) expect(allowed.has(card.quiet.to), `${status}: ${card.quiet.to}`).toBe(true);
    }
    expect(allowed.has("/f/f1/closing")).toBe(false);
  });
});

describe("the invariants that make mode and control two axes", () => {
  it("is asking this of the cards a read has landed on as well", () => {
    // The invariants below were asked of `file: undefined` only, and a card
    // that keeps every rule until its read answers keeps none of them where it
    // matters. This pins the matrix to both halves.
    expect(EVERY_CARD.filter(({ card }) => card.showHistory).length).toBeGreaterThan(0);
    expect(EVERY_CARD.filter(({ card }) => card.mode === "you").length).toBeGreaterThan(0);
    expect(EVERY_CARD.filter(({ label }) => label.endsWith(", read")).length).toBe(STATES.length);

    // And the four `approved` cards a read decides are four different cards,
    // or the rows above them would be one card written out four times.
    const card = (label: string) => EVERY_CARD.find((c) => c.label === label)!.card;
    expect(card("approved, estimate ready").control?.label).toBe(READ_YOUR_ESTIMATE);
    expect(card("approved, signed and read").noControl).toBe(NOTHING_WAITING);
    expect(card("approved, intent recorded").pending).toBe(false);
    expect(card("approved, intent recorded").noControl).toBeNull();
    expect(card("approved, read still out").pending).toBe(true);
    expect(card("approved, read came back empty").pending).toBe(false);
  });

  it("never dresses an ending as a task", () => {
    for (const { label, card } of EVERY_CARD) {
      if (card.mode === "ended") expect(card.control?.weight ?? "outline", label).toBe("outline");
    }
  });

  it("always gives your move something to press", () => {
    for (const { label, card } of EVERY_CARD) {
      if (card.mode === "you") {
        expect(card.pending, label).toBe(false);
        expect(card.control, label).not.toBeNull();
      }
    }
  });

  it("leaves the action area empty only while a read decides it", () => {
    // Guessing flashes a primary control that vanishes, or prints "nothing is
    // waiting on you" over the only intent control in the product. An empty
    // action area is acceptable for the length of one fetch and is not
    // acceptable as a resting state.
    const waiting = standing({ row: at("approved", { signed: true }), file: undefined });
    expect(waiting.pending).toBe(true);
    expect(waiting.control).toBeNull();
    expect(waiting.noControl).toBeNull();

    const settled = standing({ row: at("approved", { signed: true }), file: read() });
    expect(settled.pending).toBe(false);
  });

  it("counts a read that came back with nothing as a read that decided nothing", () => {
    // Neither absence may settle this card. Settling prints "nothing is
    // waiting on you" over the only intent control in the product, or says the
    // estimate is being worked out, on the strength of a read that did not
    // land — a claim about a regulated record made off a failure.
    const out = standing({ row: at("approved", { signed: true }), file: undefined });
    const failed = standing({ row: at("approved", { signed: true }), file: null });

    for (const card of [out, failed]) {
      expect(card.noControl).toBeNull();
      expect(card.body).toBe(APPROVED_BODY);
      expect(card.body).not.toBe(ESTIMATE_PENDING_BODY);
    }

    // They are told apart on what happens next, because the promises differ.
    // A fetch still out resolves on its own, so that card waits and owes no
    // explanation. A file that will not project never resolves, so waiting on
    // it is waiting forever — that card stops pending and offers the file,
    // which is the one destination this read does not gate.
    expect(out.pending).toBe(true);
    expect(out.control).toBeNull();

    expect(failed.pending).toBe(false);
    expect(failed.control?.label).toBe(OPEN_THIS_FILE);
    expect(failed.control?.weight).toBe("outline");
  });

  it("is pending for that one card and no other", () => {
    for (const { status, card } of EVERY_CARD) {
      if (card.pending) expect(status).toBe("approved");
    }
    for (const status of STATES) {
      expect(standing({ row: at(status), file: read() }).pending, status).toBe(false);
    }
  });

  /**
   * The cards whose body already ends the matter, so no sentence stands in.
   *
   * Silence where a control usually sits reads as an omission, which is why
   * the rule below exists at all. These are the cards where the body itself
   * says nothing is being asked — a funded loan, a closed file, an application
   * with us — and a sentence repeating it would be the page saying one thing
   * twice. The list is pinned so a twentieth state joining it is a failure
   * rather than a discovery.
   */
  const SAYS_IT_IN_THE_BODY = [
    "in_underwriting, signed",
    "in_underwriting, signed and read",
    "closing",
    "closing, read",
    "rescission_pending",
    "rescission_pending, read",
    "funded",
    "funded, read",
    "withdrawn",
    "withdrawn, read",
    "canceled",
    "canceled, read",
    // "You told us to proceed. Nothing else is needed from you right now." —
    // the one card that joins this list only once its read lands, and the
    // reason the list is now asked of the read cards too.
    "approved, intent recorded",
  ];

  it("says why there is no control, or has already said it in the body", () => {
    const silent = EVERY_CARD.filter(
      ({ card }) =>
        (card.mode === "us" || card.mode === "ended") &&
        card.control === null &&
        card.noControl === null &&
        !card.pending,
    ).map(({ label }) => label);
    expect(silent.sort()).toEqual([...SAYS_IT_IN_THE_BODY].sort());
  });

  it("says it in a sentence everywhere else", () => {
    const spoken = EVERY_CARD.filter(({ card }) => card.noControl !== null);
    const named = spoken.map(({ label }) => label);
    expect(named).toContain("intake_received");
    expect(named).toContain("suspended");
    expect(named).toContain("approved, signed and read");
    for (const { label, card } of spoken) {
      expect(card.noControl, label).toBe(NOTHING_WAITING);
    }
  });

  it("never offers one destination twice under two labels", () => {
    // The defect the documents branch demonstrates: two controls of different
    // weight navigating to the same URL. Where the control already goes to the
    // record, the control wins and the quiet link is dropped.
    for (const { label, card } of EVERY_CARD) {
      if (card.quiet) expect(card.control?.to, label).not.toBe(card.quiet.to);
    }
    const dropped = EVERY_CARD.filter(({ card }) => card.showHistory && card.quiet === null).map(
      ({ label }) => label,
    );
    expect(dropped.sort()).toEqual([
      "adverse_action_pending, read",
      "conditionally_approved, read",
      "denied, read",
    ]);
  });

  it("offers the record only where there is one to offer", () => {
    // There is no ledger on a file with no application, so the heading would
    // stand over nothing on the one card whose whole point is that nothing was
    // recorded.
    expect(standing({ row: row({ applicationState: null }) }).showHistory).toBe(false);
    expect(standing({ row: row({ applicationState: null }) }).quiet).toBeNull();
    const shown = EVERY_CARD.filter(({ card }) => card.showHistory);
    expect(shown.length).toBeGreaterThan(0);
    for (const { label, card } of shown) {
      expect(card.mode, label).not.toBe("you");
      expect(card.quiet?.label ?? SEE_EVERYTHING, label).toBe(SEE_EVERYTHING);
    }
  });

  it("offers it off the rows themselves, and not before they are there", () => {
    // The block is drawn off this file's own read, so it is absent for the
    // length of that fetch and absent for good on a file that will not
    // project. Offering it in either case is the heading over nothing that
    // the file with no application already has a rule against, and on the
    // funded card it is worse than empty: the body says the record of how it
    // got here is below, and the answer to that is the sentence written for a
    // card with nothing under it.
    const funded = (file: HomeContext["file"]) => standing({ row: at("funded"), file });
    expect(funded(undefined).showHistory).toBe(false);
    expect(funded(undefined).body).toBe(FUNDED_WITHOUT_HISTORY);
    expect(funded(read({ status: "funded" })).showHistory).toBe(false);
    expect(funded(read({ status: "funded" })).body).toBe(FUNDED_WITHOUT_HISTORY);

    const recorded = funded(read({ status: "funded", ledger: LEDGER }));
    expect(recorded.showHistory).toBe(true);
    expect(recorded.body).toBe(FUNDED_BODY);
    expect(recorded.quiet?.label).toBe(SEE_EVERYTHING);
  });
});

describe("what is outstanding, named rather than implied", () => {
  const OWED = {
    event: "borrower_owes",
    reasonCode: "bank_connection_needed",
    to: "awaiting_borrower",
  };

  it("names the branch, and beats the screen the cursor stopped at", () => {
    const card = standing({ row: at("awaiting_borrower", { stage: "identity", owes: OWED }) });
    expect(card.control?.to).toBe("/f/f1/bank");
    expect(card.lead).toContain("connect your bank");
  });

  it("names every branch the reconciler can record", () => {
    const branch = (reasonCode: string) =>
      standing({
        row: at("awaiting_borrower", { owes: { ...OWED, reasonCode } }),
      }).control?.to;
    expect(branch("payroll_connection_needed")).toBe("/f/f1/payroll");
    expect(branch("tax_transcript_needed")).toBe("/f/f1/irs");
    expect(branch("documents_needed")).toBe("/f/f1/documents");
  });

  it("sends a reason code nobody wrote words for at the file itself", () => {
    // The words fall back through `wordsFor` to the destination state's own
    // heading, which is why the lead is the catalog's and not a sentence this
    // module wrote: the ledger already answers "a row nobody wrote copy for".
    const card = standing({
      row: at("awaiting_borrower", {
        stage: "identity",
        owes: { ...OWED, reasonCode: "something_new" },
      }),
    });
    expect(card.control?.to).toBe("/f/f1/identity");
    expect(card.lead).toBe(entryFor("awaiting_borrower")!.heading);
  });

  it("changes the answer in that state and in no other", () => {
    // The row stays on the ledger forever. Read anywhere but the state the
    // reconciler wrote it in, it names an obligation already cleared — which
    // is why the server gates it and why this asks every other state too.
    for (const status of STATES) {
      if (status === "awaiting_borrower") continue;
      expect(standing({ row: at(status, { owes: OWED }) }), status).toEqual(
        standing({ row: at(status) }),
      );
    }
  });

  it("prefers the ledger once it has been read, which is the same row", () => {
    const ledger = [
      { seq: 1, event: "borrower_owes", reasonCode: "documents_needed", to: "awaiting_borrower" },
      {
        seq: 2,
        event: "borrower_owes",
        reasonCode: "payroll_connection_needed",
        to: "awaiting_borrower",
      },
    ];
    const card = standing({
      row: at("awaiting_borrower", { owes: OWED }),
      file: read({ ledger: ledger as never, status: "awaiting_borrower" }),
    });
    expect(card.control?.to).toBe("/f/f1/payroll");
  });
});

describe("where in the flow, and only while there is a flow to be in", () => {
  it("is offered on the four screens a borrower is still walking", () => {
    const stepped = EVERY_STATE.filter(({ card }) => card.showStep).map(({ status }) => status);
    expect(stepped.sort()).toEqual(["awaiting_borrower", "draft", "in_underwriting"]);
    expect(standing({ row: row({ applicationState: null }) }).showStep).toBe(true);
  });

  it("is gone the moment the file is signed, decided, stopped or held", () => {
    // A step count over "We can't approve this" is the four-dot progress bar
    // arriving on the page built to take it off the other screens.
    expect(standing({ row: at("in_underwriting", { signed: true }) }).showStep).toBe(false);
    for (const status of ["suspended", "approved", "denied", "funded", "withdrawn"]) {
      expect(standing({ row: at(status) }).showStep, status).toBe(false);
    }
  });
});

describe("the two clocks", () => {
  const DUE_AHEAD = "2026-09-20T03:59:59.999Z";
  const DUE_BEHIND = "2026-09-01T03:59:59.999Z";
  const ECOA = [{ kind: "ECOA_ADVERSE_ACTION_30D", tolledFrom: "2026-09-09", tolledUntil: null }];

  it("puts the Loan Estimate under the states it is still ahead of", () => {
    // The five are written out rather than read off the module, or this would
    // agree with whatever the module said and check only that the resolver
    // reads its own list. It is a POSITIVE list because the obvious negative
    // one — anything not past deciding — is wrong on the state that matters.
    const AHEAD = [
      "awaiting_borrower",
      "draft",
      "in_processing",
      "in_underwriting",
      "intake_received",
    ];
    expect([...ESTIMATE_AHEAD].sort()).toEqual(AHEAD);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    for (const status of STATES) {
      const card = standing({
        row: at(status),
        file: read({ status, loanEstimate: { dueAt: DUE_AHEAD } }),
      });
      expect(card.clockBelow === "estimate", status).toBe(AHEAD.includes(status));
    }
  });

  it("drops the date once the date is behind us", () => {
    // The clock opens already tolled and nothing ever satisfies it, so a date
    // that has passed was never a deadline running down. On a page read again
    // every week, printing it is a lie rather than a wart.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const card = (dueAt: string) =>
      standing({
        row: at("in_underwriting", { signed: true }),
        file: read({ loanEstimate: { dueAt } }),
      }).clockBelow;
    expect(card(DUE_AHEAD)).toBe("estimate");
    expect(card(DUE_BEHIND)).toBe("estimate-lapsed");
  });

  it("never puts a Loan Estimate date under a decline", () => {
    // `adverse_action_pending` is neither terminal nor past-deciding, so the
    // obvious `!pastDeciding` gate prints "Your Loan Estimate is due by
    // September 14" directly under "We can't approve this".
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    for (const status of ["adverse_action_pending", "denied"]) {
      expect(
        standing({
          row: at(status),
          file: read({ status, loanEstimate: { dueAt: DUE_AHEAD } }),
        }).clockBelow,
        status,
      ).toBeNull();
    }
  });

  it("puts the adverse-action date above the body, on those two states alone", () => {
    for (const status of STATES) {
      const card = standing({ row: at(status), file: read({ status, clocks: ECOA }) });
      const owed = status === "adverse_action_pending" || status === "denied";
      expect(card.clockAbove, status).toBe(owed ? "ecoa" : null);
    }
  });

  it("supplies the referent the regulated sentence points at, or says the other one", () => {
    // The shipping body ends "and the date it is due is above", which is a
    // claim about layout: true where the clock renders and false where it does
    // not. The fix is to supply the referent rather than to trim the string.
    const withClock = standing({
      row: at("adverse_action_pending"),
      file: read({ status: "adverse_action_pending", clocks: ECOA }),
    });
    expect(withClock.clockAbove).toBe("ecoa");
    expect(withClock.body).toBe(ADVERSE_COPY.body);

    const without = standing({ row: at("adverse_action_pending"), file: read() });
    expect(without.clockAbove).toBeNull();
    expect(without.body).toBe(ADVERSE_WITHOUT_DATE);
  });

  it("does the same for the funded card, which points downward", () => {
    const withHistory = standing({
      row: at("funded"),
      file: read({
        status: "funded",
        ledger: [{ seq: 1, event: "disbursed", reasonCode: null, to: "funded" }] as never,
      }),
    });
    expect(withHistory.body).toBe(FUNDED_BODY);
    expect(standing({ row: at("funded") }).body).toBe(FUNDED_WITHOUT_HISTORY);
  });
});

describe("the two headings this page writes instead of the catalog's", () => {
  it("asks for the signature no state can name", () => {
    const card = standing({ row: at("in_underwriting", { signed: false }) });
    expect(card.lead).toBe(SIGN_LEAD);
    expect(card.lead).not.toBe(entryFor("in_underwriting")!.heading);
    expect(card.mode).toBe("you");
  });

  it("asks for it on a file the machine decided without one", () => {
    // Nothing on the way to a decision checks for a signature: the branch
    // screens post one unconditionally and an approval is a legal edge out of
    // underwriting. `endingFor` answers null for such a file, which is what
    // makes the review screen render the panel asking for it — so a card
    // reading the intent latch instead said nothing was waiting on the
    // borrower, with no control at all, over the one screen that was asking.
    const state = at("approved").applicationState;
    const inputs = { outcome: "clear_to_close" as const, state, ratios: RATIOS, branches: [] };
    expect(endingFor({ ...inputs, signed: false })).toBeNull();
    expect(endingFor({ ...inputs, signed: true })).toBe("estimate");

    const card = standing({
      row: at("approved", {
        signed: false,
        decisions: [{ outcome: "clear_to_close", ausRecommendation: "Approve" }],
      }),
      file: read({ status: "approved", ledger: LEDGER, ratios: RATIOS }),
    });
    expect(card.lead).toBe(SIGN_LEAD);
    expect(card.body).toBe(UNSIGNED_BODY);
    expect(card.mode).toBe("you");
    expect(card.control).toEqual({ label: READ_AND_SIGN, to: "/f/f1/review", weight: "primary" });
    expect(card.pending).toBe(false);
    expect(card.noControl).toBeNull();
    // The position line stays off. The four screens are behind a decided file
    // and a step count over one is the progress bar this page took off the
    // other screens arriving back on it.
    expect(card.showStep).toBe(false);
  });

  it("says who holds a signed file, for the whole of the state", () => {
    // The catalog's heading says a named actor holds it. There is no role on
    // `User`, no assignment and no queue. The claim is about who holds the
    // file, which the word the engine returned does not change — so the
    // override covers both branches and the body carries the difference.
    const signed = (outcome: "referred" | "clear_to_close") =>
      standing({
        row: at("in_underwriting", {
          signed: true,
          decisions: [{ outcome, ausRecommendation: "Refer" }],
        }),
      });
    expect(signed("referred").lead).toBe(REFERRED_COPY.headline);
    expect(signed("clear_to_close").lead).toBe(REFERRED_COPY.headline);
    expect(signed("referred").body).toBe(REFERRED_COPY.body);
    expect(signed("clear_to_close").body).not.toBe(REFERRED_COPY.body);
  });
});

describe("the one control the server refuses", () => {
  it("offers a new application to a person who can start one", () => {
    for (const status of ["expired", "incomplete_closed"]) {
      const card = standing({ row: at(status), user: { persona: null } });
      expect(card.control?.to, status).toBe(NEW_APPLICATION);
      expect(card.noControl, status).toBeNull();
    }
  });

  it("replaces it with the sentence the session already has for it", () => {
    // The refusal is about the account rather than the file, so the sentence
    // is the account's — said where the session is, not written a second time.
    const card = standing({ row: at("expired"), user: { persona: { key: "maya" } } });
    expect(card.control).toBeNull();
    expect(card.noControl).toBe(PERSONA_READ_ONLY);
    expect(canStart({ persona: { key: "maya" } })).toBe(false);
  });

  it("answers read-only for a sample file and for a sample session", () => {
    expect(readOnly(row({ isDemo: true }), null)).toBe(true);
    expect(readOnly(row(), { persona: { key: "maya" } })).toBe(true);
    expect(readOnly(row(), null)).toBe(false);
    expect(readOnly(row(), { persona: null })).toBe(false);
  });
});

describe("which file the page is about", () => {
  const ranked = (rows: readonly FileRow[]) => rankFiles(rows).primary?.id;

  const you = (id: string, enteredAt: string) =>
    row({
      id,
      applicationState: {
        status: "awaiting_borrower",
        statusEnteredAt: enteredAt,
        terminal: false,
      },
    });
  const us = (id: string, enteredAt: string) =>
    row({
      id,
      applicationState: { status: "in_processing", statusEnteredAt: enteredAt, terminal: false },
    });
  const ended = (id: string, enteredAt: string) =>
    row({
      id,
      applicationState: { status: "withdrawn", statusEnteredAt: enteredAt, terminal: true },
    });

  it("puts your move first, then ours, then what has ended", () => {
    const files = [ended("c", "2026-09-10"), us("b", "2026-09-09"), you("a", "2026-09-01")];
    const { primary, live, closed } = rankFiles(files);
    expect(primary?.id).toBe("a");
    expect(live.map((f) => f.id)).toEqual(["b"]);
    expect(closed.map((f) => f.id)).toEqual(["c"]);
  });

  it("takes the file that moved most recently within a group", () => {
    // Not the one that was created most recently: every seeded row shares one
    // creation date, and "last moved" is the question anyway.
    expect(ranked([us("old", "2026-09-01"), us("new", "2026-09-10")])).toBe("new");
    expect(ranked([us("new", "2026-09-10"), us("old", "2026-09-01")])).toBe("new");
  });

  it("never makes a closed file primary while a live one exists", () => {
    expect(ranked([ended("c", "2026-09-10"), us("b", "2026-09-01")])).toBe("b");
  });

  it("makes a closed file primary when it is the newest thing that happened", () => {
    // A person whose only application was withdrawn gets that file's own card,
    // which is the record of what happened, rather than a badge and a shrug.
    const { primary, closed } = rankFiles([ended("c", "2026-09-10")]);
    expect(primary?.id).toBe("c");
    expect(closed).toEqual([]);
  });

  it("never makes a held file primary while something is waiting on the borrower", () => {
    const held = row({
      id: "held",
      applicationState: { status: "suspended", statusEnteredAt: "2026-09-10", terminal: false },
    });
    expect(ranked([held, you("a", "2026-09-01")])).toBe("a");
  });

  it("never makes somebody else's sample file primary", () => {
    const sample = row({ id: "demo", isDemo: true, mine: false });
    const { primary, samples } = rankFiles([sample]);
    expect(primary).toBeNull();
    expect(samples.map((f) => f.id)).toEqual(["demo"]);
    expect(ranked([sample, ended("c", "2026-09-01")])).toBe("c");
  });

  it("renders each file exactly once", () => {
    // A file that is both the card and a row underneath it is one file telling
    // somebody two things about itself on one screen, and the arithmetic that
    // produces it — a group filtered off the full ranking rather than off what
    // is left of it — reads as correct at every step.
    const files = [
      you("a", "2026-09-05"),
      us("b", "2026-09-04"),
      ended("c", "2026-09-03"),
      row({ id: "demo", isDemo: true, mine: false }),
    ];
    const { primary, live, closed, samples } = rankFiles(files);
    const rendered = [primary!, ...live, ...closed, ...samples].map((f) => f.id);
    expect(rendered.sort()).toEqual(["a", "b", "c", "demo"]);
    expect(live).not.toContain(primary);
    expect(closed).not.toContain(primary);
  });
});

describe("telling two files apart", () => {
  const draft = (id: string, createdAt: string) =>
    row({ id, createdAt, purpose: null, propertyCity: null, propertyState: null });

  it("names a file with no purpose and no address", () => {
    const { labels } = rankFiles([draft("a", "2026-09-07T15:14:00.000Z")]);
    expect(labels.a!.length).toBeGreaterThan(0);
  });

  it("gives two same-day drafts two names", () => {
    // The file every card offers to pick back up is precisely the one with
    // neither a purpose nor a place, and two of them are two rows reading the
    // same words. A person cannot name or rename a file, so the clock is what
    // is left.
    const { labels } = rankFiles([
      draft("a", "2026-09-07T15:14:00.000Z"),
      draft("b", "2026-09-07T21:40:00.000Z"),
    ]);
    expect(labels.a).not.toBe(labels.b);
    expect(labels.a).toMatch(/\d\s?[AP]M$/);
  });

  it("leaves a name alone when nothing collides with it", () => {
    const { labels } = rankFiles([
      draft("a", "2026-09-07T15:14:00.000Z"),
      row({ id: "b", propertyCity: "Austin", propertyState: "TX" }),
    ]);
    expect(labels.a).not.toMatch(/[AP]M$/);
    expect(labels.b).toBe("Purchase in Austin, TX");
  });

  it("tells an own file from a sample row, though they render in two sections", () => {
    // Two namespaces were two chances to call one thing by another thing's
    // name. Somebody else's file is named by whose it is, which is what keeps
    // the pair a person is most likely to have — their own abandoned draft and
    // one of the shared ones — from reading alike. The clock cannot do it: the
    // eight shared rows land in a single seeding run, so they share a minute.
    const { labels } = rankFiles([
      draft("mine", "2026-09-07T15:14:00.000Z"),
      row({
        id: "demo",
        isDemo: true,
        mine: false,
        createdAt: "2026-09-07T21:40:00.000Z",
        purpose: null,
        propertyCity: null,
        propertyState: null,
      }),
    ]);
    expect(labels.mine).not.toBe(labels.demo);
    expect(labels.demo).toContain("Maya Okafor");
    // And the shared one does not need the clock to be distinct, which is the
    // whole reason it is named by its person.
    expect(labels.demo).not.toMatch(/\d\s?[AP]M$/);
  });

  it("names every file the page renders, and names no two of them the same", () => {
    // The pair that collides is one own draft and one sample row, with a named
    // file between them that collides with neither — so the collision is only
    // seen by a pass that runs over everything the page draws. Their two start
    // times are two different minutes, which is as far as any of this goes:
    // the clock is the last thing on a row that is a name at all.
    const files = [
      draft("a", "2026-09-07T15:14:00.000Z"),
      row({ id: "b", propertyCity: "Austin", propertyState: "TX" }),
      row({
        id: "c",
        isDemo: true,
        mine: false,
        createdAt: "2026-09-07T18:05:00.000Z",
        purpose: null,
        propertyCity: null,
        propertyState: null,
      }),
    ];
    const { labels } = rankFiles(files);
    const named = files.map((f) => labels[f.id]!);
    expect(named.filter(Boolean)).toHaveLength(files.length);
    expect(new Set(named).size).toBe(files.length);
  });
});

describe("where a row's link goes", () => {
  it("is the screen the stage reached, until the file has stopped", () => {
    expect(screenFor(row({ stage: "bank" }))).toBe("bank");
    expect(screenFor(at("withdrawn", { stage: "bank" }))).toBe("review");
  });
});
