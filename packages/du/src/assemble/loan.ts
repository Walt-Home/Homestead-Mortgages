/**
 * The subject loan: its terms, its amortization, and how many borrowers are on
 * it.
 *
 * `LoanRoleType="SubjectLoan"` is an attribute and it is load-bearing. It is
 * the whole of what separates the loan being applied for from one the borrower
 * already owes — nine `RelatedLoan`s across eight samples share this element
 * name — which is why it is in the modeled path and why the related loan, which
 * nothing here holds, is in the inventory rather than silently absent.
 *
 * **No `LOAN_IDENTIFIER`.** `LenderLoan` is DU-Conditional on one existing and
 * Required only for EarlyCheck, so a conventional submission that carries none
 * is legal. Minting one means deciding whether the institution we submit under
 * allocates a loan-number range, which is a contractual question and not a
 * format; the identifier and the submitting party that goes with it land
 * together, later, or not at all.
 */

import type { LienPosition, LoanPurpose } from "@hm/db";
import { compact, container, leaf, type DuNode } from "../document.js";
import { renderAmount, renderCount, renderPercent } from "../values.js";
import type { LoadedApplication } from "./load.js";

/**
 * Three enums our tables spell one way and MISMO spells another, each
 * exhaustive and each throwing rather than defaulting.
 *
 * A cash-out refinance and a rate-and-term refinance are one `LoanPurposeType`
 * to DU; which one it is lives in the `REFINANCE` container, which this model
 * does not yet emit.
 */
const LOAN_PURPOSE: Readonly<Record<LoanPurpose, string>> = {
  PURCHASE: "Purchase",
  RATE_TERM_REFINANCE: "Refinance",
  CASH_OUT_REFINANCE: "Refinance",
};

const LIEN_PRIORITY: Readonly<Record<LienPosition, string>> = {
  FIRST: "FirstLien",
  SECOND: "SecondLien",
  // A subordinate HELOC is a second lien on the wire; the product difference is
  // carried by the HELOC container and not by the priority.
  SUBORDINATE_HELOC: "SecondLien",
};

const AMORTIZATION_TYPE: Readonly<Record<string, string>> = {
  fixed: "Fixed",
  arm: "AdjustableRate",
};

function amortizationType(amortization: string | null): string | null {
  if (amortization === null) return null;
  const mapped = AMORTIZATION_TYPE[amortization];
  if (!mapped) {
    throw new Error(
      `${JSON.stringify(amortization)} is not an amortization this emitter can name. Add it to ` +
        "AMORTIZATION_TYPE; do not guess a MISMO value.",
    );
  }
  return mapped;
}

export function buildLoans(application: LoadedApplication): DuNode | null {
  const file = application.loanFile;
  const scenario = application.scenarios[0];
  const termMonths = scenario?.termMonths ?? file.termMonths;

  const amortization = container("AMORTIZATION", [
    container(
      "AMORTIZATION_RULE",
      compact([
        leaf("AmortizationType", amortizationType(file.amortization)),
        termMonths === null || termMonths === undefined
          ? null
          : leaf("LoanAmortizationPeriodCount", renderCount(termMonths)),
        termMonths === null || termMonths === undefined
          ? null
          : leaf("LoanAmortizationPeriodType", "Month"),
      ]),
    ),
  ]);

  // Counted from `application_parties` and not from `borrowers`: the edges are
  // what the document's ROLE elements are emitted from, so this is a count of
  // what the file actually contains.
  const loanDetail = container("LOAN_DETAIL", [
    application.parties.length === 0
      ? null
      : leaf("BorrowerCount", renderCount(application.parties.length)),
  ]);

  const terms = container(
    "TERMS_OF_LOAN",
    compact([
      scenario ? leaf("BaseLoanAmount", renderAmount(scenario.loanAmountCents)) : null,
      scenario ? leaf("LienPriorityType", LIEN_PRIORITY[scenario.lienPosition]) : null,
      file.purpose ? leaf("LoanPurposeType", LOAN_PURPOSE[file.purpose]) : null,
      scenario?.noteRateBps == null
        ? null
        : leaf("NoteRatePercent", renderPercent(scenario.noteRateBps)),
    ]),
  );

  const loan = container("LOAN", [amortization, loanDetail, terms], {
    LoanRoleType: "SubjectLoan",
  });

  return container("LOANS", [loan]);
}
