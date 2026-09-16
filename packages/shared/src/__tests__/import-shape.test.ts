/**
 * What a partner's feed is allowed to say, and what it has nowhere to put.
 *
 * The canonical import shape is the only door a servicer's file comes through,
 * so its absences are the product's protection rather than the adapter's
 * discipline: a record carrying an SSN or an email address fails to parse here,
 * where a mapping mistake is a red test instead of a column.
 *
 * The last case is the other half of the same promise. A shape with nowhere to
 * put a social security number is worth nothing if the migration beside it adds
 * a place to put one, so the walk over this slice's migrations is here rather
 * than trusting the two to be reviewed together.
 *
 * One clause is deferred and owed. The same promise is made a third time by
 * the port that hands these records over, and that port does not exist yet:
 * whoever writes `PortfolioPort` and its fixture adapter adds the clause that
 * the port's own types can express nothing this shape cannot.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ImportedLoanRecordSchema,
  ImportedPartySchema,
  canonicalRecordHash,
  type ImportedLoanRecord,
  type ImportedParty,
} from "../portfolio.js";

const VALID: ImportedLoanRecord = {
  sourceLoanKey: "GR-100244",
  servicerSlug: "grander",
  parties: [
    {
      sourcePartyKey: "GR-100244-1",
      role: "PRIMARY_BORROWER",
      legalName: { given: "Marisol", middle: null, surname: "Okonkwo" },
      dateOfBirth: "1979-11-02",
      mailingAddress: {
        line1: "42 Oak Street",
        line2: null,
        city: "Demo City",
        state: "CA",
        postalCode: "94000",
      },
    },
  ],
  property: {
    line1: "42 Oak Street",
    line2: null,
    city: "Demo City",
    state: "CA",
    postalCode: "94000",
    apn: "123-456-789",
  },
  terms: {
    objective: "purchase",
    program: "conventional",
    lienPosition: "first",
    occupancy: "primary_residence",
    rateType: "fixed",
    originalPrincipalCents: 41_600_000n,
    noteRateBps: 625,
    termMonths: 360,
    originatedOn: "2021-06-01",
    firstPaymentOn: "2021-08-01",
    maturityOn: "2051-07-01",
  },
  servicing: {
    asOf: "2026-08-01T00:00:00.000Z",
    status: "current",
    principalBalanceCents: 38_204_115n,
    escrowBalanceCents: 412_000n,
    scheduledPaymentCents: 256_100n,
    currentRateBps: 625,
    nextPaymentDueOn: "2026-09-01",
    delinquencyDays: null,
  },
};

/** Every field name the shape declares, at every depth. */
function keysOf(schema: unknown, into: string[] = []): string[] {
  const def = (schema as { _def?: Record<string, unknown> })._def;
  if (!def) return into;
  const inner = def.innerType ?? def.type ?? def.schema;
  if (inner) return keysOf(inner, into);
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  if (shape) {
    for (const [key, child] of Object.entries(shape)) {
      into.push(key);
      keysOf(child, into);
    }
  }
  return into;
}

/** Every object in the shape, so "strict" can be asked of all of them. */
function objectsIn(schema: unknown, into: unknown[] = []): unknown[] {
  const def = (schema as { _def?: Record<string, unknown> })._def;
  if (!def) return into;
  const inner = def.innerType ?? def.type ?? def.schema;
  if (inner) return objectsIn(inner, into);
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  if (shape) {
    into.push(schema);
    for (const child of Object.values(shape)) objectsIn(child, into);
  }
  return into;
}

