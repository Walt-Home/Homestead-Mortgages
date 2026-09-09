/**
 * The endings: which one renders, and what it is allowed to say.
 *
 * Both halves were bugs. The selection asked only about the ratios, so a
 * `refer` — which computes its ratios perfectly well and blocks only on the
 * pricing tests — rendered "Your Loan Estimate", and so did a counteroffer, a
 * decline and a funded loan. The copy made three promises the product cannot
 * keep: an email, a person being in touch, and three business days.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BRITISH, DAY_FIRST, DELIVERY_TIME, PROMISES, REQ_ID } from "@hm/shared";
import { endingFor, proposedTerms } from "../endings.js";
import {
  ADVERSE_COPY,
  COUNTEROFFER_COPY,
  ENDING_COPY,
  REFERRED_COPY,
  SIGN_LEAD,
} from "../outcomes.js";

/** Every string a borrower can read out of the catalog. */
const COPY = [
  ...Object.values(REFERRED_COPY),
  ...Object.values(ADVERSE_COPY),
  ...Object.values(COUNTEROFFER_COPY),
  ...Object.values(ENDING_COPY),
  SIGN_LEAD,
];

/** The ratios a fully connected file has, whatever the engine concluded. */
const RATIOS = { housingPitia: 3_987, dtiBack: 40 };

const REVIEW_SOURCE = readFileSync(new URL("../../pages/ReviewPage.tsx", import.meta.url), "utf8");

/**
 * What one ending renders, read out of the source.
 *
 * ReviewPage needs a router, a query client and a fetched assessment, and
 * there is no DOM in this repo to give them — so the claims about what an
 * ending puts on the screen are made against the block that renders it, from
 * its own guard to the next one's.
 */
function blockFor(ending: string): string {
  const start = REVIEW_SOURCE.indexOf(`if (ending === "${ending}"`);
  expect(start, ending).toBeGreaterThan(-1);
  const rest = REVIEW_SOURCE.slice(start + 1);
  const next = rest.indexOf('if (ending === "');
  return rest.slice(0, next === -1 ? undefined : next);
}

describe("the referred ending says what is actually missing", () => {
  it("names it as ours rather than theirs", () => {
    expect(REFERRED_COPY.headline).toBe("We're reviewing this ourselves.");
    expect(REFERRED_COPY.body).toContain("ours to work out rather than yours");
  });
});

describe("no ending promises something the system cannot do", () => {
  it("names no channel and no person who will make contact", () => {
    for (const line of COPY) expect(line, line).not.toMatch(PROMISES);
  });

  it("promises no delivery time", () => {
    for (const line of COPY) expect(line, line).not.toMatch(DELIVERY_TIME);
  });

  it("catches the three that were actually here", () => {
    // A regex that matches nothing passes for the wrong reason. These are the
    // sentences this screen carried until this commit.
    expect("Sent to your email, and here it is.").toMatch(PROMISES);
    expect("we will be in touch about next steps").toMatch(PROMISES);
    expect("your Loan Estimate will follow within three business days").toMatch(DELIVERY_TIME);
  });

  it("renders nothing internal, in American English", () => {
    for (const line of COPY) {
      expect(line, line).not.toMatch(REQ_ID);
      expect(line, line).not.toMatch(BRITISH);
      expect(line, line).not.toMatch(DAY_FIRST);
    }
  });
});

