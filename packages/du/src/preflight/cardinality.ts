/**
 * How many of each container, and the part a literal reading gets wrong.
 *
 * **The tab's minimum is parent-scoped, not document-mandatory.**
 * `TAXPAYER_IDENTIFIER` is marked 1:1 per `PARTY`, and in Fannie Mae's own
 * three-borrower refinance only the three borrower parties carry one: the two
 * property owners, the origination company, the originator and the party the
 * note is paid to have none. A validator built literally from the minimum
 * column rejects the shipped test suite it was supposed to be measured against.
 * So every rule below names the SCOPE its minimum is counted in, and the scopes
 * are the role vocabulary — a borrower's party, a borrower's role, the subject
 * loan — rather than "the document".
 *
 * **Two rows the tab has wrong in the other direction are overridden here.**
 * `SUBJECT_PROPERTY/PROPERTY_DETAIL` and `ROLE/ROLE_DETAIL` are both minimum 0
 * while holding data points the same specification marks unconditionally
 * required, and both are present on every instance in all eighteen shipped
 * samples. A casefile whose role does not say which role it is has a party
 * doing nothing in particular, so they are treated as minimum 1 and the
 * override says so beside the number.
 *
 * Everything else is read out of the generated table, per product. Nothing here
 * copies a figure out of it: a specification change that moves a maximum moves
 * this check with it, and a container the table does not carry throws rather
 * than defaulting to unbounded.
 */

import { DU_CARDINALITY, type DuCardinality } from "../generated/cardinality.js";
import {
  ABOUT_VERSION,
  ASSET,
  BANKRUPTCY,
  BORROWER,
  BORROWER_DETAIL,
  COLLATERAL,
  CURRENT_INCOME_ITEM,
  CURRENT_INCOME_ITEM_DETAIL,
  DECLARATION,
  DECLARATION_DETAIL,
  EMPLOYER,
  EXPENSE,
  LIABILITY,
  LOAN,
  AMORTIZATION_RULE,
  PARTY,
  RESIDENCE,
  RESIDENCE_DETAIL,
  ROLE,
  ROLE_DETAIL,
  SUBJECT_PROPERTY,
  SUBJECT_PROPERTY_ADDRESS,
  SUBJECT_PROPERTY_DETAIL,
  TAXPAYER_IDENTIFIER,
  TERMS_OF_LOAN,
  UNDERWRITING_VERIFICATION,
} from "./paths.js";
import type { Findings } from "./report.js";
import { valueOf, type DuInstance, type DuTree } from "./tree.js";

/**
 * Which column of the cardinality table this casefile is counted against.
 *
 * The product is the subject loan's own `MortgageType`, because that is the
 * only place the document says what it is asking for. Government products are
 * one column in the table and conventional is the other; an absent
 * `MortgageType` counts as conventional, which is what a file with no
 * government product in it is.
 */
export type DuProduct = "du" | "fhaVa";

/** The scopes a minimum can be counted in. */
type Scope =
  | "document"
  | "everyParty"
  | "everyBorrowerParty"
  | "everyRole"
  | "everyBorrowerRole"
  | "everyBorrower"
  | "everyDeclaration"
  | "everyResidence"
  | "subjectProperty"
  | "subjectLoan";

interface ContainerRule {
  /** The container's XPath, which is also its key into the generated table. */
  readonly container: string;
  /** What each instance of this container is counted under. */
  readonly within: Scope;
  /** A minimum the tab does not carry, and the reason it is here. */
  readonly minimum?: { readonly count: number; readonly because: string };
}

