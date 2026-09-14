/**
 * The vendored chain compiles, the eighteen samples validate against it, and
 * the harness can still fail.
 *
 * The last one is not decoration. A validator that has quietly stopped
 * validating passes every test that only asserts success, and this one shells
 * out to a binary that may not be installed — so the suite mutates a sample
 * into something the XSD does catch and requires the error.
 *
 * The other half of the honesty is at the bottom: the mutations the XSD does
 * NOT catch, asserted as passing. README.md says schema validity is necessary
 * and nowhere near sufficient, and docs/du-readiness.md repeats it; these are
 * what make that a measurement rather than a claim, and they are what stop
 * somebody from promoting `xmllint` to a gate later on. Every mutation either
 * document names is pinned here, in the direction it is named, so that the
 * prose cannot drift from the validator without a red test.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DU_WRAPPER_XSD,
  SAMPLES_DIR,
  WORKBOOK_DIR,
  XSD_DIR,
  samplePaths,
  xmllintErrors,
} from "../index.js";

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "du-schema-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let serial = 0;

/**
 * Write a mutated copy to the scratch directory and hand back its path.
 *
 * The samples are CRLF and tab-indented exactly as Fannie shipped them, so an
 * edit written as a literal string is one invisible byte away from matching
 * nothing — and an edit that matched nothing makes "the XSD does not catch
 * this" true of a document that was never mutated. So the change is asserted
 * before the file is written.
 */
function mutated(source: string, edit: (xml: string) => string): string {
  const original = readFileSync(source, "utf8");
  const xml = edit(original);
  expect(xml).not.toBe(original);
  // Serialized rather than named after the source: two mutations of one sample
  // in a single test would otherwise write the same path, and the second would
  // silently be the one both assertions read.
  const path = join(scratch, `${(serial += 1)}-${basename(source)}`);
  writeFileSync(path, xml);
  return path;
}

/** How many times a pattern appears in a written-out mutation. */
function count(path: string, pattern: RegExp): number {
  return (readFileSync(path, "utf8").match(pattern) ?? []).length;
}

const SAMPLE = join(SAMPLES_DIR, "DI-C09_DU Spec v1.9.1_Refi CO 2nd Home_3rd Borr.xml");

/**
 * The README section that records who owns what is vendored here, with its
 * wrapping flattened. The prose is wrapped at 80 columns and Prettier rewraps
 * it, so a match that a reflow can break is a test nobody trusts twice.
 */
function rightsSection(): string {
  const readme = readFileSync(join(XSD_DIR, "..", "README.md"), "utf8");
  const start = readme.indexOf("### Whose these are");
  expect(start).toBeGreaterThan(-1);
  const end = readme.indexOf("###", start + 3);
  return readme.slice(start, end === -1 ? undefined : end).replace(/\s+/g, " ");
}

describe("the vendored chain", () => {
  it("is exactly the closure of the wrapper's imports", () => {
    // Vendored by following imports outward from the wrapper, not by copying
    // every file with the right extension: the corpus holds seventeen .xsd
    // files, and the extras are an alternative packaging of the same reference
    // model plus a data-dictionary schema that is not on the message path.
    // This walks the closure again from the committed copies, so a file added
    // to the directory and a file the chain needs and lost both fail here.
    const seen = new Set<string>();
    const queue = [basename(DU_WRAPPER_XSD)];
    while (queue.length > 0) {
      const name = queue.shift() as string;
      if (seen.has(name)) continue;
      seen.add(name);
      const xsd = readFileSync(join(XSD_DIR, name), "utf8");
      for (const hit of xsd.matchAll(/schemaLocation="([^"]+)"/g)) {
        queue.push(basename(hit[1] as string));
      }
    }
    expect([...seen].sort()).toEqual(readdirSync(XSD_DIR).sort());
    expect(seen.size).toBe(9);
  });
});

