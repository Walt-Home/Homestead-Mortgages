/**
 * A partner's book: the tape and its supplement become records in the one
 * shape a servicer's file may enter the product in.
 *
 * Three stages, all pure:
 *
 *   parseBook      the profile maps; nothing is refused for being missing.
 *                  Header presence gates the whole file (`rejected` when a
 *                  required header is absent); a row is skipped only for no
 *                  loan number, no state or no readable balance and rate; a
 *                  loan number seen twice is a `duplicate_row`; the supplement
 *                  joins on the loan number, and a row without one carries a
 *                  gap rather than a refusal.
 *   deriveRecord   one parsed row → an `ImportedLoanRecord` from
 *                  `@hm/shared/portfolio`, or a rejection naming why. The
 *                  contract is strict at every level, so what a tape carries
 *                  that the product must not hold has nowhere to land here.
 *   readBook       both, over the bytes of the two files.
 *
 * What is deliberately NOT here, against Doug's §33.1, and why:
 *
 * - **No contact.** His supplement carries each borrower's e-mail and phone,
 *   and his import provisions an account and sends an invitation to that
 *   address. Ours takes the supplement's date of birth and name and ignores
 *   its e-mail, phone and tax-id columns by name, reporting that it did. The
 *   claim here is a signed token the partner delivers, never an e-mail match
 *   (`docs/states.md`), and the feed contract has no field for an address on
 *   purpose. A column the contract cannot hold is a column that never enters.
 * - **No linking to an existing party.** His rule 3 links a tape row to a
 *   party already on the platform when the e-mail and the name agree. A loan
 *   attached to a claimed party by an e-mail match would appear in that
 *   person's account without a claim, which is the oracle the 404 rule exists
 *   to suppress. Every row here becomes its own provisional party; the claim
 *   flow merges later.
 * - **No investor economics.** Retained rate, net rate, remittance type and
 *   the reconciled cash flows are the partner's business with its investor
 *   and never leave the profile.
 */

import { createHash } from "node:crypto";
import { daysBetween, plainDate } from "@hm/kernel/calendar";
import {
  ImportedLoanRecordSchema,
  type ImportedLoanRecord,
  type ImportedName,
} from "@hm/shared/portfolio";
import {
  mapTapeRow,
  normalizeHeader,
  profileHeadersPresent,
  type Fact,
  type RowException,
  type TapeProfile,
} from "./m3-v1.js";
import { readTabular, type ParsedFile } from "./tabular.js";

export const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

// ── the supplement ────────────────────────────────────────────────────────

export type SupplementRow = {
  /** 1-based data row of the supplement. */
  readonly row: number;
  readonly servicer_loan_number: string;
  /** The supplement's borrower_name when the column is present. */
  readonly name: string | null;
  /** ISO, when the column is present and the cell reads. */
  readonly date_of_birth: string | null;
};

const normKey = (h: string): string =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const SUPPLEMENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  servicer_loan_number: [
    "servicer_loan_number",
    "loan_number",
    "servicer_loan_no",
    "loan_no",
    "loan_id",
  ],
  borrower_name: ["borrower_name", "name", "borrower"],
  date_of_birth: ["date_of_birth", "dob", "birth_date"],
};

/**
 * Columns a supplement may carry that the product has no place for. They are
 * recognized by name so the report can say they were there and ignored,
 * rather than leaving a partner to wonder why nobody was invited.
 */
const IGNORED_SUPPLEMENT_KEYS: readonly string[] = [
  "borrower_email",
  "email",
  "e_mail",
  "email_address",
  "borrower_phone",
  "phone",
  "mobile",
  "cell",
  "phone_number",
  "mobile_phone",
  "tin_last4",
  "ssn_last4",
  "ssn_last_4",
  "last4",
  "ssn",
  "tin",
];

export type ParsedSupplement = {
  readonly rows: SupplementRow[];
  /** The supplement's own header text for each column ignored by name. */
  readonly ignored_columns: string[];
};

