/**
 * The provenance check: every number in a transcript or a note is one the
 * record held that day. It is the servicing app's conversation harness's
 * provenance check (apps/servicing/src/domain/borrower/eval/checks.ts) carried
 * over to calls: the harness reads cards and turns, this reads text.
 *
 * Numbers are read the way `format.ts` writes them: money ("$1,234.56", and
 * in notes "1234.56"), dates ("March 5th", "March 5th, 2027", "5 de marzo",
 * "03/05/27"), rates ("6.375 percent", "6.375 por ciento"), the servicer's
 * telephone number, the phone menu's keys, and bare counts. Markup in square
 * brackets and placeholders in angle quotes are not speech and are skipped.
 * A date said without its year matches a record date on the same month and
 * day. A month said with its year ("January 2030", "enero de 2030") is no
 * date: its year reads as a count.
 */

import { parts, type PlainDate } from "@hm/kernel/calendar";
import { MESES, MONTHS } from "./format.js";
import { pctKey, type FactNumbers } from "./record.js";
import type { NoiseOp, Transcript } from "./types.js";

export type NumberToken =
  | { readonly kind: "money"; readonly raw: string; readonly cents: string }
  | {
      readonly kind: "date";
      readonly raw: string;
      readonly m: number;
      readonly d: number;
      readonly y: number | null;
    }
  | { readonly kind: "pct"; readonly raw: string; readonly value: string }
  | { readonly kind: "phone"; readonly raw: string }
  | { readonly kind: "key"; readonly raw: string }
  | { readonly kind: "int"; readonly raw: string; readonly value: number };

const MONTH_RE = MONTHS.join("|");
const MES_RE = MESES.join("|");
const PATTERNS: readonly (readonly [
  NumberToken["kind"] | "markup" | "money_bare" | "date_es" | "date_num",
  RegExp,
])[] = [
  ["markup", /\[[^\]]*\]|‹[^›]*›/g],
  ["phone", /\b1-\d{3}-\d{3}-\d{4}\b/g],
  ["money", /\$\s?\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\$\s?\d+(?:\.\d{2})?/g],
  ["pct", /\b\d+(?:\.\d+)?\s?(?:%|percent|por ciento)/gi],
  // A day is one or two digits and no more: "January 2030" is a month and its year, not the 20th and a 30.
  [
    "date",
    new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:,\\s*(\\d{4}))?`, "gi"),
  ],
  ["date_es", new RegExp(`\\b(\\d{1,2}) de (${MES_RE})(?: de (\\d{4}))?`, "gi")],
  ["date_num", /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g],
  ["key", /\b(?:press|oprima)\s+\d\b/gi],
  ["money_bare", /\b\d{1,3}(?:,\d{3})+\.\d{2}\b|\b\d+\.\d{2}\b/g],
  ["int", /\b\d+(?:\.\d+)?\b/g],
];

const centsOf = (raw: string): string => {
  const x = raw.replace(/[$,\s]/g, "");
  const [w, f] = x.split(".");
  return (BigInt(w!) * 100n + BigInt((f ?? "0").padEnd(2, "0").slice(0, 2))).toString();
};

/** Every number in the text, in order, as the record would be searched for it. */
export function numberTokens(text: string): NumberToken[] {
  let work = text;
  const found: { at: number; t: NumberToken }[] = [];
  for (const [kind, re] of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    const spans: [number, number][] = [];
    while ((m = re.exec(work)) !== null) {
      const raw = m[0];
      spans.push([m.index, m.index + raw.length]);
      if (kind === "markup") continue;
      let t: NumberToken | null = null;
      if (kind === "money" || kind === "money_bare")
        t = { kind: "money", raw, cents: centsOf(raw) };
      else if (kind === "phone") t = { kind: "phone", raw };
      else if (kind === "key") t = { kind: "key", raw };
      else if (kind === "pct") t = { kind: "pct", raw, value: pctKey(raw.replace(/[^\d.]/g, "")) };
      else if (kind === "date") {
        const mi = MONTHS.findIndex((x) => x.toLowerCase() === m![1]!.toLowerCase());
        t = { kind: "date", raw, m: mi + 1, d: Number(m[2]), y: m[3] ? Number(m[3]) : null };
      } else if (kind === "date_es") {
        const mi = MESES.findIndex((x) => x === m![2]!.toLowerCase());
        t = { kind: "date", raw, m: mi + 1, d: Number(m[1]), y: m[3] ? Number(m[3]) : null };
      } else if (kind === "date_num") {
        const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
        t = { kind: "date", raw, m: Number(m[1]), d: Number(m[2]), y };
      } else t = { kind: "int", raw, value: Number(raw) };
      found.push({ at: m.index, t });
    }
    // Blank what this pattern took, so a later one never reads it twice.
    for (const [a, b] of spans) work = work.slice(0, a) + " ".repeat(b - a) + work.slice(b);
  }
  return found.sort((a, b) => a.at - b.at).map((x) => x.t);
}

/** Whether the record holds the token. */
export function inRecord(t: NumberToken, n: FactNumbers): boolean {
  switch (t.kind) {
    case "money":
      return n.money.has(t.cents);
    case "pct":
      return n.pcts.has(t.value);
    case "phone":
      return n.phones.has(t.raw);
    case "key":
      return true;
    case "int":
      return n.ints.has(t.value);
    case "date":
      for (const d of n.dates) {
        const p = parts(d as PlainDate);
        if (p.m === t.m && p.d === t.d && (t.y === null || t.y === p.y)) return true;
      }
      return false;
  }
}

/** The numbers in a text the record does not hold. */
export function unexplained(text: string, n: FactNumbers): NumberToken[] {
  return numberTokens(text).filter((t) => !inRecord(t, n));
}

const sameToken = (a: NumberToken, b: NumberToken): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === "money" && b.kind === "money") return a.cents === b.cents;
  if (a.kind === "date" && b.kind === "date")
    return a.m === b.m && a.d === b.d && (a.y === null || b.y === null || a.y === b.y);
  if (a.kind === "pct" && b.kind === "pct") return a.value === b.value;
  if (a.kind === "int" && b.kind === "int") return a.value === b.value;
  return a.raw === b.raw;
};

/**
 * A transcript's provenance: for each turn, the numbers said that the record
 * does not hold, and the numbers the recognizer wrote that are neither the
 * record's nor a mishearing it logged. `allowed` names the turns where a
 * planted figure is labeled.
 */
export function checkTranscript(
  t: Transcript,
  n: FactNumbers,
  allowed: ReadonlySet<number> = new Set(),
): { readonly turn: number; readonly where: "said" | "text"; readonly token: string }[] {
  const out: { turn: number; where: "said" | "text"; token: string }[] = [];
  t.turns.forEach((turn, i) => {
    if (allowed.has(i)) return;
    for (const tok of unexplained(turn.said, n))
      out.push({ turn: i, where: "said", token: tok.raw });
    const heard = turn.noise.flatMap((op: NoiseOp) =>
      op.kind === "misheard_number" ? numberTokens(op.heard) : [],
    );
    for (const tok of unexplained(turn.text, n))
      if (!heard.some((h) => sameToken(h, tok)))
        out.push({ turn: i, where: "text", token: tok.raw });
  });
  return out;
}
