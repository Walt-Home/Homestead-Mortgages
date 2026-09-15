/**
 * The gate, against the only casefiles anybody has that are known to be right.
 *
 * Two claims, and the second is the one that makes this commit worth having.
 *
 * **It does not refuse Fannie Mae's own files.** All eighteen shipped
 * submissions go through every check and come back clean. That is the property
 * a validator built literally out of the specification's minimum column does
 * NOT have — a taxpayer identifier is marked required on every party, and only
 * borrower parties carry one — so passing here is evidence that the scoping is
 * real rather than decorative.
 *
 * **Every check has a fixture that trips it, and the schema accepts all but two
 * of them.** Each fixture below is one of those eighteen with something changed,
 * and `xmllint` is run over the changed bytes: a casefile the schema would have
 * caught anyway proves nothing about a gate whose whole argument is that schema
 * validity is not enough. The two exceptions are the verification maximum,
 * which the DU wrapper happens to declare as `maxOccurs="50"`, and a date of
 * birth on a day February has never had; both are asserted as exceptions rather
 * than quietly left off the list. The list of checks is read out of the
 * report's own type, so a check added with no fixture fails here.
 *
 * The fixtures are text edits rather than tree surgery because the bytes are
 * what `xmllint` reads. An edit that matches nothing throws: a fixture that
 * silently stopped changing the sample would leave a check tested by a document
 * that is still correct.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DU_DATA_POINT_FOR_ENUM } from "../../../../scripts/build-du.mjs";
import { DU_ENUMERATIONS } from "../generated/enums.ts";
import { DU_FORMATS } from "../generated/lengths.ts";
import {
  CONDITIONAL_RULES,
  DU_SUBSET_AT,
  NOT_CHECKED_AGAINST_A_SUBSET,
  REQUIRED_RULES,
  runPreflight,
} from "../preflight/index.ts";
import { parseSample, readSamples, toDuNode, xmllintErrors } from "./support/sample-reader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Every check the report can name, read out of the type that names them.
 *
 * Out of the source rather than typed again here, because a second copy of a
 * list is a list that goes stale silently — and the thing this pins is that a
 * check arriving with no casefile behind it fails the build.
 */
const CHECKS = [
  ...readFileSync(resolve(HERE, "../preflight/report.ts"), "utf8").matchAll(
    /^\s*\|\s*"([a-z-]+)";?$/gm,
  ),
].map((match) => match[1]);

const samples = readSamples();

function sample(prefix) {
  const found = samples.find((entry) => entry.name.startsWith(prefix));
  if (!found) throw new Error(`no vendored sample named ${prefix}`);
  return found.xml;
}

/** A replacement that has to change something, applied once. */
function replaceOnce(xml, find, put) {
  const at = xml.indexOf(find);
  if (at === -1) throw new Error(`${find} is not in this sample, so the fixture changes nothing.`);
  return xml.slice(0, at) + put + xml.slice(at + find.length);
}

/** Where every element of a name begins and ends, self-closing ones included. */
function blocksOf(xml, tag) {
  const opening = new RegExp(`<${tag}(\\s[^>]*?)?(/)?>`, "g");
  const either = new RegExp(`<(/)?${tag}(\\s[^>]*?)?(/)?>`, "g");
  const found = [];
  let open;
  while ((open = opening.exec(xml))) {
    if (open[2] === "/") {
      found.push([open.index, opening.lastIndex]);
      continue;
    }
    let depth = 1;
    either.lastIndex = opening.lastIndex;
    let step;
    while (depth > 0 && (step = either.exec(xml))) {
      if (step[3] === "/") continue;
      depth += step[1] ? -1 : 1;
    }
    found.push([open.index, either.lastIndex]);
    opening.lastIndex = either.lastIndex;
  }
  return found;
}

/** The first element of a name whose text carries a marker. */
function blockWith(xml, tag, marker) {
  const found = blocksOf(xml, tag).find(([from, to]) => xml.slice(from, to).includes(marker));
  if (!found) throw new Error(`no ${tag} in this sample carries ${marker}.`);
  return found;
}

/** The sample without that element. */
function cut(xml, tag, marker) {
  const [from, to] = blockWith(xml, tag, marker);
  return xml.slice(0, from) + xml.slice(to).replace(/^\s*\n/, "");
}

