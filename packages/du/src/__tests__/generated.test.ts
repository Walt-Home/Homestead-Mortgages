/**
 * What the generator actually derived from the DU Spec, asserted against the
 * committed tables.
 *
 * These read the committed tables and nothing else, which is the point of
 * committing them: the facts below are checkable without opening a spreadsheet,
 * and `npm run du:verify` is what ties them back to the workbook vendored in
 * `packages/du-schema/workbook`.
 */

import { describe, expect, it } from "vitest";
import {
  CHILD_ORDER,
  DU_ARCROLES,
  DU_CARDINALITY,
  DU_CONDITIONALITY,
  DU_CONDITION_STATEMENTS,
  DU_ENUMERATIONS,
  DU_FORMATS,
  DU_RELATIONSHIP_XPATH,
  LOCAL_ENUMERATIONS,
  TYPE_FOR_PATH,
} from "../index.js";

/**
 * Alphabetical, with EXTENSION last — the shortcut this table exists to refuse.
 * Case-insensitive, because that is the reading under which it looks most
 * plausible and gets the most types right.
 */
function alphabeticalWithExtensionLast(children: readonly string[]): string[] {
  const rest = children.filter((c) => c !== "EXTENSION");
  rest.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  return children.includes("EXTENSION") ? [...rest, "EXTENSION"] : rest;
}

describe("child order", () => {
  /**
   * The nine types on the DU emission path whose sequence is not alphabetical.
   * Each is written out here in full rather than spot-checked, because "the
   * order is right" is the only thing standing between a well-formed document
   * and one Fannie Mae rejects for a reason no local check can see.
   */
  const expected: Record<string, string[]> = {
    DEAL: [
      "REFERENCE",
      "ABOUT_VERSIONS",
      "ASSETS",
      "COLLATERALS",
      "COMMUNICATION_EVENTS",
      "DEAL_DETAIL",
      "EXPENSES",
      "LIABILITIES",
      "LITIGATIONS",
      "LOANS",
      "PARTIES",
      "RELATIONSHIPS",
      "SERVICES",
      "SUPPORTING_RECORD_SETS",
      "EXTENSION",
    ],
    PARTY: [
      "REFERENCE",
      "INDIVIDUAL",
      "LEGAL_ENTITY",
      "ADDRESSES",
      "LANGUAGES",
      "ROLES",
      "TAXPAYER_IDENTIFIERS",
      "EXTENSION",
    ],
    // Thirty role containers before LICENSES, and BORROWER — the one a DU
    // file always carries — is fifth, not alphabetical among them.
    ROLE: [
      "APPRAISER",
      "APPRAISER_SUPERVISOR",
      "ATTORNEY",
      "ATTORNEY_IN_FACT",
      "BORROWER",
      "CLOSING_AGENT",
      "DEFENDANT",
      "FULFILLMENT_PARTY",
      "HOUSING_COUNSELING_AGENCY",
      "LENDER",
      "LIEN_HOLDER",
      "LOAN_ORIGINATOR",
      "LOSS_PAYEE",
      "NOTARY",
      "PAYEE",
      "PLAINTIFF",
      "PROPERTY_OWNER",
      "PROPERTY_SELLER",
      "REAL_ESTATE_AGENT",
      "REGULATORY_AGENCY",
      "REQUESTING_PARTY",
      "RESPONDING_PARTY",
      "RETURN_TO",
      "REVIEW_APPRAISER",
      "SERVICE_PROVIDER",
      "SERVICER",
      "SERVICING_TRANSFEROR",
      "SUBMITTING_PARTY",
      "TRUST",
      "TRUSTEE",
      "LICENSES",
      "PARTY_ROLE_IDENTIFIERS",
      "ROLE_DETAIL",
      "EXTENSION",
    ],
    EMPLOYER: [
      "INDIVIDUAL",
      "LEGAL_ENTITY",
      "ADDRESS",
      "CREDIT_COMMENTS",
      "EMPLOYMENT",
      "EMPLOYMENT_DOCUMENTATIONS",
      "VERIFICATION",
      "EXTENSION",
    ],
    COLLATERAL: ["PLEDGED_ASSET", "SUBJECT_PROPERTY", "COLLATERAL_DETAIL", "EXTENSION"],
    CONTACT_POINT: [
      "CONTACT_POINT_EMAIL",
      "CONTACT_POINT_SOCIAL_MEDIA",
      "CONTACT_POINT_TELEPHONE",
      "OTHER_CONTACT_POINT",
      "CONTACT_POINT_DETAIL",
      "EXTENSION",
    ],
    LICENSE: ["APPRAISER_LICENSE", "PROPERTY_LICENSE", "LICENSE_DETAIL", "EXTENSION"],
    // All data points, and the schema puts the FHA_VA prefix after the FHA
    // one — which a case-insensitive sort does not.
    GOVERNMENT_BORROWER: [
      "CAIVRSIdentifier",
      "FHABorrowerCertificationLeadPaintIndicator",
      "FHABorrowerCertificationOriginalMortgageAmount",
      "FHABorrowerCertificationOwnFourOrMoreDwellingsIndicator",
      "FHABorrowerCertificationOwnOtherPropertyIndicator",
      "FHABorrowerCertificationPropertySoldCityName",
      "FHABorrowerCertificationPropertySoldPostalCode",
      "FHABorrowerCertificationPropertySoldStateName",
      "FHABorrowerCertificationPropertySoldStreetAddressLineText",
      "FHABorrowerCertificationPropertyToBeSoldIndicator",
      "FHABorrowerCertificationRentalIndicator",
      "FHABorrowerCertificationSalesPriceAmount",
      "FHA_VABorrowerCertificationSalesPriceExceedsAppraisedValueType",
      "VABorrowerCertificationOccupancyType",
      "VABorrowerSurvivingSpouseIndicator",
      "VACoBorrowerNonTaxableIncomeAmount",
      "VACoBorrowerTaxableIncomeAmount",
      "VAFederalTaxAmount",
      "VALocalTaxAmount",
      "VAPrimaryBorrowerNonTaxableIncomeAmount",
      "VAPrimaryBorrowerTaxableIncomeAmount",
      "VASocialSecurityTaxAmount",
      "VAStateTaxAmount",
      "VeteranStatusIndicator",
      "EXTENSION",
    ],
    DOCUMENT_SPECIFIC_DATA_SET: [
      "ASSIGNMENT",
      "GFE",
      "HUD1",
      "INTEGRATED_DISCLOSURE",
      "NOTE",
      "NOTICE_OF_RIGHT_TO_CANCEL",
      "SECURITY_INSTRUMENT",
      "TIL_DISCLOSURE",
      "URLA",
      "DOCUMENT_CLASSES",
      "EXECUTION",
      "RECORDING_ENDORSEMENTS",
      "EXTENSION",
    ],
  };

  it("covers all nine of them", () => {
    // The count is part of the claim above it. A tenth type found to be
    // non-alphabetical, or one quietly dropped from the list, is the same
    // silence either way.
    expect(Object.keys(expected)).toHaveLength(9);
  });

  it.each(Object.entries(expected))("%s is in schema order", (type, children) => {
    expect(CHILD_ORDER[type]).toEqual(children);
  });

  it.each(Object.keys(expected))("%s is not what sorting would give", (type) => {
    const children = CHILD_ORDER[type];
    expect(children).toBeDefined();
    expect(alphabeticalWithExtensionLast(children!)).not.toEqual(children);
  });

  it("resolves every container XPath the spec names to a type it knows", () => {
    for (const [xpath, type] of Object.entries(TYPE_FOR_PATH)) {
      expect(xpath.startsWith("MESSAGE"), xpath).toBe(true);
      expect(CHILD_ORDER[type] ?? [], `${xpath} -> ${type}`).toBeDefined();
    }
  });
});