const CONTAINER_RULES: readonly ContainerRule[] = [
  // The envelope. The emitter always writes it, which is exactly why a list
  // that enumerated the other minima and left this one out would be a list a
  // reader cannot trust.
  { container: ABOUT_VERSION, within: "document" },

  // The property being underwritten, and where it is.
  { container: COLLATERAL, within: "document" },
  { container: SUBJECT_PROPERTY, within: "document" },
  { container: SUBJECT_PROPERTY_ADDRESS, within: "subjectProperty" },
  {
    container: SUBJECT_PROPERTY_DETAIL,
    within: "subjectProperty",
    minimum: {
      count: 1,
      because:
        "the tab marks it optional while the same specification marks the data points inside " +
        "it required, and every instance in all eighteen shipped samples carries one",
    },
  },

  // The loan being applied for. Both of these are per-loan rows in the tab, and
  // the subject loan is the one they are asserted about: a related loan is a
  // second lien the borrower already owes and carries its own terms.
  { container: LOAN, within: "document" },
  { container: TERMS_OF_LOAN, within: "subjectLoan" },
  { container: AMORTIZATION_RULE, within: "subjectLoan" },

  // The people. `PARTY` is bounded across all three sources at once — the
  // borrowers, how title will read, and the institutions on the deal — because
  // they are one flat list in the document however many tables they came from.
  { container: PARTY, within: "document" },
  { container: ROLE, within: "everyParty" },
  {
    container: ROLE_DETAIL,
    within: "everyRole",
    minimum: {
      count: 1,
      because:
        "a role that does not say which role it is leaves a party on the deal doing nothing in " +
        "particular, and every role in all eighteen shipped samples says",
    },
  },
  { container: BORROWER, within: "everyBorrowerRole" },
  { container: BORROWER_DETAIL, within: "everyBorrower" },
  { container: DECLARATION, within: "everyBorrower" },
  { container: DECLARATION_DETAIL, within: "everyDeclaration" },
  { container: RESIDENCE, within: "everyBorrower" },
  { container: RESIDENCE_DETAIL, within: "everyResidence" },
  { container: TAXPAYER_IDENTIFIER, within: "everyBorrowerParty" },

  // What a borrower has, owes and earns. The income minimum is one on a
  // government product and none on a conventional one, which is the table's
  // own split and the reason it is read per product rather than flattened to a
  // maximum.
  { container: ASSET, within: "document" },
  { container: LIABILITY, within: "document" },
  { container: EXPENSE, within: "document" },
  { container: EMPLOYER, within: "everyBorrower" },
  { container: CURRENT_INCOME_ITEM, within: "everyBorrower" },
  { container: BANKRUPTCY, within: "everyBorrower" },

  // The verifications. The table this container is built from is append-only,
  // so the maximum holds only while one verification per report type per party
  // is selected instead of the history; this is what notices if that is ever
  // relaxed.
  { container: UNDERWRITING_VERIFICATION, within: "document" },
];

/**
 * The most borrowers a casefile may carry, which is a product rule and not a
 * row in the tab.
 *
 * The tab bounds `BORROWER` at four on both columns. A VA loan is a veteran's,
 * or a veteran's and one other person's, so the four never applies there, and
 * the specification's four would let a submission through that the guaranty
 * cannot cover.
 */
const MOST_BORROWERS = { conventionalOrFha: 4, va: 2 } as const;

function cardinalityFor(container: string, product: DuProduct): DuCardinality {
  const row = DU_CARDINALITY[container];
  if (!row) {
    throw new Error(
      `${container} has no row in the generated cardinality table, so nothing here knows how ` +
        "many of it a casefile may carry. Name a container the specification carries.",
    );
  }
  const bounds = product === "fhaVa" ? row.fhaVa : row.du;
  if (!bounds) {
    throw new Error(
      `${container} is not applicable to this product, so counting it would be asserting a ` +
        "bound the specification does not give.",
    );
  }
  return bounds;
}

function roleType(role: DuInstance, tree: DuTree): string | undefined {
  const detail = tree.within(role, ROLE_DETAIL)[0];
  return detail ? valueOf(detail, "PartyRoleType") : undefined;
}

function borrowerRoles(tree: DuTree): readonly DuInstance[] {
  return tree.at(ROLE).filter((role) => roleType(role, tree) === "Borrower");
}

