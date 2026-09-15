/**
 * What the verification path refuses to do, and why each refusal has to be a
 * mechanism rather than a note.
 *
 * They fail in the same way: the document DU receives is short something, or
 * carries something nobody chose, and nothing anywhere says so. An arc whose
 * far end the specification does not settle validates against the whole
 * nine-file chain and is read as a claim. A snapshot kind or a vendor this
 * emitter has never heard of is a report a borrower's file holds and the
 * submission either does not name or names wrongly. And the history those
 * reports are chosen from is unbounded, so reading it whole is the one query
 * here that grows with a borrower's time on file.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DU_ARCROLES } from "../index.js";
import { arcrole } from "../assemble/relationships.js";
import {
  loadVerificationPayloads,
  loadVerificationSnapshots,
  type DuReader,
} from "../assemble/load.js";
import {
  selectVerifications,
  standingReports,
  VERIFICATION_KINDS,
  VERIFICATION_REPORT_TYPE,
} from "../assemble/verifications.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const MIGRATIONS = join(ROOT, "packages", "db", "prisma", "migrations");

/* ── The two arcs nobody may build ─────────────────────────────────────────── */

describe("the ASSET and EMPLOYER variants", () => {
  it("are still disputed at their far end, by two names that are not synonyms", () => {
    for (const name of [
      "UNDERWRITING_VERIFICATION_IsAssociatedWith_ASSET",
      "UNDERWRITING_VERIFICATION_IsAssociatedWith_EMPLOYER",
    ] as const) {
      const arc = DU_ARCROLES[name]!;
      expect(arc.to.disputed).toBe(true);
      // The endpoint row and the arcrole URI name different containers, which
      // is the whole of the dispute: OWNED_PROPERTY_DETAIL is a grandchild of
      // ASSET, and EMPLOYMENT is not on the emission path at all.
      expect(arc.to.container).not.toBe(arc.to.arcroleTerm);
      expect(arc.exercised).toBe(false);
    }
  });

  it("leave the ROLE variant the only one a sample ever carried", () => {
    const role = DU_ARCROLES["UNDERWRITING_VERIFICATION_IsAssociatedWith_ROLE"]!;
    expect(role.to.disputed).toBe(false);
    expect(role.exercised).toBe(true);
  });
});

describe("the fold's one way to name an arc", () => {
  // Not "the two files that fold arcs today do not mention these strings": an
  // arcrole name can be assembled at runtime, and the next assembler is a file
  // no such reading knows to open. Every arc in the block gets its URI here, so
  // this is where a disputed one stops.
  it("refuses every arcrole the generated table leaves disputed", () => {
    const disputed = Object.values(DU_ARCROLES).filter(
      (entry) => entry.from.disputed || entry.to.disputed,
    );
    expect(disputed.map((entry) => entry.name)).toEqual([
      "UNDERWRITING_VERIFICATION_IsAssociatedWith_ASSET",
      "UNDERWRITING_VERIFICATION_IsAssociatedWith_EMPLOYER",
    ]);
    for (const entry of disputed) {
      expect(() => arcrole(entry.name)).toThrow(/names two containers at one end/);
    }
  });

  it("hands back the URI for every arc whose ends the table settles", () => {
    const settled = Object.values(DU_ARCROLES).filter(
      (entry) => !entry.from.disputed && !entry.to.disputed,
    );
    expect(settled.length).toBeGreaterThan(0);
    for (const entry of settled) expect(arcrole(entry.name)).toBe(entry.arcrole);
  });

  it("refuses a name the generated table has never carried", () => {
    expect(() => arcrole("UNDERWRITING_VERIFICATION_IsAssociatedWith_NOTHING")).toThrow(
      /not an arcrole the generated table carries/,
    );
  });
});

/* ── The kinds, which the database is the authority on ─────────────────────── */

/**
 * The snapshot kinds the trigger admits, read out of the migration that last
 * defines it.
 *
 * The last one, because the function is written with CREATE OR REPLACE and a
 * later migration may rewrite it. Reading it rather than repeating it is the
 * point: a tenth kind arrives as a migration, and this is what turns that
 * migration into a failing test in the same commit.
 */
function kindsTheDatabaseAdmits(): string[] {
  const body = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .flatMap((name) => {
      const sql = readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8");
      return [
        ...sql.matchAll(
          /CREATE OR REPLACE FUNCTION "connector_snapshots_say_whose_they_are"\(\)([\s\S]*?)\$\$ LANGUAGE plpgsql;/g,
        ),
      ].map((match) => match[1]!);
    })
    .at(-1);
  if (body === undefined) {
    throw new Error("No migration defines connector_snapshots_say_whose_they_are.");
  }
  const kinds = [...body.matchAll(/NEW\."kind" IN \(([^)]*)\)/g)].flatMap((match) =>
    [...match[1]!.matchAll(/'([^']+)'/g)].map((quoted) => quoted[1]!),
  );
  if (kinds.length === 0) {
    throw new Error("connector_snapshots_say_whose_they_are names no kinds; its shape changed.");
  }
  return kinds;
}