export function parseSupplement(file: ParsedFile): ParsedSupplement {
  const keys = file.headers.map(normKey);
  const col = (want: string): number => {
    for (const k of SUPPLEMENT_KEYS[want] ?? [want]) {
      const i = keys.indexOf(k);
      if (i >= 0) return i;
    }
    return -1;
  };
  const idx = {
    loan: col("servicer_loan_number"),
    name: col("borrower_name"),
    dob: col("date_of_birth"),
  };
  if (idx.loan < 0) throw new RangeError("the supplement needs a servicer_loan_number column");
  const ignored_columns = file.headers.filter((h) => IGNORED_SUPPLEMENT_KEYS.includes(normKey(h)));
  const cell = (r: string[], i: number): string => (i >= 0 ? (r[i] ?? "").trim() : "");
  const rows = file.rows
    .map((r, k) => {
      const dob = cell(r, idx.dob);
      return {
        row: k + 1,
        servicer_loan_number: cell(r, idx.loan),
        name: idx.name >= 0 ? cell(r, idx.name) || null : null,
        date_of_birth: /^\d{4}-\d{2}-\d{2}$/.test(dob) ? dob : null,
      };
    })
    .filter((s) => s.servicer_loan_number !== "");
  return { rows, ignored_columns };
}

// ── the book ──────────────────────────────────────────────────────────────

/** What the partner's file does not carry for a row. Never a refusal. */
export type GapKind = "dob" | "mailing_address" | "coborrower";
export type GapCounts = Record<GapKind, number>;
export const emptyGaps = (): GapCounts => ({ dob: 0, mailing_address: 0, coborrower: 0 });

export type ParsedRow = {
  /** 1-based data row of the tape. */
  readonly row: number;
  readonly servicer_loan_number: string;
  readonly facts: Record<string, Fact>;
  readonly raw: Record<string, string>;
  readonly exceptions: RowException[];
  readonly supplement: SupplementRow | null;
  readonly gaps: GapKind[];
};

export type ParsedBook = {
  readonly profile: string;
  readonly rejected: { readonly missing_headers: string[] } | null;
  readonly rows_total: number;
  /** The loadable rows, in tape order. */
  readonly rows: ParsedRow[];
  /** Every exception of every row, plus supplement orphans and duplicates. */
  readonly exceptions: RowException[];
  readonly supplement: { readonly rows: number; readonly ignored_columns: string[] };
};

export function parseBook(
  profile: TapeProfile,
  tape: ParsedFile,
  supplement: ParsedFile | null,
): ParsedBook {
  const present = profileHeadersPresent(profile, tape.headers);
  if (!present.ok) {
    return {
      profile: profile.id,
      rejected: { missing_headers: present.missing },
      rows_total: tape.rows.length,
      rows: [],
      exceptions: [],
      supplement: { rows: supplement?.rows.length ?? 0, ignored_columns: [] },
    };
  }
  const supp = supplement ? parseSupplement(supplement) : { rows: [], ignored_columns: [] };
  const suppByLoan = new Map<string, SupplementRow>();
  for (const s of supp.rows) {
    if (!suppByLoan.has(s.servicer_loan_number)) suppByLoan.set(s.servicer_loan_number, s);
  }
  const exceptions: RowException[] = [];
  const rows: ParsedRow[] = [];
  const seen = new Set<string>();
  tape.rows.forEach((r, k) => {
    const rowNo = k + 1;
    const m = mapTapeRow(profile, tape.headers, r, rowNo);
    exceptions.push(...m.exceptions);
    if (m.skip) return;
    const loanNo = String(m.facts[profile.loanNumber]).trim();
    if (seen.has(loanNo)) {
      exceptions.push({ row: rowNo, servicer_loan_number: loanNo, code: "duplicate_row" });
      return;
    }
    seen.add(loanNo);
    const s = suppByLoan.get(loanNo) ?? null;
    const gaps: GapKind[] = [];
    if (!s?.date_of_birth) gaps.push("dob");
    // The m3 layout carries the property address only and the primary
    // borrower only.
    gaps.push("mailing_address", "coborrower");
    rows.push({
      row: rowNo,
      servicer_loan_number: loanNo,
      facts: m.facts,
      raw: m.raw,
      exceptions: m.exceptions,
      supplement: s,
      gaps,
    });
  });
  for (const s of supp.rows) {
    if (!seen.has(s.servicer_loan_number)) {
      exceptions.push({
        row: s.row,
        servicer_loan_number: s.servicer_loan_number,
        code: "supplement_orphan",
        column: "servicer_loan_number",
      });
    }
  }
  return {
    profile: profile.id,
    rejected: null,
    rows_total: tape.rows.length,
    rows,
    exceptions,
    supplement: { rows: supp.rows.length, ignored_columns: supp.ignored_columns },
  };
}

