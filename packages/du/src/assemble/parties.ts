/**
 * `PARTIES`: the borrowers, how title will read, and everybody on the deal who
 * is not a borrower.
 *
 * Three sources under one container, in one fixed order — borrowers by
 * `borrower_ordinal`, then `du_vestings`, then `du_deal_parties`, each of the
 * last two in `(created_at, id)` order — because `DEAL/PARTIES/PARTY` is a flat
 * list and the document has to be reproducible.
 *
 * **The label sits on the `ROLE`, never on the `PARTY` and never on the
 * `BORROWER`.** Every arc that ends at a person ends at their part in this
 * deal, which is why the ownership join tables point at `application_parties`
 * and not at `parties`: dropping a borrower from a file takes their arcs with
 * them instead of leaving one naming a label the document no longer contains.
 *
 * A submission made only of borrowers satisfies neither half of
 * `DEAL/PARTIES/PARTY`'s "at least one party (non-Borrower) and no more than
 * 10", which is why the vesting and deal-party blocks are here rather than
 * waiting for somebody to notice. Refusing to emit without them is the next
 * commit's; this one writes what the tables hold.
 */

import type { DuDealPartyRole } from "@hm/db";
import { compact, container, leaf, type DuNode } from "../document.js";
import type { DuLabelIndex, DuLabelKind, DuLabels } from "../labels.js";
import { renderAmount, renderCount, renderDate, renderIndicator } from "../values.js";
import { addressNode } from "./collateral.js";
import { buildCurrentIncome, buildEmployers } from "./employment.js";
import type {
  LoadedApplication,
  LoadedEmployment,
  LoadedIncome,
  LoadedParty,
  PartyFacts,
} from "./load.js";

/**
 * The full nine digits, in cleartext, from outside Postgres.
 *
 * `TaxpayerIdentifierValue` is DU-Required and `Numeric 9` — no dashes — while
 * `borrowers.ssn_vault_handle` is an opaque reference and `ssn_last4` is
 * display only, so the number only exists at emit time and only for as long as
 * the document does. A resolver that has nothing for a party returns null and
 * the element is OMITTED: `ssn_last4` is not a taxpayer identifier and padding
 * it into one would put five fabricated digits on a federal submission.
 */
export type TaxpayerIdentifierResolver = (partyId: string) => Promise<string | null>;

/** What the nine digits have to look like before they go on the wire. */
const NINE_DIGITS = /^[0-9]{9}$/;

function readString(facts: PartyFacts | undefined, predicate: string): string | null {
  const value = facts?.[predicate];
  return typeof value === "string" && value !== "" ? value : null;
}

