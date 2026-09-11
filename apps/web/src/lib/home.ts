/**
 * The nineteen states, joined to the four screens.
 *
 * The product knows where a file stands and it knows which screens exist, and
 * until now nothing joined the two: the file list keyed a link off the stage,
 * the shell redirected off the state, and the review screen decided its own
 * ending off the decision row. Three readers, three answers, and a borrower
 * could reach a page whose control promised something the destination would
 * not render. This module is that join, written once and pure, so the page
 * that renders it can be argued with separately from the rules it renders.
 *
 * Four things it does NOT do, each of them a way the first version went wrong:
 *
 * 1. **It writes no heading a state already has.** Sixteen leads come straight
 *    off the catalog. `awaiting_borrower` takes the ledger's own words with
 *    the catalog as its fallback, and `counteroffer_outstanding` reads the
 *    same sentence out of the outcome copy, where the counteroffer's words
 *    already live. Two headings are written here instead of read: the line
 *    asking for a signature, which no state can express, and the line saying
 *    who holds a signed file. `in_underwriting` is where both sit, and
 *    `approved` borrows the first whenever it too is unsigned. Everything else
 *    this module returns is a body, a control label or the sentence that
 *    stands in for a control, which are claims about this page rather than
 *    about what a state means.
 *
 * 2. **It re-derives nothing.** `endingFor` decides what the review screen
 *    renders, `entryFor` holds the state's words, `owedFrom` picks the
 *    outstanding obligation and `wordsFor` says it. A second copy of any of
 *    them is a second answer to a question a borrower can see both halves of.
 *
 * 3. **It names no payload a destination has not agreed to render.** A label
 *    may promise the reasons, or the Loan Estimate, only when `endingFor` —
 *    asked with the same inputs the review screen asks it with — has already
 *    said that is what renders there. Everywhere else the label names the
 *    destination, which is true under all seven endings.
 *
 * 4. **It puts no figure on the page.** The only number in anything it returns
 *    is a date. The loan amount and the property value are on the wire and
 *    are deliberately unread here: a figure with no derivation behind it is
 *    the defect the engine's whole recording discipline exists to stop, and
 *    the way to never have one on this surface is to have none.
 *
 * Mode and control are two axes, not one. Mode answers whose move it is;
 * control answers whether there is anything to press. Collapsing them is what
 * dresses a read-the-record link as a task: `conditionally_approved` and
 * `rescission_pending` have nothing outstanding on the borrower's side, and an
 * enum that says "your move means one primary button" gives them one.
 *
 * `none` and `unread` are in the vocabulary and are not built here. Neither is
 * about a file — one is a person who has never applied and one is a list read
 * that failed — so neither has a row to resolve, and the page that made the
 * read is where both are known.
 */

import type { DecisionOutcome } from "@hm/shared";
import { PERSONA_READ_ONLY } from "./auth.js";
import { endingFor } from "./endings.js";
import type { FileRow, LoanFileResponse } from "./file.js";
import { landingScreen } from "./file.js";
import { BRANCH_COPY, STAGE_TO_SCREEN, type BranchPath, type ScreenPath } from "./flow.js";
import {
  ADVERSE_WITHOUT_DATE,
  APPROVED_BODY,
  CANCELED_BODY,
  CLEAR_TO_CLOSE_BODY,
  CLOSING_BODY,
  CONDITIONS_BODY,
  CONNECT_YOUR_BANK,
  DENIED_BODY,
  DRAFT_BODY,
  ESTIMATE_PENDING_BODY,
  ESTIMATE_READY_BODY,
  EXPIRED_BODY,
  fileLabel,
  sharedFileLabel,
  FUNDED_BODY,
  FUNDED_WITHOUT_HISTORY,
  INCOMPLETE_BODY,
  INTAKE_BODY,
  labelWithStartTime,
  NOTHING_WAITING,
  NO_APPLICATION_BODY,
  UNKNOWN_STANDING_BODY,
  NO_APPLICATION_LEAD,
  OPEN_IT,
  OPEN_THIS_FILE,
  OWED_BANK_BODY,
  OWED_UNKNOWN_BODY,
  PICK_BACK_UP,
  PROCESSING_BODY,
  READ_AND_SIGN,
  READ_THE_DECISION,
  READ_THE_REASONS,
  READ_YOUR_ESTIMATE,
  RESCISSION_BODY,
  SEE_EVERYTHING,
  SEE_WHERE_THIS_STANDS,
  SEND_DOCUMENTS,
  SEND_TRANSCRIPTS,
  START_A_NEW_APPLICATION,
  SUSPENDED_BODY,
  UNKNOWN_STANDING_LEAD,
  UNSIGNED_BODY,
  WITHDRAWN_BODY,
  WITH_US_BODY,
} from "./home-copy.js";
import { owedFrom, wordsFor } from "./ledger.js";
import {
  ADVERSE_COPY,
  COUNTEROFFER_COPY,
  ENDING_COPY,
  REFERRED_COPY,
  SIGN_LEAD,
} from "./outcomes.js";
import { entryFor } from "./states.js";

