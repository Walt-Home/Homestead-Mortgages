import { Router } from "express";
import { prisma } from "@hm/db";
import { REQUIREMENTS } from "@hm/requirements";
import { SHADOW_ENGINE_VERSION } from "@hm/underwriting";
import { config } from "../config.js";

export const healthRouter = Router();

/**
 * Health, including whether the database is actually reachable.
 *
 * The database check is not decoration. A malformed Cloud SQL socket path in
 * DATABASE_URL produced a deployment where every endpoint anyone thought to
 * test — this one, and the 401s from unauthenticated routes — answered
 * perfectly, because none of them touched Postgres. The first request that
 * did was a real person signing in, and it 500'd.
 *
 * A health check that cannot fail is a health check that tells you nothing.
 * This one returns 503 when the database is unreachable, and the deploy
 * workflow fails on it.
 */
healthRouter.get("/", async (_req, res) => {
  let database: "ok" | "unreachable" = "unreachable";
  let databaseError: string | undefined;
  try {
    await prisma.$queryRaw`SELECT 1`;
    database = "ok";
  } catch (err) {
    databaseError = err instanceof Error ? err.message.split("\n")[0] : "unknown";
  }

  res.status(database === "ok" ? 200 : 503).json({
    status: database === "ok" ? "ok" : "degraded",
    service: "homestead-mortgages-api",
    version: "0.1.0",
    database,
    databaseError,
    requirementCount: REQUIREMENTS.length,
    ausEngine: `shadow@${SHADOW_ENGINE_VERSION}`,
    connectorMode: config.connectorMode,
    authConfigured: Boolean(config.googleClientId),
    timestamp: new Date().toISOString(),
  });
});
