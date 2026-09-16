/**
 * Submitting a casefile to Desktop Underwriter, for real.
 *
 * The half of this that could be built without Fannie Mae in the room is built:
 * the guard, the emptiness check, the POST, the status contract, the timeout,
 * and a reader that refuses what it does not recognize. The half that cannot is
 * held as configuration with no defaults, so that a deployment missing any of
 * it fails at boot rather than at a borrower.
 *
 * ── What is still not ours, and is a value rather than code ────────────────
 *
 *   1. **A seller/servicer number.** A casefile goes in under one. Grander is
 *      the creditor and Supermortgage administers as their agent, so it would
 *      be Grander's — and whether the agency agreement permits us to submit
 *      under it is a contract question with a longer lead time than any code.
 *      It is `sellerServicerNumber` below, refused at construction when absent,
 *      for the reason the Plaid adapter refuses a missing key at boot: a
 *      credential discovered at the first borrower's request is a credential
 *      discovered in front of a borrower. The API reads it from ONE config
 *      field that also feeds `DuInstitution.submittingPartyIdentifier`, so the
 *      number this adapter authenticates beside and the number the document
 *      states cannot drift apart — and this adapter never reads the document
 *      to compare them.
 *   2. **The endpoint.** From the integration agreement. There is no default
 *      and there must never be one — a wrong endpoint that happens to answer
 *      is worse than none.
 *   3. **The authentication scheme.** Fannie's Technology Integration products
 *      variously use OAuth2 client credentials, a static key header, HTTP
 *      basic and mutual TLS. `DuCredential` below is a closed set of the three
 *      that are a header; which one DU wants is in the guide, not in the
 *      vendored corpus, so it is CHOSEN by configuration rather than detected.
 *      Mutual TLS is not among them: a client certificate is an agent on the
 *      fetch, not a header, and building that seam blind would be inventing.
 *   4. **The response format.** `readResponse` is required and has no default,
 *      for the same reason the endpoint has none. `mismoAusResponseReader` in
 *      `du-response.ts` is written against the one shape the schema chain
 *      defines and is marked as the guess it is.
 *
 * What the vendored corpus DOES specify, and what this file therefore no longer
 * claims is missing, is the MESSAGE-level envelope: `packages/du/src/assemble`
 * emits the MISMO `MESSAGE` with its attributes, `ABOUT_VERSIONS` and the
 * `SubmittingParty` role, and `DU_Wrapper_3.4.0_B324.xsd` is an `xsd:redefine`
 * of the MISMO model that declares no element of its own. The envelope that is
 * missing is the HTTP one — the URL, the credential, the content type, whether
 * the answer is synchronous, and what it looks like.
 *
 * ── The ordering, which is the part with teeth ─────────────────────────────
 *
 * The guard runs FIRST and unconditionally, and the emptiness check runs
 * second. A half-wiring that gets a transport and no permission check is the
 * failure this ordering exists to make impossible: this is the only thing
 * between an assembled submission and Fannie Mae, so everything that must
 * happen before a send is above the send. `du.test.ts` asserts WHICH error each
 * refusal is, against an adapter whose `fetchImpl` throws if it is reached at
 * all — so a future edit that sends first and checks after fails the test
 * rather than passing it.
 *
 * ── What never appears in an error from this file ──────────────────────────
 *
 * The request body and the response body. The casefile carries up to four
 * cleartext social security numbers and the findings report names people, their
 * income and their debts. A `DuTransportError` carries the status, the media
 * type and the endpoint's origin, which is what an operator needs, and nothing
 * a borrower owns. The credential never appears either, in any form.
 */

import type { PurposeToken, DuResponse } from "@hm/shared";
import { requireEveryBorrowerAuthorized } from "../guard.js";
import { requireDocument } from "../ports/index.js";
import type { ConnectorResult, DuConnector, DuSubmission } from "../ports/index.js";
import { MAX_DU_RESPONSE_CHARACTERS, type DuResponseReader } from "./du-response.js";

export type DuEnvironment = "test" | "production";

/**
 * How a request proves it is us.
 *
 * Three shapes, all of them a header, because which one Desktop Underwriter
 * wants is in the integration guide and not in `packages/du-schema`. The set is
 * closed and the choice is configuration: an adapter that sniffed the scheme
 * from a 401 challenge would be inventing a protocol, and one that sent all
 * three would be leaking a credential to whichever endpoint answered.
 */
export type DuCredential =
  | { readonly scheme: "bearer"; readonly token: string }
  | { readonly scheme: "basic"; readonly username: string; readonly password: string }
  | { readonly scheme: "header"; readonly name: string; readonly value: string };

/** The three schemes, for a configuration layer that has to validate a string. */
export const DU_CREDENTIAL_SCHEMES = ["bearer", "basic", "header"] as const;