/** Whose move it is, and what kind of page this is at all. */
export type Mode = "you" | "us" | "ended" | "none" | "unread";

export interface Standing {
  mode: Mode;
  /** The card's only h1. The state's own heading, except where noted. */
  lead: string;
  body: string;
  /** The ECOA pair, rendered BEFORE the body so the body's "above" is true. */
  clockAbove: "ecoa" | null;
  /** The Loan Estimate, rendered after it. */
  clockBelow: "estimate" | "estimate-lapsed" | null;
  control: { label: string; to: string; weight: "primary" | "outline" } | null;
  /** The sentence where a control would be, when silence would read as absence. */
  noControl: string | null;
  /** A read that would decide whether a control exists has not answered yet. */
  pending: boolean;
  quiet: { label: string; to: string } | null;
  showStep: boolean;
  showHistory: boolean;
}

export interface HomeContext {
  /** The row from `GET /api/files`, which every card has. */
  row: FileRow;
  /**
   * `GET /api/files/:id`, which only the primary card makes.
   *
   * `undefined` is "not read yet" and is the resting state for every row on
   * the page; the clocks and the history come off this read and are absent
   * until it lands. It carries the whole response rather than the file alone,
   * because the ledger, the clocks and the estimate's due date are all on the
   * application state beside it.
   */
  file: LoanFileResponse | null | undefined;
  user: { persona: unknown } | null | undefined;
}

/**
 * Every route a control on this page may name, as the last path segment.
 *
 * A closed vocabulary, and a test holds the resolver to it. A `to` this list
 * does not contain matches no route under `/f/:fileId`, and there is no
 * not-found surface to catch it: the top-level catch-all redirects to the
 * index. So the borrower presses a control and silently arrives back on this
 * page, with nothing broken to see and nothing to explain it.
 */
export const DESTINATIONS: readonly (ScreenPath | BranchPath)[] = [
  "property",
  "identity",
  "bank",
  "review",
  "payroll",
  "irs",
  "documents",
];

/** The one route on this page that is not about a file that exists. */
export const NEW_APPLICATION = "/f/new/property";

/**
 * The states where a Loan Estimate is still ahead of the file.
 *
 * A POSITIVE list, deliberately. The obvious gate is `!pastDeciding(state)`,
 * and it is wrong in the one place it matters: `adverse_action_pending` is
 * neither terminal nor past-deciding, so that gate prints a Loan Estimate due
 * date directly under "We can't approve this".
 */
export const ESTIMATE_AHEAD: readonly string[] = [
  "draft",
  "intake_received",
  "in_processing",
  "awaiting_borrower",
  "in_underwriting",
];

/** The two states that carry an adverse-action clock the borrower is owed. */
const ECOA_STATES: readonly string[] = ["adverse_action_pending", "denied"];

