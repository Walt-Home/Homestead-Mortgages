/**
 * The pure halves of the autofill: what a reader is offered, from rows that
 * already exist, and under what the rules refuse.
 *
 * No database here. The file scope takes the reader's own newest bank
 * snapshot, their own earlier phone, whether they have a row on the file yet
 * and what they dismissed; the person scope takes their own earlier income.
 * The cases are the refusals the design lists: nothing without evidence,
 * nothing bank-sourced under any purpose but an extension of credit, nothing
 * the reader dismissed on the same evidence (newer evidence offers again),
 * nothing for a run the detector did not call rent, never a figure that is
 * not positive, and a phone only before the person has said who they are.
 */

import { describe, expect, it } from "vitest";
import type { AssetReport } from "@hm/shared";
import { dismissalKey, EXTENSION_OF_CREDIT, READ_BACK_KEYS, SUGGESTION_KEYS } from "@hm/shared";
import {
  fileReadBacksFor,
  fileSuggestionsFor,
  personSuggestionsFor,
  type OwnBankSnapshot,
  type PriorStatement,
} from "../services/autofill.js";

const PARTY = "11111111-1111-4111-8111-111111111111";
const FACT = "44444444-4444-4444-8444-444444444444";

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

const said = (value: unknown, over: Partial<PriorStatement> = {}): PriorStatement => ({
  id: FACT,
  value,
  observedAt: "2026-03-14T15:00:00Z",
  ...over,
});

const onFile = (
  o: OwnBankSnapshot | null,
  opts: { phone?: PriorStatement | null; hasOwnRow?: boolean; dismissed?: string[] } = {},
) =>
  fileSuggestionsFor({
    partyId: PARTY,
    own: o,
    priorPhone: opts.phone ?? null,
    hasOwnRow: opts.hasOwnRow ?? true,
    dismissed: new Set(opts.dismissed ?? []),
  });