describe("the snapshot kinds a report type is decided for", () => {
  it("are exactly the kinds the database admits", () => {
    // The trigger raises on a kind it has never heard of, so adding one is a
    // decision somebody makes in a migration. This is the other half of that
    // decision: a kind the database accepts and this map has not heard of is a
    // vendor report the submission would be silently short.
    expect(Object.keys(VERIFICATION_REPORT_TYPE).sort()).toEqual(kindsTheDatabaseAdmits().sort());
  });

  it("carry a report type for the three that are verifications and for nothing else", () => {
    expect([...VERIFICATION_KINDS].sort()).toEqual(["bank", "irs", "payroll"]);
  });

  it("are refused rather than skipped when a report arrives under a kind nobody decided", () => {
    const party = { id: "edge-1", partyId: "party-1" };
    const snapshot = {
      id: "snapshot-1",
      partyId: party.partyId,
      kind: "rent_ledger",
      provider: "fixture-bank",
      externalId: "ledger-1",
    };

    expect(() => standingReports([snapshot], { parties: [party] })).toThrow(
      /rent_ledger is a snapshot kind with no decision/,
    );
  });

  it("are refused when the kind is a name every object answers to", () => {
    const party = { id: "edge-1", partyId: "party-1" };
    const snapshot = {
      id: "snapshot-1",
      partyId: party.partyId,
      kind: "constructor",
      provider: "fixture-bank",
      externalId: "ledger-1",
    };

    expect(() => standingReports([snapshot], { parties: [party] })).toThrow(
      /constructor is a snapshot kind with no decision/,
    );
  });
});

describe("the supplier a submission names", () => {
  it("is nothing for a provider the approved table has no row for", () => {
    const standing = [
      {
        snapshotId: "snapshot-1",
        reportType: "VOD",
        // `provider` is a column too, and a name every object answers to must
        // not come back as a supplier DU would read as approved.
        provider: "constructor",
        reportIdentifier: "assets-1",
        applicationPartyId: "edge-1",
      },
    ];

    expect(selectVerifications(standing, new Map())).toEqual([]);
  });
});

/* ── The history, which is unbounded ───────────────────────────────────────── */

/** A reader that answers nothing and remembers what it was asked. */
function aRecordingReader(): { db: DuReader; asked: Record<string, unknown>[] } {
  const asked: Record<string, unknown>[] = [];
  const db = {
    connectorSnapshot: {
      findMany(args: Record<string, unknown>) {
        asked.push(args);
        return Promise.resolve([]);
      },
    },
  } as unknown as DuReader;
  return { db, asked };
}

describe("the read of a borrower's whole pull history", () => {
  it("asks for no payload, because every superseded one would be sent and dropped", async () => {
    const { db, asked } = aRecordingReader();

    await loadVerificationSnapshots(db, "file-1", ["party-1"], [...VERIFICATION_KINDS]);

    expect(asked).toHaveLength(1);
    // A year of daily re-pulls is hundreds of rows a borrower a kind, each
    // carrying a vendor report, and the whole reason to read them is one
    // boolean off the dozen that stand.
    expect(Object.keys(asked[0]!.select as object)).not.toContain("payload");
  });

  it("takes the newest first, by the vendor's moment and then by which was written second", async () => {
    const { db, asked } = aRecordingReader();

    await loadVerificationSnapshots(db, "file-1", ["party-1"], [...VERIFICATION_KINDS]);

    // `retrieved_at` can tie and the id is a random uuid, so the write order is
    // what makes "the latest" mean the later report rather than the larger
    // identifier.
    expect(asked[0]!.orderBy).toEqual([{ retrievedAt: "desc" }, { writeSeq: "desc" }]);
  });

  it("reads the payloads of the reports that stand and of nothing else", async () => {
    const { db, asked } = aRecordingReader();

    await loadVerificationPayloads(db, ["snapshot-9", "snapshot-4"]);

    expect(asked).toHaveLength(1);
    expect(asked[0]!.where).toEqual({ id: { in: ["snapshot-9", "snapshot-4"] } });
  });

  it("asks nothing at all when no report stands", async () => {
    const { db, asked } = aRecordingReader();

    expect(await loadVerificationPayloads(db, [])).toEqual(new Map());
    expect(asked).toEqual([]);
  });
});