/** The states whose card is the borrower's move, the signature aside. */
const YOURS: readonly string[] = [
  "draft",
  "awaiting_borrower",
  "counteroffer_outstanding",
  "approved",
];

/**
 * Whether this file may be acted on at all.
 *
 * A demo file refuses everybody and a sample session is refused on every file
 * including its own, so one predicate has to answer both. The review screen is
 * the only screen that already does: the other three ask whether the FILE is a
 * sample and never whether the session is, which is why a tester pressing a
 * step screen's control finds out from the server rather than from the page.
 */
export const readOnly = (row: FileRow, user: { persona: unknown } | null | undefined): boolean =>
  row.isDemo || user?.persona != null;

/**
 * Whether this session has an application to start.
 *
 * A sample borrower does not. The server refuses `POST /files` from such a
 * session, so leaving the control up would offer a tester the one action on
 * the page that answers 403.
 */
export function canStart(user: { persona: unknown } | null | undefined): boolean {
  return !user?.persona;
}

/**
 * Where a row's link goes.
 *
 * The stage is where the borrower got to, and it only ever moves forward — so
 * on a file whose application has ended or is held it still points at the bank
 * or identity screen. The shell refuses to open one there and redirects to the
 * review screen; asking `landingScreen` here means the link and the shell
 * cannot disagree.
 */
export function screenFor(row: FileRow): ScreenPath {
  const stage = STAGE_TO_SCREEN[row.stage];
  return landingScreen(row.applicationState, stage) ?? stage;
}

const route = (row: FileRow, screen: ScreenPath | BranchPath) => `/f/${row.id}/${screen}`;

/**
 * Which of the three groups a file ranks in, from the row alone.
 *
 * `ended` is terminal plus `adverse_action_pending`, which is the state a
 * ranking written from `TERMINAL` drops on the floor: the machine keeps it
 * live until the notice goes out, and to the borrower it is an ending. It is
 * also where `suspended` deliberately does NOT go — a hold is a wait, the file
 * can still move, and grouping it with the endings would paint five terminal
 * states and one live one the same.
 *
 * The default is named rather than left to fall through, so a status this app
 * has never heard of is ranked rather than dropped out of every group.
 */
export function modeForRow(row: FileRow): "you" | "us" | "ended" {
  const state = row.applicationState;
  if (!state) return "us";
  if (state.terminal || state.status === "adverse_action_pending") return "ended";
  if (state.status === "in_underwriting") return row.signed ? "us" : "you";
  if (YOURS.includes(state.status)) return "you";
  return "us";
}

const GROUP_ORDER = { you: 0, us: 1, ended: 2 } as const;

/** When the file last moved. The start date is all a file with no application has. */
const movedAt = (row: FileRow) => row.applicationState?.statusEnteredAt ?? row.createdAt;

export interface RankedFiles {
  primary: FileRow | null;
  /** The rest of the live files. The primary is not among them. */
  live: FileRow[];
  /** The ended files. The primary is not among them either. */
  closed: FileRow[];
  /** Demo files belonging to somebody else. Never primary, in any circumstance. */
  samples: FileRow[];
  /** What each file is called, by id, made unique within what renders together. */
  labels: Record<string, string>;
}

/**
 * Which file the page is about, and where the others go.
 *
 * All the `you` files, then all the `us` files, then all the `ended` ones, each
 * newest first by when the state was entered rather than by when the file was
 * made — every seeded row shares one creation date, and "last moved" is the
 * question anyway.
 *
 * The primary appears in exactly one place: it is removed from every group
 * below it. A file that is both the card and a row underneath it is one file
 * telling somebody two things about itself on one screen, and the ended states
 * are where that bites, because they are the ones with a card worth reading.
 */
