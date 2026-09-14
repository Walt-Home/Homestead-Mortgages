/**
 * A person a partner named, and everything that may not be done about them.
 *
 * The claim status enum has shipped with four values and one writer, so the
 * narrowness it promised was a comment. These are the assertions that make it a
 * property of the database instead: a provisional party holds no permission, a
 * partner's word never climbs the confidence ladder, and the only minter in the
 * product refuses every category for somebody who has never contacted us.
 *
 * All of it against a real Postgres, because all of it is a trigger.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  prisma,
  type AuthorizationPurpose,
  type ConfidenceTier,
  type DataCategory as DataCategoryEnum,
} from "@hm/db";
import { PURPOSE_FOR } from "@hm/connectors";
import type { Borrower, DataCategory, LoanFile } from "@hm/shared";
import { ImportedNameSchema } from "@hm/shared/portfolio";
import { tokenFor } from "../services/authorization.js";
import {
  assertFacts,
  assertPartnerFacts,
  createProvisionalParty,
  mergePartyInto,
  partnerFactsFor,
  partnerPrincipal,
  partyForUser,
  principalForParty,
} from "../services/party.js";
import { createUser, importedLoan } from "./support/factories.js";

const AS_OF = new Date("2026-08-01T00:00:00Z");

/** What an import writes: the party, the feed's principal, and its facts. */
async function imported(over: { sourceFirstSeen?: string } = {}) {
  return prisma.$transaction(async (tx) => {
    const partyId = await createProvisionalParty(tx, {
      sourceFirstSeen: over.sourceFirstSeen ?? "grander_import",
    });
    const principalId = await partnerPrincipal(tx, "grander");
    await assertPartnerFacts(tx, {
      partyId,
      principalId,
      facts: [
        {
          predicate: "legal_name",
          value: { given: "Marisol", middle: null, surname: "Okonkwo" },
          observedAt: AS_OF,
        },
        { predicate: "date_of_birth", value: "1979-11-02", observedAt: AS_OF },
      ],
    });
    return { partyId, principalId };
  });
}

describe("an imported party is held provisionally", () => {
  it("is PROVISIONAL and says where it came from", async () => {
    const { partyId } = await imported();
    const party = await prisma.party.findUniqueOrThrow({ where: { id: partyId } });
    expect(party.claimStatus).toBe("PROVISIONAL");
    expect(party.sourceFirstSeen).toBe("grander_import");
  });

  it("holds facts a partner shared and nobody checked", async () => {
    const { partyId } = await imported();
    const facts = await prisma.fact.findMany({ where: { partyId } });
    expect(facts).toHaveLength(2);
    for (const f of facts) {
      expect(f.sourceKind).toBe("PARTNER_SHARED");
      expect(f.confidence).toBe("UNVERIFIED");
      // The as-of the feed stated, not the minute we read it.
      expect(f.observedAt.toISOString()).toBe(AS_OF.toISOString());
    }
  });

  it("attributes them to a partner principal that is nobody", async () => {
    const { principalId } = await imported();
    const principal = await prisma.principal.findUniqueOrThrow({ where: { id: principalId } });
    expect(principal.kind).toBe("PARTNER");
    expect(principal.subject).toBe("grander");
    // Null, and the shipped CHECK forces it. A principal that cascaded from a
    // party would take the attribution with the person who deleted their
    // account, and "who told us this" would go with it.
    expect(principal.partyId).toBeNull();
  });

  it("is one principal per feed, however many records arrive", async () => {
    const a = await imported();
    const b = await imported();
    expect(b.principalId).toBe(a.principalId);
    expect(b.partyId).not.toBe(a.partyId);
  });

  it("stores the name in the shape a partner's record arrives in", async () => {
    // The hold's `legal_name` is the canonical import shape's `legalName`, not
    // a string somebody will have to split later — which is what lets the
    // claim's second factor compare a surname and a first given name without
    // guessing where one ends.
    //
    // It is also the assertion that `@hm/shared/portfolio` resolves from here.
    // The module sits outside the barrel so the browser app never pulls a
    // partner-feed parser through it, and a subpath is a second entry point
    // that needs its own alias and its own `paths` entry; this proves both in
    // the commit that adds the module rather than in the one that first
    // imports it in anger.
    const { partyId } = await imported();
    const fact = await prisma.fact.findFirstOrThrow({
      where: { partyId, predicate: "legal_name" },
    });
    expect(ImportedNameSchema.parse(fact.value)).toEqual({
      given: "Marisol",
      middle: null,
      surname: "Okonkwo",
    });
  });

  it("has no application and no authorization", async () => {
    const { partyId } = await imported();
    expect(await prisma.applicationParty.count({ where: { partyId } })).toBe(0);
    expect(await prisma.authorization.count({ where: { partyId } })).toBe(0);
  });
});