describe("the rent caption", () => {
  it("is offered from the person's own category-gated rent run, with the figure and the payee in it", () => {
    const [rent, ...rest] = onFile(own());
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
    expect(rent!.evidence).toEqual({
      kind: "snapshot",
      id: "22222222-2222-4222-8222-222222222222",
      at: "2026-10-12T12:00:00Z",
    });
  });

  it("offers nothing without a report of the person's own", () => {
    expect(onFile(null)).toEqual([]);
  });

  it("offers nothing from a report the bureau was not told is for an extension of credit", () => {
    // FCRA 1681b(f): the purpose certified at order time is the one the
    // report may serve. A purpose nobody recorded is not a purpose.
    expect(onFile(own({ permissiblePurpose: null }))).toEqual([]);
    expect(onFile(own({ permissiblePurpose: "WRITTEN_INSTRUCTION_PREQUALIFICATION" }))).toEqual([]);
  });

  it("offers nothing where the detector found no rent, and never a figure that is not positive", () => {
    expect(
      onFile(own({}, { alternativeReferences: [], identifiedMonthlyRent: undefined })),
    ).toEqual([]);
    expect(onFile(own({}, { identifiedMonthlyRent: 0 }))).toEqual([]);
    // A utility run is not a rent run, however steady.
    expect(
      onFile(
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

  it("stays dismissed on the report it was dismissed on, and comes back on a newer one", () => {
    const first = own();
    expect(onFile(first, { dismissed: [dismissalKey("current_monthly_rent", first.id)] })).toEqual(
      [],
    );
    const newer = own({ id: "33333333-3333-4333-8333-333333333333" });
    expect(
      onFile(newer, { dismissed: [dismissalKey("current_monthly_rent", first.id)] }),
    ).toHaveLength(1);
  });
});

describe("the phone a returning person gave before", () => {
  it("is offered on a file where they have not said who they are yet", () => {
    const [phone, ...rest] = onFile(null, { phone: said("5125550142"), hasOwnRow: false });
    expect(rest).toHaveLength(0);
    expect(phone).toMatchObject({
      key: "phone",
      screen: "identity",
      mode: "suggest",
      target: { kind: "fact", predicate: "phone" },
      value: "512-555-0142",
      source: "prior_statement",
      tag: "What you told us before",
      basis: "512-555-0142",
      evidenceTier: "attested",
      partyId: PARTY,
    });
    expect(phone!.evidence).toEqual({ kind: "fact", id: FACT, at: "2026-03-14T15:00:00Z" });
  });

  it("is not offered once they have a row here, because the screen reads their answer back", () => {
    expect(onFile(null, { phone: said("5125550142"), hasOwnRow: true })).toEqual([]);
  });

  it("is not offered when it is not a ten-digit number, which the bank screen would refuse", () => {
    expect(onFile(null, { phone: said("555-0100"), hasOwnRow: false })).toEqual([]);
    expect(onFile(null, { phone: said(5125550142), hasOwnRow: false })).toEqual([]);
  });

  it("takes the last ten digits of a number written with its country code", () => {
    const [phone] = onFile(null, { phone: said("+1 (512) 555-0142"), hasOwnRow: false });
    expect(phone!.value).toBe("512-555-0142");
  });

  it("stays dismissed on the statement it was dismissed on", () => {
    expect(
      onFile(null, {
        phone: said("5125550142"),
        hasOwnRow: false,
        dismissed: [dismissalKey("phone", FACT)],
      }),
    ).toEqual([]);
  });

  it("rides beside the rent, each on its own evidence", () => {
    const keys = onFile(own(), { phone: said("5125550142"), hasOwnRow: false }).map((s) => s.key);
    expect(keys).toEqual(["current_monthly_rent", "phone"]);
  });
});

describe("the income a person stated before", () => {
  const before = (value: unknown) =>
    personSuggestionsFor({ partyId: PARTY, priorIncome: value === null ? null : said(value) });

  it("is offered as a one-tap line, with the figure and when it was said", () => {
    const [income, ...rest] = before(9_400);
    expect(rest).toHaveLength(0);
    expect(income).toMatchObject({
      key: "stated_monthly_income",
      screen: "property",
      mode: "suggest",
      target: { kind: "fact", predicate: "monthly_income" },
      value: 9_400,
      source: "prior_statement",
      tag: "What you told us before",
      basis: "$9,400 a month, in March 2026",
      evidenceTier: "attested",
    });
    expect(income!.evidence).toEqual({ kind: "fact", id: FACT, at: "2026-03-14T15:00:00Z" });
  });

  it("is a whole-dollar figure, which is what the field takes", () => {
    expect(before(9_400.6)[0]!.value).toBe(9_401);
  });

  it("is never offered as nothing, as a negative, or as something that is not a figure", () => {
    expect(before(null)).toEqual([]);
    expect(before(0)).toEqual([]);
    expect(before(-50)).toEqual([]);
    expect(before("a lot")).toEqual([]);
  });
});

describe("the income read-back", () => {
  const STREAMS: AssetReport["incomeSources"] = [
    {
      type: "base_wage",
      monthlyAmount: 6_250.4,
      historyMonths: 12,
      continuanceEstablished: null,
      evidenceDocumentIds: [],
    },
    {
      type: "self_employment",
      monthlyAmount: 1_420,
      historyMonths: 9,
      continuanceEstablished: null,
      evidenceDocumentIds: [],
    },
  ];
  const back = (
    over: Partial<{
      isOwner: boolean;
      own: OwnBankSnapshot | null;
      stated: PriorStatement | null;
    }> = {},
  ) =>
    fileReadBacksFor({
      partyId: PARTY,
      isOwner: true,
      own: own({}, { incomeSources: STREAMS }),
      stated: said(9_400),
      ...over,
    });

  it("sets what the applicant told us beside what their own bank shows, with the rows each came from", () => {
    const [r, ...rest] = back();
    expect(rest).toHaveLength(0);
    expect(r).toEqual({
      key: "stated_vs_found_income",
      screen: "review",
      stated: {
        value: 9_400,
        evidence: { kind: "fact", id: FACT, at: "2026-03-14T15:00:00Z" },
      },
      found: {
        value: 7_670,
        streams: 2,
        evidence: {
          kind: "snapshot",
          id: "22222222-2222-4222-8222-222222222222",
          at: "2026-10-12T12:00:00Z",
        },
      },
      tag: "From your bank activity",
      partyId: PARTY,
    });
  });

  it("is the applicant's alone: a co-borrower is not asked an income on this application", () => {
    expect(back({ isOwner: false })).toEqual([]);
  });

  it("needs both figures, and never reads a report with no income in it as an answer", () => {
    expect(back({ stated: null })).toEqual([]);
    expect(back({ stated: said(0) })).toEqual([]);
    expect(back({ own: null })).toEqual([]);
    expect(back({ own: own({}, { incomeSources: [] }) })).toEqual([]);
  });

  it("reads nothing from a report the bureau was not told is for an extension of credit", () => {
    expect(back({ own: own({ permissiblePurpose: null }, { incomeSources: STREAMS }) })).toEqual(
      [],
    );
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
    for (const key of [...SUGGESTION_KEYS, ...READ_BACK_KEYS]) {
      for (const word of forbidden) expect(key, `${key} names ${word}`).not.toContain(word);
    }
  });
});
