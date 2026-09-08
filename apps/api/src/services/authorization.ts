/**
 * Whose data a route is about to fetch.
 *
 * Every person-keyed connector method now takes a `PurposeToken`, which names
 * one borrower. That is the fix: the old guard took a file and no subject, so
 * on a two-borrower file one person's signature authorized a pull about the
 * other. The type system now forces the question to be asked at every call
 * site.
 *
 * It does not yet force the RIGHT answer. Screen 2 collects one borrower, so
 * `subjectOf` takes the first, and that is correct for every file this product
 * can currently create. When co-borrowers exist the routes have to choose
 * deliberately — and the choice will be a compile error away rather than a
 * silent default, because this function is the only place that guesses.
 */

import { prisma } from "@hm/db";
import {
  mintPurposeToken,
  type AuthorizationPurpose,
  type DataCategory,
  type Grant,
  type LoanFile,
  type PurposeToken,
} from "@hm/shared";
import { AuthorizationError, PURPOSE_FOR, purposeFor } from "@hm/connectors";
import { AppError } from "../middleware/error-handler.js";

/** `FCRA_WRITTEN_INSTRUCTION` -> `fcra_written_instruction`. */
const lower = <T extends string>(s: string) => s.toLowerCase() as T;

/**
 * Permission to retrieve `category` about this file's borrower.
 *
 * Reads the real `authorizations` table when the borrower has a party with any
 * grant on it, and falls back to the file's legacy `consents` when not. The
 * fallback exists for files written before the relationship layer and for
 * demo files; it goes away when the last of those does. Once a party HAS
 * authorizations, they are authoritative — a denial there is not a reason to
 * try the old table.
 *
 * Throws `AuthorizationError` (403, carrying the requirement id the client
 * routes on) when the permission is missing, revoked, expired or for
 * something else.
 */
export async function tokenFor(file: LoanFile, category: DataCategory): Promise<PurposeToken> {
  const subject = file.borrowers[0];
  if (!subject) {
    // Reachable: every connector route runs after screen 2, but a file whose
    // borrower row was never written would otherwise reach the adapter with
    // nobody to name. A 409 rather than a 403 — nothing was refused, there is
    // simply nobody to refuse it about.
    throw new AppError(
      409,
      "This file has no borrower yet, so there is nobody to authorize a retrieval about.",
      "NO_SUBJECT",
    );
  }

  if (subject.partyId) {
    const rows = await prisma.authorization.findMany({
      where: { partyId: subject.partyId },
      select: {
        id: true,
        partyId: true,
        purpose: true,
        dataCategories: true,
        grantedAt: true,
        expiresAt: true,
        revokedAt: true,
      },
    });
    if (rows.length > 0) {
      const grants: Grant[] = rows.map((r) => ({
        id: r.id,
        partyId: r.partyId,
        purpose: lower<AuthorizationPurpose>(r.purpose),
        dataCategories: r.dataCategories.map((c) => lower<DataCategory>(c)),
        grantedAt: r.grantedAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        revokedAt: r.revokedAt?.toISOString() ?? null,
      }));
      const result = mintPurposeToken({
        partyId: subject.partyId,
        purpose: PURPOSE_FOR[category],
        dataCategory: category,
        grants,
        now: new Date(),
      });
      if (result.ok) return result.token;
      throw new AuthorizationError(
        `No authorization to retrieve ${category} for this borrower: ${result.message}.`,
        category === "tax_transcript" ? "INC-008" : "APP-005",
      );
    }
  }

  return purposeFor(file, subject.id, category);
}
