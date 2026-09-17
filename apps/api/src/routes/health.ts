import { Router } from "express";
import { prisma } from "@hm/db";
import { REQUIREMENTS } from "@hm/requirements";
import { SHADOW_ENGINE_VERSION } from "@hm/underwriting";
import { config } from "../config.js";
import { aporStatus } from "../services/apor.js";
import { providerMix, providerModes } from "../services/connectors.js";
import { originatorPlaceholdersIn } from "@hm/du";
import { originatorFromConfig } from "../services/originator.js";

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

  const apor =
    database === "ok"
      ? await aporStatus().catch((err: unknown) => ({
          error: err instanceof Error ? err.message.split("\n")[0] : "unknown",
        }))
      : null;

  res.status(database === "ok" ? 200 : 503).json({
    status: database === "ok" ? "ok" : "degraded",
    service: "homestead-mortgages-api",
    version: "0.1.0",
    database,
    databaseError,
    requirementCount: REQUIREMENTS.length,
    ausEngine: `shadow@${SHADOW_ENGINE_VERSION}`,
    connectorMode: config.connectorMode,
    // Which adapter each connector is actually using. "Is this real yet?" is a
    // question that gets asked at the worst possible moment.
    providers: providerMix(),
    // The same reading the borrower's screens disclose from, out of the same
    // function /auth/config serves. An operator checking here and a borrower
    // reading a screen are then looking at one fact rather than two.
    connectorModes: providerModes(),
    authConfigured: Boolean(config.googleClientId),
    // Whether this deployment mints sessions for sample borrowers. Reported
    // rather than merely set, because the one thing that must never happen to
    // this flag is that nobody notices it is on.
    personas: config.demoPersonasEnabled ? "enabled" : "disabled",
    // Whether the NMLSR numbers a casefile names are ours or the
    // placeholders, reported rather than merely set.
    originator:
      originatorPlaceholdersIn(originatorFromConfig()).length === 0 ? "configured" : "placeholder",
    // Whether the average prime offer rate series reaches the current week.
    // Three legal tests block without it and every decision ends `referred`,
    // and nothing else on this page would say so: the database answers, the
    // vendors answer, the borrower walks four screens and lands on "In review".
    // The deploy workflow asserts `coversThisWeek` after every deploy.
    apor,
    timestamp: new Date().toISOString(),
  });
});