export function rankFiles(files: readonly FileRow[]): RankedFiles {
  const samples = files.filter((f) => f.isDemo && !f.mine);
  const own = files.filter((f) => !(f.isDemo && !f.mine));

  const ranked = [...own].sort((a, b) => {
    const group = GROUP_ORDER[modeForRow(a)] - GROUP_ORDER[modeForRow(b)];
    return group !== 0 ? group : movedAt(b).localeCompare(movedAt(a));
  });

  const primary = ranked[0] ?? null;
  const rest = ranked.slice(1);

  return {
    primary,
    live: rest.filter((f) => modeForRow(f) !== "ended"),
    closed: rest.filter((f) => modeForRow(f) === "ended"),
    samples,
    // The card and the rows beneath it are read together, so they share one
    // namespace: a name that is unique among the rows and matches the card's
    // is still two things called one thing. The sample rows are in it too —
    // they render on the same page, under their own heading, and a heading is
    // not what a person reads when they are working out which file is theirs.
    labels: labelsWithin([...ranked, ...samples]),
  };
}

/**
 * What each of these files is called, with collisions broken by the clock.
 *
 * `fileLabel` is handed one row and cannot know there is another one like it,
 * and two drafts abandoned on the same day with no address are exactly that:
 * no purpose, no place, one date, one name. The start time is the only thing
 * left to tell them apart, because a person cannot name or rename a file at
 * all — which makes this a machine's answer to a human question, and the best
 * one available. It is the last one, too: two files started in the same minute
 * come back with the same name, and nothing else on a row is a name.
 *
 * It is handed everything the page is about to draw rather than one section of
 * it, because sections are not what somebody reads to work out which file is
 * which.
 */
function labelsWithin(rows: readonly FileRow[]): Record<string, string> {
  // Somebody else's file is named by whose it is. The clock tiebreaker below
  // cannot help there: the shared files arrive in one seeding run, so they
  // share a minute as well as a city.
  const plain = new Map(
    rows.map((row) => [row.id, row.mine ? fileLabel(row) : sharedFileLabel(row)]),
  );
  const seen = new Map<string, number>();
  for (const label of plain.values()) seen.set(label, (seen.get(label) ?? 0) + 1);

  const out: Record<string, string> = {};
  for (const row of rows) {
    const label = plain.get(row.id)!;
    out[row.id] = (seen.get(label) ?? 0) > 1 ? labelWithStartTime(label, row.createdAt) : label;
  }
  return out;
}

/* ── The card ───────────────────────────────────────────────────────────── */

/**
 * Everything the primary card says, for one file.
 *
 * The order below is the precedence, and it is the join the product did not
 * have: the application's state first, then the signature — which no state can
 * express, because `esign` is deliberately outside the obligations the ledger
 * tracks — then the outstanding obligation, and the stage last, as the
 * fallback for a draft and for a file with no application at all.
 */
export function standingFor({ row, file, user }: HomeContext): Standing {
  const state = row.applicationState;
  const outcome: DecisionOutcome | null = row.decisions[0]?.outcome ?? null;
  const standing = file?.applicationState ?? null;

  // Asked with the inputs the review screen passes, so the two cannot disagree
  // about what is rendered there. `branches: []` is sound rather than lazy:
  // outstanding borrower work is what puts a file in `awaiting_borrower`, so an
  // approved file with live branches is a state the ledger does not produce.
  const ending = endingFor({
    signed: row.signed,
    outcome,
    state,
    ratios: file?.file.decision?.ratios ?? null,
    branches: [],
  });

  const card = cardFor({ row, file, user, state, outcome, ending, standing });

  // The record is drawn off this file's own read, so it is absent for the
  // length of that fetch and absent for good on a file that will not project —
  // and a heading standing over no rows is the same empty block the file with
  // no application was given this rule to avoid, arriving through the other
  // input. It is the rows that decide, not the read: an application whose
  // ledger is somehow empty has nothing to show either.
  const showHistory = card.mode !== "you" && state !== null && (standing?.ledger.length ?? 0) > 0;
  const history = { label: SEE_EVERYTHING, to: route(row, "review") };

  return {
    ...card,
    clockAbove: clockAbove(row, standing),
    clockBelow: clockBelow(row, standing),
    showHistory,
    // One destination never gets two affordances of different weight under two
    // labels. Where the control already goes to the record, the control wins.
    quiet: showHistory && card.control?.to !== history.to ? history : null,
  };
}

