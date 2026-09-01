/**
 * "What is left?" — the endpoint the whole UI hangs off.
 *
 * It never returns the raw 77. It returns what applies to this borrower, what
 * they can act on now, and what we do not yet know — because those three are
 * different sentences and a borrower deserves to be told which one they are in.
 */

import { Router } from "express";
import { z } from "zod";
import {
  assessAll,
  connectorLeverage,
  explainBlock,
  outstanding,
  progress,
  REQUIREMENTS,
} from "@hm/requirements";
import { AppError, asyncRoute } from "../middleware/error-handler.js";
import { assertFileAccess, loadLoanFile } from "../services/repository.js";

export const requirementRouter = Router();

/** The registry itself, for tooling and for the internal requirement browser. */
requirementRouter.get("/", (_req, res) => {
  res.json({ requirements: REQUIREMENTS, count: REQUIREMENTS.length });
});

requirementRouter.get(
  "/:id/assessment",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    await assertFileAccess(id, req.user!.id, "read");
    const file = await loadLoanFile(id);
    if (!file) throw new AppError(404, "Loan file not found", "NOT_FOUND");

    const all = assessAll(file);
    res.json({
      progress: progress(file),
      outstanding: outstanding(file).map((a) => ({
        id: a.requirement.id,
        screen: a.requirement.screen,
        source: a.requirement.source,
        statement: a.requirement.statement,
        severity: a.requirement.failureSeverity,
        appliesBecause: a.requirement.conditionProse,
        applicabilityKnown: a.applies === true,
        missing: a.satisfaction.status === "unsatisfied" ? a.satisfaction.missing : null,
        waitingFor: a.satisfaction.status === "blocked" ? a.satisfaction.waitingFor : null,
      })),
      blocked: all
        .filter((a) => a.applies !== false && a.blockedBy.length > 0)
        .map((a) => ({
          id: a.requirement.id,
          statement: a.requirement.statement,
          rootCauses: explainBlock(file, a.requirement.id),
        })),
      leverage: connectorLeverage(file),
    });
  }),
);