/** The parties one of whose roles is a borrower's. */
export function borrowerParties(tree: DuTree): readonly DuInstance[] {
  return tree
    .at(PARTY)
    .filter((party) =>
      tree.within(party, ROLE).some((role) => roleType(role, tree) === "Borrower"),
    );
}

export function subjectLoans(tree: DuTree): readonly DuInstance[] {
  return tree.at(LOAN).filter((loan) => loan.node.attributes?.LoanRoleType === "SubjectLoan");
}

function productOf(tree: DuTree): DuProduct {
  const terms = subjectLoans(tree).flatMap((loan) => tree.within(loan, TERMS_OF_LOAN));
  const mortgageType = terms.map((detail) => valueOf(detail, "MortgageType")).find(Boolean);
  return mortgageType === "FHA" || mortgageType === "VA" ? "fhaVa" : "du";
}

function scopeOf(scope: Scope, tree: DuTree): readonly (DuInstance | null)[] {
  switch (scope) {
    // A null parent is the document itself: `within` takes an ancestor and the
    // root has none, so the whole-document scope is one anonymous parent.
    case "document":
      return [null];
    case "everyParty":
      return tree.at(PARTY);
    case "everyBorrowerParty":
      return borrowerParties(tree);
    case "everyRole":
      return tree.at(ROLE);
    case "everyBorrowerRole":
      return borrowerRoles(tree);
    case "everyBorrower":
      return tree.at(BORROWER);
    case "everyDeclaration":
      return tree.at(DECLARATION);
    case "everyResidence":
      return tree.at(RESIDENCE);
    case "subjectProperty":
      return tree.at(SUBJECT_PROPERTY);
    case "subjectLoan":
      return subjectLoans(tree);
  }
}

function countIn(tree: DuTree, parent: DuInstance | null, container: string): number {
  return parent === null ? tree.at(container).length : tree.within(parent, container).length;
}

function placeOf(parent: DuInstance | null, container: string): string {
  return parent === null ? container : `${parent.path} -> ${container}`;
}

export function checkCardinality(tree: DuTree, findings: Findings): void {
  const product = productOf(tree);

  for (const rule of CONTAINER_RULES) {
    const bounds = cardinalityFor(rule.container, product);
    const minimum = rule.minimum?.count ?? bounds.min;
    for (const parent of scopeOf(rule.within, tree)) {
      const found = countIn(tree, parent, rule.container);
      if (found < minimum) {
        const because = rule.minimum ? ` It is required here because ${rule.minimum.because}.` : "";
        findings.add(
          "container-below-minimum",
          placeOf(parent, rule.container),
          `${found} of a container this casefile needs ${minimum} of.${because}`,
        );
      }
      if (found > bounds.max) {
        findings.add(
          "container-above-maximum",
          placeOf(parent, rule.container),
          `${found} of a container Desktop Underwriter accepts ${bounds.max} of.`,
        );
      }
    }
  }

  checkNonBorrowerParty(tree, findings);
  checkBorrowerCap(tree, findings, product);
  checkOneSubjectLoan(tree, findings);
  checkOneCurrentResidence(tree, findings);
  checkIncomeTypes(tree, findings);
}

/**
 * At least one party who is not a borrower.
 *
 * The tab's note on `PARTY` says it in a parenthesis — "each Deal must have at
 * least one party (non-Borrower)" — and a predicate that counts parties without
 * the qualifier passes on a casefile that has only borrowers, which is a file
 * with nobody originating it. Every one of the eighteen shipped samples carries
 * an origination company and an originator.
 */
function checkNonBorrowerParty(tree: DuTree, findings: Findings): void {
  const parties = tree.at(PARTY);
  const borrowerOnly = parties.every((party) =>
    tree.within(party, ROLE).every((role) => roleType(role, tree) === "Borrower"),
  );
  if (parties.length > 0 && borrowerOnly) {
    findings.add(
      "container-below-minimum",
      PARTY,
      "Every party on this casefile is a borrower. A deal needs at least one party who is not: " +
        "the company originating it, the originator, whoever the note is paid to.",
    );
  }
}