describe("which ending", () => {
  const ending = (over: Parameters<typeof endingFor>[0]) => endingFor(over);

  it("puts a referral before an estimate, whatever the ratios say", () => {
    // The bug, stated: these ratios computed, and before this the screen took
    // that as permission to render a Loan Estimate.
    expect(ending({ signed: true, outcome: "referred", ratios: RATIOS, branches: [] })).toBe(
      "referred",
    );
  });

  it("gives a decline its own ending rather than a figures block", () => {
    // A file with no application at all has nothing to check the word against,
    // so the outcome is all there is.
    expect(ending({ signed: true, outcome: "denied", ratios: RATIOS, branches: [] })).toBe(
      "adverse",
    );
    expect(
      ending({
        signed: true,
        outcome: "denied",
        state: { status: "adverse_action_pending", terminal: false },
        ratios: RATIOS,
        branches: [],
      }),
    ).toBe("adverse");
  });

  it("keeps the reasons on the screen once the decline is final", () => {
    // `denied` is itself a terminal state, so reading it as "an application
    // that has ended" rendered the pill and nothing else — and the reasons the
    // engine recorded never reached a screen from the one state the written
    // notice is actually owed from.
    expect(
      ending({
        signed: true,
        outcome: "denied",
        state: { status: "denied", terminal: true },
        ratios: RATIOS,
        branches: [],
      }),
    ).toBe("adverse");
  });

  it("gives a counteroffer its own ending", () => {
    expect(ending({ signed: true, outcome: "counteroffer", ratios: RATIOS, branches: [] })).toBe(
      "counteroffer",
    );
    expect(
      ending({
        signed: true,
        outcome: "counteroffer",
        state: { status: "counteroffer_outstanding", terminal: false },
        ratios: RATIOS,
        branches: [],
      }),
    ).toBe("counteroffer");
  });

  it("says nothing was decided when the machine never took the edge", () => {
    // The reachable break. `POST /decision` records the computation whether or
    // not there is an edge for it: from `awaiting_borrower` neither a decline
    // nor a counteroffer is legal, the ledger writes `decision_not_applied`,
    // and the pill still reads "Needs you". Reading the word alone put "Not
    // that loan — but here's one we can do" under it, for an application
    // nobody had counter-offered.
    const owing = { status: "awaiting_borrower", terminal: false };
    for (const outcome of ["denied", "counteroffer"] as const) {
      expect(ending({ signed: true, outcome, state: owing, ratios: RATIOS, branches: [] })).toBe(
        "ours",
      );
      expect(
        ending({
          signed: true,
          outcome,
          state: owing,
          ratios: RATIOS,
          branches: [{ path: "payroll" }],
        }),
      ).toBe("branches");
    }
  });

  it("renders a file that has ended as its state, signed or not", () => {
    // Lena withdrew at the bank screen and never signed. Inviting her to sign,
    // or offering her a Loan Estimate, are both the screen ignoring the pill
    // beside it.
    const withdrawn = { status: "withdrawn", terminal: true };
    expect(ending({ signed: false, outcome: null, state: withdrawn, branches: [] })).toBe("state");
    expect(
      ending({ signed: true, outcome: "denied", state: withdrawn, ratios: RATIOS, branches: [] }),
    ).toBe("state");
  });

  it("renders a funded loan as its state, not as an estimate", () => {
    expect(
      ending({
        signed: true,
        outcome: "clear_to_close",
        state: { status: "funded", terminal: true },
        ratios: RATIOS,
        branches: [],
      }),
    ).toBe("state");
  });

  it("still offers the estimate to an approval that is still pre-approval", () => {
    // Both approval words reach it. `clear_to_close` lands the application on
    // the state `approved`, and that borrower is owed the estimate and the
    // control that records their intent to proceed — which lives inside this
    // ending and nowhere else. Rendering the best outcome as a pill and a Done
    // button left APP-007 with no control on any screen.
    expect(
      ending({
        signed: true,
        outcome: "approved_with_conditions",
        state: { status: "conditionally_approved", terminal: false },
        ratios: RATIOS,
        branches: [],
      }),
    ).toBe("estimate");
    expect(
      ending({
        signed: true,
        outcome: "clear_to_close",
        state: { status: "approved", terminal: false },
        ratios: RATIOS,
        branches: [],
      }),
    ).toBe("estimate");
  });

  it("stops offering it once the file is past the approval", () => {
    // The trim is exactly one state wide: everything after `approved` still
    // reads as its state, because there the estimate is behind the file.
    for (const status of ["clear_to_close", "closing", "rescission_pending"]) {
      expect(
        ending({
          signed: true,
          outcome: "clear_to_close",
          state: { status, terminal: false },
          ratios: RATIOS,
          branches: [],
        }),
        status,
      ).toBe("state");
    }
  });

  it("renders a held file as its state rather than asking it to sign", () => {
    // A screening hold stops the file on somebody else's answer. The signature
    // would be refused server-side anyway; asking for it is the screen saying
    // something the ledger does not.
    expect(
      ending({
        signed: false,
        outcome: null,
        state: { status: "suspended", terminal: false },
        branches: [],
      }),
    ).toBe("state");
  });

  it("puts work the borrower can still finish ahead of the estimate", () => {
    expect(
      ending({
        signed: true,
        outcome: "approved_with_conditions",
        ratios: RATIOS,
        branches: [{ path: "payroll" }],
      }),
    ).toBe("branches");
  });

  it("puts that work ahead of a referral too", () => {
    // Every real-flow file on staging is `referred`, and a file with work
    // outstanding is already in `awaiting_borrower` — so the header pill above
    // this ending reads "Needs you". The referred ending says "Nothing is
    // needed from you right now" and renders no branch cards, which would
    // leave a borrower told to act with nothing to act on. A referral has
    // decided nothing; work the borrower can still finish outranks it.
    expect(
      ending({
        signed: true,
        outcome: "referred",
        state: { status: "awaiting_borrower", terminal: false },
        ratios: RATIOS,
        branches: [{ path: "payroll" }],
      }),
    ).toBe("branches");
  });

  it("keeps a decline and a counteroffer ahead of that work", () => {
    // The other side of the same rule: a decided word is a reason to stop
    // asking. A borrower we have declined must not be sent for a paystub.
    for (const outcome of ["denied", "counteroffer"] as const) {
      expect(
        ending({ signed: true, outcome, ratios: RATIOS, branches: [{ path: "payroll" }] }),
      ).toBe(outcome === "denied" ? "adverse" : "counteroffer");
    }
  });

  it("falls back to ours when there is nothing left for them", () => {
    expect(ending({ signed: true, outcome: null, ratios: null, branches: [] })).toBe("ours");
  });

  it("renders no ending at all before the signature", () => {
    // Otherwise the pre-signature view is unreachable and nothing can be
    // signed: every unsigned file already has a decision, computed on the
    // bank screen.
    expect(
      ending({
        signed: false,
        outcome: "referred",
        state: { status: "in_underwriting", terminal: false },
        ratios: RATIOS,
        branches: [],
      }),
    ).toBeNull();
  });
});

