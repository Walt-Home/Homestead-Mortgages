/**
 * Runs before every test file. See `support/database.ts` for why there is a
 * real database behind these tests at all.
 */

import { afterAll, beforeAll, beforeEach } from "vitest";
import { prisma } from "@hm/db";
import { assertDatabaseReachable, resetDatabase } from "./database.js";

beforeAll(assertDatabaseReachable);
beforeEach(resetDatabase);
afterAll(async () => {
  await prisma.$disconnect();
});
