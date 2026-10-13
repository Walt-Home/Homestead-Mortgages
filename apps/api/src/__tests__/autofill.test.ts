/**
 * The pure half of the autofill: what a reader is offered, from rows that
 * already exist, and under what the rules refuse.
 *
 * No database here. `suggestionsFor` takes the reader's own newest bank
 * snapshot and what they dismissed, and the cases below are the refusals the
 * design lists: nothing without a report, nothing from a report ordered under
 * any purpose but an extension of credit, nothing the reader dismissed on the
 * same snapshot (a newer one offers again), nothing for a run the detector did
 * not call rent, and never a figure that is not positive.
 */

import { describe, expect, it } from "vitest";
import type { AssetReport } from "@hm/shared";
import { dismissalKey, EXTENSION_OF_CREDIT, SUGGESTION_KEYS } from "@hm/shared";
import { suggestionsFor, type OwnBankSnapshot } from "../services/autofill.js";

const PARTY = "11111111-1111-4111-8111-111111111111";

function report(over: Partial<AssetReport> = {}): AssetReport {
  return {
    reportId: "r1",
    generatedAt: "2026-10-12T12:00:00Z",
    monthsCovered: 12,
    vendorAuthorizedForDu: true,
    accounts: [],
    largeDeposits: [],
    incomeSources: [],
    employments: [],
    incomeConfidence: "estimated",
    identifiedRentPayments: 13,
    identifiedMonthlyRent: 2_150,
    alternativeReferences: [
      {
        kind: "rent",
        payeeName: "OAKRIDGE PROPERTY MGMT",
        monthsOfHistory: 13,
        monthlyAmount: 2_150,
        onTime: true,
      },
    ],
    gifts: [],
    borrowedFunds: [],
    earnestMoneyVerified: false,
    ...over,
  };
}

function own(
  over: Partial<OwnBankSnapshot> = {},
  assets: Partial<AssetReport> = {},
): OwnBankSnapshot {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    retrievedAt: "2026-10-12T12:00:00Z",
    permissiblePurpose: EXTENSION_OF_CREDIT,
    assets: report(assets),
    ...over,
  };
}

const read = (o: OwnBankSnapshot | null, dismissed: string[] = []) =>
  suggestionsFor({ partyId: PARTY, own: o, dismissed: new Set(dismissed) });

describe("the rent caption", () => {
  it("is offered from the person's own category-gated rent run, with the figure and the payee in it", () => {
    const [rent, ...rest] = read(own());
    expect(rest).toHaveLength(0);
    expect(rent).toMatchObject({
      key: "current_monthly_rent",
      screen: "declarations",
      mode: "suggest",
      target: { kind: "residence", residencyType: "Current", field: "monthlyRent" },
      value: 2_150,
      source: "bank",
      tag: "From your bank activity",
      evidenceTier: "estimated",
      partyId: PARTY,
    });
    expect(rent!.basis).toBe("Your bank shows $2,150 a month to OAKRIDGE PROPERTY MGMT");
    expect(rent!.evidence.snapshotId).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("offers nothing without a report of the person's own", () => {
    expect(read(null)).toEqual([]);
  });

  it("offers nothing from a report the bureau was not told is for an extension of credit", () => {
    // FCRA 1681b(f): the purpose certified at order time is the one the
    // report may serve. A purpose nobody recorded is not a purpose.
    expect(read(own({ permissiblePurpose: null }))).toEqual([]);
    expect(read(own({ permissiblePurpose: "WRITTEN_INSTRUCTION_PREQUALIFICATION" }))).toEqual([]);
  });

  it("offers nothing where the detector found no rent, and never a figure that is not positive", () => {
    expect(read(own({}, { alternativeReferences: [], identifiedMonthlyRent: undefined }))).toEqual(
      [],
    );
    expect(read(own({}, { identifiedMonthlyRent: 0 }))).toEqual([]);
    // A utility run is not a rent run, however steady.
    expect(
      read(
        own(
          {},
          {
            alternativeReferences: [
              {
                kind: "utility",
                payeeName: "CITY WATER",
                monthsOfHistory: 12,
                monthlyAmount: 80,
                onTime: true,
              },
            ],
          },
        ),
      ),
    ).toEqual([]);
  });

  it("stays dismissed on the snapshot it was dismissed on, and comes back on a newer one", () => {
    const first = own();
    expect(read(first, [dismissalKey("current_monthly_rent", first.id)])).toEqual([]);
    const newer = own({ id: "33333333-3333-4333-8333-333333333333" });
    expect(read(newer, [dismissalKey("current_monthly_rent", first.id)])).toHaveLength(1);
  });
});

describe("the keys", () => {
  it("can name nothing a declaration, a demographic or an identity answer is stored under", () => {
    // Rule c: a Section 5 or 1b answer is asked bare and never suggested; a
    // demographic comes only from the applicant's own control; citizenship,
    // marital status, military service, occupancy and the first-time flag
    // are refused as values by the matrix. The union is closed, and this is
    // the test that keeps it closed.
    const forbidden = [
      "intent",
      "occup",
      "homeowner",
      "borrowed",
      "mortgage_application",
      "credit_application",
      "clean_energy",
      "comaker",
      "judgment",
      "delinquent",
      "lawsuit",
      "deed",
      "short_sale",
      "foreclos",
      "bankrupt",
      "self_employed",
      "party_to",
      "ethnicity",
      "race",
      "sex",
      "citizen",
      "marital",
      "military",
      "first_time",
      "language",
    ];
    for (const key of SUGGESTION_KEYS) {
      for (const word of forbidden) expect(key, `${key} names ${word}`).not.toContain(word);
    }
  });
});