describe("a partner shared it; nobody checked it", () => {
  // Everything above UNVERIFIED. ATTESTED is not here because it is not above
  // anything — it is the borrower's own word, which a partner cannot speak.
  const ABOVE: ConfidenceTier[] = [
    "INFERRED",
    "ESTIMATED",
    "CORROBORATED",
    "VERIFIED",
    "VALIDATED_D1C",
  ];

  it.each(ABOVE)("refuses a partner principal asserting %s", async (confidence) => {
    const { partyId, principalId } = await imported();
    await expect(
      prisma.fact.create({
        data: {
          subjectType: "PARTY",
          subjectId: partyId,
          partyId,
          predicate: "annual_income",
          value: 128_000,
          sourceKind: "PARTNER_SHARED",
          confidence,
          assertedByPrincipalId: principalId,
          observedAt: AS_OF,
        },
      }),
    ).rejects.toThrow(/partner shared it, nobody checked it/);
  });

  it("will overwrite a person's own name with the servicer's, if it is aimed at them", async () => {
    // The hazard the doc comment on assertPartnerFacts describes, pinned here
    // so it is found in a test rather than assumed away. Supersession matches
    // on (party, predicate) and reads neither who asserted the prior row nor
    // what tier it sits at, so pointing this at a party somebody signed in and
    // attested on replaces their own name with a servicer's spelling of it, at
    // a lower confidence, and every later read returns the servicer's. Nothing
    // in the database stops it: which party the caller passes IS the safety
    // property, and the importer is what has to keep it.
    const user = await createUser();
    const own = await prisma.$transaction((tx) => partyForUser(tx, user.id));
    await prisma.$transaction(async (tx) =>
      assertFacts(tx, own, await principalForParty(tx, own), [
        { predicate: "legal_name", value: { first: "Marisol", last: "Okonkwo-Reyes" } },
      ]),
    );

    const { principalId } = await imported();
    await prisma.$transaction((tx) =>
      assertPartnerFacts(tx, {
        partyId: own,
        principalId,
        facts: [
          {
            predicate: "legal_name",
            value: { given: "MARISOL", middle: null, surname: "OKONKWO" },
            observedAt: new Date("2020-01-01T00:00:00Z"),
          },
        ],
      }),
    );

    const live = await prisma.fact.findFirstOrThrow({
      where: { partyId: own, predicate: "legal_name", supersededById: null, retractedAt: null },
    });
    // The servicer's row is what a later read returns, at the tier a partner
    // is capped to — below the tier the person's own assertion carried.
    expect(live.confidence).toBe("UNVERIFIED");
    expect(live.value).toMatchObject({ surname: "OKONKWO" });
  });

  it("keeps speaking for a record after the person claims it", async () => {
    // The feed does not stop arriving because somebody signed in, and next
    // month's file carries the same two borrowers with a new balance. It is
    // asserted against the party the partner's own record names, which by then
    // is MERGED — so a claim status precondition here would reject the whole
    // record, including a co-borrower's data, the month after anybody claims.
    const { partyId, principalId } = await imported();
    const user = await createUser();
    const survivor = await prisma.$transaction((tx) => partyForUser(tx, user.id));
    await prisma.$transaction((tx) => mergePartyInto(tx, partyId, survivor));

    const later = new Date("2026-09-01T00:00:00Z");
    await prisma.$transaction((tx) =>
      assertPartnerFacts(tx, {
        partyId,
        principalId,
        facts: [
          {
            predicate: "legal_name",
            value: { given: "Marisol", middle: "A", surname: "Okonkwo" },
            observedAt: later,
          },
        ],
      }),
    );

    // Still one live row per predicate, still reachable from the person, and
    // still nothing on the survivor's own party.
    const live = await partnerFactsFor(prisma, survivor);
    expect(live.map((f) => f.predicate).sort()).toEqual(["date_of_birth", "legal_name"]);
    const name = live.find((f) => f.predicate === "legal_name");
    expect(name?.observedAt.toISOString()).toBe(later.toISOString());
    expect(await prisma.fact.count({ where: { partyId: survivor } })).toBe(0);
  });

  it("leaves the same tiers open to a principal that is not a partner", async () => {
    // The rule is about who is speaking, not about which words are dangerous.
    // A vendor retrieval corroborating an income is exactly what the ladder is
    // for, and this is the assertion that the trigger did not close it.
    const user = await createUser();
    const partyId = await prisma.$transaction((tx) => partyForUser(tx, user.id));
    const staff = await prisma.principal.create({
      data: { kind: "STAFF", subject: `ops-${partyId}` },
      select: { id: true },
    });
    const fact = await prisma.fact.create({
      data: {
        subjectType: "PARTY",
        subjectId: partyId,
        partyId,
        predicate: "annual_income",
        value: 128_000,
        sourceKind: "VENDOR_RETRIEVED",
        confidence: "CORROBORATED",
        assertedByPrincipalId: staff.id,
        observedAt: AS_OF,
      },
      select: { id: true },
    });
    expect(fact.id).toBeDefined();
  });
});

