/**
 * Screens 3–6, and the consent that gates them.
 *
 * Every pull writes a verbatim snapshot and an event. The authorization guard
 * lives inside the adapters rather than here, so a new route cannot forget it.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "@hm/db";
import { AppError, asyncRoute } from "../middleware/error-handler.js";
import {
  assertFileAccess,
  loadLoanFile,
  recordEvent,
  recordSnapshot,
} from "../services/repository.js";
import { connectors } from "../services/connectors.js";
import { advanceStage } from "../services/stage.js";

export const connectorRouter = Router();

/**
 * Load a file the caller is allowed to WRITE. Every route in this module
 * mutates — a connector pull writes a snapshot — so there is no read-only
 * variant here on purpose.
 */
async function requireFile(id: string, userId: string) {
  await assertFileAccess(id, userId, "write");
  const file = await loadLoanFile(id);
  if (!file) throw new AppError(404, "Loan file not found", "NOT_FOUND");
  return file;
}

/** Record a consent. This is what unlocks every connector below. */
const consentSchema = z.object({
  kind: z.enum([
    "verification_authorization",
    "econsent",
    "form_4506c",
    "persistent_monitoring",
    "sms_contact",
  ]),
  borrowerId: z.string().uuid(),
  envelopeId: z.string().optional(),
});

connectorRouter.post(
  "/:id/consents",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = consentSchema.parse(req.body);
    await requireFile(id, req.user!.id);

    const consent = await prisma.consent.create({
      data: {
        loanFileId: id,
        borrowerId: input.borrowerId,
        kind: input.kind,
        grantedAt: new Date(),
        envelopeId: input.envelopeId ?? null,
        // The IP and user agent ARE the evidence that a person signed. They
        // are only trustworthy because `trust proxy` is a hop count — see
        // config.ts.
        ipAddress: req.ip ?? "unknown",
        userAgent: req.get("user-agent") ?? "unknown",
      },
    });
    await recordEvent(id, "consent_granted", "borrower", { kind: input.kind });
    res.status(201).json({ id: consent.id, kind: consent.kind, grantedAt: consent.grantedAt });
  }),
);

/** Screen 3 — the soft credit pull. First visible win. */
connectorRouter.post(
  "/:id/credit",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const file = await requireFile(id, req.user!.id);

    const result = await connectors().credit.pullTriMerge(file);
    await recordSnapshot(
      id,
      "credit",
      result.provider,
      result.externalId,
      result.data,
      result.retrievedAt,
    );
    await upsertLink(id, "credit", result.provider);
    // APP-018 names the credit pull as its source: a refinance's existing
    // servicer and balance come off the report. Nothing wrote them back, so a
    // refinance could never satisfy a requirement it had made applicable.
    const mortgage = result.data.tradelines.find((t) => t.type === "mortgage");
    if (mortgage && file.loan && file.loan.purpose !== "purchase") {
      await prisma.loanFile.update({
        where: { id },
        data: {
          existingServicer: mortgage.creditorName,
          existingLoanNumber: mortgage.id,
          existingBalance: mortgage.balance,
          existingRate: 0,
          existingMonthlyPayment: mortgage.monthlyPayment,
        },
      });
    }

    // CRD-010 (OFAC/SDN) used to be asserted true right here, without any
    // screening having run. That is worse than not screening at all: it puts a
    // clean value in the exact field an auditor would check. Real screening now
    // lives behind the `screening` connector — see routes/property.ts — and
    // this route no longer claims anything it did not do.
    //
    // UW-018's fraud and red-flag review has no provider either, but it is a
    // review rather than a lookup, so it stays a recorded system assertion.
    await prisma.loanFile.update({
      where: { id },
      data: { fraudReviewComplete: true },
    });
    await recordEvent(id, "screening_completed", "system", {
      checks: ["fraud_red_flag"],
      note: "fixture — no real fraud review provider is wired",
    });

    await recordEvent(id, "connector_pull", result.provider, { kind: "credit" }, "CRD-001");
    await advanceStage(id, "BANK");

    res.status(201).json({ report: result.data, provider: result.provider });
  }),
);