// ── names ─────────────────────────────────────────────────────────────────

const SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"]);

/**
 * "Maria Garcia" → given Maria, surname Garcia. "GARCIA, MARIA J" → surname
 * Garcia, given Maria, middle J. Three or more words without a comma: the
 * first is given, the last is the surname, the rest are middle. A suffix is
 * dropped. One word, or none, is the case the contract says not to guess at:
 * it comes back null and the row is rejected as `name_unsplit`.
 */
export function splitName(name: string): ImportedName | null {
  const strip = (s: string) =>
    s
      .trim()
      .split(/\s+/)
      .filter((w) => w && !SUFFIXES.has(w.toLowerCase()));
  const comma = name.indexOf(",");
  if (comma >= 0) {
    const surname = strip(name.slice(0, comma)).join(" ");
    const rest = strip(name.slice(comma + 1));
    if (!surname || rest.length === 0) return null;
    return { given: rest[0]!, middle: rest.length > 1 ? rest.slice(1).join(" ") : null, surname };
  }
  const words = strip(name);
  if (words.length < 2) return null;
  return {
    given: words[0]!,
    middle: words.length > 2 ? words.slice(1, -1).join(" ") : null,
    surname: words[words.length - 1]!,
  };
}

// ── the derivation onto the contract ──────────────────────────────────────

const s = (v: Fact | undefined): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;
const n = (v: Fact | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const money = (v: Fact | undefined): bigint | null =>
  typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : null;
const b = (v: Fact | undefined): boolean | null => (typeof v === "boolean" ? v : null);

type Terms = ImportedLoanRecord["terms"];
type Servicing = ImportedLoanRecord["servicing"];

/** The tape's occupancy text → the contract's word, else null: the feed did not say. */
export function occupancyOf(text: string | null): Terms["occupancy"] {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/^[op]$/.test(t) || /owner|primary|principal|occupied/.test(t)) return "primary_residence";
  if (t === "s" || /second|vacation/.test(t)) return "second_home";
  if (t === "i" || /invest|rental|tenant|non[- ]?owner/.test(t)) return "investment";
  return null;
}

export function lienOf(text: string | null): Terms["lienPosition"] {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/^(1|1st|first)$/.test(t)) return "first";
  if (/^(2|2nd|second)$/.test(t)) return "second";
  if (/heloc/.test(t)) return "subordinate_heloc";
  return null;
}

/** "Conventional" | "FHA" | "VA" | "USDA" | "Jumbo" → the program; anything else is null, never a guess. */
export function programOf(text: string | null): Terms["program"] {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/fha/.test(t)) return "fha";
  if (/\bva\b/.test(t)) return "va";
  if (/usda|rural/.test(t)) return "usda";
  if (/jumbo/.test(t)) return "jumbo";
  if (/conv/.test(t)) return "conventional";
  return null;
}

/**
 * The GMC purpose code: "P" is a purchase. "R" is a refinance, and the tape
 * does not say whether cash came out, so it is null rather than one of the
 * two — the axis may not be answered with a guess.
 */
export function objectiveOf(code: string | null): Terms["objective"] {
  const t = (code ?? "").trim().toUpperCase();
  return t === "P" ? "purchase" : null;
}

function isArm(facts: Record<string, Fact>): boolean {
  const index = s(facts["arm_index"]);
  return (
    (!!index && !/^(none|n\/a|na|fixed|no)$/i.test(index)) ||
    (n(facts["arm_fixed_period_months"]) ?? 0) > 0 ||
    /\barm\b|adjustable/i.test(s(facts["loan_type"]) ?? "")
  );
}

/**
 * The tape's servicing status, reduced to the contract's. The MBA
 * delinquency status decides when it is there — "C" is current, a number of
 * days is that many days behind, "FC" is a foreclosure referral and therefore
 * behind, "BK" says nothing about payments — and the next due date against
 * the as-of date decides otherwise.
 */
