/**
 * Permission to retrieve something about a named person.
 *
 * The guard this replaces is `assertVerificationAuthorized(file)`, and its
 * problem is visible in the signature: it takes a FILE. On a two-borrower file
 * it will happily let borrower A's signature authorize a credit pull about
 * borrower B, because nothing in the call names whose data is being fetched.
 * It also cannot distinguish a bank authorization from a tax-transcript one,
 * and it never expires.
 *
 * A `PurposeToken` fixes that by construction rather than by discipline. It
 * names one party, one purpose and one data category; it can only be produced
 * by `mintPurposeToken`, which needs real grants to look at; and its brand is a
 * symbol this module does not export, so no other file can write an object
 * literal that satisfies the type. A connector method that takes one cannot be
 * called without a permission having been checked, and no amount of careless
 * refactoring can move the check to the wrong side of the pull.
 */

/** The legal basis a grant rests on, not the screen that collected it. */
export type AuthorizationPurpose =
  | "fcra_written_instruction"
  | "fcra_account_review"
  | "fcra_prescreen"
  | "irs_4506c"
  | "ssa_89"
  | "biometric_idv"
  | "electronic_delivery"
  | "partner_data_share"
  | "marketing_contact";

/**
 * What may be retrieved. Person-keyed only.
 *
 * An assessor record, an AVM and a flood determination are keyed on a building
 * and need nobody's permission, which is exactly why screen 1 can run before
 * any authorization exists. Keeping them out of this union is the address /
 * person split expressed in the type system.
 */
export type DataCategory =
  | "credit_report"
  | "bank_transactions"
  | "payroll_income"
  | "tax_transcript"
  | "identity_document"
  | "sanctions_screening"
  /** A lien search names an owner, even though the query goes in by parcel. */
  | "public_record_liens";

/** A grant as stored. */
export interface Grant {
  readonly id: string;
  readonly partyId: string;
  readonly purpose: AuthorizationPurpose;
  readonly dataCategories: readonly DataCategory[];
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

declare const purposeTokenBrand: unique symbol;

/**
 * Proof that one specific retrieval is permitted, right now.
 *
 * The brand is not exported, so this type cannot be produced anywhere but
 * `mintPurposeToken`. That is the whole mechanism: an adapter cannot conjure
 * one, a test cannot fake one without going through the same checks the
 * production path uses, and a `as PurposeToken` cast is the only way around it
 * — which is greppable in a way that a forgotten function call is not.
 */
export interface PurposeToken {
  readonly [purposeTokenBrand]: true;
  readonly partyId: string;
  /**
   * The loan file this token was minted on, and the only one it speaks for.
   *
   * A grant belongs to the person and outlives the application it was signed
   * on, so read by party alone it is one person's permission everywhere for
   * 120 days. The minter already refuses a category with no signature on THIS
   * file; carrying the file id forward is what lets a port that transmits
   * several people's data at once ask the same question, instead of trusting
   * that whoever gathered the tokens gathered them from one application.
   */
  readonly fileId: string;
  readonly purpose: AuthorizationPurpose;
  readonly dataCategory: DataCategory;
  readonly authorizationId: string;
  readonly mintedAt: string;
}

/**
 * Why a retrieval was refused.
 *
 * Four values rather than a boolean, because they are four different
 * conversations. "Nobody ever asked you" is a form; "you withdrew this" is an
 * apology and an offer to re-grant; "it lapsed" is a renewal; "you agreed to
 * something narrower" is a second, specific ask. Collapsing them produces the
 * screen that tells a borrower to do something they already did.
 */
export type DenialReason = "no_grant" | "revoked" | "expired" | "category_not_granted";

export type MintResult =
  | { readonly ok: true; readonly token: PurposeToken }
  | { readonly ok: false; readonly reason: DenialReason; readonly message: string };

const DENIAL_MESSAGE: Record<DenialReason, string> = {
  no_grant: "no authorization of this purpose has ever been granted by this party",
  revoked: "the authorization was revoked",
  expired: "the authorization has expired",
  category_not_granted: "the authorization does not cover this data category",
};

function denied(reason: DenialReason): MintResult {
  return { ok: false, reason, message: DENIAL_MESSAGE[reason] };
}

/**
 * Mint a token, or say precisely why not.
 *
 * Pure: it is handed the grants rather than fetching them, so the rule is
 * testable without a database and the caller is forced to have loaded real
 * rows. `grants` may contain rows for other parties and purposes — filtering is
 * this function's job, because a caller that filters is a caller that can
 * filter wrongly.
 *
 * `fileId` is stamped rather than checked: the grants carry no loan file, so
 * whether this party signed HERE is a question about rows this function was
 * deliberately not given. `tokenFor` in the API asks it, and is the only minter
 * there is — so the scope on the token is as good as that one caller, which is
 * exactly as good as the party on it already was.
 */
export function mintPurposeToken(args: {
  readonly partyId: string;
  readonly fileId: string;
  readonly purpose: AuthorizationPurpose;
  readonly dataCategory: DataCategory;
  readonly grants: readonly Grant[];
  readonly now: Date;
}): MintResult {
  const { partyId, fileId, purpose, dataCategory, grants, now } = args;

  const mine = grants.filter((g) => g.partyId === partyId && g.purpose === purpose);
  if (mine.length === 0) return denied("no_grant");

  const unrevoked = mine.filter((g) => g.revokedAt === null);
  // The database allows at most one unrevoked grant per (party, purpose), so
  // everything left is either that one row or history.
  if (unrevoked.length === 0) return denied("revoked");

  const live = unrevoked.filter((g) => Date.parse(g.expiresAt) > now.getTime());
  if (live.length === 0) return denied("expired");

  const covering = live.find((g) => g.dataCategories.includes(dataCategory));
  if (!covering) return denied("category_not_granted");

  return {
    ok: true,
    token: {
      partyId,
      fileId,
      purpose,
      dataCategory,
      authorizationId: covering.id,
      mintedAt: now.toISOString(),
    } as PurposeToken,
  };
}

/** Thrown when a retrieval is attempted without a token. */
export class AuthorizationDenied extends Error {
  constructor(
    readonly reason: DenialReason,
    readonly partyId: string,
    readonly purpose: AuthorizationPurpose,
    readonly dataCategory: DataCategory,
  ) {
    super(
      `Refusing to retrieve ${dataCategory} for party ${partyId} under ${purpose}: ` +
        DENIAL_MESSAGE[reason],
    );
    this.name = "AuthorizationDenied";
  }
}

/** Mint, or throw. For call sites that cannot carry on without the data. */
export function requirePurposeToken(args: {
  readonly partyId: string;
  readonly fileId: string;
  readonly purpose: AuthorizationPurpose;
  readonly dataCategory: DataCategory;
  readonly grants: readonly Grant[];
  readonly now: Date;
}): PurposeToken {
  const result = mintPurposeToken(args);
  if (result.ok) return result.token;
  throw new AuthorizationDenied(result.reason, args.partyId, args.purpose, args.dataCategory);
}