export interface DuOptions {
  /**
   * The institution the casefile is submitted under. Not ours: see the header.
   */
  readonly sellerServicerNumber: string;
  readonly environment: DuEnvironment;
  /**
   * Where the casefile is sent, from the integration agreement. There is no
   * default, and there must never be one — a wrong endpoint that happens to
   * answer is worse than none. Must be `https:`.
   */
  readonly endpoint: string;
  /** How the request proves it is us. See `DuCredential`. */
  readonly credential: DuCredential;
  /**
   * Bytes to an answer. **Required, with no default**, on the same argument as
   * the endpoint: a deployment whose response format is not the one
   * `mismoAusResponseReader` guesses at must be handed a different function
   * rather than silently half-reading this one.
   */
  readonly readResponse: DuResponseReader;
  /**
   * How long to wait. DU evaluates a casefile rather than echoing it, so this
   * is generous by the standards of the other adapters.
   */
  readonly timeoutMs?: number;
  /**
   * Permit `environment: "production"`. Deliberately awkward, the way
   * `allowLiveMode` is on the Stripe adapter: a production submission puts a
   * real borrower's file in front of Fannie Mae under a real institution's
   * number, and nothing in this repository sets this.
   */
  readonly allowProduction?: boolean;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Thrown when this adapter cannot be BUILT.
 *
 * It used to mean "submit refuses", because submit always did. It now means the
 * configuration is incomplete or unsafe — no number, no endpoint, an endpoint
 * that is not https, no credential, production without the flag — and every one
 * of those is an operator's problem discovered at boot. An authorization
 * refusal is a borrower's, and a route that collapsed the two would tell
 * somebody to sign something that would not have helped.
 */
export class DuTransportNotWiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuTransportNotWiredError";
  }
}

/**
 * Thrown when the exchange itself failed.
 *
 * Distinct from `DuResponseFormatError`, which means an answer arrived and was
 * not one we could read, and from `DuTransportNotWiredError`, which means no
 * request was ever attempted. This one means bytes may have left the building.
 *
 * `mayHaveOpenedACase` is the field that matters and the reason this is a class
 * rather than a message. On a timeout or a dropped connection the casefile may
 * have reached Fannie Mae and DU may have minted a case for it; the caller
 * cannot resubmit blindly, because a second submission with no
 * `AutomatedUnderwritingCaseIdentifier` opens a SECOND case for one loan. What
 * detects that afterwards is the write-once trigger on
 * `applications.du_casefile_id` — but only if whatever retries re-reads the row
 * first.
 */
export class DuTransportError extends Error {
  constructor(
    message: string,
    readonly mayHaveOpenedACase: boolean,
  ) {
    super(message);
    this.name = "DuTransportError";
  }
}

/**
 * The credential as headers. Pure, so it can be tested without a server.
 *
 * `basic` is encoded as ASCII deliberately. RFC 7617 leaves the character set
 * to the server and a non-ASCII credential would be encoded one way here and
 * read another way there — a failure that looks like a wrong password. It is
 * refused at construction instead.
 */
export function authorizationHeaders(credential: DuCredential): Record<string, string> {
  switch (credential.scheme) {
    case "bearer":
      return { authorization: `Bearer ${credential.token}` };
    case "basic": {
      const pair = `${credential.username}:${credential.password}`;
      return { authorization: `Basic ${Buffer.from(pair, "ascii").toString("base64")}` };
    }
    case "header":
      return { [credential.name.toLowerCase()]: credential.value };
  }
}

/** Empty, or nothing but whitespace. */
function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

/** Whether the credential carries anything to send, without saying what. */
function credentialIsBlank(credential: DuCredential): boolean {
  switch (credential.scheme) {
    case "bearer":
      return blank(credential.token);
    case "basic":
      return blank(credential.username) || blank(credential.password);
    case "header":
      return blank(credential.name) || blank(credential.value);
  }
}

/** ASCII, for the reason `authorizationHeaders` gives. */
function credentialIsAscii(credential: DuCredential): boolean {
  const parts =
    credential.scheme === "bearer"
      ? [credential.token]
      : credential.scheme === "basic"
        ? [credential.username, credential.password]
        : [credential.name, credential.value];
  return parts.every((part) => /^[\x20-\x7e]*$/.test(part));
}

/** The endpoint with its path, query and credentials taken off. Safe in a log. */
function originOf(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return "the configured endpoint";
  }
}

