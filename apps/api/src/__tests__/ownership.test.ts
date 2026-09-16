/**
 * An asset has an owner, a liability has an obligor, an expense has a payer,
 * and none of the three is a shape the serializer gets to discover.
 *
 * All 110 assets and all 110 liabilities across the eighteen shipped sample
 * files carry an owner arc, and the DU Map says why: where a value is present
 * in AssetType, LiabilityType or ExpenseType, an arc role must say which party
 * it belongs to. So a row with no owner is not untidy — it is a row that
 * cannot be emitted, and the database refuses to hold one.
 *
 * It refuses at COMMIT rather than at the statement, because the row and its
 * first arc have to land together and neither is writable before the other.
 * That is what `writeAsset` and its siblings exist for, and it is also why
 * almost everything here runs inside an explicit transaction: a deferred
 * constraint is only observable through one.
 *
 * Four shapes below are the reason the triggers are written the way they are,
 * and each is a case an obvious implementation gets wrong. A revive is an
 * UPDATE, so an INSERT-only trigger never sees the moment a superseded row
 * becomes live again. A row created and dropped in one transaction is not
 * going into a document, so it is nobody's business. A superseded row is not
 * going into a document either, so dropping its last arc is allowed. And the
 * fifty-row cap counts LIVE rows, because a cap on ingest is a lockout and a
 * cap on emission is the actual rule.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma, type ApplicationPartyRole, type Prisma } from "@hm/db";
import { writeAsset, writeExpense, writeLiability } from "@hm/du";
import { ensureApplicationParty } from "../services/applications.js";
import { createLoanFile, createParty, createUser } from "./support/factories.js";

/** A credit request with as many borrowing edges as a test asks for. */
interface Application {
  id: string;
  loanFileId: string;
  /** `application_parties` rows, which are what an owner arc points at. */
  borrowers: string[];
}

async function anApplication(
  roles: readonly ApplicationPartyRole[] = ["PRIMARY_BORROWER"],
): Promise<Application> {
  const user = await createUser();
  const file = await createLoanFile({ userId: user.id });
  const app = await prisma.application.create({
    data: { loanFileId: file.id, ausCasefileId: randomUUID() },
    select: { id: true },
  });
  const borrowers: string[] = [];
  for (const role of roles) {
    const party = await createParty();
    const edge = await ensureApplicationParty(prisma, app.id, party.id, role);
    borrowers.push(edge.id);
  }
  return { id: app.id, loanFileId: file.id, borrowers };
}

/** The first borrowing edge, which is whose row it is unless a test says otherwise. */
const owner = (app: Application): string => app.borrowers[0]!;

function assetFor(
  applicationId: string,
  overrides: Partial<Prisma.DuAssetUncheckedCreateInput> = {},
): Prisma.DuAssetUncheckedCreateInput {
  return {
    applicationId,
    kind: "DEPOSIT_ACCOUNT",
    assetType: "CheckingAccount",
    cashOrMarketValueCents: 1_250_000n,
    holderName: "First Federal",
    accountIdentifier: "4455",
    identityKey: `manual:${randomUUID()}`,
    ...overrides,
  };
}

function liabilityFor(
  applicationId: string,
  overrides: Partial<Prisma.DuLiabilityUncheckedCreateInput> = {},
): Prisma.DuLiabilityUncheckedCreateInput {
  return {
    applicationId,
    liabilityType: "Revolving",
    holderName: "Shoreline CU",
    unpaidBalanceCents: 240_000n,
    monthlyPaymentCents: 4_500n,
    payoffStatus: false,
    identityKey: `manual:${randomUUID()}`,
    ...overrides,
  };
}

function expenseFor(
  applicationId: string,
  overrides: Partial<Prisma.DuExpenseUncheckedCreateInput> = {},
): Prisma.DuExpenseUncheckedCreateInput {
  return {
    applicationId,
    expenseType: "Alimony",
    monthlyPaymentCents: 90_000n,
    ...overrides,
  };
}

