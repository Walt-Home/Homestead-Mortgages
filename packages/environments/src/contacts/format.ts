/**
 * How numbers are written in the contact center's text. A speech recognizer
 * writes digits, so every figure in a transcript is digits: money as
 * "$1,234.56", a date as "March 5th" or "March 5th, 2027", a count as "2".
 * Notes write money as "$1234.56" or "1,234.56" and dates as "03/05/27".
 * Spanish dates are "5 de marzo". `check.ts` reads every one of these back.
 */

import { parts, type PlainDate } from "@hm/kernel/calendar";
import type { Cents } from "@hm/kernel/money";

export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
export const MESES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** "$1,234.56". */
export function money(c: Cents): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  const s = `$${group((a / 100n).toString())}.${(a % 100n).toString().padStart(2, "0")}`;
  return neg ? `-${s}` : s;
}

/** A note's money: "$1234.56", "1,234.56" or "$1,234.56", by the writer's habit. */
export function noteMoney(c: Cents, style: 0 | 1 | 2): string {
  const a = c < 0n ? -c : c;
  const whole = (a / 100n).toString();
  const frac = (a % 100n).toString().padStart(2, "0");
  if (style === 0) return `$${whole}.${frac}`;
  if (style === 1) return `${group(whole)}.${frac}`;
  return `$${group(whole)}.${frac}`;
}

export function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`;
}

/** "March 5th", or "March 5th, 2027" with the year. */
export function spokenDate(d: PlainDate, withYear = false): string {
  const p = parts(d);
  return `${MONTHS[p.m - 1]} ${ordinal(p.d)}${withYear ? `, ${p.y}` : ""}`;
}

/** "5 de marzo", or "5 de marzo de 2027". */
export function fecha(d: PlainDate, withYear = false): string {
  const p = parts(d);
  return `${p.d} de ${MESES[p.m - 1]}${withYear ? ` de ${p.y}` : ""}`;
}

/** A note's date: "03/05/27", "3/5/27" or "03/05/2027", by the writer's habit. */
export function noteDate(d: PlainDate, style: 0 | 1 | 2): string {
  const p = parts(d);
  const yy = String(p.y % 100).padStart(2, "0");
  if (style === 0) return `${String(p.m).padStart(2, "0")}/${String(p.d).padStart(2, "0")}/${yy}`;
  if (style === 1) return `${p.m}/${p.d}/${yy}`;
  return `${String(p.m).padStart(2, "0")}/${String(p.d).padStart(2, "0")}/${p.y}`;
}

export const monthName = (d: PlainDate): string => MONTHS[parts(d).m - 1]!;

/** A rate as said: "6.375 percent", without trailing zeros past the eighth. */
export function pct(p: string): string {
  const n = Number(p);
  return `${Number.isInteger(n) ? n.toFixed(0) : String(Number(n.toFixed(3)))} percent`;
}

/** A rate as an interpreter says it: "6.375 por ciento". */
export function pctEs(p: string): string {
  return pct(p).replace(" percent", " por ciento");
}

/** "00:04:17", for markup in a rendered transcript. */
export function clock(s: number): string {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const x = t % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}`;
}
