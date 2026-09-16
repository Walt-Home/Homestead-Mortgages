/**
 * Turning what Desktop Underwriter sends back into a `DuResponse`.
 *
 * ⚠ **Written against the only response shape the vendored corpus defines, and
 * never exercised against a live payload.** `packages/du-schema` specifies what
 * we SEND. It says nothing about what DU answers with: not the media type, not
 * whether the answer is MISMO at all, not where the recommendation sits. The
 * one candidate the schema chain does declare is
 * `AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE` under `DEAL/SERVICES/SERVICE`, with
 * the verdict on an `AUTOMATED_UNDERWRITING` container, and that is what this
 * reads. It is a guess about the format and an honest one about the fields —
 * every element name below is in `MISMO_3.4.0_B324.xsd` and none was invented.
 *
 * **This is the only file that changes when a real payload is in hand.** The
 * adapter takes a `DuResponseReader` and has no default one, so a deployment
 * whose response format is not this cannot silently half-work: it is handed a
 * different function or it is handed nothing.
 *
 * ── Why it refuses rather than salvages ───────────────────────────────────
 *
 * Everything downstream of here is append-only and write-once.
 * `recordDuResponse` claims `applications.du_casefile_id` the first time it
 * sees one, and a later answer naming a different case raises. So a reader that
 * guessed — that read a sign-in page as "a response with no findings", or an
 * unfamiliar verdict as "errored" — would not produce a wrong screen. It would
 * produce a wrong row that cannot be replaced, on the column a resubmission
 * depends on. Refusing loses an answer somebody has to fetch again; guessing
 * loses the case.
 *
 * That is the same argument `parseDuResponseStatus` makes in `@hm/shared`, one
 * layer out: a status nobody recognizes, read as "errored", files a verdict DU
 * gave as a casefile DU could not evaluate.
 *
 * ── The XML is scanned here rather than parsed by a library ───────────────
 *
 * `@hm/connectors` has one dependency, `@hm/shared`, and this is the package
 * that talks to vendors and holds the authorization guard — the worst place in
 * the repository to add supply-chain surface. The scanner below is private to
 * this file and deliberately incapable: it accepts elements, attributes, text,
 * CDATA, comments and the XML declaration, and it REFUSES a DOCTYPE, an entity
 * declaration, and every entity reference that is not one of the five
 * predefined names or a numeric character reference. There is therefore no DTD
 * to expand, no external entity to resolve and no entity to expand into itself
 * — the three things that make a general XML parser pointed at a vendor's bytes
 * a hazard. `packages/du-schema` makes the same trade for the same reason and
 * writes it down: schema validation shells out to `xmllint` rather than adding
 * a megabyte of JavaScript to do it.
 *
 * It is not exported, and that is part of the design. A general XML parser in
 * this package's public surface is one somebody reuses for something it was
 * never careful enough for.
 *
 * ── Namespaces ────────────────────────────────────────────────────────────
 *
 * Elements are matched on their LOCAL name, with any prefix dropped and no
 * namespace URI checked. A MISMO document uses a default namespace and Fannie's
 * own eighteen samples do; a response could equally arrive prefixed. Resolving
 * prefixes to URIs would mean asserting which namespace DU answers in, and
 * nothing vendored says. The element names being this specific —
 * `AutomatedUnderwritingRecommendationDescription` is not a word two vocabularies
 * share — is what makes local-name matching safe enough for a reader that
 * refuses everything it half-recognizes anyway.
 */

import {
  parseDuRecommendation,
  type DuMessage,
  type DuResponse,
} from "@hm/shared";

/** Exactly what the adapter saw, before anything interpreted it. */
export interface DuRawResponse {
  readonly status: number;
  /** The `content-type` header verbatim, or null where the server sent none. */
  readonly contentType: string | null;
  readonly body: string;
  /** OUR clock. See `respondedAt` below. */
  readonly receivedAt: Date;
}

/**
 * Bytes to an answer, or a refusal.
 *
 * A function rather than a method on the adapter, because the HTTP exchange and
 * the format of what comes back are two unknowns that will be answered by two
 * different pages of the integration guide — and if DU turns out to answer a
 * POST with a job id to poll, the exchange changes and this does not.
 */
export type DuResponseReader = (raw: DuRawResponse) => DuResponse;

