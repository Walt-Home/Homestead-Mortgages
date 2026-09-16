/**
 * `EMPLOYERS` and `CURRENT_INCOME_ITEMS`, and the one arc between them.
 *
 * Both hang under a borrower's `BORROWER` block, and the arc that joins an
 * income item to the employer it comes from is derivable rather than stored
 * twice: `income_sources.employment_income` is true exactly when the row names
 * an employer, bound by a CHECK, so the indicator DU reads and the arc DU reads
 * cannot disagree.
 *
 * One `EMPLOYER` element per live `employments` row, which is one per party per
 * employer. The label space is document-global — `DI-C04` arcs to `EMPLOYER_1`,
 * `_2` and `_3` across two borrowers — while `SequenceNumber` restarts under
 * each borrower's `EMPLOYERS`.
 */

import { compact, container, leaf, type DuNode } from "../document.js";
import { employerKey, type DuLabelIndex, type DuLabels } from "../labels.js";
import { renderAmount, renderCount, renderDate, renderIndicator } from "../values.js";
import { centsFromDecimal } from "./collateral.js";
import type { LoadedEmployment, LoadedIncome } from "./load.js";

/**
 * Our income vocabulary, in MISMO's.
 *
 * Every token on the right is in the vendored `MISMOEnumeratedTypesB324.xsd`;
 * none of them is invented here, because a value MISMO does not carry is a
 * submission rejected at the other end and schema validation is the one thing
 * that would catch it.
 *
 * Two of the fifteen map to `Other` and they are named rather than buried.
 * MISMO has no equity-compensation token at all, and it has SEVEN military
 * ones — base pay, flight pay, combat pay, four kinds of allowance — where
 * `military_entitlement` is one word that cannot say which. The fix is a column
 * that says which; a guess here would be a document that validates and states
 * something nobody said.
 *
 * `retirement` and `pension` both land on `Pension` because the URLA groups
 * them and MISMO has no separate retirement token.
 */
const INCOME_TYPE: Readonly<Record<string, string>> = {
  base_wage: "Base",
  overtime: "Overtime",
  bonus: "Bonus",
  commission: "Commissions",
  self_employment: "SelfEmploymentIncome",
  rental: "NetRentalIncome",
  retirement: "Pension",
  pension: "Pension",
  social_security: "SocialSecurity",
  investment: "DividendsInterest",
  dividend: "DividendsInterest",
  alimony: "Alimony",
  child_support: "ChildSupport",
  equity_compensation: "Other",
  military_entitlement: "Other",
};

function incomeType(type: string): string {
  const mapped = INCOME_TYPE[type];
  if (!mapped) {
    throw new Error(
      `${JSON.stringify(type)} is not an income type this emitter can name. Add it to ` +
        "INCOME_TYPE against the vendored MISMO enumeration; do not guess a token.",
    );
  }
  return mapped;
}

/** What `employments.status` means on the wire. The corpus carries only `Current`. */
const EMPLOYMENT_STATUS: Readonly<Record<string, string>> = {
  active: "Current",
  ended: "Prior",
};

function employmentStatus(status: string): string {
  const mapped = EMPLOYMENT_STATUS[status];
  if (!mapped) {
    throw new Error(
      `${JSON.stringify(status)} is not an employment status this emitter can name. ` +
        "Add it to EMPLOYMENT_STATUS; do not guess a MISMO value.",
    );
  }
  return mapped;
}

/**
 * Which of a borrower's current jobs is the primary one.
 *
 * URLA 1b is the primary employment and 1c the additional ones, and DU wants
 * that as `EmploymentClassificationType` on every current job. Nobody is asked
 * it: it is the current job carrying the most employment income, which the
 * income items beside the employers already say. Ties — two jobs, identical
 * pay — go to the one that started first, and a job with no income item at
 * all counts as zero rather than as unknown, because a current job the pulls
 * found no pay for is still a job and still needs a classification. One
 * current job is primary by itself. Prior jobs get no classification: the
 * specification requires it on Current only.
 */
