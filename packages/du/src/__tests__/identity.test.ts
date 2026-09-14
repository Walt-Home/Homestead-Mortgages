/**
 * The key itself, with no database in the way.
 *
 * Everything a re-pull does rests on this string, so the properties worth
 * asserting are the ones that are invisible in a passing ingest: that the
 * subject party opens every connector-written key, that nothing about where a
 * row sat in the vendor's list reaches it, and that two rows a vendor cannot
 * tell apart are refused a match rather than given one by arrival order.
 *
 * Two more are here because they are invisible in a passing TEST. A key is also
 * a lookup, so a pull carries the key it would have written before the vendor
 * numbered its accounts — and a component computed from a clock answers
 * differently on two machines, which is a split no row records.
 */

import { describe, expect, it } from "vitest";
import {
  assetIdentityKeys,
  liabilityIdentityKeys,
  resolveIdentities,
  type AssetIdentityFacts,
  type LiabilityIdentityFacts,
  type VendorItem,
} from "../identity.js";

const PRIYA = "11111111-1111-4111-8111-111111111111";
const DEV = "22222222-2222-4222-8222-222222222222";

const bank = { partyId: PRIYA, provider: "plaid" };

/**
 * The key a pull writes, for the assertions that are only about the string.
 * What the pull would ALSO look the row up by is its own describe below.
 */
const keyOf = (vendor: VendorItem, facts: AssetIdentityFacts): string =>
  assetIdentityKeys(vendor, facts).key;

const liabilityKeyOf = (vendor: VendorItem, facts: LiabilityIdentityFacts): string =>
  liabilityIdentityKeys(vendor, facts).key;

const checking: AssetIdentityFacts = {
  kind: "DEPOSIT_ACCOUNT",
  holderName: "First Federal",
  accountSubtype: "checking",
  accountIdentifier: "****4455",
};

describe("the subject party opens a connector-written key", () => {
  it("is the whole difference between two borrowers' identical accounts", () => {
    // The index is (application_id, identity_key) and one application holds
    // both borrowers, so without this prefix these two are one key — and the
    // second pull would update the first borrower's row while its owner arcs
    // still pointed at the first borrower.
    const hers = keyOf(bank, checking);
    const his = keyOf({ ...bank, partyId: DEV }, checking);

    expect(hers).not.toBe(his);
    expect(hers.replace(PRIYA, "")).toBe(his.replace(DEV, ""));
    expect(hers.startsWith(`p:${PRIYA}:`)).toBe(true);
  });
});

describe("tier 1, where the adapter has a stable id", () => {
  it("is the id and nothing else, so a changed mask keeps the row", () => {
    const withMask = keyOf({ ...bank, itemId: "acc_9f2" }, checking);
    const maskChanged = keyOf(
      { ...bank, itemId: "acc_9f2" },
      { ...checking, accountIdentifier: "1199", accountSubtype: "savings" },
    );
    expect(withMask).toBe(maskChanged);
    expect(withMask).toBe(`p:${PRIYA}:vendor:plaid:acc_9f2`);
  });

  it("keeps the vendor's id verbatim and normalizes only the provider name", () => {
    // Two ids differing in punctuation are two accounts; lowercasing them would
    // merge a pair the vendor is telling us apart.
    const upper = keyOf({ ...bank, itemId: "ACC_9F2" }, checking);
    const lower = keyOf({ ...bank, itemId: "acc_9f2" }, checking);
    expect(upper).not.toBe(lower);
    expect(keyOf({ ...bank, provider: "Plaid", itemId: "x" }, checking)).toBe(
      keyOf({ ...bank, provider: "plaid", itemId: "x" }, checking),
    );
  });
});

