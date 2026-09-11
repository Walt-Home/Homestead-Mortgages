/**
 * What the signed-in home page actually puts on the page.
 *
 * The resolver behind it is tested on its own and every rule it holds is held
 * there. These are the claims a pure function cannot make: that the JSX
 * renders what the resolver returned, that a refusal is really absent from the
 * markup rather than merely disallowed by a predicate, and that nothing the
 * ledger is written in — an event name, a reason code, a principal id — leaks
 * out of the record block.
 *
 * It replaces the front door's own suite, which held two live rules: a file
 * with no application says so and wears no pill, and a sample borrower is not
 * offered the one control the server refuses. Both are below, asked of the
 * page that now carries them.
 *
 * Rendered to a string, like every other component test here. There is no
 * jsdom in this repo and the page takes no interaction that the markup cannot
 * answer for; the query cache is seeded rather than fetched, because a static
 * render runs no effects and would otherwise show every case as loading.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { APPLICATION_STATES, TERMINAL, type ApplicationState } from "@hm/shared";
import { HomePage } from "../HomePage.js";
import type { FileRow, LoanFileResponse } from "../../lib/file.js";
import { NO_APPLICATION } from "../../lib/ledger.js";
import { entryFor } from "../../lib/states.js";
import { PERSONA_READ_ONLY } from "../../lib/auth.js";
import {
  CLOSED_FILES,
  FINDING_WHERE_YOU_STAND,
  OTHER_APPLICATIONS,
  QUIET_LABELS,
  RECENT_MOVES,
  SAMPLE_BORROWERS,
  SAMPLE_FILE,
  START_ANOTHER,
  START_A_NEW_APPLICATION,
  START_BODY,
  START_LEAD,
  START_NOW,
  TRY_AGAIN,
  UNREAD_LEAD,
  WITHDRAWN_BODY,
} from "../../lib/home-copy.js";

/** Who the page thinks is looking. Set per render. */
const session = vi.hoisted(() => ({ user: null as { persona: unknown } | null }));

vi.mock("../../lib/auth.js", async (original) => ({
  ...(await original<typeof import("../../lib/auth.js")>()),
  useAuth: () => session,
}));

function file(over: Partial<FileRow> = {}): FileRow {
  return {
    id: "f1",
    stage: "bank",
    isDemo: false,
    mine: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    purpose: "PURCHASE",
    // Strings, because Prisma's Decimal crosses the wire through `toJSON`.
    loanAmount: "450000",
    valueOrPrice: "500000",
    propertyCity: "Austin",
    propertyState: "TX",
    borrowers: [],
    decisions: [],
    applicationState: null,
    signed: false,
    owes: null,
    ...over,
  };
}

/** A row sitting in one state, with the terminal flag the machine gives it. */
const at = (status: string, over: Partial<FileRow> = {}): FileRow =>
  file({
    applicationState: {
      status,
      statusEnteredAt: "2026-09-04T15:00:00.000Z",
      terminal: TERMINAL.includes(status as ApplicationState),
    },
    ...over,
  });

/**
 * The primary file's own read, cast rather than written out.
 *
 * Three fields wide, because three is what this page draws off it: the record,
 * the clocks and the intent latch. Declaring the rest of a very wide wire
 * shape here would make a test about a page into a second copy of the
 * response.
 */
const read = (over: Partial<LoanFileResponse["applicationState"]> = {}): LoanFileResponse =>
  ({
    file: { intentToProceedAt: null, decision: null },
    applicationState: {
      status: "in_underwriting",
      statusEnteredAt: "2026-09-04T15:00:00.000Z",
      terminal: false,
      ledger: [],
      clocks: [],
      loanEstimate: null,
      scenario: null,
      ...over,
    },
  }) as unknown as LoanFileResponse;