/** What `cardFor` settles, before the clocks and the record are added. */
type Card = Pick<
  Standing,
  "mode" | "lead" | "body" | "control" | "noControl" | "pending" | "showStep"
>;

interface CardInput extends HomeContext {
  state: FileRow["applicationState"];
  outcome: DecisionOutcome | null;
  ending: ReturnType<typeof endingFor>;
  standing: LoanFileResponse["applicationState"];
}

function cardFor(input: CardInput): Card {
  const { row, file, user, state, outcome, ending, standing } = input;

  const primary = (label: string, to: string) => ({ label, to, weight: "primary" as const });
  const outline = (label: string, to: string) => ({ label, to, weight: "outline" as const });
  const base = { control: null, noControl: null, pending: false, showStep: false };
  const heading = (id: string) => entryFor(id)?.heading ?? UNKNOWN_STANDING_LEAD;

  // A file made before applications existed, and the one card whose heading is
  // its own sentence. `NO_APPLICATION` belongs to the standing row — it is
  // where both surfaces that already say it put it — so a lead that repeated
  // it would print the same six words twice on one card in two sizes.
  if (!state) {
    return {
      ...base,
      mode: "us",
      lead: NO_APPLICATION_LEAD,
      body: NO_APPLICATION_BODY,
      control: outline(OPEN_THIS_FILE, route(row, screenFor(row))),
      showStep: true,
    };
  }

  const lead = heading(state.status);

  switch (state.status) {
    case "draft":
      return {
        ...base,
        mode: "you",
        lead,
        body: DRAFT_BODY,
        control: primary(PICK_BACK_UP, route(row, screenFor(row))),
        showStep: true,
      };

    case "intake_received":
      return { ...base, mode: "us", lead, body: INTAKE_BODY, noControl: NOTHING_WAITING };

    case "in_processing":
      return { ...base, mode: "us", lead, body: PROCESSING_BODY, noControl: NOTHING_WAITING };

    case "awaiting_borrower":
      return owedCard(row, standing, lead);

    // A hold is a wait, not an ending. The file is stopped on a check of ours
    // and the borrower cannot advance it, which is what makes this `us` and
    // not `you` — and why it wears the neutral pill the catalog gives it
    // rather than the tone of a decision.
    case "suspended":
      return { ...base, mode: "us", lead, body: SUSPENDED_BODY, noControl: NOTHING_WAITING };

    case "in_underwriting":
      return row.signed
        ? {
            ...base,
            mode: "us",
            // The one override that covers a whole state, and the second on
            // this surface after the signature line. The catalog's heading
            // says a named actor holds the file; there is no role on `User`,
            // no assignment and no queue. The claim is about who holds it,
            // which is unchanged by the word the engine returned, so the body
            // carries the difference and the lead does not.
            lead: REFERRED_COPY.headline,
            body: outcome === "referred" ? REFERRED_COPY.body : WITH_US_BODY,
          }
        : {
            ...base,
            mode: "you",
            // The other recorded override: no state can express a missing
            // signature, and "Being decided" over a button asking for one is
            // the contradiction this line exists to end.
            lead: SIGN_LEAD,
            body: UNSIGNED_BODY,
            control: primary(READ_AND_SIGN, route(row, "review")),
            showStep: true,
          };

    // The label is the whole of what the divergence changes. A decision row
    // saying something else — a branch page posts one unconditionally — does
    // not un-counteroffer an application the machine actually moved, so the
    // state keeps its words; what it loses is a control promising a decision
    // the review screen will not render.
    case "counteroffer_outstanding":
      return {
        ...base,
        mode: "you",
        lead: COUNTEROFFER_COPY.headline,
        body: COUNTEROFFER_COPY.body,
        control:
          ending === "counteroffer"
            ? primary(READ_THE_DECISION, route(row, "review"))
            : outline(SEE_WHERE_THIS_STANDS, route(row, "review")),
      };

    case "conditionally_approved":
      return {
        ...base,
        mode: "us",
        lead,
        body: CONDITIONS_BODY,
        control: outline(SEE_WHERE_THIS_STANDS, route(row, "review")),
      };

    case "approved":
      return approvedCard(row, file, lead, ending);

    case "clear_to_close":
      return { ...base, mode: "us", lead, body: CLEAR_TO_CLOSE_BODY, noControl: NOTHING_WAITING };

    case "closing":
      return { ...base, mode: "us", lead, body: CLOSING_BODY };

    case "rescission_pending":
      return { ...base, mode: "us", lead, body: RESCISSION_BODY };

    case "funded":
      return {
        ...base,
        mode: "ended",
        lead,
        // The shipping sentence ends by pointing at the record below it, which
        // is drawn off the file's own read and is therefore absent for the
        // length of that fetch.
        body: standing && standing.ledger.length > 0 ? FUNDED_BODY : FUNDED_WITHOUT_HISTORY,
      };

    case "adverse_action_pending":
      return {
        ...base,
        mode: "ended",
        lead,
        // Same fix from the other side: the regulated sentence ends by
        // pointing at the due date above it, so the card supplies the referent
        // where the clock is there and says the other sentence where it is not.
        body: clockAbove(row, standing) ? ADVERSE_COPY.body : ADVERSE_WITHOUT_DATE,
        control: reasonsOrStanding(row, ending),
      };

    case "denied":
      return {
        ...base,
        mode: "ended",
        lead,
        body: DENIED_BODY,
        control: reasonsOrStanding(row, ending),
      };

    case "incomplete_closed":
      return { ...base, mode: "ended", lead, body: INCOMPLETE_BODY, ...startAgain(user) };

    case "withdrawn":
      return { ...base, mode: "ended", lead, body: WITHDRAWN_BODY };

    case "canceled":
      return { ...base, mode: "ended", lead, body: CANCELED_BODY };

    case "expired":
      return { ...base, mode: "ended", lead, body: EXPIRED_BODY, ...startAgain(user) };

    // A status this app has no card for. It still renders, and it says the
    // least that is true of it rather than borrowing the words of a state it
    // might not be in.
    default:
      return {
        ...base,
        mode: "us",
        lead,
        body: UNKNOWN_STANDING_BODY,
        control: outline(OPEN_THIS_FILE, route(row, screenFor(row))),
      };
  }
}

