import type { StatementWire } from "@hm/billing";
import { describe, expect, it } from "vitest";
import { invoiceLines } from "../services/billing-invoices.js";

/**
 * An invoice line states the rate its row is priced at. A yearly row's tokens
 * are per loan-year, charged a twelfth each month; read "per loan-month" they
 * stated twelve times the sheet's rate while the amount was right.
 */
describe("an invoice line's rate", () => {
  const line = (code: string, cadence: "loan_month" | "loan_year", tokensEach: number) => ({
    code,
    action: `${code}: the row`,
    fires: "",
    basis: "upb_per_100k" as never,
    cadence,
    tokensEach,
    quantity: {
      kind: "loan_months" as const,
      loanMonths: "10",
      balanceCents: "250000000",
      loans: 10,
    },
    tokens: "100",
    cents: "100",
  });
  const statement = {
    lines: [line("A.statements", "loan_month", 150), line("A.escrow_analysis", "loan_year", 60)],
  } as unknown as StatementWire;

  it("says per loan-month for a monthly row and per loan-year for a yearly one", () => {
    const [monthly, yearly] = invoiceLines(statement);
    expect(monthly!.description).toMatch(/at 150 tokens per \$100,000 per loan-month$/);
    expect(yearly!.description).toMatch(
      /at 60 tokens per \$100,000 per loan-year, a twelfth each month$/,
    );
  });
});
