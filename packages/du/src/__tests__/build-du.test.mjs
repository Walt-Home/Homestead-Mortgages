/**
 * The generator's promises, tested against rows this file makes up.
 *
 * Every fixture below is synthetic on purpose. The workbook and the reference
 * model are vendored now, so a test could read them — but a mapping asserted
 * against the rows the spec happens to carry proves only that the spec is
 * itself, and says nothing about the row it does not carry yet. What these
 * assert is the machinery: that an unrecognized phrase stops the build, that a
 * blank cell nobody named stops the build, that a child the schema does not
 * declare stops the build. The facts derived FROM the spec are asserted in
 * generated.test.ts, against the committed tables; that the committed tables
 * are what the vendored workbook produces is asserted below, by rebuilding.
 *
 * The tests live here rather than beside the script because this is where
 * `npm test` reaches them.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARCROLE_SECTIONS,
  ASSET_TYPE_SECTIONS,
  BLANK_ENUMERATION_CELLS,
  COLUMN_NAME_ALIASES,
  DEAL_XPATH,
  DU_DATA_POINT_FOR_ENUM,
  MODELED_CHILDREN,
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
  deriveNotRoundTripped,
  diffAssetTypeChecks,
  diffModeledHolders,
  diffPrismaEnums,
  elementPathsInCorpus,
  modeledElementPaths,
  notModeledContainers,
  parseCardinality,
  parseConditionality,
  parseFormat,
  parseGeneratedArcRoles,
  parseGeneratedAssetTypeSections,
  parseGeneratedOrder,
  prismaEnums,
  prismaTableNames,
  proseNotModeledContainers,
  renderNotRoundTripped,
  shortElementPath,
  buildFromSpec,
} from "../../../../scripts/build-du.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCRIPT = resolve(ROOT, "scripts/build-du.mjs");
const PRISMA_SCHEMA = "packages/db/prisma/schema.prisma";
const GENERATED_DIR = resolve(ROOT, "packages/du/src/generated");
const WORKBOOK_DIR = resolve(ROOT, "packages/du-schema/workbook");
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

describe("the vendored workbook", () => {
  it("is the version the generator says every mapping was read against", () => {
    // The filename, the front cover and SPEC_VERSION are three separate
    // assertions of the same number, and the generator refuses to run unless
    // they agree — which is how a reissue stops the build instead of parsing
    // as though nothing moved. This pins the first of the three, because it is
    // the one a re-vendor sets by choosing a filename.
    expect(readdirSync(WORKBOOK_DIR)).toEqual(["DU_Specification v1.9.3.xlsx"]);
  });

  it("is what the committed tables were generated from, byte for byte", () => {
    // The proof that vendoring copied THIS workbook and not a revision that
    // merely parses. A different release would still produce six well-formed
    // tables; it would produce six different ones, and a spec change that
    // arrived inside a commit about where a file lives is a spec change nobody
    // reviewed. Rebuilding in memory and comparing to the committed bytes is
    // the same thing `--verify` does, asserted here so that it fails as a
    // named test rather than only as a script's exit code.
    const files = buildFromSpec();
    expect(Object.keys(files)).toHaveLength(6);
    for (const [name, contents] of Object.entries(files)) {
      const committed = readFileSync(resolve(GENERATED_DIR, name), "utf8");
      expect(contents, `${name} is not what the vendored workbook produces`).toBe(committed);
    }
  });
});

describe("--verify with nothing but this repository", () => {
  it("checks all six tables, and defers nothing it could have read", () => {
    // Run with no environment at all, which is the point: every input the six
    // tables come from is vendored, so there is nothing to set and nothing to
    // fetch. A skip line naming a FILE, or the name of the variable that used
    // to gate one, means an input went back outside the tree and four tables
    // quietly stopped being checked — which is the failure this arrangement
    // exists to prevent, and it has no other symptom.
    //
    // The REO nesting is the one check that reads a database rather than a
    // file, and it skips wherever there is no database to ask — here, and on
    // any run that does not hand the script a URL. Forbidding the word outright
    // would fail on that line instead, which says nothing about the tables.
    const result = runScript(["--verify"], {});
    expect(result.stdout).toMatch(/child sequences in order\.ts match the vendored MISMO chain/);
    expect(result.stdout).toMatch(/arcroles in arcroles\.ts are exercised by the vendored samples/);
    expect(result.stdout).toMatch(/6 generated files match the DU Spec 1\.9\.3/);
    const skipped = result.stdout.split("\n").filter((line) => line.includes("skipped"));
    expect(skipped.filter((line) => !line.includes("the REO nesting check"))).toEqual([]);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/DU_SPEC_DIR/);
    expect(result.status).toBe(0);
  });

  it("reaches the vendored corpus without importing a workspace package", () => {
    // `@hm/du-schema` exports the same three directories this script resolves
    // for itself, and the duplication is the arrangement rather than an
    // oversight: that package's entry point is its compiled `dist/`, so
    // importing it here would make regenerating the tables wait on a
    // TypeScript build, and a fresh checkout is exactly where somebody
    // regenerates them. The failure would arrive as a module that could not be
    // resolved, which reads like a broken install and not like an ordering
    // anybody chose. Nothing else would notice: every machine that has already
    // run `npm run build` has the `dist/` that hides it.
    const source = readFileSync(SCRIPT, "utf8");
    const imported = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((hit) => hit[1]);
    expect(imported.length).toBeGreaterThan(0);
    expect(imported.filter((name) => name.startsWith("@hm/"))).toEqual([]);
  });

  it("is described by the comment the deploy workflow runs it under", () => {
    // That comment presents itself as the exhaustive list of what this step
    // checks, and it is what gets believed — the step's own output scrolls past
    // in a CI log nobody reads twice. So the list is derived from the run
    // rather than trusted beside it: every committed file the run names has to
    // appear in the comment, and so do the workbook-derived tables it no
    // longer has any reason to leave out.
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

  // Two tables the workbook is the sole authority on: nothing else in
  // `--verify` parses either file, so a failure here can only have come from
  // the rebuild. Mutating them is the difference between a check that runs and
  // a check that works, and it is worth spelling out because "it passed" and
  // "it had nothing to compare against" looked identical from outside for as
  // long as the workbook was somewhere else.
  it.each([
    ["cardinality.ts", '"min": 1,', '"min": 2,'],
    ["lengths.ts", '"maxLength": 30', '"maxLength": 31'],
  ])("fails on a hand-edited %s", (name, from, to) => {
    const path = resolve(GENERATED_DIR, name);
    const original = readFileSync(path, "utf8");
    // One digit, at the first place it occurs. Small enough that no reader
    // would spot it, which is the kind of edit this has to catch — a
    // conspicuous one is caught by whoever makes it.
    expect(original, `${name} no longer contains ${from}`).toContain(from);
    try {
      writeFileSync(path, original.replace(from, to));
      const result = runScript(["--verify"], {});
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`packages/du/src/generated/${name} is out of date`);
    } finally {
      writeFileSync(path, original);
    }
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

  it("throws when an exclusion names a value the tab no longer carries", () => {
    // `exclude` skips a value the enum will not take, and it is a claim about
    // the tab exactly as VALUES_NOT_IN_SCOPE is. Checked in both directions,
    // the tab's values for an enum are its members plus its exclusions plus
    // what VALUES_NOT_IN_SCOPE names, and nothing else — which is what lets a
    // comment count them and be held to the count. Unchecked, a renamed or
    // dropped value would sit in the list forever, skipping nothing.
    const table = {
      DuDealPartyRole: {
        dataPoints: [{ name: "PartyRoleType", formFields: [] }],
        exclude: ["Borrower", "Trust"],
      },
    };
    const options = { table, disagreements: [], blanks: [], notInScope: [] };

    const { enumerations } = deriveEnumerations(
      [
        enumerationRow("PartyRoleType", "1a.1", "Borrower"),
        enumerationRow("PartyRoleType", "L2.5", "Trust"),
        enumerationRow("PartyRoleType", "9.5", "LoanOriginator"),
      ],
      options,
    );
    expect(enumerations.DuDealPartyRole).toEqual(["LoanOriginator"]);

    // The same table against a tab that has stopped carrying `Trust`.
    expect(() =>
      deriveEnumerations(
        [
          enumerationRow("PartyRoleType", "1a.1", "Borrower"),
          enumerationRow("PartyRoleType", "9.5", "LoanOriginator"),
        ],
        options,
      ),
    ).toThrow(/excludes Trust from DuDealPartyRole/);
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

  it("agrees with the migration on the committed spec", () => {
    // The check CI runs. Both sides are committed files, and neither is
    // anything the rebuild reads — the workbook is no authority on what a
    // migration wrote, so nothing else here would catch a widened CHECK, and a
    // widened CHECK has no other local symptom.
    const generated = readFileSync(resolve(ROOT, "packages/du/src/generated/enums.ts"), "utf8");
    const sections = parseGeneratedAssetTypeSections(generated);
    const members = prismaEnums(readFileSync(resolve(ROOT, PRISMA_SCHEMA), "utf8")).DuAssetType;
    const lists = assetTypeListsInMigration(readFileSync(resolve(ROOT, ASSET_MIGRATION), "utf8"));
    expect(diffAssetTypeChecks(sections, lists, members)).toEqual([]);
  });
});

describe("the modeled set, and the inventory derived from it", () => {
  const NOT_ROUND_TRIPPED = resolve(ROOT, "packages/du-schema/du-not-round-tripped.txt");
  const PROSE = resolve(ROOT, "docs/du-generation.md");
  const SAMPLES = resolve(ROOT, "packages/du-schema/samples");
  const SUBJECT_LOAN = `${DEAL_XPATH}/LOANS/LOAN[@LoanRoleType="SubjectLoan"]`;
  const RELATED_LOAN = `${DEAL_XPATH}/LOANS/LOAN[@LoanRoleType="RelatedLoan"]`;
  const ROLE = `${DEAL_XPATH}/PARTIES/PARTY/ROLES/ROLE`;

  /** The corpus and the declaration, measured once for the whole block. */
  const corpus = elementPathsInCorpus();
  const modeled = modeledElementPaths();
  const entries = deriveNotRoundTripped(corpus, modeled);

  it("is exactly what the committed artifact holds", () => {
    // The promise the file makes. A container that becomes modeled shrinks it,
    // a container a future sample introduces grows it, and either way this is
    // the assertion that makes the change show up as a diff rather than as
    // nothing at all.
    expect(readFileSync(NOT_ROUND_TRIPPED, "utf8")).toBe(
      renderNotRoundTripped(entries, corpus.size),
    );
  });

  it("lists only element paths the samples actually carry, counted again", () => {
    // Counted a second way, by the element's own name across the bytes of all
    // eighteen files, because the first count comes from the same function the
    // artifact does and would agree with itself about a path nothing matches.
    // The name count is a ceiling rather than an equality — one name can sit at
    // several XPaths — but it is zero for a name that is not there, which is
    // the mistake this file exists to stop repeating.
    const bytes = readdirSync(SAMPLES)
      .filter((name) => name.endsWith(".xml"))
      .map((name) => readFileSync(resolve(SAMPLES, name), "utf8"))
      .join("");

    expect(entries.length).toBeGreaterThan(0);
    const wrong = [];
    for (const entry of entries) {
      const name = entry.xpath.slice(entry.xpath.lastIndexOf("/") + 1).replace(/\[@.*$/, "");
      const occurrences = bytes.split(`<${name}`).length - 1;
      if (entry.elements < 1 || entry.files < 1 || entry.files > 18) {
        wrong.push(`${entry.xpath} claims ${entry.elements} elements in ${entry.files} files`);
      } else if (occurrences < entry.elements) {
        wrong.push(`${entry.xpath} claims ${entry.elements} and <${name} occurs ${occurrences}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("refuses a modeled path no sample carries", () => {
    // The failure mode the hand-written inventory had twice over: RELATED_LOAN
    // and ALIAS, both named, both absent from all eighteen files. A name that
    // matches nothing subtracts nothing, so without this it would sit in the
    // list looking like a claim.
    expect(() =>
      deriveNotRoundTripped(corpus, new Set([...modeled, `${DEAL_XPATH}/LOANS/RELATED_LOAN`])),
    ).toThrow(/RELATED_LOAN/);
    expect(corpus.has(`${DEAL_XPATH}/LOANS/RELATED_LOAN`)).toBe(false);
  });

  it("drops a container from the inventory when the model claims it", () => {
    // The other direction, which is what makes the file a progress record
    // rather than a list of excuses. HOUSING_EXPENSE is the largest single
    // absence: 84 elements across all eighteen files.
    const housing = `${SUBJECT_LOAN}/HOUSING_EXPENSES/HOUSING_EXPENSE`;
    const listed = entries.filter((entry) => entry.xpath.startsWith(housing));
    expect(listed.map((entry) => entry.elements)).toEqual([84, 84, 84, 84]);

    const claimed = modeledElementPaths({
      ...MODELED_CHILDREN,
      [housing]: {
        held: ["loan_files"],
        children: ["HousingExpensePaymentAmount", "HousingExpenseTimingType", "HousingExpenseType"],
      },
    });
    const after = deriveNotRoundTripped(corpus, claimed);
    expect(after.filter((entry) => entry.xpath.startsWith(housing))).toEqual([]);
    expect(entries.length - after.length).toBe(5);
  });

  it("keeps the related loan off the subject loan's path", () => {
    // The whole of what separates the loan being applied for from a
    // simultaneous second is one attribute, so one attribute is in the path.
    // Without it these nine elements land on paths MODELED_CHILDREN claims and
    // a model that holds one loan per application reads as holding them.
    expect(corpus.has(`${DEAL_XPATH}/LOANS/LOAN`)).toBe(false);
    expect(corpus.get(SUBJECT_LOAN)).toEqual({ elements: 18, files: 18 });
    expect(corpus.get(RELATED_LOAN)).toEqual({ elements: 9, files: 8 });

    // Four paths the two loans share as bare tag names, and the subject loan's
    // half of each is modeled while the related loan's is not.
    for (const tail of ["", "/LOAN_DETAIL", "/TERMS_OF_LOAN", "/TERMS_OF_LOAN/LienPriorityType"]) {
      expect(modeled.has(`${SUBJECT_LOAN}${tail}`)).toBe(true);
      expect(modeled.has(`${RELATED_LOAN}${tail}`)).toBe(false);
    }
    expect(entries.filter((entry) => entry.xpath.startsWith(RELATED_LOAN))).toHaveLength(18);
  });

  it("stops on a LOAN that does not say which loan it is", () => {
    // A predicate that silently falls back to the bare name would put a future
    // sample's roleless LOAN back on the subject loan's path, which is the
    // reading this predicate exists to prevent.
    const dir = mkdtempSync(resolve(tmpdir(), "du-corpus-"));
    try {
      writeFileSync(resolve(dir, "a.xml"), "<MESSAGE><LOANS><LOAN/></LOANS></MESSAGE>");
      expect(() => elementPathsInCorpus(dir)).toThrow(/a\.xml has a LOAN with no LoanRoleType/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops on a close tag that does not match what is open", () => {
    // Popping by position rather than by name produces a wrong path for every
    // element after the mismatch and no error at all, which is the one failure
    // mode a counting tokenizer must not have.
    const dir = mkdtempSync(resolve(tmpdir(), "du-corpus-"));
    try {
      writeFileSync(resolve(dir, "b.xml"), "<MESSAGE><DEALS></MESSAGE></DEALS>");
      expect(() => elementPathsInCorpus(dir)).toThrow(/b\.xml closes MESSAGE inside DEALS/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a modeled block with nowhere to put what it claims", () => {
    // The direction that went unchecked, and what it let through: vesting, an
    // originator's license and a counseling agency's identifier were all
    // declared modeled while `schema.prisma` held none of them. Naming a table
    // is what makes the claim answerable, and a table the schema does not map
    // is not an answer.
    const tables = prismaTableNames(
      readFileSync(resolve(ROOT, "packages/db/prisma/schema.prisma"), "utf8"),
    );
    expect(tables.has("du_assets")).toBe(true);
    // Deliberately a name no schema will ever map, rather than a table that
    // does not exist YET: `du_vestings` was this fixture's example until the
    // commit that added it, and a fixture that has to be revisited every time
    // the schema grows is a fixture that will one day be revisited wrongly.
    expect(tables.has("du_nothing_will_ever_map_this")).toBe(false);
    expect(diffModeledHolders(MODELED_CHILDREN, tables)).toEqual([]);

    expect(
      diffModeledHolders(
        { [`${ROLE}/PROPERTY_OWNER`]: { held: ["du_nothing_will_ever_map_this"], children: ["x"] } },
        tables,
      ),
    ).toEqual([`${ROLE}/PROPERTY_OWNER is held by du_nothing_will_ever_map_this, which schema.prisma does not map`]);
    expect(diffModeledHolders({ "MESSAGE/X": { held: [], children: ["x"] } }, tables)).toEqual([
      "MESSAGE/X claims to be modeled and names nothing that holds it",
    ]);
  });

  it("checks the holders on the same --verify run that checks the file", () => {
    // A declaration nothing reads is a comment. The run says how many blocks
    // it put the question to, so a check quietly dropped out of the verify
    // path takes its own line with it.
    const result = runScript(["--verify"], {});
    expect(result.stdout).toContain(
      `✓ ${Object.keys(MODELED_CHILDREN).length} modeled blocks name the table or the constant ` +
        "that holds them",
    );
  });

  it("names every container it stops at in the page that explains them", () => {
    // The prose and the artifact are one claim. The page carries a bullet per
    // container and the subtraction carries the containers; a reader who
    // trusts the page has to be reading something the corpus still supports.
    const derived = notModeledContainers(entries, modeled).map((c) => c.short);
    expect(derived.length).toBeGreaterThan(0);
    expect(proseNotModeledContainers(readFileSync(PROSE, "utf8")).sort()).toEqual(derived.sort());
  });

  it("stops reading bullets at a heading of any depth", () => {
    // The section is bounded by the next heading, and a sub-heading is a
    // heading: bullets under one belong to it, not to the checked list.
    const page = ["", "## Heading", "", "- `A/B`", "", "### Deeper", "", "- `C/D`", ""].join("\n");
    expect(proseNotModeledContainers(page, "## Heading")).toEqual(["A/B"]);
  });

  it("fails --verify on a bullet the page no longer carries", () => {
    // The check that runs in CI, driven the way a careless edit would drive it.
    const original = readFileSync(PROSE, "utf8");
    const bullet = `- \`${shortElementPath(SUBJECT_LOAN)}/HOUSING_EXPENSES\``;
    expect(original).toContain(bullet);
    try {
      writeFileSync(PROSE, original.replace(bullet, "- HOUSING_EXPENSES"));
      const result = runScript(["--verify"], {});
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `DEAL/LOANS/LOAN[@LoanRoleType="SubjectLoan"]/HOUSING_EXPENSES is in 18 of the eighteen`,
      );
    } finally {
      writeFileSync(PROSE, original);
    }
  });

  it("fails --verify on a hand-edited du-not-round-tripped.txt", () => {
    const original = readFileSync(NOT_ROUND_TRIPPED, "utf8");
    const line = original.split("\n").find((text) => text.endsWith("/HOUSING_EXPENSE"));
    expect(line).toBeDefined();
    try {
      writeFileSync(NOT_ROUND_TRIPPED, original.replace(`${line}\n`, ""));
      const result = runScript(["--verify"], {});
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("du-not-round-tripped.txt is not what the samples minus");
    } finally {
      writeFileSync(NOT_ROUND_TRIPPED, original);
    }
  });
});