describe("enumerations", () => {
  it("derives DuAssetType to 22 members", () => {
    // Twenty-three rows in the tab, one of them a repeated "Other".
    expect(DU_ENUMERATIONS.DuAssetType).toHaveLength(22);
    expect(DU_ENUMERATIONS.DuAssetType).toContain("CheckingAccount");
    // Schema-legal and DU-illegal: in the XSD's AssetType, not in DU's subset.
    expect(DU_ENUMERATIONS.DuAssetType).not.toContain("RealEstateOwned");
    expect(DU_ENUMERATIONS.DuAssetType).not.toContain("Automobile");
  });

  it("carries both answers to both declaration questions", () => {
    // Read verbatim the tab gives IntentToOccupyType only "No".
    expect(DU_ENUMERATIONS.DuYesNo).toEqual(["No", "Yes"]);
  });

  it("keeps the two property-usage enums apart", () => {
    // 3a.5 carries Other and the current-usage list does not, so merging these
    // two back together would widen one of them.
    expect(DU_ENUMERATIONS.DuIntendedPropertyUsage).toContain("Other");
    expect(DU_ENUMERATIONS.DuPropertyUsage).not.toContain("Other");
  });

  it("treats AssetTypeOtherDescription as the enumeration it is", () => {
    expect(DU_ENUMERATIONS.DuAssetTypeOtherDescription).toEqual([
      "OtherLiquidAsset",
      "OtherNonLiquidAsset",
    ]);
  });

  it("declares the enums that are ours and gives them no members", () => {
    // Named one by one rather than counted, so that calling an enum "ours" is
    // a deliberate act. Two of the three are about what DU ANSWERS with, and
    // the corpus has nothing to say about that: it specifies the casefile we
    // send, `AutomatedUnderwritingRecommendationDescription` is free text in
    // the schema chain, and the workbook names a recommendation only in prose.
    expect(LOCAL_ENUMERATIONS).toEqual(["DuAssetKind", "DuResponseStatus", "DuRecommendation"]);
    for (const name of LOCAL_ENUMERATIONS) expect(DU_ENUMERATIONS[name]).toBeUndefined();
  });

  it("derives a non-empty member list for every enum that is not ours", () => {
    for (const [name, values] of Object.entries(DU_ENUMERATIONS)) {
      expect(name).toMatch(/^Du[A-Z]/);
      expect(values.length, name).toBeGreaterThan(0);
      expect(new Set(values).size, name).toBe(values.length);
      for (const value of values) expect(value, name).not.toMatch(/\*/);
    }
  });
});

