/**
 * Who issues an invoice, as data.
 *
 * Joe, 1 October 2026: the legal entity is the one the Stripe account was
 * opened under — Tomorrow OS Inc., doing business as Supermortgage — and
 * the terms are the ones published at supermortgage.com. The address and
 * the support address are the ones section 23 of those terms gives. This
 * is printed in the footer of every invoice and copied onto the row, so
 * what a servicer was sent is kept even if this file changes.
 *
 * The terms URL alone is also a deployment variable (`BILLING_TERMS_URL`),
 * because the page there today is the borrower terms — it says the service
 * is free to the borrower and names no payment terms — and a partner terms
 * page replacing it should not need a release.
 */

export interface Issuer {
  readonly legalName: string;
  readonly dba: string;
  /** As it is printed: the legal name, then the trade name. */
  readonly name: string;
  readonly address: {
    readonly line1: string;
    readonly line2: string | null;
    readonly city: string;
    readonly state: string;
    readonly postalCode: string;
    readonly country: "US";
  };
  readonly supportEmail: string;
  readonly termsUrl: string;
  /** When the entity was decided, and by whom. */
  readonly decidedOn: string;
}

export const ISSUER: Issuer = {
  legalName: "Tomorrow OS Inc.",
  dba: "Supermortgage",
  name: "Tomorrow OS Inc. dba Supermortgage",
  address: {
    line1: "2261 Market Street",
    line2: "Suite 86665",
    city: "San Francisco",
    state: "CA",
    postalCode: "94114",
    country: "US",
  },
  supportEmail: "support@supermortgage.com",
  termsUrl: "https://supermortgage.com/terms.html",
  decidedOn: "2026-10-01",
};

/** The address on one line, as a footer prints it. */
export function issuerAddressLine(issuer: Issuer = ISSUER): string {
  const a = issuer.address;
  return [a.line1, a.line2, `${a.city}, ${a.state} ${a.postalCode}`].filter(Boolean).join(", ");
}

/** Lowercased, punctuation dropped, "Inc." and its spellings dropped, one space between words. */
function normalizedName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,'’&()]/g, " ")
    .replace(/\b(inc|incorporated|llc|corp|corporation|co)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether the name the provider prints on its invoices names us. Stripe
 * puts its account's public business name at the head of every invoice
 * and the footer is ours, so the two must not disagree: an invoice headed
 * by one company and signed by another reads as a mistake or a fraud. A
 * name agrees when it names the trade name or the legal name; "HMX
 * sandbox" does not, and "Supermortgage" or "Tomorrow OS, Inc." does.
 */
export function issuerAgrees(providerName: string | null, issuer: Issuer = ISSUER): boolean {
  if (providerName === null || providerName.trim() === "") return false;
  const theirs = normalizedName(providerName);
  if (theirs === "") return false;
  const ours = [issuer.dba, issuer.legalName].map(normalizedName);
  return ours.some((o) => o !== "" && (theirs === o || theirs.includes(o)));
}

/**
 * The footer printed on every invoice: who issues it, how it is paid,
 * which terms govern it, where to write. `payable` is the payment methods
 * in words ("ACH debit"); `termsUrl` is the deployment's, which defaults
 * to the issuer's.
 */
export function invoiceFooter(
  args: { readonly payable: string; readonly termsUrl?: string },
  issuer: Issuer = ISSUER,
): string {
  return (
    `Issued by ${issuer.name}, ${issuerAddressLine(issuer)}. ` +
    `Payable by ${args.payable}. ` +
    `Governed by the terms at ${args.termsUrl ?? issuer.termsUrl}. ` +
    `Questions: ${issuer.supportEmail}.`
  );
}
