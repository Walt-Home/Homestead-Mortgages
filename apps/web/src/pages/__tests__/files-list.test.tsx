/**
 * Which file the front door offers to pick up, and what each row says.
 *
 * `stage` only ever moves forward and stops at `complete`, so it cannot say that
 * an application ended: a withdrawn file sitting at the bank screen reads as
 * unfinished, and the front door used to offer "pick up the one you started"
 * over an application the borrower had stopped. The application state is what
 * knows that, and where there is one it is the whole answer — including for a
 * file whose stage says `complete` while the application is still live. The
 * stage is the fallback, for a file made before applications existed.
 *
 * The row itself is rendered rather than reasoned about. It writes the same
 * "no application" sentence the header does, and a list that grew a pill for a
 * legacy file would be inventing a state nobody recorded — which no test of
 * `resumable` alone can see.
 */

import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { canStart, FilesPage, resumable, screenFor, Standing, type FileRow } from "../FilesPage.js";
import { NO_APPLICATION } from "../../lib/ledger.js";

/** Who the front door thinks is looking. Set per render. */
const session = vi.hoisted(() => ({ user: null as { persona: unknown } | null }));

vi.mock("../../lib/auth.js", () => ({ useAuth: () => session }));

/** The page as it actually renders, so the guard in the JSX is the thing read. */
function frontDoor(user: { persona: unknown } | null): string {
  session.user = user;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <FilesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function file(over: Partial<FileRow>): FileRow {
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
    ...over,
  };
}

const at = (status: string, terminal: boolean) => ({
  status,
  statusEnteredAt: "2026-09-04T15:00:00.000Z",
  terminal,
});

describe("the resume link", () => {
  it("offers a file that is still going", () => {
    const row = file({ applicationState: at("awaiting_borrower", false) });
    expect(resumable([row])).toBe(row);
  });

  it("never offers one whose application ended", () => {
    // Withdrawn, at the bank screen. The stage alone would offer it.
    const ended = file({ stage: "bank", applicationState: at("withdrawn", true) });
    expect(resumable([ended])).toBeUndefined();
  });

  it("skips the ended one and offers the next", () => {
    const ended = file({ id: "ended", applicationState: at("denied", true) });
    const live = file({ id: "live", applicationState: at("draft", false) });
    expect(resumable([ended, live])?.id).toBe("live");
  });

  it("falls back to the stage for a file with no application", () => {
    expect(resumable([file({ applicationState: null })])?.id).toBe("f1");
    expect(resumable([file({ stage: "complete", applicationState: null })])).toBeUndefined();
  });

  it("still offers one whose flow is done but whose application is live", () => {
    // Walking to the end of the four screens is not the end of the request.
    // A submitted file sits in `in_underwriting` and is waiting on US, and the
    // stage — which stops at `complete` and never moves again — is the wrong
    // thing to ask once there is an application that knows better.
    const row = file({ stage: "complete", applicationState: at("in_underwriting", false) });
    expect(resumable([row])).toBe(row);
  });

  it("never offers one whose application ended, whatever the stage says", () => {
    // The other direction of the same rule: the application is the answer, so
    // a terminal one is never offered even where the stage reads unfinished.
    expect(
      resumable([file({ stage: "complete", applicationState: at("funded", true) })]),
    ).toBeUndefined();
    expect(
      resumable([file({ stage: "property_loan", applicationState: at("expired", true) })]),
    ).toBeUndefined();
  });
});

describe("where a row links", () => {
  it("sends a live file to the screen its stage reached", () => {
    expect(
      screenFor(file({ stage: "bank", applicationState: at("awaiting_borrower", false) })),
    ).toBe("bank");
    expect(screenFor(file({ stage: "identity", applicationState: null }))).toBe("identity");
  });

  it("does not link at a page the shell will bounce", () => {
    // Withdrawn at the bank screen: the stage still says "bank", the shell
    // redirects to review the moment it opens, and the row was pointing at
    // the redirect. Three of the eight seeded files behaved this way.
    expect(screenFor(file({ stage: "bank", applicationState: at("withdrawn", true) }))).toBe(
      "review",
    );
    for (const status of ["canceled", "denied", "funded", "expired"]) {
      expect(
        screenFor(file({ stage: "property_loan", applicationState: at(status, true) })),
        status,
      ).toBe("review");
    }
  });

  it("sends a held file there too, though it has not ended", () => {
    // `suspended` is not terminal, so `resumable` still offers this file —
    // which makes it the one row where the two expressions disagreed on a
    // file the front door actually links to.
    expect(screenFor(file({ stage: "identity", applicationState: at("suspended", false) }))).toBe(
      "review",
    );
  });

  it("is what the page actually calls, in both places", () => {
    // The rule and the JSX can disagree: the two links used to compute the
    // stage map inline, and both cases above would still pass.
    const src = readFileSync(new URL("../FilesPage.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/to=\{`\/f\/\$\{[^}]+\}\/\$\{STAGE_TO_SCREEN/);
    expect([...src.matchAll(/screenFor\(/g)]).toHaveLength(3);
  });
});

describe("the start button", () => {
  it("is not offered to a sample borrower", () => {
    // The server refuses `POST /files` from a persona session, so the button
    // would be the one control on the page that answers 403.
    expect(canStart({ persona: { key: "maya_okafor", name: "Maya Okafor" } })).toBe(false);
  });

  it("is offered to a real person, and to nobody in particular", () => {
    expect(canStart({ persona: null })).toBe(true);
    expect(canStart(null)).toBe(true);
    expect(canStart(undefined)).toBe(true);
  });

  it("is actually left off the page, not merely disallowed by the rule", () => {
    // The rule and the page can disagree: drop `canStart(user) &&` from the
    // JSX and both cases above still pass while the button is right there.
    expect(frontDoor({ persona: { key: "maya_okafor", name: "Maya Okafor" } })).not.toContain(
      "super-cta",
    );
    expect(frontDoor({ persona: null })).toContain("super-cta");
  });
});

describe("a row in the list", () => {
  it("says a legacy file has no application, and wears no pill", () => {
    const markup = renderToStaticMarkup(<Standing state={null} />);
    expect(markup).toContain(NO_APPLICATION);
    expect(markup).not.toContain("super-pill");
  });

  it("wears the state's own word, with the date it entered it", () => {
    const markup = renderToStaticMarkup(<Standing state={at("awaiting_borrower", false)} />);
    expect(markup).toContain("Needs you");
    expect(markup).toContain("super-pill");
    expect(markup).toContain("since September 4, 2026");
    expect(markup).not.toContain(NO_APPLICATION);
  });

  it("renders no state id and no requirement id", () => {
    const markup = renderToStaticMarkup(<Standing state={at("adverse_action_pending", true)} />);
    expect(markup).not.toContain("adverse_action_pending");
    expect(markup).not.toMatch(/\b(APP|CRD|INC|AST|UW|CLS)-\d{3}\b/);
  });
});