describe("tier 2, the content key", () => {
  it("ignores the balance, which is the thing a re-pull is expected to change", () => {
    // Balance has no place in the facts at all, which is the strongest form of
    // this: a caller cannot put it there by accident.
    expect(keyOf(bank, checking)).toBe(`p:${PRIYA}:acct:firstfederal:checking:4455:`);
  });

  it("reads one bank spelled two ways as one bank, and one mask masked two ways as one account", () => {
    expect(keyOf(bank, { ...checking, holderName: "first federal!" })).toBe(keyOf(bank, checking));
    expect(keyOf(bank, { ...checking, accountIdentifier: "xxxx-4455" })).toBe(
      keyOf(bank, checking),
    );
  });

  it("tells two accounts at one bank apart by subtype, and by the day one opened", () => {
    const savings = keyOf(bank, { ...checking, accountSubtype: "savings" });
    expect(savings).not.toBe(keyOf(bank, checking));

    const opened = keyOf(bank, { ...checking, openedOn: "2019-06-01" });
    expect(opened).toBe(`p:${PRIYA}:acct:firstfederal:checking:4455:20190601`);
    expect(keyOf(bank, { ...checking, openedOn: new Date("2019-06-01T00:00:00Z") })).toBe(opened);
  });

  it("gives a gift a key its sibling gift cannot take", () => {
    // Two sets of parents, two gifts, and an earlier rule keyed on type and
    // source alone made the second one unwritable.
    const fromHers = keyOf(bank, {
      kind: "GIFT_OR_GRANT",
      assetType: "GiftOfCash",
      fundsSourceType: "Parent",
      fundsSourceTypeOtherDescription: "Priya's parents",
    });
    const fromHis = keyOf(bank, {
      kind: "GIFT_OR_GRANT",
      assetType: "GiftOfCash",
      fundsSourceType: "Parent",
      fundsSourceTypeOtherDescription: "Dev's parents",
    });
    expect(fromHers).not.toBe(fromHis);
  });

  it("keys an other asset on its description and an owned property on its address", () => {
    expect(
      keyOf(bank, {
        kind: "OTHER_ASSET",
        assetType: "Other",
        assetTypeOtherDescription: "OtherNonLiquidAsset",
      }),
    ).toBe(`p:${PRIYA}:other:Other:othernonliquidasset`);

    expect(
      keyOf(bank, {
        kind: "OWNED_PROPERTY",
        address: {
          addressLineText: "88 Foster Lane",
          cityName: "Austin",
          stateCode: "TX",
          postalCode: "78745",
        },
      }),
    ).toBe(`p:${PRIYA}:reo:88fosterlane::austin:tx:78745`);
  });

  it("keys a tradeline the same way, on the account rather than the balance", () => {
    const card = {
      holderName: "Shoreline CU",
      liabilityType: "Revolving",
      accountIdentifier: "0027",
    } as const;
    expect(liabilityKeyOf(bank, card)).toBe(`p:${PRIYA}:liab:shorelinecu:Revolving:0027:`);
    // The same account reported as a different kind of debt is a different
    // tradeline, not the same one revalued.
    expect(liabilityKeyOf(bank, { ...card, liabilityType: "Installment" })).not.toBe(
      liabilityKeyOf(bank, card),
    );
  });
});

describe("there is no ordinal, at any tier", () => {
  it("gives the same account the same key wherever the vendor puts it in the list", () => {
    // The property an ordinal breaks. With a `#<n>` on the key, dropping the
    // first of three accounts moves every survivor's key onto the row above it.
    const pull = [
      { ...checking, accountSubtype: "checking" },
      { ...checking, accountSubtype: "savings" },
      { ...checking, accountSubtype: "money market" },
    ];
    const first = pull.map((facts) => keyOf(bank, facts));
    const reordered = [pull[2]!, pull[0]!, pull[1]!].map((facts) => keyOf(bank, facts));

    expect([...first].sort()).toEqual([...reordered].sort());
    expect(keyOf(bank, pull[1]!)).toBe(reordered[2]);
  });

  it("does not consult the rest of the pull, so a sibling disappearing changes nothing", () => {
    const alone = keyOf(bank, checking);
    const amongOthers = [checking, { ...checking, accountSubtype: "savings" }].map((facts) =>
      keyOf(bank, facts),
    );
    expect(amongOthers[0]).toBe(alone);
  });
});

describe("tier 3 refuses to match", () => {
  const twin = () => assetIdentityKeys(bank, checking);
  const savings = () => assetIdentityKeys(bank, { ...checking, accountSubtype: "savings" });

  it("writes both ambiguous rows unmatched and names the group", () => {
    const key = keyOf(bank, checking);
    const plan = resolveIdentities([twin(), savings(), twin()]);

    expect(plan.rows[1]).toEqual({
      identityKey: savings().key,
      priorKeys: [],
      id: null,
      ambiguousWith: null,
    });
    for (const row of [plan.rows[0]!, plan.rows[2]!]) {
      expect(row.ambiguousWith).toBe(key);
      expect(row.identityKey).toBe(`unmatched:${row.id}`);
    }
    expect(plan.ambiguous).toEqual([
      { identityKey: key, rowIds: [plan.rows[0]!.id, plan.rows[2]!.id] },
    ]);
  });

  it("gives the next pull's ambiguous rows uuids of their own", () => {
    // Which is what makes the cost bearable: the old rows stay live beside the
    // new ones until somebody says which is which, and nothing collides while
    // they wait.
    const first = resolveIdentities([twin(), twin()]);
    const second = resolveIdentities([twin(), twin()]);
    const keys = [...first.rows, ...second.rows].map((row) => row.identityKey);
    expect(new Set(keys).size).toBe(4);
  });

  it("says nothing is ambiguous when every key identifies its row", () => {
    const plan = resolveIdentities([twin(), savings()]);
    expect(plan.ambiguous).toEqual([]);
    expect(plan.sharedPriorKeys).toEqual([]);
    expect(plan.rows.every((row) => row.id === null && row.ambiguousWith === null)).toBe(true);
  });
});

