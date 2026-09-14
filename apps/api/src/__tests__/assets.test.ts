/**
 * What a borrower owns, what they owe, and the property behind both.
 *
 * Every promise these four tables make is a constraint, an index or a trigger,
 * so all of it runs against the real Postgres. A suite that mocked the database
 * would see an owned property hanging off a checking account, a gift typed as a
 * savings account, and a two-lien REO reporting the balance of one lien.
 *
 * Three shapes here are expensive to get wrong later and cheap to hold now, and
 * they are what most of this file is about. An OWNED_PROPERTY row nests INSIDE
 * an asset rather than beside it, and a composite foreign key is what makes
 * that true. A liability names the property securing it, one property takes
 * two liens, and the lien total is DERIVED from them rather than asserted by a
 * caller. And the identity index spans retired rows, so an account that goes
 * away and comes back is one row rather than two.
 *
 * Ownership is not what this file is about — `ownership.test.ts` is — but it
 * is unavoidable here: a live asset, liability or expense with no owner arc
 * rolls back at COMMIT, so every row below is written through `writeAsset` and
 * its siblings, which pair the row with its owners in one transaction.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma, type Prisma } from "@hm/db";
import { writeAsset, writeExpense, writeLiability } from "@hm/du";
import { createLoanFile, createParty, createUser } from "./support/factories.js";

/** A credit request, and the one borrowing edge that owns every row on it. */
interface Application {
  id: string;
  /** An `application_parties` row, which is what an owner arc points at. */
  owner: string;
}

async function anApplication(): Promise<Application> {
  const user = await createUser();
  const file = await createLoanFile({ userId: user.id });
  const app = await prisma.application.create({
    data: { loanFileId: file.id, ausCasefileId: randomUUID() },
    select: { id: true },
  });
  const party = await createParty();
  const edge = await prisma.applicationParty.create({
    data: { applicationId: app.id, partyId: party.id, role: "PRIMARY_BORROWER" },
    select: { id: true },
  });
  return { id: app.id, owner: edge.id };
}

/**
 * The three writers, wrapped so a test reads the row back rather than an id.
 *
 * A refusal this file is testing fires at the statement, so the tests that
 * expect one still go straight at `prisma.duAsset.create` — what these are for
 * is the rows that are supposed to land.
 */
async function anAsset(app: Application, data: Prisma.DuAssetUncheckedCreateInput) {
  const id = await prisma.$transaction((tx) =>
    writeAsset(tx, { asset: data, owners: [{ applicationPartyId: app.owner }] }),
  );
  return prisma.duAsset.findUniqueOrThrow({ where: { id } });
}

async function aLiability(app: Application, data: Prisma.DuLiabilityUncheckedCreateInput) {
  const id = await prisma.$transaction((tx) =>
    writeLiability(tx, { liability: data, obligors: [{ applicationPartyId: app.owner }] }),
  );
  return prisma.duLiability.findUniqueOrThrow({ where: { id } });
}

async function anExpense(app: Application, data: Prisma.DuExpenseUncheckedCreateInput) {
  const id = await prisma.$transaction((tx) =>
    writeExpense(tx, { expense: data, payers: [{ applicationPartyId: app.owner }] }),
  );
  return prisma.duExpense.findUniqueOrThrow({ where: { id } });
}

/**
 * A checking account, the ordinary 2a row.
 *
 * The identity key is a fresh uuid by default because nothing in this change
 * computes one: the matcher that derives a key from a vendor payload arrives
 * with the writer, and a key that matches nothing is the honest placeholder
 * until it does.
 */
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

/** An REO asset: kind and identity and nothing else, by CHECK. */
async function anReoAsset(app: Application): Promise<string> {
  const asset = await anAsset(app, {
    applicationId: app.id,
    kind: "OWNED_PROPERTY",
    identityKey: `manual:${randomUUID()}`,
  });
  return asset.id;
}

/** A retained second home the borrower owns outright, with its own address. */
function reoFor(
  assetId: string,
  applicationId: string,
  overrides: Partial<Prisma.DuOwnedPropertyUncheckedCreateInput> = {},
): Prisma.DuOwnedPropertyUncheckedCreateInput {
  return {
    assetId,
    applicationId,
    dispositionStatus: "Retain",
    addressLineText: "1234 Ocean Pines",
    cityName: "Rehobeth",
    stateCode: "MD",
    postalCode: "21857",
    countryCode: "US",
    currentUsage: "SecondHome",
    intendedUsage: "SecondHome",
    estimatedValueCents: 42_000_000n,
    ...overrides,
  };
}

