/**
 * A borrower who has finished screens 1 and 2, with no database behind them.
 *
 * The engine, the branch rule and the decision are all pure functions of a
 * `LoanFile`, so the tests that exercise them do not need Postgres — they need
 * a file that looks exactly like one a real borrower would have produced by
 * the time each connector has run. This is that file, and the pulls that grow
 * it, in one place: the flow test walks it forward to check what each
 * connection retires, and the obligations test asks what is left on the
 * borrower at each step. Two tests reading the same borrower is the point.
 */

import { fixtureRegistry, PURPOSE_FOR, type PersonaId } from "@hm/connectors";
import {
  mintPurposeToken,
  type Consent,
  type DataCategory,
  type Grant,
  type LoanFile,
  type PurposeToken,
} from "@hm/shared";

export const REFERENCE = new Date("2026-06-15T12:00:00.000Z");

const PARTY = "11111111-1111-1111-1111-111111111111";
/** The file every token here is minted on. A token from another one is refused. */
const FILE = "11111111-1111-1111-1111-111111111111";

const GRANTS: Grant[] = [
  {
    id: "grant-app-005",
    partyId: PARTY,
    purpose: "fcra_written_instruction",
    dataCategories: [
      "credit_report",
      "bank_transactions",
      "payroll_income",
      "sanctions_screening",
      "public_record_liens",
    ],
    grantedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    revokedAt: null,
  },
  {
    id: "grant-4506c",
    partyId: PARTY,
    purpose: "irs_4506c",
    dataCategories: ["tax_transcript"],
    grantedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    revokedAt: null,
  },
];

/** A token for `category`, minted through the same pure function the API uses. */
export function token(category: DataCategory): PurposeToken {
  const r = mintPurposeToken({
    partyId: PARTY,
    fileId: FILE,
    purpose: PURPOSE_FOR[category],
    dataCategory: category,
    grants: GRANTS,
    now: REFERENCE,
  });
  if (!r.ok) throw new Error(`test setup: ${r.message}`);
  return r.token;
}

export const consent = (kind: Consent["kind"]): Consent => ({
  kind,
  borrowerId: "b1",
  grantedAt: REFERENCE.toISOString(),
  ipAddress: "127.0.0.1",
  userAgent: "test",
});

/** Screens 1 and 2 — everything the borrower types. */
export function afterIdentity(): LoanFile {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    createdAt: REFERENCE.toISOString(),
    updatedAt: REFERENCE.toISOString(),
    stage: "credit",
    propertyRecord: null,
    valuation: null,
    flood: null,
    sanctions: null,
    lienSearch: null,
    property: {
      address: { line1: "1 Example St", city: "Austin", state: "TX", postalCode: "78701" },
      deliverableAddressVerified: true,
      propertyType: "single_family",
      // Null after screens 1 and 2, because screen 3 is what asks it. Nothing
      // retrieved carries the estate — no assessor record, no valuation, no
      // flood determination — so a file that has not reached the declarations
      // has not been told, and a fixture that said FeeSimple here would make
      // APP-028 satisfied on every borrower who never answered it.
      estateType: null,
      occupancy: "primary_residence",
      valueOrPrice: 650_000,
      valuationSource: "attom_estimate",
      financedPropertyCount: 1,
    },
    loan: {
      purpose: "purchase",
      loanAmount: 520_000,
      downPayment: 130_000,
      juniorLienBalance: 0,
      juniorLienCreditLimit: 0,
      interestedPartyContributions: 0,
    },
    product: {
      productCode: "CONF-30-FIXED",
      termMonths: 360,
      amortization: "Fixed",
      noteRate: 6.25,
      overlays: [],
    },
    borrowers: [
      {
        id: "b1",
        partyId: "11111111-1111-1111-1111-111111111111",
        firstName: "Dana",
        lastName: "Whitfield",
        dateOfBirth: "1988-04-12",
        ssn: { last4: "4321", vaultHandle: "vault:4321:test" },
        email: "dana@example.com",
        phone: "512-555-0100",
        currentAddress: { line1: "9 Rent Rd", city: "Austin", state: "TX", postalCode: "78704" },
        maritalStatus: "unmarried",
        citizenship: "us_citizen",
        identityVerification: {
          verificationId: "fixture-idv.b1",
          status: "verified",
          verifiedAt: "2026-06-15T12:00:00.000Z",
        },
        nonBorrowingSpouseSignatureRequired: false,
        preferredLanguage: "en",
        demographics: {
          ethnicity: "declined",
          race: "declined",
          sex: "declined",
          visualObservationNoted: false,
        },
        firstTimeHomebuyer: true,
        isMilitary: false,
        currentHousing: "rent",
        monthlyRent: 2_150,
        declaration: null,
        residences: [],
      },
    ],
    consents: [consent("verification_authorization"), consent("econsent")],
    application: {
      receivedAt: REFERENCE.toISOString(),
      sixPieces: {
        name: true,
        income: true,
        ssn: true,
        propertyAddress: true,
        valueEstimate: true,
        loanAmount: true,
      },
      // One person on this file, so the flat six above and her own three are
      // the same three. A second signer is what makes them different answers.
      signers: [
        {
          borrowerId: "b1",
          name: "Dana Whitfield",
          ordinal: 1,
          pieces: { name: true, income: true, ssn: true },
          authorizedAt: REFERENCE.toISOString(),
          taxRecordsAt: null,
        },
      ],
    },
    credit: null,
    assets: null,
    payroll: null,
    transcripts: [],
    incomeSources: [],
    employment: [],
    documents: [],
    disclosures: [],
    links: [],
    decision: null,
    sanctionsScreenClear: true,
    ssnValidatedWithSsa: null,
    fraudReviewComplete: false,
    applicationSignedAt: null,
    intentToProceedAt: null,
    deliveryMethod: "electronic",
  };
}

