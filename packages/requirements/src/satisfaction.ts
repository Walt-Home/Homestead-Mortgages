/**
 * Is a requirement satisfied, and if not, what exactly is missing?
 *
 * One evaluator per requirement id. `evaluators.test.ts` fails if the registry
 * gains a requirement this file has no evaluator for, so a new row in Drew's
 * sheet cannot land as a silently-passing requirement.
 *
 * Evaluators answer only about evidence that is PRESENT. None of them decide
 * whether a requirement APPLIES — that is `conditions.ts`, and keeping the two
 * apart is what lets the product say "not needed for you" and "needed, not yet
 * done" in different words.
 */

import { RESIDENCE_HISTORY_MONTHS, type Borrower, type LoanFile } from "@hm/shared";
import type { Requirement } from "./types.js";

/** Evidence that it is done. */
type Met = { readonly status: "satisfied"; readonly evidence: string };
/** Not done, and what is missing — in the words a person would use. */
type Unmet = { readonly status: "unsatisfied"; readonly missing: string };

export type Satisfaction =
  | Met
  | Unmet
  /** Cannot be judged yet — an upstream requirement has not produced its data. */
  | { readonly status: "blocked"; readonly waitingFor: string };

type Evaluator = (file: LoanFile) => Satisfaction;

const ok = (evidence: string): Met => ({ status: "satisfied", evidence });
const no = (missing: string): Unmet => ({ status: "unsatisfied", missing });
const wait = (waitingFor: string): Satisfaction => ({ status: "blocked", waitingFor });

const check = (condition: boolean, evidence: string, missing: string): Met | Unmet =>
  condition ? ok(evidence) : no(missing);

/**
 * The same question, put to every borrower on the file.
 *
 * The URLA, Reg B and the FCRA owe these to each applicant, so one person
 * answering does not settle them: satisfied only once everybody's answer is
 * in, unsatisfied naming whoever is still missing. Reading `borrowers[0]` here
 * reported a file finished while a co-borrower had answered nothing — the
 * quiet version of the same mistake that let one person's signature authorize
 * a pull about another.
 *
 * On a file with one borrower the words are exactly the ones this produced
 * before. A second person is what puts a name in front of them, and nothing
 * else does, so no existing file's count moves for this.
 */
function ofEveryBorrower(ask: (b: Borrower, f: LoanFile) => Met | Unmet): Evaluator {
  return (f) => {
    if (f.borrowers.length === 0) return no("no borrower");
    const named = (b: Borrower, text: string) =>
      f.borrowers.length === 1 ? text : `${b.firstName} ${b.lastName}: ${text}`;
    const answers = f.borrowers.map((b) => ({ b, answer: ask(b, f) }));
    const unmet = answers.filter(
      (a): a is { b: Borrower; answer: Unmet } => a.answer.status === "unsatisfied",
    );
    if (unmet.length) return no(unmet.map((a) => named(a.b, a.answer.missing)).join("; "));
    return ok(answers.map((a) => named(a.b, (a.answer as Met).evidence)).join("; "));
  };
}

/**
 * This borrower's own live consent.
 *
 * `tokenFor` reads one party's `authorizations` rows and no other's, so a file
 * carrying only the first borrower's authorization can retrieve nothing about
 * the second. A file-level `some()` answered "signed borrower authorization on
 * record" for that same file — the engine and the only minter giving opposite
 * answers about the requirement whose failure severity is a regulatory
 * violation, with nothing on the outstanding list ever asking the second
 * person to sign.
 */
function consentOf(file: LoanFile, borrower: Borrower, kind: string): boolean {
  return file.consents.some((c) => c.kind === kind && c.borrowerId === borrower.id && !c.revokedAt);
}

function hasDisclosure(file: LoanFile, kind: string): boolean {
  return file.disclosures.some((d) => d.kind === kind);
}

function hasDocumentFor(file: LoanFile, requirementId: string): boolean {
  return file.documents.some((d) => d.satisfiesRequirementId === requirementId);
}

function derivation(file: LoanFile, requirementId: string) {
  return file.decision?.derivations.find((d) => d.requirementId === requirementId);
}

/** A derived requirement is satisfied when its derivation ran unblocked. */
function derived(requirementId: string, label: string): Evaluator {
  return (file) => {
    if (!file.decision) return wait("the decision has not been computed");
    const d = derivation(file, requirementId);
    if (!d) return no(`${label} has not been computed`);
    if (d.blockedBy?.length) return wait(d.blockedBy.join(", "));
    return ok(d.formula);
  };
}

