/**
 * The average prime offer rate series, for a test that decides something.
 *
 * `resetDatabase` truncates every table between tests, `apor_weeks` included,
 * and the decision route reads that table and nothing else — so a test that
 * walks a file to a decision has to put a series there first, exactly as the
 * deploy does before it seeds. This ingests the vendored published table with
 * the vendored survey beside it, through the same adapter and the same service
 * a deployment uses, and returns the table that resulted so the test can pin a
 * quote to a week it holds.
 */

import { fixtureAporSeriesConnector } from "@hm/connectors";
import { prisma } from "@hm/db";
import type { AporTable } from "@hm/underwriting";
import { aporTableFromDatabase, ingestApor } from "../../services/apor.js";
import type { Db } from "../../services/db.js";

export async function ingestFixtureApor(db: Db = prisma): Promise<AporTable> {
  const port = fixtureAporSeriesConnector({ latencyMs: 0 });
  const report = await ingestApor(
    await port.fetchTable(),
    await port.fetchSurvey(),
    port.capabilities.provider,
    db,
  );
  if (report.status === "refused") throw new Error(`fixture ingest refused: ${report.reason}`);
  const table = await aporTableFromDatabase(db);
  if (!table) throw new Error("ingesting the fixture documents left no series behind");
  return table;
}
