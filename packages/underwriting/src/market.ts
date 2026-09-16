/**
 * The priced figures the borrower flow never asks for, derived rather than
 * awaited.
 *
 * APR, APOR and the fee total used to be an optional argument to `underwrite`,
 * absent on every path a borrower could walk. Four compliance tests blocked on
 * them, a blocked input forces `refer`, and `refer` becomes `referred` — so
 * every file walked end to end on this product ended at "In review" for want of
 * numbers nobody was ever going to type. They are not borrower facts and they
 * are not vendor answers either: two of them are ours (what we charge, and the
 * arithmetic Regulation Z defines), and the third is a published weekly table.
 *
 * **They are derived HERE rather than accepted from the request.** The route
 * used to take them off the POST body, which meant the person whose loan was
 * being tested could state the APOR their HOEPA determination was measured
 * against. That is not a theoretical hole: the only session on a file belongs
 * to that borrower, and a posted `{"apor": 20}` turned a high-cost decline
 * into an approval. Nothing outside
 * this engine may supply them now, and `UnderwriteOptions.market` remains only
 * so the persona seed can stand a sample borrower at an outcome the fixtures
 * cannot reach on their own.
 *
 * The schedule, the table and the solve each record their own derivation, and
 * each blocks with what it is waiting for rather than defaulting. That is the same rule the rest of the
 * engine keeps; it matters more here because these three feed legal tests, and
 * a legal test answered from a default is the failure mode `compliance.ts` was
 * written to end.
 */

import type { LoanFile, PricedAgainst } from "@hm/shared";
import { APOR_TABLE, lookupApor } from "./apor.js";
import { annualPercentageRate, APR_OMITS } from "./apr.js";
import type { MarketInputs } from "./compliance.js";
import { DerivationLog, round } from "./derive.js";
import { closingCosts, FEE_SCHEDULE } from "./fee-schedule.js";
import { mortgageInsuranceRate } from "./guidelines.js";

/**
 * The four figures, and the provenance that has to travel with them.
 *
 * `pricedAgainst` is returned rather than derived later because only this
 * function knows which week answered and which schedule priced: by the time the
 * compliance tests see a number, it is a number. The decision carries it and
 * the database refuses a stored spread that has none.
 */
export interface ResolvedMarket {
  readonly inputs: MarketInputs;
  readonly pricedAgainst: PricedAgainst;
}

/**
 * What a market supplied by a caller was measured against: their say-so.
 *
 * An object with nothing in it is refused rather than accepted. `underwrite`
 * branches on whether `options.market` is present, and `{}` is present — so a
 * caller handing over an empty market silently turned off all four derivations
 * and got a file that referred for want of numbers the engine was standing
 * ready to compute. Nothing states an empty market on purpose; the failure mode
 * is a caller building one up conditionally and every condition being false.
 */
export function statedMarket(market: MarketInputs): ResolvedMarket {
  if (
    market.apor === undefined &&
    market.apr === undefined &&
    market.pointsAndFeesAmount === undefined &&
    market.totalLoanAmount === undefined &&
    market.closingCostTotal === undefined
  ) {
    throw new Error(
      "A stated market with nothing stated in it is neither stated nor derived. " +
        "Omit `market` to have the engine derive all four figures from the file.",
    );
  }
  return {
    inputs: market,
    pricedAgainst: {
      aporWeekOf: null,
      aporSource: market.apor === undefined ? null : "stated",
      feeScheduleVersion: market.pointsAndFeesAmount === undefined ? null : "stated",
    },
  };
}