const LEDGER = [
  {
    seq: 1,
    from: "draft",
    to: "intake_received",
    event: "intake_completed",
    reasonCode: "six_pieces_received",
    actorKind: "SERVICE",
    occurredAt: "2026-09-03T14:59:00.000Z",
  },
  {
    seq: 2,
    from: "intake_received",
    to: "awaiting_borrower",
    event: "borrower_owes",
    reasonCode: "bank_connection_needed",
    actorKind: "SERVICE",
    occurredAt: "2026-09-04T15:00:00.000Z",
  },
];

/**
 * The page as it renders, with the list already answered.
 *
 * `files: undefined` leaves the cache empty, which is the page before its read
 * lands; `failed` puts the rejection in the cache the way a failed fetch does,
 * through the client's own prefetch rather than by reaching into its state.
 */
async function home(
  options: {
    files?: readonly FileRow[];
    reads?: Record<string, LoanFileResponse>;
    user?: { persona: unknown } | null;
    failed?: boolean;
  } = {},
): Promise<string> {
  session.user = options.user ?? null;
  // `retryOnMount: false` is what makes the failed read visible here. React
  // Query reports an errored query it is about to retry as pending, and a
  // render with no effects never gets to the retry — so without this the
  // failure and the first paint are the same markup and neither could be
  // asserted.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });

  if (options.failed) {
    await client.prefetchQuery({
      queryKey: ["files"],
      queryFn: () => Promise.reject(new Error("the list read failed")),
    });
  } else if (options.files) {
    client.setQueryData(["files"], { files: options.files });
  }
  for (const [id, response] of Object.entries(options.reads ?? {})) {
    client.setQueryData(["file", id], response);
  }

  return decoded(
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <HomePage />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
}

/**
 * The markup with its entities read back as the characters they stand for.
 *
 * React escapes an apostrophe to `&#x27;`, and nearly every sentence on this
 * page has one — so a test comparing against the copy module's own constants
 * would fail on strings that are correct, and the obvious way round it is to
 * assert on half a sentence, which is how a test stops holding the words.
 */
function decoded(markup: string): string {
  return markup
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

describe("the two rules the front door's suite held", () => {
  it("says a file with no application has none, and wears no pill", async () => {
    // A file made before the join has no state, and painting it "You've
    // started" would invent one nobody recorded.
    const markup = await home({ files: [file({ applicationState: null })] });
    expect(markup).toContain(NO_APPLICATION);
    expect(markup).not.toContain("super-pill");
  });

  it("offers a sample borrower no way to start an application", async () => {
    // The server refuses `POST /files` from a persona session, so the control
    // would be the one thing on the page that answers 403. The rule and the
    // JSX can disagree, which is why this reads the markup: drop the gate and
    // every test of the predicate still passes while the button is right
    // there.
    const persona = { persona: { key: "maya_okafor", name: "Maya Okafor" } };
    const files = [at("awaiting_borrower", { isDemo: true })];

    const asPersona = await home({ files, user: persona });
    expect(asPersona).not.toContain(START_ANOTHER);
    expect(asPersona).not.toContain(START_NOW);

    expect(await home({ files, user: { persona: null } })).toContain(START_ANOTHER);
  });

  it("leaves no fragment of the offer where the control was", async () => {
    // The front door's version read "Or pick up the one you started" with
    // nothing above the "Or" for a persona. The offer and the sentence
    // standing in for it are one block, replaced whole — so the card's own
    // control is gone AND the account's refusal is standing where it was.
    const markup = await home({
      files: [at("expired", { isDemo: true })],
      user: { persona: { key: "lena_fischer", name: "Lena Fischer" } },
    });
    expect(markup).not.toContain(START_ANOTHER);
    expect(markup).not.toContain(START_A_NEW_APPLICATION);
    expect(markup).toContain(PERSONA_READ_ONLY);
  });

  it("demotes every other control to a link, and says why once", async () => {
    // Not a permission fix: the destination is a GET a tester may read.
    // "Connect your bank" on somebody else's file asks them to do that
    // borrower's task, and a disabled button that then explains itself is the
    // shape this product already decided against.
    const markup = await home({
      files: [
        at("awaiting_borrower", {
          isDemo: true,
          owes: { event: "borrower_owes", reasonCode: "bank_connection_needed", to: "x" },
        }),
      ],
      user: { persona: { key: "maya_okafor", name: "Maya Okafor" } },
    });
    // The verdict itself does not soften — that is the file's true state.
    expect(markup).toContain("Something needed from you: connect your bank");
    expect(markup).not.toContain("super-btn");
    expect(markup).toContain(QUIET_LABELS.bank);
    expect(markup).toContain(SAMPLE_FILE);
    // Once. The banner in the header already makes the session-wide claim.
    expect([...markup.matchAll(/so it is read-only/g)]).toHaveLength(1);
  });
});

describe("the four shapes this page has", () => {
  it("says one faint line while the list is still coming", async () => {
    const markup = await home();
    expect(markup).toContain(FINDING_WHERE_YOU_STAND);
    expect(markup).not.toContain(START_LEAD);
  });

  it("becomes the start for somebody who has never applied", async () => {
    const markup = await home({ files: [] });
    expect(markup).toContain(START_LEAD);
    expect(markup).toContain(START_BODY);
    expect(markup).toContain(START_NOW);
    // Not the acquisition page. They have already signed in.
    expect(markup).not.toContain("The Greatest Mortgage Ever Offered");
  });

  it("never answers a failed read with the empty state", async () => {
    // "You have no applications" is a claim about a regulated record, and a
    // network error is not evidence for it.
    const markup = await home({ failed: true });
    expect(markup).toContain(UNREAD_LEAD);
    expect(markup).toContain(TRY_AGAIN);
    expect(markup).not.toContain(START_LEAD);
    expect(markup).not.toContain(FINDING_WHERE_YOU_STAND);
  });

  it("leaves the retry alone for a sample borrower", async () => {
    // It refetches a GET, which is the one thing that session may do. The
    // demotion rule is about controls that ask a tester to act as somebody
    // else, and this control is the page's own read.
    const markup = await home({
      failed: true,
      user: { persona: { key: "maya_okafor", name: "Maya Okafor" } },
    });
    expect(markup).toContain(TRY_AGAIN);
  });

  it("names the files only once there is more than one of them", async () => {
    const alone = await home({ files: [at("in_underwriting")] });
    expect(alone).not.toContain("super-eyebrow");
    expect(alone).not.toContain(OTHER_APPLICATIONS);

    const several = await home({
      files: [at("awaiting_borrower"), at("in_underwriting", { id: "f2", signed: true })],
    });
    expect(several).toContain("super-eyebrow");
    expect(several).toContain(OTHER_APPLICATIONS);
    expect(several).toContain("Purchase in Austin, TX");
  });
});

describe("a file that has stopped is the card, not a badge and a shrug", () => {
  it("gives an ended file its own words and its own record", async () => {
    // The design's one fatal contradiction, settled: an ended file is primary
    // when it is the newest thing that happened to this person, and it gets
    // the whole card. A person whose only application was withdrawn reads
    // what happened to it, not "nothing is open right now".
    const markup = await home({
      files: [at("withdrawn")],
      reads: { f1: read({ status: "withdrawn", terminal: true, ledger: LEDGER }) },
    });
    expect(markup).toContain(entryFor("withdrawn")!.heading);
    expect(markup).toContain(WITHDRAWN_BODY);
    expect(markup).toContain(RECENT_MOVES);
    expect(markup).toContain("Application received");
  });

  it("does the same for a decline and for a funded loan", async () => {
    for (const status of ["denied", "funded"]) {
      const markup = await home({
        files: [at(status)],
        reads: { f1: read({ status, terminal: true, ledger: LEDGER }) },
      });
      expect(markup, status).toContain(entryFor(status)!.heading);
      expect(markup, status).toContain(RECENT_MOVES);
    }
  });

  it("puts no step count over a file that has stopped", async () => {
    // A four-step position line over "We can't approve this" is the finding
    // this page was built to fix, arriving on the page built to fix it.
    for (const status of ["withdrawn", "denied", "funded", "expired", "suspended"]) {
      const markup = await home({ files: [at(status)] });
      expect(markup, status).not.toContain("Step ");
    }
    expect(await home({ files: [at("draft")] })).toContain("Step ");
  });
});

describe("what may never reach this page", () => {
  const STATES = APPLICATION_STATES as readonly ApplicationState[];

  it("renders no event name, reason code or state id out of the record", async () => {
    const markup = await home({
      files: [at("in_underwriting", { signed: true })],
      reads: { f1: read({ ledger: LEDGER }) },
    });
    expect(markup).toContain("Application received");
    expect(markup).toContain("Automatic");
    for (const leak of [
      "intake_completed",
      "borrower_owes",
      "six_pieces_received",
      "bank_connection_needed",
      "awaiting_borrower",
      "intake_received",
      "SERVICE",
    ]) {
      expect(markup, leak).not.toContain(leak);
    }
  });

  it("renders no uuid and no requirement id, in any state", async () => {
    for (const status of STATES) {
      const markup = await home({ files: [at(status)] });
      expect(markup, status).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
      expect(markup, status).not.toMatch(/\b(APP|CRD|INC|AST|UW|CLS)-\d{3}\b/);
    }
  });

  it("renders no figure of any kind, in any state", async () => {
    // The rule that retires "never show a number the engine could not
    // compute" by construction rather than by vigilance. The list wire
    // carries a loan amount and a property value; nothing here reads them.
    for (const status of STATES) {
      const markup = await home({ files: [at(status)] });
      expect(markup, status).not.toContain("$");
      expect(markup, status).not.toMatch(/\d{1,3},\d{3}/);
      expect(markup, status).not.toContain("450000");
    }
  });

  it("renders no sentence out of the state catalog", async () => {
    // The catalog's bodies are worked examples written for the gallery and
    // carry invented figures. The card reads the heading, the pill and the
    // tone off it and nothing else.
    for (const status of STATES) {
      const markup = await home({ files: [at(status)] });
      const entry = entryFor(status)!;
      expect(markup, status).not.toContain(entry.body);
      expect(markup, status).not.toContain(entry.meaning);
    }
  });
});

describe("the other files, as rows", () => {
  it("puts the ended ones under their own heading, and each file once", async () => {
    // Mixing a withdrawn file into the live list is how one word came to mean
    // five different situations. Three files, so the live section exists to be
    // put in the wrong place.
    const markup = await home({
      files: [
        at("awaiting_borrower", { id: "card" }),
        at("in_processing", { id: "alive", purpose: "RATE_TERM_REFINANCE" }),
        at("withdrawn", {
          id: "gone",
          purpose: "CASH_OUT_REFINANCE",
          propertyCity: null,
          propertyState: null,
        }),
      ],
    });

    const closed = markup.indexOf(CLOSED_FILES);
    expect(markup.indexOf(OTHER_APPLICATIONS)).toBeGreaterThan(-1);
    expect(closed).toBeGreaterThan(markup.indexOf(OTHER_APPLICATIONS));
    expect(markup.indexOf("/f/alive/")).toBeLessThan(closed);
    expect(markup.indexOf("/f/gone/")).toBeGreaterThan(closed);

    // The primary is removed from every group below it, and no row is in two.
    for (const id of ["card", "alive", "gone"]) {
      expect([...markup.matchAll(new RegExp(`/f/${id}/`, "g"))], id).toHaveLength(1);
    }
  });

  it("offers a sample borrower's row the destination rather than the task", async () => {
    // Every one of these is a GET a tester may read. Naming it "Open" on
    // somebody else's file asks them to take that borrower's next step.
    const markup = await home({
      files: [
        at("awaiting_borrower", { id: "mine" }),
        at("draft", { id: "sample", isDemo: true, mine: false }),
      ],
    });
    expect(markup).toContain(SAMPLE_BORROWERS);
    expect(markup).toContain("See this borrower's");
  });
});
