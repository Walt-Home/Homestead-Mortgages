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
import type { Prisma } from "@hm/db";
import { AppError, asyncRoute } from "../middleware/error-handler.js";
import { assertFileAccess, loadLoanFile, recordEvent } from "../services/repository.js";

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
      market: { apor: market.apor, apr: market.apr, pointsAndFeesAmount: market.pointsAndFeesAmount },
      estimatedFees: market.estimatedFees,
      estimatedPrepaids: market.estimatedPrepaids,
    });

    await prisma.$transaction(async (tx) => {
      await tx.decision.create({
        data: {
          loanFileId: id,
          outcome: decision.outcome,
          computedAt: new Date(decision.computedAt),
          ausEngine: decision.aus!.engine,
          ausEngineVersion: decision.aus!.engineVersion,
          ausCasefileId: decision.aus!.casefileId,
          ausRecommendation: decision.aus!.recommendation,
          ausFindings: decision.aus!.findings as unknown as Prisma.InputJsonValue,
          ratios: decision.ratios as unknown as Prisma.InputJsonValue,
          reserves: decision.reserves as unknown as Prisma.InputJsonValue,
          compliance: decision.compliance as unknown as Prisma.InputJsonValue,
          pricing: decision.pricing as unknown as Prisma.InputJsonValue,
          derivations: decision.derivations as unknown as Prisma.InputJsonValue,
          adverseActionReasons: [...(decision.adverseActionReasons ?? [])],
        },
      });

      // Conditions are replaced wholesale on each run. A condition the
      // borrower already cleared should not reappear, so cleared rows survive.
      await tx.loanCondition.deleteMany({ where: { loanFileId: id, status: "open" } });
      const cleared = await tx.loanCondition.findMany({
        where: { loanFileId: id },
        select: { requirementId: true },
      });
      const clearedIds = new Set(cleared.map((c) => c.requirementId));
      const fresh = decision.conditions.filter((c) => !clearedIds.has(c.requirementId));
      if (fresh.length) {
        await tx.loanCondition.createMany({
          data: fresh.map((c) => ({
            loanFileId: id,
            requirementId: c.requirementId,
            description: c.description,
            status: c.status,
            owner: c.owner,
            issuedAt: new Date(c.issuedAt),
            documentIds: [...c.documentIds],
          })),
        });
      }

      await tx.loanFile.update({ where: { id }, data: { stage: "PERSISTENT_CONSENT" } });
    });

    await recordEvent(id, "decision_computed", "system", {
      outcome: decision.outcome,
      recommendation: decision.aus?.recommendation,
      engine: decision.aus?.engine,
    }, "UW-002");

    res.status(201).json({ decision });
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
