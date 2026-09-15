/**
 * The round trip, and the clause that keeps it honest.
 *
 * An earlier version of this test was "parse each of the eighteen into our
 * model, re-serialize, diff", with an escape clause saying any shape that
 * cannot round-trip is a gap the test reports. That is a report and not a gate,
 * and measured it could not have passed on a single sample: the corpus carries
 * 468 element paths and this model claims 208 of them.
 *
 * So the round trip runs over **the modeled set `MODELED_CHILDREN` declares**,
 * against **the inventory `du-not-round-tripped.txt` derives**, and
 * **a sample element in NEITHER fails the test.** That last clause is the whole
 * value of the arrangement, and it is only enforceable because the inventory is
 * generated rather than written: a hand-kept list was wrong in both directions
 * at once, naming seven containers as deliberately excluded while eight that
 * appear in every sample went unmentioned, and two of its seven occur zero
 * times in the corpus as element names.
 *
 * **What it covers.** Every modeled element of all eighteen shipped
 * submissions goes through `emit.ts` and comes back: the child sequence, the
 * values verbatim, every `SequenceNumber`, and every arc with both ends
 * resolved to the container they point at. If the generated order table and
 * Fannie Mae's own files ever disagree about where a child goes, this is what
 * says so.
 *
 * **The emitted document is read back WHOLE**, and that is load-bearing rather
 * than incidental. The tree going in is already reduced to the modeled set, so
 * anything in the bytes coming out that is not in the tree is something the
 * emitter made up — and putting the modeled filter on the output side as well
 * would delete exactly that evidence before the comparison saw it. An invented
 * element is not an implausible failure: a fabricated `FinancedUnitCount` is
 * real MISMO, sits in the generated order table, and validates against the
 * whole nine-file chain, so nothing else here would have caught it.
 *
 * **What it does not cover, said out loud.** The trees here are read from the
 * samples, not built by `assemble/` from rows — no shipped submission is a
 * database state, and reconstructing one would mean inventing the parts of the
 * model the corpus does not carry. So this proves the emitter against Fannie
 * Mae's bytes and proves nothing about which rows become which elements; that
 * is what the database-backed tests in `apps/api` are for. It also refuses any
 * sample element that the two sets do not between them account for, which is
 * the only thing here that can go wrong without anybody changing this file.
 */

import { describe, expect, it } from "vitest";
import { MODELED_CHILDREN, modeledElementPaths } from "../../../../scripts/build-du.mjs";
import { emitDocument } from "../emit.ts";
import {
  keepModeled,
  labelPositions,
  parseSample,
  pathsIn,
  project,
  readInventory,
  readSamples,
  toDuNode,
  xmllintErrors,
} from "./support/sample-reader.mjs";

const modeled = modeledElementPaths(MODELED_CHILDREN);
const inventory = readInventory();
const samples = readSamples();

describe("the modeled set and the inventory partition the corpus", () => {
  it("has eighteen samples to run over", () => {
    expect(samples).toHaveLength(18);
  });

  for (const sample of samples) {
    it(`accounts for every element path in ${sample.name}`, () => {
      const unaccounted = [...pathsIn(parseSample(sample.xml))].filter(
        (path) => !modeled.has(path) && !inventory.has(path),
      );
      expect(unaccounted).toEqual([]);
    });
  }
});