/**
 * The answer was not one this system can read.
 *
 * Distinct from `UnknownDuRecommendationError`, which means DU said something
 * we understood the shape of and not the word. This one means the document is
 * not a findings response at all — an HTML sign-in page, a gateway error with a
 * 200 on it, XML with no verdict and no messages in it.
 *
 * **The message never carries the body.** A findings report names people, their
 * income and their debts; a refusal is a string somebody pastes into a ticket.
 * What it may carry is the media type, the length and which element was
 * missing, which is everything an operator needs and nothing a borrower owns.
 */
export class DuResponseFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuResponseFormatError";
  }
}

/**
 * How much of an answer this will read.
 *
 * A findings report is a few hundred kilobytes of text at the outside. Four
 * mebibytes is room for an unusually long one and a bound on what a wrong
 * endpoint can make this process hold. Measured in characters of the decoded
 * body rather than bytes on the wire: by the time a `DuResponseReader` is
 * called, `fetch` has already decoded it. The adapter checks `content-length`
 * BEFORE reading, which is the half of this that actually protects memory —
 * and a server that sends no `content-length` gets buffered, which is the limit
 * of what can be done without streaming the response.
 */
export const MAX_DU_RESPONSE_CHARACTERS = 4 * 1024 * 1024;

/** `applications.du_casefile_id` is a `VARCHAR(30)`, and DU_FORMATS says String 30. */
export const DU_CASEFILE_IDENTIFIER_MAX_LENGTH = 30;

/**
 * What every message is filed under until a real payload shows a category.
 *
 * `DuMessage.category` is free text and NOT NULL. DU groups its findings under
 * headings — Summary, Risk/Eligibility, Verification Messages — but the MISMO
 * container has nowhere to put one: `AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE_MESSAGE`
 * carries a description, a value and a sequence number, and that is all. So one
 * constant, which is a true statement about where the line came from, rather
 * than a heading inferred from the text.
 */
export const DU_FINDINGS_CATEGORY = "Findings";

/** An XML media type, or one of the things a wrong endpoint answers with. */
function assertXmlMediaType(contentType: string | null): void {
  if (contentType === null) {
    throw new DuResponseFormatError(
      "Desktop Underwriter's answer carried no content-type, so nothing here knows what it is.",
    );
  }
  const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
  const isXml =
    mediaType === "application/xml" || mediaType === "text/xml" || mediaType.endsWith("+xml");
  if (!isXml) {
    throw new DuResponseFormatError(
      `Desktop Underwriter's answer is ${JSON.stringify(mediaType)} and not XML. A sign-in ` +
        "page, an error page and a gateway notice all arrive with a 200 on them; none of them " +
        "is a findings report.",
    );
  }
}

/**
 * The reader for a MISMO `AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE`.
 *
 * What it accepts:
 *
 *   - An XML media type, a body inside the cap, and a document the scanner
 *     below can read with no DTD and no non-predefined entity in it.
 *   - `AUTOMATED_UNDERWRITING` containers anywhere in the document, for
 *     `AutomatedUnderwritingCaseIdentifier` and
 *     `AutomatedUnderwritingRecommendationDescription`. Anywhere, because the
 *     schema permits the container at two XPaths — under the deal's own
 *     `LOAN/UNDERWRITING` and under the response's `LOANS/LOAN/UNDERWRITING`,
 *     since `AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE` carries a `LOANS` of its
 *     own — and nothing vendored says which one DU answers in. A response that
 *     echoes our submission carries both, agreeing.
 *   - `AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE_MESSAGE` elements as the findings.
 *
 * What it refuses:
 *
 *   - Two `AUTOMATED_UNDERWRITING` containers that DISAGREE about the case
 *     identifier or the recommendation. One of them is the answer and nothing
 *     here can say which.
 *   - A verdict with no case identifier. DU opened a case to evaluate the
 *     casefile; a recommendation arriving without one is a shape nobody has
 *     seen, and recording it as `errored` would file a verdict as an evaluation
 *     that never happened.
 *   - A case identifier that is empty or longer than thirty characters, which
 *     the column cannot hold.
 *   - A document with no verdict AND no messages, which is what a 200 from the
 *     wrong endpoint looks like.
 *   - A findings message with no description, which has no `text` to be.
 *   - Messages where some carry a `SequenceNumber` and others do not. The
 *     schema says the value is unique across siblings; a partial one is an
 *     order nobody can reconstruct, and the order of a findings report is part
 *     of what it says.
 *
 * And `UnknownDuRecommendationError` comes through from `@hm/shared` unchanged
 * when the verdict is a word this system has never decided about — nothing is
 * returned and therefore nothing is stored.
 */