describe("what the counteroffer ending is allowed to print", () => {
  const asked = { seq: 1, origin: "BORROWER", loanAmount: 636_350, downPayment: 13_650 };

  it("drops the terms the borrower asked for", () => {
    // The reachable failure: a 97.9% LTV purchase is the one decided word a
    // real-flow file reaches today, and its active scenario is screen 1's own
    // loan. Printing it under "here's one we can do" hands the borrower their
    // own numbers back as our alternative.
    expect(proposedTerms(asked)).toBeNull();
  });

  it("prints terms somebody on our side proposed", () => {
    // Not a hypothetical branch: the persona seed proposes a COUNTEROFFER
    // scenario at seq 2, which retires the borrower's own, and that is the
    // file a tester opens to see this ending with figures under it.
    for (const origin of ["COUNTEROFFER", "REPRICING", "STAFF", "AI_SUGGESTED"]) {
      const proposed = { ...asked, origin, seq: 2 };
      expect(proposedTerms(proposed), origin).toBe(proposed);
    }
  });

  it("has nothing to print for a file with no scenario at all", () => {
    expect(proposedTerms(null)).toBeNull();
    expect(proposedTerms(undefined)).toBeNull();
  });

  it("is what the review screen actually calls", () => {
    // Read out of the source: ReviewPage needs a router and a query client,
    // and there is no DOM here to give them. The claim is that the guard is on
    // the path the ending takes, not merely available beside it.
    const block = blockFor("counteroffer");
    expect(block).toContain("proposedTerms(standing?.scenario)");
    expect(block).not.toContain("standing?.scenario ?? null");
  });

  it("announces the terms only where the terms are", () => {
    // The body renders on every counteroffer, including the ones whose
    // alternative has not been proposed yet and whose only scenario is
    // therefore the borrower's own — so a body carrying "Here are the terms we
    // can do instead." printed it directly above "The alternative is being
    // worked out".
    expect(COUNTEROFFER_COPY.body).not.toContain("terms");
    const block = blockFor("counteroffer");
    const terms = block.indexOf("{scenario ? (");
    expect(terms).toBeGreaterThan(-1);
    expect(block.slice(0, terms)).not.toContain("termsLead");
    expect(block.slice(terms)).toContain("COUNTEROFFER_COPY.termsLead");
  });
});

/**
 * The reasons, wherever the copy above them says they are owed.
 *
 * The decline has rendered them from the start. The counteroffer's body says
 * "you are still owed the reasons we couldn't do it your way" and the engine
 * records them on a counteroffer for exactly that sentence — a counteroffer is
 * an adverse action under Reg B — and the ending printed none of it.
 */
describe("an ending that says the borrower is owed reasons shows them", () => {
  it.each([
    ["adverse", ADVERSE_COPY],
    ["counteroffer", COUNTEROFFER_COPY],
  ])("%s", (ending, copy) => {
    // From the copy side first, so the pairing cannot be satisfied by an
    // ending that quietly stopped promising anything.
    expect(copy.body).toContain("reasons");
    const block = blockFor(ending);
    expect(block).toContain("decision?.adverseActionReasons");
    expect(block).toContain("reasonsLead");
    expect(block).toContain("noReasons");
  });
});
