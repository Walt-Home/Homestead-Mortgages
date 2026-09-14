/**
 * How two pulls decide they are talking about the same account, the same
 * tradeline, the same gift.
 *
 * Nothing here touches the database, because the interesting part is not the
 * lookup — it is the guess, the same way `services/employer-identity.ts` states
 * its guesses rather than leaving them to be found in production. What is
 * different here is how much weight the guess carries.
 *
 * `income_sources` is keyed on `(loan file, party, identity key)`, so the party
 * is IN the index and a bare `type:` prefix discriminates. Ownership of an asset
 * is a JOIN — one account, two owners, which is the shape the arcs exist for —
 * so `du_assets` has no party column and its unique key is
 * `(application_id, identity_key)`. The whole discriminating burden falls on the
 * string, and every rule below is what that costs.
 *
 * **The subject party opens every connector-written key.** The index spans the
 * application while the key is computed from one vendor's payload about ONE
 * person, and two borrowers are two pulls. Two people holding an unmasked
 * checking account of the same subtype at the same bank would otherwise compute
 * one key across two snapshots: the second pull would update the first
 * borrower's row while its owner arcs still pointed at the first borrower, so a
 * balance would be filed under the wrong person with nothing on the wire
 * looking different. The prefix is `connector_snapshots.party_id` — the durable
 * party, not the `application_parties` row, because prefixing with the edge
 * gives one person two keys for one account across two applications and turns
 * every re-pull on the second file into a fresh row.
 *
 * The consequence is stated rather than discovered: a genuinely joint account
 * reported on both borrowers' pulls becomes TWO rows. That is honest — two
 * vendor reports about one account are two pieces of evidence — but it is not
 * what a submission should carry, and collapsing the pair has a whole balance
 * riding on it. So it is a person's call on the way out, never a coincidence of
 * keys on the way in.
 *
 * **There is no ordinal in the key, at any tier, and that is the rule with the
 * most history behind it.** A `#<n>` meaning "the n-th row sharing this prefix
 * in the pull being ingested" is the vendor's row order wearing another name,
 * and under a unique index that spans retired rows the damage is not a
 * duplicate — it is a mix-up. Two unmasked accounts at one bank, the first
 * closed between pulls: the survivor takes `#1`, matches the closed account's
 * row, overwrites its balance and its type, and keeps that row's owner arcs. A
 * joint account becomes individual and an individual one becomes joint, every
 * label on the wire is unchanged, and a byte-comparison of two submissions
 * reports that nothing moved. `incomeIdentityKey` does carry an ordinal and its
 * own header records it as an accepted cost — there it is a tiebreak on a key
 * already anchored to a matched employer row, and the damage is one row's
 * continuance judgment. Here it would be the whole key whenever the vendor
 * masks nothing, which is the ordinary case rather than the exotic one.
 *
 * **What the content key still cannot tell apart, said out loud.** Dropping the
 * ordinal cures the reordering: a sibling disappearing no longer moves anything
 * onto anything. It does not cure the replacement. Where the vendor masks the
 * number and reports no opening date, a closed account and the account that
 * opened at the same bank in the same subtype after it compute ONE key, so the
 * second pull matches the closed account's row, takes its balance and its type,
 * and keeps its owner arcs — a joint account becoming individual, exactly as the
 * ordinal would have done it. Refusing to match cannot reach this one: that
 * rule compares the rows inside a single pull, and these two accounts are never
 * reported together. Nothing in this file catches it and nothing downstream does
 * yet; a retired row whose replacement arrives under its key is material for a
 * reconciliation item, and no code raises one. The keys the vendor DOES number
 * are the way out of it, which is why tier 1 exists.
 *
 * So: tier 1 is the vendor's own stable id where the adapter exposes one, tier
 * 2 is a content key built only from properties of the row itself — so that
 * deleting any other row cannot change it — and tier 3 is refusing to match.
 * `resolveIdentities` is tier 3: when two rows in one pull compute the same
 * tier-2 key, that key identifies neither of them, so both are written
 * `unmatched:<this row's uuid>` and the ambiguous group is handed back for the
 * preflight to block on. An ambiguous pair is a fact about the report rather
 * than an error in it, so the report is kept and the submission is stopped.
 *
 * A row a PERSON wrote takes `manual:<uuid>`, and one written before any of
 * this existed takes `legacy:<uuid>`. Neither carries a party prefix and
 * neither is produced here: no re-pull can report a borrower's own typed
 * answer, so a key that matches nothing is the honest one, and it is what makes
 * two gifts from two sets of parents two rows by construction.
 */

