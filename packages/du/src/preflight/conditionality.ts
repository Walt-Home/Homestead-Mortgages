/**
 * What the specification requires, and what it requires once something else is
 * true.
 *
 * **Forty-five data points are required with no statement at all, and the
 * container minima do not reach them.** A minimum catches a
 * `TAXPAYER_IDENTIFIER` that is absent entirely and nothing catches the same
 * one present carrying only its type, because `container()` keeps a container
 * alive on any one surviving child: a `BORROWER_DETAIL` survives on a marital
 * status with no date of birth, a `NAME` on a full name with no first name, a
 * `DECLARATION_DETAIL` on any one of fifteen siblings. All of those validate
 * against the whole chain and Desktop Underwriter rejects every one, which is
 * the same argument the rest of this gate is.
 *
 * Two hundred and twelve data points are conditional on eighty-five distinct
 * statements, and the statements are evaluated against the assembled casefile
 * rather than against one container at a time. That is not a preference:
 * `OwnedPropertyMaintenanceExpenseAmount` is conditional on
 * `LiabilityPaymentIncludesTaxesInsuranceIndicator`, which sits on a different
 * container reachable only along an arc, so a per-container validator cannot
 * express it at all. Nineteen owned properties across fourteen of the eighteen
 * shipped samples satisfy exactly that rule, through exactly that arc.
 *
 * **A bare `exists` in a statement names the data point itself, and makes the
 * statement unfalsifiable.** "Required IF exists" is how the specification
 * writes "send it when you have one" — a unit number, a middle name, a
 * suffix — so reading it as "required whenever its container exists" turns
 * fifty-two rules into refusals and rejects every one of Fannie Mae's own
 * eighteen files. Those statements are therefore not enforced, and the rule for
 * deciding which is mechanical rather than a list: a conjunction with a
 * self-reference in it is unfalsifiable, a disjunction is unfalsifiable only
 * when every branch is, and a disjunction's remaining branches are still
 * evaluated. Ninety of the two hundred and twelve survive that, two of them are
 * named below as rules nothing here can scope, and sixty-five of the remaining
 * eighty-eight fire somewhere in the eighteen and are satisfied there.
 *
 * **A data point named by a statement is looked up in the scope the document
 * fixes, and no wider.** The ladder starts at the container the rule is about
 * and climbs to the deal's own child — an `ASSET`, a `LIABILITY`, a `LOAN`, a
 * `PARTY` — stopping early at anything that repeats, and at each rung it also
 * looks along the arcs out of that rung. Without the ceiling, a borrower's
 * existing home equity line satisfies a condition about the loan being applied
 * for, because both spell the balance with the same element name in different
 * containers.
 */

import {
  DU_CONDITIONALITY,
  DU_CONDITION_STATEMENTS,
  type DuCondition,
  type DuConditionalityEntry,
} from "../generated/conditionality.js";
import { borrowerParties, subjectLoans } from "./cardinality.js";
import {
  DEAL,
  INDIVIDUAL_NAME,
  LOAN_DETAIL,
  SUBJECT_PROPERTY_DETAIL,
  TERMS_OF_LOAN,
} from "./paths.js";
import type { Findings } from "./report.js";
import { carries, contains, valuesUnder, type DuInstance, type DuTree } from "./tree.js";

/**
 * The rules whose statement is true of a casefile Fannie Mae ships, and why
 * each is not a rule this gate can keep.
 *
 * Both of them read "IF LiabilityUnpaidBalanceAmount exists", and both are
 * filed in the specification under a form field that says WHICH liabilities:
 * 3a.6 is the mortgage list against owned property and the remaining-term row
 * is the borrower's other debts. The casefile carries no form field, so the
 * statement fires on every liability, and Fannie Mae's own files answer the
 * two halves in the mirror image of each other — every mortgage and home
 * equity line in the corpus carries the taxes-and-insurance indicator and no
 * remaining term, and every installment and revolving account carries the
 * remaining term and no indicator. Enforcing either would refuse all eighteen.
 */
const UNSCOPED_BY_FORM_FIELD: readonly string[] = [
  `${DEAL}/LIABILITIES/LIABILITY/LIABILITY_DETAIL#LiabilityPaymentIncludesTaxesInsuranceIndicator#3a.6`,
  `${DEAL}/LIABILITIES/LIABILITY/LIABILITY_DETAIL#LiabilityRemainingTermMonthsCount#`,
];

function keyOf(entry: DuConditionalityEntry): string {
  return `${entry.xpath}#${entry.name}#${entry.formFieldId}`;
}

/**
 * True when the statement can never be broken by a document.
 *
 * A conjunction inherits it from any branch, because "A and we have it" only
 * bites when we have it. A disjunction inherits it only when every branch has
 * it, because one falsifiable branch is still a rule.
 */
