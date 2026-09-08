/**
 * Runs before every test file. See `support/database.ts` for why there is a
 * real database behind these tests at all.
 */

import { afterAll, beforeAll, beforeEach } from "vitest";
import { prisma } from "@hm/db";
import { assertDatabaseReachable, resetDatabase } from "./database.js";

beforeAll(assertDatabaseReachable);
beforeEach(resetDatabase);
// Emptied on the way out as well as on the way in. The last file to run
// otherwise leaves its rows behind, and a migration that adds a NOT NULL
// column with no default then fails against them the next time
// `db:test:setup` applies it — on a developer machine, after a checkout,
// with a message about data nobody remembers creating.
afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});
