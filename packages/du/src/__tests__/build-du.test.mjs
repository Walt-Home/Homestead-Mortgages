/**
 * The generator's promises, tested against rows this file makes up.
 *
 * Every fixture below is synthetic on purpose. Fannie Mae's workbook and
 * MISMO's reference model are not in this repository and must not be, so a test
 * that reads them would only run on a machine that happens to have them — which
 * is no test at all. What these assert is the machinery: that an unrecognized
 * phrase stops the build, that a blank cell nobody named stops the build, that
 * a child the schema does not declare stops the build. The facts derived FROM
 * the spec are asserted in generated.test.ts, against the committed tables.
 *
 * The tests live here rather than beside the script because this is where
 * `npm test` reaches them.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARCROLE_SECTIONS,
  ASSET_TYPE_SECTIONS,
  BLANK_ENUMERATION_CELLS,
  COLUMN_NAME_ALIASES,
  DU_DATA_POINT_FOR_ENUM,
  TAB_DISAGREEMENTS,
  UNPARSEABLE_STATEMENTS,
  arcRoleColumnNamesFor,
  arcRolesInCorpus,
  assetTypeListsInMigration,
  buildOrderTable,
  checkTabDisagreements,
  deriveArcRoles,
  deriveAssetTypeSections,
  deriveEnumerations,
  diffAssetTypeChecks,
  diffPrismaEnums,
  parseCardinality,
  parseConditionality,
  parseFormat,
  parseGeneratedArcRoles,
  parseGeneratedAssetTypeSections,
  parseGeneratedOrder,
  prismaEnums,
  resolveSpecFiles,
} from "../../../../scripts/build-du.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCRIPT = resolve(ROOT, "scripts/build-du.mjs");
const PRISMA_SCHEMA = "packages/db/prisma/schema.prisma";
const ASSET_MIGRATION =
  "packages/db/prisma/migrations/20260913110000_an_asset_has_an_owner/migration.sql";

/** One row of the DU Enumerations tab. */
function enumerationRow(dataPoint, formFieldId, value, extra = {}) {
  return {
    rowNumber: 1,
    formFieldId,
    formFieldName: "Test Field",
    dataPoint,
    value,
    ediCode: "",
    ...extra,
  };
}

/** One row of the DU Map. */
function mapRow(dataPoint, formFieldId, extra = {}) {
  return {
    rowNumber: 1,
    formFieldId,
    formFieldName: "Test Field",
    xpath: "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL",
    dataPoint,
    attribute: "",
    format: "Enumerated",
    du: "R",
    conditionality: "",
    ...extra,
  };
}

/** Run the generator the way a developer or CI does, with the env it is given. */
function runScript(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
}

describe("the spec directory", () => {
  it("says what to do when DU_SPEC_DIR is unset", () => {
    expect(() => resolveSpecFiles({})).toThrow(/DU_SPEC_DIR is not set/);
    expect(() => resolveSpecFiles({})).toThrow(/DU_SPEC_DIR='\/path\/to\/DU Integration'/);
  });

  it("names the files it cannot find", () => {
    expect(() => resolveSpecFiles({ DU_SPEC_DIR: "/nonexistent" })).toThrow(
      /DU_Specification v1\.9\.3\.xlsx/,
    );
  });

  it("asks for the workbook and not for the vendored XSDs", () => {
    // The variable named five files once. Four of them are now in
    // packages/du-schema/xsd, and a message still demanding them would send
    // somebody hunting for a corpus to satisfy a check that no longer reads it.
    const message = (() => {
      try {
        resolveSpecFiles({});
        return "";
      } catch (error) {
        return error.message;
      }
    })();
    expect(message).toMatch(/DU_Specification v1\.9\.3\.xlsx/);
    expect(message).not.toMatch(/\.xsd/);
  });

  it("separates an unset variable from one pointing somewhere wrong", () => {
    // Two different events wearing one error class. Unset is a machine without
    // the licensed workbook; set-but-wrong is somebody who asked for the check
    // and typo'd the path, and reporting that as an absent workbook is how a
    // green build comes to have verified less than it looked like.
    expect(() => resolveSpecFiles({})).toThrow(expect.objectContaining({ unset: true }));
    expect(() => resolveSpecFiles({ DU_SPEC_DIR: "/nonexistent" })).toThrow(
      expect.objectContaining({ unset: false }),
    );
  });
});

