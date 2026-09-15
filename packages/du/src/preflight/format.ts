/**
 * How a value is written, and how long it may be.
 *
 * **Nothing here compares two renderings for equality.** An earlier reading of
 * the width rules asked that the subject property's address be byte-identical
 * wherever it appears, and that assertion is unsatisfiable on legal input:
 * `AddressLineText` is fifty characters under the subject property and
 * thirty-five under an owned property, so a lawful forty-one character street
 * line is valid at one destination and too long at the other. The check is
 * per-destination, it reads the width out of the generated table, and it names
 * the XPath and the overrun — which is the failure the equality assertion was
 * reaching for and could not see.
 *
 * **A message never quotes the value.** Every one of these checks can fire on a
 * date of birth or an address, and a refusal is a string somebody pastes into a
 * ticket. So an overrun reports the count of characters and the maximum, a
 * malformed value reports the shape it was supposed to have, and neither
 * reports what was there.
 *
 * **Three destinations carry two widths and take the wider one.** The width is
 * keyed on the form field as well as the XPath, and at those three the casefile
 * does not say which form field a value came from: a borrower's address and a
 * loan originator's share one XPath at fifty and thirty-five characters. The
 * narrower bound would refuse a lawful borrower address to catch an over-long
 * originator one, so the wider is used and the narrower is unenforced rather
 * than wrongly enforced.
 */

import { DU_ENUMERATIONS } from "../generated/enums.js";
import { DU_FORMATS, type DuFormat } from "../generated/lengths.js";
import { DU_SUBSET_AT } from "./enumerations.js";
import type { Findings } from "./report.js";
import type { DuNode } from "../document.js";
import type { DuTree } from "./tree.js";

/** Every format declared at a destination, whatever form field it was filed under. */
const FORMATS_AT = new Map<string, DuFormat[]>();
for (const [key, format] of Object.entries(DU_FORMATS)) {
  if (format === null) continue;
  const destination = key.slice(0, key.lastIndexOf("#"));
  const held = FORMATS_AT.get(destination);
  if (held) held.push(format);
  else FORMATS_AT.set(destination, [format]);
}

/**
 * The widest declaration at a destination, and the shape they all agree on.
 *
 * The kinds never disagree within a destination; only the widths do, and the
 * generator would have to stop naming form fields for that to change.
 */
function formatAt(destination: string): DuFormat | null {
  const declared = FORMATS_AT.get(destination);
  if (!declared || declared.length === 0) return null;
  const widest = declared.reduce((one, other) =>
    (other.maxLength ?? 0) > (one.maxLength ?? 0) ? other : one,
  );
  return {
    kind: widest.kind,
    ...(widest.maxLength === undefined ? {} : { maxLength: widest.maxLength }),
    ...(widest.digits === undefined ? {} : { digits: widest.digits }),
    ...(widest.decimals === undefined ? {} : { decimals: widest.decimals }),
  };
}

/**
 * A postal code is five digits or nine, and never carries the dash.
 *
 * Keyed on the data point rather than on the format, because the specification
 * types it as a nine-character string: a ZIP+4 written the way a person writes
 * it is ten characters and would fail the width, and a five-digit code with a
 * trailing dash would pass it.
 */
const POSTAL_CODE = /^(\d{5}|\d{9})$/;

const SHAPES: Readonly<Record<string, RegExp>> = {
  boolean: /^(true|false)$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  datetime: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
  year: /^\d{4}$/,
};

const SAYS: Readonly<Record<string, string>> = {
  boolean: "the word true or the word false, in lower case",
  date: "a date written CCYY-MM-DD",
  datetime: "a moment written CCYY-MM-DDThh:mm:ssZ",
  year: "a four-digit year",
};

/**
 * True when the digits name a day that exists.
 *
 * `Date.parse` is not the test it looks like, and this is the one place that
 * matters: an out-of-range day rolls forward, so `1980-02-31` parses to the
 * second of March and comes back a number rather than NaN. Only a month past
 * twelve or a day past thirty-one is rejected that way, and both of those are
 * already at the edge of what the shape admits. The date is therefore built and
 * read back: a value that does not survive the round trip is a day nobody had,
 * and it is one the schema refuses while nothing in this pipeline runs the
 * schema.
 *
 * `setUTCFullYear` rather than `Date.UTC`, because `Date.UTC` maps a year under
 * a hundred into the nineteen hundreds and would report `0080-01-01` as a date
 * that is not a day.
 */
