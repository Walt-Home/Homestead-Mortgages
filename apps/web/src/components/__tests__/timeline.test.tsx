/**
 * What the timeline and the standing line actually put on the page.
 *
 * The rule these hold is a rule about the DOM, not about a helper: the ledger
 * is written for an examiner — event names, reason codes, principal ids,
 * requirement ids in `causedBy` — and none of it may reach a borrower. A
 * component that renders `{row.event}` by mistake passes every test of
 * `wordsFor`, so these render the real components and read the markup.
 *
 * Rendered to a string rather than to a DOM. There is no jsdom in this repo
 * and neither component takes an interaction; the markup is the whole claim.
 */

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApplicationStanding } from "../ApplicationStanding.js";
import { ApplicationTimeline } from "../ApplicationTimeline.js";
import type { ApplicationStandingView } from "../../lib/file.js";
import { NO_APPLICATION } from "../../lib/ledger.js";
import { SIGN_LEAD } from "../../lib/outcomes.js";

const STANDING: ApplicationStandingView = {
  id: "8f1a3e3e-1f5e-4c1d-9d6a-0b6a2c0c9f11",
  status: "awaiting_borrower",
  statusEnteredAt: "2026-09-04T15:00:00.000Z",
  terminal: false,
  ledger: [
    {
      seq: 1,
      from: "draft",
      to: "intake_received",
      event: "intake_completed",
      reasonCode: "six_pieces_received",
      actorKind: "SERVICE",
      occurredAt: "2026-09-04T14:59:00.000Z",
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
  ],
  clocks: [
    {
      kind: "TRID_LE_DELIVERY",
      statuteCitation: "12 CFR 1026.19(e)(1)(iii)",
      startedAt: "2026-09-04T14:59:00.000Z",
      dueAt: "2026-09-10T03:59:59.999Z",
      tolledFrom: "2026-09-04T14:59:00.000Z",
      tollingReason: "no_delivery_channel_configured",
      tolledUntil: null,
      satisfiedAt: null,
      breachedAt: null,
    },
  ],
  loanEstimate: {
    dueAt: "2026-09-10T03:59:59.999Z",
    tolled: true,
    tollingReason: "no_delivery_channel_configured",
  },
  // The terms the file was received on. Neither component renders them — the
  // counteroffer ending on the review screen is their only reader — and that
  // is the claim: no figure a borrower did not ask for leaks into the header.
  scenario: {
    seq: 1,
    origin: "BORROWER",
    loanAmount: 332_000,
    downPayment: 83_000,
    valueEstimate: 415_000,
  },
};

const timeline = renderToStaticMarkup(<ApplicationTimeline standing={STANDING} />);

describe("the timeline speaks to the borrower", () => {
  it("says what happened, in words", () => {
    expect(timeline).toContain("Application received");
    expect(timeline).toContain("Something needed from you: connect your bank");
  });

  it("carries the pill for each state it passed through", () => {
    expect(timeline).toContain("Received");
    expect(timeline).toContain("Needs you");
    expect(timeline).toContain("super-pill");
  });

  it("names who caused each move", () => {
    expect(timeline).toContain("Automatic");
  });

  it("renders no event name, reason code or state id", () => {
    for (const leak of [
      "intake_completed",
      "borrower_owes",
      "six_pieces_received",
      "bank_connection_needed",
      "awaiting_borrower",
      "intake_received",
      "TRID_LE_DELIVERY",
      "no_delivery_channel_configured",
    ]) {
      expect(timeline, leak).not.toContain(leak);
    }
  });

  it("renders no uuid and no requirement id", () => {
    expect(timeline).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
    expect(timeline).not.toMatch(/\b(APP|CRD|INC|AST|UW|CLS)-\d{3}\b/);
  });

  it("gives the Loan Estimate date and says why it is not running", () => {
    // Either half alone is a lie: the date without the toll promises a
    // delivery nothing here can make, the toll without the date hides a
    // deadline a person is entitled to know about.
    expect(timeline).toContain("Your Loan Estimate is due by September 9, 2026.");
    expect(timeline).toContain("on hold");
  });

  it("renders nothing at all for a file with no application", () => {
    expect(renderToStaticMarkup(<ApplicationTimeline standing={null} />)).toBe("");
  });

  it("drops the Loan Estimate date once there is nothing left to decide", () => {
    // The clock row survives the end of an application — it is a regulated
    // record and nothing deletes it — so this paragraph rendered on a funded
    // loan, a withdrawn file and a denial alike: a document promised by a
    // date, under a pill that had already said the request was over.
    for (const status of ["funded", "withdrawn", "denied", "canceled", "expired"]) {
      const markup = renderToStaticMarkup(
        <ApplicationTimeline standing={{ ...STANDING, status, terminal: true }} />,
      );
      expect(markup, status).not.toContain("Loan Estimate");
      // The history itself is exactly what such a file is here to read.
      expect(markup, status).toContain("Application received");
    }
  });

  it("drops it on a file that is held, and on one past deciding", () => {
    for (const status of ["suspended", "closing", "rescission_pending"]) {
      const markup = renderToStaticMarkup(
        <ApplicationTimeline standing={{ ...STANDING, status, terminal: false }} />,
      );
      expect(markup, status).not.toContain("Loan Estimate");
    }
  });

  it("still gives it to a file that is still being decided", () => {
    // Including the one state that sounds like it belongs with the others:
    // an approved file is owed the estimate, and the deadline for it is the
    // whole point of the clock.
    for (const status of ["awaiting_borrower", "in_underwriting", "approved"]) {
      const markup = renderToStaticMarkup(
        <ApplicationTimeline standing={{ ...STANDING, status, terminal: false }} />,
      );
      expect(markup, status).toContain("Your Loan Estimate is due by September 9, 2026.");
    }
  });
});

describe("the standing line", () => {
  it("names the specific thing outstanding, from the ledger", () => {
    // The state's own heading is a worked example written for the gallery.
    // The newest `borrower_owes` row says which thing is actually owed.
    const markup = renderToStaticMarkup(<ApplicationStanding standing={STANDING} />);
    expect(markup).toContain("Needs you");
    expect(markup).toContain("Something needed from you: connect your bank");
    expect(markup).toContain("since September 4, 2026");
  });

  it("uses the state's own words everywhere else", () => {
    const markup = renderToStaticMarkup(
      <ApplicationStanding standing={{ ...STANDING, status: "in_underwriting" }} />,
    );
    expect(markup).toContain("In review");
    expect(markup).toContain("Being decided");
  });

  it("lets one screen say the line the state cannot", () => {
    // The state the override exists for. A file reaching the signature has
    // already had its decision posted from the bank screen, so it is
    // `in_underwriting` and its heading is "Being decided" — which denies the
    // signature the button below it is asking for, and which no state can fix
    // because e-sign is outside the obligations the flow tracks. The pill and
    // the date stay the state's; only the heading changes.
    const markup = renderToStaticMarkup(
      <ApplicationStanding
        standing={{ ...STANDING, status: "in_underwriting" }}
        headline={SIGN_LEAD}
      />,
    );
    expect(markup).toContain(SIGN_LEAD);
    expect(markup).not.toContain("Being decided");
    expect(markup).toContain("In review");
    expect(markup).toContain("since September 4, 2026");
  });

  it("says so, with no pill, when there is no application on record", () => {
    const markup = renderToStaticMarkup(<ApplicationStanding standing={null} />);
    expect(markup).toContain(NO_APPLICATION);
    expect(markup).not.toContain("super-pill");
  });

  it("says nothing at all until the file has been read", () => {
    // Undefined is "not read yet". Rendering the sentence there told every
    // cold load of a file page that a regulated record does not exist, before
    // anybody had looked for it — and left it there for good on a read that
    // failed with anything but a 404.
    expect(renderToStaticMarkup(<ApplicationStanding standing={undefined} />)).toBe("");
  });
});

describe("where the review screen puts them", () => {
  /**
   * Read out of the source, because the four endings cannot be rendered here.
   *
   * ReviewPage needs a router, a query client and a fetched assessment, and
   * there is no DOM in this repo to give them. The claim is about ORDER — the
   * standing and the history come before the ending, not after its Done button
   * — and the order is a fact about the file. A borrower reading "Your Loan
   * Estimate" at the bottom of a long card has scrolled the shell header away,
   * and what the application is actually doing has to still be on the screen.
   */
  it("puts the standing and the history above every ending", () => {
    const src = readFileSync(new URL("../../pages/ReviewPage.tsx", import.meta.url), "utf8");
    // Everything after the shared header is defined; the spinner above it is
    // not an ending and shows no state.
    const body = src.slice(src.indexOf("const header = ("));
    const headers = [...body.matchAll(/\{(?:header|signingHeader)\}/g)].map((m) => m.index ?? -1);
    const headings = [...body.matchAll(/<h1[\s>]/g)].map((m) => m.index ?? -1);

    // Numbers rather than ranges, so an ending added without its standing is a
    // failing test. Seven headings — referred, adverse, counteroffer, estimate,
    // branches, ours, and the pre-signature view — and one header more than
    // that, because the ending for a file that has ended IS the header: the
    // pill, the state's heading and the history, with no heading of its own.
    expect(headings).toHaveLength(7);
    expect(headers).toHaveLength(8);

    let previous = -1;
    for (const [i, heading] of headings.entries()) {
      const between = headers.filter((h) => h > previous && h < heading);
      expect(between.length, `ending ${i + 1}`).toBeGreaterThan(0);
      previous = heading;
    }
  });

  /**
   * Read out of the source for the same reason, and about the same three-value
   * distinction the component above is built on.
   *
   * `undefined` is "nobody has looked yet" and `null` is "we looked and there
   * is none". Optional-chaining the unread file into `?? null` throws the
   * first away, and then every cold load of this screen tells the borrower
   * there is no application on record before anything looked for one — for
   * good, on a read that fails with anything but a 404.
   */
  it("does not tell a borrower there is no application before the file is read", () => {
    const src = readFileSync(new URL("../../pages/ReviewPage.tsx", import.meta.url), "utf8");
    // One binding now, read by the standing, the history and the ending rule,
    // so the three cannot disagree about what an empty history means.
    const line = src.split("\n").find((l) => l.includes("const standing ="));
    expect(line).toBeDefined();
    // The collapse, and the thing that has to survive it.
    expect(line).not.toMatch(/data\?\.applicationState\s*\?\?\s*null/);
    expect(line).toContain("undefined");

    const start = src.indexOf("const header = (");
    const header = src.slice(start, src.indexOf(");", start));
    expect(header).toContain("<ApplicationStanding standing={standing} />");

    // The one view that overrides the state's words still shows the same pill,
    // the same date and the same history — only the line beside them differs.
    const signStart = src.indexOf("const signingHeader = (");
    const signing = src.slice(signStart, src.indexOf(");", signStart));
    expect(signing).toContain("<ApplicationStanding standing={standing} headline={SIGN_LEAD} />");
    expect(signing).toContain("<ApplicationTimeline standing={standing} />");
    expect(header).toContain("<ApplicationTimeline standing={standing} />");
  });
});