describe("the key the row may already be stored under", () => {
  it("is the content key, for a pull the vendor has started numbering", () => {
    // A provider that supplies ids on its second pull computes a key no
    // existing row carries. Without the fallback the row it means stays live
    // and a twin is written beside it, so the balance is counted twice.
    const numbered = assetIdentityKeys({ ...bank, itemId: "acc_9f2" }, checking);
    expect(numbered.key).toBe(`p:${PRIYA}:vendor:plaid:acc_9f2`);
    expect(numbered.priorKeys).toEqual([keyOf(bank, checking)]);
  });

  it("is nothing at all where the content key is what gets written", () => {
    // There is no second thing to try: a row that was never numbered was
    // written under exactly this string.
    expect(assetIdentityKeys(bank, checking).priorKeys).toEqual([]);
    expect(
      liabilityIdentityKeys(
        { ...bank, itemId: "tl_1" },
        {
          holderName: "Shoreline CU",
          liabilityType: "Revolving",
          accountIdentifier: "0027",
        },
      ).priorKeys,
    ).toEqual([`p:${PRIYA}:liab:shorelinecu:Revolving:0027:`]);
  });

  it("is dropped when two of one pull's rows would both fall back to it", () => {
    // Two content-identical accounts the bank has just begun numbering. Each
    // identifies itself, so neither is unmatched — but following the fallback
    // would land both on the one row already filed under it, the second
    // overwriting the first, which loses a balance rather than duplicating one.
    const one = assetIdentityKeys({ ...bank, itemId: "acc_1" }, checking);
    const two = assetIdentityKeys({ ...bank, itemId: "acc_2" }, checking);
    const plan = resolveIdentities([one, two]);

    expect(plan.rows.map((row) => row.identityKey)).toEqual([one.key, two.key]);
    expect(plan.rows.map((row) => row.priorKeys)).toEqual([[], []]);
    expect(plan.ambiguous).toEqual([]);
    expect(plan.sharedPriorKeys).toEqual([keyOf(bank, checking)]);
  });

  it("is dropped when another row in the pull is being written under it", () => {
    // The numbered account would otherwise take the row the unnumbered one is
    // writing, inside one transaction.
    const numbered = assetIdentityKeys({ ...bank, itemId: "acc_1" }, checking);
    const plan = resolveIdentities([numbered, assetIdentityKeys(bank, checking)]);

    expect(plan.rows[0]!.priorKeys).toEqual([]);
    expect(plan.rows[1]!.identityKey).toBe(keyOf(bank, checking));
    expect(plan.sharedPriorKeys).toEqual([keyOf(bank, checking)]);
  });
});

describe("an opening date is a day, and the same day everywhere", () => {
  it("reads a Date as its UTC day rather than the machine's", () => {
    // The component is on no column of the row, so a key that moves with the
    // server's clock splits an account into two rows and leaves nothing to
    // trace the split back to.
    // Two instants half an hour either side of a UTC midnight, so a rule
    // reading the machine's own calendar fields answers wrongly on every
    // timezone that is not Greenwich itself, whichever side of it it sits.
    const lateOnTheFirst = new Date("2019-06-01T23:30:00Z");
    expect(keyOf(bank, { ...checking, openedOn: lateOnTheFirst })).toBe(
      `p:${PRIYA}:acct:firstfederal:checking:4455:20190601`,
    );
    const earlyOnTheSecond = new Date("2019-06-02T00:30:00Z");
    expect(keyOf(bank, { ...checking, openedOn: earlyOnTheSecond })).toBe(
      `p:${PRIYA}:acct:firstfederal:checking:4455:20190602`,
    );
    expect(keyOf(bank, { ...checking, openedOn: new Date(Date.UTC(2019, 5, 1)) })).toBe(
      keyOf(bank, { ...checking, openedOn: "2019-06-01" }),
    );
  });

  it("refuses a date written any other way, rather than keying its punctuation", () => {
    // `06/01/2019` used to key as `06012019` and `2019-06-01` as `20190601`:
    // one day, two keys, two rows, and no way to tell from either row.
    expect(() => keyOf(bank, { ...checking, openedOn: "06/01/2019" })).toThrow(/cannot be keyed/);
    expect(() => keyOf(bank, { ...checking, openedOn: "2019-06-01T00:00:00Z" })).toThrow(
      /cannot be keyed/,
    );
  });
});