describe("every modeled element survives the emitter", () => {
  for (const sample of samples) {
    it(`round-trips ${sample.name}`, () => {
      const parsed = parseSample(sample.xml);
      const kept = keepModeled(parsed, modeled);
      expect(kept).not.toBeNull();

      const before = project(kept, labelPositions(kept));
      const emitted = emitDocument(toDuNode(kept));
      const reparsed = parseSample(emitted);
      const after = project(reparsed, labelPositions(reparsed));

      expect(after).toEqual(before);
    });
  }

  it("writes nothing the modeled set does not name", () => {
    // The same property the comparison above rests on, stated where narrowing
    // that comparison cannot quiet it: whatever the projection is taken over,
    // the bytes the emitter produced contain no path outside the modeled set.
    const invented = [];
    for (const sample of samples) {
      const kept = keepModeled(parseSample(sample.xml), modeled);
      for (const path of pathsIn(parseSample(emitDocument(toDuNode(kept))))) {
        if (!modeled.has(path)) invented.push(`${sample.name} ${path}`);
      }
    }
    expect(invented).toEqual([]);
  });

  it("actually carries the shapes the named cases are about", () => {
    // A round trip over an empty projection would pass. These are the four
    // element paths the rest of this commit's tests are about, and if the
    // filter ever stopped keeping them the comparison above would go quiet
    // rather than red.
    const kept = new Set();
    for (const sample of samples) {
      for (const path of pathsIn(keepModeled(parseSample(sample.xml), modeled))) kept.add(path);
    }
    expect(kept).toContain(
      "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/LIABILITIES/LIABILITY/LIABILITY_DETAIL/MortgageType",
    );
    expect(kept).toContain(
      "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/ASSETS/ASSET/OWNED_PROPERTY/OWNED_PROPERTY_DETAIL/OwnedPropertyRentalIncomeNetAmount",
    );
    expect(kept).toContain(
      "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/ASSETS/ASSET/OWNED_PROPERTY/PROPERTY/ADDRESS/CountryCode",
    );
    expect(kept).toContain("MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/RELATIONSHIPS/RELATIONSHIP");
  });
});

describe("what the emitter writes is at least schema-valid", () => {
  // A lint and not the gate, and the vendored package's README is where that
  // is argued: the XSD enforces element order, enumerated values and boolean
  // casing, and essentially nothing about the graph — a dangling `xlink:to`, a
  // duplicate label, an invented arcrole and a deleted RELATIONSHIPS container
  // all validate. What it does catch is the failure this emitter could
  // plausibly have: a child written out of its `xsd:sequence` position.
  for (const sample of samples) {
    it(`emits bytes libxml2 accepts, from ${sample.name}`, () => {
      const kept = keepModeled(parseSample(sample.xml), modeled);
      expect(xmllintErrors(emitDocument(toDuNode(kept)))).toEqual([]);
    });
  }
});