export const mismoAusResponseReader: DuResponseReader = (raw) => {
  assertXmlMediaType(raw.contentType);
  if (raw.body.length > MAX_DU_RESPONSE_CHARACTERS) {
    throw new DuResponseFormatError(
      `Desktop Underwriter's answer is ${raw.body.length} characters, past the ` +
        `${MAX_DU_RESPONSE_CHARACTERS} this will read. Nothing was parsed.`,
    );
  }

  const root = scanXml(raw.body);

  const underwritings = descendantsNamed(root, "AUTOMATED_UNDERWRITING");
  const caseIdentifier = theOneValueOf(
    underwritings,
    "AutomatedUnderwritingCaseIdentifier",
    "case identifier",
  );
  const recommendationText = theOneValueOf(
    underwritings,
    "AutomatedUnderwritingRecommendationDescription",
    "recommendation",
  );

  if (caseIdentifier !== null && caseIdentifier.length > DU_CASEFILE_IDENTIFIER_MAX_LENGTH) {
    throw new DuResponseFormatError(
      `Desktop Underwriter's case identifier is ${caseIdentifier.length} characters at a ` +
        `destination that takes ${DU_CASEFILE_IDENTIFIER_MAX_LENGTH}. Nothing is stored.`,
    );
  }

  const messages = readMessages(root);
  if (recommendationText === null && messages.length === 0) {
    throw new DuResponseFormatError(
      "Desktop Underwriter's answer carries no recommendation and no findings message, so " +
        "there is nothing in it this system recognizes as a response.",
    );
  }

  const respondedAt = raw.receivedAt.toISOString();

  if (recommendationText === null) {
    return { status: "errored", duCasefileId: caseIdentifier, messages, respondedAt };
  }
  if (caseIdentifier === null) {
    throw new DuResponseFormatError(
      "Desktop Underwriter answered with a recommendation and no case identifier. Recording " +
        "that as an errored response would file a verdict as an evaluation that never " +
        "happened, and a resubmission would open a second case.",
    );
  }
  return {
    status: "answered",
    duCasefileId: caseIdentifier,
    // Throws UnknownDuRecommendationError on a word this system has not decided
    // about. Deliberately not caught: nothing is returned, so nothing is stored.
    recommendation: parseDuRecommendation(recommendationText),
    messages,
    respondedAt,
  };
};

/**
 * One value for a data point across every container that carries it, or null.
 *
 * Two containers agreeing is the ordinary case on a response that echoes the
 * submission. Two disagreeing is one answer and one something else, and the
 * refusal names the count rather than the values — a case identifier is not a
 * secret, but the rule in this package is that a message somebody pastes into a
 * ticket carries no value from a casefile.
 */
function theOneValueOf(
  containers: readonly XmlElement[],
  name: string,
  what: string,
): string | null {
  const values = new Set<string>();
  for (const container of containers) {
    for (const element of childrenNamed(container, name)) {
      const value = element.text.trim();
      if (value === "") {
        throw new DuResponseFormatError(
          `Desktop Underwriter's answer carries an empty ${what}. An empty element is a claim ` +
            "nothing here can read.",
        );
      }
      values.add(value);
    }
  }
  if (values.size > 1) {
    throw new DuResponseFormatError(
      `Desktop Underwriter's answer states ${values.size} different values for the ${what}. ` +
        "One of them is the answer and nothing here can say which.",
    );
  }
  const [only] = values;
  return only ?? null;
}