/**
 * The one control whose absence is a refusal rather than a silence.
 *
 * Starting an application is the only thing on this page the server genuinely
 * says no to, and it says no to the session rather than to the file — so the
 * sentence that replaces it is the account's, which is where that refusal is
 * already worded.
 */
function startAgain(user: HomeContext["user"]): Pick<Card, "control" | "noControl"> {
  return canStart(user)
    ? {
        control: { label: START_A_NEW_APPLICATION, to: NEW_APPLICATION, weight: "outline" },
        noControl: null,
      }
    : { control: null, noControl: PERSONA_READ_ONLY };
}

/**
 * The declined file's control, which names the reasons only where they render.
 *
 * The payload is real — the recorded reasons are on the review screen under
 * their own lead — but only while `endingFor` returns `adverse`, and that
 * comes apart: neither of these two states stops the shell opening a branch
 * page, where a `POST /files/:id/decision` writes a fresh `referred` row over
 * the decline. A red control landing on "We're reviewing this ourselves" is
 * the contradiction this page was built to end, arriving across two surfaces
 * instead of across one screen.
 *
 * `applied("denied", state)` is the question this sounds like and is not the
 * gate, because it is the narrower half of one: it is true of any file whose
 * state is `denied` or `adverse_action_pending`, whatever the newest decision
 * row says, so on its own it would promise reasons on a file whose review
 * screen renders the standing and the timeline instead. `endingFor` asks it
 * AND asks the decision row, and it is the answer the destination itself
 * gives, so it is the one asked here.
 */