describe("the shape has nowhere to put the things it must never hold", () => {
  it("names no field that could carry one", () => {
    const keys = keysOf(ImportedLoanRecordSchema);
    // Recursively, and the count is asserted so that a traversal that quietly
    // stopped descending would fail here rather than pass by seeing nothing.
    expect(keys.length).toBeGreaterThan(30);
    const forbidden = keys.filter((k) => /ssn|social|tax_?id|account_?number|email/i.test(k));
    expect(forbidden).toEqual([]);
  });

  it("refuses a record carrying an SSN rather than dropping it", () => {
    const carrying = { ...VALID, ssn: "123-45-6789" };
    expect(() => ImportedLoanRecordSchema.parse(carrying)).toThrow();
  });

  it("refuses one carrying an email address, at any depth", () => {
    const party = { ...VALID.parties[0], email: "marisol@example.test" };
    expect(() => ImportedPartySchema.parse(party)).toThrow();
    expect(() => ImportedLoanRecordSchema.parse({ ...VALID, parties: [party] })).toThrow();
  });

  it("is strict at every level, not only the outermost", () => {
    const objects = objectsIn(ImportedLoanRecordSchema);
    expect(objects.length).toBeGreaterThanOrEqual(5);
    for (const o of objects) {
      expect((o as { _def: { unknownKeys?: string } })._def.unknownKeys).toBe("strict");
    }
  });

  it("has nowhere to put one in the type either", () => {
    // The parse refusal is the runtime half. This is the half that runs in the
    // editor, where a mapping is actually written: `npm run check` compiles
    // this file, so a shape that grew a place to put an SSN would turn this
    // into an unused expect-error and fail the build.
    // @ts-expect-error a partner shape has nowhere to put a social security number
    const withSsn: ImportedParty = { ...VALID.parties[0]!, ssn: "123-45-6789" };
    expect(withSsn).toBeDefined();
  });

  it("accepts what a feed may legitimately send", () => {
    expect(() => ImportedLoanRecordSchema.parse(VALID)).not.toThrow();
    // The four axes are nullable, and a feed that did not say sends null
    // rather than the adapter picking one.
    const silent = { ...VALID, terms: { ...VALID.terms, objective: null, program: null } };
    expect(() => ImportedLoanRecordSchema.parse(silent)).not.toThrow();
  });
});

describe("the fingerprint of one record", () => {
  it("does not depend on the order a serializer emitted the keys", () => {
    const reordered: ImportedLoanRecord = {
      ...VALID,
      servicing: Object.fromEntries(
        Object.entries(VALID.servicing).reverse(),
      ) as ImportedLoanRecord["servicing"],
    };
    expect(canonicalRecordHash(reordered)).toBe(canonicalRecordHash(VALID));
  });

  it("changes when the record does", () => {
    const moved: ImportedLoanRecord = {
      ...VALID,
      servicing: { ...VALID.servicing, principalBalanceCents: 38_204_116n },
    };
    expect(canonicalRecordHash(moved)).not.toBe(canonicalRecordHash(VALID));
  });
});

describe("no migration in this slice adds a place to put one", () => {
  // Everything the loan work adds, by the timestamps it started at. Earlier
  // migrations are out of scope on purpose: `borrowers.ssn_vault_handle` is an
  // opaque reference and `ssn_last4` is display only, both already shipped and
  // both argued for where they live.
  const FIRST_OF_THIS_SLICE = "20260910100000";

  it("names no column an SSN could sit in", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const dir = join(root, "packages", "db", "prisma", "migrations");
    const mine = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name >= FIRST_OF_THIS_SLICE)
      .map((e) => e.name);
    // A guard on the guard: a rename of the migrations directory, or a slice
    // that has not landed yet, would otherwise make this pass by scanning
    // nothing at all.
    expect(mine.length).toBeGreaterThan(0);

    const offending: string[] = [];
    for (const name of mine) {
      const sql = readFileSync(join(dir, name, "migration.sql"), "utf8");
      for (const line of sql.split("\n")) {
        // Comments discuss the rule; only what Postgres reads counts.
        if (line.trimStart().startsWith("--")) continue;
        // Relaxing the already-shipped display column is not adding a place:
        // a co-borrower the applicant NAMED has a row before they have stated
        // a number, and `ssn_last4` went nullable to say so. The rule stays
        // for anything that would create a column or a table.
        if (/ALTER COLUMN "ssn_last4" DROP NOT NULL/.test(line)) continue;
        if (/COMMENT ON COLUMN "borrowers"\."ssn_last4"/.test(line)) continue;
        if (/ssn|social_security/i.test(line)) offending.push(`${name}: ${line.trim()}`);
      }
    }
    expect(offending).toEqual([]);
  });
});