/** The findings, in the order the report gives them. */
function readMessages(root: XmlElement): DuMessage[] {
  const elements = descendantsNamed(root, "AUTOMATED_UNDERWRITING_SYSTEM_RESPONSE_MESSAGE");
  const sequenced = elements.map((element) => {
    const description = childrenNamed(element, "AutomatedUnderwritingSystemMessageDescription")
      .map((child) => child.text.trim())
      .find((text) => text !== "");
    if (description === undefined) {
      throw new DuResponseFormatError(
        "A findings message in Desktop Underwriter's answer carries no description, so there " +
          "is no text for it to be.",
      );
    }
    const code = childrenNamed(element, "AutomatedUnderwritingSystemMessageValue")
      .map((child) => child.text.trim())
      .find((text) => text !== "");
    const sequence = element.attributes.get("SequenceNumber");
    return {
      sequence: sequence === undefined ? null : sequence.trim(),
      message: { category: DU_FINDINGS_CATEGORY, code: code ?? null, text: description },
    };
  });

  const numbered = sequenced.filter((entry) => entry.sequence !== null);
  if (numbered.length === 0) return sequenced.map((entry) => entry.message);
  if (numbered.length !== sequenced.length) {
    throw new DuResponseFormatError(
      `Desktop Underwriter's answer numbers ${numbered.length} of ${sequenced.length} findings ` +
        "messages. A partial order is one nothing here can reconstruct, and the order of a " +
        "findings report is part of what it says.",
    );
  }
  const keys = numbered.map((entry) => Number(entry.sequence));
  if (keys.some((key) => !Number.isSafeInteger(key)) || new Set(keys).size !== keys.length) {
    throw new DuResponseFormatError(
      "Desktop Underwriter's findings messages carry sequence numbers that are not distinct " +
        "integers, and the schema says they must be.",
    );
  }
  return sequenced
    .map((entry, index) => ({ key: keys[index]!, message: entry.message }))
    .sort((a, b) => a.key - b.key)
    .map((entry) => entry.message);
}

// ── The scanner ─────────────────────────────────────────────────────────────
//
// Private to this file. See the header for why it exists and what it refuses.

interface XmlElement {
  /** The local name, with any namespace prefix dropped. */
  readonly name: string;
  /** Attributes by local name. */
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XmlElement[];
  /** This element's own character data, with its children's excluded. */
  readonly text: string;
}

/** Deep enough for MISMO, shallow enough that no document can exhaust the stack. */
const MAX_XML_DEPTH = 100;
/** A findings report is hundreds of elements. This is four orders of magnitude of room. */
const MAX_XML_ELEMENTS = 200_000;

/** The five XML predefines. There is no DTD here, so there are no others. */
const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_:.-]/;

