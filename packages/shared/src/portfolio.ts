/**
 * What a servicer may tell us about a mortgage, and what it may not.
 *
 * One canonical shape, strict at both ends: an adapter turns a partner's feed
 * into this, and anything this cannot express does not enter the product. The
 * most important property of the type is therefore what it CANNOT hold.
 *
 * **No SSN field, no tax-id field, no account-number field.** A servicing feed
 * plausibly carries all three. `docs/decisions.md` calls a plaintext SSN column
 * the single change most likely to turn this prototype into a breach, and
 * making that a matter of adapter discipline would leave it one careless
 * mapping away. Here the adapter has nowhere to put it, `.strict()` means a
 * record carrying one fails to parse rather than passing it through, and `npm
 * run check` says so. No `ssnLast4` either: nothing in a claim needs four
 * digits, and a field for four is an argument for a field for nine.
 *
 * **No email address.** The partner delivers the claim link and already knows
 * where to send it, so we never need one — and carrying one would put the
 * match `docs/states.md` forbids by name, an email match at sign-in, one WHERE
 * clause away, defended by a comment.
 *
 * **Money arrives as `bigint` cents and rates as three-decimal percent
 * strings**, so the adapter is the only place a vendor's dollar figure becomes
 * cents and no float reaches a service. Not integer basis points: a mortgage
 * note is quoted in eighths, and 6.375 % is 637.5 of them. The `loans` column
 * that still holds integer bps rounds at the importer, where the rounding is
 * visible, rather than here, where it would be a lie about what the servicer
 * said.
 *
 * This module is deliberately outside `index.ts`. `@hm/shared`'s barrel is
 * compiled and bundled by the browser app, which resolves its own copy of zod
 * and has no business carrying a partner-feed parser; a partner shape reaches
 * the API through `@hm/shared/portfolio` and reaches the browser not at all.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Somewhere mail is delivered, or a house stands. No name on it: an address is
 * a place, and pairing one with a person is the caller's act, recorded where
 * that act is.
 */
export const PostalAddressSchema = z
  .object({
    line1: z.string().min(1),
    line2: z.string().nullable(),
    city: z.string().min(1),
    state: z.string().length(2),
    postalCode: z.string().min(1),
  })
  .strict();

export type PostalAddress = z.infer<typeof PostalAddressSchema>;

export const ImportedNameSchema = z
  .object({
    given: z.string().min(1),
    middle: z.string().nullable(),
    surname: z.string().min(1),
  })
  .strict();

export type ImportedName = z.infer<typeof ImportedNameSchema>;

/**
 * A percent to three decimals, as a string: "7.250", "6.375". The unit a
 * note rate is actually quoted in, and one no float can hold exactly.
 */
export const RatePctSchema = z.string().regex(/^\d{1,2}\.\d{3}$/);

export const ImportedPartySchema = z
  .object({
    sourcePartyKey: z.string().min(1),
    /** What the servicer says this person is on a loan somebody else wrote.
     *  NOT `ApplicationPartyRole`, and `GUARANTOR` is where the two part
     *  company: that enum has no guarantor, because no party role in the MISMO
     *  chain is one and a Desktop Underwriter submission could not name them.
     *  A loan already on a servicer's books can perfectly well have one, and
     *  narrowing this would reject a record a partner is right to send. So it
     *  stays, and the importer that maps this feed onto rows has to decide what
     *  a guarantor becomes — which is the decision the other enum not carrying
     *  the value forces, rather than letting one land as a party nothing can
     *  submit. */
    role: z.enum(["PRIMARY_BORROWER", "CO_BORROWER", "NON_BORROWING_SPOUSE", "GUARANTOR"]),
    /** Structured, not one string. Proving somebody is who a servicer says
     *  they are compares a surname and a first given name, and splitting
     *  "SMITH, JOHN Q" at comparison time means guessing inside the one
     *  comparison in this product that may not guess. The adapter does the
     *  split, where every other vendor-shape problem already lives, and
     *  REJECTS the record when it cannot do it confidently — a rejected record
     *  is a row somebody reads, a mis-split name is a borrower refused by
     *  their own mortgage. */
    legalName: ImportedNameSchema,
    /** Nullable, because the feed may genuinely not send one. A party with no
     *  date of birth then gets no claim credential at all: the second factor
     *  the whole thing rests on cannot run for it. Tolerant shape, strict
     *  credential — this describes what a partner may send, not what we are
     *  willing to issue a credential against. */
    dateOfBirth: z.string().date().nullable(),
    mailingAddress: PostalAddressSchema.nullable(),
  })
  .strict();

export type ImportedParty = z.infer<typeof ImportedPartySchema>;

export const ImportedLoanRecordSchema = z
  .object({
    sourceLoanKey: z.string().min(1),
    servicerSlug: z.string().min(1),
    parties: z.array(ImportedPartySchema).min(1),
    property: PostalAddressSchema.extend({ apn: z.string().nullable() }).strict(),
    terms: z
      .object({
        // The four axes, and every one of them nullable. A feed that did not
        // say must not be answered with a guess, so the shape gives the
        // adapter a null to send rather than a default to pick.
        objective: z.enum(["purchase", "rate_term_refinance", "cash_out_refinance"]).nullable(),
        program: z
          .enum([
            "conventional",
            "high_balance",
            "jumbo",
            "fha",
            "va",
            "usda",
            "non_qm",
            "agricultural",
          ])
          .nullable(),
        lienPosition: z.enum(["first", "second", "subordinate_heloc"]).nullable(),
        occupancy: z.enum(["primary_residence", "second_home", "investment"]).nullable(),
        rateType: z.enum(["fixed", "arm"]),
        originalPrincipalCents: z.bigint(),
        noteRatePct: RatePctSchema,
        termMonths: z.number().int(),
        originatedOn: z.string().date().nullable(),
        firstPaymentOn: z.string().date().nullable(),
        maturityOn: z.string().date().nullable(),
      })
      .strict(),
    servicing: z
      .object({
        asOf: z.string().datetime(),
        status: z.enum([
          "current",
          "delinquent",
          "paid_off",
          "charged_off",
          "matured",
          "transferred",
        ]),
        principalBalanceCents: z.bigint(),
        escrowBalanceCents: z.bigint().nullable(),
        scheduledPaymentCents: z.bigint().nullable(),
        currentRatePct: RatePctSchema.nullable(),
        nextPaymentDueOn: z.string().date().nullable(),
        delinquencyDays: z.number().int().nullable(),
      })
      .strict(),
  })
  .strict();

export type ImportedLoanRecord = z.infer<typeof ImportedLoanRecordSchema>;

/**
 * A stable fingerprint of one record, so a re-import can tell "we have this
 * already" from "this changed".
 *
 * Keys are sorted at every level, because two feeds that agree about a
 * mortgage must not disagree about its hash over the order a serializer
 * happened to emit. Money is `bigint` all the way here and is written as a
 * bare integer, which is also how a `number` is written — unambiguous only
 * because every field's type is fixed by the schema above, and worth knowing
 * before anyone widens a field to a union.
 */
export function canonicalRecordHash(r: ImportedLoanRecord): string {
  return createHash("sha256").update(canonical(r)).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