describe("formats", () => {
  it("keeps a data point's width per destination", () => {
    const subject =
      "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/COLLATERALS/COLLATERAL/SUBJECT_PROPERTY/ADDRESS" +
      "#AddressLineText#4a.3.1";
    const owned =
      "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/ASSETS/ASSET/OWNED_PROPERTY/PROPERTY/ADDRESS" +
      "#AddressLineText#3a.2.1";
    expect(DU_FORMATS[subject]).toEqual({ kind: "string", maxLength: 50 });
    expect(DU_FORMATS[owned]).toEqual({ kind: "string", maxLength: 35 });
  });

  it("carries the full nine digits for the taxpayer identifier", () => {
    // Numeric 9, no dashes. The serializer is where the vault gets
    // dereferenced, and this is the width it has to render into.
    const key =
      "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/PARTIES/PARTY/TAXPAYER_IDENTIFIERS/" +
      "TAXPAYER_IDENTIFIER#TaxpayerIdentifierValue#1a.3";
    expect(DU_FORMATS[key]).toEqual({ kind: "numeric", digits: 9 });
  });
});

describe("cardinality", () => {
  it("covers the container XPaths the Cardinality tab names", () => {
    expect(Object.keys(DU_CARDINALITY)).toHaveLength(171);
  });

  /**
   * The borrower's own words have nowhere to go on the wire, and that is a
   * fact about DU rather than a decision this repo made. MISMO carries a
   * DECLARATION_EXPLANATIONS container -- CHILD_ORDER has it -- and DU's
   * cardinality table does not, so nothing on the emission path can hold an
   * explanation. `du_declarations.explanations` is stored for the 1003, the
   * underwriter and the file's own record, and a serializer that found the
   * container in the child order and filled it would be inventing a
   * destination rather than finding one.
   */
  it("has nowhere to put a declaration explanation", () => {
    expect(CHILD_ORDER["DECLARATION"]).toContain("DECLARATION_EXPLANATIONS");

    const paths = Object.keys(DU_CARDINALITY);
    expect(paths.some((p) => p.endsWith("/BORROWER/DECLARATION"))).toBe(true);
    expect(paths.filter((p) => /EXPLANATION/i.test(p))).toEqual([]);
  });

  it("reads MIN:MAX per product", () => {
    expect(DU_CARDINALITY["MESSAGE/DEAL_SETS/DEAL_SET"]?.du).toEqual({ min: 1, max: 1 });
  });
});

describe("conditionality", () => {
  it("parses every statement the map carries", () => {
    const referenced = new Set(
      DU_CONDITIONALITY.filter((e) => e.condition !== null).map((e) => e.condition!),
    );
    for (const statement of referenced) {
      expect(DU_CONDITION_STATEMENTS[statement], statement).toBeDefined();
    }
    expect(Object.keys(DU_CONDITION_STATEMENTS)).toHaveLength(referenced.size);
  });

  it("gives a condition to conditional rows and to no others", () => {
    for (const entry of DU_CONDITIONALITY) {
      if (entry.requirement === "conditional") expect(entry.condition, entry.name).not.toBeNull();
      else expect(entry.condition, entry.name).toBeNull();
    }
  });
});

