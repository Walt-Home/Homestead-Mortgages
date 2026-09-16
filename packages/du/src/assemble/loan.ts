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
 * **The `LOAN_IDENTIFIER` is a placeholder and says so in the value.**
 * `LenderLoan` is DU-Conditional on one existing, so a submission carrying
 * none is legal — and a submission is not assembled at all until somebody has
 * decided which institution it goes under, which is what `institution.ts`
 * holds and refuses outside development. Nothing here mints a number: the one
 * written is whatever the caller was given, and today that is the placeholder.
 *
 * The verifications hang off this container rather than off a borrower, which
 * is the shape DU chose and not one this model picked: `DU:UNDERWRITING_VERIFICATION`
 * sits in the subject loan's extension and reaches the borrower by an arc.
 * Which reports stand is decided in `verifications.ts`; this writes what that
 * hands it.
 */

import type { LienPosition, LoanPurpose } from "@hm/db";
import { compact, container, leaf, type DuNode } from "../document.js";
import type { DuInstitution } from "../institution.js";
import { renderAmount, renderCount, renderIndicator, renderPercent } from "../values.js";
import type { LoadedApplication } from "./load.js";

/**
 * Two enums our tables spell one way and MISMO spells another. Both are
 * exhaustive over the column's own type, so a value added to either column is a
 * compile error here rather than a MISMO value invented at runtime.
 *
 * A cash-out refinance and a rate-and-term refinance are one `LoanPurposeType`
 * to DU; which one it is lives in the `REFINANCE` container, which this model
 * does not yet emit.
 *
 * `AmortizationType` used to be a third, and it needed a runtime throw because
 * `loan_files.amortization` was a free-text column holding the word `'fixed'`.
 * The product row holds the DU enumeration itself, so there is nothing left to
 * translate and nothing left to guess.
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

export function buildLoans(
  application: LoadedApplication,
  verifications: DuNode | null,
  institution: DuInstitution,
): DuNode | null {
  const file = application.loanFile;
  const scenario = application.scenarios[0];
  const termMonths = scenario?.termMonths ?? file.termMonths;

  // Read off the product for the reason the four indicators below are: a loan
  // that pays interest only or balloons is not one that amortizes fully, and
  // two rows cannot disagree about one loan when there is only one row.
  const product = file.product;
  const amortization = container("AMORTIZATION", [
    container(
      "AMORTIZATION_RULE",
      compact([
        product ? leaf("AmortizationType", product.amortization) : null,
        termMonths === null || termMonths === undefined
          ? null
          : leaf("LoanAmortizationPeriodCount", renderCount(termMonths)),
        termMonths === null || termMonths === undefined
          ? null
          : leaf("LoanAmortizationPeriodType", "Month"),
      ]),
    ),
  ]);

  // The borrower count is counted from `application_parties` and not from
  // `borrowers`: the edges are what the document's ROLE elements are emitted
  // from, so this is a count of what the file actually contains.
  //
  // The four indicators beside it are read off the PRODUCT. None of them is an
  // answer a borrower gives — whether a loan builds, balloons, pays interest
  // only or amortizes negatively is true of `CONF-30-FIXED` itself — so a file
  // quoted against no product carries none of them and the gate refuses it,
  // which is the whole reason the product became a row.
  const loanDetail = container(
    "LOAN_DETAIL",
    compact([
      product ? leaf("BalloonIndicator", renderIndicator(product.balloon)) : null,
      application.parties.length === 0
        ? null
        : leaf("BorrowerCount", renderCount(application.parties.length)),
      product ? leaf("ConstructionLoanIndicator", renderIndicator(product.constructionLoan)) : null,
      product ? leaf("InterestOnlyIndicator", renderIndicator(product.interestOnly)) : null,
      product
        ? leaf("NegativeAmortizationIndicator", renderIndicator(product.negativeAmortization))
        : null,
      product
        ? leaf("PrepaymentPenaltyIndicator", renderIndicator(product.prepaymentPenalty))
        : null,
    ]),
  );

  const terms = container(
    "TERMS_OF_LOAN",
    compact([
      scenario ? leaf("BaseLoanAmount", renderAmount(scenario.loanAmountCents)) : null,
      scenario ? leaf("LienPriorityType", LIEN_PRIORITY[scenario.lienPosition]) : null,
      file.purpose ? leaf("LoanPurposeType", LOAN_PURPOSE[file.purpose]) : null,
      // Conventional, FHA, VA or USDA. A family of product and not a borrower's
      // circumstance, which is why it reads the same row the indicators do and
      // not the two enum columns on `du_liabilities` that spell a mortgage the
      // borrower already owes.
      product ? leaf("MortgageType", product.mortgageType) : null,
      scenario?.noteRateBps == null
        ? null
        : leaf("NoteRatePercent", renderPercent(scenario.noteRateBps)),
    ]),
  );

  // The type is written beside the number rather than assumed from it: the
  // same element carries the lender's number at fifteen characters, an agency
  // case number at thirty and a universal loan identifier at forty-five, and
  // which one it is decides what DU reads it as.
  const identifiers = container("LOAN_IDENTIFIERS", [
    container("LOAN_IDENTIFIER", [
      leaf("LoanIdentifier", institution.lenderLoanIdentifier),
      leaf("LoanIdentifierType", "LenderLoan"),
    ]),
  ]);

  const loan = container("LOAN", [amortization, loanDetail, identifiers, terms, verifications], {
    LoanRoleType: "SubjectLoan",
  });

  return container("LOANS", [loan]);
}