function reasonsOrStanding(row: FileRow, ending: ReturnType<typeof endingFor>) {
  return {
    label: ending === "adverse" ? READ_THE_REASONS : SEE_WHERE_THIS_STANDS,
    to: route(row, "review"),
    weight: "outline" as const,
  };
}

/**
 * What this file is waiting on the borrower for, named rather than implied.
 *
 * The row the API sends and the row `owedFrom` picks off the ledger are two
 * expressions of one rule, bound by a test in the API — so the ledger is used
 * once it has been read and the row stands in until then, and neither can name
 * an obligation the other would not. The lead is the ledger's own words, which
 * is the only per-file next-action copy the product has.
 *
 * Read in any other state it would name something already cleared, which is
 * why the server gates it and why this is the only branch that asks.
 */
function owedCard(
  row: FileRow,
  standing: LoanFileResponse["applicationState"],
  fallbackLead: string,
): Card {
  const owed = standing ? owedFrom(standing.ledger) : row.owes;
  const base = { mode: "you" as const, noControl: null, pending: false, showStep: true };
  const lead = owed ? wordsFor(owed.event, owed.reasonCode, owed.to) : fallbackLead;
  const at = (screen: ScreenPath | BranchPath, label: string, body: string): Card => ({
    ...base,
    lead,
    body,
    control: { label, to: route(row, screen), weight: "primary" },
  });

  switch (owed?.reasonCode) {
    // The bank is a step rather than a branch, so it has no card in the branch
    // copy to take a reason from — and a file sitting at "connect your bank"
    // with nothing under it was the one obligation the product could not say
    // why it had.
    case "bank_connection_needed":
      return at("bank", CONNECT_YOUR_BANK, OWED_BANK_BODY);
    case "payroll_connection_needed":
      return at("payroll", BRANCH_COPY.payroll.title, BRANCH_COPY.payroll.because);
    case "tax_transcript_needed":
      return at("irs", SEND_TRANSCRIPTS, BRANCH_COPY.irs.because);
    case "documents_needed":
      return at("documents", SEND_DOCUMENTS, BRANCH_COPY.documents.because);
    default:
      return at(screenFor(row), OPEN_IT, OWED_UNKNOWN_BODY);
  }
}

/**
 * The one card that renders an empty action area rather than guessing.
 *
 * The split reads `intentToProceedAt`, which is on the file and not on the
 * list, and both defaults are wrong for somebody: guess "your move" and a
 * borrower who has already told us to proceed watches a primary button appear
 * and vanish; guess "ours" and a borrower who has not reads that nothing is
 * needed, directly over the only intent control in the product. So the card
 * says the part that is true either way and waits.
 *
 * The estimate label is gated on the answer `endingFor` gives, not on the
 * state: an approved file whose ratios did not compute renders "ours" on the
 * review screen, and a label promising a Loan Estimate there is the payload
 * rule broken on the best outcome the product has.
 *
 * The signature comes first, because a file can be decided without one and the
 * latch below cannot see that. Nothing on the way to a decision checks: the
 * branch screens post one unconditionally, and an approval is a legal edge out
 * of underwriting. `endingFor` answers null for such a file, which is what
 * makes the review screen render the panel asking for the signature — so
 * reading the intent latch there would say nothing was waiting on the borrower
 * directly over the one screen that was.
 */
