/**
 * Speech recognition, as a contact center's recorder does it: what was said
 * becomes text with the mistakes such text has. Every departure is logged on
 * the turn (`NoiseOp`), so a reader can tell a figure the recognizer misheard
 * from one the agent misquoted, which only a label says.
 *
 *   - personal data redacted: taxpayer digits, dates of birth, the full loan
 *     number, bank and contact details become `[REDACTED]`, and now and then
 *     a dollar amount is redacted too, as redaction engines over-reach;
 *   - numbers misheard: a digit of an amount, a teen for a ty ("fifteen",
 *     "fifty"), the thirteenth for the thirtieth;
 *   - words misheard (a confusion list of the trade's words), dropped, or lost
 *     to `[inaudible]`;
 *   - fillers kept or dropped; one engine writes cased, punctuated text and
 *     the other lower case without punctuation.
 *
 * Swapped speakers and crosstalk are the transcript's (transcript.ts), since
 * they are about turns and not words. Every rate is a design choice; no
 * public source gives a servicer's recognizer's error rates.
 */

import type { Rng } from "../rng.js";
import { numberTokens } from "./check.js";
import { MESES, MONTHS } from "./format.js";
import type { NoiseOp } from "./types.js";

const MISHEAR_NUMBER = 0.035;
const OVER_REDACT_MONEY = 0.012;
const MISHEAR_WORD = 0.02;
const DROP_WORD = 0.012;
const INAUDIBLE = 0.005;
const DROP_FILLER = 0.5;

/** Words a recognizer gets wrong on servicing calls, and what it writes instead. */
const CONFUSIONS: Readonly<Record<string, readonly string[]>> = {
  escrow: ["S crow", "escrows", "ask row"],
  principal: ["principle"],
  forbearance: ["for bearance", "forbearing"],
  mortgage: ["mortgaged", "more gauge"],
  insurance: ["in surance", "assurance"],
  county: ["count he", "country"],
  verify: ["very fi", "verified"],
  payoff: ["pay off", "paid off"],
  shortage: ["short age", "shortened"],
  surplus: ["sir plus"],
  interest: ["in trust", "interests"],
  declarations: ["declaration"],
  servicer: ["service her", "servicers"],
  Supermortgage: ["super mortgage", "Super Mortgage", "supra mortgage"],
  delinquent: ["delinquents"],
  modification: ["notification"],
  bankruptcy: ["bank ruptcy"],
  late: ["latest"],
  waive: ["wave"],
  lien: ["lean", "lane"],
  premium: ["premiums"],
  analysis: ["analyses"],
  hold: ["old"],
  social: ["special"],
  autopay: ["auto pay", "auto-pay"],
};
const FILLERS = new Set(["um,", "uh,", "um", "uh", "like,", "you know,"]);
const DATE_WORD = new RegExp(`^(${[...MONTHS, ...MESES].join("|")})$`, "i");
const TEENS: Readonly<Record<string, string>> = {
  "13": "30",
  "14": "40",
  "15": "50",
  "16": "60",
  "17": "70",
  "18": "80",
  "19": "90",
  "30": "13",
  "40": "14",
  "50": "15",
  "60": "16",
  "70": "17",
  "80": "18",
  "90": "19",
};

/** A misheard amount: one digit off, never the first, so the amount still reads like one. */
function mishearMoney(r: Rng, raw: string): string {
  const idx = [...raw].map((c, i) => (/\d/.test(c) ? i : -1)).filter((i) => i > 0);
  const digits = idx.slice(1);
  if (!digits.length) return raw;
  const i = r.pick(digits);
  const d = Number(raw[i]);
  const nd = r.chance(0.5) ? (d + 1) % 10 : (d + 9) % 10;
  return raw.slice(0, i) + String(nd) + raw.slice(i + 1);
}

export interface Recognized {
  readonly text: string;
  readonly noise: NoiseOp[];
}

