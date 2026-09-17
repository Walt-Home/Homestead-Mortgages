/**
 * What a co-borrower sees of a file that is not theirs.
 *
 * "Your private identity details and credentials stay private" is the
 * promise the separate-application design makes, and it is kept here rather
 * than in a screen: the file a member reads back is the household's — the
 * property, the terms, the decision, who is on it — with everybody else's
 * person removed from it. Their name stays, because the member was told who
 * they are applying with; their date of birth, their number, their contact
 * details, their answers and their reports do not.
 *
 * A member's own reports come back to them, by party — their credit, their
 * bank, their payroll, their transcripts and their links — and nobody else's
 * do. The file's own fields carry the applicant's, which is what the engine
 * reads; a co-borrower's reports reach the engine through the compute
 * boundary item, not through this view.
 */

import type { Address, Borrower, LoanFile } from "@hm/shared";

const NOWHERE: Address = { line1: "", city: "", state: "", postalCode: "" };

/** Somebody else on the file, as a member may see them: a name and a place. */
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
    demographics: null,
    currentHousing: null,
    monthlyRent: undefined,
    declaration: null,
    residences: [],
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
  return {
    ...file,
    borrowers: file.borrowers.map((b) => (b.id === you ? b : onlyTheirName(b))),
    consents: file.consents.filter((c) => c.borrowerId === you),
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
  };
}