export function duConnector(options: DuOptions): DuConnector {
  if (options.sellerServicerNumber.trim() === "") {
    throw new DuTransportNotWiredError(
      "A DU casefile is submitted under a seller/servicer number, and none is configured.",
    );
  }
  if (options.endpoint.trim() === "") {
    throw new DuTransportNotWiredError("DU_ENDPOINT is not set, so there is nowhere to submit to.");
  }
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(options.endpoint);
  } catch {
    throw new DuTransportNotWiredError(
      "DU_ENDPOINT is not a URL, so there is nowhere to submit to.",
    );
  }
  if (endpointUrl.protocol !== "https:") {
    // The document carries up to four cleartext social security numbers. There
    // is no development shortcut for this: a test stub is handed a `fetchImpl`
    // and never an http URL.
    throw new DuTransportNotWiredError(
      "DU_ENDPOINT is not https. A casefile carries cleartext social security numbers and " +
        "does not go over an unencrypted connection, not even in test.",
    );
  }
  if (credentialIsBlank(options.credential)) {
    throw new DuTransportNotWiredError(
      `DU_CREDENTIAL is empty for the ${options.credential.scheme} scheme, so nothing would ` +
        "authenticate. Discovering that at the first borrower's request is discovering it in " +
        "front of a borrower.",
    );
  }
  if (!credentialIsAscii(options.credential)) {
    throw new DuTransportNotWiredError(
      "DU_CREDENTIAL carries a character outside printable ASCII, which different ends of an " +
        "HTTP connection encode differently. Refusing rather than sending something that will " +
        "read as a wrong password.",
    );
  }
  if (options.environment === "production" && options.allowProduction !== true) {
    throw new DuTransportNotWiredError(
      "DU_ENV=production without DU_ALLOW_PRODUCTION. A production submission puts a real " +
        "borrower's file in front of Fannie Mae under a real institution's number, and that " +
        "is a decision somebody makes explicitly.",
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const production = options.environment === "production";
  const provider = production ? "desktop-underwriter (PRODUCTION)" : "desktop-underwriter (test)";

  return {
    capabilities: {
      provider,
      mode: production ? "production" : "sandbox",
      // Still nothing, and deliberately. UW-001 is "the casefile was submitted"
      // and UW-002 "DU answered"; this adapter has never completed one exchange
      // against Fannie Mae's test environment, because nobody holds credentials
      // for it. Listing them here would put two requirements behind a POST to
      // an endpoint whose shape is a guess. Flip this to ["UW-001", "UW-002"]
      // in the commit that records the first real answer, not before.
      satisfies: [],
    },
    async submit(
      submission: DuSubmission,
      tokens: readonly PurposeToken[],
    ): Promise<ConnectorResult<DuResponse>> {
      requireEveryBorrowerAuthorized(submission, tokens);
      requireDocument(submission);

      let response: Response;
      try {
        response = await fetchImpl(options.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/xml; charset=utf-8",
            accept: "application/xml",
            ...authorizationHeaders(options.credential),
          },
          body: submission.document,
          signal: AbortSignal.timeout(timeoutMs),
          // Never followed. A redirect to a sign-in page would otherwise be
          // answered by re-POSTing a casefile — and the credential with it — to
          // a host nobody configured.
          redirect: "error",
        });
      } catch (err) {
        // The bytes may have arrived. Nothing here can tell a connection that
        // failed on the way out from one that failed on the way back, so this
        // says so rather than letting a caller assume the safer of the two.
        throw new DuTransportError(
          `The submission to ${originOf(options.endpoint)} did not complete ` +
            `(${err instanceof Error ? err.name : "unknown"}). The casefile MAY have been ` +
            "received and Desktop Underwriter MAY have opened a case for it. Do not resubmit " +
            "without re-reading applications.du_casefile_id: a resubmission that carries no " +
            "case identifier opens a second case for one loan.",
          true,
        );
      }

      const contentType = response.headers.get("content-type");
      if (!response.ok) {
        throw new DuTransportError(
          `Desktop Underwriter answered ${response.status} at ${originOf(options.endpoint)} ` +
            `(${contentType ?? "no content-type"}). The body is not repeated here: a findings ` +
            "report names people.",
          // A response arrived, so the request was received and DU decided
          // against it. Whether a case was opened is DU's answer to give, and
          // the caller learns it by asking again rather than by guessing.
          false,
        );
      }

      // Before `.text()` rather than after, which is the half of the cap that
      // protects memory. A server sending no content-length is buffered, which
      // is the limit of what can be done without streaming.
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_DU_RESPONSE_CHARACTERS) {
        throw new DuTransportError(
          `Desktop Underwriter's answer declares ${declaredLength} bytes, past the ` +
            `${MAX_DU_RESPONSE_CHARACTERS} this will read. Nothing was buffered.`,
          false,
        );
      }

      const data = options.readResponse({
        status: response.status,
        contentType,
        body: await response.text(),
        // Our clock. A vendor timestamp's zone and meaning are two more things
        // the corpus does not give, and `received_at` is a fact about us.
        receivedAt: new Date(),
      });

      return {
        data,
        provider,
        retrievedAt: data.respondedAt,
        // DU's case number where there is one. Where DU refused before opening a
        // case there is none, and the audit row still has to name something
        // this exchange can be found by — ours.
        externalId: data.duCasefileId ?? `du-${submission.ausCasefileId}`,
      };
    },
  };
}
