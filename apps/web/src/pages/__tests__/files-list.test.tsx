/**
 * Which file the front door offers to pick up, and what each row says.
 *
 * `stage` only ever moves forward and stops at COMPLETE, so it cannot say that
 * an application ended: a withdrawn file sitting at the bank screen reads as
 * unfinished, and the front door used to offer "pick up the one you started"
 * over an application the borrower had stopped. The application state is what
 * knows that, and where there is one it is the whole answer — including for a
 * file whose stage says COMPLETE while the application is still live. The
 * stage is the fallback, for a file made before applications existed.
 *
 * The row itself is rendered rather than reasoned about. It writes the same
 * "no application" sentence the header does, and a list that grew a pill for a
 * legacy file would be inventing a state nobody recorded — which no test of
 * `resumable` alone can see.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { resumable, Standing, type FileRow } from "../FilesPage.js";
import { NO_APPLICATION } from "../../lib/ledger.js";

function file(over: Partial<FileRow>): FileRow {
  return {
    id: "f1",
    stage: "BANK",
    isDemo: false,
    mine: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    propertyCity: "Austin",
    propertyState: "TX",
    borrowers: [],
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
    const ended = file({ stage: "BANK", applicationState: at("withdrawn", true) });
    expect(resumable([ended])).toBeUndefined();
  });

  it("skips the ended one and offers the next", () => {
    const ended = file({ id: "ended", applicationState: at("denied", true) });
    const live = file({ id: "live", applicationState: at("draft", false) });
    expect(resumable([ended, live])?.id).toBe("live");
  });

  it("falls back to the stage for a file with no application", () => {
    expect(resumable([file({ applicationState: null })])?.id).toBe("f1");
    expect(resumable([file({ stage: "COMPLETE", applicationState: null })])).toBeUndefined();
  });

  it("still offers one whose flow is done but whose application is live", () => {
    // Walking to the end of the four screens is not the end of the request.
    // A submitted file sits in `in_underwriting` and is waiting on US, and the
    // stage — which stops at COMPLETE and never moves again — is the wrong
    // thing to ask once there is an application that knows better.
    const row = file({ stage: "COMPLETE", applicationState: at("in_underwriting", false) });
    expect(resumable([row])).toBe(row);
  });

  it("never offers one whose application ended, whatever the stage says", () => {
    // The other direction of the same rule: the application is the answer, so
    // a terminal one is never offered even where the stage reads unfinished.
    expect(
      resumable([file({ stage: "COMPLETE", applicationState: at("funded", true) })]),
    ).toBeUndefined();
    expect(
      resumable([file({ stage: "PROPERTY_LOAN", applicationState: at("expired", true) })]),
    ).toBeUndefined();
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