function localNameOf(qualified: string): string {
  const colon = qualified.lastIndexOf(":");
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

/**
 * The document's root element, or a refusal.
 *
 * Reads top to bottom with an explicit cursor rather than a regular expression,
 * because every construct it does not handle has to be REFUSED and a regular
 * expression's failure mode is to match less and carry on.
 */
function scanXml(source: string): XmlElement {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  let at = 0;

  // A function declaration rather than a const arrow, so that TypeScript reads
  // a call to it as terminating the flow and the cursor stays non-nullable
  // afterwards.
  function fail(why: string): never {
    // The offset, never the text at it. See DuResponseFormatError.
    throw new DuResponseFormatError(`${why} at character ${at} of the answer.`);
  }

  const skipSpace = (): void => {
    while (at < text.length && /\s/.test(text[at]!)) at += 1;
  };

  /** A comment, a processing instruction or the XML declaration. Nothing else. */
  const skipProlog = (): boolean => {
    if (text.startsWith("<!--", at)) {
      const end = text.indexOf("-->", at + 4);
      if (end === -1) fail("An XML comment is never closed");
      at = end + 3;
      return true;
    }
    if (text.startsWith("<?", at)) {
      const end = text.indexOf("?>", at + 2);
      if (end === -1) fail("An XML processing instruction is never closed");
      at = end + 2;
      return true;
    }
    if (text.startsWith("<!", at)) {
      // A DOCTYPE, an ENTITY declaration, a conditional section. The reason
      // this reader needs no entity-expansion limit is that it has none to
      // expand: without a DTD there is nothing an entity could be declared in.
      fail(
        "The answer carries a document type or entity declaration, which this reader refuses " +
          "rather than resolving",
      );
    }
    return false;
  };

  /**
   * The five predefines and numeric character references. Everything else —
   * including a bare `&`, which is not well-formed XML — is refused rather than
   * passed through, because a reader that carries an unresolved reference into
   * a findings message is showing somebody markup and calling it a finding.
   */
  const decodeEntities = (raw: string): string => {
    if (!raw.includes("&")) return raw;
    let out = "";
    let from = 0;
    for (;;) {
      const amp = raw.indexOf("&", from);
      if (amp === -1) {
        out += raw.slice(from);
        return out;
      }
      out += raw.slice(from, amp);
      const semicolon = raw.indexOf(";", amp + 1);
      if (semicolon === -1 || semicolon - amp > 32) {
        fail("The answer carries an ampersand that begins no entity reference");
      }
      const body = raw.slice(amp + 1, semicolon);
      const predefined = PREDEFINED_ENTITIES[body];
      if (predefined !== undefined) {
        out += predefined;
      } else if (/^#(x[0-9a-fA-F]{1,6}|[0-9]{1,7})$/.test(body)) {
        const code = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
          fail("The answer carries a character reference outside Unicode");
        }
        out += String.fromCodePoint(code);
      } else {
        fail(
          "The answer references an entity this reader will not resolve. Only the five XML " +
            "predefines and numeric character references are read",
        );
      }
      from = semicolon + 1;
    }
  };

  const readName = (): string => {
    const start = at;
    if (at >= text.length || !NAME_START.test(text[at]!)) fail("An element or attribute has no name");
    while (at < text.length && NAME_CHAR.test(text[at]!)) at += 1;
    return text.slice(start, at);
  };

  let elements = 0;

  const readElement = (depth: number): XmlElement => {
    elements += 1;
    if (elements > MAX_XML_ELEMENTS) fail("The answer holds more elements than this will read");
    if (depth > MAX_XML_DEPTH) fail("The answer nests deeper than this will read");

    at += 1; // "<"
    const qualified = readName();
    const attributes = new Map<string, string>();
    for (;;) {
      skipSpace();
      if (text.startsWith("/>", at)) {
        at += 2;
        return { name: localNameOf(qualified), attributes, children: [], text: "" };
      }
      if (text[at] === ">") {
        at += 1;
        break;
      }
      const attribute = readName();
      skipSpace();
      if (text[at] !== "=") fail("An attribute has no value");
      at += 1;
      skipSpace();
      const quote = text[at];
      if (quote !== '"' && quote !== "'") fail("An attribute value is not quoted");
      at += 1;
      const end = text.indexOf(quote, at);
      if (end === -1) fail("An attribute value is never closed");
      attributes.set(localNameOf(attribute), decodeEntities(text.slice(at, end)));
      at = end + 1;
    }

    const children: XmlElement[] = [];
    let own = "";
    for (;;) {
      if (at >= text.length) fail(`<${qualified}> is never closed`);
      if (text.startsWith("</", at)) {
        at += 2;
        const closing = readName();
        if (closing !== qualified) fail(`<${qualified}> is closed by </${closing}>`);
        skipSpace();
        if (text[at] !== ">") fail("A closing tag is malformed");
        at += 1;
        return { name: localNameOf(qualified), attributes, children, text: own };
      }
      if (text.startsWith("<![CDATA[", at)) {
        const end = text.indexOf("]]>", at + 9);
        if (end === -1) fail("A CDATA section is never closed");
        own += text.slice(at + 9, end);
        at = end + 3;
        continue;
      }
      if (text[at] === "<") {
        if (skipProlog()) continue;
        children.push(readElement(depth + 1));
        continue;
      }
      const next = text.indexOf("<", at);
      const chunk = next === -1 ? text.slice(at) : text.slice(at, next);
      own += decodeEntities(chunk);
      at = next === -1 ? text.length : next;
    }
  };

  skipSpace();
  while (at < text.length && text[at] === "<" && skipProlog()) skipSpace();
  if (at >= text.length || text[at] !== "<") {
    throw new DuResponseFormatError(
      "Desktop Underwriter's answer does not begin with an XML element. It was served as XML " +
        "and is not.",
    );
  }
  const root = readElement(1);
  skipSpace();
  while (at < text.length && text[at] === "<" && skipProlog()) skipSpace();
  if (at < text.length) fail("The answer carries content after its root element");
  return root;
}

/** Direct children with this local name. */
function childrenNamed(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

/** Every element with this local name, in document order, the root included. */
function descendantsNamed(root: XmlElement, name: string): XmlElement[] {
  const found: XmlElement[] = [];
  const walk = (element: XmlElement): void => {
    if (element.name === name) found.push(element);
    for (const child of element.children) walk(child);
  };
  walk(root);
  return found;
}