export function classifyEmployments(
  employments: readonly LoadedEmployment[],
  incomes: readonly LoadedIncome[],
): ReadonlyMap<string, "Primary" | "Secondary"> {
  const monthlyByEmployer = new Map<string, number>();
  for (const income of incomes) {
    if (income.employerId === null || !income.employmentIncome) continue;
    const cents = Number(centsFromDecimal(income.monthlyAmount) ?? 0);
    monthlyByEmployer.set(
      income.employerId,
      (monthlyByEmployer.get(income.employerId) ?? 0) + cents,
    );
  }
  const out = new Map<string, "Primary" | "Secondary">();
  const byParty = new Map<string, LoadedEmployment[]>();
  for (const e of employments) {
    if (employmentStatus(e.status) !== "Current") continue;
    byParty.set(e.partyId, [...(byParty.get(e.partyId) ?? []), e]);
  }
  for (const current of byParty.values()) {
    const ranked = [...current].sort((a, b) => {
      const pay =
        (b.employerId ? (monthlyByEmployer.get(b.employerId) ?? 0) : 0) -
        (a.employerId ? (monthlyByEmployer.get(a.employerId) ?? 0) : 0);
      if (pay !== 0) return pay;
      const aStart = a.startDate?.getTime() ?? Number.POSITIVE_INFINITY;
      const bStart = b.startDate?.getTime() ?? Number.POSITIVE_INFINITY;
      if (aStart !== bStart) return aStart - bStart;
      return a.id < b.id ? -1 : 1;
    });
    ranked.forEach((e, i) => out.set(e.id, i === 0 ? "Primary" : "Secondary"));
  }
  return out;
}

export function buildEmployers(
  employments: readonly LoadedEmployment[],
  incomes: readonly LoadedIncome[],
  labels: DuLabels,
  index: DuLabelIndex,
): DuNode | null {
  const classification = classifyEmployments(employments, incomes);
  const nodes = employments.map((employment, position) => {
    const current = employmentStatus(employment.status) === "Current";
    // The two declared answers are emitted only when the borrower has given
    // them. Absent, the preflight refuses the casefile by name — which is the
    // gate working, and not this emitter inventing a "false" for a question
    // nobody asked.
    const declared =
      employment.selfEmployed !== null && employment.employedByPartyToTransaction !== null;
    const children = compact([
      container("LEGAL_ENTITY", [
        container("LEGAL_ENTITY_DETAIL", [leaf("FullName", employment.employerName)]),
      ]),
      container(
        "EMPLOYMENT",
        compact([
          current && declared
            ? leaf(
                "EmploymentBorrowerSelfEmployedIndicator",
                renderIndicator(employment.selfEmployed!),
              )
            : null,
          current ? leaf("EmploymentClassificationType", classification.get(employment.id)!) : null,
          leaf("EmploymentPositionDescription", employment.position),
          employment.startDate === null
            ? null
            : leaf("EmploymentStartDate", renderDate(employment.startDate)),
          leaf("EmploymentStatusType", employmentStatus(employment.status)),
          current && declared
            ? leaf(
                "SpecialBorrowerEmployerRelationshipIndicator",
                renderIndicator(employment.employedByPartyToTransaction!),
              )
            : null,
        ]),
      ),
    ]);
    if (children.length === 0) {
      throw new Error(`employments ${employment.id} renders no element and cannot carry a label.`);
    }

    const label = labels.next("employer");
    if (employment.employerId !== null) {
      index.employerByPartyAndEmployer.set(
        employerKey(employment.partyId, employment.employerId),
        label,
      );
    }
    return container("EMPLOYER", children, {
      SequenceNumber: renderCount(position + 1),
      "xlink:label": label,
    });
  });

  return container("EMPLOYERS", nodes);
}

export function buildCurrentIncome(
  incomes: readonly LoadedIncome[],
  labels: DuLabels,
  index: DuLabelIndex,
): DuNode | null {
  const nodes = incomes.map((income, position) => {
    const monthly = centsFromDecimal(income.monthlyAmount);
    const children = compact([
      container(
        "CURRENT_INCOME_ITEM_DETAIL",
        compact([
          monthly === null ? null : leaf("CurrentIncomeMonthlyTotalAmount", renderAmount(monthly)),
          leaf("EmploymentIncomeIndicator", renderIndicator(income.employmentIncome)),
          leaf("IncomeType", incomeType(income.type)),
        ]),
      ),
    ]);
    if (children.length === 0) {
      throw new Error(`income_sources ${income.id} renders no element and cannot carry a label.`);
    }

    const label = labels.next("incomeItem");
    index.incomeItemByRow.set(income.id, label);
    return container("CURRENT_INCOME_ITEM", children, {
      SequenceNumber: renderCount(position + 1),
      "xlink:label": label,
    });
  });

  const items = container("CURRENT_INCOME_ITEMS", nodes);
  return container("CURRENT_INCOME", [items]);
}