function isADay(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const built = new Date(0);
  built.setUTCFullYear(year, month - 1, day);
  return (
    built.getUTCFullYear() === year &&
    built.getUTCMonth() + 1 === month &&
    built.getUTCDate() === day
  );
}

function digitsBefore(value: string): number {
  const magnitude = value.startsWith("-") ? value.slice(1) : value;
  const point = magnitude.indexOf(".");
  return (point === -1 ? magnitude : magnitude.slice(0, point)).length;
}

function checkValue(
  destination: string,
  name: string,
  value: string,
  format: DuFormat,
  findings: Findings,
): void {
  const where = `${destination}#${name}`;

  if (format.maxLength !== undefined && value.length > format.maxLength) {
    findings.add(
      "value-too-long",
      where,
      `${value.length} characters at a destination that takes ${format.maxLength}, which is ` +
        `${value.length - format.maxLength} too many.`,
    );
  }

  const shape = SHAPES[format.kind];
  if (shape && !shape.test(value)) {
    findings.add("value-malformed", where, `Not ${SAYS[format.kind]}.`);
    return;
  }

  if (format.kind === "date" && !isADay(value)) {
    findings.add("value-malformed", where, "A date written CCYY-MM-DD that is not a day.");
    return;
  }

  if (format.kind === "amount") {
    const decimals = format.decimals ?? 2;
    if (!new RegExp(`^-?\\d+\\.\\d{${decimals}}$`).test(value)) {
      findings.add(
        "value-malformed",
        where,
        `Not an amount written with exactly ${decimals} decimal places and no thousands ` +
          "separator.",
      );
      return;
    }
  }

  if (format.kind === "percent" && !/^-?\d+\.\d+$/.test(value)) {
    findings.add("value-malformed", where, "Not a rate written as a decimal.");
    return;
  }

  if ((format.kind === "numeric" || format.kind === "code") && !/^\d+$/.test(value)) {
    findings.add("value-malformed", where, "Not a whole number written in digits.");
    return;
  }

  if (format.digits !== undefined && digitsBefore(value) > format.digits) {
    findings.add(
      "value-malformed",
      where,
      `${digitsBefore(value)} digits before the decimal point at a destination that takes ` +
        `${format.digits}.`,
    );
  }

  if (name === "PostalCode" && !POSTAL_CODE.test(value)) {
    findings.add(
      "value-malformed",
      where,
      "Not a postal code written as five digits or nine, with no dash.",
    );
  }

  const enumeration = DU_SUBSET_AT[where];
  if (enumeration !== undefined && !DU_ENUMERATIONS[enumeration]!.includes(value)) {
    findings.add(
      "value-malformed",
      where,
      "Not one of the values Desktop Underwriter supports at this destination. The schema " +
        "admits more of them than Desktop Underwriter does, so this is a rejection nothing " +
        "downstream would catch.",
    );
  }
}

export function checkFormat(tree: DuTree, findings: Findings): void {
  for (const instance of tree.instances) {
    for (const child of instance.node.children ?? []) {
      const value = child.value;
      if (value === undefined || value === "") continue;
      const format = formatAt(`${instance.path}#${child.name}`);
      if (format === null) continue;
      checkValue(instance.path, child.name, value, format, findings);
    }
    checkAttributes(instance.node, instance.path, findings);
  }
}

/**
 * The attributes that are data points too.
 *
 * `SequenceNumber` and `MISMOReferenceModelIdentifier` are rows in the same
 * table as every element, and the specification gives them widths; the `xlink`
 * attributes are the graph and are checked as the graph.
 */
function checkAttributes(node: DuNode, path: string, findings: Findings): void {
  for (const [name, value] of Object.entries(node.attributes ?? {})) {
    if (name.startsWith("xlink:") || name.startsWith("xsi:") || name.startsWith("xmlns")) continue;
    if (value === "") continue;
    const format = formatAt(`${path}#${name}`);
    if (format === null) continue;
    checkValue(path, name, value, format, findings);
  }
}
