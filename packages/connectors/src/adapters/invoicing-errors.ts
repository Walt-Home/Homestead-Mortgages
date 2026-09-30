/**
 * What an invoicing adapter throws, named so a route can answer each one
 * differently: a delivery that is not the provider's is a 400, a door with
 * no secret behind it is a 503, and a provider that refused or could not be
 * reached is a 502 carrying its own sentence.
 */

/** A delivered event whose signature did not verify against the raw body. */
export class InvoicingSignatureError extends Error {
  readonly code = "INVOICING_SIGNATURE";
  constructor(message = "The event's signature did not verify.") {
    super(message);
    this.name = "InvoicingSignatureError";
  }
}

/** The adapter holds no signing secret, so no delivery can be verified. */
export class InvoicingNotConfiguredError extends Error {
  readonly code = "INVOICING_NOT_CONFIGURED";
  constructor(message = "No signing secret is configured for invoicing events.") {
    super(message);
    this.name = "InvoicingNotConfiguredError";
  }
}

/** The provider refused a request, or could not be reached to be asked. */
export class InvoicingProviderError extends Error {
  readonly code = "INVOICING_PROVIDER";
  constructor(
    message: string,
    /** The provider's own code for the refusal, when it gave one. */
    readonly providerCode: string | null = null,
    /** The HTTP status it answered, when it answered. */
    readonly statusCode: number | null = null,
  ) {
    super(message);
    this.name = "InvoicingProviderError";
  }
}

/** The idempotency key for one act on one of our invoices. Stable across retries. */
export function invoicingKey(invoiceId: string, act: string): string {
  return `hm-invoice-${invoiceId}-${act}`;
}