export function resolveMarketInputs(file: LoanFile, log: DerivationLog): ResolvedMarket {
  /* ── The fee schedule (UW-007, APP-019) ───────────────────────────────── */
  const loanAmount = file.loan?.loanAmount ?? 0;
  const costs = closingCosts(FEE_SCHEDULE, loanAmount);
  if (costs === null) {
    log.blocked("UW-007", "Closing costs", ["loan amount"]);
  } else {
    log.record(
      "UW-007",
      "Closing costs",
      costs.total,
      `the ${FEE_SCHEDULE.version} fee schedule priced against the loan amount ` +
        "(this lender's own charges; no state transfer or recording tax is in it)",
      {
        fee_schedule: FEE_SCHEDULE.version,
        fee_schedule_effective_from: FEE_SCHEDULE.effectiveFrom,
        loan_amount: loanAmount,
        points_and_fees: costs.pointsAndFees,
        prepaid_finance_charges: costs.prepaidFinanceCharges,
      },
    );
  }

  /* ── APOR (UW-008) ────────────────────────────────────────────────────── */
  let apor: number | undefined;
  let aporWeekOf: string | null = null;
  let aporSource: string | null = null;
  if (!file.product) {
    log.blocked("UW-008", "Average prime offer rate", ["a quoted product"]);
  } else if (file.product.rateQuotedAt === null) {
    log.blocked("UW-008", "Average prime offer rate", ["the date this loan's rate was set"]);
  } else {
    const lookup = lookupApor(
      APOR_TABLE,
      new Date(file.product.rateQuotedAt),
      file.product.termMonths,
      file.product.amortization,
    );
    if (!lookup.found) {
      log.blocked("UW-008", "Average prime offer rate", [lookup.reason]);
    } else {
      apor = lookup.rate;
      aporWeekOf = lookup.weekOf;
      aporSource = lookup.source;
      log.record(
        "UW-008",
        "Average prime offer rate",
        lookup.rate,
        `the ${lookup.termYears}-year column of the weekly table, for the week the rate was set`,
        {
          week_of: lookup.weekOf,
          rate_quoted_at: file.product.rateQuotedAt,
          term_years: lookup.termYears,
          apor_source: lookup.source,
        },
      );
    }
  }

  /* ── APR (UW-008) ─────────────────────────────────────────────────────── */
  let apr: number | undefined;
  // Whether mortgage insurance applies has to be known before an APR can be
  // refused for carrying it, and it is read through the same function that
  // puts the premium into PITIA so the two cannot disagree about one loan.
  const value = file.property?.valueOrPrice ?? 0;
  if (!file.product || !file.loan || value <= 0) {
    log.blocked(
      "UW-008",
      "Annual percentage rate",
      [
        !file.product ? "a quoted product" : null,
        !file.loan ? "loan terms" : null,
        value <= 0 ? "a property value" : null,
      ].filter((x): x is string => x !== null),
    );
  } else if (costs === null) {
    log.blocked("UW-008", "Annual percentage rate", ["a priced fee schedule"]);
  } else {
    const ltv = (file.loan.loanAmount / value) * 100;
    // Above 80% is above 80%. `mortgageInsuranceRate` answers off a band table
    // whose lowest row starts at 80.01, so reading the refusal off a non-zero
    // premium left the open interval (80, 80.01) stating an APR for a loan that
    // carries mortgage insurance in fact — precisely the loan `apr.ts` says it
    // refuses. The premium still comes from that table, so PITIA and this
    // cannot disagree about the AMOUNT; they are allowed to disagree about the
    // boundary, and this is the side that has to be right.
    const carriesMortgageInsurance = ltv > 80 || mortgageInsuranceRate(ltv) > 0;
    const result = annualPercentageRate({
      loanAmount: file.loan.loanAmount,
      noteRate: file.product.noteRate,
      termMonths: file.product.termMonths,
      amortization: file.product.amortization,
      prepaidFinanceCharges: costs.prepaidFinanceCharges,
      mortgageInsuranceApplies: carriesMortgageInsurance,
    });
    if (!result.computed) {
      log.blocked("UW-008", "Annual percentage rate", [result.reason]);
    } else {
      apr = result.apr;
      log.record(
        "UW-008",
        "Annual percentage rate",
        result.apr,
        `Regulation Z Appendix J: the monthly rate discounting ${file.product.termMonths} ` +
          `payments back to the amount financed, times twelve — ${APR_OMITS}`,
        {
          note_rate: file.product.noteRate,
          loan_amount: file.loan.loanAmount,
          prepaid_finance_charges: costs.prepaidFinanceCharges,
          amount_financed: result.amountFinanced,
          monthly_payment: result.monthlyPayment,
          term_months: file.product.termMonths,
          fee_schedule: FEE_SCHEDULE.version,
        },
      );
    }
  }

  return {
    inputs: {
      apor,
      apr,
      pointsAndFeesAmount: costs?.pointsAndFees,
      // The §1026.32(b)(4) denominator, derived here so it and the APR's
      // `amountFinanced` are one subtraction rather than two that can drift:
      // the loan, less the charges paid at closing for the credit itself.
      totalLoanAmount:
        costs === null ? undefined : round(loanAmount - costs.prepaidFinanceCharges, 2),
      closingCostTotal: costs?.total,
    },
    pricedAgainst: {
      aporWeekOf,
      aporSource,
      feeScheduleVersion: costs === null ? null : costs.version,
    },
  };
}