import { randomUUID } from "node:crypto";
import type {
  DuAssetType,
  DuAssetTypeOtherDescription,
  DuFundsSourceType,
  DuLiabilityType,
} from "@hm/db";

/** The prefix on a key that is deliberately unmatchable. */
export const UNMATCHED_PREFIX = "unmatched:";

/**
 * Who reported this item, and what the reporter calls it.
 *
 * `partyId` is `connector_snapshots.party_id`. `itemId` is the adapter's stable
 * per-item id where it has one — Plaid's `account_id` is stable for the life of
 * an Item and the adapter already holds it, so the blanket "no vendor gives us
 * a stable identifier" inherited from income is not true of every connector
 * here.
 */
export interface VendorItem {
  readonly partyId: string;
  readonly provider: string;
  readonly itemId?: string | null;
}

/** The parts of an address a key is built from. */
export interface AddressFacts {
  readonly addressLineText?: string | null;
  readonly addressUnit?: string | null;
  readonly cityName?: string | null;
  readonly stateCode?: string | null;
  readonly postalCode?: string | null;
}

/**
 * What a pull reports about one asset, in the shape its key is computed from.
 *
 * Discriminated by the same `kind` the row carries, because one container
 * serves four URLA sections and the fields that identify a row are different in
 * each. Two of these have no column on `du_assets` — the vendor's account
 * subtype and the opening date — which is why this is its own type rather than
 * the row.
 *
 * Balance is deliberately absent from all four: it is the thing a re-pull is
 * expected to change.
 */
export type AssetIdentityFacts =
  | {
      readonly kind: "DEPOSIT_ACCOUNT";
      /** The institution, as the vendor spells it. */
      readonly holderName?: string | null;
      /** The vendor's own subtype where it reports one, and nothing otherwise. */
      readonly accountSubtype?: string | null;
      /** Whatever the vendor discloses of the number; empty where it masks everything. */
      readonly accountIdentifier?: string | null;
      readonly openedOn?: Date | string | null;
    }
  | {
      readonly kind: "OTHER_ASSET";
      readonly assetType: DuAssetType;
      readonly assetTypeOtherDescription?: DuAssetTypeOtherDescription | null;
    }
  | {
      readonly kind: "GIFT_OR_GRANT";
      readonly assetType: DuAssetType;
      readonly fundsSourceType?: DuFundsSourceType | null;
      readonly fundsSourceTypeOtherDescription?: string | null;
    }
  | {
      readonly kind: "OWNED_PROPERTY";
      readonly address: AddressFacts;
    };

/** What a credit pull reports about one tradeline. */
export interface LiabilityIdentityFacts {
  readonly holderName?: string | null;
  readonly liabilityType: DuLiabilityType;
  readonly accountIdentifier?: string | null;
  readonly openedOn?: Date | string | null;
}

/**
 * Lowercased with every non-alphanumeric character removed, exactly as
 * `employerNameKey` does it, so one bank punctuated two ways is one bank.
 */