export const EVALUATORS: Record<string, Evaluator> = {
  /* ── Screen 1 · Property & loan ──────────────────────────────────────── */

  "APP-002": (f) =>
    f.application
      ? ok(`six pieces received ${f.application.receivedAt}`)
      : no("one of the six pieces is still missing — the LE clock has not started"),

  "APP-003": (f) =>
    !f.loan || !f.property
      ? no("loan purpose, occupancy and property type not yet declared")
      : ok(`${f.loan.purpose} / ${f.property.occupancy} / ${f.property.propertyType}`),

  "APP-004": (f) =>
    !f.property
      ? no("no subject property")
      : check(
          f.property.deliverableAddressVerified,
          "address matched to public record",
          "address not matched to a deliverable public record",
        ),

  "APP-021": ofEveryBorrower((b) =>
    b.firstTimeHomebuyer === null
      ? no("first-time homebuyer status not determined")
      : ok(`fthb_flag = ${b.firstTimeHomebuyer}`),
  ),

  "AST-012": (f) =>
    !f.loan
      ? no("no loan terms")
      : check(
          Boolean(f.loan.cashOutPurpose) && f.loan.cashToBorrower !== undefined,
          "cash-out proceeds purpose on record",
          "cash-out proceeds purpose not documented",
        ),

  /* ── Screen 2 · Identity ─────────────────────────────────────────────── */

  "APP-001": ofEveryBorrower((b) => {
    const missing = [
      b.firstName && b.lastName ? null : "name",
      b.dateOfBirth ? null : "date of birth",
      b.ssn.vaultHandle ? null : "SSN",
      b.currentAddress.line1 ? null : "physical address",
    ].filter((x): x is string => x !== null);
    if (missing.length) return no(missing.join(", "));
    // The sheet's evidence column is "Government photo ID; SSN; DOB; physical
    // address". Typed fields are the last three; only a document check is the
    // first, and the requirement is that the borrower IS who they claim rather
    // than that they typed a plausible name.
    if (b.identityVerification?.status !== "verified") {
      return no("identity not yet verified against a government ID");
    }
    return ok(`identity verified ${b.identityVerification.verifiedAt?.slice(0, 10)}`);
  }),

  "APP-005": ofEveryBorrower((b, f) =>
    check(
      consentOf(f, b, "verification_authorization"),
      "signed borrower authorization on record",
      "borrower has not authorized verification — no connector may be called",
    ),
  ),

  "APP-011": ofEveryBorrower((b) => {
    if (!b.demographics) return no("demographic information not requested");
    // Reg B is about the ASKING. All three must have been put to the borrower;
    // an empty answer means the question was never shown, which is not the
    // same as a decline and must not be recorded as one.
    const d = b.demographics;
    const answered = (v: readonly string[] | string) =>
      v === "declined" || (Array.isArray(v) ? v.length > 0 : v.length > 0);
    const missing = [
      answered(d.ethnicity) ? null : "ethnicity",
      answered(d.race) ? null : "race",
      answered(d.sex) ? null : "sex",
    ].filter((x): x is string => x !== null);
    return check(
      missing.length === 0,
      "URLA Section 7 requested; answers or declines recorded",
      `${missing.join(", ")} not requested`,
    );
  }),

  "APP-012": ofEveryBorrower((b, f) =>
    check(consentOf(f, b, "econsent"), "E-SIGN consent recorded", "eConsent not obtained"),
  ),

  "APP-015": ofEveryBorrower((b) =>
    b.maritalStatus === "married" && !b.nonBorrowingSpouseName
      ? no("non-borrowing spouse not identified")
      : ok("marital status and spouse handling recorded"),
  ),

  "APP-017": ofEveryBorrower((b) =>
    b.preferredLanguage
      ? ok(`preferred language ${b.preferredLanguage}`)
      : no("language preference not captured"),
  ),

  "CRD-010": (f) =>
    f.sanctionsScreenClear === null
      ? no("OFAC / SDN screening has not run")
      : check(f.sanctionsScreenClear, "no sanctions hit", "sanctions screening returned a hit"),

  /* ── Screen 3 · Credit ───────────────────────────────────────────────── */

  "APP-018": (f) =>
    !f.loan
      ? wait("loan terms")
      : check(
          f.loan.existingLoan !== undefined,
          "existing servicer and loan identified",
          "existing loan and servicer not identified",
        ),

  "AST-011": (f) => {
    if (!f.assets) return wait("the bank connection");
    const undocumented = f.assets.borrowedFunds.filter((b) => !b.agreementDocumentId);
    return check(
      undocumented.length === 0,
      "borrowed funds secured and documented",
      `${undocumented.length} borrowed-funds item(s) without a loan agreement`,
    );
  },

  "CRD-001": (f) =>
    !f.credit
      ? no("credit has not been pulled")
      : check(
          f.credit.scores.length === 3,
          `tri-merge ${f.credit.reportId} dated ${f.credit.reportDate}`,
          `only ${f.credit.scores.length} of 3 bureau scores returned`,
        ),

  "CRD-002": derived("CRD-002", "representative FICO"),

  "CRD-003": (f) => {
    if (!f.credit) return wait("the credit pull");
    const unreconciled = f.credit.tradelines.filter(
      (t) => t.monthlyPayment === 0 && !t.exclusionReasonCode,
    );
    return check(
      unreconciled.length === 0,
      "every tradeline is in DTI or excluded with a reason",
      `${unreconciled.length} tradeline(s) neither counted nor excluded`,
    );
  },

  "CRD-004": (f) =>
    !f.credit
      ? wait("the credit pull")
      : ok(`${f.credit.publicRecords.length} public record(s) reviewed`),

  "CRD-005": (f) => {
    if (!f.credit) return wait("the credit pull");
    const mortgage = f.credit.tradelines.find((t) => t.type === "mortgage");
    if (mortgage && mortgage.paymentHistory.length >= 12) {
      return ok(`${mortgage.paymentHistory.length} months of mortgage rating`);
    }
    const rentMonths = f.assets?.identifiedRentPayments ?? 0;
    return check(
      rentMonths >= 12,
      `${rentMonths} months of rent history`,
      "no 12-month housing payment history from a mortgage rating or the bank report",
    );
  },

  "CRD-007": derived("CRD-007", "foreclosure / short sale / DIL seasoning"),

  "CRD-014": (f) => {
    if (!f.credit) return wait("the credit pull");
    const disputed = f.credit.tradelines.filter((t) => t.disputed);
    return check(
      disputed.length === 0,
      "no disputed tradelines remain",
      `${disputed.length} disputed tradeline(s) unresolved`,
    );
  },

  "CRD-016": derived("CRD-016", "revolving utilization"),

  /* ── The declarations screen ─────────────────────────────────────────── */

  /*
   * Six evaluators, and not one of them reads a connector.
   *
   * Section 5 is the borrower's own statement. The review screen used to
   * build five of these answers out of a credit report, a lien search, an
   * asset report and a county record — which means an unrun pull asserted "no bankruptcy" from
   * having looked nowhere, above a signature. So `b.declaration` is the only
   * input here, and `null` means unasked rather than answered no.
   *
   * Per borrower, because the answers are. The file carried one copy of
   * Section 5 and it was borrower 1's, so a co-borrower who declared a
   * bankruptcy was judged by somebody else's "no" — under a review screen
   * showing his own answer back to him, above the signature that attests to
   * it.
   *
   * Three of the six are asked only of the people they are about, and that
   * gate is HERE rather than in `conditions.ts`: applicability is a fact about
   * the file, and one person declaring a bankruptcy makes APP-024 apply to it.
   * Who on the file then owes chapters is a different question, and answering
   * it file-wide would tell the other borrower they had failed to document a
   * bankruptcy they never declared.
   *
   * The route refuses a partial submit, so a stored declaration carries all of
   * 5a or none of it. These still name their own fields rather than reporting
   * "the declaration exists": the refusal can only be trusted while it is
   * where it is, and a second writer would be found by this rather than by a
   * borrower signing a blank answer.
   */

  "APP-022": ofEveryBorrower((b) => {
    const d = b.declaration;
    if (!d) return no("the Section 5a declarations have not been asked");
    const missing = [
      d.intentToOccupy ? null : "intent to occupy",
      d.intentToOccupy === "Yes" && d.homeownerPastThreeYears == null
        ? "whether they owned a home in the past three years"
        : null,
      d.undisclosedBorrowedFunds && d.undisclosedBorrowedFundsAmount == null
        ? "the amount of the borrowed funds"
        : null,
    ].filter((x): x is string => x !== null);
    return missing.length
      ? no(missing.join(", "))
      : ok(`section 5a answered, occupancy ${d.intentToOccupy.toLowerCase()}`);
  }),

  "APP-023": ofEveryBorrower((b) => {
    const d = b.declaration;
    if (!d) return no("the Section 5b declarations have not been asked");
    // Every one of the seven is a NOT NULL boolean, so a stored row has them
    // all. What this says is that they were ANSWERED, which is the fact the
    // 1003 needs — and the count is how it reports it without turning any
    // borrower's yes into something the evidence column never asked for.
    const yes = [
      d.undisclosedComakerOfNote,
      d.outstandingJudgments,
      d.presentlyDelinquent,
      d.priorPropertyDeedInLieuConveyed,
      d.priorPropertyShortSaleCompleted,
      d.priorPropertyForeclosureCompleted,
      d.bankruptcy,
    ].filter(Boolean).length;
    return ok(yes === 0 ? "section 5b answered, all no" : `section 5b answered, ${yes} yes`);
  }),

  "APP-024": ofEveryBorrower((b) => {
    const d = b.declaration;
    if (!d) return no("no bankruptcy has been declared or denied");
    // Chapters are owed by whoever declared one. `declared_bankruptcy` is true
    // of the file as soon as a single person says yes, so without this the
    // other borrower would be reported as having failed to name the chapters
    // of a bankruptcy they told us they never had.
    if (!d.bankruptcy) return ok("no bankruptcy declared");
    return check(
      d.bankruptcyChapters.length > 0,
      d.bankruptcyChapters.join(", "),
      "a bankruptcy was declared with no chapter named",
    );
  }),

  "APP-025": ofEveryBorrower((b) => {
    const d = b.declaration;
    if (!d) return no("the prior-property questions have not been asked");
    // Asked of whoever owned, for the same reason APP-024 asks chapters of
    // whoever declared a bankruptcy: one owner makes the condition true of the
    // file, and does not give the other borrower a prior property.
    if (d.homeownerPastThreeYears !== "Yes") return ok("no home owned in the past three years");
    // Title is optional in DU and unbound by any conditionality, so it is
    // reported when it is there and never demanded.
    return check(
      d.priorPropertyUsage != null,
      d.priorPropertyTitle
        ? `${d.priorPropertyUsage}, held ${d.priorPropertyTitle}`
        : `${d.priorPropertyUsage}`,
      "how the prior property was used has not been stated",
    );
  }),

  "APP-026": ofEveryBorrower((b) => {
    const current = b.residences.find((r) => r.residencyType === "Current");
    if (!current) return no("where they live now has not been stated");
    // The one-directional rule the table carries: an amount needs a Rent
    // basis, and a Rent basis does not need an amount.
    return ok(`${current.basis}, ${current.durationMonths} month(s)`);
  }),

  "APP-027": ofEveryBorrower((b) => {
    const current = b.residences.find((r) => r.residencyType === "Current");
    if (!current) return no("where they live now has not been stated");
    // Two years of history is the ask, so somebody who has been at one address
    // for the whole window owes no second one. One borrower moving recently is
    // what makes the condition true of the file; it does not put the other
    // borrower's settled address in question.
    if (current.durationMonths >= RESIDENCE_HISTORY_MONTHS) {
      return ok(`${current.durationMonths} month(s) at the current address`);
    }
    const prior = b.residences.find((r) => r.residencyType === "Prior");
    if (!prior) return no("the previous address has not been stated");
    const missing = [
      prior.addressLineText ? null : "street",
      prior.cityName ? null : "city",
      prior.stateCode ? null : "state",
      prior.postalCode ? null : "postal code",
    ].filter((x): x is string => x !== null);
    return missing.length
      ? no(`the previous address is missing its ${missing.join(", ")}`)
      : ok(`${prior.addressLineText}, ${prior.cityName} ${prior.stateCode}`);
  }),

  /**
   * The only row on this screen that is not asked of every borrower.
   *
   * One property, one estate, one answer — two people buying one house do not
   * hold it on two different tenures — so this reads the file rather than
   * going through `ofEveryBorrower`, and a co-borrower's save restates the
   * same fact rather than owing one of their own.
   */
  "APP-028": (f) => {
    const estate = f.property?.estateType;
    if (!estate) return no("whether the land comes with the house has not been stated");
    // A ground lease is reported in the words the answer was given in. What
    // happens to a leasehold file afterwards — the expiration date DU wants,
    // the term the agencies require to outlast the loan — is not this row's
    // question and is nowhere in this model yet.
    return ok(estate === "FeeSimple" ? "fee simple" : "leasehold");
  },

  /* ── Screen 5 · Bank ─────────────────────────────────────────────────── */

  "AST-001": (f) => {
    if (!f.assets) return no("bank not connected");
    if (f.assets.accounts.length === 0) return no("no deposit accounts returned");
    const thin = f.assets.accounts.filter((a) => a.balanceHistory.length < 2);
    return check(
      thin.length === 0,
      `${f.assets.accounts.length} account(s) with two months of history`,
      `${thin.length} account(s) with under two months of history`,
    );
  },

  "AST-005": (f) => {
    if (!f.assets) return wait("the bank connection");
    const monthlyIncome = f.incomeSources.reduce((s, i) => s + i.monthlyAmount, 0);
    if (monthlyIncome === 0) return wait("qualifying income");
    const unsourced = f.assets.largeDeposits.filter(
      (d) => d.amount > monthlyIncome * 0.5 && !d.sourceType,
    );
    return check(
      unsourced.length === 0,
      "every large deposit is sourced",
      `${unsourced.length} deposit(s) over 50% of monthly income without a source`,
    );
  },

  "AST-007": (f) =>
    !f.assets
      ? wait("the bank connection")
      : check(
          f.assets.earnestMoneyVerified,
          "EMD traced to a verified source",
          "earnest money deposit not sourced",
        ),

  "AST-008": (f) => {
    if (!f.assets) return wait("the bank connection");
    const retirement = f.assets.accounts.filter(
      (a) => a.type === "retirement" && a.usedForQualifying,
    );
    const incomplete = retirement.filter(
      (a) => a.vestedBalance === undefined || a.withdrawalEligible === undefined,
    );
    return check(
      incomplete.length === 0,
      `${retirement.length} retirement account(s) with liquidity verified`,
      `${incomplete.length} retirement account(s) missing vested balance or withdrawal eligibility`,
    );
  },

  "CRD-013": (f) => {
    if (!f.assets) return wait("the bank connection");
    // Three references, each with twelve months. Counting rent as the only
    // possible reference and then demanding three made this unsatisfiable by
    // construction — a thin-file borrower could never clear the requirement
    // that exists specifically for thin-file borrowers.
    const qualifying = f.assets.alternativeReferences.filter(
      (r) => r.monthsOfHistory >= 12 && r.onTime,
    );
    return check(
      qualifying.length >= 3,
      qualifying.map((r) => `${r.kind}: ${r.payeeName}`).join(", "),
      `${qualifying.length} of 3 alternative credit references with 12 months of on-time history`,
    );
  },

  "CRD-017": (f) => {
    if (!f.assets) return wait("the bank connection");
    if (!f.assets.vendorAuthorizedForDu) {
      return no("asset report did not come from a DU-authorized vendor");
    }
    return check(
      Boolean(f.assets.cashFlowAssessmentResult),
      `cash flow assessment: ${f.assets.cashFlowAssessmentResult}`,
      "cash flow assessment not performed",
    );
  },

  "CRD-018": (f) => {
    if (!f.assets) return wait("the bank connection");
    const rent = f.assets.identifiedMonthlyRent ?? 0;
    if (rent < 300) return no(`identified rent of ${rent} is under the 300 minimum`);
    return check(
      f.assets.identifiedRentPayments >= 12,
      `${f.assets.identifiedRentPayments} on-time rent payments identified`,
      `only ${f.assets.identifiedRentPayments} of 12 rent payments identified`,
    );
  },

  "INC-001": (f) => {
    const active = f.employment.filter((e) => e.status === "active");
    return check(
      active.length > 0,
      active.map((e) => `${e.employerName} (${e.verificationMethod})`).join(", "),
      "no active employment verified",
    );
  },

  "INC-019": (f) => {
    const sources = f.incomeSources.filter(
      (s) => s.type === "retirement" || s.type === "pension" || s.type === "social_security",
    );
    const undocumented = sources.filter((s) => s.evidenceDocumentIds.length === 0);
    return check(
      undocumented.length === 0,
      `${sources.length} retirement/pension/SSA source(s) documented`,
      `${undocumented.length} retirement income source(s) without an award letter or 1099`,
    );
  },

  "INC-020": (f) => {
    const sources = f.incomeSources.filter((s) => s.type === "investment" || s.type === "dividend");
    const thin = sources.filter((s) => s.historyMonths < 24);
    return check(
      thin.length === 0,
      `${sources.length} investment income source(s) with two-year history`,
      `${thin.length} investment income source(s) with under 24 months of history`,
    );
  },

  /* ── Screen 6 · Payroll ──────────────────────────────────────────────── */

  "INC-002": (f) => {
    // Paystubs are the classic evidence, but not the only one the sheet
    // accepts: INC-002 carries "Day 1 Certainty: Yes - income", which is the
    // program where a validated asset report stands in for them. A salaried
    // borrower whose twelve months of deposits verify does not need a payroll
    // step, and demanding one would put a screen in front of every borrower to
    // serve the minority whose income is variable.
    if (f.payroll?.paystubs.length) {
      return ok(`${f.payroll.paystubs.length} paystub(s)`);
    }
    if (f.assets?.incomeConfidence === "verified") {
      return ok("income validated from the 12-month asset report (Day 1 Certainty)");
    }
    if (!f.assets && !f.payroll) return no("no income source connected");
    return no(
      f.assets?.incomeConfidenceReason ??
        "the asset report could not validate income on its own — paystubs needed",
    );
  },

  "INC-005": (f) => {
    const variable = f.incomeSources.filter(
      (s) => s.type === "overtime" || s.type === "bonus" || s.type === "commission",
    );
    const thin = variable.filter((s) => s.historyMonths < 12);
    return check(
      thin.length === 0,
      `${variable.length} variable income source(s) averaged over 12+ months`,
      `${thin.length} variable income source(s) with under 12 months of history`,
    );
  },

  "INC-006": (f) => {
    if (!f.payroll) return wait("the payroll connection");
    const unexplained = f.payroll.gaps.filter((g) => g.days > 30 && !g.reasonCode);
    return check(
      unexplained.length === 0,
      "every employment gap has a reason on record",
      `${unexplained.length} employment gap(s) over 30 days unexplained`,
    );
  },

  "INC-022": (f) =>
    check(
      f.incomeSources.some((s) => s.type === "military_entitlement"),
      "base pay and entitlements identified separately",
      "military entitlements not broken out from base pay",
    ),

  /* ── Screen 7 · IRS transcript ───────────────────────────────────────── */

  "INC-003": (f) => {
    const years = new Set(f.transcripts.map((t) => t.taxYear));
    return check(
      years.size >= 2,
      `W-2 wages for ${[...years].sort().join(", ")}`,
      `${years.size} of 2 tax years obtained`,
    );
  },

  /*
   * IRS Form 4506-C names a single taxpayer, so it is signed by each borrower
   * and answered about each of them. It read a file-level `some()` for as long
   * as the transcripts were pulled under the first borrower's token and nobody
   * else's — which made "4506-C executed" true of a joint file where one
   * person had signed and the other's tax records were not requestable at all.
   * Per applicant now, the same as APP-005 and APP-012, because the retrieval
   * is per applicant.
   */
  "INC-008": ofEveryBorrower((b, f) =>
    check(
      consentOf(f, b, "form_4506c"),
      "4506-C executed",
      "4506-C not signed — no tax records may be requested for this borrower",
    ),
  ),

  "INC-009": derived("INC-009", "transcript reconciliation"),

  /* ── Screen 8 · Upload fallback ──────────────────────────────────────── */

  "AST-006": (f) => {
    if (!f.assets) return wait("the bank connection");
    const undocumented = f.assets.gifts.filter((g) => !g.donorAbilityEvidenceId);
    return check(
      undocumented.length === 0,
      `${f.assets.gifts.length} gift(s) fully documented`,
      `${undocumented.length} gift(s) without donor ability evidence`,
    );
  },

  "CRD-006": derived("CRD-006", "bankruptcy seasoning"),

  "CRD-008": (f) =>
    check(
      hasDocumentFor(f, "CRD-008"),
      "letter of explanation on record",
      "no explanation for the derogatory account",
    ),

  "CRD-009": (f) => {
    if (!f.credit) return wait("the credit pull");
    const now = Date.now();
    const recent = f.credit.inquiries.filter(
      (i) => (now - new Date(i.date).getTime()) / 86_400_000 <= 90,
    );
    const unresolved = recent.filter((i) => i.resultedInNewDebt === null);
    return check(
      unresolved.length === 0,
      `${recent.length} recent inquiry/inquiries resolved`,
      `${unresolved.length} of ${recent.length} recent inquiries unresolved`,
    );
  },

  "CRD-011": (f) =>
    f.ssnValidatedWithSsa === null
      ? no("SSA-89 validation has not run")
      : check(f.ssnValidatedWithSsa, "SSN validated with SSA", "SSA-89 did not validate the SSN"),

  "INC-021": (f) => {
    const sources = f.incomeSources.filter(
      (s) => s.type === "alimony" || s.type === "child_support",
    );
    const thin = sources.filter((s) => s.historyMonths < 6 || !s.continuanceEndDate);
    return check(
      thin.length === 0,
      `${sources.length} support income source(s) documented`,
      `${thin.length} support income source(s) missing receipt history or continuance`,
    );
  },

  "INC-023": (f) => {
    const sources = f.incomeSources.filter((s) => s.type === "equity_compensation");
    const thin = sources.filter((s) => s.evidenceDocumentIds.length === 0 || s.historyMonths < 24);
    return check(
      thin.length === 0,
      `${sources.length} equity compensation source(s) documented`,
      `${thin.length} equity comp source(s) missing a vesting schedule or 24-month history`,
    );
  },

  /* ── Screen 9 · Decision ─────────────────────────────────────────────── */

  "APP-006": (f) =>
    check(hasDisclosure(f, "loan_estimate"), "LE delivered", "Loan Estimate not delivered"),

  "APP-007": (f) =>
    f.intentToProceedAt
      ? ok(`intent to proceed ${f.intentToProceedAt}`)
      : no("borrower has not indicated intent to proceed"),

  "APP-008": (f) =>
    check(
      hasDisclosure(f, "written_list_of_service_providers"),
      "WLSP delivered",
      "Written List of Service Providers not delivered",
    ),

  "APP-009": (f) =>
    check(
      hasDisclosure(f, "homeownership_counseling_list"),
      "counseling list delivered",
      "homeownership counseling list not delivered",
    ),

  "APP-010": (f) =>
    check(
      hasDisclosure(f, "home_loan_toolkit"),
      "toolkit delivered",
      "Your Home Loan Toolkit not delivered",
    ),

  "APP-019": (f) => {
    const ntb = f.decision?.compliance.netTangibleBenefit;
    if (!ntb) return wait("the decision has not run the NTB test");
    // A null recoup is a refinance with no monthly saving to recoup out of, and
    // it needs its own words: this string is read by a borrower and is the kind
    // of engine text an adverse-action reason is built from, so "recoup of null
    // months" — or the "recoup of Infinity months" it used to say — is not a
    // sentence anybody may send.
    if (ntb.recoupMonths === null) {
      return check(
        ntb.satisfied,
        "the new payment is lower than the old",
        "the new payment is not lower than the old, so the closing costs are never recouped",
      );
    }
    return check(
      ntb.satisfied,
      `recoup in ${ntb.recoupMonths} months against a ${ntb.thresholdMonths}-month threshold`,
      `recoup of ${ntb.recoupMonths} months exceeds the ${ntb.thresholdMonths}-month threshold`,
    );
  },

  "AST-002": derived("AST-002", "funds to close"),
  "AST-003": derived("AST-003", "reserve requirement"),

  "AST-004": (f) => {
    const r = f.decision?.reserves;
    if (!r || r.satisfied === null) return wait("the reserve calculation");
    return check(
      r.satisfied,
      `${r.actualMonths} months against ${r.requiredMonths} required`,
      `${r.actualMonths} months of reserves against ${r.requiredMonths} required`,
    );
  },

  "AST-016": derived("AST-016", "interested party contribution test"),
  "INC-004": derived("INC-004", "base income"),

  "INC-026": (f) => {
    const total = f.decision?.ratios.totalQualifyingIncome;
    return total === null || total === undefined
      ? wait("income components have not all been approved")
      : ok(`total qualifying monthly income ${total}`);
  },

  "INC-027": (f) => {
    if (f.incomeSources.length === 0) return wait("income sources");
    const undetermined = f.incomeSources.filter((s) => s.continuanceEstablished === null);
    return check(
      undetermined.length === 0,
      "continuance determined for every income source",
      `${undetermined.length} income source(s) without a continuance determination`,
    );
  },

  "UW-001": (f) =>
    f.decision?.aus
      ? ok(`submitted ${f.decision.aus.submittedAt} to ${f.decision.aus.engine}`)
      : no("case has not been submitted to AUS"),

  "UW-002": (f) =>
    f.decision?.aus
      ? ok(`${f.decision.aus.recommendation} (casefile ${f.decision.aus.casefileId})`)
      : wait("the AUS submission"),

  "UW-003": (f) => {
    const aus = f.decision?.aus;
    if (!aus) return wait("the AUS submission");
    const conditionIds = new Set(f.decision?.conditions.map((c) => c.requirementId) ?? []);
    const unmapped = aus.findings.filter(
      (x) => !x.requirementId || !conditionIds.has(x.requirementId),
    );
    return check(
      unmapped.length === 0,
      `${aus.findings.length} finding(s) mapped to conditions`,
      `${unmapped.length} AUS finding(s) with no tracked condition`,
    );
  },

  "UW-004": (f) => {
    const r = f.decision?.ratios;
    return r?.dtiBack === null || r?.dtiBack === undefined
      ? wait("income and liabilities")
      : ok(`front ${r.dtiFront}%, back ${r.dtiBack}%`);
  },

  "UW-005": (f) => {
    const r = f.decision?.ratios;
    return r?.ltv === null || r?.ltv === undefined
      ? wait("value and loan amount")
      : ok(`LTV ${r.ltv}%, CLTV ${r.cltv}%, HCLTV ${r.hcltv}%`);
  },

  "UW-006": (f) => {
    const c = f.decision?.compliance;
    if (c?.atrDetermination !== "documented") return no("ATR / QM determination not made");
    // QM is a price test needing APR and APOR. ATR can be documented while QM
    // status is genuinely unknown, and saying "documented, null" was worse
    // than saying which half is missing.
    if (c.qmStatus === null) return wait("APR and APOR, for the QM price test");
    return ok(`ATR documented, ${c.qmStatus}`);
  },

  "UW-007": (f) => {
    const c = f.decision?.compliance;
    if (c?.pointsAndFeesPass === null || c?.pointsAndFeesPass === undefined) {
      return wait("the fee schedule");
    }
    return check(
      c.pointsAndFeesPass,
      `points and fees ${c.pointsAndFeesRatio}% of loan amount`,
      `points and fees ${c.pointsAndFeesRatio}% exceeds the QM threshold`,
    );
  },

  "UW-008": (f) => {
    const c = f.decision?.compliance;
    return c?.isHpml === null || c?.isHpml === undefined
      ? wait("APR and APOR")
      : ok(`HPML spread ${c.hpmlSpread}, hpml = ${c.isHpml}`);
  },

  "UW-009": (f) => {
    const c = f.decision?.compliance;
    if (c?.isHighCost === null || c?.isHighCost === undefined) return wait("the fee schedule");
    return check(!c.isHighCost, "not a high-cost loan", "loan tests as HOEPA high-cost");
  },

  "UW-010": (f) => {
    const bps = f.decision?.pricing.llpaTotalBps;
    return bps === null || bps === undefined
      ? wait("FICO, LTV and product parameters")
      : ok(`${bps} bps of pricing adjustments`);
  },

  "UW-011": derived("UW-011", "manual underwrite"),
  "UW-012": derived("UW-012", "product eligibility"),
  "UW-013": derived("UW-013", "investor overlays"),

  "UW-014": (f) => {
    const conditions = f.decision?.conditions;
    if (!conditions) return wait("the AUS recommendation");
    return ok(`${conditions.length} condition(s) issued`);
  },

  "UW-015": (f) => {
    const conditions = f.decision?.conditions;
    if (!conditions) return wait("the condition list");
    const open = conditions.filter((c) => c.status !== "cleared" && c.status !== "waived");
    return check(open.length === 0, "all conditions cleared", `${open.length} open condition(s)`);
  },

  "UW-016": (f) => {
    const reasons = f.decision?.adverseActionReasons;
    return check(
      Boolean(reasons?.length),
      `${reasons?.length} principal reason(s) given`,
      "adverse action notice not issued with principal reasons",
    );
  },

  "UW-017": (f) =>
    f.decision?.outcome === "clear_to_close"
      ? ok("clear to close issued")
      : no("not yet clear to close"),

  "UW-018": (f) =>
    check(
      f.fraudReviewComplete,
      "fraud and red flag review complete",
      "fraud review not performed",
    ),
};

export function evaluateSatisfaction(requirement: Requirement, file: LoanFile): Satisfaction {
  const evaluator = EVALUATORS[requirement.id];
  if (!evaluator) {
    // Unreachable while evaluators.test.ts passes; kept so a registry change
    // degrades to an honest "unknown" rather than a crash in production.
    return wait(`no evaluator implemented for ${requirement.id}`);
  }
  return evaluator(file);
}
