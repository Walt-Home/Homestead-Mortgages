/**
 * Screen 8 — compute and answer.
 *
 * The decision is APPENDED, never updated. Recomputing writes a new row, which
 * is what lets "your options changed" be a diff rather than a claim.
 */

import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { prisma } from "@hm/db";
import { underwrite } from "@hm/underwriting";
import { AppError, asyncRoute } from "../middleware/error-handler.js";
import { assertFileAccess, loadLoanFile, recordEvent } from "../services/repository.js";
import { advanceStage } from "../services/stage.js";
import { applicationForFile } from "../services/applications.js";
import { decideApplication, recordDecision } from "../services/decide.js";
import { applicationStanding } from "../services/standing.js";

export const decisionRouter = Router();

const marketSchema = z
  .object({
    apor: z.number().optional(),
    apr: z.number().optional(),
    pointsAndFeesAmount: z.number().optional(),
    estimatedFees: z.number().optional(),
    estimatedPrepaids: z.number().optional(),
  })
  .default({});

decisionRouter.post(
  "/:id/decision",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const market = marketSchema.parse(req.body ?? {});

    await assertFileAccess(id, req.user!.id, "write");
    const file = await loadLoanFile(id);
    if (!file) throw new AppError(404, "Loan file not found", "NOT_FOUND");

    const decision = underwrite(file, {
      casefileId: randomUUID(),
      now: new Date().toISOString(),
      market: {
        apor: market.apor,
        apr: market.apr,
        pointsAndFeesAmount: market.pointsAndFeesAmount,
      },
      estimatedFees: market.estimatedFees,
      estimatedPrepaids: market.estimatedPrepaids,
    });

    // The decision is always appended; whether it MOVES the application is a
    // separate question the machine answers. Both in one transaction, so a
    // recorded decision and the state it produced cannot disagree.
    await prisma.$transaction(async (tx) => {
      const { decisionId } = await recordDecision(tx, id, decision);
      const app = await applicationForFile(tx, id);
      // A legacy file with no application still gets its decision recorded.
      if (!app) return;
      await decideApplication(tx, {
        applicationId: app.id,
        loanFileId: id,
        decision,
        decisionId,
        file,
      });
    });

    // Outside the transaction, and `advanceStage` rather than a direct write:
    // recomputing a decision on a finished file must not rewind it to the
    // consent step, and the stage is the old vocabulary the four screens still
    // resume on.
    await advanceStage(id, "PERSISTENT_CONSENT");

    await recordEvent(
      id,
      "decision_computed",
      "system",
      {
        outcome: decision.outcome,
        recommendation: decision.aus?.recommendation,
        engine: decision.aus?.engine,
      },
      "UW-002",
    );

    res.status(201).json({ decision, applicationState: await applicationStanding(prisma, id) });
  }),
);

/**
 * The decision as last computed. Read-only, and the only way a demo file can
 * show one at all: recomputing is a write, and demo files refuse writes.
 */
decisionRouter.get(
  "/:id/decision",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    await assertFileAccess(id, req.user!.id, "read");
    const file = await loadLoanFile(id);
    if (!file) throw new AppError(404, "Loan file not found", "NOT_FOUND");
    res.json({ decision: file.decision });
  }),
);

/**
 * Intent to Proceed (APP-007).
 *
 * A borrower_input requirement with a regulatory-violation severity and no
 * control anywhere, so it sat on the borrower's list permanently with nothing
 * they could press. It belongs on the decision screen: intent is something you
 * express AFTER seeing your Loan Estimate, which is what that screen stands in
 * for.
 */
decisionRouter.post(
  "/:id/intent-to-proceed",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    await assertFileAccess(id, req.user!.id, "write");

    const file = await prisma.loanFile.findUnique({
      where: { id },
      select: { intentToProceedAt: true },
    });
    // Recording it twice would move a dated, regulatory record. Once is once.
    if (file?.intentToProceedAt) {
      res.json({ intentToProceedAt: file.intentToProceedAt, alreadyRecorded: true });
      return;
    }

    const now = new Date();
    await prisma.loanFile.update({ where: { id }, data: { intentToProceedAt: now } });
    await recordEvent(id, "intent_to_proceed", "borrower", {}, "APP-007");
    res.status(201).json({ intentToProceedAt: now, alreadyRecorded: false });
  }),
);

/** Decision history — the substrate for "what changed since last time". */
decisionRouter.get(
  "/:id/decisions",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    await assertFileAccess(id, req.user!.id, "read");
    const decisions = await prisma.decision.findMany({
      where: { loanFileId: id },
      orderBy: { computedAt: "desc" },
      select: {
        id: true,
        outcome: true,
        computedAt: true,
        ausRecommendation: true,
        ausEngine: true,
        ratios: true,
      },
    });
    res.json({ decisions });
  }),
);