/** An asset and its arcs, through the writer, in the one transaction they need. */
async function ownedAsset(
  app: Application,
  owners: readonly string[] = [owner(app)],
  overrides: Partial<Prisma.DuAssetUncheckedCreateInput> = {},
): Promise<string> {
  const [first, ...rest] = owners;
  return prisma.$transaction((tx) =>
    writeAsset(tx, {
      asset: assetFor(app.id, overrides),
      owners: [{ applicationPartyId: first! }, ...rest.map((id) => ({ applicationPartyId: id }))],
    }),
  );
}

async function owedLiability(
  app: Application,
  obligors: readonly string[] = [owner(app)],
  overrides: Partial<Prisma.DuLiabilityUncheckedCreateInput> = {},
): Promise<string> {
  const [first, ...rest] = obligors;
  return prisma.$transaction((tx) =>
    writeLiability(tx, {
      liability: liabilityFor(app.id, overrides),
      obligors: [{ applicationPartyId: first! }, ...rest.map((id) => ({ applicationPartyId: id }))],
    }),
  );
}

async function paidExpense(
  app: Application,
  payers: readonly string[] = [owner(app)],
  overrides: Partial<Prisma.DuExpenseUncheckedCreateInput> = {},
): Promise<string> {
  const [first, ...rest] = payers;
  return prisma.$transaction((tx) =>
    writeExpense(tx, {
      expense: expenseFor(app.id, overrides),
      payers: [{ applicationPartyId: first! }, ...rest.map((id) => ({ applicationPartyId: id }))],
    }),
  );
}

const liveAssets = (applicationId: string): Promise<number> =>
  prisma.duAsset.count({ where: { applicationId, retiredAt: null } });

describe("an owner is a borrowing party on this application", () => {
  it("refuses an arc to an edge on somebody else's application", async () => {
    // An arc across two applications emits an `xlink:to` naming a ROLE label
    // this document does not contain, and the XSD accepts that silently.
    const mine = await anApplication();
    const theirs = await anApplication();
    await expect(ownedAsset(mine, [owner(theirs)])).rejects.toThrow(
      /an arc across two applications points at a label/,
    );
    expect(await prisma.duAsset.count()).toBe(0);
  });

  it("refuses an arc to a non-borrowing spouse", async () => {
    // A non-borrowing spouse does not become a DU Borrower element, so an arc
    // pointing at one points at a ROLE the document never emits. They are the
    // only non-borrowing role left: a co-signer is a NON_OCCUPANT_CO_BORROWER,
    // and no party role in the MISMO chain is a guarantor.
    const app = await anApplication(["PRIMARY_BORROWER", "NON_BORROWING_SPOUSE"]);
    const [, spouse] = app.borrowers;
    await expect(ownedAsset(app, [spouse!])).rejects.toThrow(/is not a DU Borrower/);
    await expect(owedLiability(app, [spouse!])).rejects.toThrow(/is not a DU Borrower/);
    await expect(paidExpense(app, [spouse!])).rejects.toThrow(/is not a DU Borrower/);
  });

  it("takes a non-occupant co-borrower, which IS one", async () => {
    const app = await anApplication(["PRIMARY_BORROWER", "NON_OCCUPANT_CO_BORROWER"]);
    const id = await ownedAsset(app, [app.borrowers[1]!]);
    expect(await prisma.duAssetParty.count({ where: { assetId: id } })).toBe(1);
  });

  it("records joint ownership as two arcs, because there is no other way", async () => {
    // MISMO has no "joint" flag and no place on a RELATIONSHIP to record a
    // share: a 60/40 split has no wire representation, and a second owner is a
    // second arc.
    const app = await anApplication(["PRIMARY_BORROWER", "CO_BORROWER"]);
    const id = await ownedAsset(app, app.borrowers);
    expect(await prisma.duAssetParty.count({ where: { assetId: id } })).toBe(2);
  });
});

