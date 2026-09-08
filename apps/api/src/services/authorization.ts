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

import type { DataCategory, LoanFile, PurposeToken } from "@hm/shared";
import { purposeFor } from "@hm/connectors";
import { AppError } from "../middleware/error-handler.js";

/**
 * Permission to retrieve `category` about this file's borrower.
 *
 * Throws `AuthorizationError` (403, carrying the requirement id the client
 * routes on) when the permission is missing, revoked or for something else.
 */
export function tokenFor(file: LoanFile, category: DataCategory): PurposeToken {
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
  return purposeFor(file, subject.id, category);
}
