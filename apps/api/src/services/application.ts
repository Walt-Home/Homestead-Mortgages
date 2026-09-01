/**
 * APP-002 — the moment an application exists.
 *
 * TRID defines it as six pieces received: name, income, SSN, property address,
 * value estimate, loan amount. Receiving the sixth starts a three-business-day
 * Loan Estimate clock, and missing that deadline is the sheet's most severe
 * category.
 *
 * Drew's sheet places APP-002 on screen 1, but screen 1 collects address,
 * price and down payment; name and SSN arrive on screen 2, and income does not
 * arrive until the bank or payroll connection on screens 4–5. So the clock
 * cannot start where the row sits. Rather than guess, the product asks for a
 * STATED income on screen 1 — one field, no verification — which lets the
 * sixth piece land at the end of screen 2, predictably, before any connector
 * runs.
 *
 * This function is the only thing that stamps the receipt, it stamps it once,
 * and it never un-stamps it. A borrower who edits their loan amount afterwards
 * has not restarted the clock, because TRID does not work that way.
 */

import { prisma } from "@sm/db";
import type { Prisma } from "@sm/db";
import type { LoanFile } from "@sm/shared";
import { recordEvent } from "./repository.js";

export interface SixPieces {
  readonly name: boolean;
  readonly income: boolean;
  readonly ssn: boolean;
  readonly propertyAddress: boolean;
  readonly valueEstimate: boolean;
  readonly loanAmount: boolean;
}

export function evaluateSixPieces(file: LoanFile, statedMonthlyIncome: number | null): SixPieces {
  const borrower = file.borrowers[0];
  return {
    name: Boolean(borrower?.firstName && borrower?.lastName),
    // Stated income counts. Verified income is a later requirement (INC-026);
    // conflating them would delay the clock past its legal start.
    income: (statedMonthlyIncome ?? 0) > 0 || file.incomeSources.length > 0,
    ssn: Boolean(borrower?.ssn.vaultHandle),
    propertyAddress: Boolean(file.property?.address.line1),
    valueEstimate: (file.property?.valueOrPrice ?? 0) > 0,
    loanAmount: (file.loan?.loanAmount ?? 0) > 0,
  };
}

/**
 * Stamp the receipt if all six are present and it has not been stamped.
 * Returns the ISO timestamp if this call stamped it, else null.
 */
export async function stampApplicationIfComplete(
  file: LoanFile,
  statedMonthlyIncome: number | null,
): Promise<string | null> {
  if (file.application) return null;

  const sixPieces = evaluateSixPieces(file, statedMonthlyIncome);
  if (!Object.values(sixPieces).every(Boolean)) return null;

  const receivedAt = new Date();
  await prisma.loanFile.update({
    where: { id: file.id },
    data: {
      applicationReceivedAt: receivedAt,
      applicationSixPieces: sixPieces as unknown as Prisma.InputJsonValue,
    },
  });
  await recordEvent(file.id, "application_received", "system", { sixPieces }, "APP-002");
  return receivedAt.toISOString();
}

/** Add `days` business days, skipping weekends. Federal holidays are not modelled. */
export function addBusinessDays(from: Date, days: number): Date {
  const result = new Date(from);
  let remaining = days;
  while (remaining > 0) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6) remaining--;
  }
  return result;
}

/** When the Loan Estimate is due, given the application receipt. */
export function loanEstimateDueAt(file: LoanFile): string | null {
  if (!file.application) return null;
  return addBusinessDays(new Date(file.application.receivedAt), 3).toISOString();
}
