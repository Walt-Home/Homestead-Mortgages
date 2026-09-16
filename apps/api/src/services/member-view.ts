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
 * Every report on the file is nulled for a member today, because every
 * report on the file today is the applicant's: nothing yet keys a pull to the
 * party it was pulled on. When a member's own credit and bank reports exist
 * they come back to them here, by party, and nobody else's do.
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

export function memberView(file: LoanFile, you: string | null): LoanFile {
  return {
    ...file,
    borrowers: file.borrowers.map((b) => (b.id === you ? b : onlyTheirName(b))),
    consents: file.consents.filter((c) => c.borrowerId === you),
    sanctions: null,
    lienSearch: null,
    credit: null,
    assets: null,
    payroll: null,
    transcripts: [],
    incomeSources: [],
    employment: [],
    qualifyingIncomeReportedBy: undefined,
    documents: [],
    links: [],
    sanctionsScreenClear: null,
    ssnValidatedWithSsa: null,
  };
}
