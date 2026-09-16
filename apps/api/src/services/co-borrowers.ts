/**
 * A second person on the application: named by the applicant, completed by
 * themselves.
 *
 * The applicant names a co-borrower by name and email and nothing else. The
 * co-borrower completes their own profile and gives their own permissions —
 * their date of birth, address and Social Security number are theirs to state,
 * in their own session — and until they do, the file is waiting on them and
 * cannot be signed, decided or submitted. That is the product's design: a
 * separate, private application per person, where "your private identity
 * details and credentials stay private."
 *
 * Two writers here, and the difference is who asserts what:
 *
 *   - `nameCoBorrower` is the route's. It mints a PROVISIONAL party, asserts a
 *     name and an email under the APPLICANT's principal — the two things the
 *     applicant can honestly say about somebody else — and puts the person on
 *     the credit request in their role. Nothing else is stated about them.
 *   - `appendCoBorrowerWithFacts` states a whole identity under the applicant's
 *     principal. It is what the paper joint URLA does and what the persona
 *     seed and the tests build a complete household from; no screen offers it.
 *
 * Removal is the applicant's while the person has not arrived and stops being
 * the applicant's the moment they have: a claimed party is a person who signed
 * in, and leaving is theirs to do.
 */

import { prisma, type ApplicationPartyRole, type Prisma } from "@hm/db";
import type { Demographics } from "@hm/shared";
import { AppError } from "../middleware/error-handler.js";
import { applicationForFile, ensureApplicationParty } from "./applications.js";
import { primaryBorrowerRow } from "./borrower-order.js";
import type { Db } from "./db.js";
import {
  assertFacts,
  createProvisionalParty,
  principalForParty,
  recordBorrowerFacts,
  type BorrowerInput,
} from "./party.js";
import { recordEvent } from "./repository.js";

/** What the applicant says about the person they are applying with. */
export interface NamedCoBorrower {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  /** Whether they will live in the home. A co-signer does not. */
  readonly occupiesProperty: boolean;
}

/**
 * A whole identity, stated by the applicant about somebody else: screen 2's
 * fields, with the SSN required because there is no revisit to spare it on,
 * and without the three that are the applicant's alone (`statedMonthlyIncome`,
 * because TRID's six pieces are theirs; `currentHousing` and `monthlyRent`,
 * because `du_residences` is where a housing basis comes from).
 */
export interface StatedCoBorrower extends BorrowerInput {
  readonly ssnVaultHandle: string;
  readonly ssnLast4: string;
  readonly nonBorrowingSpouseName?: string;
  readonly demographics?: Demographics | null;
}

export interface Appended {
  readonly borrowerId: string;
  readonly partyId: string;
  readonly borrowerOrdinal: number | null;
  readonly role: ApplicationPartyRole;
}

/** The product's words for a file that is waiting on somebody it named. */
export function coBorrowerNeedsToFinish(
  invited: readonly { firstName: string; lastName: string }[],
): string {
  if (invited.length === 1) return "Your co-borrower needs to finish.";
  const names = invited.map((p) => `${p.firstName} ${p.lastName}`.trim()).join(" and ");
  return `${names} need to finish their part before this can go on.`;
}

/** The role a named person takes on the credit request. DU has no guarantor. */
export function roleFor(occupiesProperty: boolean): ApplicationPartyRole {
  return occupiesProperty ? "CO_BORROWER" : "NON_OCCUPANT_CO_BORROWER";
}

async function applicantOn(db: Db, loanFileId: string) {
  // Whose request this is — Borrower 1 by ordinal, the same person every
  // reader resolves to. A file with nobody on it has no applicant for a second
  // person to be second to.
  const primary = await primaryBorrowerRow(db, loanFileId);
  if (!primary) throw new AppError(409, "Tell us who you are first.", "NO_BORROWER");
  const app = await applicationForFile(db, loanFileId);
  if (!app) throw new AppError(409, "This file is not an application yet.", "NO_APPLICATION");
  return { primary, app };
}