function normalized(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The last four characters the vendor disclosed, and the empty string where it
 * disclosed none.
 *
 * Taken after normalizing, so `****4455` and `xxxx-4455` and `4455` are one
 * account rather than three.
 */
function lastFour(accountIdentifier: string | null | undefined): string {
  return normalized(accountIdentifier).slice(-4);
}

/** The only shape an opening date may be written in, where it is written out. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The opening date the vendor reported, as the UTC calendar day.
 *
 * Which day it is has to be said, because this component is on no column of
 * `du_assets`: a key built from it cannot be recomputed from the row, so a rule
 * that answers differently on two machines splits an account into two live rows
 * and leaves nothing to trace the split back to. A `Date` is an instant rather
 * than a day, and the ordinary result of parsing a vendor's `2019-06-01` is
 * LOCAL midnight — the 31st of May in UTC east of Greenwich and the 1st of June
 * west of it. The UTC day is the one taken, from the UTC fields, on every
 * machine.
 *
 * A string is refused unless it is a calendar day, which is narrower than it
 * looks: anything at all was accepted before, so `06/01/2019` keyed as
 * `06012019` while `2019-06-01` keyed as `20190601` — one day under two keys,
 * and no column to catch it against. A pull that cannot be keyed is a pull
 * somebody has to look at, which is the better of the two failures.
 */
function openedOnKey(openedOn: Date | string | null | undefined): string {
  if (openedOn === null || openedOn === undefined) return "";
  if (openedOn instanceof Date) {
    const year = openedOn.getUTCFullYear().toString().padStart(4, "0");
    const month = (openedOn.getUTCMonth() + 1).toString().padStart(2, "0");
    return `${year}${month}${openedOn.getUTCDate().toString().padStart(2, "0")}`;
  }
  if (!ISO_DAY.test(openedOn)) {
    throw new Error(
      `An opening date of "${openedOn}" cannot be keyed: a date the key is built ` +
        "from has to be a YYYY-MM-DD day or a Date, because two spellings of one " +
        "day are two keys and the date is on no column to check them against.",
    );
  }
  return openedOn.replace(/-/g, "");
}

/**
 * The parts normalized one at a time and joined, rather than joined and then
 * normalized: a unit that reads as the tail of the street line is not the same
 * property as one where the line already carried it.
 */
function normalizedAddress(address: AddressFacts): string {
  return [
    address.addressLineText,
    address.addressUnit,
    address.cityName,
    address.stateCode,
    address.postalCode,
  ]
    .map(normalized)
    .join(":");
}

/**
 * Tier 1. The item id is taken verbatim — it is the vendor's string and
 * normalizing it would merge two ids that differ only in punctuation — while
 * the provider name is ours and is normalized.
 */
function vendorKey(vendor: VendorItem): string {
  return `vendor:${normalized(vendor.provider)}:${vendor.itemId}`;
}

/** Tier 2 for an asset: every component a property of this row and no other. */
function assetContentKey(facts: AssetIdentityFacts): string {
  switch (facts.kind) {
    case "DEPOSIT_ACCOUNT":
      return [
        "acct",
        normalized(facts.holderName),
        normalized(facts.accountSubtype),
        lastFour(facts.accountIdentifier),
        openedOnKey(facts.openedOn),
      ].join(":");
    case "OTHER_ASSET":
      return ["other", facts.assetType, normalized(facts.assetTypeOtherDescription)].join(":");
    case "GIFT_OR_GRANT":
      return [
        "gift",
        facts.assetType,
        facts.fundsSourceType ?? "",
        normalized(facts.fundsSourceTypeOtherDescription),
      ].join(":");
    case "OWNED_PROPERTY":
      return `reo:${normalizedAddress(facts.address)}`;
  }
}

/**
 * The key a pull writes, and the keys the row it means may already be stored
 * under.
 *
 * There is one of each at most, and the second exists for one movement: a
 * provider that starts supplying item ids between two pulls. Its first pull
 * wrote a content key, its second computes a vendor key, and a matcher that
 * knew only the second would leave the first row live and write a twin beside
 * it — one account, two rows, the balance counted twice, and nothing raised.
 * So the content key comes back too, and the matcher tries it second.
 *
 * The movement the other way cannot be covered and is not. A provider that
 * STOPS supplying an id leaves nothing to compute the vendor key from, so that
 * account's next pull writes a second live row beside the one it means. Nothing
 * detects it here: the only evidence is a row nobody reported this time, which
 * is also what an account that was simply closed looks like.
 */
export interface IdentityKeys {
  /** What this pull writes, and what it looks the row up by first. */
  readonly key: string;
  /** Tried in order after `key`, for a row written before the vendor numbered it. */
  readonly priorKeys: readonly string[];
}

function keysFor(vendor: VendorItem, content: string): IdentityKeys {
  const contentKey = `p:${vendor.partyId}:${content}`;
  if (!vendor.itemId) return { key: contentKey, priorKeys: [] };
  return { key: `p:${vendor.partyId}:${vendorKey(vendor)}`, priorKeys: [contentKey] };
}

/**
 * What a second bank pull recognizes an asset by.
 *
 * A vendor id wins where there is one and nothing else is consulted with it;
 * where there is none the content key is the whole answer. A row the writer
 * finds under a prior key MOVES onto the key this pull computed, in the update
 * that matched it, which is the one place a key is rewritten. Leaving it where
 * it was is worse than it sounds: the row would keep answering to a content key
 * that any later account at the same bank in the same subtype also computes,
 * and the next pull carrying both would find two accounts pointing at one row.
 */
export function assetIdentityKeys(vendor: VendorItem, facts: AssetIdentityFacts): IdentityKeys {
  return keysFor(vendor, assetContentKey(facts));
}

/** The same rule for a tradeline, whose content key is the account it is on. */
export function liabilityIdentityKeys(
  vendor: VendorItem,
  facts: LiabilityIdentityFacts,
): IdentityKeys {
  return keysFor(
    vendor,
    [
      "liab",
      normalized(facts.holderName),
      facts.liabilityType,
      lastFour(facts.accountIdentifier),
      openedOnKey(facts.openedOn),
    ].join(":"),
  );
}

/** One row's identity, decided once the whole pull has been looked at. */
export interface ResolvedIdentity {
  /** The key to write. */
  readonly identityKey: string;
  /**
   * The keys to look the row up by after `identityKey` finds nothing — the ones
   * this pull's own rows do not compete for.
   */
  readonly priorKeys: readonly string[];
  /**
   * The id to write the row under, when the key carries it, and null when the
   * database is free to pick one.
   */
  readonly id: string | null;
  /**
   * The tier-2 key two or more rows in this pull computed, when this row is one
   * of them. Null when the key identifies this row on its own.
   */
  readonly ambiguousWith: string | null;
}

/** An ambiguous group, for whoever has to say which row is which. */
export interface AmbiguousGroup {
  /** The tier-2 key the rows collided on. */
  readonly identityKey: string;
  /** The rows written under it, by the id each was given. */
  readonly rowIds: readonly string[];
}

export interface IdentityPlan {
  /** One entry per item handed in, answering in the order they were handed in. */
  readonly rows: readonly ResolvedIdentity[];
  /**
   * Empty when every key identified its row. Anything here is blocking: a pull
   * that produced an ambiguous pair would otherwise emit both rows as two
   * independent accounts, which double-counts a balance.
   */
  readonly ambiguous: readonly AmbiguousGroup[];
  /**
   * The prior keys two or more of this pull's rows would have fallen back to,
   * and which none of them may therefore use.
   *
   * Not blocking and not silent. Each of those rows still identifies itself, so
   * each is written and matched on its own key; what is lost is the row they
   * were all pointing at, which stays live under the shared key with nothing
   * reporting it any more. That is one account's balance sitting beside its
   * replacement, so it belongs on the same list the ambiguous groups go on.
   */
  readonly sharedPriorKeys: readonly string[];
}

/** Every string in `values` that appears more than once. */
function repeated(values: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) twice.add(value);
    seen.add(value);
  }
  return twice;
}