describe("a provisional party has authorized nothing", () => {
  const GRANTED = new Date("2026-09-01T00:00:00Z");
  const EXPIRES = new Date("2026-12-01T00:00:00Z");

  it("refuses an authorization row of any purpose", async () => {
    const { partyId } = await imported();
    for (const purpose of ["FCRA_WRITTEN_INSTRUCTION", "IRS_4506C", "BIOMETRIC_IDV"] as const) {
      await expect(
        prisma.authorization.create({
          data: {
            partyId,
            purpose,
            dataCategories: ["CREDIT_REPORT"],
            grantedAt: GRANTED,
            expiresAt: EXPIRES,
          },
        }),
      ).rejects.toThrow(/an imported record is not a consent/);
    }
  });

  it("refuses one on a merged party, and names the survivor", async () => {
    const { partyId } = await imported();
    const user = await createUser();
    const survivor = await prisma.$transaction((tx) => partyForUser(tx, user.id));
    await prisma.$transaction((tx) => mergePartyInto(tx, partyId, survivor));
    await expect(
      prisma.authorization.create({
        data: {
          partyId,
          purpose: "FCRA_WRITTEN_INSTRUCTION",
          dataCategories: ["CREDIT_REPORT"],
          grantedAt: GRANTED,
          expiresAt: EXPIRES,
        },
      }),
    ).rejects.toThrow(new RegExp(`was merged; grant on ${survivor} instead`));
  });

  it("refuses every retrieval the product can name", async () => {
    const { partyId } = await imported();
    // The minter reads `authorizations` and nothing else, and the connector
    // guard takes a token only the minter can produce. So this loop is the
    // whole retrieval surface: an imported party cannot be pulled on by any
    // route, including one somebody writes without reading the trigger.
    //
    // The borrower is a stand-in and says so. An imported party never appears
    // on a loan file — it has no application at all — and the only thing
    // `tokenFor` reads off one is the party whose permission it is about.
    const subject = { partyId } as unknown as Borrower;
    // And no file, for the same reason. `tokenFor` asks the party's grants
    // before it asks any application whether the signature was made there, so
    // a party with no grant of any purpose is refused without the file being
    // read at all — which is what this loop is about.
    const nowhere = { id: randomUUID(), borrowers: [] } as unknown as LoanFile;
    for (const category of Object.keys(PURPOSE_FOR) as DataCategory[]) {
      // Both halves, in this order, because the denial on its own would read
      // the same if the trigger were gone: a party with no grant is refused by
      // the absence of a row, and a rule that has stopped refusing looks
      // exactly like a rule nothing has tested. So the row the minter would
      // accept is offered first, and refused.
      await expect(
        prisma.authorization.create({
          data: {
            partyId,
            purpose: PURPOSE_FOR[category].toUpperCase() as AuthorizationPurpose,
            dataCategories: [category.toUpperCase() as DataCategoryEnum],
            grantedAt: GRANTED,
            expiresAt: EXPIRES,
          },
        }),
      ).rejects.toThrow(/an imported record is not a consent/);
      await expect(tokenFor(nowhere, subject, category)).rejects.toThrow(
        /No authorization to retrieve .*: no authorization of this purpose has ever been granted/,
      );
    }
  });
});