describe("the four gaps the model had before this commit, in the corpus", () => {
  const sample = (prefix) => {
    const found = samples.find((entry) => entry.name.startsWith(prefix));
    if (!found) throw new Error(`no vendored sample named ${prefix}`);
    return parseSample(found.xml);
  };

  /** Every element at `path`, as text, across one parsed sample. */
  const valuesAt = (element, path, prefix = "", into = []) => {
    const here = prefix === "" ? element.name : `${prefix}/${element.name}`;
    if (here === path && element.children.length === 0) into.push(element.text);
    for (const child of element.children) valuesAt(child, path, here, into);
    return into;
  };

  const DEAL = "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL";

  it("DI-C04's subject REO address differs from the subject property's", () => {
    const parsed = sample("DI-C04");
    const reo = valuesAt(
      parsed,
      `${DEAL}/ASSETS/ASSET/OWNED_PROPERTY/PROPERTY/ADDRESS/AddressLineText`,
    );
    const subject = valuesAt(
      parsed,
      `${DEAL}/COLLATERALS/COLLATERAL/SUBJECT_PROPERTY/ADDRESS/AddressLineText`,
    );
    expect(subject).toEqual(["1234 Main"]);
    expect(reo[0]).toBe("1234 Main St");
    // Which is why `du_owned_properties` has address columns at all, and why
    // the emitter does not simply render the subject address into both.
    expect(reo[0]).not.toBe(subject[0]);
  });

  it("DI-FHA02 carries a liability MortgageType and a loan MortgageType", () => {
    const parsed = sample("DI-FHA02");
    const onLiabilities = valuesAt(
      parsed,
      `${DEAL}/LIABILITIES/LIABILITY/LIABILITY_DETAIL/MortgageType`,
    );
    const onTerms = valuesAt(parsed, `${DEAL}/LOANS/LOAN/TERMS_OF_LOAN/MortgageType`);
    // EXACTLY ONE liability in the whole corpus carries one, and it is this
    // file's LIABILITY_1. An earlier claim that two of its liabilities did was
    // wrong, and it is the kind of wrong that would have put a column on rows
    // that never carry one.
    expect(onLiabilities).toEqual(["FHA"]);
    expect(onTerms).toEqual(["FHA"]);

    const everywhere = samples.flatMap((entry) =>
      valuesAt(
        parseSample(entry.xml),
        `${DEAL}/LIABILITIES/LIABILITY/LIABILITY_DETAIL/MortgageType`,
      ),
    );
    expect(everywhere).toEqual(["FHA"]);
  });

  it("DI-C08 carries a negative net rental figure", () => {
    const parsed = sample("DI-C08");
    const net = valuesAt(
      parsed,
      `${DEAL}/ASSETS/ASSET/OWNED_PROPERTY/OWNED_PROPERTY_DETAIL/OwnedPropertyRentalIncomeNetAmount`,
    );
    expect(net).toContain("-678.00");
  });

  /** Every element named `name`, as `path = value`, in document order. */
  const everyNamed = (element, name, prefix = "", into = []) => {
    const here = prefix === "" ? element.name : `${prefix}/${element.name}`;
    if (element.name === name && element.children.length === 0)
      into.push(`${here} = ${element.text}`);
    for (const child of element.children) everyNamed(child, name, here, into);
    return into;
  };

  it("DI-C02 carries CountryCode on three REO addresses and two residences, nowhere else", () => {
    // Enumerated rather than spot-checked, because "and nowhere else" is the
    // half that decides where the column goes: a CountryCode the model did not
    // know about is a place the emitter would have to write one. Both places
    // are modeled — the REO address on `du_owned_properties`, the residence
    // address on `du_residences` — and the subject property carries none.
    expect(everyNamed(sample("DI-C02"), "CountryCode")).toEqual([
      `${DEAL}/ASSETS/ASSET/OWNED_PROPERTY/PROPERTY/ADDRESS/CountryCode = US`,
      `${DEAL}/ASSETS/ASSET/OWNED_PROPERTY/PROPERTY/ADDRESS/CountryCode = US`,
      `${DEAL}/ASSETS/ASSET/OWNED_PROPERTY/PROPERTY/ADDRESS/CountryCode = US`,
      `${DEAL}/PARTIES/PARTY/ROLES/ROLE/BORROWER/RESIDENCES/RESIDENCE/ADDRESS/CountryCode = US`,
      `${DEAL}/PARTIES/PARTY/ROLES/ROLE/BORROWER/RESIDENCES/RESIDENCE/ADDRESS/CountryCode = US`,
    ]);
  });

  it("an REO's lien total is the sum of the liens against it", () => {
    // DI-C04's 206,514.00 is 198,514.00 plus 8,000.00 and the VA files'
    // 420,306.00 is 210,279.00 plus 210,027.00. Both are the figure the
    // database derives, and both are why the total is not the first
    // mortgage's balance.
    const c04 = sample("DI-C04");
    expect(
      valuesAt(
        c04,
        `${DEAL}/ASSETS/ASSET/OWNED_PROPERTY/OWNED_PROPERTY_DETAIL/OwnedPropertyLienUPBAmount`,
      ),
    ).toContain("206514.00");

    const va01 = sample("DI-VA01");
    expect(
      valuesAt(
        va01,
        `${DEAL}/ASSETS/ASSET/OWNED_PROPERTY/OWNED_PROPERTY_DETAIL/OwnedPropertyLienUPBAmount`,
      ),
    ).toEqual(["420306.00"]);
    const balances = valuesAt(
      va01,
      `${DEAL}/LIABILITIES/LIABILITY/LIABILITY_DETAIL/LiabilityUnpaidBalanceAmount`,
    );
    expect(balances.slice(0, 2)).toEqual(["210279.00", "210027.00"]);
  });
});