function checkBorrowerCap(tree: DuTree, findings: Findings, product: DuProduct): void {
  const veteransAffairs = subjectLoans(tree)
    .flatMap((loan) => tree.within(loan, TERMS_OF_LOAN))
    .some((terms) => valueOf(terms, "MortgageType") === "VA");
  const most = veteransAffairs ? MOST_BORROWERS.va : MOST_BORROWERS.conventionalOrFha;
  const found = tree.at(BORROWER).length;
  if (found > most) {
    findings.add(
      "container-above-maximum",
      BORROWER,
      `${found} borrowers on a ${product === "fhaVa" ? "government" : "conventional"} casefile ` +
        `that admits ${most}.`,
    );
  }
}

/**
 * Exactly one loan is the one being applied for.
 *
 * `LoanRoleType` is the whole of what separates it from a related loan, and
 * both spellings are the same element name: a casefile with two subject loans
 * asks for two mortgages, and one with none asks for nothing while still
 * carrying a property and a borrower.
 */
function checkOneSubjectLoan(tree: DuTree, findings: Findings): void {
  const subjects = subjectLoans(tree);
  if (subjects.length === 1) return;
  findings.add(
    subjects.length === 0 ? "container-below-minimum" : "container-above-maximum",
    LOAN,
    `${subjects.length} of the loans in this casefile are marked SubjectLoan, and exactly one ` +
      "is the loan being applied for.",
  );
}

/**
 * One residence, and it is the one they live in now.
 *
 * The tab bounds residences at two per borrower and says nothing about which is
 * which; a borrower with two prior addresses and no current one has a residence
 * history and no address, which is the shape this catches.
 */
function checkOneCurrentResidence(tree: DuTree, findings: Findings): void {
  for (const borrower of tree.at(BORROWER)) {
    const current = tree
      .within(borrower, RESIDENCE_DETAIL)
      .filter((detail) => valueOf(detail, "BorrowerResidencyType") === "Current");
    if (current.length === 1) continue;
    findings.add(
      current.length === 0 ? "container-below-minimum" : "container-above-maximum",
      `${borrower.path} -> ${RESIDENCE}`,
      `${current.length} current residences, where a borrower has exactly one address they ` +
        "live at now.",
    );
  }
}

/**
 * One income type per borrower, among the income that is not employment.
 *
 * Evaluated here rather than on the rows it came from, because two rental
 * properties are two legitimate rows of one type until the mapping onto
 * Desktop Underwriter's vocabulary collapses them — a unique index on the
 * income table would make the vendor pull itself fail. Both items are named so
 * that whoever resolves it can see which two collided rather than being told a
 * count.
 */
function checkIncomeTypes(tree: DuTree, findings: Findings): void {
  for (const borrower of tree.at(BORROWER)) {
    const byType = new Map<string, string[]>();
    for (const item of tree.within(borrower, CURRENT_INCOME_ITEM)) {
      const detail = tree.within(item, CURRENT_INCOME_ITEM_DETAIL)[0];
      if (!detail) continue;
      if (valueOf(detail, "EmploymentIncomeIndicator") !== "false") continue;
      const type = valueOf(detail, "IncomeType");
      if (type === undefined) continue;
      const held = byType.get(type) ?? [];
      held.push(item.label ?? item.path);
      byType.set(type, held);
    }
    for (const [type, items] of byType) {
      if (items.length < 2) continue;
      findings.add(
        "income-type-repeated",
        `${borrower.path} -> ${CURRENT_INCOME_ITEM}`,
        `${items.join(" and ")} both carry ${type}, and one borrower has one income item per ` +
          "type of income that is not employment.",
      );
    }
  }
}
