/**
 * OFAC/SDN screening, and the hold a near match puts on the file.
 *
 * One writer, so the route and anything else that screens a person record the
 * same four things: the verbatim snapshot, the column the engine reads, the
 * event, and — when the list came back with a name on it — the ledger row
 * saying the application is held while somebody looks at it.
 *
 * Nothing here CLEARS a hold. `third_party_returned` is a person's act, and a
 * screening that comes back clean on a second run is not that person: a near
 * match that has been resolved is resolved by whoever resolved it, and the
 * ledger should name them.
 */

import { prisma } from "@hm/db";
import type { ConnectorRegistry } from "@hm/connectors";
import type { LoanFile, SanctionsScreening } from "@hm/shared";
import { applicationForFile } from "./applications.js";
import { primaryBorrower, subjectPartyId, tokenFor } from "./authorization.js";
import { ownsTransaction, type Db } from "./db.js";
import { servicePrincipal } from "./party.js";
import { recordEvent, recordSnapshot } from "./repository.js";
import { advanceIfLegal } from "./transition.js";

export interface ScreeningOutcome {
  readonly screening: SanctionsScreening;
  readonly snapshotId: string;
  readonly held: boolean;
}

/**
 * Screen the borrower and record everything that follows.
 *
 * The pull happens before the writes rather than inside them: a watchlist
 * vendor is a network call, and holding a transaction open across one would
 * put a database connection at the mercy of somebody else's latency. What
 * follows it is one transaction, because a snapshot without its column, or a
 * near match without its hold, is a half-recorded screen.
 */
export async function screenAndRecord(
  db: Db,
  file: LoanFile,
  registry: ConnectorRegistry,
): Promise<ScreeningOutcome> {
  const result = await registry.screening.screenSanctions(
    file,
    await tokenFor(file, primaryBorrower(file), "sanctions_screening", db),
  );

  const write = async (tx: Db): Promise<ScreeningOutcome> => {
    const snapshot = await recordSnapshot(
      file.id,
      "sanctions",
      result.provider,
      result.externalId,
      result.data,
      result.retrievedAt,
      subjectPartyId(file),
      tx,
    );
    await tx.loanFile.update({
      where: { id: file.id },
      data: { sanctionsScreenClear: result.data.clear },
    });
    await recordEvent(
      file.id,
      "screening_completed",
      result.provider,
      { clear: result.data.clear },
      "CRD-010",
      tx,
    );

    let held = false;
    if (!result.data.clear) {
      const app = await applicationForFile(tx, file.id);
      if (app) {
        const advance = await advanceIfLegal(
          {
            applicationId: app.id,
            event: "third_party_blocked",
            actorPrincipalId: await servicePrincipal(tx, "application_flow"),
            reasonCode: "sanctions_near_match",
            causedBy: `snapshot:${snapshot.id}`,
          },
          tx,
        );
        held = !("skipped" in advance);
      }
    }

    return { screening: result.data, snapshotId: snapshot.id, held };
  };

  return ownsTransaction(db) ? prisma.$transaction(write) : write(db);
}