describe("nothing emittable is left without an owner", () => {
  it("rolls back an asset written with no arc at all", async () => {
    const app = await anApplication();
    await expect(prisma.duAsset.create({ data: assetFor(app.id) })).rejects.toThrow(
      /du_assets .* has no party link and cannot be emitted/,
    );
    expect(await prisma.duAsset.count()).toBe(0);
  });

  it("rolls back a liability and an expense written with no arc either", async () => {
    const app = await anApplication();
    await expect(prisma.duLiability.create({ data: liabilityFor(app.id) })).rejects.toThrow(
      /du_liabilities .* has no party link and cannot be emitted/,
    );
    // The expense is the one whose table has no `retired_at`, which is why the
    // liveness predicate is a trigger argument rather than a WHERE clause.
    await expect(prisma.duExpense.create({ data: expenseFor(app.id) })).rejects.toThrow(
      /du_expenses .* has no party link and cannot be emitted/,
    );
  });

  it("rolls back the deletion of the only arc, in a later transaction", async () => {
    // The check that an INSERT-only trigger cannot make: the asset was written
    // correctly and is stripped afterwards. `DELETE FROM du_asset_parties`
    // otherwise reports DELETE 1 and leaves the asset standing with no owner.
    const app = await anApplication();
    const assetId = await ownedAsset(app);
    await expect(prisma.duAssetParty.deleteMany({ where: { assetId } })).rejects.toThrow(
      /du_assets .* has no party link left and cannot be emitted/,
    );
    expect(await prisma.duAssetParty.count({ where: { assetId } })).toBe(1);
  });

  it("rolls back removing the last obligor and the last payer too", async () => {
    // The mirror runs on all three join tables. `du_expense_parties` is the one
    // whose parent has no `retired_at`, so it is also where the liveness
    // predicate being a trigger argument stops being an abstraction.
    const app = await anApplication();
    const liabilityId = await owedLiability(app);
    const expenseId = await paidExpense(app);
    await expect(prisma.duLiabilityParty.deleteMany({ where: { liabilityId } })).rejects.toThrow(
      /du_liabilities .* has no party link left and cannot be emitted/,
    );
    await expect(prisma.duExpenseParty.deleteMany({ where: { expenseId } })).rejects.toThrow(
      /du_expenses .* has no party link left and cannot be emitted/,
    );
  });

  it("rolls back the deletion of the application_parties row the arc points at", async () => {
    const app = await anApplication();
    await ownedAsset(app);
    await expect(prisma.applicationParty.delete({ where: { id: owner(app) } })).rejects.toThrow(
      /du_assets .* has no party link left and cannot be emitted/,
    );
    expect(await prisma.applicationParty.count({ where: { id: owner(app) } })).toBe(1);
  });

  it("rolls back reviving a retired row that has no arc left", async () => {
    // Four permitted statements reach a live asset with zero owners, and the
    // last of them is an UPDATE. An `AFTER INSERT` trigger fires at none of it.
    const app = await anApplication();
    const assetId = await ownedAsset(app);
    await prisma.duAsset.update({ where: { id: assetId }, data: { retiredAt: new Date() } });
    await prisma.duAssetParty.deleteMany({ where: { assetId } });

    await expect(
      prisma.duAsset.update({ where: { id: assetId }, data: { retiredAt: null } }),
    ).rejects.toThrow(/du_assets .* has no party link and cannot be emitted/);
    const still = await prisma.duAsset.findUniqueOrThrow({ where: { id: assetId } });
    expect(still.retiredAt).not.toBeNull();
  });

  it("commits an asset created and deleted inside ONE transaction", async () => {
    // A row that no longer exists is not going into a document, so it is not
    // this rule's business. Without the existence probe the transaction aborts
    // at COMMIT with "cannot be emitted" about a row that is gone.
    const app = await anApplication();
    await prisma.$transaction(async (tx) => {
      const id = await writeAsset(tx, {
        asset: assetFor(app.id),
        owners: [{ applicationPartyId: owner(app) }],
      });
      await tx.duAsset.delete({ where: { id } });
    });
    expect(await prisma.duAsset.count()).toBe(0);
    expect(await prisma.duAssetParty.count()).toBe(0);
  });

  it("commits an expense created and deleted inside ONE transaction", async () => {
    const app = await anApplication();
    await prisma.$transaction(async (tx) => {
      const id = await writeExpense(tx, {
        expense: expenseFor(app.id),
        payers: [{ applicationPartyId: owner(app) }],
      });
      await tx.duExpense.delete({ where: { id } });
    });
    expect(await prisma.duExpense.count()).toBe(0);
  });

  it("commits retiring an asset and then removing its last arc", async () => {
    // A superseded row is not emitted, so it does not need an owner. Without
    // this, dropping a borrower from a file would be refused because of an
    // account a re-pull superseded three days earlier — which makes an
    // ordinary operation impossible for every borrower a pull has touched.
    const app = await anApplication();
    const assetId = await ownedAsset(app);
    await prisma.duAsset.update({ where: { id: assetId }, data: { retiredAt: new Date() } });
    await prisma.duAssetParty.deleteMany({ where: { assetId } });
    expect(await prisma.duAssetParty.count({ where: { assetId } })).toBe(0);
    expect(await prisma.duAsset.count({ where: { id: assetId } })).toBe(1);
  });

  it("lets a jointly owned row lose one owner and keep the other", async () => {
    const app = await anApplication(["PRIMARY_BORROWER", "CO_BORROWER"]);
    const assetId = await ownedAsset(app, app.borrowers);
    await prisma.applicationParty.delete({ where: { id: app.borrowers[1]! } });
    expect(await prisma.duAssetParty.count({ where: { assetId } })).toBe(1);
    expect(await liveAssets(app.id)).toBe(1);
  });
});

