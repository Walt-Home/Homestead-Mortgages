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
import { BRITISH, DAY_FIRST, DELIVERY_TIME, PROMISES, REQ_ID, VENDOR_CLAIM } from "@hm/shared";
import { endingFor, proposedTerms } from "../endings.js";
import {
  ADVERSE_COPY,
  CO_BORROWER_COPY,
  COUNTEROFFER_COPY,
  ENDING_COPY,
  REFERRED_COPY,
  SIGNING_COPY,
  SIGN_LEAD,
} from "../outcomes.js";

/** A name to render the co-borrower lines with, since two of them take one. */
const CO_BORROWER = "Theo Okafor";

/** Every string a borrower can read out of the catalog. */
const COPY = [
  ...Object.values(REFERRED_COPY),
  ...Object.values(ADVERSE_COPY),
  ...Object.values(COUNTEROFFER_COPY),
  ...Object.values(ENDING_COPY),
  ...Object.values(SIGNING_COPY),
  // Two of these are functions of a name, so they are rendered rather than
  // walked: a line that only exists once a name is in it is still a line a
  // borrower reads, and skipping it is how the rules stop seeing half a module.
  ...Object.values(CO_BORROWER_COPY).map((line) =>
    typeof line === "function" ? line(CO_BORROWER) : line,
  ),
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
  // The last ending has no ending after it, and the pre-signature view below
  // renders the same catalog — so the divider that opens it ends the slice
  // too. Without that, an assertion about what the final ending shows would
  // pass on a line that only ever renders before the signature, which is the
  // exact confusion these blocks exist to tell apart.
  const next = [rest.indexOf('if (ending === "'), rest.indexOf("── Before signing")].filter(
    (at) => at !== -1,
  );
  return rest.slice(0, next.length === 0 ? undefined : Math.min(...next));
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

  it("claims nothing about a vendor that depends on which adapter answered", () => {
    // The panel makes specific claims about what a federal form authorizes, in
    // a repo whose IRS adapter is a fixture, which is the class this rule is
    // for. Nothing in the catalog trips it today and this is what keeps that
    // true — the mode-derived sentences live in `disclosures.ts`, and a
    // sentence that has to be a function of the deployment does not belong in
    // a catalog that is settled once.
    for (const line of COPY) expect(line, line).not.toMatch(VENDOR_CLAIM);
    expect("the rest goes straight to the credit bureaus").toMatch(VENDOR_CLAIM);
  });

  it("renders nothing internal, in American English", () => {
    for (const line of COPY) {
      expect(line, line).not.toMatch(REQ_ID);
      expect(line, line).not.toMatch(BRITISH);
      expect(line, line).not.toMatch(DAY_FIRST);
    }
  });
});

/**
 * The signing panel, on a file with a second person on it.
 *
 * IRS Form 4506-C names a single taxpayer, so one signature on this screen
 * authorizes one person's tax records. While a file held one borrower the
 * panel could say "your tax records" and be right by accident; with two it is
 * the one phrase that reads as the household's and is not.
 *
 * The panel block is read out of the source for the same reason the endings
 * are: it only renders once the borrower has pressed Continue to sign, and
 * there is no DOM here to press it in.
 */
describe("what the signature covers on a joint file", () => {
  const PANEL = REVIEW_SOURCE.slice(
    REVIEW_SOURCE.indexOf("SIGNING_COPY.panelTitle"),
    REVIEW_SOURCE.indexOf("SIGNING_COPY.signButton"),
  );

  it("qualifies whose tax records the 4506-C reaches", () => {
    expect(SIGNING_COPY.panelBody).toContain("your own tax records");
    // The sentence this replaced. Unqualified, it is the household's records
    // on a joint application and one person's on every other file.
    expect(SIGNING_COPY.panelBody).not.toContain("request your tax records");
  });

  it("qualifies whose answers the signature attests to", () => {
    // The other half of the same carve-out, one register over. "The answers
    // above" is two blocks on a joint file, and the second is headed with
    // somebody else's name — so an unqualified attestation asks the signer to
    // swear that a block reading "X has not answered these yet" is true and
    // complete.
    expect(SIGNING_COPY.panelTerms).toContain("your own answers above");
    expect(SIGNING_COPY.panelTerms).not.toContain("says the answers above");
    expect(SIGNING_COPY.lead).toContain("your own are true and complete");
    expect(SIGNING_COPY.lead).not.toContain("says they are true");
  });

  it("names the other person, and says the form is one taxpayer's", () => {
    const line = CO_BORROWER_COPY.signatureIsYours(CO_BORROWER);
    expect(line).toContain(CO_BORROWER);
    expect(line).toContain("4506-C names one taxpayer");
  });

  it("says nothing of theirs is requested, and promises nothing about who will ask", () => {
    const line = CO_BORROWER_COPY.theirOwnSignature(CO_BORROWER);
    expect(line).toContain(`no tax records about ${CO_BORROWER} are requested`);
    // There is no mailer, no invite and no screen for a co-borrower to sign
    // on. A line saying somebody will ask them is the promise this rule is
    // for, and it would be an easy one to write here.
    expect(line).not.toMatch(PROMISES);
  });

  it("puts both of them in the panel that asks for the signature", () => {
    expect(PANEL.length).toBeGreaterThan(0);
    expect(PANEL).toContain("CO_BORROWER_COPY.signatureIsYours(");
    expect(PANEL).toContain("CO_BORROWER_COPY.theirOwnSignature(");
  });
});

/**
 * The same fact after the signature, which is where it was being lost.
 *
 * `endingFor` returns an ending the moment `signed` is true, so the panel's
 * two co-borrower lines stop rendering at exactly the point they start
 * mattering — and what replaces them says there is nothing left to do, or that
 * what remains is ours rather than theirs. On a joint file whose co-borrower
 * has signed nothing both are false. Nothing else raises it either: INC-008 is
 * per borrower and its source is the signature, which `branchesFor()` excludes
 * from the work a borrower is sent to do, so there is no card and no other
 * sentence anywhere.
 */
describe("what an ending says about a co-borrower who has not signed", () => {
  it("names the person and what of theirs is unsigned", () => {
    const line = CO_BORROWER_COPY.awaitingTheirSignature(CO_BORROWER);
    expect(line).toContain(CO_BORROWER);
    expect(line).toContain("4506-C");
    expect(line).toContain(`Nothing about ${CO_BORROWER} has been requested`);
  });

  it("promises nobody will ask them, because nothing here would", () => {
    const line = CO_BORROWER_COPY.awaitingTheirSignature(CO_BORROWER);
    expect(line).not.toMatch(PROMISES);
    expect(line).not.toMatch(DELIVERY_TIME);
  });

  it("renders in the two endings that say nothing is needed", () => {
    // "That is everything we need" and "Nothing is needed from you right now"
    // are both true of the applicant and neither is true of the file.
    for (const ending of ["ours", "referred"]) {
      expect(blockFor(ending), ending).toContain("stillToSign");
    }
    expect(REVIEW_SOURCE).toContain("CO_BORROWER_COPY.awaitingTheirSignature(");
    // And it is one list, read once: two endings computing the same set is the
    // second one that would drift.
    expect(REVIEW_SOURCE.split("awaitingTheirSignature(")).toHaveLength(2);
  });

  it("asks whose signature it is per person rather than per file", () => {
    // `hasConsent` with a borrower id. A file-level `some()` would call a
    // co-borrower signed on the applicant's own 4506-C.
    expect(REVIEW_SOURCE).toContain('hasConsent(file, "form_4506c", who.id)');
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