describe("claim status moves forward", () => {
  it("refuses a provisional party being declared claimed", async () => {
    // The edge that would matter most and does not exist: a record a partner
    // sent us becoming a person who agreed to something, by an UPDATE.
    const { partyId } = await imported();
    await expect(
      prisma.party.update({ where: { id: partyId }, data: { claimStatus: "CLAIMED" } }),
    ).rejects.toThrow(/cannot go PROVISIONAL -> CLAIMED/);
  });

  it("refuses a claimed party going back", async () => {
    const user = await createUser();
    const partyId = await prisma.$transaction((tx) => partyForUser(tx, user.id));
    await expect(
      prisma.party.update({ where: { id: partyId }, data: { claimStatus: "PROVISIONAL" } }),
    ).rejects.toThrow(/cannot go CLAIMED -> PROVISIONAL/);
  });

  it("refuses a merge that names nobody", async () => {
    const { partyId } = await imported();
    await expect(
      prisma.party.update({ where: { id: partyId }, data: { claimStatus: "MERGED" } }),
    ).rejects.toThrow(/a merged party names the party it merged into/);
  });

  it("leaves a party alone when the update is about something else", async () => {
    const { partyId } = await imported();
    const same = await prisma.party.update({
      where: { id: partyId },
      data: { sourceFirstSeen: "grander_import_2" },
    });
    expect(same.claimStatus).toBe("PROVISIONAL");
  });

  it("refuses to repoint a merged party at somebody else", async () => {
    // Naming a survivor is checked on the way into MERGED. Once the status has
    // stopped moving, an UPDATE that touches only the pointer changes no
    // status at all — so without a rule of its own it would move one person's
    // imported record onto an account holder who never claimed it.
    const { partyId } = await imported();
    const first = await createUser();
    const second = await createUser();
    const survivor = await prisma.$transaction((tx) => partyForUser(tx, first.id));
    const stranger = await prisma.$transaction((tx) => partyForUser(tx, second.id));
    await prisma.$transaction((tx) => mergePartyInto(tx, partyId, survivor));

    await expect(
      prisma.party.update({ where: { id: partyId }, data: { mergedIntoPartyId: stranger } }),
    ).rejects.toThrow(/a merged party keeps the survivor it named/);
    const still = await prisma.party.findUniqueOrThrow({ where: { id: partyId } });
    expect(still.mergedIntoPartyId).toBe(survivor);
  });

  it("refuses to leave a merged party pointing at nobody", async () => {
    const { partyId } = await imported();
    const user = await createUser();
    const survivor = await prisma.$transaction((tx) => partyForUser(tx, user.id));
    await prisma.$transaction((tx) => mergePartyInto(tx, partyId, survivor));

    await expect(
      prisma.party.update({ where: { id: partyId }, data: { mergedIntoPartyId: null } }),
    ).rejects.toThrow(/a merged party keeps the survivor it named/);
  });

  it("refuses to delete a survivor out from under the parties merged into it", async () => {
    // `merged_into_party_id` is ON DELETE SET NULL, so deleting the survivor
    // on its own would null the pointer rather than fail — and leave a
    // stranger's date of birth that `partnerFactsFor` cannot reach and
    // `users_delete_takes_party` cannot take. The rule above turns that silent
    // rewrite into a refusal, which is what makes an eraser take the
    // merged-from rows itself. Account deletion already does, in that order.
    const { partyId } = await imported();
    const user = await createUser();
    const survivor = await prisma.$transaction((tx) => partyForUser(tx, user.id));
    await prisma.$transaction((tx) => mergePartyInto(tx, partyId, survivor));

    await expect(prisma.party.delete({ where: { id: survivor } })).rejects.toThrow(
      /a merged party keeps the survivor it named/,
    );

    await prisma.user.delete({ where: { id: user.id } });
    expect(await prisma.party.count({ where: { id: { in: [partyId, survivor] } } })).toBe(0);
  });
});