describe("the provenance record", () => {
  // Every vendored file is third-party copyrighted work — the chain, the
  // samples and the workbook alike — and git keeps a file forever once it
  // lands. README.md is the only thing in the tree that says whose these are,
  // so a re-vendor that brings in a file under a holder nobody recorded has to
  // fail here rather than pass quietly.

  it("assigns every vendored XSD to a rights holder", () => {
    const section = rightsSection();
    for (const name of readdirSync(XSD_DIR)) {
      expect(section, `${name} is in xsd/ and named by no holder`).toContain(name);
    }
  });

  it("assigns the workbook to a rights holder, by its filename", () => {
    // The workbook is the one vendored file that carries a version and the one
    // that gets replaced rather than kept, so the README names the file and not
    // just the directory. A re-vendor that dropped 1.9.4 in beside this and
    // said nothing has to fail here, because the rights record is the only
    // thing in the tree that knows a new Fannie document arrived.
    const section = rightsSection();
    for (const name of readdirSync(WORKBOOK_DIR)) {
      expect(section, `${name} is in workbook/ and named by no holder`).toContain(name);
    }
    expect(section).toContain("Fannie Mae");
  });

  it("names MISMO for every file that asserts MISMO's copyright", () => {
    // Derived from the files rather than listed: the notice is inside them, so
    // the count of files carrying it is a fact about the vendored bytes.
    const asserted = readdirSync(XSD_DIR).filter((name) =>
      readFileSync(join(XSD_DIR, name), "utf8").includes(
        "Copyright 2015 Mortgage Industry Standards Maintenance Organization",
      ),
    );
    expect(asserted).toHaveLength(5);
    const section = rightsSection();
    expect(section).toContain("Mortgage Industry Standards Maintenance Organization");
    expect(section).toContain("End User License Agreement");
    for (const name of asserted) {
      expect(section.slice(0, section.indexOf("Fannie Mae's"))).toContain(name);
    }
  });
});

describe("the eighteen samples", () => {
  it("are all eighteen of them", () => {
    expect(samplePaths()).toHaveLength(18);
  });

  it.each(samplePaths().map((path) => [basename(path), path]))("%s validates", (_name, path) => {
    expect(xmllintErrors(path)).toEqual([]);
  });
});

describe("what the XSD catches", () => {
  // Three kinds, and README.md names them as kinds rather than as instances:
  // an enumeration violation, a sequence-model violation, a datatype or facet
  // violation. Naming one instance — `False` for `false` was the first version
  // of this — reads as the whole list to the next person, and a harness that
  // looks like it catches three things is a harness somebody drops.

  it("catches a value outside the MISMO enumeration", () => {
    // The mutation this suite is checked by. If the chain stops compiling, or
    // xmllint stops being reachable, `xmllintErrors` throws here rather than
    // letting the eighteen above pass on a validator that never ran.
    const path = mutated(SAMPLE, (xml) =>
      xml.replace("<AssetType>CheckingAccount</AssetType>", "<AssetType>PiggyBank</AssetType>"),
    );
    expect(xmllintErrors(path).join("\n")).toMatch(/PiggyBank/);
  });

  it("catches a child out of xsd:sequence order", () => {
    const path = mutated(SAMPLE, (xml) =>
      xml.replace(
        /(<AboutVersionIdentifier>[^<]*<\/AboutVersionIdentifier>)(\s*)(<CreatedDatetime>[^<]*<\/CreatedDatetime>)/,
        "$3$2$1",
      ),
    );
    expect(xmllintErrors(path).join("\n")).toMatch(/AboutVersionIdentifier/);
  });

  it("catches an element name the model does not know", () => {
    const path = mutated(SAMPLE, (xml) =>
      xml.replace(
        "<AssetType>CheckingAccount</AssetType>",
        "<AssetFlavor>CheckingAccount</AssetFlavor>",
      ),
    );
    expect(xmllintErrors(path).join("\n")).toMatch(/AssetFlavor/);
  });

  it("catches a singleton child repeated", () => {
    const path = mutated(SAMPLE, (xml) =>
      xml.replace(
        "<AssetType>CheckingAccount</AssetType>",
        "<AssetType>CheckingAccount</AssetType><AssetType>CheckingAccount</AssetType>",
      ),
    );
    expect(xmllintErrors(path).join("\n")).toMatch(/AssetType/);
  });

  it("catches False where false was wanted", () => {
    // The one a serializer writes by accident: xs:boolean is lexical and does
    // not fold case, so a language whose own boolean prints as `False` emits an
    // invalid document every time.
    const path = mutated(SAMPLE, (xml) =>
      xml.replace(
        "<BalloonIndicator>false</BalloonIndicator>",
        "<BalloonIndicator>False</BalloonIndicator>",
      ),
    );
    expect(xmllintErrors(path).join("\n")).toMatch(/BalloonIndicator/);
  });

  it("catches a non-numeric amount", () => {
    const path = mutated(SAMPLE, (xml) =>
      xml.replace(
        "<AssetCashOrMarketValueAmount>7500.00</AssetCashOrMarketValueAmount>",
        "<AssetCashOrMarketValueAmount>$7,500</AssetCashOrMarketValueAmount>",
      ),
    );
    expect(xmllintErrors(path).join("\n")).toMatch(/AssetCashOrMarketValueAmount/);
  });

  it("catches a malformed datetime", () => {
    const path = mutated(SAMPLE, (xml) =>
      xml.replace(
        "<CreatedDatetime>2025-07-31T11:11:17Z</CreatedDatetime>",
        "<CreatedDatetime>yesterday</CreatedDatetime>",
      ),
    );
    expect(xmllintErrors(path).join("\n")).toMatch(/CreatedDatetime/);
  });

  it("catches a SequenceNumber of zero", () => {
    // A facet rather than a type: SequenceNumber is a positive integer, so the
    // off-by-one a zero-based loop produces is caught even though the value is
    // a perfectly good integer.
    const path = mutated(SAMPLE, (xml) =>
      xml.replace('<ASSET SequenceNumber="1"', '<ASSET SequenceNumber="0"'),
    );
    expect(xmllintErrors(path).join("\n")).toMatch(/SequenceNumber/);
  });

  it("catches an xlink:label that is not an NCName", () => {
    // xs:NCName buys lexical well-formedness and nothing else — which is the
    // whole point of the group below, where the labels are all well formed and
    // the graph they describe is nonsense.
    const path = mutated(SAMPLE, (xml) =>
      xml.replace('xlink:label="ASSET_1"', 'xlink:label="1 BAD LABEL"'),
    );
    expect(xmllintErrors(path).join("\n")).toMatch(/label/i);
  });
});