/**
 * The sample with that element again, `times` more, every label AND every
 * sequence number inside the copy made its own.
 *
 * The renumbering is not tidiness. `SequenceNumber` is uniqueness among
 * siblings, so fifty copies all carrying the original's number trip the
 * uniqueness check fifty times and a fixture whose whole job is to pin one
 * maximum ends up wrong in two ways at once.
 */
function copy(xml, tag, marker, times) {
  const [from, to] = blockWith(xml, tag, marker);
  const block = xml.slice(from, to);
  const opening = /^<[^>]*>/.exec(block)[0];
  const numbered = /SequenceNumber="(\d+)"/.exec(opening);
  const copies = Array.from({ length: times }, (_unused, n) => {
    const rename = (text) => text.replace(/xlink:label="/g, `xlink:label="COPY${n}`);
    const head = numbered
      ? rename(opening).replace(numbered[0], `SequenceNumber="${Number(numbered[1]) + n + 1}"`)
      : rename(opening);
    return head + rename(block.slice(opening.length));
  }).join("\n");
  return `${xml.slice(0, to)}\n${copies}${xml.slice(to)}`;
}

/** The sample with one element edited in place. */
function edit(xml, tag, marker, change) {
  const [from, to] = blockWith(xml, tag, marker);
  return xml.slice(0, from) + change(xml.slice(from, to)) + xml.slice(to);
}

function reportFor(xml, identities = []) {
  return runPreflight({ document: toDuNode(parseSample(xml)), identities });
}

const DEAL = "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL";
const ADDRESS_41 = "1234 Independence North Terrace Extension";
const ADDRESS_51 = "1234 Independence Boulevard Northwest Extension Two";

/**
 * One fixture per check: the sample, the edit, and what the gate must say.
 *
 * `matches` is a regular expression over the finding's message where the check
 * fires on more than one kind of defect, so that a fixture for the scoped
 * minimum cannot be satisfied by an unrelated minimum firing elsewhere.
 *
 * `also` names the second check an edit necessarily trips. It is a declaration
 * and not a hedge: a fixture that refuses a casefile two ways stops isolating
 * the one check it exists for, and the assertion below is that the list is
 * exactly what each fixture says it is.
 */
const FIXTURES = [
  {
    title: "an arc pointing at a label nothing declares",
    check: "arc-endpoint-unresolved",
    xml: () => replaceOnce(sample("DI-C01"), 'xlink:to="BORROWER_1"', 'xlink:to="BORROWER_7"'),
  },
  {
    title: "two containers answering to one label",
    check: "label-not-unique",
    // The arcs move with it, so the only thing wrong with this casefile is that
    // one name now means two assets.
    xml: () =>
      sample("DI-C01")
        .replaceAll('xlink:label="ASSET_1"', 'xlink:label="ASSET_2"')
        .replaceAll('xlink:from="ASSET_1"', 'xlink:from="ASSET_2"'),
  },
  {
    title: "an arcrole nobody defines",
    check: "arcrole-unknown",
    // And the second thing that edit does, which is not noise: belonging to
    // somebody means an arc out of the container under an arcrole that starts
    // there, so an association Fannie Mae has no rule for leaves the asset it
    // left owned by nobody.
    also: ["container-has-no-arc"],
    xml: () =>
      replaceOnce(
        sample("DI-C01"),
        "residential/ASSET_IsAssociatedWith_ROLE",
        "residential/ASSET_IsOwnedBy_ROLE",
      ),
  },
  {
    title: "an asset no arc leaves",
    check: "container-has-no-arc",
    xml: () => cut(sample("DI-C01"), "RELATIONSHIP", 'xlink:from="ASSET_1"'),
  },
  {
    title: "an asset arced to a liability under the arcrole that associates it with a person",
    check: "arc-endpoint-wrong-container",
    matches: /puts a ROLE at its xlink:to/,
    // Both ends resolve, the arcrole is one of the eleven, and the asset is
    // still the source of an arc — so every other check in this file passes a
    // casefile in which nobody owns it.
    xml: () =>
      replaceOnce(
        sample("DI-C01"),
        '<RELATIONSHIP SequenceNumber="1" xlink:from="ASSET_1" xlink:to="BORROWER_1"',
        '<RELATIONSHIP SequenceNumber="1" xlink:from="ASSET_1" xlink:to="LIABILITY_1"',
      ),
  },
  {
    title: "an asset arced to a borrower under the arcrole a liability uses",
    check: "arc-endpoint-wrong-container",
    matches: /puts a LIABILITY at its xlink:from/,
    // And what that costs the asset, which is the reason belonging to somebody
    // is an arc out of the container under an arcrole that STARTS there: this
    // asset is the source of an arc and is owned by nobody all the same.
    also: ["container-has-no-arc"],
    xml: () =>
      replaceOnce(
        sample("DI-C01"),
        '<RELATIONSHIP SequenceNumber="1" xlink:from="ASSET_1" xlink:to="BORROWER_1" ' +
          'xlink:arcrole="urn:fdc:mismo.org:2009:residential/ASSET_IsAssociatedWith_ROLE"',
        '<RELATIONSHIP SequenceNumber="1" xlink:from="ASSET_1" xlink:to="BORROWER_1" ' +
          'xlink:arcrole="urn:fdc:mismo.org:2009:residential/LIABILITY_IsAssociatedWith_ROLE"',
      ),
  },
  {
    title: "an asset arced to itself",
    check: "arc-endpoint-wrong-container",
    matches: /lands on a ASSET/,
    xml: () =>
      replaceOnce(
        sample("DI-C01"),
        '<RELATIONSHIP SequenceNumber="1" xlink:from="ASSET_1" xlink:to="BORROWER_1"',
        '<RELATIONSHIP SequenceNumber="1" xlink:from="ASSET_1" xlink:to="ASSET_1"',
      ),
  },
  {
    title: "two siblings under one SequenceNumber",
    check: "sequence-number-not-unique",
    xml: () =>
      replaceOnce(
        sample("DI-C01"),
        '<ASSET SequenceNumber="2" xlink:label="ASSET_2">',
        '<ASSET SequenceNumber="1" xlink:label="ASSET_2">',
      ),
  },
  {
    title: "the subject property with no address",
    check: "container-below-minimum",
    matches: /needs 1 of/,
    where: `${DEAL}/COLLATERALS/COLLATERAL/SUBJECT_PROPERTY -> ${DEAL}/COLLATERALS/COLLATERAL/SUBJECT_PROPERTY/ADDRESS`,
    xml: () =>
      edit(sample("DI-C01"), "SUBJECT_PROPERTY", "<SUBJECT_PROPERTY>", (block) =>
        cut(block, "ADDRESS", "<AddressLineText>"),
      ),
  },
  {
    title: "a deal whose every party is a borrower",
    check: "container-below-minimum",
    matches: /at least one party who is not/,
    xml: () => {
      const one = cut(sample("DI-VA01"), "PARTY", "<PartyRoleType>LoanOriginationCompany<");
      return cut(one, "PARTY", "<PartyRoleType>LoanOriginator<");
    },
  },
  {
    title: "a borrower party with no taxpayer identifier, on a file where another party has one",
    check: "container-below-minimum",
    matches: /needs 1 of/,
    where: `${DEAL}/PARTIES/PARTY -> ${DEAL}/PARTIES/PARTY/TAXPAYER_IDENTIFIERS/TAXPAYER_IDENTIFIER`,
    xml: () => cut(sample("DI-FHA03"), "TAXPAYER_IDENTIFIERS", "SocialSecurityNumber"),
  },
  {
    title: "a role that does not say which role it is",
    check: "container-below-minimum",
    matches: /doing nothing in particular/,
    xml: () => cut(sample("DI-C01"), "ROLE_DETAIL", "<PartyRoleType>LoanOriginator<"),
  },
  {
    title: "a subject property with no property detail",
    check: "container-below-minimum",
    matches: /data points inside it required/,
    xml: () =>
      edit(sample("DI-C01"), "SUBJECT_PROPERTY", "<SUBJECT_PROPERTY>", (block) =>
        cut(block, "PROPERTY_DETAIL", "<"),
      ),
  },
  {
    title: "a third borrower on a loan the Department of Veterans Affairs guarantees",
    check: "container-above-maximum",
    matches: /3 borrowers/,
    xml: () => copy(sample("DI-VA02"), "PARTY", 'xlink:label="BORROWER_1"', 1),
  },
  {
    title: "an eleventh party",
    check: "container-above-maximum",
    matches: /11 of a container/,
    xml: () => copy(sample("DI-C09"), "PARTY", "<PartyRoleType>NotePayTo<", 3),
  },
  {
    title: "the fifty-first verification",
    check: "container-above-maximum",
    matches: /51 of a container/,
    // One of the two fixtures the schema also refuses: the DU wrapper declares
    // this container `maxOccurs="50"` where it declares parties, borrowers,
    // assets and liabilities unbounded.
    schemaCatchesItToo: /UNDERWRITING_VERIFICATION/,
    xml: () => copy(sample("DI-C07"), "DU:UNDERWRITING_VERIFICATION", "VERIFICATION_1", 50),
  },
  {
    title: "a borrower with no date of birth, on a detail that survives on a marital status",
    check: "required-data-point-absent",
    matches: /BorrowerBirthDate/,
    // The container minimum cannot see this: BORROWER_DETAIL is still there,
    // carrying one of its other children, and the specification requires this
    // one with no statement in front of it.
    xml: () => cut(sample("DI-C01"), "BorrowerBirthDate", "<"),
  },
  {
    title: "a taxpayer identifier carrying only what kind of number it is",
    check: "required-data-point-absent",
    matches: /TaxpayerIdentifierValue/,
    xml: () =>
      edit(sample("DI-C01"), "TAXPAYER_IDENTIFIER", "SocialSecurityNumber", (block) =>
        cut(block, "TaxpayerIdentifierValue", "<"),
      ),
  },
  {
    title: "the loan being applied for with no note rate on it",
    check: "required-data-point-absent",
    matches: /NoteRatePercent.*the loan being applied for/,
    // The scoped half. Eight of the eighteen shipped files carry a related loan
    // whose terms name no rate and are correct, so the rule is asked of the
    // subject loan and this is the casefile that proves it is still asked.
    xml: () =>
      edit(sample("DI-C01"), "LOAN", 'LoanRoleType="SubjectLoan"', (block) =>
        cut(block, "NoteRatePercent", "<"),
      ),
  },
  {
    title: "one borrower with two income items of one type",
    check: "income-type-repeated",
    xml: () =>
      replaceOnce(
        sample("DI-C01"),
        "<IncomeType>AutomobileAllowance</IncomeType>",
        "<IncomeType>DividendsInterest</IncomeType>",
      ),
  },
  {
    title: "an owned property missing what a liability on the other end of an arc makes required",
    check: "conditional-data-point-absent",
    matches: /OwnedPropertyMaintenanceExpenseAmount/,
    xml: () => cut(sample("DI-C04"), "OwnedPropertyMaintenanceExpenseAmount", "<"),
  },
  {
    title: "an amount written without its cents",
    check: "value-malformed",
    matches: /exactly 2 decimal places/,
    xml: () =>
      replaceOnce(
        sample("DI-C01"),
        "<BaseLoanAmount>300000.00</BaseLoanAmount>",
        "<BaseLoanAmount>300000</BaseLoanAmount>",
      ),
  },
  {
    title: "an indicator written as a digit",
    check: "value-malformed",
    matches: /true or the word false/,
    xml: () =>
      replaceOnce(
        sample("DI-C01"),
        "<LiabilityExclusionIndicator>false</LiabilityExclusionIndicator>",
        "<LiabilityExclusionIndicator>0</LiabilityExclusionIndicator>",
      ),
  },
  {
    title: "a liability type the schema admits and Desktop Underwriter does not",
    check: "value-malformed",
    matches: /values Desktop Underwriter supports/,
    // `PersonalLoan` is a member of the MISMO enumeration and not of the
    // subset Desktop Underwriter reads, which is the whole of why that table
    // exists: the schema accepts this casefile and the destination rejects it.
    xml: () =>
      replaceOnce(
        sample("DI-C01"),
        "<LiabilityType>Installment</LiabilityType>",
        "<LiabilityType>PersonalLoan</LiabilityType>",
      ),
  },
  {
    title: "a date of birth written CCYY-MM-DD on a day February has never had",
    check: "value-malformed",
    matches: /not a day/,
    // The second fixture the schema also refuses, and it is here because the
    // obvious way to write this check does not fire: parsing a date rolls an
    // out-of-range day into the next month rather than refusing it.
    schemaCatchesItToo: /BorrowerBirthDate/,
    xml: () =>
      replaceOnce(
        sample("DI-C01"),
        "<BorrowerBirthDate>1966-07-04</BorrowerBirthDate>",
        "<BorrowerBirthDate>1980-02-31</BorrowerBirthDate>",
      ),
  },
  {
    title: "a street line too long for the subject property",
    check: "value-too-long",
    matches: /1 too many/,
    xml: () =>
      edit(sample("DI-C01"), "SUBJECT_PROPERTY", "<SUBJECT_PROPERTY>", (block) =>
        block.replace(
          /<AddressLineText>[^<]*<\/AddressLineText>/,
          `<AddressLineText>${ADDRESS_51}</AddressLineText>`,
        ),
      ),
  },
  {
    title: "a street line too long for an owned property and lawful for the subject property",
    check: "value-too-long",
    matches: /6 too many/,
    xml: () =>
      edit(sample("DI-C04"), "OWNED_PROPERTY", "<AddressLineText>", (block) =>
        block.replace(
          /<AddressLineText>[^<]*<\/AddressLineText>/,
          `<AddressLineText>${ADDRESS_41}</AddressLineText>`,
        ),
      ),
  },
  {
    title: "a taxpayer identifier with more digits than it is allowed",
    check: "value-malformed",
    matches: /TaxpayerIdentifierValue.*12 digits/,
    // The schema types this as any run of digits, so twelve of them validate
    // and Desktop Underwriter rejects the casefile. It is also the fixture that
    // proves the refusal is safe to read: the finding is ABOUT a taxpayer
    // identifier, and the assertion below is that it does not contain one.
    xml: () =>
      edit(sample("DI-C01"), "TAXPAYER_IDENTIFIER", "SocialSecurityNumber", (block) =>
        block.replace(
          /<TaxpayerIdentifierValue>(\d+)<\/TaxpayerIdentifierValue>/,
          "<TaxpayerIdentifierValue>$1123</TaxpayerIdentifierValue>",
        ),
      ),
  },
  {
    title: "an owned property stating one lien's balance where two liens are arced to it",
    check: "derived-figure-disagrees",
    matches: /2 liens/,
    xml: () =>
      replaceOnce(
        sample("DI-C04"),
        "<OwnedPropertyLienUPBAmount>206514.00</OwnedPropertyLienUPBAmount>",
        "<OwnedPropertyLienUPBAmount>198514.00</OwnedPropertyLienUPBAmount>",
      ),
  },
  {
    title: "a borrower count that is not the number of borrowers",
    check: "derived-figure-disagrees",
    matches: /States 3 borrowers/,
    xml: () =>
      replaceOnce(
        sample("DI-C04"),
        "<BorrowerCount>2</BorrowerCount>",
        "<BorrowerCount>3</BorrowerCount>",
      ),
  },
  {
    title: "a row the matcher could not tell from another",
    check: "identity-unmatched",
    // The only check whose subject is not in the document: an unmatchable key
    // is a fact about the pull that wrote the row.
    xml: () => sample("DI-C01"),
    identities: [
      {
        table: "du_assets",
        id: "6f0e5f2a-0000-4000-8000-00000000abcd",
        identityKey: "unmatched:6f0e5f2a-0000-4000-8000-00000000abcd",
        lastSeenSnapshotId: "9c1d7e40-0000-4000-8000-0000000012ef",
      },
    ],
  },
];

describe("the gate passes what Fannie Mae ships", () => {
  it("has eighteen samples to run over", () => {
    expect(samples).toHaveLength(18);
  });

  for (const entry of samples) {
    it(`emits ${entry.name} without a finding`, () => {
      expect(reportFor(entry.xml).findings).toEqual([]);
    });
  }

  it("passes the eight shipped files that carry no BorrowerCount", () => {
    // The qualifier on the borrower-count check is not a hedge: every FHA file
    // and every VA file omits the figure entirely, so a check that required it
    // would refuse eight of the eighteen.
    const without = samples.filter((entry) => !entry.xml.includes("<BorrowerCount>"));
    expect(without.map((entry) => entry.name.slice(0, 8)).sort()).toEqual([
      "DI-FHA01",
      "DI-FHA02",
      "DI-FHA03",
      "DI-FHA04",
      "DI-VA01_",
      "DI-VA02_",
      "DI-VA03_",
      "DI-VA04_",
    ]);
    for (const entry of without) expect(reportFor(entry.xml).ok).toBe(true);
  });
});

describe("every check has a casefile that trips it", () => {
  for (const fixture of FIXTURES) {
    it(fixture.title, () => {
      const report = reportFor(fixture.xml(), fixture.identities ?? []);
      const matching = report.findings.filter(
        (finding) =>
          finding.check === fixture.check &&
          (fixture.where === undefined || finding.where === fixture.where) &&
          (fixture.matches === undefined ||
            fixture.matches.test(`${finding.where} ${finding.message}`)),
      );
      expect(matching.length).toBeGreaterThan(0);
      expect(report.ok).toBe(false);
      expect(report.findings.map((finding) => finding.check)).toEqual([
        fixture.check,
        ...(fixture.also ?? []),
      ]);
    });
  }

  it("leaves no check without one", () => {
    // The direction that rots. A predicate added to the gate with no casefile
    // behind it is a predicate nobody would notice going quiet, and the list it
    // is measured against is the report's own type rather than a copy here.
    expect(CHECKS.length).toBeGreaterThan(10);
    const covered = new Set(FIXTURES.map((fixture) => fixture.check));
    expect(CHECKS.filter((check) => !covered.has(check))).toEqual([]);
    expect([...covered].filter((check) => !CHECKS.includes(check))).toEqual([]);
  });

  it("changes something in every one of them", () => {
    // A fixture that stopped editing its sample would be a check tested by a
    // correct document, and the edit helpers throw rather than return the
    // sample unchanged — which is what this is asserting they do.
    for (const fixture of FIXTURES) {
      if (fixture.check === "identity-unmatched") continue;
      const original = samples.find((entry) => fixture.xml() === entry.xml);
      expect(original).toBeUndefined();
    }
  });
});

describe("what the schema would have caught anyway", () => {
  for (const fixture of FIXTURES.filter((entry) => !entry.schemaCatchesItToo)) {
    it(`libxml2 accepts the casefile behind "${fixture.title}"`, () => {
      expect(xmllintErrors(fixture.xml())).toEqual([]);
    });
  }

  for (const fixture of FIXTURES.filter((entry) => entry.schemaCatchesItToo)) {
    it(`libxml2 refuses the casefile behind "${fixture.title}" too`, () => {
      const errors = xmllintErrors(fixture.xml());
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.join("\n")).toMatch(fixture.schemaCatchesItToo);
    });
  }

  it("names the two the schema refuses too, and no others", () => {
    // Both are disclosed rather than quietly left off the list, and the list
    // being two long is what makes the claim above worth anything: the DU
    // wrapper bounds verifications at fifty where it leaves parties,
    // borrowers, assets and liabilities unbounded, and `xs:date` is the one
    // lexical type in this gate the schema polices as well as we do.
    expect(
      FIXTURES.filter((entry) => entry.schemaCatchesItToo).map((entry) => entry.check),
    ).toEqual(["container-above-maximum", "value-malformed"]);
  });
});

describe("a refusal is safe to read", () => {
  /** Every taxpayer identifier and date of birth in one casefile. */
  const secretsIn = (xml) =>
    ["TaxpayerIdentifierValue", "BorrowerBirthDate"].flatMap((element) =>
      [...xml.matchAll(new RegExp(`<${element}>([^<]+)<`, "g"))].map((match) => match[1]),
    );

  it("names no taxpayer identifier and no date of birth", () => {
    // Read out of each fixture's OWN casefile rather than out of the corpus,
    // because one of the fixtures trips a check that is about a taxpayer
    // identifier: a message that quoted what it did not like would put the one
    // thing this system keeps out of Postgres into a refusal somebody pastes
    // into a ticket. What a finding carries is an XPath, a label or a row id.
    let checked = 0;
    for (const fixture of FIXTURES) {
      const xml = fixture.xml();
      const secrets = secretsIn(xml);
      expect(secrets.length).toBeGreaterThan(0);
      const said = reportFor(xml, fixture.identities ?? [])
        .findings.map((finding) => `${finding.where} ${finding.message}`)
        .join("\n");
      expect(said.length).toBeGreaterThan(0);
      expect(secrets.filter((secret) => said.includes(secret))).toEqual([]);
      checked += secrets.length;
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe("the only way out", () => {
  it("keeps the serializer off the package's public surface", async () => {
    // This is what makes "there is no argument that turns the gate off" true of
    // the module and not only of one function in it: a caller holding both the
    // assembler and a serializer can compose them and get bytes no check ever
    // saw. The door for a test that needs ungated bytes is under `__tests__`,
    // out of the package's exports map, where nothing shipped can reach it.
    const surface = Object.keys(await import("../index.ts"));
    expect(surface).toContain("emitSubmission");
    expect(surface).toContain("assembleSubmission");
    expect(surface).not.toContain("emitDocument");
  });
});

describe("what the gate keeps, counted", () => {
  it("keeps eighty-eight conditional rules and names the two it cannot scope", () => {
    // Both halves matter. The first is what the checking is worth: a
    // specification change that made every statement unfalsifiable would leave
    // this check green and empty. The second is the exception list, which is
    // an exception list precisely because it is short enough to count.
    expect(CONDITIONAL_RULES).toEqual({ enforced: 88, unscopedByFormField: 2 });
  });

  it("keeps forty-three unconditional rules and names what it cannot ask", () => {
    // The same two halves as the conditional count, for the same reason. A
    // reading of the required column that dropped the scopes would refuse
    // Fannie Mae's own suite; a reading that dropped the rules would leave a
    // casefile with no date of birth, no first name and no taxpayer identifier
    // value passing both this gate and the schema.
    expect(REQUIRED_RULES).toEqual({
      enforced: 43,
      askedOnlyOfAScope: 11,
      absentFromShippedCasefiles: 2,
    });
  });

  it("checks a value against the list the generator joined it to", () => {
    // The generated enumeration table is keyed by the enum a column holds and
    // this gate needs the other direction, so the two are one table joined on
    // the data point. Pinned here rather than trusted: a destination that
    // pointed at the wrong enum would refuse lawful casefiles, and a spelling
    // that drifted would check nothing at all.
    for (const [destination, enumName] of Object.entries(DU_SUBSET_AT)) {
      const dataPoint = destination.slice(destination.indexOf("#") + 1);
      const entry = DU_DATA_POINT_FOR_ENUM[enumName];
      expect(entry, `${enumName} is not an enum the generator maps`).toBeDefined();
      expect((entry.dataPoints ?? []).map((row) => row.name)).toContain(dataPoint);
      expect(DU_ENUMERATIONS[enumName].length).toBeGreaterThan(0);
      const formats = Object.entries(DU_FORMATS).filter(([key]) =>
        key.startsWith(`${destination}#`),
      );
      expect(formats.length, `${destination} is not a destination the Map carries`).toBeGreaterThan(
        0,
      );
      for (const [, format] of formats) {
        expect(["enumerated", "string_enumerated"]).toContain(format.kind);
      }
    }
  });

  it("accounts for every destination the corpus can carry an enumerated value at", () => {
    // The direction that rots: a data point the specification files at a second
    // destination would otherwise go unchecked and nothing would say so.
    // Destinations outside the DEAL are not this gate's — the message-level
    // parties block is neither emitted nor checked here.
    const unaccounted = [];
    for (const [enumName, entry] of Object.entries(DU_DATA_POINT_FOR_ENUM)) {
      if (entry.local) continue;
      for (const dataPoint of entry.dataPoints) {
        for (const key of Object.keys(DU_FORMATS)) {
          const [xpath, name] = key.split("#");
          if (name !== dataPoint.name || !xpath.startsWith(`${DEAL}/`)) continue;
          const destination = `${xpath}#${name}`;
          if (DU_SUBSET_AT[destination] || NOT_CHECKED_AGAINST_A_SUBSET.includes(destination)) {
            continue;
          }
          unaccounted.push(`${enumName} ${destination}`);
        }
      }
    }
    expect(unaccounted).toEqual([]);
  });
});