function unfalsifiable(condition: DuCondition): boolean {
  switch (condition.kind) {
    case "self_exists":
      return true;
    case "and":
      return condition.terms.some(unfalsifiable);
    case "or":
      return condition.terms.every(unfalsifiable);
    default:
      return false;
  }
}

const EXCEPTED = new Set(UNSCOPED_BY_FORM_FIELD);

const ENFORCED = DU_CONDITIONALITY.filter((entry) => {
  if (entry.requirement !== "conditional" || entry.condition === null) return false;
  const statement = DU_CONDITION_STATEMENTS[entry.condition];
  if (!statement) {
    throw new Error(
      `${keyOf(entry)} is conditional on a statement the generated table does not parse, so ` +
        "nothing here can evaluate it.",
    );
  }
  return !unfalsifiable(statement) && !EXCEPTED.has(keyOf(entry));
});

for (const excepted of UNSCOPED_BY_FORM_FIELD) {
  const entry = DU_CONDITIONALITY.find((candidate) => keyOf(candidate) === excepted);
  if (!entry || entry.requirement !== "conditional") {
    throw new Error(
      `${excepted} is named as a rule this gate cannot keep, and the specification no longer ` +
        "carries it as a conditional one. An exception with nothing behind it is worse than none.",
    );
  }
}

/** How many conditional rules this check keeps, and how many it names as out of reach. */
export const CONDITIONAL_RULES = {
  enforced: ENFORCED.length,
  unscopedByFormField: UNSCOPED_BY_FORM_FIELD.length,
} as const;

/** The scopes an unconditionally required data point can be asked in. */
type RequiredScope = "subjectLoan" | "borrowerParty";

/**
 * Where a required data point is asked, when "wherever its container appears"
 * is the wrong reading.
 *
 * The same correction the container minima needed, and forced the same way. A
 * related loan is a second lien the borrower already owes: it carries a
 * `TERMS_OF_LOAN` and a `LOAN_DETAIL` of its own, and the rate, the amount and
 * the product of a debt somebody already has say nothing about the mortgage
 * being applied for — eight of the eighteen shipped files carry such a loan and
 * answer none of these on it. An originator is named by `FullName` alone, so
 * nine of the eighteen carry a `NAME` with no first name on it.
 *
 * Scoped per data point rather than per container, because `LienPriorityType`
 * sits on the same `TERMS_OF_LOAN` and every loan in the corpus carries one:
 * narrowing the container would stop asking for it on the loans that answer.
 */
const ASKED_ONLY_OF: Readonly<Record<string, RequiredScope>> = {
  [`${TERMS_OF_LOAN}#BaseLoanAmount`]: "subjectLoan",
  [`${TERMS_OF_LOAN}#LoanPurposeType`]: "subjectLoan",
  [`${TERMS_OF_LOAN}#MortgageType`]: "subjectLoan",
  [`${TERMS_OF_LOAN}#NoteRatePercent`]: "subjectLoan",
  [`${LOAN_DETAIL}#BalloonIndicator`]: "subjectLoan",
  [`${LOAN_DETAIL}#ConstructionLoanIndicator`]: "subjectLoan",
  [`${LOAN_DETAIL}#InterestOnlyIndicator`]: "subjectLoan",
  [`${LOAN_DETAIL}#NegativeAmortizationIndicator`]: "subjectLoan",
  [`${LOAN_DETAIL}#PrepaymentPenaltyIndicator`]: "subjectLoan",
  [`${INDIVIDUAL_NAME}#FirstName`]: "borrowerParty",
  [`${INDIVIDUAL_NAME}#LastName`]: "borrowerParty",
};

/**
 * Two data points the workbook marks required and Fannie Mae's own files omit.
 *
 * Both are omitted on files the specification ships as correct — the temporary
 * buydown indicator from the subject loan of all four Department of Veterans
 * Affairs samples, the existing clean energy lien indicator from the subject
 * property of the last of those four — and no scope separates the files that
 * omit them from the ones that answer. Enforcing either would refuse a casefile
 * Fannie Mae wrote, so they are declared here, as a short list somebody can
 * count, rather than enforced or quietly dropped.
 */
const ABSENT_FROM_SHIPPED_CASEFILES: readonly string[] = [
  `${LOAN_DETAIL}#BuydownTemporarySubsidyFundingIndicator`,
  `${SUBJECT_PROPERTY_DETAIL}#PropertyExistingCleanEnergyLienIndicator`,
];

function destinationOf(entry: DuConditionalityEntry): string {
  return `${entry.xpath}#${entry.name}`;
}

const NOT_ASKED = new Set(ABSENT_FROM_SHIPPED_CASEFILES);

/**
 * Every destination the specification requires with no statement behind it.
 *
 * Deduplicated on the destination, because the workbook files one data point
 * under several form fields and the requirement is about the destination rather
 * than about the form.
 */
