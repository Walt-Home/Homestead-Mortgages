/**
 * Who originates, and the placeholders standing where that answer goes.
 *
 * URLA Section 9 puts two parties inside the deal that are neither borrowers
 * nor the institution the casefile is sent under: the loan origination
 * company (9.1 its legal name, 9.3 its NMLSR id) and the loan originator (9.5
 * their name, 9.6 their NMLSR id). Both are `PARTY` rows the preflight refuses
 * a casefile without — a borrower-only `PARTIES` is not a submission — and
 * both carry a license identifier that, like the seller/servicer number in
 * `institution.ts`, is a number somebody was allocated and not a format.
 *
 * So the same three rules hold here as there. The placeholders SAY they are
 * placeholders — no NMLSR id has letters in it. `assertOriginatorEmittable`
 * refuses them when `NODE_ENV` is `production`, reading the environment here
 * rather than taking it as an argument, so there is one check and one place
 * to get it right. And the widths come out of `generated/lengths.ts`, so a
 * specification that moves one moves this with it.
 *
 * What is different is where the values live. The institution is handed to
 * the assembler as an option; the originator is written onto every
 * application at birth as two `du_deal_parties` ROWS, because the rows are
 * what the assembler reads and what the ten-party ceiling counts. That is why
 * `assertDealPartiesEmittable` exists beside the option-shaped check: a row
 * born under placeholders in a development database must never reach a
 * document, and the rows are the only thing the assembler sees.
 */

import { DU_FORMATS } from "./generated/lengths.js";

/** The five values a submission states an originator with. */
export interface DuOriginator {
  /** 9.1 — the origination company's legal name. */
  readonly companyLegalName: string;
  /** 9.3 — the company's NMLSR id. */
  readonly companyNmlsId: string;
  /** 9.5 — the loan originator's name, as the Map splits it. */
  readonly originatorFirstName: string;
  readonly originatorLastName: string;
  /** 9.6 — the originator's own NMLSR id. */
  readonly originatorNmlsId: string;
}

const PARTY = "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/PARTIES/PARTY";
export const COMPANY_NAME_FORMAT = `${PARTY}/LEGAL_ENTITY/LEGAL_ENTITY_DETAIL#FullName#9.1`;
export const COMPANY_NMLS_FORMAT = `${PARTY}/ROLES/ROLE/LICENSES/LICENSE/LICENSE_DETAIL#LicenseIdentifier#9.3`;
export const ORIGINATOR_FIRST_NAME_FORMAT = `${PARTY}/INDIVIDUAL/NAME#FirstName#9.5`;
export const ORIGINATOR_LAST_NAME_FORMAT = `${PARTY}/INDIVIDUAL/NAME#LastName#9.5`;
export const ORIGINATOR_NMLS_FORMAT = `${PARTY}/ROLES/ROLE/LICENSES/LICENSE/LICENSE_DETAIL#LicenseIdentifier#9.6`;

/** The width the specification gives a destination, or a throw — see institution.ts. */
export function widthOf(destination: string): number {
  const format = DU_FORMATS[destination];
  if (!format || format.kind !== "string" || format.maxLength === undefined) {
    throw new Error(
      `${destination} is not a string destination the generated lengths table carries, so ` +
        "nothing here knows how wide the value may be.",
    );
  }
  return format.maxLength;
}

const WIDTHS = {
  companyLegalName: widthOf(COMPANY_NAME_FORMAT),
  companyNmlsId: widthOf(COMPANY_NMLS_FORMAT),
  originatorFirstName: widthOf(ORIGINATOR_FIRST_NAME_FORMAT),
  originatorLastName: widthOf(ORIGINATOR_LAST_NAME_FORMAT),
  originatorNmlsId: widthOf(ORIGINATOR_NMLS_FORMAT),
} as const;

/**
 * What stands where our numbers go. Every value has letters in it, so none
 * can pass for an NMLSR id, and each fits its destination so the refusal is
 * this file's sentence rather than a length overrun.
 */
export const PLACEHOLDER_ORIGINATOR: DuOriginator = {
  companyLegalName: "PLACEHOLDER MORTGAGE",
  companyNmlsId: "PLCHLD-NMLS",
  originatorFirstName: "Placeholder",
  originatorLastName: "Originator",
  originatorNmlsId: "PLCHLD-NMLS",
};

const FIELDS = [
  "companyLegalName",
  "companyNmlsId",
  "originatorFirstName",
  "originatorLastName",
  "originatorNmlsId",
] as const;

/** Which of the five values is still the placeholder. Empty when none is. */
export function originatorPlaceholdersIn(originator: DuOriginator): readonly string[] {
  return FIELDS.filter((field) => originator[field] === PLACEHOLDER_ORIGINATOR[field]);
}

function assertWidth(what: string, value: string, maximum: number): void {
  if (value.trim() === "") {
    throw new Error(`${what} is empty. A submission names who originated it or it names nobody.`);
  }
  if (value.length > maximum) {
    throw new Error(
      `${what} is ${value.length} characters at a destination that takes ${maximum}.`,
    );
  }
}

const WHAT: Record<(typeof FIELDS)[number], string> = {
  companyLegalName: "The origination company's legal name",
  companyNmlsId: "The origination company's NMLSR id",
  originatorFirstName: "The loan originator's first name",
  originatorLastName: "The loan originator's last name",
  originatorNmlsId: "The loan originator's NMLSR id",
};

/**
 * The originator, or a refusal. Messages name the field and never the value.
 */
export function assertOriginatorEmittable(originator: DuOriginator): void {
  for (const field of FIELDS) assertWidth(WHAT[field], originator[field], WIDTHS[field]);
  const standing = originatorPlaceholdersIn(originator);
  if (standing.length > 0 && process.env.NODE_ENV === "production") {
    throw new Error(
      `Refusing to assemble a submission against a placeholder originator: ${standing.join(
        ", ",
      )}. Nobody has put our NMLSR numbers in the configuration, and a number that looks real ` +
        "is worse than none.",
    );
  }
}

/** The shape of a deal-party row as the assembler loads it: what this check reads. */
export interface DealPartyLike {
  readonly role: string;
  readonly licenseIdentifier: string | null;
}

/**
 * The rows, or a refusal — the same rule made about what the assembler
 * actually reads. A row born in a development database under placeholders
 * carries the placeholder id, and that is what identifies it here.
 */
export function assertDealPartiesEmittable(parties: readonly DealPartyLike[]): void {
  if (process.env.NODE_ENV !== "production") return;
  const standing = parties.filter(
    (p) =>
      (p.role === "LoanOriginationCompany" || p.role === "LoanOriginator") &&
      (p.licenseIdentifier === PLACEHOLDER_ORIGINATOR.companyNmlsId ||
        p.licenseIdentifier === PLACEHOLDER_ORIGINATOR.originatorNmlsId),
  );
  if (standing.length > 0) {
    throw new Error(
      `Refusing to assemble a submission whose ${standing.map((p) => p.role).join(" and ")} ` +
        "row carries a placeholder NMLSR id. The application was born before the numbers were " +
        "configured; it has to be re-recorded against real ones.",
    );
  }
}
