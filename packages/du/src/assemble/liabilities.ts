/**
 * `LIABILITIES`, and `EXPENSES` beside them.
 *
 * Two containers in one file because they are one shape: a row, a label, and a
 * join table saying whose it is. `EXPENSE` is the smaller of the two and it is
 * the only container in the document with no detail block — its data points
 * hang directly off the element.
 *
 * `MortgageType` belongs to the LIABILITY and not to the loan. Exactly one
 * `LIABILITY_DETAIL` in the eighteen samples carries one — `DI-FHA02`'s
 * `LIABILITY_1`, an FHA mortgage the borrower already owes — and that same file
 * carries a second `MortgageType` under `TERMS_OF_LOAN`, which is the FHA
 * product being applied for. They are different statements about different
 * loans under one element name, `du_liabilities.mortgage_type` holds the first,
 * and nothing in this model holds the second.
 */

import { compact, container, leaf, type DuNode } from "../document.js";
import type { DuLabelIndex, DuLabels } from "../labels.js";
import { renderAmount, renderCount, renderIndicator } from "../values.js";
import type { LoadedExpense, LoadedLiability } from "./load.js";

function liabilityDetail(liability: LoadedLiability): DuNode | null {
  return container(
    "LIABILITY_DETAIL",
    compact([
      liability.helocMaximumBalanceCents === null
        ? null
        : leaf("HELOCMaximumBalanceAmount", renderAmount(liability.helocMaximumBalanceCents)),
      leaf("LiabilityAccountIdentifier", liability.accountIdentifier),
      // DU-Conditional on an unpaid balance existing, and the balance is NOT
      // NULL, so this is required on every liability we hold.
      leaf("LiabilityExclusionIndicator", renderIndicator(liability.exclusionIndicator)),
      leaf("LiabilityMonthlyPaymentAmount", renderAmount(liability.monthlyPaymentCents)),
      liability.paymentIncludesTaxesInsurance === null
        ? null
        : leaf(
            "LiabilityPaymentIncludesTaxesInsuranceIndicator",
            renderIndicator(liability.paymentIncludesTaxesInsurance),
          ),
      leaf("LiabilityPayoffStatusIndicator", renderIndicator(liability.payoffStatus)),
      liability.remainingTermMonths === null
        ? null
        : leaf("LiabilityRemainingTermMonthsCount", renderCount(liability.remainingTermMonths)),
      leaf("LiabilityType", liability.liabilityType),
      leaf("LiabilityUnpaidBalanceAmount", renderAmount(liability.unpaidBalanceCents)),
      leaf("MortgageType", liability.mortgageType),
    ]),
  );
}

export function buildLiabilities(
  liabilities: readonly LoadedLiability[],
  labels: DuLabels,
  index: DuLabelIndex,
): DuNode | null {
  const nodes = liabilities.map((liability, position) => {
    const children = compact([
      liabilityDetail(liability),
      container("LIABILITY_HOLDER", [container("NAME", [leaf("FullName", liability.holderName)])]),
    ]);
    if (children.length === 0) {
      throw new Error(
        `du_liabilities ${liability.id} renders no element and cannot carry a label.`,
      );
    }

    const label = labels.next("liability");
    index.liabilityByRow.set(liability.id, label);
    return container("LIABILITY", children, {
      SequenceNumber: renderCount(position + 1),
      "xlink:label": label,
    });
  });

  return container("LIABILITIES", nodes);
}

export function buildExpenses(
  expenses: readonly LoadedExpense[],
  labels: DuLabels,
  index: DuLabelIndex,
): DuNode | null {
  const nodes = expenses.map((expense, position) => {
    const children = compact([
      leaf("ExpenseMonthlyPaymentAmount", renderAmount(expense.monthlyPaymentCents)),
      expense.remainingTermMonths === null
        ? null
        : leaf("ExpenseRemainingTermMonthsCount", renderCount(expense.remainingTermMonths)),
      leaf("ExpenseType", expense.expenseType),
      leaf("ExpenseTypeOtherDescription", expense.expenseOtherDescription),
    ]);
    if (children.length === 0) {
      throw new Error(`du_expenses ${expense.id} renders no element and cannot carry a label.`);
    }

    const label = labels.next("expense");
    index.expenseByRow.set(expense.id, label);
    return container("EXPENSE", children, {
      SequenceNumber: renderCount(position + 1),
      "xlink:label": label,
    });
  });

  return container("EXPENSES", nodes);
}
