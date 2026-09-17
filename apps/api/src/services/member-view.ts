/**
 * What one person on a file sees of the others.
 *
 * "Your private identity details and credentials stay private" is the
 * promise the separate-application design makes, and it holds in BOTH
 * directions: a co-borrower does not see the applicant's person, and the
 * applicant does not see the co-borrower's. It is kept here rather than in a
 * screen. Everybody who is not the reader keeps their name, because the
 * reader was told who they are applying with, and whether they have answered
 * their questions, because the applicant's review screen has to be able to
 * say "Theo has answered" without being able to say what. Their date of
 * birth, their number, their contact details, their answers, their
 * demographics and their reports do not come through.
 *
 * `redactOthers` is that rule, and both readers get it. `memberView` is the
 * rest of what a co-borrower does not get: the file's own fields carry the
 * applicant's reports and the decision computed from them, so a member reads
 * their own reports by party in their place, and no decision at all — the
 * derivation log under one carries the applicant's bureau scores and income.
 * A co-borrower's reports reach the engine through the compute boundary
 * item, not through this view.
 */

import type { Address, Borrower, Consent, LoanFile } from "@hm/shared";

const NOWHERE: Address = { line1: "", city: "", state: "", postalCode: "" };

/**
 * Somebody else on the file, as anybody but themselves may see them: a name,
 * a place in the order, and whether they have answered.
 *
 * `declared` is set from the declaration before the declaration is taken
 * away, and it is the only thing the answers leave behind. Everything typed
 * as a required enum or string is blanked to its empty value; the two
 * booleans that could be read as a statement about the person are set to
 * the value that states nothing.
 */
function onlyTheirName(b: Borrower): Borrower {
  return {
    ...b,
    dateOfBirth: "",
    ssn: { last4: "", vaultHandle: "" },
    email: "",
    phone: "",
    currentAddress: NOWHERE,
    identityVerification: null,
    nonBorrowingSpouseName: undefined,
    nonBorrowingSpouseSignatureRequired: false,
    demographics: null,
    firstTimeHomebuyer: null,
    isMilitary: false,
    currentHousing: null,
    monthlyRent: undefined,
    declared: b.declaration !== null,
    declaration: null,
    residences: [],
  };
}

/**
 * A consent row that is not the reader's, with the evidence of WHERE it was
 * signed from taken off. The row itself stays: the applicant's review screen
 * reads it to say who has signed, and a signature a reader cannot see is a
 * co-borrower it thinks has not finished.
 */
function onlyThatTheySigned(c: Consent): Consent {
  return { ...c, ipAddress: "", userAgent: "" };
}

/**
 * The file with everybody but the reader reduced to a name and a status.
 *
 * `you` is the reader's own borrower row, or null for a reader with none —
 * the applicant before screen 2, or a reader of a demo file — in which case
 * everybody on it is somebody else.
 */
export function redactOthers(file: LoanFile, you: string | null): LoanFile {
  return {
    ...file,
    borrowers: file.borrowers.map((b) => (b.id === you ? b : onlyTheirName(b))),
    consents: file.consents.map((c) => (c.borrowerId === you ? c : onlyThatTheySigned(c))),
  };
}

/** What a member's own pulls produced, in place of the applicant's. */
export interface OwnReports {
  readonly credit: LoanFile["credit"];
  readonly assets: LoanFile["assets"];
  readonly payroll: LoanFile["payroll"];
  readonly transcripts: LoanFile["transcripts"];
  readonly links: LoanFile["links"];
}

export function memberView(file: LoanFile, you: string | null, own: OwnReports): LoanFile {
  const mine = file.borrowers.find((b) => b.id === you)?.partyId ?? null;
  const household = redactOthers(file, you);
  return {
    ...household,
    // A member reads only their own consent rows. The applicant's are the
    // applicant's; the applicant's screen is the one that needs everybody's.
    consents: file.consents.filter((c) => c.borrowerId === you),
    // Who else has been named is the household's to know; where the applicant
    // is reaching them is not.
    invitedBorrowers: file.invitedBorrowers.map((b) => (b.id === you ? b : { ...b, email: "" })),
    sanctions: null,
    lienSearch: null,
    // Their own reports, by party — never the applicant's.
    credit: own.credit,
    assets: own.assets,
    payroll: own.payroll,
    transcripts: own.transcripts,
    // Income sources carry no party today; a member reads none rather than
    // the applicant's.
    incomeSources: [],
    employment: file.employment.filter((e) => e.partyId === mine),
    qualifyingIncomeReportedBy: undefined,
    documents: [],
    links: own.links,
    sanctionsScreenClear: null,
    ssnValidatedWithSsa: null,
    // Computed from the applicant's reports, and explained in terms of them.
    decision: null,
    disclosures: [],
  };
}