function readObject(facts: PartyFacts | undefined, predicate: string): Record<string, unknown> {
  const value = facts?.[predicate];
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function readNested(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : null;
}

const MARITAL_STATUS: Readonly<Record<string, string>> = {
  married: "Married",
  unmarried: "Unmarried",
  separated: "Separated",
};

const CITIZENSHIP: Readonly<Record<string, string>> = {
  us_citizen: "USCitizen",
  permanent_resident: "PermanentResidentAlien",
  non_permanent_resident: "NonPermanentResidentAlien",
};

function mapped(
  table: Readonly<Record<string, string>>,
  value: string | null,
  what: string,
): string | null {
  if (value === null) return null;
  const token = table[value];
  if (!token) {
    throw new Error(
      `${JSON.stringify(value)} is not a ${what} this emitter can name. Add it to the map ` +
        "against the vendored MISMO enumeration; do not guess a token.",
    );
  }
  return token;
}

function individualName(facts: PartyFacts | undefined): DuNode | null {
  const name = readObject(facts, "legal_name");
  const first = readNested(name, "first");
  const last = readNested(name, "last");
  const full = [first, last].filter((part) => part !== null).join(" ");
  return container("NAME", [
    leaf("FirstName", first),
    leaf("FullName", full),
    leaf("LastName", last),
  ]);
}

/**
 * A telephone number as DU takes it: ten digits and nothing else, which is
 * what every shipped sample carries. A person types it with dashes, dots or
 * parentheses, and a country code of 1 in front of ten digits is the same
 * number; anything that does not come out to ten digits is emitted as the
 * digits it did come out to, so the preflight refuses it by its length
 * rather than this function inventing a number that fits.
 */
export function telephoneDigits(value: string | null): string | null {
  if (value === null) return null;
  const digits = value.replace(/[^0-9]/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

function contactPoints(facts: PartyFacts | undefined): DuNode | null {
  return container("CONTACT_POINTS", [
    container("CONTACT_POINT", [
      container("CONTACT_POINT_EMAIL", [
        leaf("ContactPointEmailValue", readString(facts, "email")),
      ]),
    ]),
    container("CONTACT_POINT", [
      container("CONTACT_POINT_TELEPHONE", [
        leaf("ContactPointTelephoneValue", telephoneDigits(readString(facts, "phone"))),
      ]),
    ]),
  ]);
}

/**
 * The borrower's home address.
 *
 * Four lines and not five: the unit is inside `current_address.line2` and the
 * modeled set for this container does not carry `AddressUnitIdentifier`, which
 * is the corpus rather than an omission — no sample puts one here.
 */
function partyAddress(facts: PartyFacts | undefined): DuNode | null {
  const address = readObject(facts, "current_address");
  return container("ADDRESSES", [
    addressNode({
      addressLineText: readNested(address, "line1"),
      cityName: readNested(address, "city"),
      stateCode: readNested(address, "state"),
      postalCode: readNested(address, "postalCode"),
    }),
  ]);
}

function declaration(party: LoadedParty, facts: PartyFacts | undefined): DuNode | null {
  const answers = party.declaration;
  const citizenship = mapped(CITIZENSHIP, readString(facts, "citizenship"), "citizenship");
  if (!answers) {
    // Citizenship is a standing fact about a person and the rest of Section 5
    // is a statement about THIS credit request. Without the row there is no
    // declaration, and one element on its own would read as a borrower who
    // answered nothing.
    return null;
  }

  const ulad =
    answers.specialBorrowerSellerRelationship === null
      ? null
      : container("EXTENSION", [
          container("OTHER", [
            container("ULAD:DECLARATION_DETAIL_EXTENSION", [
              leaf(
                "ULAD:SpecialBorrowerSellerRelationshipIndicator",
                renderIndicator(answers.specialBorrowerSellerRelationship),
              ),
            ]),
          ]),
        ]);

  const detail = container(
    "DECLARATION_DETAIL",
    compact([
      leaf("BankruptcyIndicator", renderIndicator(answers.bankruptcy)),
      leaf("CitizenshipResidencyType", citizenship),
      answers.fhaSecondaryResidence === null
        ? null
        : leaf("FHASecondaryResidenceIndicator", renderIndicator(answers.fhaSecondaryResidence)),
      leaf("HomeownerPastThreeYearsType", answers.homeownerPastThreeYears),
      leaf("IntentToOccupyType", answers.intentToOccupy),
      leaf("OutstandingJudgmentsIndicator", renderIndicator(answers.outstandingJudgments)),
      answers.partyToLawsuit === null
        ? null
        : leaf("PartyToLawsuitIndicator", renderIndicator(answers.partyToLawsuit)),
      leaf("PresentlyDelinquentIndicator", renderIndicator(answers.presentlyDelinquent)),
      leaf(
        "PriorPropertyDeedInLieuConveyedIndicator",
        renderIndicator(answers.priorPropertyDeedInLieuConveyed),
      ),
      leaf(
        "PriorPropertyForeclosureCompletedIndicator",
        renderIndicator(answers.priorPropertyForeclosureCompleted),
      ),
      leaf(
        "PriorPropertyShortSaleCompletedIndicator",
        renderIndicator(answers.priorPropertyShortSaleCompleted),
      ),
      leaf("PriorPropertyTitleType", answers.priorPropertyTitle),
      leaf("PriorPropertyUsageType", answers.priorPropertyUsage),
      leaf(
        "PropertyProposedCleanEnergyLienIndicator",
        renderIndicator(answers.propertyProposedCleanEnergyLien),
      ),
      leaf("UndisclosedBorrowedFundsIndicator", renderIndicator(answers.undisclosedBorrowedFunds)),
      leaf("UndisclosedComakerOfNoteIndicator", renderIndicator(answers.undisclosedComakerOfNote)),
      leaf(
        "UndisclosedCreditApplicationIndicator",
        renderIndicator(answers.undisclosedCreditApplication),
      ),
      leaf(
        "UndisclosedMortgageApplicationIndicator",
        renderIndicator(answers.undisclosedMortgageApplication),
      ),
      ulad,
    ]),
  );

  return container("DECLARATION", [detail]);
}

function residences(party: LoadedParty): DuNode | null {
  const nodes = party.residences.map((residence, position) =>
    container(
      "RESIDENCE",
      compact([
        addressNode(residence),
        container("LANDLORD", [
          container("LANDLORD_DETAIL", [
            residence.monthlyRentCents === null
              ? null
              : leaf("MonthlyRentAmount", renderAmount(residence.monthlyRentCents)),
          ]),
        ]),
        container("RESIDENCE_DETAIL", [
          leaf("BorrowerResidencyBasisType", residence.basis),
          leaf("BorrowerResidencyDurationMonthsCount", renderCount(residence.durationMonths)),
          leaf("BorrowerResidencyType", residence.residencyType),
        ]),
      ]),
      { SequenceNumber: renderCount(position + 1) },
    ),
  );
  return container("RESIDENCES", nodes);
}

async function taxpayerIdentifiers(
  partyId: string,
  resolve: TaxpayerIdentifierResolver | undefined,
): Promise<DuNode | null> {
  if (!resolve) return null;
  const value = await resolve(partyId);
  if (value === null) return null;
  if (!NINE_DIGITS.test(value)) {
    throw new Error(
      "A taxpayer identifier is nine digits and nothing else. The resolver returned something " +
        "that is not one, and the value is not repeated here.",
    );
  }
  return container("TAXPAYER_IDENTIFIERS", [
    container("TAXPAYER_IDENTIFIER", [
      leaf("TaxpayerIdentifierType", "SocialSecurityNumber"),
      leaf("TaxpayerIdentifierValue", value),
    ]),
  ]);
}

export interface PartiesInput {
  readonly application: LoadedApplication;
  readonly facts: Map<string, PartyFacts>;
  readonly income: readonly LoadedIncome[];
  readonly employments: readonly LoadedEmployment[];
  readonly labels: DuLabels;
  readonly index: DuLabelIndex;
  readonly taxpayerIdentifiers?: TaxpayerIdentifierResolver;
}

async function borrowerParty(party: LoadedParty, input: PartiesInput): Promise<DuNode> {
  const facts = input.facts.get(party.partyId);
  // A person the applicant named who has not completed their own profile has
  // a name and nothing a casefile could carry about them. Refused by name,
  // here, before a generic "no date of birth" could say it worse: the
  // application is waiting on them, and a submission that left them out
  // would be a different loan.
  if (readString(facts, "date_of_birth") === null && readString(facts, "ssn_token") === null) {
    const name = readObject(facts, "legal_name");
    const who = `${name.first ?? ""} ${name.last ?? ""}`.trim() || party.partyId;
    throw new Error(
      `${who} is named on this application and has not completed their profile; ` +
        "a casefile cannot carry a person who has not stated who they are.",
    );
  }
  const label = input.labels.next("borrowerRole");
  input.index.roleByApplicationParty.set(party.id, label);

  const borrower = container("BORROWER", [
    container("BORROWER_DETAIL", [
      leaf("BorrowerBirthDate", birthDate(facts)),
      leaf(
        "MaritalStatusType",
        mapped(MARITAL_STATUS, readString(facts, "marital_status"), "marital status"),
      ),
    ]),
    buildCurrentIncome(
      input.income.filter((row) => row.partyId === party.partyId),
      input.labels,
      input.index,
    ),
    declaration(party, facts),
    buildEmployers(
      input.employments.filter((row) => row.partyId === party.partyId),
      input.income.filter((row) => row.partyId === party.partyId),
      input.labels,
      input.index,
    ),
    residences(party),
  ]);

  const role = container(
    "ROLE",
    [borrower, container("ROLE_DETAIL", [leaf("PartyRoleType", "Borrower")])],
    { SequenceNumber: "1", "xlink:label": label },
  );

  return {
    name: "PARTY",
    children: compact([
      container("INDIVIDUAL", [contactPoints(facts), individualName(facts)]),
      partyAddress(facts),
      container("ROLES", [role]),
      await taxpayerIdentifiers(party.partyId, input.taxpayerIdentifiers),
    ]),
  };
}

/**
 * A date of birth arrives as the string a screen collected, and goes out as the
 * same ten characters.
 *
 * Re-parsing it into a `Date` to format it back is how a birthday drifts a day
 * across a time zone, so a well-formed value is passed through and anything
 * else is refused rather than corrected.
 */
function birthDate(facts: PartyFacts | undefined): string | null {
  const value = readString(facts, "date_of_birth");
  if (value === null) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      "A date of birth is a date, and this party's is not one. The value is not repeated here: " +
        "a birth date belongs in the same place a taxpayer identifier does, which is nowhere " +
        "an exception message can be read.",
    );
  }
  return renderDate(parsed);
}

/** The label space each non-borrowing role is numbered in. */
const DEAL_PARTY_LABEL: Readonly<Record<DuDealPartyRole, DuLabelKind>> = {
  LoanOriginationCompany: "loanOriginationCompanyRole",
  LoanOriginator: "loanOriginatorRole",
  NotePayTo: "notePayToRole",
  HousingCounselingAgency: "housingCounselingAgencyRole",
};

function vestingParty(
  vesting: LoadedApplication["vestings"][number],
  labels: DuLabels,
): DuNode | null {
  const role = container(
    "ROLE",
    [
      container("PROPERTY_OWNER", [
        leaf("PropertyOwnerStatusType", vesting.status),
        leaf("RelationshipVestingType", vesting.vestingType),
      ]),
      container("ROLE_DETAIL", [leaf("PartyRoleType", "PropertyOwner")]),
    ],
    { SequenceNumber: "1", "xlink:label": labels.next("propertyOwnerRole") },
  );
  return container("PARTY", [
    container("INDIVIDUAL", [container("NAME", [leaf("FullName", vesting.fullName)])]),
    container("ROLES", [role]),
  ]);
}

function dealParty(
  party: LoadedApplication["dealParties"][number],
  labels: DuLabels,
): DuNode | null {
  const individualFullName = [party.firstName, party.lastName]
    .filter((part) => part !== null && part !== "")
    .join(" ");

  const role = container(
    "ROLE",
    [
      container("LICENSES", [
        container("LICENSE", [
          container("LICENSE_DETAIL", [
            leaf("LicenseAuthorityLevelType", party.licenseAuthorityType),
            leaf("LicenseIdentifier", party.licenseIdentifier),
          ]),
        ]),
      ]),
      container("PARTY_ROLE_IDENTIFIERS", [
        container("PARTY_ROLE_IDENTIFIER", [
          leaf("PartyRoleIdentifier", party.partyRoleIdentifier),
        ]),
      ]),
      container("ROLE_DETAIL", [leaf("PartyRoleType", party.role)]),
    ],
    { SequenceNumber: "1", "xlink:label": labels.next(DEAL_PARTY_LABEL[party.role]) },
  );

  return container("PARTY", [
    container("INDIVIDUAL", [
      container("CONTACT_POINTS", [
        container("CONTACT_POINT", [
          container("CONTACT_POINT_TELEPHONE", [
            leaf("ContactPointTelephoneValue", telephoneDigits(party.contactTelephone)),
          ]),
        ]),
      ]),
      container("NAME", [leaf("FullName", individualFullName)]),
    ]),
    container("LEGAL_ENTITY", [
      container("LEGAL_ENTITY_DETAIL", [leaf("FullName", party.legalEntityName)]),
    ]),
    container("ADDRESSES", [addressNode(party)]),
    container("ROLES", [role]),
  ]);
}

export async function buildParties(input: PartiesInput): Promise<DuNode | null> {
  const borrowers: DuNode[] = [];
  for (const party of input.application.parties) {
    borrowers.push(await borrowerParty(party, input));
  }
  return container("PARTIES", [
    ...borrowers,
    ...input.application.vestings.map((vesting) => vestingParty(vesting, input.labels)),
    ...input.application.dealParties.map((party) => dealParty(party, input.labels)),
  ]);
}