function approvedCard(
  row: FileRow,
  file: HomeContext["file"],
  lead: string,
  ending: ReturnType<typeof endingFor>,
): Card {
  if (!row.signed) {
    return {
      // The same words the state one over says, because it is the same
      // missing thing: a signature is not something a status can be about.
      lead: SIGN_LEAD,
      body: UNSIGNED_BODY,
      mode: "you",
      control: { label: READ_AND_SIGN, to: route(row, "review"), weight: "primary" },
      noControl: null,
      pending: false,
      // No position line, unlike the unsigned file still being decided. The
      // four screens are behind this one — the decision is recorded — and a
      // step count over a decided file is the progress bar this page took off
      // the other screens arriving back on it.
      showStep: false,
    };
  }

  const base = { lead, showStep: false };

  // A read that came back with nothing is not a read that decided anything.
  // Either way the card refuses to guess, because the alternative is printing
  // "nothing is waiting on you" over the one control the product has for
  // saying otherwise, on the strength of a read that did not land.
  //
  // The two absences are told apart, though, because they are different
  // promises. `undefined` is a fetch still out: it resolves on its own, so the
  // card waits with an empty action area and no explanation owed. `null` is a
  // file that will not project, and waiting for that is waiting forever — so
  // the card stops pending and offers the file itself, which is the one
  // destination that renders without this read succeeding.
  if (file === undefined) {
    return {
      ...base,
      mode: "us",
      body: APPROVED_BODY,
      control: null,
      noControl: null,
      pending: true,
    };
  }
  if (file === null) {
    return {
      ...base,
      mode: "us",
      body: APPROVED_BODY,
      control: {
        label: OPEN_THIS_FILE,
        to: route(row, screenFor(row)),
        weight: "outline",
      },
      noControl: null,
      pending: false,
    };
  }

  const settled = { pending: false };

  if (file.file.intentToProceedAt != null) {
    return {
      ...base,
      ...settled,
      mode: "us",
      body: ENDING_COPY.intentRecorded,
      control: null,
      noControl: null,
    };
  }

  if (ending === "estimate") {
    return {
      ...base,
      ...settled,
      mode: "you",
      body: ESTIMATE_READY_BODY,
      control: { label: READ_YOUR_ESTIMATE, to: route(row, "review"), weight: "primary" },
      noControl: null,
    };
  }

  return {
    ...base,
    ...settled,
    mode: "us",
    body: ESTIMATE_PENDING_BODY,
    control: null,
    noControl: NOTHING_WAITING,
  };
}

/* ── The two clocks ─────────────────────────────────────────────────────── */

/**
 * The adverse-action date, and it keeps its date however old it is.
 *
 * A thirty-day window that has passed is a fact a declined borrower is
 * entitled to see, and the sentence beside it says why it is not moving. The
 * estimate below is the other way round, because an estimate is a document
 * still ahead of the file and a notice is a debt already owed.
 */
function clockAbove(row: FileRow, standing: LoanFileResponse["applicationState"]): "ecoa" | null {
  if (!row.applicationState || !ECOA_STATES.includes(row.applicationState.status)) return null;
  const ecoa = standing?.clocks.find((c) => c.kind === "ECOA_ADVERSE_ACTION_30D");
  return ecoa ? "ecoa" : null;
}

/**
 * The Loan Estimate date, which is dropped once it is behind us.
 *
 * The clock opens already tolled — there is no way to deliver the document —
 * and nothing ever satisfies or un-tolls it, so a date that has passed was
 * never a deadline running down. On a screen read once a stale date was a
 * wart; on a page built to be read again every week it is a lie, and dropping
 * it loses nothing true while keeping the promise, which is the half that
 * matters.
 */
function clockBelow(
  row: FileRow,
  standing: LoanFileResponse["applicationState"],
): "estimate" | "estimate-lapsed" | null {
  const status = row.applicationState?.status;
  if (!status || !ESTIMATE_AHEAD.includes(status)) return null;
  const estimate = standing?.loanEstimate;
  if (!estimate) return null;
  return Date.parse(estimate.dueAt) >= Date.now() ? "estimate" : "estimate-lapsed";
}