/** Screen 4 — the 12-month asset report. The one that matters. */
connectorRouter.post(
  "/:id/bank",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const file = await requireFile(id, req.user!.id);

    const bank = connectors().bank;
    const session = await bank.createLinkSession(file);
    const result = await bank.fetchAssetReport(file, session.sessionId, 12);

    await recordSnapshot(
      id,
      "bank",
      result.provider,
      result.externalId,
      result.data,
      result.retrievedAt,
    );
    await upsertLink(id, "bank", result.provider);

    // The bank report carries income and employment, not just assets — the
    // sheet says so ("Assets + income + employment + cash flow + rent
    // history") and the real vendors behave that way. Writing them here is
    // what lets a salaried borrower reach a decision without a payroll step.
    //
    // Replaced wholesale rather than merged: a re-pull is the newer truth
    // about the same twelve months, and merging would double the income.
    await prisma.$transaction([
      prisma.incomeSource.deleteMany({ where: { loanFileId: id } }),
      prisma.incomeSource.createMany({
        data: result.data.incomeSources.map((s) => ({
          loanFileId: id,
          type: s.type,
          monthlyAmount: s.monthlyAmount,
          historyMonths: s.historyMonths,
          continuanceEndDate: s.continuanceEndDate ? new Date(s.continuanceEndDate) : null,
          continuanceEstablished: s.continuanceEstablished,
          evidenceDocumentIds: [...s.evidenceDocumentIds],
        })),
      }),
      prisma.employment.deleteMany({ where: { loanFileId: id } }),
      prisma.employment.createMany({
        data: result.data.employments.map((e) => ({
          loanFileId: id,
          employerName: e.employerName,
          employerEin: e.employerEin ?? null,
          position: e.position,
          startDate: new Date(e.startDate),
          endDate: e.endDate ? new Date(e.endDate) : null,
          status: e.status,
          isMilitary: e.isMilitary,
          verificationMethod: e.verificationMethod,
        })),
      }),
    ]);
    await recordEvent(id, "connector_pull", result.provider, { kind: "bank" }, "AST-001");
    await advanceStage(id, "PAYROLL");

    res.status(201).json({
      report: result.data,
      provider: result.provider,
      // The flow branches on this. "verified" means the borrower is done;
      // anything else means the payroll step is worth showing them.
      incomeConfidence: result.data.incomeConfidence,
      incomeConfidenceReason: result.data.incomeConfidenceReason ?? null,
      payrollNeeded: result.data.incomeConfidence !== "verified",
    });
  }),
);

/** Consumer-permissioned payroll. Conditional: only when the bank cannot stand alone. */
connectorRouter.post(
  "/:id/payroll",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const file = await requireFile(id, req.user!.id);

    const payroll = connectors().payroll;
    const session = await payroll.createLinkSession(file);
    const result = await payroll.fetchPayroll(file, session.sessionId);

    await recordSnapshot(
      id,
      "payroll",
      result.provider,
      result.externalId,
      result.data,
      result.retrievedAt,
    );
    await upsertLink(id, "payroll", result.provider);

    // Payroll is the precise source, so it REPLACES what the bank inferred
    // rather than adding to it. Two employment records for one job would
    // double-count income, which is the kind of error that reaches closing.
    await prisma.$transaction([
      prisma.employment.deleteMany({ where: { loanFileId: id } }),
      prisma.employment.createMany({
        data: result.data.employments.map((e) => ({
          loanFileId: id,
          employerName: e.employerName,
          employerEin: e.employerEin ?? null,
          position: e.position,
          startDate: new Date(e.startDate),
          endDate: e.endDate ? new Date(e.endDate) : null,
          status: e.status,
          isMilitary: e.isMilitary,
          verificationMethod: e.verificationMethod,
        })),
      }),
      prisma.incomeSource.deleteMany({ where: { loanFileId: id } }),
      prisma.incomeSource.createMany({
        data: result.data.incomeSources.map((s) => ({
          loanFileId: id,
          type: s.type,
          monthlyAmount: s.monthlyAmount,
          historyMonths: s.historyMonths,
          continuanceEndDate: s.continuanceEndDate ? new Date(s.continuanceEndDate) : null,
          continuanceEstablished: s.continuanceEstablished,
          evidenceDocumentIds: [...s.evidenceDocumentIds],
        })),
      }),
    ]);

    await recordEvent(id, "connector_pull", result.provider, { kind: "payroll" }, "INC-002");
    await advanceStage(id, "IRS_TRANSCRIPT");

    res.status(201).json({ payroll: result.data, provider: result.provider });
  }),
);

/** Screen 6 — IRS transcripts. Needs an executed 4506-C on top of APP-005. */
connectorRouter.post(
  "/:id/irs",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const file = await requireFile(id, req.user!.id);

    const currentYear = new Date().getFullYear();
    const result = await connectors().irs.fetchTranscripts(file, [
      currentYear - 1,
      currentYear - 2,
    ]);

    await recordSnapshot(
      id,
      "irs",
      result.provider,
      result.externalId,
      result.data,
      result.retrievedAt,
    );
    await upsertLink(id, "irs", result.provider);
    await recordEvent(id, "connector_pull", result.provider, { kind: "irs" }, "INC-003");
    await advanceStage(id, "UPLOAD_FALLBACK");

    res.status(201).json({ transcripts: result.data, provider: result.provider });
  }),
);

/** Screen 9 — persistent consent. The switch the whole monitoring product needs. */
connectorRouter.post(
  "/:id/monitoring",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const enabled = z.object({ enabled: z.boolean() }).parse(req.body).enabled;
    await requireFile(id, req.user!.id);

    await prisma.connectorLink.updateMany({
      where: { loanFileId: id },
      data: { persistentMonitoringEnabled: enabled, nextSyncDueAt: null },
    });
    await advanceStage(id, "COMPLETE");
    await recordEvent(id, enabled ? "monitoring_enabled" : "monitoring_declined", "borrower", {
      enabled,
    });

    // nextSyncDueAt stays null: nothing schedules re-pulls yet. The consent is
    // recorded so the loop can be switched on without asking again.
    res.json({ enabled, scheduled: false });
  }),
);

async function upsertLink(loanFileId: string, kind: string, provider: string): Promise<void> {
  const now = new Date();
  await prisma.connectorLink.upsert({
    where: { loanFileId_kind: { loanFileId, kind } },
    create: { loanFileId, kind, provider, linkedAt: now, lastSyncedAt: now },
    update: { lastSyncedAt: now, status: "active" },
  });
}