export function servicingStatusOf(
  facts: Record<string, Fact>,
  asOf: string,
): { status: Servicing["status"]; delinquencyDays: number | null } {
  const text = (s(facts["servicing_status"]) ?? "").toLowerCase();
  if (/paid[\s_-]?(off|in[\s_-]?full)|payoff|liquidat/.test(text)) {
    return { status: "paid_off", delinquencyDays: null };
  }
  if (/charge[\s_-]?off|charged/.test(text))
    return { status: "charged_off", delinquencyDays: null };
  if (/transfer|service[\s_-]?released|sold/.test(text)) {
    return { status: "transferred", delinquencyDays: null };
  }
  const maturity = s(facts["maturity_date"]);
  const upb = money(facts["upb_cents"]);
  if (maturity && maturity <= asOf && upb === 0n)
    return { status: "matured", delinquencyDays: null };
  const mba = (s(facts["mba_delinquency_status"]) ?? "").toUpperCase();
  if (mba === "C") return { status: "current", delinquencyDays: 0 };
  if (/^\d+$/.test(mba)) return { status: "delinquent", delinquencyDays: Number(mba) };
  if (mba === "FC") return { status: "delinquent", delinquencyDays: null };
  const nextDue = s(facts["next_due_date"]);
  if (nextDue && nextDue < asOf) {
    return {
      status: "delinquent",
      delinquencyDays: daysBetween(plainDate(nextDue), plainDate(asOf)),
    };
  }
  return { status: "current", delinquencyDays: nextDue ? 0 : null };
}

export type Derived =
  | {
      readonly record: ImportedLoanRecord;
      readonly facts: Record<string, Fact>;
      readonly rejected?: undefined;
    }
  | { readonly record?: undefined; readonly facts?: undefined; readonly rejected: RowException };

/**
 * One parsed row onto the contract, or a rejection saying which column made
 * it impossible. The record is parsed through the schema on the way out, so
 * a derivation that drifted from the contract fails here and never reaches
 * a database.
 */
export function deriveRecord(row: ParsedRow, servicerSlug: string, asOfDefault: string): Derived {
  const f = row.facts;
  const reject = (code: RowException["code"], column?: string): Derived => ({
    rejected: {
      row: row.row,
      servicer_loan_number: row.servicer_loan_number,
      code,
      ...(column ? { column } : {}),
    },
  });

  // The supplement's spelling first, when it carries one and it splits; the
  // tape's otherwise. Only when neither does is the row refused.
  const tapeName = s(f["borrower_name"]);
  const legalName =
    (row.supplement?.name ? splitName(row.supplement.name) : null) ??
    (tapeName ? splitName(tapeName) : null);
  if (!legalName) return reject("name_unsplit", "Name Borrower Primary");

  const line1 = s(f["property_address"]);
  const city = s(f["property_city"]);
  const state = s(f["property_state"]);
  const postalCode = s(f["property_zip"]);
  if (!line1 || !city || !state || !postalCode)
    return reject("no_property_address", "Property Address");

  const termMonths = n(f["original_term_months"]);
  if (!termMonths || termMonths <= 0) return reject("no_term", "Term");

  const upb = money(f["upb_cents"]);
  const rate = s(f["note_rate_pct"]);
  // The row gate already refused a row without these; the types do not know.
  if (upb === null || rate === null) return reject("no_balance_or_rate");
  const originalRaw = money(f["original_upb_cents"]);
  const originalPrincipalCents = originalRaw !== null && originalRaw > 0n ? originalRaw : upb;

  const asOf = s(f["as_of_date"]) ?? asOfDefault;
  const { status, delinquencyDays } = servicingStatusOf(f, asOf);
  const pi = money(f["pi_cents"]);
  const ti = money(f["ti_cents"]) ?? 0n;

  const record: ImportedLoanRecord = {
    sourceLoanKey: row.servicer_loan_number,
    servicerSlug,
    parties: [
      {
        sourcePartyKey: `${row.servicer_loan_number}-1`,
        role: "PRIMARY_BORROWER",
        legalName,
        dateOfBirth: row.supplement?.date_of_birth ?? null,
        mailingAddress: null,
      },
    ],
    property: {
      line1,
      line2: null,
      city,
      state: state.toUpperCase().slice(0, 2),
      postalCode: postalCode.slice(0, 10),
      apn: null,
    },
    terms: {
      objective: objectiveOf(s(f["gmc_purpose_code"])),
      program: programOf(s(f["loan_type"])),
      lienPosition: lienOf(s(f["lien_position"])),
      occupancy: occupancyOf(
        s(f["occupancy"]) ?? s(f["occupancy_current"]) ?? s(f["original_occupancy_code"]),
      ),
      rateType: isArm(f) || b(f["interest_only"]) === true ? "arm" : "fixed",
      originalPrincipalCents,
      noteRatePct: s(f["original_note_rate_pct"]) ?? rate,
      termMonths,
      originatedOn: s(f["origination_date"]),
      firstPaymentOn: s(f["first_payment_date"]),
      maturityOn: s(f["maturity_date"]),
    },
    servicing: {
      asOf: `${asOf}T00:00:00.000Z`,
      status,
      principalBalanceCents: upb,
      escrowBalanceCents: money(f["escrow_balance_cents"]),
      scheduledPaymentCents: pi === null ? null : pi + ti,
      currentRatePct: rate,
      nextPaymentDueOn: s(f["next_due_date"]),
      delinquencyDays,
    },
  };
  const parsed = ImportedLoanRecordSchema.safeParse(record);
  if (!parsed.success) {
    const column = parsed.error.issues[0]?.path.join(".");
    return reject("implausible_value", column);
  }
  return { record: parsed.data, facts: f };
}