export function recognize(
  r: Rng,
  said: string,
  pii: readonly string[],
  lower: boolean,
): Recognized {
  const noise: NoiseOp[] = [];
  let text = said;
  // Personal data first: the recorder redacts before anything else touches the words.
  for (const p of [...pii].sort((a, b) => b.length - a.length)) {
    if (!p || !text.includes(p)) continue;
    text = text.split(p).join("[REDACTED]");
    noise.push({ kind: "redacted", said: p, pii: true });
  }
  text = text.replace(/‹[^›]*›/g, (m) => {
    noise.push({ kind: "redacted", said: m, pii: true });
    return "[REDACTED]";
  });
  // Numbers: a few are misheard, and an amount is now and then redacted though it is no one's personal data.
  const toks = numberTokens(text);
  for (const t of toks) {
    const u = r.next();
    const v = r.next();
    if (t.kind === "money" && u < OVER_REDACT_MONEY) {
      text = text.replace(t.raw, "[REDACTED]");
      noise.push({ kind: "redacted", said: t.raw, pii: false });
      continue;
    }
    if (u >= OVER_REDACT_MONEY + MISHEAR_NUMBER) continue;
    let heard: string | null = null;
    if (t.kind === "money") heard = mishearMoney(r, t.raw);
    else if (t.kind === "int" && TEENS[t.raw]) heard = TEENS[t.raw]!;
    else if (t.kind === "date" && /\b13th\b/.test(t.raw)) heard = t.raw.replace("13th", "30th");
    else if (t.kind === "date" && /\b30th\b/.test(t.raw) && v < 0.5)
      heard = t.raw.replace("30th", "13th");
    if (heard && heard !== t.raw) {
      text = text.replace(t.raw, heard);
      noise.push({ kind: "misheard_number", said: t.raw, heard });
    }
  }
  // Words.
  const words = text.split(" ");
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const u = r.next();
    const core = w.replace(/[.,?!;:]+$/, "");
    const tail = w.slice(core.length);
    // A figure, markup, the words that make a date of a number ("March", "de"), and the phone menu's
    // "press" before its key are written as said: a misheard figure is logged above, not made here.
    const nearDigit = [i - 2, i - 1, i + 1].some((k) => /\d/.test(words[k] ?? ""));
    if (
      /\d|\[|\]|\$/.test(w) ||
      /^(press|oprima)$/i.test(core) ||
      (nearDigit && (DATE_WORD.test(core) || core.length <= 3))
    ) {
      out.push(w);
      continue;
    }
    if (FILLERS.has(w.toLowerCase()) && u < DROP_FILLER) {
      noise.push({ kind: "dropped_word", said: w });
      continue;
    }
    const conf = CONFUSIONS[core] ?? CONFUSIONS[core.toLowerCase()];
    if (conf && u < MISHEAR_WORD * 4) {
      const heard = r.pick(conf);
      out.push(heard + tail);
      noise.push({ kind: "misheard_word", said: core, heard });
      continue;
    }
    if (core.length > 2 && u < DROP_WORD) {
      noise.push({ kind: "dropped_word", said: core });
      continue;
    }
    if (u > 1 - INAUDIBLE) {
      out.push("[inaudible]");
      noise.push({ kind: "inaudible", said: w });
      continue;
    }
    out.push(w);
  }
  text = out.join(" ");
  if (lower) {
    // The lower-case engine keeps the punctuation inside numbers and drops the rest.
    text = text
      .replace(/([^\d\s])[.,?!;:](?=\s|$)/g, "$1")
      .replace(/^[.,?!;:]+|[.,?!;:]+$/g, "")
      .replace(/\[REDACTED\]/g, "<<R>>")
      .replace(/\[inaudible\]/g, "<<I>>")
      .toLowerCase()
      .replace(/<<r>>/g, "[REDACTED]")
      .replace(/<<i>>/g, "[inaudible]");
  }
  return { text: text.replace(/\s+/g, " ").trim(), noise };
}