describe("folding a provisional party into the person it turned out to be", () => {
  it("moves the loans, marks the merge, and moves no facts", async () => {
    const { partyId } = await imported();
    const loan = await importedLoan([{ partyId }]);
    const user = await createUser();
    const survivor = await prisma.$transaction((tx) => partyForUser(tx, user.id));
    const before = await prisma.fact.count({ where: { partyId } });

    await prisma.$transaction((tx) => mergePartyInto(tx, partyId, survivor));

    // The mortgage is the thing the person came for, so it is the thing the
    // merge has to move: after this the loan reaches them through their own
    // party, which is what `assertLoanAccess` reads.
    const on = await prisma.loanParty.findMany({ where: { loanId: loan.id } });
    expect(on.map((p) => p.partyId)).toEqual([survivor]);

    const merged = await prisma.party.findUniqueOrThrow({ where: { id: partyId } });
    expect(merged.claimStatus).toBe("MERGED");
    expect(merged.mergedIntoPartyId).toBe(survivor);
    // The facts stay where they were asserted. `facts` is append-only, and
    // re-asserting a servicer's spelling onto the survivor would supersede the
    // person's own name with a partner's version of it.
    expect(await prisma.fact.count({ where: { partyId } })).toBe(before);
    expect(await prisma.fact.count({ where: { partyId: survivor } })).toBe(0);
  });

  it("refuses to merge into a party that was itself merged", async () => {
    const first = await imported();
    const second = await imported();
    const user = await createUser();
    const survivor = await prisma.$transaction((tx) => partyForUser(tx, user.id));
    await prisma.$transaction((tx) => mergePartyInto(tx, first.partyId, survivor));
    await expect(
      prisma.$transaction((tx) => mergePartyInto(tx, second.partyId, first.partyId)),
    ).rejects.toThrow(/merge into its survivor instead/);
  });

  it("refuses to fold a party that has already been folded into somebody", async () => {
    // The survivor check reads only the survivor, and both survivors here are
    // ordinary claimed parties, so nothing above sees this one. The status
    // stays MERGED across the second fold, which means no status changes and
    // the trigger's forward rule never looks. What it would do is move one
    // person's imported record — their name and their date of birth — from the
    // account holder who claimed it to one who did not, and leave the first
    // person's account deletion a row short.
    const { partyId } = await imported();
    const first = await createUser();
    const second = await createUser();
    const survivor = await prisma.$transaction((tx) => partyForUser(tx, first.id));
    const stranger = await prisma.$transaction((tx) => partyForUser(tx, second.id));
    await prisma.$transaction((tx) => mergePartyInto(tx, partyId, survivor));

    await expect(
      prisma.$transaction((tx) => mergePartyInto(tx, partyId, stranger)),
    ).rejects.toThrow(/only a party nobody has claimed can be folded into another/);

    expect(await partnerFactsFor(prisma, survivor)).toHaveLength(2);
    expect(await partnerFactsFor(prisma, stranger)).toHaveLength(0);
    await prisma.user.delete({ where: { id: first.id } });
    expect(await prisma.party.count({ where: { id: partyId } })).toBe(0);
  });

  it("refuses to fold a party the person themselves has claimed", async () => {
    const first = await createUser();
    const second = await createUser();
    const mine = await prisma.$transaction((tx) => partyForUser(tx, first.id));
    const theirs = await prisma.$transaction((tx) => partyForUser(tx, second.id));
    await expect(prisma.$transaction((tx) => mergePartyInto(tx, mine, theirs))).rejects.toThrow(
      /only a party nobody has claimed can be folded into another/,
    );
  });

  it("refuses to merge into a party nobody has claimed", async () => {
    // The refusal that keeps a chain from existing at all. PROVISIONAL ->
    // MERGED is a legal edge, so a survivor that is not CLAIMED can be merged
    // onward, and the two things below assume it cannot be.
    const first = await imported();
    const second = await imported();
    await expect(
      prisma.$transaction((tx) => mergePartyInto(tx, first.partyId, second.partyId)),
    ).rejects.toThrow(/a merge survivor must be a claimed party/);
    const untouched = await prisma.party.findUniqueOrThrow({ where: { id: first.partyId } });
    expect(untouched.claimStatus).toBe("PROVISIONAL");
  });

  it("keeps every merged party one hop from the person, for the reader and the reaper", async () => {
    // The two things the guard above is for, asserted rather than argued.
    // `partnerFactsFor` follows one hop and `users_delete_takes_party` deletes
    // one hop, so a two-hop chain would hide a stranger's date of birth from
    // both: invisible to the person it is about, and left standing after they
    // close their account.
    const far = await imported();
    const near = await imported();
    const user = await createUser();
    const survivor = await prisma.$transaction((tx) => partyForUser(tx, user.id));
    await expect(
      prisma.$transaction(async (tx) => {
        await mergePartyInto(tx, far.partyId, near.partyId);
        await mergePartyInto(tx, near.partyId, survivor);
      }),
    ).rejects.toThrow(/a merge survivor must be a claimed party/);

    // Both records are still where a merge could reach them, and both go when
    // the person does.
    await prisma.$transaction(async (tx) => {
      await mergePartyInto(tx, far.partyId, survivor);
      await mergePartyInto(tx, near.partyId, survivor);
    });
    expect(await partnerFactsFor(prisma, survivor)).toHaveLength(4);
    await prisma.user.delete({ where: { id: user.id } });
    expect(
      await prisma.party.count({ where: { id: { in: [far.partyId, near.partyId, survivor] } } }),
    ).toBe(0);
    expect(
      await prisma.fact.count({ where: { partyId: { in: [far.partyId, near.partyId] } } }),
    ).toBe(0);
  });

  it("keeps what the partner said reachable from the survivor", async () => {
    const { partyId } = await imported();
    const user = await createUser();
    const survivor = await prisma.$transaction((tx) => partyForUser(tx, user.id));
    // Invisible before the merge: the survivor is a different person until the
    // pointer says otherwise.
    expect(await partnerFactsFor(prisma, survivor)).toHaveLength(0);

    await prisma.$transaction((tx) => mergePartyInto(tx, partyId, survivor));

    const found = await partnerFactsFor(prisma, survivor);
    expect(found.map((f) => f.predicate).sort()).toEqual(["date_of_birth", "legal_name"]);
    expect(found.every((f) => f.sourceKind === "PARTNER_SHARED")).toBe(true);
  });

  it("does not hand back what the person said themselves", async () => {
    // The refinance prefill labels its fields "your servicer told us". Mixing
    // the borrower's own attested facts in would put that label on their own
    // words, which is the one thing the tier separation exists to prevent.
    const { partyId } = await imported();
    const user = await createUser();
    const survivor = await prisma.$transaction((tx) => partyForUser(tx, user.id));
    const own = await prisma.principal.create({
      data: { kind: "BORROWER", subject: `party:${survivor}`, partyId: survivor },
      select: { id: true },
    });
    await prisma.fact.create({
      data: {
        subjectType: "PARTY",
        subjectId: survivor,
        partyId: survivor,
        predicate: "legal_name",
        value: { first: "Mari", last: "Okonkwo" },
        sourceKind: "SELF_ATTESTED",
        confidence: "ATTESTED",
        assertedByPrincipalId: own.id,
        observedAt: new Date(),
      },
    });
    await prisma.$transaction((tx) => mergePartyInto(tx, partyId, survivor));

    const found = await partnerFactsFor(prisma, survivor);
    expect(found).toHaveLength(2);
    expect(found.every((f) => f.partyId === partyId)).toBe(true);
  });
});
