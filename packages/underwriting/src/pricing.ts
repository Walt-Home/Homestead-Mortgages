/**
 * Loan-level price adjustments (UW-010).
 *
 * ⚠ This grid is ILLUSTRATIVE. Real LLPAs come from the agencies' published
 * matrices, change several times a year, and are combined with caps and
 * waivers this does not model. The shape is right — an additive set of basis
 * point adjustments, each traceable to the attribute that caused it — and the
 * numbers are the wrong kind of wrong to ship: plausible enough to be believed.
 *
 * The failure severity Drew assigns UW-010 is "Financial loss", which is what
 * mispricing means. Wire the real matrix before anything is quoted.
 */

import type { LoanFile } from "@hm/shared";
import { DerivationLog } from "./derive.js";

export interface PricingResult {
  readonly llpaTotalBps: number | null;
  readonly adjustments: readonly { reason: string; bps: number }[];
}

/** FICO band → LTV band → basis points. Illustrative; see the file header. */
const FICO_LTV_GRID: { minFico: number; bands: { maxLtv: number; bps: number }[] }[] = [
  {
    minFico: 780,
    bands: [
      { maxLtv: 60, bps: 0 },
      { maxLtv: 80, bps: 0 },
      { maxLtv: 97, bps: 38 },
    ],
  },
  {
    minFico: 740,
    bands: [
      { maxLtv: 60, bps: 0 },
      { maxLtv: 80, bps: 13 },
      { maxLtv: 97, bps: 63 },
    ],
  },
  {
    minFico: 700,
    bands: [
      { maxLtv: 60, bps: 0 },
      { maxLtv: 80, bps: 50 },
      { maxLtv: 97, bps: 113 },
    ],
  },
  {
    minFico: 660,
    bands: [
      { maxLtv: 60, bps: 25 },
      { maxLtv: 80, bps: 100 },
      { maxLtv: 97, bps: 175 },
    ],
  },
  {
    minFico: 620,
    bands: [
      { maxLtv: 60, bps: 63 },
      { maxLtv: 80, bps: 163 },
      { maxLtv: 97, bps: 288 },
    ],
  },
];

export function priceLoan(
  file: LoanFile,
  fico: number | null,
  ltv: number | null,
  log: DerivationLog,
): PricingResult {
  if (fico === null || ltv === null || !file.property || !file.loan) {
    log.blocked(
      "UW-010",
      "Pricing adjustments",
      [
        fico === null ? "representative FICO" : null,
        ltv === null ? "LTV" : null,
        !file.property ? "property" : null,
      ].filter((x): x is string => x !== null),
    );
    return { llpaTotalBps: null, adjustments: [] };
  }

  const adjustments: { reason: string; bps: number }[] = [];

  const row = FICO_LTV_GRID.find((r) => fico >= r.minFico);
  if (!row) {
    log.blocked("UW-010", "Pricing adjustments", [
      `representative FICO ${fico} is below the ${FICO_LTV_GRID[FICO_LTV_GRID.length - 1]?.minFico ?? 620} floor`,
    ]);
    return { llpaTotalBps: null, adjustments: [] };
  }
  const band = row.bands.find((b) => ltv <= b.maxLtv) ?? row.bands[row.bands.length - 1];
  if (band) adjustments.push({ reason: `FICO ${row.minFico}+ at ${ltv}% LTV`, bps: band.bps });

  if (file.property.occupancy === "investment") {
    adjustments.push({ reason: "investment property", bps: 175 });
  } else if (file.property.occupancy === "second_home") {
    adjustments.push({ reason: "second home", bps: 165 });
  }

  if (file.property.propertyType === "condo" && ltv > 75) {
    adjustments.push({ reason: "condo over 75% LTV", bps: 75 });
  }
  if (file.property.propertyType === "two_to_four_unit") {
    adjustments.push({ reason: "2-4 unit property", bps: 100 });
  }
  if (file.loan.purpose === "cash_out_refinance") {
    adjustments.push({ reason: "cash-out refinance", bps: 100 });
  }

  const total = adjustments.reduce((sum, a) => sum + a.bps, 0);
  log.record(
    "UW-010",
    "Total pricing adjustment",
    total,
    "sum of LLPAs from FICO, LTV, occupancy, property type and purpose (ILLUSTRATIVE GRID)",
    Object.fromEntries(adjustments.map((a) => [a.reason, a.bps])),
  );

  return { llpaTotalBps: total, adjustments };
}
