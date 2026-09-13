/**
 * The one fixture that can say "not clear".
 *
 * Every persona's public record screens clean — variable_income's score-41 hit
 * is deliberately under the threshold — so without an explicit knob there is
 * no way to see a file held while somebody checks a name. That state exists in
 * the model and a sample borrower has to be able to show it, or a pill would
 * be the only evidence for it.
 *
 * The knob does not weaken the guard: a near match is still a person-keyed
 * retrieval, and asking for one without the category is refused exactly as
 * asking for a clean one is.
 */

import { describe, expect, it } from "vitest";
import {
  mintPurposeToken,
  type Borrower,
  type DataCategory,
  type Grant,
  type LoanFile,
  type PurposeToken,
} from "@hm/shared";
import { AuthorizationError, fixtureRegistry, PURPOSE_FOR } from "../index.js";

const PARTY = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-09-08T12:00:00.000Z");

const GRANT: Grant = {
  id: "grant-app-005",
  partyId: PARTY,
  purpose: "fcra_written_instruction",
  dataCategories: ["credit_report", "sanctions_screening"],
  grantedAt: "2026-09-01T00:00:00.000Z",
  expiresAt: "2026-12-01T00:00:00.000Z",
  revokedAt: null,
};

function token(category: DataCategory): PurposeToken {
  const result = mintPurposeToken({
    partyId: PARTY,
    purpose: PURPOSE_FOR[category],
    dataCategory: category,
    grants: [GRANT],
    now: NOW,
  });
  if (!result.ok) throw new Error(result.message);
  return result.token;
}

const OMAR: Borrower = {
  id: "borrower-1",
  partyId: PARTY,
  firstName: "Omar",
  lastName: "Haddad",
  dateOfBirth: "1991-12-05",
  ssn: { last4: "9034", vaultHandle: "vault:persona:omar_haddad" },
  email: "omar@example.test",
  phone: "5125550142",
  currentAddress: { line1: "710 W 22nd Street", city: "Austin", state: "TX", postalCode: "78705" },
  maritalStatus: "unmarried",
  citizenship: "us_citizen",
  identityVerification: null,
  nonBorrowingSpouseSignatureRequired: false,
  preferredLanguage: "en",
  demographics: null,
  firstTimeHomebuyer: null,
  isMilitary: false,
  currentHousing: "rent",
};

const file: LoanFile = {
  id: "00000000-0000-0000-0000-000000000000",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  stage: "credit",
  property: null,
  loan: null,
  product: null,
  borrowers: [OMAR],
  consents: [],
  application: null,
  declaration: null,
  residences: [],
  propertyRecord: null,
  valuation: null,
  flood: null,
  sanctions: null,
  lienSearch: null,
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
  sanctionsScreenClear: null,
  ssnValidatedWithSsa: null,
  fraudReviewComplete: false,
  applicationSignedAt: null,
  intentToProceedAt: null,
  deliveryMethod: "electronic",
};

describe("the screening fixture", () => {
  it("comes back clear unless it is asked not to", async () => {
    const screened = await fixtureRegistry({ latencyMs: 0 }).screening.screenSanctions(
      file,
      token("sanctions_screening"),
    );
    expect(screened.data.clear).toBe(true);
    expect(screened.data.matches).toEqual([]);
  });

  it("reports one near match, against the name on the file", async () => {
    const screened = await fixtureRegistry({
      latencyMs: 0,
      screening: "near_match",
    }).screening.screenSanctions(file, token("sanctions_screening"));

    expect(screened.data.clear).toBe(false);
    expect(screened.data.matches).toHaveLength(1);
    // The name on the file, not a fixed one: a hold that named somebody else
    // would contradict the file it is holding.
    expect(screened.data.matches[0]!.matchedName).toBe("OMAR HADDAD");
    // A near match, so a person has to read it rather than the file simply
    // stopping.
    expect(screened.data.matches[0]!.score).toBeLessThan(100);
    expect(screened.data.listsChecked.length).toBeGreaterThan(0);
    expect(screened.provider).toBe("fixture-screening");
  });

  it("still refuses without the sanctions category, near match or not", async () => {
    await expect(
      fixtureRegistry({ latencyMs: 0, screening: "near_match" }).screening.screenSanctions(
        file,
        token("credit_report"),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});