const REQUIRED = [
  ...new Map(
    DU_CONDITIONALITY.filter((entry) => entry.requirement === "required").map((entry) => [
      destinationOf(entry),
      entry,
    ]),
  ).values(),
].filter((entry) => !NOT_ASKED.has(destinationOf(entry)));

for (const named of [...ABSENT_FROM_SHIPPED_CASEFILES, ...Object.keys(ASKED_ONLY_OF)]) {
  const entry = DU_CONDITIONALITY.find(
    (candidate) => destinationOf(candidate) === named && candidate.requirement === "required",
  );
  if (!entry) {
    throw new Error(
      `${named} is named here as a data point the specification requires, and the specification ` +
        "no longer requires it. An exception with nothing behind it is worse than none.",
    );
  }
}

/** How many unconditional rules this check keeps, and what it names as out of reach. */
export const REQUIRED_RULES = {
  enforced: REQUIRED.length,
  askedOnlyOfAScope: Object.keys(ASKED_ONLY_OF).length,
  absentFromShippedCasefiles: ABSENT_FROM_SHIPPED_CASEFILES.length,
} as const;

/**
 * Every value of a data point that is visible from here.
 *
 * The rungs are tried in order and the first that answers wins, so a residence
 * asks about its own residency type before it asks its borrower about one.
 */
function resolve(instance: DuInstance, name: string, tree: DuTree): string[] {
  for (let rung: DuInstance | null = instance; rung; rung = rung.parent) {
    const found = valuesUnder(rung.node, name);
    for (const linked of tree.linked(rung)) found.push(...valuesUnder(linked.node, name));
    if (found.length > 0) return found;
    if (rung.repeats) return [];
    if (rung.parent === null || rung.parent.path === DEAL) return [];
  }
  return [];
}

function holds(condition: DuCondition, instance: DuInstance, tree: DuTree): boolean {
  switch (condition.kind) {
    case "self_exists":
      return true;
    case "exists":
      return resolve(instance, condition.dataPoint, tree).length > 0;
    case "absent":
      return resolve(instance, condition.dataPoint, tree).length === 0;
    case "in": {
      const values = resolve(instance, condition.dataPoint, tree);
      return values.some((value) => condition.values.includes(value));
    }
    case "compare": {
      const values = resolve(instance, condition.dataPoint, tree);
      const against = String(condition.value);
      return values.some((value) => {
        switch (condition.operator) {
          case "=":
            return value === against;
          case "<>":
            return value !== against;
          case "<":
            return Number(value) < Number(against);
          case ">":
            return Number(value) > Number(against);
          default:
            throw new Error(
              `${condition.operator} is not a comparison this gate knows how to make. Add it ` +
                "rather than letting a rule pass by not being evaluated.",
            );
        }
      });
    }
    case "and":
      return condition.terms.every((term) => holds(term, instance, tree));
    case "or":
      // A branch that cannot be broken says nothing about whether the rule
      // bites, so the surviving branches are what decide it.
      return condition.terms
        .filter((term) => !unfalsifiable(term))
        .some((term) => holds(term, instance, tree));
  }
}

/** Whether the data point a rule is about is written on this container. */
function present(instance: DuInstance, entry: DuConditionalityEntry): boolean {
  return entry.attribute
    ? (instance.node.attributes?.[entry.name] ?? "") !== ""
    : carries(instance, entry.name);
}

function inScope(scope: RequiredScope, instance: DuInstance, tree: DuTree): boolean {
  const holders = scope === "subjectLoan" ? subjectLoans(tree) : borrowerParties(tree);
  return holders.some((holder) => contains(holder, instance));
}

/** What the phrase says about a scope, so the finding reads as a sentence. */
const ASKED_ON: Readonly<Record<RequiredScope, string>> = {
  subjectLoan: "the loan being applied for",
  borrowerParty: "a borrower's party",
};

export function checkRequired(tree: DuTree, findings: Findings): void {
  for (const entry of REQUIRED) {
    const scope = ASKED_ONLY_OF[destinationOf(entry)];
    for (const instance of tree.at(entry.xpath)) {
      if (scope !== undefined && !inScope(scope, instance, tree)) continue;
      if (present(instance, entry)) continue;
      findings.add(
        "required-data-point-absent",
        destinationOf(entry),
        `Required here unconditionally${scope === undefined ? "" : ` on ${ASKED_ON[scope]}`}, ` +
          "and this casefile does not carry it.",
      );
    }
  }
}

export function checkConditionality(tree: DuTree, findings: Findings): void {
  for (const entry of ENFORCED) {
    const statement = DU_CONDITION_STATEMENTS[entry.condition!]!;
    for (const instance of tree.at(entry.xpath)) {
      if (present(instance, entry)) continue;
      if (!holds(statement, instance, tree)) continue;
      findings.add(
        "conditional-data-point-absent",
        `${entry.xpath}#${entry.name}`,
        `Required here because ${entry.condition}, and this casefile does not carry it.`,
      );
    }
  }
}
