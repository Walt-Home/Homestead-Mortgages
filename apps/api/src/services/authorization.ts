/**
 * Whose data a route is about to fetch, and whether it may.
 *
 * The only minter. Every person-keyed connector method takes a `PurposeToken`
 * naming one party, and this is where one comes from: the party's rows in
 * `authorizations`, and nothing else. There is no fallback to a loan file's
 * `consents` — that bridge came out with the borrower columns it read, and a
 * refusal here is attributable to exactly one table.
 *
 * Screen 2 collects one borrower, so `file.borrowers[0]` is the subject, and
 * that is correct for every file this product can currently create. When
 * co-borrowers exist the routes have to choose deliberately, and this
 * function is the only place that guesses — so the choice will be a compile
 * error away rather than a silent default.
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
import { AuthorizationError, PURPOSE_FOR, REQUIREMENT_FOR } from "@hm/connectors";
import { AppError } from "../middleware/error-handler.js";

/** `FCRA_WRITTEN_INSTRUCTION` -> `fcra_written_instruction`. */
const lower = <T extends string>(s: string) => s.toLowerCase() as T;

/**
 * Permission to retrieve `category` about this file's borrower.
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
    `No authorization to retrieve ${category} for this borrower: ${result.message}. ` +
      "No credit, income, employment or asset data may be pulled.",
    REQUIREMENT_FOR[category],
  );
}