describe("--verify without the workbook", () => {
  it("still checks the vendored chain and the vendored samples, and says what it skipped", () => {
    // The vendored corpus is what makes this more than a skip: element order
    // comes back out of the XSDs and the arcs' corpus column out of the
    // eighteen samples, both on a machine with no workbook at all. So the
    // message names what did NOT get checked rather than calling the whole
    // regeneration check skipped.
    const result = runScript(["--verify"], {});
    expect(result.stdout).toMatch(/child sequences in order\.ts match the vendored MISMO chain/);
    expect(result.stdout).toMatch(/arcroles in arcroles\.ts are exercised by the vendored samples/);
    expect(result.stdout).toMatch(
      /skipped the workbook check \(enums, lengths, cardinality, conditionality, and the arcroles' endpoints\): DU_SPEC_DIR is not set/,
    );
    expect(result.status).toBe(0);
  });

  it("is described by the comment the deploy workflow runs it under", () => {
    // That comment presents itself as the exhaustive list of what this step
    // checks without the workbook, and it is what gets believed — the step's
    // own output scrolls past in a CI log nobody reads twice. So the list is
    // derived from the run rather than trusted beside it: every committed file
    // the always-run checks name has to appear in the comment, and so does the
    // tail of the skip line.
    const workflow = readFileSync(resolve(ROOT, ".github/workflows/deploy.yml"), "utf8");
    const lines = workflow.split("\n");
    const step = lines.findIndex((line) => line.includes("name: DU tables match the spec"));
    expect(step).toBeGreaterThan(-1);
    let first = step;
    while (first > 0 && /^\s*(#|$)/.test(lines[first - 1])) first -= 1;
    const comment = lines.slice(first, step).join(" ").replace(/\s+/g, " ");

    const result = runScript(["--verify"], {});
    const checked = new Set(
      result.stdout
        .split("\n")
        .filter((line) => line.startsWith("✓"))
        .flatMap((line) => [...line.matchAll(/\b[a-z_]+\.(?:ts|prisma)\b/g)].map((m) => m[0])),
    );
    expect(checked.size).toBeGreaterThan(2);
    for (const file of checked) {
      expect(comment, `${file} is checked without the workbook and the comment omits it`).toContain(
        file,
      );
    }
    expect(comment).toContain("the arcroles' endpoints");
  });

  it("fails, and lists the files, when DU_SPEC_DIR points somewhere wrong", () => {
    const result = runScript(["--verify"], { DU_SPEC_DIR: "/nonexistent" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/DU_SPEC_DIR is set to "\/nonexistent"/);
    // The whole message, not its first line: the list of what is missing is
    // the only part that says what to do about it.
    expect(result.stderr).toMatch(/DU_Specification v1\.9\.3\.xlsx/);
    expect(result.stderr).toMatch(/unset DU_SPEC_DIR to skip/);
  });
});

describe("the workbook's own column list", () => {
  it("names the two headings the two places spell differently", () => {
    // An alias is a hole in the check that stops a renamed or reordered column
    // from being read as the column beside it, so the count is part of the
    // promise: two headings need one, and a third arriving needs a reader.
    expect(Object.entries(COLUMN_NAME_ALIASES)).toEqual([
      ["DU, Credit, Early Check Cardinality MIN:MAX", "DU, EC Cardinality MIN:MAX"],
      ["ArcRole", "ArcRoles"],
    ]);
  });

  it("splits the ArcRoles tab's two column lists rather than concatenating them", () => {
    // That tab is two tables under one heading. Read as one list, the second
    // table's headings would be compared against the first table's columns, and
    // the check that stops a reordered column would be checking nothing.
    const description = [
      { number: 1, cells: ["", "ArcRoles Tab", ""] },
      { number: 2, cells: ["", "Establishing Endpoints in the Relationship", ""] },
      { number: 3, cells: ["", "Column Name", "Column Definition"] },
      { number: 4, cells: ["", "ArcRoles", "The name of the ArcRole."] },
      { number: 5, cells: ["", "Source", "The source container."] },
      { number: 6, cells: ["", "Relationships Container", ""] },
      { number: 7, cells: ["", "Column Name", "Column Definition"] },
      { number: 8, cells: ["", "Value", "The name of the ArcRole."] },
      { number: 9, cells: ["", "DU Removals Tab*", ""] },
      { number: 10, cells: ["", "Field ID", "The reference number."] },
    ];
    expect(arcRoleColumnNamesFor(description, ARCROLE_SECTIONS)).toEqual({
      endpoints: ["ArcRoles", "Source"],
      relationships: ["Value"],
    });
  });
});

describe("conditionality", () => {
  it("parses the statement shapes the sheet uses", () => {
    expect(parseConditionality("IF exists")).toEqual({ kind: "self_exists" });
    expect(parseConditionality('IF LiabilityType = "Other"')).toEqual({
      kind: "compare",
      dataPoint: "LiabilityType",
      operator: "=",
      value: "Other",
    });
    expect(parseConditionality("IF PurchaseCreditType does not exist")).toEqual({
      kind: "absent",
      dataPoint: "PurchaseCreditType",
    });
    expect(parseConditionality('IF AssetType = "GiftOfCash" OR "Grant"')).toEqual({
      kind: "in",
      dataPoint: "AssetType",
      values: ["GiftOfCash", "Grant"],
    });
    // A bare data point in an OR chain is an existence test, and a lower-case
    // "and" is the same keyword as an upper-case one.
    expect(parseConditionality("IF NoteAmount OR HELOCMaximumBalanceAmount exists")).toEqual({
      kind: "or",
      terms: [
        { kind: "exists", dataPoint: "NoteAmount" },
        { kind: "exists", dataPoint: "HELOCMaximumBalanceAmount" },
      ],
    });
    expect(parseConditionality('IF ConstructionMethodType = "Manufactured" and exists')).toEqual({
      kind: "and",
      terms: [
        {
          kind: "compare",
          dataPoint: "ConstructionMethodType",
          operator: "=",
          value: "Manufactured",
        },
        { kind: "self_exists" },
      ],
    });
  });

  it("reads the sheet's curly quotes and trailing full stops", () => {
    expect(parseConditionality("IF RefinanceCashOutDeterminationType = “CashOut”")).toEqual({
      kind: "compare",
      dataPoint: "RefinanceCashOutDeterminationType",
      operator: "=",
      value: "CashOut",
    });
    expect(parseConditionality('IF LoanPurposeType = "Purchase" AND exists.')).toEqual({
      kind: "and",
      terms: [
        { kind: "compare", dataPoint: "LoanPurposeType", operator: "=", value: "Purchase" },
        { kind: "self_exists" },
      ],
    });
  });

  it("throws on a phrase nobody has written down", () => {
    // The prose in the sheet's one unparseable statement, on its own: a range
    // written as English rather than as an expression.
    expect(() => parseConditionality("IF FinancedUnitCount > 1 but <5")).toThrow(
      /Unrecognized conditionality phrase/,
    );
    expect(() => parseConditionality("IF BorrowerAgeYears BETWEEN 18 AND 65")).toThrow(
      /Unrecognized conditionality phrase/,
    );
    // A character the lexer has no token for, rather than a word it cannot
    // place: the two are different refusals and both have to happen.
    expect(() => parseConditionality("IF Borrower% = 3")).toThrow(
      /Unrecognized conditionality phrase/,
    );
    expect(() => parseConditionality('BorrowerResidencyType = "Current"')).toThrow(
      /does not start with IF/,
    );
  });

  it("takes the one statement the grammar cannot, from the named list", () => {
    const named = UNPARSEABLE_STATEMENTS[0];
    expect(named.statement).toMatch(/but <5/);
    expect(parseConditionality(named.statement)).toEqual(named.condition);
  });
});

describe("enumerations", () => {
  it("strips footnote markers and never corrects a spelling", () => {
    const rows = [
      enumerationRow("ExpenseType", "2d.1", "Alimony"),
      enumerationRow("ExpenseType", "2d.1", "ChildSupport**"),
      // Double lowercase i. Canonical in MISMOEnumeratedTypesB324.xsd itself.
      enumerationRow("ExpenseType", "2d.1", "AccessoryUnitIincome*"),
    ];
    const { enumerations } = deriveEnumerations(rows, {
      table: { DuExpenseType: { dataPoints: [{ name: "ExpenseType", formFields: ["2d.1"] }] } },
      disagreements: [],
      blanks: [],
      notInScope: [],
    });
    expect(enumerations.DuExpenseType).toEqual(["Alimony", "ChildSupport", "AccessoryUnitIincome"]);
  });

  it("derives DuAssetType to 22 members from 23 rows", () => {
    // The AssetType block of the tab: thirteen rows at 2a.1, seven at 2b.1 —
    // two of them the same "Other" — and three at 4d.1.
    const values = [
      ["2a.1", "Bond"],
      ["2a.1", "BridgeLoanNotDeposited"],
      ["2a.1", "CertificateOfDepositTimeDeposit"],
      ["2a.1", "CheckingAccount"],
      ["2a.1", "IndividualDevelopmentAccount**"],
      ["2a.1", "LifeInsurance"],
      ["2a.1", "MoneyMarketFund"],
      ["2a.1", "MutualFund"],
      ["2a.1", "RetirementFund"],
      ["2a.1", "SavingsAccount"],
      ["2a.1", "Stock"],
      ["2a.1", "StockOptions**"],
      ["2a.1", "TrustAccount"],
      ["2b.1", "CashOnHand"],
      ["2b.1", "Other"],
      ["2b.1", "Other"],
      ["2b.1", "PendingNetSaleProceedsFromRealEstateAssets"],
      ["2b.1", "ProceedsFromSaleOfNonRealEstateAsset**"],
      ["2b.1", "ProceedsFromSecuredLoan"],
      ["2b.1", "ProceedsFromUnsecuredLoan**"],
      ["4d.1", "GiftOfCash"],
      ["4d.1", "GiftOfPropertyEquity"],
      ["4d.1", "Grant"],
    ];
    expect(values).toHaveLength(23);
    const { enumerations } = deriveEnumerations(
      values.map(([formField, value]) => enumerationRow("AssetType", formField, value)),
      {
        table: { DuAssetType: { dataPoints: [{ name: "AssetType", formFields: [] }] } },
        disagreements: [],
        blanks: [],
        notInScope: [],
      },
    );
    expect(enumerations.DuAssetType).toHaveLength(22);
    expect(enumerations.DuAssetType.filter((v) => v === "Other")).toEqual(["Other"]);
  });

  it("throws on a blank cell outside the named exception list", () => {
    const table = {
      DuPropertyUsage: { dataPoints: [{ name: "PropertyCurrentUsageType", formFields: [] }] },
    };
    const rows = [
      enumerationRow("PropertyCurrentUsageType", "", "Investment"),
      enumerationRow("PropertyCurrentUsageType", "", "", { rowNumber: 412, ediCode: "R = Rental" }),
    ];
    expect(() =>
      deriveEnumerations(rows, { table, disagreements: [], blanks: [], notInScope: [] }),
    ).toThrow(/Blank enumeration cell for PropertyCurrentUsageType at row 412/);
    expect(() =>
      deriveEnumerations(rows, { table, disagreements: [], blanks: [], notInScope: [] }),
    ).toThrow(/BLANK_ENUMERATION_CELLS/);
  });

  it("takes the four blanks that are named, and gives both questions Yes and No", () => {
    // Read verbatim, IntentToOccupyType has only No and
    // HomeownerPastThreeYearsType has only Yes. The EDI Code Values column is
    // what says which blank stands for which answer.
    const rows = [
      enumerationRow("IntentToOccupyType", "5a.1", "No", { ediCode: "N = No" }),
      enumerationRow("IntentToOccupyType", "5a.1", "", { ediCode: "U = Unknown" }),
      enumerationRow("IntentToOccupyType", "5a.1", "", { ediCode: "Y = Yes" }),
      enumerationRow("HomeownerPastThreeYearsType", "5a.1.1", "", { ediCode: "N = No" }),
      enumerationRow("HomeownerPastThreeYearsType", "5a.1.1", "", { ediCode: "U = Unknown" }),
      enumerationRow("HomeownerPastThreeYearsType", "5a.1.1", "Yes", { ediCode: "Y = Yes" }),
    ];
    const { enumerations } = deriveEnumerations(rows, {
      table: {
        DuYesNo: {
          dataPoints: [
            { name: "IntentToOccupyType", formFields: ["5a.1"] },
            { name: "HomeownerPastThreeYearsType", formFields: ["5a.1.1"] },
          ],
        },
      },
      disagreements: [],
      blanks: BLANK_ENUMERATION_CELLS,
      notInScope: [],
    });
    expect(enumerations.DuYesNo).toEqual(["No", "Yes"]);
  });

  it("throws when a corrected workbook makes a named blank stale", () => {
    const rows = [enumerationRow("IntentToOccupyType", "5a.1", "No", { ediCode: "N = No" })];
    expect(() =>
      deriveEnumerations(rows, {
        table: { DuYesNo: { dataPoints: [{ name: "IntentToOccupyType", formFields: ["5a.1"] }] } },
        disagreements: [],
        blanks: BLANK_ENUMERATION_CELLS,
        notInScope: [],
      }),
    ).toThrow(/no longer blank/);
  });

  it("throws when two data points behind one enum disagree", () => {
    const rows = [
      enumerationRow("IntentToOccupyType", "5a.1", "Yes"),
      enumerationRow("IntentToOccupyType", "5a.1", "No"),
      enumerationRow("HomeownerPastThreeYearsType", "5a.1.1", "Yes"),
    ];
    expect(() =>
      deriveEnumerations(rows, {
        table: {
          DuYesNo: {
            dataPoints: [
              { name: "IntentToOccupyType", formFields: ["5a.1"] },
              { name: "HomeownerPastThreeYearsType", formFields: ["5a.1.1"] },
            ],
          },
        },
        disagreements: [],
        blanks: [],
        notInScope: [],
      }),
    ).toThrow(/do not agree/);
  });

  it("throws when narrowing an enum leaves a value behind unnamed", () => {
    const rows = [
      enumerationRow("FundsSourceType", "4d.3", "Relative"),
      enumerationRow("FundsSourceType", "", "PropertySeller"),
    ];
    const table = {
      DuFundsSourceType: { dataPoints: [{ name: "FundsSourceType", formFields: ["4d.3"] }] },
    };
    expect(() =>
      deriveEnumerations(rows, { table, disagreements: [], blanks: [], notInScope: [] }),
    ).toThrow(/leaves PropertySeller behind/);
    const { enumerations } = deriveEnumerations(rows, {
      table,
      disagreements: [],
      blanks: [],
      notInScope: [{ enumName: "DuFundsSourceType", values: ["PropertySeller"] }],
    });
    expect(enumerations.DuFundsSourceType).toEqual(["Relative"]);
  });
});

describe("the two tabs disagreeing about a form field", () => {
  // Each of the four is reproduced with two rows: the DU Map's id, and the DU
  // Enumerations tab's different id for the same named field.
  const cases = TAB_DISAGREEMENTS.map((entry) => ({
    entry,
    map: [mapRow(entry.dataPoint, entry.mapFormField)],
    enumerations: [
      enumerationRow(entry.dataPoint, entry.enumerationFormField, "SomeValue"),
      enumerationRow("SomethingElse", entry.mapFormField, "SomeValue"),
    ],
  }));

  it.each(cases)(
    "reconciles $entry.dataPoint $entry.mapFormField",
    ({ entry, map, enumerations }) => {
      expect(() =>
        checkTabDisagreements(map, enumerations, {
          table: {
            Anything: {
              dataPoints: [{ name: map[0].dataPoint, formFields: [map[0].formFieldId] }],
            },
          },
          disagreements: [entry],
        }),
      ).not.toThrow();
    },
  );

  it.each(cases)(
    "throws on $entry.dataPoint $entry.mapFormField when it is not on the list",
    ({ entry, map, enumerations }) => {
      expect(() =>
        checkTabDisagreements(map, enumerations, {
          table: {
            Anything: {
              dataPoints: [{ name: map[0].dataPoint, formFields: [map[0].formFieldId] }],
            },
          },
          disagreements: TAB_DISAGREEMENTS.filter((d) => d !== entry),
        }),
      ).toThrow(/has no such row/);
    },
  );

  it("refuses to reconcile two ids the tabs give different names", () => {
    const entry = TAB_DISAGREEMENTS[0];
    expect(() =>
      checkTabDisagreements(
        [mapRow(entry.dataPoint, entry.mapFormField, { formFieldName: "Type" })],
        [
          enumerationRow(entry.dataPoint, entry.enumerationFormField, "FHA", {
            formFieldName: "Mortgage Type Applied For",
          }),
        ],
        {
          table: { Anything: { dataPoints: [{ name: entry.dataPoint, formFields: [] }] } },
        },
      ),
    ).toThrow(/disagree about more than the number/);
  });
});

describe("child order", () => {
  // A schema stub in the shape parseSchemas produces: a type name, and its
  // children in the order the sequence declares them.
  const schema = {
    childrenOf(type) {
      const types = {
        MESSAGE: [{ name: "DEAL_SETS", type: "DEAL_SETS", prefix: "" }],
        DEAL_SETS: [{ name: "DEAL_SET", type: "DEAL_SET", prefix: "" }],
        DEAL_SET: [
          { name: "PARTIES", type: "PARTIES", prefix: "" },
          { name: "DEALS", type: "DEALS", prefix: "" },
          { name: "EXTENSION", type: "DEAL_SET_EXTENSION", prefix: "" },
        ],
        DEALS: [],
        DEAL_SET_EXTENSION: [],
        PARTIES: [{ name: "PARTY", type: "PARTY", prefix: "" }],
        PARTY: [
          { name: "REFERENCE", type: "REFERENCE", prefix: "" },
          { name: "INDIVIDUAL", type: "INDIVIDUAL", prefix: "" },
          { name: "ROLES", type: "ROLES", prefix: "" },
          { name: "EXTENSION", type: "PARTY_EXTENSION", prefix: "" },
        ],
        REFERENCE: [],
        INDIVIDUAL: [],
        ROLES: [],
        PARTY_EXTENSION: [],
      };
      return types[type] ?? null;
    },
  };

  it("reads the order out of the schema rather than sorting it", () => {
    const { order } = buildOrderTable(schema, ["MESSAGE/DEAL_SETS/DEAL_SET/PARTIES/PARTY"]);
    // PARTY is where the walk ends and DEAL_SET is one it passes through. Both
    // orders are recorded, and neither is sorted.
    expect(order.get("PARTY")).toEqual(["REFERENCE", "INDIVIDUAL", "ROLES", "EXTENSION"]);
    expect(order.get("DEAL_SET")).toEqual(["PARTIES", "DEALS", "EXTENSION"]);
  });

  it("throws on a child name the complex type does not declare", () => {
    expect(() =>
      buildOrderTable(schema, ["MESSAGE/DEAL_SETS/DEAL_SET/PARTIES/PARTY/BORROWER"]),
    ).toThrow(/PARTY does not declare a child named "BORROWER"/);
  });

  it("throws on a path that does not start at MESSAGE", () => {
    expect(() => buildOrderTable(schema, ["DEAL_SETS/DEAL_SET"])).toThrow(/does not start at/);
  });
});

describe("reading the committed order table back", () => {
  // The XPath list the schema-order check walks comes out of the committed
  // file, because the workbook that named those XPaths is not on every machine.
  // That is what makes the check runnable in CI, and parsing is where it can
  // quietly stop working.
  const source = readFileSync(resolve(ROOT, "packages/du/src/generated/order.ts"), "utf8");

  it("recovers both tables from the file the script writes", () => {
    const { childOrder, typeForPath } = parseGeneratedOrder(source);
    expect(childOrder["ABOUT_VERSIONS"]).toEqual(["ABOUT_VERSION", "EXTENSION"]);
    expect(typeForPath["MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL"]).toBe("DEAL");
  });

  it("stops rather than reading a hand-edited file as an empty table", () => {
    // An empty table would make the diff vacuous, and a vacuous diff is a green
    // tick over a file nobody checked.
    expect(() => parseGeneratedOrder("export const CHILD_ORDER = {\n} as const;")).toThrow(
      /no TYPE_FOR_PATH in the shape this script writes/,
    );
    expect(() => parseGeneratedOrder("// nothing")).toThrow(
      /no CHILD_ORDER in the shape this script writes/,
    );
  });
});

describe("arc roles", () => {
  /**
   * One arc, described the way the ArcRoles tab describes every arc: once in
   * the endpoints section and once as a RELATIONSHIP block. The helpers below
   * bend one field at a time, which is the only way to tell the machinery from
   * the facts the real tab happens to carry.
   */
  const NS = "urn:fdc:mismo.org:2009:residential";
  const RELATIONSHIP = "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/RELATIONSHIPS/RELATIONSHIP";

  function endpointRow(extra = {}) {
    return {
      rowNumber: 4,
      arcRole: "ASSET is associated with LIABILITY",
      fromXPath: "DEAL/ASSETS/ASSET",
      source: "ASSET",
      verbPhrase: "IsAssociatedWith",
      toXPath: "DEAL/LIABILITIES/LIABILITY",
      target: "LIABILITY",
      ...extra,
    };
  }

  function relationshipRows(extra = {}) {
    const name = extra.name ?? "ASSET_IsAssociatedWith_LIABILITY";
    const blank = { arcRole: "", xpath: "", attribute: "", label: "", value: "", notes: "" };
    return [
      { ...blank, rowNumber: 23, arcRole: "ASSET to LIABILITY", xpath: RELATIONSHIP, notes: "If." },
      { ...blank, rowNumber: 24, attribute: "Sequence Number" },
      {
        ...blank,
        rowNumber: 25,
        label: extra.declaration ?? `arcrole="${NS}/${name}"`,
        value: name,
      },
      { ...blank, rowNumber: 26, label: "from", value: extra.from ?? "ASSET" },
      { ...blank, rowNumber: 27, label: "to", value: extra.to ?? "LIABILITY" },
    ];
  }

  const sections = (endpoints, relationships) => ({ endpoints, relationships });
  const corpus = (...uris) => new Map(uris.map((u) => [u, 1]));

  it("joins the tab's two sections into one arc", () => {
    const { table, relationshipXPath } = deriveArcRoles(
      sections([endpointRow()], relationshipRows()),
      corpus(`${NS}/ASSET_IsAssociatedWith_LIABILITY`),
      { disagreements: [] },
    );
    expect(relationshipXPath).toBe(RELATIONSHIP);
    expect(table.ASSET_IsAssociatedWith_LIABILITY).toEqual({
      arcrole: `${NS}/ASSET_IsAssociatedWith_LIABILITY`,
      name: "ASSET_IsAssociatedWith_LIABILITY",
      verbPhrase: "IsAssociatedWith",
      from: {
        xpath: "DEAL/ASSETS/ASSET",
        container: "ASSET",
        relationshipEnd: "ASSET",
        arcroleTerm: "ASSET",
        disputed: false,
      },
      to: {
        xpath: "DEAL/LIABILITIES/LIABILITY",
        container: "LIABILITY",
        relationshipEnd: "LIABILITY",
        arcroleTerm: "LIABILITY",
        disputed: false,
      },
      note: "If.",
      exercised: true,
    });
  });

  it("assembles the URI from the namespace whether the cell holds all of it or not", () => {
    // Four of the eleven blocks type the namespace in the label cell and stop,
    // leaving the name in the cell beside it; the other seven type the whole
    // URI. A generator that copied the cell would emit four URIs ending at
    // ":residential".
    const short = deriveArcRoles(
      sections([endpointRow()], relationshipRows({ declaration: `arcrole="${NS}` })),
      corpus(),
      { disagreements: [] },
    );
    expect(short.table.ASSET_IsAssociatedWith_LIABILITY.arcrole).toBe(
      `${NS}/ASSET_IsAssociatedWith_LIABILITY`,
    );
    expect(() =>
      deriveArcRoles(
        sections([endpointRow()], relationshipRows({ declaration: 'arcrole="urn:example:2020' })),
        corpus(),
        { disagreements: [] },
      ),
    ).toThrow(/is neither/);
  });

  it("marks an arc no sample carries, and refuses one no sample could", () => {
    // The corpus column is the half of this table that is checkable without the
    // workbook, so both directions have to be real.
    const unexercised = deriveArcRoles(sections([endpointRow()], relationshipRows()), corpus(), {
      disagreements: [],
    });
    expect(unexercised.table.ASSET_IsAssociatedWith_LIABILITY.exercised).toBe(false);
    expect(() =>
      deriveArcRoles(
        sections([endpointRow()], relationshipRows()),
        corpus(`${NS}/INVENTED_IsAssociatedWith_ROLE`),
        { disagreements: [] },
      ),
    ).toThrow(/The vendored samples carry .*INVENTED.*and the ArcRoles tab does not describe it/);
  });

  it("names an end the tab disagrees with itself about, and does not pick one", () => {
    // The trap this table exists for. An emitter handed one name would arc to
    // the wrong element and validate anyway, because nothing in the XSD checks
    // where an arc lands.
    const disputed = deriveArcRoles(
      sections(
        [endpointRow({ target: "OWNED_PROPERTY_DETAIL" })],
        relationshipRows({ to: "LIABILITY" }),
      ),
      corpus(),
      { disagreements: [{ arcrole: "ASSET_IsAssociatedWith_LIABILITY", end: "to" }] },
    ).table.ASSET_IsAssociatedWith_LIABILITY;
    expect(disputed.to).toEqual({
      xpath: "DEAL/LIABILITIES/LIABILITY",
      container: "OWNED_PROPERTY_DETAIL",
      relationshipEnd: "LIABILITY",
      arcroleTerm: "LIABILITY",
      disputed: true,
    });
  });

  it("stops on a disagreement nobody has read, and on one that healed", () => {
    expect(() =>
      deriveArcRoles(
        sections([endpointRow({ target: "OWNED_PROPERTY_DETAIL" })], relationshipRows()),
        corpus(),
        { disagreements: [] },
      ),
    ).toThrow(/ASSET_IsAssociatedWith_LIABILITY to.*Do not pick one/s);
    expect(() =>
      deriveArcRoles(sections([endpointRow()], relationshipRows()), corpus(), {
        disagreements: [{ arcrole: "ASSET_IsAssociatedWith_LIABILITY", end: "from" }],
      }),
    ).toThrow(/names ends the tab now agrees about/);
  });

  it("reads a prefix and a predicate as the element they name", () => {
    // DU:UNDERWRITING_VERIFICATION and ROLE[PartyRoleType = "Borrower"] are the
    // same elements the other three columns spell bare, and comparing them
    // verbatim would report nine of the eleven arcs as disputed.
    const arc = deriveArcRoles(
      sections(
        [
          endpointRow({
            arcRole: "LOAN is associated with ROLE",
            fromXPath: 'DEAL/LOANS/LOAN[LoanRoleType="RelatedLoan"]',
            source: "LOAN",
            toXPath: 'DEAL/PARTIES/PARTY/ROLE[PartyRoleType = "NotePayTo"]',
            target: "ROLE",
          }),
        ],
        relationshipRows({ name: "LOAN_IsAssociatedWith_ROLE", from: "LOAN", to: "ROLE" }),
      ),
      corpus(),
      { disagreements: [] },
    ).table.LOAN_IsAssociatedWith_ROLE;
    expect(arc.from.disputed).toBe(false);
    expect(arc.to.disputed).toBe(false);
    expect(arc.from.xpath).toBe('DEAL/LOANS/LOAN[LoanRoleType="RelatedLoan"]');
  });

  it("throws on a verb phrase, an attribute and a label it does not recognize", () => {
    // The generator's rule, applied to this tab: an arc the spec grows a new
    // vocabulary for stops the build rather than landing as a default.
    expect(() =>
      deriveArcRoles(
        sections([endpointRow({ verbPhrase: "IsOwnedBy" })], relationshipRows()),
        corpus(),
        { disagreements: [] },
      ),
    ).toThrow(/unrecognized Verb Phrase "IsOwnedBy"/);
    const withAttribute = relationshipRows();
    withAttribute[1] = { ...withAttribute[1], attribute: "Label Number" };
    expect(() =>
      deriveArcRoles(sections([endpointRow()], withAttribute), corpus(), { disagreements: [] }),
    ).toThrow(/unrecognized Attribute "Label Number"/);
    const withLabel = relationshipRows();
    withLabel[3] = { ...withLabel[3], label: "through" };
    expect(() =>
      deriveArcRoles(sections([endpointRow()], withLabel), corpus(), { disagreements: [] }),
    ).toThrow(/unrecognized xLink:label row "through"/);
  });

  it("stops when the two sections do not cover the same arcs", () => {
    // Either section can grow a row the other does not have, and each is a
    // different kind of half-described arc. Neither may be dropped quietly.
    expect(() =>
      deriveArcRoles(sections([], relationshipRows()), corpus(), { disagreements: [] }),
    ).toThrow(/has a RELATIONSHIP block and no endpoints row/);
    expect(() =>
      deriveArcRoles(
        sections([endpointRow({ arcRole: "EXPENSE is associated with ROLE" })], relationshipRows()),
        corpus(),
        { disagreements: [] },
      ),
    ).toThrow(/describes the endpoints of EXPENSE_IsAssociatedWith_ROLE/);
    const noTo = relationshipRows().slice(0, -1);
    expect(() =>
      deriveArcRoles(sections([endpointRow()], noTo), corpus(), { disagreements: [] }),
    ).toThrow(/ASSET_IsAssociatedWith_LIABILITY has no to row/);
  });

  it("stops when the prose and the Verb Phrase column disagree", () => {
    // The prose is what joins the two sections, and it is the only column that
    // names the same element the arcrole URI does. Reading it loosely is how a
    // row joins an arc that is not its own.
    expect(() =>
      deriveArcRoles(
        sections([endpointRow({ arcRole: "ASSET belongs to LIABILITY" })], relationshipRows()),
        corpus(),
        { disagreements: [] },
      ),
    ).toThrow(/spells the verb phrase "belongsto"/);
  });

  it("recovers the committed table, and stops rather than reading a hand-edit as empty", () => {
    const source = readFileSync(resolve(ROOT, "packages/du/src/generated/arcroles.ts"), "utf8");
    const table = parseGeneratedArcRoles(source);
    expect(table.ASSET_IsAssociatedWith_ROLE.arcrole).toBe(`${NS}/ASSET_IsAssociatedWith_ROLE`);
    expect(() => parseGeneratedArcRoles("// nothing")).toThrow(
      /no DU_ARCROLES in the shape this script writes/,
    );
  });

  it("finds the arcroles the vendored samples carry", () => {
    const counts = arcRolesInCorpus();
    expect(counts.get(`${NS}/ASSET_IsAssociatedWith_ROLE`)).toBeGreaterThan(0);
    expect(counts.has(`${NS}/UNDERWRITING_VERIFICATION_IsAssociatedWith_ASSET`)).toBe(false);
  });
});

describe("formats and cardinality", () => {
  it("parses the widths the sheet writes", () => {
    expect(parseFormat("String 35")).toEqual({ kind: "string", maxLength: 35 });
    expect(parseFormat("Amount 9.2")).toEqual({ kind: "amount", digits: 9, decimals: 2 });
    expect(parseFormat("Numeric 9")).toEqual({ kind: "numeric", digits: 9 });
    expect(parseFormat("String  (DU Enumerated)")).toEqual({ kind: "string_enumerated" });
  });

  it("throws rather than guessing a width", () => {
    expect(() => parseFormat("String")).toThrow(/Unrecognized DU Data Point Format/);
    expect(() => parseFormat("Text 35")).toThrow(/Do not guess a width/);
  });

  it("reads MIN:MAX and N/A", () => {
    expect(parseCardinality("0:50", "MESSAGE")).toEqual({ min: 0, max: 50 });
    expect(parseCardinality("N/A", "MESSAGE")).toBeNull();
    expect(() => parseCardinality("0-50", "MESSAGE")).toThrow(/Unrecognized cardinality/);
    expect(() => parseCardinality("5:1", "MESSAGE")).toThrow(/minimum above its maximum/);
  });
});

describe("the Prisma enum diff", () => {
  const schema = `
enum FlowStage {
  PROPERTY_LOAN
}

enum DuExpenseType {
  Alimony
  ChildSupport // the one the sheet spells out
}
`;

  it("finds every Du* enum in schema.prisma and nothing else", () => {
    expect(prismaEnums(schema)).toEqual({ DuExpenseType: ["Alimony", "ChildSupport"] });
  });

  it("fails on a member with no row in the spec", () => {
    // The shape of the defect this check exists for: a value in a block that
    // claimed to be generated, and in no tab of the spec.
    const problems = diffPrismaEnums(
      { DuAssetType: ["CheckingAccount", "SecuredBorrowedFundsNotDeposited"] },
      { DuAssetType: ["CheckingAccount"] },
      [],
    );
    expect(problems).toEqual([
      "DuAssetType.SecuredBorrowedFundsNotDeposited has no row in the DU Enumerations tab.",
    ]);
  });

  it("fails in the other direction too", () => {
    const problems = diffPrismaEnums(
      { DuAssetType: ["CheckingAccount"] },
      { DuAssetType: ["CheckingAccount", "SavingsAccount"] },
      [],
    );
    expect(problems).toEqual([
      "DuAssetType is missing SavingsAccount, which the DU Enumerations tab carries.",
    ]);
  });

  it("fails on an enum absent from DU_DATA_POINT_FOR_ENUM", () => {
    expect(diffPrismaEnums({ DuInvented: ["Whatever"] }, {}, [])).toEqual([
      "DuInvented is not in DU_DATA_POINT_FOR_ENUM. Give it a DU data point, or declare it local.",
    ]);
  });

  it("skips an enum that is declared ours", () => {
    expect(diffPrismaEnums({ DuAssetKind: ["Anything"] }, {}, ["DuAssetKind"])).toEqual([]);
  });

  it("passes when they agree", () => {
    expect(
      diffPrismaEnums({ DuExpenseType: ["Alimony"] }, { DuExpenseType: ["Alimony"] }, []),
    ).toEqual([]);
  });
});

describe("DU_DATA_POINT_FOR_ENUM", () => {
  it("declares every form field a Du* column in schema.prisma names", () => {
    // The way this table goes quietly wrong: a column carries one DU data
    // point, its enum is mapped to a DIFFERENT one whose members happen to
    // agree today, and the diff passes without ever checking the column's own
    // field. The doc comment above each column names the form field, so that
    // is what this reads.
    const schema = readFileSync(resolve(ROOT, "packages/db/prisma/schema.prisma"), "utf8");
    const declared = (name) =>
      new Set((DU_DATA_POINT_FOR_ENUM[name]?.dataPoints ?? []).flatMap((d) => d.formFields));

    let pending = [];
    let checked = 0;
    for (const raw of schema.split("\n")) {
      const line = raw.trim();
      const comment = /^\/\/\/\s+(\d[a-z]?(?:\.\d+)+)\.\s/.exec(line);
      if (comment) {
        pending.push(comment[1]);
        continue;
      }
      const field = /^[a-z]\w*\s+(Du[A-Za-z]+)\??\s/.exec(line);
      if (field && pending.length > 0) {
        const formFields = [...declared(field[1])];
        for (const formField of pending) {
          expect(formFields, `${field[1]} at ${formField}`).toContain(formField);
          checked += 1;
        }
      }
      if (!line.startsWith("///")) pending = [];
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("gives every enum either a data point or a declaration that it is ours", () => {
    for (const [name, spec] of Object.entries(DU_DATA_POINT_FOR_ENUM)) {
      expect(name).toMatch(/^Du[A-Z]/);
      if (spec.local) {
        expect(spec.dataPoints).toBeUndefined();
        continue;
      }
      expect(spec.dataPoints.length).toBeGreaterThan(0);
      for (const dataPoint of spec.dataPoints) {
        expect(typeof dataPoint.name).toBe("string");
        expect(Array.isArray(dataPoint.formFields)).toBe(true);
      }
    }
  });
});

describe("the AssetType partition, and the CHECKs that carry it", () => {
  /** The AssetType block of the tab: thirteen at 2a.1, six at 2b.1, three at 4d.1. */
  const ASSET_TYPE_ROWS = [
    ["2a.1", "Bond"],
    ["2a.1", "BridgeLoanNotDeposited"],
    ["2a.1", "CertificateOfDepositTimeDeposit"],
    ["2a.1", "CheckingAccount"],
    ["2a.1", "IndividualDevelopmentAccount**"],
    ["2a.1", "LifeInsurance"],
    ["2a.1", "MoneyMarketFund"],
    ["2a.1", "MutualFund"],
    ["2a.1", "RetirementFund"],
    ["2a.1", "SavingsAccount"],
    ["2a.1", "Stock"],
    ["2a.1", "StockOptions**"],
    ["2a.1", "TrustAccount"],
    ["2b.1", "CashOnHand"],
    ["2b.1", "Other"],
    ["2b.1", "PendingNetSaleProceedsFromRealEstateAssets"],
    ["2b.1", "ProceedsFromSaleOfNonRealEstateAsset**"],
    ["2b.1", "ProceedsFromSecuredLoan"],
    ["2b.1", "ProceedsFromUnsecuredLoan**"],
    ["4d.1", "GiftOfCash"],
    ["4d.1", "GiftOfPropertyEquity"],
    ["4d.1", "Grant"],
  ];

  const rowsFor = (values) =>
    values.map(([formField, value]) => enumerationRow("AssetType", formField, value));

  it("splits AssetType the way the tab files it, footnote markers and all", () => {
    const sections = deriveAssetTypeSections(rowsFor(ASSET_TYPE_ROWS));
    expect(Object.keys(sections)).toEqual(["2a.1", "2b.1", "4d.1"]);
    expect(sections["2a.1"]).toHaveLength(13);
    expect(sections["2b.1"]).toHaveLength(6);
    expect(sections["4d.1"]).toEqual(["GiftOfCash", "GiftOfPropertyEquity", "Grant"]);
    // The marker is the tab's "new for DU" footnote and not part of the value.
    expect(sections["2a.1"]).toContain("StockOptions");
    expect(sections["2a.1"].join(" ")).not.toMatch(/\*/);
  });

  it("stops on a fourth section rather than dropping its values", () => {
    // A spec revision that files a value under a section no kind reads is a
    // value that would silently belong to no CHECK.
    expect(() =>
      deriveAssetTypeSections(rowsFor([...ASSET_TYPE_ROWS, ["2b.2", "Cryptocurrency"]])),
    ).toThrow(/files AssetType under 2b\.2/);
  });

  it("stops on a section the tab no longer carries", () => {
    expect(() =>
      deriveAssetTypeSections(rowsFor(ASSET_TYPE_ROWS.filter(([field]) => field !== "4d.1"))),
    ).toThrow(/no members at form field 4d\.1/);
  });

  it("reads the three lists out of the migration that carries them", () => {
    const lists = assetTypeListsInMigration(readFileSync(resolve(ROOT, ASSET_MIGRATION), "utf8"));
    expect(lists.du_assets_deposit_account_shape).toHaveLength(13);
    expect(lists.du_assets_other_asset_shape).toHaveLength(6);
    expect(lists.du_assets_gift_or_grant_shape).toEqual([
      "GiftOfCash",
      "GiftOfPropertyEquity",
      "Grant",
    ]);
  });

  it("fails a shape CHECK that constrains the columns and not the type", () => {
    const sql = readFileSync(resolve(ROOT, ASSET_MIGRATION), "utf8").replace(
      /asset_type IN \('CashOnHand',[\s\S]*?'ProceedsFromUnsecuredLoan'\)\n {12}AND /,
      "",
    );
    expect(() => assetTypeListsInMigration(sql)).toThrow(
      /du_assets_other_asset_shape does not name the AssetType values it admits/,
    );
  });

  it("names the value a CHECK admits from the wrong section, and the one it drops", () => {
    const sections = deriveAssetTypeSections(rowsFor(ASSET_TYPE_ROWS));
    const members = Object.values(sections).flat();
    const widened = {
      du_assets_deposit_account_shape: [...sections["2a.1"], "CashOnHand"],
      du_assets_other_asset_shape: sections["2b.1"].filter((v) => v !== "CashOnHand"),
      du_assets_gift_or_grant_shape: sections["4d.1"],
    };
    expect(diffAssetTypeChecks(sections, widened, members)).toEqual([
      "du_assets_deposit_account_shape admits CashOnHand, which the DU Enumerations tab does " +
        "not file under 2a.1.",
      "du_assets_other_asset_shape is missing CashOnHand, which the tab files under 2b.1; " +
        "no OTHER_ASSET row could hold it.",
    ]);
  });

  it("names a member no kind's CHECK admits", () => {
    const sections = deriveAssetTypeSections(rowsFor(ASSET_TYPE_ROWS));
    const lists = Object.fromEntries(
      ASSET_TYPE_SECTIONS.map((s) => [s.constraint, sections[s.formField]]),
    );
    expect(
      diffAssetTypeChecks(sections, lists, [...Object.values(sections).flat(), "Bullion"]),
    ).toEqual(["DuAssetType.Bullion is admitted by no kind's CHECK, so no row can carry it."]);
  });

  it("agrees with the migration on the committed spec, with no spec directory", () => {
    // The check CI runs. Both sides are committed files, which is what makes a
    // widened CHECK catchable on a machine that has no DU_SPEC_DIR — and a
    // widened CHECK has no other local symptom.
    const generated = readFileSync(resolve(ROOT, "packages/du/src/generated/enums.ts"), "utf8");
    const sections = parseGeneratedAssetTypeSections(generated);
    const members = prismaEnums(readFileSync(resolve(ROOT, PRISMA_SCHEMA), "utf8")).DuAssetType;
    const lists = assetTypeListsInMigration(readFileSync(resolve(ROOT, ASSET_MIGRATION), "utf8"));
    expect(diffAssetTypeChecks(sections, lists, members)).toEqual([]);
  });
});