function liabilityFor(
  applicationId: string,
  overrides: Partial<Prisma.DuLiabilityUncheckedCreateInput> = {},
): Prisma.DuLiabilityUncheckedCreateInput {
  return {
    applicationId,
    liabilityType: "MortgageLoan",
    holderName: "Callable Mortgage",
    unpaidBalanceCents: 21_002_700n,
    monthlyPaymentCents: 147_900n,
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

/** One cent past Amount 9.2, which is the widest amount the wire takes. */
const TOO_MUCH_MONEY = 100_000_000_000n;

describe("an asset is the kind it says it is", () => {
  it("writes one row of each kind", async () => {
    // The green cases first, so that none of the refusals below can be passing
    // because the row was unwritable for some other reason.
    const app = await anApplication();
    const written = [
      await anAsset(app, assetFor(app.id)),
      await anAsset(
        app,
        assetFor(app.id, {
          kind: "OTHER_ASSET",
          assetType: "CashOnHand",
          holderName: null,
          accountIdentifier: null,
          cashOrMarketValueCents: 80_000n,
        }),
      ),
      await anAsset(
        app,
        assetFor(app.id, {
          kind: "GIFT_OR_GRANT",
          assetType: "GiftOfCash",
          fundsSourceType: "Parent",
          includedInAssetAccount: false,
          holderName: null,
          accountIdentifier: null,
          cashOrMarketValueCents: 2_000_000n,
        }),
      ),
      await anAsset(app, {
        applicationId: app.id,
        kind: "OWNED_PROPERTY",
        identityKey: `manual:${randomUUID()}`,
      }),
    ];
    expect(written.map((row) => row.kind)).toEqual([
      "DEPOSIT_ACCOUNT",
      "OTHER_ASSET",
      "GIFT_OR_GRANT",
      "OWNED_PROPERTY",
    ]);
  });

  it("refuses an other asset typed as a checking account", async () => {
    // The one that matters most, because it is silent everywhere else. `kind`
    // is what says which URLA section a row is, and the 2b shape lets the
    // holder name and the account identifier be null — so a checking account
    // filed as an other asset reaches the wire with neither, both of which DU
    // requires once an amount exists.
    const app = await anApplication();
    await expect(
      prisma.duAsset.create({
        data: assetFor(app.id, {
          kind: "OTHER_ASSET",
          assetType: "CheckingAccount",
          holderName: null,
          accountIdentifier: null,
        }),
      }),
    ).rejects.toThrow(/du_assets_other_asset_shape/);
  });

  it("refuses a deposit account typed with a value only 2b carries", async () => {
    const app = await anApplication();
    await expect(
      prisma.duAsset.create({
        data: assetFor(app.id, { assetType: "CashOnHand", accountIdentifier: null }),
      }),
    ).rejects.toThrow(/du_assets_deposit_account_shape/);
  });

  it("refuses a gift typed with a value only 2a carries", async () => {
    const app = await anApplication();
    await expect(
      prisma.duAsset.create({
        data: assetFor(app.id, {
          kind: "GIFT_OR_GRANT",
          assetType: "SavingsAccount",
          fundsSourceType: "Parent",
          accountIdentifier: null,
        }),
      }),
    ).rejects.toThrow(/du_assets_gift_or_grant_shape/);
  });

  it("refuses a deposit account with no holder and one with no amount", async () => {
    const app = await anApplication();
    await expect(
      prisma.duAsset.create({ data: assetFor(app.id, { holderName: null }) }),
    ).rejects.toThrow(/du_assets_deposit_account_shape/);
    await expect(
      prisma.duAsset.create({ data: assetFor(app.id, { cashOrMarketValueCents: null }) }),
    ).rejects.toThrow(/du_assets_deposit_account_shape/);
  });

  it("refuses a row of every typed kind that names no AssetType at all", async () => {
    // The list alone does not say this. `NULL IN (...)` is NULL, `NULL AND
    // TRUE` is NULL, and a CHECK passes on NULL — so a shape CHECK written as
    // a value list constrains only the rows that already have a value, and a
    // row with an amount and no type walks straight past it. That row is the
    // one the discriminator exists to prevent: 2a.1, 2b.1 and 4d.1 are each
    // required once `AssetCashOrMarketValueAmount` exists, and all three kinds
    // require the amount.
    const app = await anApplication();
    await expect(
      prisma.duAsset.create({ data: assetFor(app.id, { assetType: null }) }),
    ).rejects.toThrow(/du_assets_deposit_account_shape/);
    await expect(
      prisma.duAsset.create({
        data: assetFor(app.id, {
          kind: "OTHER_ASSET",
          assetType: null,
          holderName: null,
          accountIdentifier: null,
        }),
      }),
    ).rejects.toThrow(/du_assets_other_asset_shape/);
    await expect(
      prisma.duAsset.create({
        data: assetFor(app.id, {
          kind: "GIFT_OR_GRANT",
          assetType: null,
          fundsSourceType: "Parent",
          holderName: null,
          accountIdentifier: null,
        }),
      }),
    ).rejects.toThrow(/du_assets_gift_or_grant_shape/);

    // And the type cannot be taken away afterwards either, which is a separate
    // path through the same rule.
    const written = await anAsset(app, assetFor(app.id));
    await expect(
      prisma.duAsset.update({ where: { id: written.id }, data: { assetType: null } }),
    ).rejects.toThrow(/du_assets_deposit_account_shape/);
  });

  it("refuses a gift with no source of funds", async () => {
    const app = await anApplication();
    await expect(
      prisma.duAsset.create({
        data: assetFor(app.id, {
          kind: "GIFT_OR_GRANT",
          assetType: "Grant",
          accountIdentifier: null,
        }),
      }),
    ).rejects.toThrow(/du_assets_gift_or_grant_shape/);
  });

  it("refuses an REO asset carrying an account number", async () => {
    // An REO asset carries no ASSET_DETAIL at all: 21 of them in the corpus,
    // none with one. The XSD permits the combination, so this is the only
    // place it is refused.
    const app = await anApplication();
    await expect(
      prisma.duAsset.create({
        data: {
          applicationId: app.id,
          kind: "OWNED_PROPERTY",
          accountIdentifier: "4455",
          identityKey: `manual:${randomUUID()}`,
        },
      }),
    ).rejects.toThrow(/du_assets_owned_property_carries_no_asset_detail/);
  });

  it("refuses an included-in-account indicator on a gift of property equity", async () => {
    // 4d.2 is conditional on the type being GiftOfCash or Grant. Property
    // equity is a credit in the transaction and was never in an account.
    const app = await anApplication();
    await expect(
      prisma.duAsset.create({
        data: assetFor(app.id, {
          kind: "GIFT_OR_GRANT",
          assetType: "GiftOfPropertyEquity",
          fundsSourceType: "Relative",
          includedInAssetAccount: true,
          accountIdentifier: null,
        }),
      }),
    ).rejects.toThrow(/du_assets_included_in_account_needs_cash_or_grant/);
  });

  it("binds the other-asset description to `Other`, in both directions", async () => {
    const app = await anApplication();
    const other = (
      overrides: Partial<Prisma.DuAssetUncheckedCreateInput>,
    ): Prisma.DuAssetUncheckedCreateInput =>
      assetFor(app.id, {
        kind: "OTHER_ASSET",
        assetType: "Other",
        holderName: null,
        accountIdentifier: null,
        ...overrides,
      });

    await expect(prisma.duAsset.create({ data: other({}) })).rejects.toThrow(
      /du_assets_other_description_needs_other/,
    );
    await expect(
      prisma.duAsset.create({
        data: other({ assetType: "CashOnHand", assetTypeOtherDescription: "OtherLiquidAsset" }),
      }),
    ).rejects.toThrow(/du_assets_other_description_needs_other/);
    const written = await anAsset(app, other({ assetTypeOtherDescription: "OtherNonLiquidAsset" }));
    expect(written.assetTypeOtherDescription).toBe("OtherNonLiquidAsset");
  });

  it("cannot be told about a coin collection at all", async () => {
    // `AssetTypeOtherDescription` is an enumeration with two members, not a
    // string with a width. Held as text, "Coin collection" passes every check
    // this repo has — the XSD types the element as a plain string — and DU
    // rejects the casefile days later.
    //
    // Two refusals, because either alone is weak. The `@ts-expect-error` is
    // itself an assertion: `npm run check` fails if the value ever type-checks.
    // And the INSERT below goes around the client entirely, because what makes
    // this a fact about the database rather than about Prisma's validator is
    // that the COLUMN is the enumeration.
    const app = await anApplication();
    await expect(
      prisma.duAsset.create({
        data: assetFor(app.id, {
          kind: "OTHER_ASSET",
          assetType: "Other",
          holderName: null,
          accountIdentifier: null,
          // @ts-expect-error a description outside the enumeration does not compile
          assetTypeOtherDescription: "Coin collection",
        }),
      }),
    ).rejects.toThrow(/Coin collection|Invalid value|invalid input value/i);

    await expect(
      prisma.$executeRaw`
        INSERT INTO "du_assets" (id, application_id, kind, asset_type,
                                 asset_type_other_description, cash_or_market_value_cents,
                                 identity_key, updated_at)
        VALUES (gen_random_uuid(), ${app.id}::uuid, 'OTHER_ASSET', 'Other',
                'Coin collection', 80000, ${`manual:${randomUUID()}`}, now())
      `,
    ).rejects.toThrow(/invalid input value for enum "DuAssetTypeOtherDescription"/);
  });

  it("binds the funds-source description to `Other`, in both directions", async () => {
    const app = await anApplication();
    const gift = (
      overrides: Partial<Prisma.DuAssetUncheckedCreateInput>,
    ): Prisma.DuAssetUncheckedCreateInput =>
      assetFor(app.id, {
        kind: "GIFT_OR_GRANT",
        assetType: "GiftOfCash",
        holderName: null,
        accountIdentifier: null,
        ...overrides,
      });

    await expect(
      prisma.duAsset.create({ data: gift({ fundsSourceType: "Other" }) }),
    ).rejects.toThrow(/du_assets_funds_source_description_needs_other/);
    await expect(
      prisma.duAsset.create({
        data: gift({ fundsSourceType: "Parent", fundsSourceTypeOtherDescription: "Godmother" }),
      }),
    ).rejects.toThrow(/du_assets_funds_source_description_needs_other/);
    // A deposit account and an other asset both leave `funds_source_type`
    // null, and `(NULL = 'Other') = TRUE` is NULL — so a plain equality here
    // lets a 2a row carry a gift's 4d.3 description, with no source to
    // describe.
    await expect(
      prisma.duAsset.create({
        data: assetFor(app.id, { fundsSourceTypeOtherDescription: "Godmother" }),
      }),
    ).rejects.toThrow(/du_assets_funds_source_description_needs_other/);
    await expect(
      prisma.duAsset.create({
        data: assetFor(app.id, {
          kind: "OTHER_ASSET",
          assetType: "CashOnHand",
          holderName: null,
          accountIdentifier: null,
          fundsSourceTypeOtherDescription: "Godmother",
        }),
      }),
    ).rejects.toThrow(/du_assets_funds_source_description_needs_other/);

    const written = await anAsset(
      app,
      gift({ fundsSourceType: "Other", fundsSourceTypeOtherDescription: "Godmother" }),
    );
    expect(written.fundsSourceTypeOtherDescription).toBe("Godmother");
  });

  it("refuses a holder name too long for the wire", async () => {
    // ASSET_HOLDER/NAME/FullName is String 150. A value too long for the wire
    // is a value that was wrong when it was written.
    const app = await anApplication();
    await expect(
      prisma.duAsset.create({
        data: assetFor(app.id, { holderName: "F".repeat(151) }),
      }),
    ).rejects.toThrow(/du_assets_strings_fit_the_wire/);
    const written = await anAsset(app, assetFor(app.id, { holderName: "F".repeat(150) }));
    expect(written.id).toBeTruthy();
  });

  it("refuses an amount wider than the wire takes", async () => {
    const app = await anApplication();
    await expect(
      prisma.duAsset.create({
        data: assetFor(app.id, { cashOrMarketValueCents: TOO_MUCH_MONEY }),
      }),
    ).rejects.toThrow(/du_assets_value_fits_amount_9_2/);
  });
});

describe("an owned property nests inside an REO asset", () => {
  it("attaches to an OWNED_PROPERTY asset", async () => {
    const app = await anApplication();
    const assetId = await anReoAsset(app);
    const written = await prisma.duOwnedProperty.create({
      data: reoFor(assetId, app.id),
      select: { id: true, assetId: true },
    });
    expect(written.assetId).toBe(assetId);
  });

  it("is refused by the composite foreign key on a deposit account", async () => {
    // MISMO enforces the nesting itself — <OWNED_PROPERTY> has no legal
    // position outside an ASSET — and this is the relational spelling of the
    // same rule. `asset_id` alone would happily point at a checking account.
    const app = await anApplication();
    const asset = await anAsset(app, assetFor(app.id));
    await expect(prisma.duOwnedProperty.create({ data: reoFor(asset.id, app.id) })).rejects.toThrow(
      /du_owned_properties_attach_to_an_reo_asset/,
    );
  });

  it("follows its asset's application rather than the one it was handed", async () => {
    // The denormalized `application_id` exists so that "one subject REO per
    // application" can be a partial unique index, and nothing may set it by
    // hand — a wrong value here would split the index's namespace in two.
    const app = await anApplication();
    const somebodyElse = await anApplication();
    const assetId = await anReoAsset(app);
    const written = await prisma.duOwnedProperty.create({
      data: reoFor(assetId, somebodyElse.id),
      select: { applicationId: true },
    });
    expect(written.applicationId).toBe(app.id);
  });

  it("refuses a second subject property on one application", async () => {
    // OwnedPropertySubjectIndicator is how DU links the REO schedule to
    // COLLATERALS; there is no arc. Two of them name two subject properties on
    // one deal.
    const app = await anApplication();
    const first = await anReoAsset(app);
    const second = await anReoAsset(app);
    await prisma.duOwnedProperty.create({
      data: reoFor(first, app.id, {
        isSubject: true,
        addressLineText: null,
        cityName: null,
        stateCode: null,
        postalCode: null,
        countryCode: null,
      }),
    });
    await expect(
      prisma.duOwnedProperty.create({
        data: reoFor(second, app.id, {
          isSubject: true,
          addressLineText: null,
          cityName: null,
          stateCode: null,
          postalCode: null,
          countryCode: null,
        }),
      }),
    ).rejects.toThrow(/du_owned_properties_one_subject_per_application/);
  });

  it("lets two applications each have their own subject property", async () => {
    const one = await anApplication();
    const two = await anApplication();
    for (const each of [one, two]) {
      const assetId = await anReoAsset(each);
      await prisma.duOwnedProperty.create({
        data: reoFor(assetId, each.id, {
          isSubject: true,
          addressLineText: null,
          cityName: null,
          stateCode: null,
          postalCode: null,
          countryCode: null,
        }),
      });
    }
    expect(await prisma.duOwnedProperty.count({ where: { isSubject: true } })).toBe(2);
  });

  it("makes a non-subject REO carry its own address", async () => {
    const app = await anApplication();
    const assetId = await anReoAsset(app);
    await expect(
      prisma.duOwnedProperty.create({
        data: reoFor(assetId, app.id, { postalCode: null }),
      }),
    ).rejects.toThrow(/du_owned_properties_non_subject_carries_its_own_address/);
  });

  it("takes a subject REO's address override whole, or not at all", async () => {
    // Null means "render the subject property's value here". A value means the
    // REO copy is deliberately different — DI-C04 emits "1234 Main St" inside
    // the REO against "1234 Main" under COLLATERALS. Half an override is the
    // drift the rule exists to prevent.
    const app = await anApplication();
    const partial = await anReoAsset(app);
    await expect(
      prisma.duOwnedProperty.create({
        data: reoFor(partial, app.id, { isSubject: true, postalCode: null }),
      }),
    ).rejects.toThrow(/du_owned_properties_subject_override_is_whole/);

    const countryOnly = await anReoAsset(app);
    await expect(
      prisma.duOwnedProperty.create({
        data: reoFor(countryOnly, app.id, {
          isSubject: true,
          addressLineText: null,
          cityName: null,
          stateCode: null,
          postalCode: null,
          countryCode: "US",
        }),
      }),
    ).rejects.toThrow(/du_owned_properties_subject_override_is_whole/);

    const whole = await anReoAsset(app);
    const written = await prisma.duOwnedProperty.create({
      data: reoFor(whole, app.id, { isSubject: true, addressLineText: "1234 Main St" }),
      select: { addressLineText: true },
    });
    expect(written.addressLineText).toBe("1234 Main St");
  });

  it("refuses a street line too long for this destination", async () => {
    // 35 here against 50 under the subject property. "1234 Northwest Cherry
    // Blossom Parkway Ext" is 41 characters: legal at the collateral, invalid
    // inside the REO, which is why the two renderings are not required to
    // match.
    const app = await anApplication();
    const assetId = await anReoAsset(app);
    await expect(
      prisma.duOwnedProperty.create({
        data: reoFor(assetId, app.id, {
          addressLineText: "1234 Northwest Cherry Blossom Parkway Ext",
        }),
      }),
    ).rejects.toThrow(/du_owned_properties_address_fits_the_wire/);
  });

  it("refuses a postal code with a dash", async () => {
    const app = await anApplication();
    const assetId = await anReoAsset(app);
    await expect(
      prisma.duOwnedProperty.create({
        data: reoFor(assetId, app.id, { postalCode: "21857-1234" }),
      }),
    ).rejects.toThrow(/du_owned_properties_postal_code_has_no_dash/);
    const written = await prisma.duOwnedProperty.create({
      data: reoFor(assetId, app.id, { postalCode: "218571234" }),
      select: { postalCode: true },
    });
    expect(written.postalCode).toBe("218571234");
  });

  it("takes a retained farm, and refuses `Other` with nothing said about it", async () => {
    // Without the description the only writable usages are the three occupancy
    // words, and a farm has to be filed as an investment property — which is a
    // different fact about a different thing.
    const app = await anApplication();
    const farmAsset = await anReoAsset(app);
    const farm = await prisma.duOwnedProperty.create({
      data: reoFor(farmAsset, app.id, {
        intendedUsage: "Other",
        intendedUsageOtherDescription: "Farm",
      }),
      select: { intendedUsageOtherDescription: true },
    });
    expect(farm.intendedUsageOtherDescription).toBe("Farm");

    const bare = await anReoAsset(app);
    await expect(
      prisma.duOwnedProperty.create({
        data: reoFor(bare, app.id, { intendedUsage: "Other" }),
      }),
    ).rejects.toThrow(/du_owned_properties_other_description_needs_other/);

    const described = await anReoAsset(app);
    await expect(
      prisma.duOwnedProperty.create({
        data: reoFor(described, app.id, { intendedUsageOtherDescription: "Farm" }),
      }),
    ).rejects.toThrow(/du_owned_properties_other_description_needs_other/);

    // And the case the plain equality misses: no usage at all. `intended_usage`
    // is null on every property not being retained, so `(NULL = 'Other') =
    // TRUE` is NULL and the CHECK would pass — emitting a
    // `PropertyUsageTypeOtherDescription` with no `PropertyUsageType` beside it.
    const usageless = await anReoAsset(app);
    await expect(
      prisma.duOwnedProperty.create({
        data: reoFor(usageless, app.id, {
          intendedUsage: null,
          intendedUsageOtherDescription: "Farm",
        }),
      }),
    ).rejects.toThrow(/du_owned_properties_other_description_needs_other/);
  });

  it("refuses an intended usage on a property that is not being retained", async () => {
    const app = await anApplication();
    const assetId = await anReoAsset(app);
    await expect(
      prisma.duOwnedProperty.create({
        data: reoFor(assetId, app.id, {
          dispositionStatus: "Sold",
          intendedUsage: "Investment",
        }),
      }),
    ).rejects.toThrow(/du_owned_properties_intended_usage_needs_retain/);
  });

  it("refuses a net rental figure on a sold property", async () => {
    const app = await anApplication();
    const assetId = await anReoAsset(app);
    await expect(
      prisma.duOwnedProperty.create({
        data: reoFor(assetId, app.id, {
          dispositionStatus: "Sold",
          intendedUsage: null,
          rentalIncomeNetCents: 120_000n,
        }),
      }),
    ).rejects.toThrow(/du_owned_properties_rental_net_needs_retain/);
  });

  it("takes a rental that loses money", async () => {
    // DI-C08's ASSET_7 emits -678.00. Amount 9.2 bounds the magnitude and not
    // the sign, and a net figure is income minus expenses.
    const app = await anApplication();
    const assetId = await anReoAsset(app);
    const written = await prisma.duOwnedProperty.create({
      data: reoFor(assetId, app.id, {
        currentUsage: "Investment",
        intendedUsage: "Investment",
        rentalIncomeGrossCents: 0n,
        rentalIncomeNetCents: -67_800n,
      }),
      select: { rentalIncomeNetCents: true },
    });
    expect(written.rentalIncomeNetCents).toBe(-67_800n);
  });

  it("refuses amounts wider than the wire takes, signed or not", async () => {
    const app = await anApplication();
    const tooBig = await anReoAsset(app);
    await expect(
      prisma.duOwnedProperty.create({
        data: reoFor(tooBig, app.id, { estimatedValueCents: TOO_MUCH_MONEY }),
      }),
    ).rejects.toThrow(/du_owned_properties_amounts_fit_amount_9_2/);

    const tooNegative = await anReoAsset(app);
    await expect(
      prisma.duOwnedProperty.create({
        data: reoFor(tooNegative, app.id, { rentalIncomeNetCents: -TOO_MUCH_MONEY }),
      }),
    ).rejects.toThrow(/du_owned_properties_rental_net_fits_signed_amount_9_2/);
  });
});

describe("a liability, and the property it secures", () => {
  it("refuses an installment loan secured by a property", async () => {
    // Only the REO mortgage variant participates in the arc, and only it
    // carries the HELOC maximum and the taxes-and-insurance indicator.
    const app = await anApplication();
    const assetId = await anReoAsset(app);
    const reo = await prisma.duOwnedProperty.create({
      data: reoFor(assetId, app.id),
      select: { id: true },
    });
    await expect(
      prisma.duLiability.create({
        data: liabilityFor(app.id, {
          liabilityType: "Installment",
          securedByOwnedPropertyId: reo.id,
        }),
      }),
    ).rejects.toThrow(/du_liabilities_only_a_mortgage_is_secured/);
  });

  it("takes two liens on one property", async () => {
    // A first mortgage and a HELOC on one property is the shape the foreign key
    // on this side exists to express: DI-C04 and the three VA files all emit
    // it, and no liability in the corpus is the target of more than one asset.
    const app = await anApplication();
    const assetId = await anReoAsset(app);
    const reo = await prisma.duOwnedProperty.create({
      data: reoFor(assetId, app.id),
      select: { id: true },
    });
    await aLiability(app, liabilityFor(app.id, { securedByOwnedPropertyId: reo.id }));
    await aLiability(
      app,
      liabilityFor(app.id, {
        liabilityType: "HELOC",
        holderName: "Shoreline CU",
        unpaidBalanceCents: 3_500_000n,
        monthlyPaymentCents: 28_000n,
        helocMaximumBalanceCents: 5_000_000n,
        securedByOwnedPropertyId: reo.id,
      }),
    );
    expect(await prisma.duLiability.count({ where: { securedByOwnedPropertyId: reo.id } })).toBe(2);
  });

  it("refuses a lien against a property on somebody else's application", async () => {
    // An arc across two applications emits an `xlink:from` naming a label the
    // document does not contain, and the XSD accepts that silently.
    const mine = await anApplication();
    const theirs = await anApplication();
    const assetId = await anReoAsset(theirs);
    const reo = await prisma.duOwnedProperty.create({
      data: reoFor(assetId, theirs.id),
      select: { id: true },
    });
    await expect(
      prisma.duLiability.create({
        data: liabilityFor(mine.id, { securedByOwnedPropertyId: reo.id }),
      }),
    ).rejects.toThrow(/an arc across two applications points at a label/);
  });

  it("binds the HELOC maximum, the mortgage type and the taxes indicator", async () => {
    const app = await anApplication();
    await expect(
      prisma.duLiability.create({
        data: liabilityFor(app.id, {
          liabilityType: "Revolving",
          helocMaximumBalanceCents: 5_000_000n,
        }),
      }),
    ).rejects.toThrow(/du_liabilities_heloc_maximum_needs_a_heloc/);
    await expect(
      prisma.duLiability.create({
        data: liabilityFor(app.id, { liabilityType: "Taxes", mortgageType: "FHA" }),
      }),
    ).rejects.toThrow(/du_liabilities_mortgage_type_needs_a_mortgage/);
    await expect(
      prisma.duLiability.create({
        data: liabilityFor(app.id, {
          liabilityType: "LeasePayment",
          paymentIncludesTaxesInsurance: false,
        }),
      }),
    ).rejects.toThrow(/du_liabilities_taxes_indicator_needs_a_mortgage/);
  });

  it("binds the liability description to `Other`, in both directions", async () => {
    const app = await anApplication();
    await expect(
      prisma.duLiability.create({
        data: liabilityFor(app.id, { liabilityType: "Other" }),
      }),
    ).rejects.toThrow(/du_liabilities_other_description_needs_other/);
    await expect(
      prisma.duLiability.create({
        data: liabilityFor(app.id, {
          liabilityType: "Revolving",
          liabilityTypeOtherDescription: "Store card",
        }),
      }),
    ).rejects.toThrow(/du_liabilities_other_description_needs_other/);
  });

  it("refuses a hundred-year remaining term", async () => {
    // LiabilityRemainingTermMonthsCount is Numeric 3. 1200 months writes
    // cleanly and is rejected by DU, which is the most expensive moment to
    // find out.
    const app = await anApplication();
    await expect(
      prisma.duLiability.create({
        data: liabilityFor(app.id, { remainingTermMonths: 1200 }),
      }),
    ).rejects.toThrow(/du_liabilities_remaining_term_fits_numeric_3/);
    const written = await aLiability(app, liabilityFor(app.id, { remainingTermMonths: 999 }));
    expect(written.remainingTermMonths).toBe(999);
  });

  it("refuses a balance wider than the wire takes, and a holder name too long", async () => {
    const app = await anApplication();
    await expect(
      prisma.duLiability.create({
        data: liabilityFor(app.id, { unpaidBalanceCents: TOO_MUCH_MONEY }),
      }),
    ).rejects.toThrow(/du_liabilities_amounts_fit_amount_9_2/);
    await expect(
      prisma.duLiability.create({
        data: liabilityFor(app.id, { holderName: "C".repeat(151) }),
      }),
    ).rejects.toThrow(/du_liabilities_strings_fit_the_wire/);
  });
});

describe("the lien total is derived, not asserted", () => {
  /** An REO with no liens against it yet, and the application it is on. */
  async function anReoProperty(): Promise<{ app: Application; reoId: string }> {
    const app = await anApplication();
    const assetId = await anReoAsset(app);
    const reo = await prisma.duOwnedProperty.create({
      data: reoFor(assetId, app.id),
      select: { id: true },
    });
    return { app, reoId: reo.id };
  }

  const lienTotal = async (reoId: string): Promise<bigint | null> =>
    (
      await prisma.duOwnedProperty.findUniqueOrThrow({
        where: { id: reoId },
        select: { lienUpbCents: true },
      })
    ).lienUpbCents;

  it("is null on a property owned free and clear", async () => {
    const { reoId } = await anReoProperty();
    expect(await lienTotal(reoId)).toBeNull();
  });

  it("totals both liens rather than reporting either alone", async () => {
    // The two-lien REO: 210,027.00 plus 35,000.00 is 245,027.00. Reporting the
    // first mortgage alone understates the lien balance on the subject property
    // of a cash-out refinance by $35,000, and it validates against the whole
    // schema chain — the element is a plain amount.
    const { app, reoId } = await anReoProperty();
    await aLiability(app, liabilityFor(app.id, { securedByOwnedPropertyId: reoId }));
    expect(await lienTotal(reoId)).toBe(21_002_700n);

    await aLiability(
      app,
      liabilityFor(app.id, {
        liabilityType: "HELOC",
        holderName: "Shoreline CU",
        unpaidBalanceCents: 3_500_000n,
        monthlyPaymentCents: 28_000n,
        helocMaximumBalanceCents: 5_000_000n,
        securedByOwnedPropertyId: reoId,
      }),
    );
    // Nobody recomputed anything: a second lien from a credit re-pull moves the
    // figure on its own, which is the whole reason it is derived.
    expect(await lienTotal(reoId)).toBe(24_502_700n);
  });

  it("re-totals when a lien is retired, deleted or repointed", async () => {
    const { app, reoId } = await anReoProperty();
    const first = await aLiability(app, liabilityFor(app.id, { securedByOwnedPropertyId: reoId }));
    const second = await aLiability(
      app,
      liabilityFor(app.id, {
        liabilityType: "HELOC",
        holderName: "Shoreline CU",
        unpaidBalanceCents: 3_500_000n,
        monthlyPaymentCents: 28_000n,
        securedByOwnedPropertyId: reoId,
      }),
    );
    expect(await lienTotal(reoId)).toBe(24_502_700n);

    // A superseded row is not emitted, so it is not in the total either.
    await prisma.duLiability.update({
      where: { id: second.id },
      data: { retiredAt: new Date() },
    });
    expect(await lienTotal(reoId)).toBe(21_002_700n);

    await prisma.duLiability.delete({ where: { id: second.id } });
    expect(await lienTotal(reoId)).toBe(21_002_700n);

    // And the property a lien LEAVES is re-totaled as well as the one it joins.
    const other = await anReoAsset(app);
    const elsewhere = await prisma.duOwnedProperty.create({
      data: reoFor(other, app.id, { addressLineText: "9 Willow Lane" }),
      select: { id: true },
    });
    await prisma.duLiability.update({
      where: { id: first.id },
      data: { securedByOwnedPropertyId: elsewhere.id },
    });
    expect(await lienTotal(reoId)).toBeNull();
    expect(await lienTotal(elsewhere.id)).toBe(21_002_700n);
  });

  it("overwrites a hand-written total rather than refusing it", async () => {
    // The failure this guards is quiet: an asserted total is a check the writer
    // can fail, and a wrong one that is merely refused still leaves a caller
    // who believes it is theirs to write. `UPDATE ... SET lien_upb_cents = 1`
    // reports one row updated either way; what is stored is the sum.
    const { app, reoId } = await anReoProperty();
    await aLiability(app, liabilityFor(app.id, { securedByOwnedPropertyId: reoId }));

    await prisma.duOwnedProperty.update({
      where: { id: reoId },
      data: { lienUpbCents: 1n },
    });
    expect(await lienTotal(reoId)).toBe(21_002_700n);

    const updated = await prisma.$executeRaw`
      UPDATE "du_owned_properties" SET lien_upb_cents = 1 WHERE id = ${reoId}::uuid
    `;
    expect(updated).toBe(1);
    expect(await lienTotal(reoId)).toBe(21_002_700n);
  });

  it("ignores a total handed to it at insert", async () => {
    const app = await anApplication();
    const assetId = await anReoAsset(app);
    const written = await prisma.duOwnedProperty.create({
      data: reoFor(assetId, app.id, { lienUpbCents: 99_999n }),
      select: { lienUpbCents: true },
    });
    expect(written.lienUpbCents).toBeNull();
  });
});

describe("an expense", () => {
  it("writes, and refuses a hundred-year term", async () => {
    const app = await anApplication();
    const written = await anExpense(
      app,
      expenseFor(app.id, { remainingTermMonths: 84, alimonyOwedToName: "R. Vance" }),
    );
    expect(written.monthlyPaymentCents).toBe(90_000n);
    await expect(
      prisma.duExpense.create({ data: expenseFor(app.id, { remainingTermMonths: 1200 }) }),
    ).rejects.toThrow(/du_expenses_remaining_term_fits_numeric_3/);
  });

  it("binds its description to `Other` in both directions, and refuses money too wide", async () => {
    const app = await anApplication();
    await expect(
      prisma.duExpense.create({
        data: expenseFor(app.id, { expenseOtherDescription: "Union dues" }),
      }),
    ).rejects.toThrow(/du_expenses_other_description_needs_other/);
    // 2d.1 is conditional `IF ExpenseType = "Other"`, which is a requirement as
    // much as a permission: an expense filed as `Other` and left unexplained
    // reaches DU as a monthly payment with nothing behind it.
    await expect(
      prisma.duExpense.create({ data: expenseFor(app.id, { expenseType: "Other" }) }),
    ).rejects.toThrow(/du_expenses_other_description_needs_other/);
    const described = await anExpense(
      app,
      expenseFor(app.id, { expenseType: "Other", expenseOtherDescription: "Union dues" }),
    );
    expect(described.expenseOtherDescription).toBe("Union dues");
    await expect(
      prisma.duExpense.create({
        data: expenseFor(app.id, { monthlyPaymentCents: TOO_MUCH_MONEY }),
      }),
    ).rejects.toThrow(/du_expenses_amount_fits_amount_9_2/);
    await expect(
      prisma.duExpense.create({
        data: expenseFor(app.id, { alimonyOwedToName: "R".repeat(151) }),
      }),
    ).rejects.toThrow(/du_expenses_alimony_name_is_bounded/);
  });
});

describe("the identity index spans retired rows", () => {
  it("still conflicts with a row that has been retired", async () => {
    // An asset that goes away and comes back is one asset, so a later pull
    // revives the row rather than inserting a twin — and a twin renumbers every
    // ASSET_n after it on the wire. Add `WHERE retired_at IS NULL` to the index
    // and both statements below insert.
    const app = await anApplication();
    const key = `p:${randomUUID()}:acct:firstfederal:checking:4455:`;
    const first = await anAsset(app, assetFor(app.id, { identityKey: key }));
    await prisma.duAsset.update({
      where: { id: first.id },
      data: { retiredAt: new Date() },
    });

    const skipped = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "du_assets" (id, application_id, kind, asset_type, cash_or_market_value_cents,
                               holder_name, identity_key, updated_at)
      VALUES (gen_random_uuid(), ${app.id}::uuid, 'DEPOSIT_ACCOUNT', 'CheckingAccount',
              1250000, 'First Federal', ${key}, now())
      ON CONFLICT (application_id, identity_key) DO NOTHING
      RETURNING id
    `;
    expect(skipped).toEqual([]);

    const revived = await prisma.$queryRaw<{ id: string; retired_at: Date | null }[]>`
      INSERT INTO "du_assets" (id, application_id, kind, asset_type, cash_or_market_value_cents,
                               holder_name, identity_key, updated_at)
      VALUES (gen_random_uuid(), ${app.id}::uuid, 'DEPOSIT_ACCOUNT', 'CheckingAccount',
              1300000, 'First Federal', ${key}, now())
      ON CONFLICT (application_id, identity_key)
        DO UPDATE SET cash_or_market_value_cents = EXCLUDED.cash_or_market_value_cents,
                      retired_at = NULL, updated_at = now()
      RETURNING id, retired_at
    `;
    // The same row, revived and re-valued, rather than a second one beside it.
    expect(revived[0]?.id).toBe(first.id);
    expect(revived[0]?.retired_at).toBeNull();
    expect(await prisma.duAsset.count({ where: { applicationId: app.id } })).toBe(1);
  });

  it("is scoped to the application, and admits two keys on one", async () => {
    const one = await anApplication();
    const two = await anApplication();
    const key = `p:${randomUUID()}:acct:firstfederal:checking:4455:`;
    await anAsset(one, assetFor(one.id, { identityKey: key }));
    await anAsset(two, assetFor(two.id, { identityKey: key }));
    await anAsset(one, assetFor(one.id, { identityKey: `${key}x` }));
    await expect(anAsset(one, assetFor(one.id, { identityKey: key }))).rejects.toThrow(
      /du_assets_application_identity_key|Unique constraint/,
    );
    expect(await prisma.duAsset.count()).toBe(3);
  });

  it("holds the same way for a liability", async () => {
    const app = await anApplication();
    const key = `p:${randomUUID()}:liab:callablemortgage:MortgageLoan:0027:`;
    const first = await aLiability(app, liabilityFor(app.id, { identityKey: key }));
    await prisma.duLiability.update({
      where: { id: first.id },
      data: { retiredAt: new Date() },
    });
    await expect(aLiability(app, liabilityFor(app.id, { identityKey: key }))).rejects.toThrow(
      /du_liabilities_application_identity_key|Unique constraint/,
    );
  });
});