// ── both stages over bytes ────────────────────────────────────────────────

export type BookFile = { readonly filename: string; readonly bytes: Uint8Array };

export type ReadBook = {
  readonly profile: string;
  readonly tape_sha256: string;
  /** Empty when there was no supplement, so two absent supplements compare equal. */
  readonly supplement_sha256: string;
  readonly rejected: { readonly missing_headers: string[] } | null;
  readonly rows_total: number;
  readonly records: {
    readonly row: ParsedRow;
    readonly record: ImportedLoanRecord;
    readonly facts: Record<string, Fact>;
  }[];
  readonly exceptions: RowException[];
  readonly gaps: GapCounts;
  readonly supplement: { readonly rows: number; readonly ignored_columns: string[] };
};

export function readBook(
  profile: TapeProfile,
  servicerSlug: string,
  asOfDefault: string,
  tape: BookFile,
  supplement: BookFile | null,
): ReadBook {
  const parsedTape = readTabular(tape.filename, tape.bytes);
  const parsedSupp = supplement ? readTabular(supplement.filename, supplement.bytes) : null;
  const book = parseBook(profile, parsedTape, parsedSupp);
  const base = {
    profile: book.profile,
    tape_sha256: sha256Hex(tape.bytes),
    supplement_sha256: supplement ? sha256Hex(supplement.bytes) : "",
    rows_total: book.rows_total,
    supplement: book.supplement,
  };
  if (book.rejected) {
    return { ...base, rejected: book.rejected, records: [], exceptions: [], gaps: emptyGaps() };
  }
  const records: ReadBook["records"] = [];
  const exceptions = [...book.exceptions];
  const gaps = emptyGaps();
  for (const row of book.rows) {
    const d = deriveRecord(row, servicerSlug, asOfDefault);
    if (d.rejected) {
      exceptions.push(d.rejected);
      continue;
    }
    for (const g of row.gaps) gaps[g] += 1;
    records.push({ row, record: d.record, facts: d.facts });
  }
  return { ...base, rejected: null, records, exceptions, gaps };
}

/** Distinct rows with at least one exception. */
export function rowsWithExceptions(exceptions: readonly RowException[]): number {
  return new Set(exceptions.map((e) => `${e.code === "supplement_orphan" ? "s" : "t"}:${e.row}`))
    .size;
}

/** For a caller that has headers and wants to know whether they are the profile's, before reading rows. */
export function headersMatch(profile: TapeProfile, headers: readonly string[]): boolean {
  const want = new Set(profile.columns.map((c) => normalizeHeader(c.header)));
  return headers.some((h) => want.has(normalizeHeader(h)));
}