describe("fifty is the container maximum, counted live", () => {
  /** `n` live assets on one application, all written in one transaction. */
  async function fill(app: Application, n: number): Promise<void> {
    await prisma.$transaction(
      async (tx) => {
        for (let i = 0; i < n; i += 1) {
          await writeAsset(tx, {
            asset: assetFor(app.id, { accountIdentifier: `${1000 + i}` }),
            owners: [{ applicationPartyId: owner(app) }],
          });
        }
      },
      { timeout: 30_000 },
    );
  }

  it("refuses a fifty-first live asset", async () => {
    const app = await anApplication();
    await fill(app, 50);
    expect(await liveAssets(app.id)).toBe(50);
    await expect(ownedAsset(app)).rejects.toThrow(/du_assets is 0:50 per DEAL/);
    expect(await liveAssets(app.id)).toBe(50);
  });

  it("refuses a revive that would carry the live count past fifty", async () => {
    // The cap counts at COMMIT, on INSERT OR UPDATE, for the same reason the
    // owner check does: a BEFORE INSERT count cannot see a row that becomes
    // live by having `retired_at` cleared. Fifty-one rows and fifty live is a
    // legal state, and the fifty-first row coming back is not.
    const app = await anApplication();
    const spare = await prisma.$transaction(
      async (tx) => {
        let last = "";
        for (let i = 0; i < 51; i += 1) {
          last = await writeAsset(tx, {
            asset: assetFor(app.id, { accountIdentifier: `${2000 + i}` }),
            owners: [{ applicationPartyId: owner(app) }],
          });
        }
        await tx.duAsset.update({ where: { id: last }, data: { retiredAt: new Date() } });
        return last;
      },
      { timeout: 30_000 },
    );
    expect(await liveAssets(app.id)).toBe(50);

    await expect(
      prisma.duAsset.update({ where: { id: spare }, data: { retiredAt: null } }),
    ).rejects.toThrow(/du_assets is 0:50 per DEAL/);
    expect(await liveAssets(app.id)).toBe(50);
  });

  it("admits a seventh pull after six supersede cycles of twelve assets", async () => {
    // The lockout this exists to prevent. Counting every row ever written, on
    // a table whose whole re-pull design is to accumulate superseded ones,
    // refuses the fifth pull — permanently, and identically for every pull
    // after it — while the document those rows would emit carries twelve
    // `<ASSET>` elements against a limit of fifty.
    const app = await anApplication();
    let live: string[] = [];

    for (let pull = 0; pull < 7; pull += 1) {
      live = await prisma.$transaction(
        async (tx) => {
          const written: string[] = [];
          for (let account = 0; account < 12; account += 1) {
            written.push(
              await writeAsset(tx, {
                asset: assetFor(app.id, { accountIdentifier: `${3000 + account}` }),
                owners: [{ applicationPartyId: owner(app) }],
                // Nothing computes an identity key yet, so a re-pull writes a
                // replacement rather than reviving the row it replaces. What
                // the cap sees is the same either way: twelve live rows.
                ...(live[account] === undefined ? {} : { supersedes: { id: live[account]! } }),
              }),
            );
          }
          return written;
        },
        { timeout: 30_000 },
      );
      expect(await liveAssets(app.id)).toBe(12);
    }

    expect(await prisma.duAsset.count({ where: { applicationId: app.id } })).toBe(84);
  });
});