describe("the relationship graph", () => {
  /**
   * Eleven arcs, and the number is worth pinning because the tab makes it easy
   * to get wrong. It describes every arc twice — once in its endpoints section
   * and once as a RELATIONSHIP block — across 82 rows of headers, sub-headings
   * and blank separators, so no count of its rows is a count of its arcs. Both
   * 82 and 23 have been quoted as the arc count.
   */
  it("holds the eleven arcs the tab describes", () => {
    expect(Object.keys(DU_ARCROLES)).toHaveLength(11);
    for (const [name, arc] of Object.entries(DU_ARCROLES)) {
      expect(arc.name).toBe(name);
      expect(arc.arcrole).toBe(`urn:fdc:mismo.org:2009:residential/${name}`);
    }
  });

  /**
   * Nine of the eleven. The two nobody has seen sent are the two that compute
   * an income figure -- rental against an owned property, employment against an
   * employer -- and they are also the two whose endpoints the tab contradicts
   * itself about. An emitter reaching for either has no shipped example to
   * copy, and that is the fact this column exists to carry.
   */
  it("says which arcs the eighteen shipped samples actually carry", () => {
    const exercised = Object.values(DU_ARCROLES)
      .filter((arc) => arc.exercised)
      .map((arc) => arc.name);
    expect(exercised).toHaveLength(9);
    expect(
      Object.values(DU_ARCROLES)
        .filter((arc) => !arc.exercised)
        .map((arc) => arc.name),
    ).toEqual([
      "UNDERWRITING_VERIFICATION_IsAssociatedWith_ASSET",
      "UNDERWRITING_VERIFICATION_IsAssociatedWith_EMPLOYER",
    ]);
  });

  /**
   * The trap, written out. At these two ends the tab names one element in its
   * endpoint XPath and Source/Target column and a different one in its `to` row
   * and in the arcrole URI, and no reading of the tab reconciles them. The
   * generated table carries all four names rather than picking, because an
   * emitter that arced to the wrong element would produce a document `xmllint`
   * accepts and DU rejects days later.
   */
  it("keeps both readings of the two ends the tab contradicts itself about", () => {
    const rentalIncome = DU_ARCROLES["UNDERWRITING_VERIFICATION_IsAssociatedWith_ASSET"]!.to;
    expect(rentalIncome.disputed).toBe(true);
    expect(rentalIncome.xpath).toBe("DEAL/ASSETS/ASSET/OWNED_PROPERTY/OWNED_PROPERTY_DETAIL");
    expect(rentalIncome.container).toBe("OWNED_PROPERTY_DETAIL");
    expect(rentalIncome.relationshipEnd).toBe("ASSET");
    expect(rentalIncome.arcroleTerm).toBe("ASSET");

    const employmentIncome = DU_ARCROLES["UNDERWRITING_VERIFICATION_IsAssociatedWith_EMPLOYER"]!.to;
    expect(employmentIncome.disputed).toBe(true);
    expect(employmentIncome.xpath).toBe(
      "DEAL/PARTIES/PARTY/ROLES/ROLE/BORROWER/EMPLOYERS/EMPLOYER",
    );
    expect(employmentIncome.container).toBe("EMPLOYMENT");
    expect(employmentIncome.relationshipEnd).toBe("EMPLOYMENT");
    expect(employmentIncome.arcroleTerm).toBe("EMPLOYER");
  });

  it("disputes no other end", () => {
    const disputed: string[] = [];
    for (const arc of Object.values(DU_ARCROLES)) {
      if (arc.from.disputed) disputed.push(`${arc.name} from`);
      if (arc.to.disputed) disputed.push(`${arc.name} to`);
    }
    expect(disputed).toEqual([
      "UNDERWRITING_VERIFICATION_IsAssociatedWith_ASSET to",
      "UNDERWRITING_VERIFICATION_IsAssociatedWith_EMPLOYER to",
    ]);
  });

  /**
   * All eleven arcs live in one container, and it is the one container on the
   * emission path that the other four tables say nothing about: DEAL declares
   * RELATIONSHIPS as a child, and no XPath in the DU Map or the Cardinality tab
   * reaches inside it. So the arc table is not a convenience over those — it is
   * the only description of the graph the code has, which is why a serializer
   * that only read `CHILD_ORDER` and `DU_CARDINALITY` would emit a document
   * with no arcs at all and no local symptom.
   */
  it("describes the one container the other generated tables do not reach", () => {
    expect(DU_RELATIONSHIP_XPATH).toBe(
      "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/RELATIONSHIPS/RELATIONSHIP",
    );
    expect(CHILD_ORDER["DEAL"]).toContain("RELATIONSHIPS");
    expect(Object.keys(TYPE_FOR_PATH).filter((p) => /RELATIONSHIP/.test(p))).toEqual([]);
    expect(Object.keys(DU_CARDINALITY).filter((p) => /RELATIONSHIP/.test(p))).toEqual([]);
  });
});