describe("what the XSD does not catch", () => {
  it("accepts an xlink:to pointing at a label that exists nowhere", () => {
    // `xlink:label`, `from` and `to` are xs:NCName in xlinkMISMOB324.xsd, not
    // xs:ID and xs:IDREF. There is no referential integrity in the graph at
    // all, which is why every arc in our own documents is a foreign key.
    const path = mutated(SAMPLE, (xml) =>
      xml.replace('xlink:to="NOTE_PAY_TO_1"', 'xlink:to="NO_SUCH_LABEL_ANYWHERE"'),
    );
    expect(xmllintErrors(path)).toEqual([]);
  });

  it("accepts two containers carrying the same xlink:label", () => {
    // The other half of NCName-not-ID: nothing is unique either, so an arc that
    // resolves can resolve to two different elements and the document is still
    // valid.
    const path = mutated(SAMPLE, (xml) =>
      xml.replace('xlink:label="ASSET_2"', 'xlink:label="ASSET_1"'),
    );
    expect(xmllintErrors(path)).toEqual([]);
  });

  it("accepts two sibling ASSET elements with the same SequenceNumber", () => {
    // SequenceNumber is a positive integer and nothing more — the model has no
    // notion that siblings should differ, so the collision that makes two rows
    // one row downstream is invisible here.
    const path = mutated(SAMPLE, (xml) =>
      xml.replace('<ASSET SequenceNumber="2"', '<ASSET SequenceNumber="1"'),
    );
    expect(xmllintErrors(path)).toEqual([]);
  });

  it("accepts an invented arcrole, and a mis-cased real one", () => {
    // xlink:arcrole is xs:anyURI. Every arcrole DU understands is a URI, and so
    // is every arcrole it does not, which is why `generated/arcroles.ts` is a
    // table we check ourselves against the samples.
    const invented = mutated(SAMPLE, (xml) =>
      xml.replace(
        "residential/ASSET_IsAssociatedWith_ROLE",
        "residential/ASSET_IsInventedBy_NOBODY",
      ),
    );
    expect(xmllintErrors(invented)).toEqual([]);
    const miscased = mutated(SAMPLE, (xml) =>
      xml.replace(
        "residential/ASSET_IsAssociatedWith_ROLE",
        "residential/asset_isassociatedwith_role",
      ),
    );
    expect(xmllintErrors(miscased)).toEqual([]);
  });

  it("accepts five borrowers where DU's cap is four, and twelve parties where it is ten", () => {
    // The sample carries three borrowers among eight parties. Repeating the
    // first PARTY — a Borrower — is how both caps get exceeded, and MISMO's
    // model enforces neither: both maxima are DU's, stated in the workbook, and
    // therefore ours to hold in the database.
    const parties = (n: number) => (xml: string) =>
      xml.replace(/[ \t]*<PARTY>[\s\S]*?<\/PARTY>\r?\n/, (block) => block.repeat(n));

    const fiveBorrowers = mutated(SAMPLE, parties(3));
    expect(count(fiveBorrowers, /<PartyRoleType>Borrower<\/PartyRoleType>/g)).toBe(5);
    expect(xmllintErrors(fiveBorrowers)).toEqual([]);

    const twelveParties = mutated(SAMPLE, parties(5));
    expect(count(twelveParties, /<PARTY>/g)).toBe(12);
    expect(xmllintErrors(twelveParties)).toEqual([]);
  });

  it("accepts a document with its entire RELATIONSHIPS container deleted", () => {
    // Every arc in the file, gone, and it still validates. The relationships
    // are the whole of what DU reads a submission by.
    const path = mutated(SAMPLE, (xml) =>
      xml.replace(/<RELATIONSHIPS[^>]*>[\s\S]*<\/RELATIONSHIPS>/, ""),
    );
    expect(xmllintErrors(path)).toEqual([]);
  });

  it("accepts a document with no loan and no party in it", () => {
    // The bluntest one, and the reason the list above is not a list of corner
    // cases: whole required containers are optional to this chain. A submission
    // with nothing to underwrite and nobody to underwrite it is schema-valid.
    const path = mutated(SAMPLE, (xml) =>
      xml.replace(/<LOANS>[\s\S]*<\/LOANS>/, "").replace(/<PARTY>[\s\S]*<\/PARTY>/, ""),
    );
    expect(xmllintErrors(path)).toEqual([]);
  });

  it("accepts an ASSET with its required AssetType deleted", () => {
    const path = mutated(SAMPLE, (xml) =>
      xml.replace("<AssetType>CheckingAccount</AssetType>", ""),
    );
    expect(xmllintErrors(path)).toEqual([]);
  });

  it("accepts a document with every DECLARATION block deleted", () => {
    // The spec calls DECLARATION 1:1 with the borrower. Deleting all three
    // leaves a file that answers none of URLA Section 5 and validates.
    const path = mutated(SAMPLE, (xml) =>
      xml.replace(/[ \t]*<DECLARATION>[\s\S]*?<\/DECLARATION>\r?\n/g, ""),
    );
    expect(xmllintErrors(path)).toEqual([]);
  });

  it("accepts a 60-character LoanIdentifier where DU's limit is 15", () => {
    const path = mutated(SAMPLE, (xml) =>
      xml.replace(
        /<LoanIdentifier>[^<]*<\/LoanIdentifier>/,
        `<LoanIdentifier>${"9".repeat(60)}</LoanIdentifier>`,
      ),
    );
    expect(xmllintErrors(path)).toEqual([]);
  });
});

describe("the lists in the prose", () => {
  it("has a case for every mutation the README calls validating", () => {
    // The direction that rots: a bullet is easy to add to a list and a test is
    // not, and docs/du-readiness.md repeats this list to a reader who will
    // never open the package. So the count is checked rather than the intent —
    // an eleventh bullet with no case behind it fails here.
    const readme = readFileSync(join(XSD_DIR, "..", "README.md"), "utf8");
    const from = readme.indexOf("all of the following **validate**:");
    const to = readme.indexOf("Three kinds of mutation do fail", from);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const bullets = readme.slice(from, to).match(/^- /gm) ?? [];

    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const block = source.slice(source.indexOf('describe("what the XSD does not catch"'));
    const cases = block.slice(0, block.indexOf("\n});")).match(/^ {2}it\(/gm) ?? [];

    expect(cases).toHaveLength(bullets.length);
  });
});