describe("the joint credit report is a partition", () => {
  async function link(applicationId: string, from: string, to: string) {
    return prisma.duJointCreditReportLink.create({
      data: {
        applicationId,
        fromApplicationPartyId: from,
        toApplicationPartyId: to,
      },
    });
  }

  it("shares one report between two borrowers, primary under `to`", async () => {
    const app = await anApplication(["PRIMARY_BORROWER", "CO_BORROWER"]);
    const [first, second] = app.borrowers;
    const written = await link(app.id, second!, first!);
    expect(written.toApplicationPartyId).toBe(first);
  });

  it("refuses a group primary who is already an additional borrower", async () => {
    // A group has exactly one primary, so a party who is a `from` may not also
    // be a `to`. DI-C02 emits BORROWER_3 → BORROWER_2 while BORROWER_1 stands
    // alone, which is why this cannot be derived from the application's own
    // primary-versus-co distinction and has to be checked here.
    const app = await anApplication(["PRIMARY_BORROWER", "CO_BORROWER", "CO_BORROWER"]);
    const [first, second, third] = app.borrowers;
    await link(app.id, second!, first!);
    await expect(link(app.id, third!, second!)).rejects.toThrow(
      /already an additional borrower on this application/,
    );
    await expect(link(app.id, first!, third!)).rejects.toThrow(
      /already a group primary on this application/,
    );
  });

  it("refuses a link naming an edge on another application", async () => {
    // The one arc whose DIRECTION is load-bearing: a wrong endpoint makes DU
    // read the wrong borrower as the group's primary, and the foreign keys tie
    // each end to some edge without tying either to this application.
    const mine = await anApplication(["PRIMARY_BORROWER", "CO_BORROWER"]);
    const theirs = await anApplication();
    await expect(link(mine.id, mine.borrowers[1]!, owner(theirs))).rejects.toThrow(
      /an arc across two applications points at a label/,
    );
  });

  it("refuses a link naming a non-borrowing spouse", async () => {
    const app = await anApplication(["PRIMARY_BORROWER", "NON_BORROWING_SPOUSE"]);
    const [first, spouse] = app.borrowers;
    await expect(link(app.id, spouse!, first!)).rejects.toThrow(
      /a joint credit report is shared between two DU Borrowers/,
    );
  });

  it("refuses a borrower sharing a report with themselves", async () => {
    const app = await anApplication();
    await expect(link(app.id, owner(app), owner(app))).rejects.toThrow(
      /du_joint_credit_links_are_not_reflexive/,
    );
  });
});

describe("a role flip cannot strand an arc", () => {
  // The position goes with the role. A non-borrowing spouse emits no BORROWER
  // element, so there is no document position for them to keep, and
  // `application_parties_borrowers_are_numbered` refuses a demotion that tries
  // to hold on to one.
  const flip = (id: string) =>
    prisma.applicationParty.update({
      where: { id },
      data: { role: "NON_BORROWING_SPOUSE", borrowerOrdinal: null },
    });

  it("refuses a co-borrower who owns an asset", async () => {
    const app = await anApplication(["PRIMARY_BORROWER", "CO_BORROWER"]);
    await ownedAsset(app, [app.borrowers[1]!]);
    await expect(flip(app.borrowers[1]!)).rejects.toThrow(
      /carries DU borrower rows and cannot become NON_BORROWING_SPOUSE/,
    );
  });

  it("refuses a co-borrower who is an obligor on a liability", async () => {
    const app = await anApplication(["PRIMARY_BORROWER", "CO_BORROWER"]);
    await owedLiability(app, [app.borrowers[1]!]);
    await expect(flip(app.borrowers[1]!)).rejects.toThrow(
      /carries DU borrower rows and cannot become NON_BORROWING_SPOUSE/,
    );
  });

  it("refuses a co-borrower who pays an expense", async () => {
    const app = await anApplication(["PRIMARY_BORROWER", "CO_BORROWER"]);
    await paidExpense(app, [app.borrowers[1]!]);
    await expect(flip(app.borrowers[1]!)).rejects.toThrow(
      /carries DU borrower rows and cannot become NON_BORROWING_SPOUSE/,
    );
  });

  it("refuses a co-borrower on either end of a joint credit link", async () => {
    const app = await anApplication(["PRIMARY_BORROWER", "CO_BORROWER"]);
    const [first, second] = app.borrowers;
    await prisma.duJointCreditReportLink.create({
      data: {
        applicationId: app.id,
        fromApplicationPartyId: second!,
        toApplicationPartyId: first!,
      },
    });
    await expect(flip(second!)).rejects.toThrow(/carries DU borrower rows/);
    await expect(flip(first!)).rejects.toThrow(/carries DU borrower rows/);
  });

  it("lets a co-borrower who carries none of it become a non-borrowing spouse", async () => {
    // The green case, so that none of the refusals above can be passing
    // because the flip is refused for some other reason.
    const app = await anApplication(["PRIMARY_BORROWER", "CO_BORROWER"]);
    const flipped = await flip(app.borrowers[1]!);
    expect(flipped.role).toBe("NON_BORROWING_SPOUSE");
  });
});