export async function nameCoBorrower(
  loanFileId: string,
  named: NamedCoBorrower,
  db: Db = prisma,
): Promise<Appended> {
  const appended = await db.$transaction(async (tx) => {
    const { primary, app } = await applicantOn(tx, loanFileId);
    const partyId = await createProvisionalParty(tx, {
      sourceFirstSeen: "co_borrower_named_by_applicant",
    });
    // The applicant's principal on the two facts the applicant can honestly
    // assert about somebody else. Everything else about this person is theirs
    // to state, and arrives under their own principal when they do.
    await assertFacts(tx, partyId, await principalForParty(tx, primary.partyId), [
      { predicate: "legal_name", value: { first: named.firstName, last: named.lastName } },
      { predicate: "email", value: named.email },
    ]);
    const borrower = await tx.borrower.create({
      data: { loanFileId, partyId, ssnLast4: null },
      select: { id: true },
    });
    const role = roleFor(named.occupiesProperty);
    const edge = await ensureApplicationParty(tx, app.id, partyId, role);
    return { borrowerId: borrower.id, partyId, borrowerOrdinal: edge.borrowerOrdinal, role };
  });
  await recordEvent(loanFileId, "co_borrower_named", "borrower", {
    borrowerId: appended.borrowerId,
    borrowerOrdinal: appended.borrowerOrdinal,
    role: appended.role,
  });
  return appended;
}

/**
 * A whole identity stated by the applicant, the way a paper joint URLA is
 * filled in. Not offered by any screen; the seed and the tests build complete
 * households with it.
 */
export async function appendCoBorrowerWithFacts(
  loanFileId: string,
  input: StatedCoBorrower,
  occupiesProperty = true,
  db: Db = prisma,
): Promise<Appended> {
  const appended = await db.$transaction(async (tx) => {
    const { primary, app } = await applicantOn(tx, loanFileId);
    const partyId = await recordBorrowerFacts(tx, {
      loanFileId,
      existingPartyId: null,
      input,
      namedBy: {
        principalId: await principalForParty(tx, primary.partyId),
        sourceFirstSeen: "co_borrower_named_by_applicant",
      },
    });
    const borrower = await tx.borrower.create({
      data: {
        loanFileId,
        partyId,
        ssnLast4: input.ssnLast4,
        nonBorrowingSpouseName: input.nonBorrowingSpouseName ?? null,
        nonBorrowingSpouseSignatureRequired:
          input.maritalStatus === "married" && Boolean(input.nonBorrowingSpouseName),
        // An interface has no index signature, and Prisma's JSON input wants one.
        demographics: (input.demographics as Prisma.InputJsonValue | null | undefined) ?? undefined,
      },
      select: { id: true },
    });
    const role = roleFor(occupiesProperty);
    const edge = await ensureApplicationParty(tx, app.id, partyId, role);
    return { borrowerId: borrower.id, partyId, borrowerOrdinal: edge.borrowerOrdinal, role };
  });
  await recordEvent(loanFileId, "co_borrower_added", "borrower", {
    borrowerId: appended.borrowerId,
    borrowerOrdinal: appended.borrowerOrdinal,
  });
  return appended;
}

/**
 * Take a named co-borrower off the application, while it is still the
 * applicant's to do.
 *
 * Refused for the applicant themselves, and refused once the person has
 * claimed their party — they signed in, and leaving is theirs. The provisional
 * party goes with the row, and its two facts with it: a name and an email the
 * applicant typed for somebody who never arrived is not a record to keep.
 */
export async function removeNamedCoBorrower(
  loanFileId: string,
  borrowerId: string,
  db: Db = prisma,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const row = await tx.borrower.findFirst({
      where: { id: borrowerId, loanFileId },
      select: { id: true, partyId: true, party: { select: { claimStatus: true } } },
    });
    if (!row) throw new AppError(404, "That person is not on this file.", "NOT_FOUND");
    const primary = await primaryBorrowerRow(tx, loanFileId);
    if (primary && primary.id === row.id) {
      throw new AppError(
        409,
        "The applicant cannot be removed from their own application.",
        "APPLICANT_STAYS",
      );
    }
    if (row.party.claimStatus === "CLAIMED" || row.party.claimStatus === "MERGED") {
      throw new AppError(
        409,
        "They have signed in, so leaving the application is theirs to do.",
        "CO_BORROWER_ARRIVED",
      );
    }
    const app = await applicationForFile(tx, loanFileId);
    if (app) {
      await tx.applicationParty.deleteMany({
        where: { applicationId: app.id, partyId: row.partyId },
      });
    }
    await tx.borrower.delete({ where: { id: row.id } });
    await tx.party.delete({ where: { id: row.partyId } });
  });
  await recordEvent(loanFileId, "co_borrower_removed", "borrower", { borrowerId });
}