/**
 * Tier 3, over one pull's keys.
 *
 * Position never enters a key: the correspondence between what goes in and what
 * comes out is how a caller reads the answer back, and nothing about where a
 * row sat in the vendor's list survives into the string. A key two rows share
 * identifies neither, so both are written under a fresh uuid that is also the
 * row's own id — unmatchable by construction, including against the next pull's
 * unmatched rows, which get uuids of their own.
 *
 * The same sentence decides the prior keys, one tier down. A key that two of
 * this pull's rows would both fall back to identifies neither of them either,
 * and following it would let two accounts land on one row inside a single
 * transaction — the second overwriting the first, which loses a balance rather
 * than duplicating one. So it is dropped from both, and named.
 */
export function resolveIdentities(items: readonly IdentityKeys[]): IdentityPlan {
  const shared = repeated(items.map((item) => item.key));
  // A prior key is usable only when this pull's rows do not compete for it: its
  // own row claims it once, and nobody else claims it at all.
  const claimed = repeated(items.flatMap((item) => [...new Set([item.key, ...item.priorKeys])]));

  const groups = new Map<string, string[]>();
  const dropped = new Set<string>();
  const rows = items.map((item): ResolvedIdentity => {
    if (shared.has(item.key)) {
      const id = randomUUID();
      const group = groups.get(item.key);
      if (group) group.push(id);
      else groups.set(item.key, [id]);
      // An unmatched row matches nothing, and a fallback would be a match.
      return {
        identityKey: `${UNMATCHED_PREFIX}${id}`,
        priorKeys: [],
        id,
        ambiguousWith: item.key,
      };
    }
    for (const prior of item.priorKeys) if (claimed.has(prior)) dropped.add(prior);
    return {
      identityKey: item.key,
      priorKeys: item.priorKeys.filter((prior) => !claimed.has(prior)),
      id: null,
      ambiguousWith: null,
    };
  });

  return {
    rows,
    ambiguous: [...groups].map(([identityKey, rowIds]) => ({ identityKey, rowIds })),
    sharedPriorKeys: [...dropped],
  };
}