describe("two rows the identity index must not collapse into one", () => {
  /**
   * Two gifts from a parent, two piles of cash on hand, two other assets.
   *
   * Each pair is identical on everything DU says about it — kind, type, funds
   * source — so a content key built from those columns alone gives both rows
   * the same identity and the second one silently overwrites the first. What
   * keeps them apart is that the key is per-row, and what this asserts is that
   * both survive with an arc each.
   */
  it("writes two of each and gives each one its own owner arc", async () => {
    const app = await anApplication();
    const pairs: Partial<Prisma.DuAssetUncheckedCreateInput>[][] = [
      [
        {
          kind: "GIFT_OR_GRANT",
          assetType: "GiftOfCash",
          fundsSourceType: "Parent",
          holderName: null,
          accountIdentifier: null,
          cashOrMarketValueCents: 1_000_000n,
        },
      ],
      [
        {
          kind: "OTHER_ASSET",
          assetType: "CashOnHand",
          holderName: null,
          accountIdentifier: null,
          cashOrMarketValueCents: 80_000n,
        },
      ],
      [
        {
          kind: "OTHER_ASSET",
          assetType: "Other",
          assetTypeOtherDescription: "OtherNonLiquidAsset",
          holderName: null,
          accountIdentifier: null,
          cashOrMarketValueCents: 250_000n,
        },
      ],
    ];

    for (const [shape] of pairs) {
      await ownedAsset(app, [owner(app)], shape);
      await ownedAsset(app, [owner(app)], shape);
    }

    expect(await liveAssets(app.id)).toBe(6);
    const arcs = await prisma.duAssetParty.groupBy({
      by: ["assetId"],
      _count: { _all: true },
    });
    expect(arcs).toHaveLength(6);
    expect(arcs.every((row) => row._count._all === 1)).toBe(true);
  });
});

describe("the writer refuses the shape that cannot satisfy the check", () => {
  it("will not run outside a transaction", async () => {
    // `prisma.duAsset.create()` then `prisma.duAssetParty.create()` is two
    // transactions, and the first one fails at COMMIT about a row that looks
    // like it was written. The signature is what stops a caller expressing it,
    // and this is the half TypeScript cannot hold: the full client has every
    // method a transaction client has.
    const app = await anApplication();
    await expect(
      writeAsset(prisma, {
        asset: assetFor(app.id),
        owners: [{ applicationPartyId: owner(app) }],
      }),
    ).rejects.toThrow(/must be called inside prisma\.\$transaction/);
    expect(await prisma.duAsset.count()).toBe(0);
  });

  it("will not name one borrower twice", async () => {
    const app = await anApplication();
    await expect(
      prisma.$transaction((tx) =>
        writeAsset(tx, {
          asset: assetFor(app.id),
          owners: [{ applicationPartyId: owner(app) }, { applicationPartyId: owner(app) }],
        }),
      ),
    ).rejects.toThrow(/twice; one arc per borrower per row/);
  });
});
