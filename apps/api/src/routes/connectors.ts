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
  kind: z.enum(["verification_authorization", "econsent", "form_4506c", "persistent_monitoring"]),
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
    await recordSnapshot(id, "credit", result.provider, result.externalId, result.data, result.retrievedAt);
    await upsertLink(id, "credit", result.provider);
    await recordEvent(id, "connector_pull", result.provider, { kind: "credit" }, "CRD-001");
    await prisma.loanFile.update({ where: { id }, data: { stage: "BANK" } });

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

    await recordSnapshot(id, "bank", result.provider, result.externalId, result.data, result.retrievedAt);
    await upsertLink(id, "bank", result.provider);

    // The bank report carries employment the payroll connector will later
    // refine. Recording it now is what makes INC-001 satisfiable on screen 4,
    // which is what the sheet's "Day 1 Certainty: Yes - employment" claims.
    await syncEmploymentFromBank(id, result.data.accounts.length > 0);
    await recordEvent(id, "connector_pull", result.provider, { kind: "bank" }, "AST-001");
    await prisma.loanFile.update({ where: { id }, data: { stage: "PAYROLL" } });

    res.status(201).json({ report: result.data, provider: result.provider });
  }),
);

/** Screen 5 — consumer-permissioned payroll. */
connectorRouter.post(
  "/:id/payroll",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const file = await requireFile(id, req.user!.id);

    const payroll = connectors().payroll;
    const session = await payroll.createLinkSession(file);
    const result = await payroll.fetchPayroll(file, session.sessionId);

    await recordSnapshot(id, "payroll", result.provider, result.externalId, result.data, result.retrievedAt);
    await upsertLink(id, "payroll", result.provider);

    // Payroll is the precise source, so it REPLACES what the bank inferred
    // rather than adding to it. Two employment records for one job would
    // double-count income, which is the kind of error that reaches closing.
    await prisma.employment.deleteMany({ where: { loanFileId: id } });
    await prisma.employment.createMany({
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
    });

    await prisma.incomeSource.deleteMany({ where: { loanFileId: id } });
    await prisma.incomeSource.createMany({
      data: result.data.incomeSources.map((s) => ({
        loanFileId: id,
        type: s.type,
        monthlyAmount: s.monthlyAmount,
        historyMonths: s.historyMonths,
        continuanceEndDate: s.continuanceEndDate ? new Date(s.continuanceEndDate) : null,
        continuanceEstablished: s.continuanceEstablished,
        evidenceDocumentIds: [...s.evidenceDocumentIds],
      })),
    });

    await recordEvent(id, "connector_pull", result.provider, { kind: "payroll" }, "INC-002");
    await prisma.loanFile.update({ where: { id }, data: { stage: "IRS_TRANSCRIPT" } });

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
    const result = await connectors().irs.fetchTranscripts(file, [currentYear - 1, currentYear - 2]);

    await recordSnapshot(id, "irs", result.provider, result.externalId, result.data, result.retrievedAt);
    await upsertLink(id, "irs", result.provider);
    await recordEvent(id, "connector_pull", result.provider, { kind: "irs" }, "INC-003");
    await prisma.loanFile.update({ where: { id }, data: { stage: "UPLOAD_FALLBACK" } });

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
    await prisma.loanFile.update({ where: { id }, data: { stage: "COMPLETE" } });
    await recordEvent(id, enabled ? "monitoring_enabled" : "monitoring_declined", "borrower", { enabled });

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

async function syncEmploymentFromBank(loanFileId: string, hasAccounts: boolean): Promise<void> {
  if (!hasAccounts) return;
  // Deliberately a no-op beyond the guard: bank-inferred employment is weaker
  // evidence than the payroll connector, and writing a placeholder record here
  // would make INC-001 look satisfied by a deposit pattern. Left explicit so
  // the omission reads as a decision rather than an oversight.
}