/**
 * Screen 3 — Section 5 and where they live, as this borrower answered them.
 *
 * A renter of six years with nothing to declare, which is the shape most
 * files take and the one that makes the counts move in the only direction
 * they are allowed to. There is no connector anywhere near it: these are
 * answers, and the whole point of the screen is that nothing can infer them.
 */
export function afterDeclarations(file: LoanFile): LoanFile {
  return {
    ...file,
    // One house, one estate, one answer — which is why it lands on the file and
    // not on each borrower, and why it lands HERE: screen 3 is the screen that
    // asks it.
    property: file.property ? { ...file.property, estateType: "FeeSimple" } : null,
    borrowers: file.borrowers.map((b) => ({
      ...b,
      declaration: {
        intentToOccupy: "Yes",
        homeownerPastThreeYears: "No",
        priorPropertyUsage: null,
        priorPropertyTitle: null,
        fhaSecondaryResidence: null,
        specialBorrowerSellerRelationship: false,
        undisclosedBorrowedFunds: false,
        undisclosedBorrowedFundsAmount: null,
        undisclosedMortgageApplication: false,
        undisclosedCreditApplication: false,
        propertyProposedCleanEnergyLien: false,
        undisclosedComakerOfNote: false,
        outstandingJudgments: false,
        presentlyDelinquent: false,
        partyToLawsuit: false,
        priorPropertyDeedInLieuConveyed: false,
        priorPropertyShortSaleCompleted: false,
        priorPropertyForeclosureCompleted: false,
        bankruptcy: false,
        bankruptcyChapters: [],
        explanations: null,
      },
      residences: [
        {
          residencyType: "Current",
          basis: "Rent",
          durationMonths: 72,
          monthlyRent: 2_150,
          addressLineText: null,
          addressUnit: null,
          cityName: null,
          stateCode: null,
          postalCode: null,
          countryCode: null,
        },
      ],
    })),
  };
}

/** The registry the borrower flow would have talked to, for one persona. */
export const registryFor = (persona: PersonaId) =>
  fixtureRegistry({ latencyMs: 0, persona, referenceDate: REFERENCE });

/** How far through the connectors a file has got. */
export type Connected = "credit" | "bank" | "payroll" | "irs";

/**
 * Walk a fixture borrower through the connectors, in the order the four
 * screens run them, and hand back the file each one left behind.
 */
export async function connectedThrough(persona: PersonaId, through: Connected): Promise<LoanFile> {
  const registry = registryFor(persona);
  let file = afterIdentity();

  const credit = await registry.credit.pullTriMerge(file, token("credit_report"));
  file = { ...file, credit: credit.data };
  if (through === "credit") return file;

  const outcome = await registry.bank.fetchAssetReport(
    file,
    token("bank_transactions"),
    { sessionId: "s" },
    12,
  );
  if (outcome.status !== "ready") throw new Error("fixture must answer immediately");
  file = {
    ...file,
    assets: outcome.result.data,
    incomeSources: outcome.result.data.incomeSources,
    employment: outcome.result.data.employments,
  };
  if (through === "bank") return file;

  const payroll = await registry.payroll.fetchPayroll(file, token("payroll_income"), "s");
  file = {
    ...file,
    payroll: payroll.data,
    incomeSources: payroll.data.incomeSources,
    employment: payroll.data.employments,
  };
  if (through === "payroll") return file;

  file = { ...file, consents: [...file.consents, consent("form_4506c")] };
  const irs = await registry.irs.fetchTranscripts(file, token("tax_transcript"), []);
  return { ...file, transcripts: irs.data };
}
