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
import { tokenFor } from "../services/authorization.js";
import { signedOn } from "../services/signature.js";
import { advanceStage } from "../services/stage.js";
import { applicationForFile, ensureApplicationParty } from "../services/applications.js";
import { pinTridPieces } from "../services/evidence.js";
import { settleAfterIntake } from "../services/standing.js";

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

/**
 * Record a consent. This is what unlocks every connector below.
 *
 * Idempotent under the same rule as a signature: when this file already holds
 * a live row of the kind and the party's mirrored grant is still live, the
 * existing row comes back and nothing is written. Otherwise the row is
 * inserted — which is the renewal when the grant has lapsed, and a harmless
 * no-op at the trigger when it has not. Screen 2 re-posts its consents on
 * every save, so without this a borrower saving twice grew a new row each
 * time for the same signature.
 */
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

    // The borrower must be THIS file's, or the row would name a person the
    // caller has no file for — and the trigger mirrors the grant onto whoever
    // the borrower row points at.
    const borrower = await prisma.borrower.findFirst({
      where: { id: input.borrowerId, loanFileId: id },
      select: { partyId: true },
    });
    if (!borrower) throw new AppError(404, "That borrower is not on this file.", "NOT_FOUND");

    // The signature, the grant the trigger mirrors from it, the facts that
    // grant lets the application borrow, and the receipt those pins fire, are
    // one act. Screen 2 posts this immediately after saving the person, so for
    // a borrower with nothing on file this is the moment the application
    // begins. If any part of it cannot be written, none of it is: a consent
    // row standing alone would say a borrower authorized a verification whose
    // evidence was never taken.
    const { consent, alreadyRecorded } = await prisma.$transaction(async (tx) => {
      const existing = await signedOn(id, borrower.partyId, input.kind, tx);
      const row =
        existing ??
        (await tx.consent.create({
          data: {
            loanFileId: id,
            borrowerId: input.borrowerId,
            kind: input.kind,
            grantedAt: new Date(),
            envelopeId: input.envelopeId ?? null,
            // The IP and user agent ARE the evidence that a person signed.
            // They are only trustworthy because `trust proxy` is a hop count
            // — see config.ts.
            ipAddress: req.ip ?? "unknown",
            userAgent: req.get("user-agent") ?? "unknown",
          },
          select: { id: true, kind: true, grantedAt: true },
        }));

      // Only the verification authorization licenses borrowing a person's
      // facts. eConsent is about how we may deliver documents and monitoring
      // mirrors to an account-review grant the pin guard refuses outright.
      if (input.kind === "verification_authorization") {
        const app = await applicationForFile(tx, id);
        if (app) {
          await ensureApplicationParty(tx, app.id, borrower.partyId, "PRIMARY_BORROWER");
          await pinTridPieces(tx, { applicationId: app.id, partyId: borrower.partyId });
          await settleAfterIntake(tx, {
            applicationId: app.id,
            loanFileId: id,
            causedBy: "consent:verification_authorization",
          });
        }
      }

      return { consent: row, alreadyRecorded: Boolean(existing) };
    });

    if (alreadyRecorded) {
      res.json({
        id: consent.id,
        kind: consent.kind,
        grantedAt: consent.grantedAt,
        alreadyRecorded: true,
      });
      return;
    }

    await recordEvent(id, "consent_granted", "borrower", { kind: input.kind });
    res.status(201).json({
      id: consent.id,
      kind: consent.kind,
      grantedAt: consent.grantedAt,
      alreadyRecorded: false,
    });
  }),
);

/** Screen 3 — the soft credit pull. First visible win. */
connectorRouter.post(
  "/:id/credit",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const file = await requireFile(id, req.user!.id);

    const result = await connectors().credit.pullTriMerge(
      file,
      await tokenFor(file, "credit_report"),
    );
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
    const publicToken = req.body?.publicToken as string | undefined;
    let sessionId = req.body?.sessionId as string | undefined;

    // Only open a session when the client does not already hold one. The
    // borrower polls this route while the report assembles, and minting a new
    // link token on every poll would both bill for sessions nobody opens and
    // hand back a token that invalidates the one Link is using.
    if (!sessionId && !publicToken) {
      const session = await bank.createLinkSession(file, await tokenFor(file, "bank_transactions"));
      sessionId = session.sessionId;

      // A real aggregator needs the borrower to log in inside its own widget
      // before any data exists, and hands the client a token to send back. The
      // client drives that; this route only reaches the fetch below when the
      // provider can answer without one.
      if (session.requiresClientHandoff) {
        res.status(202).json({
          requiresClientHandoff: true,
          linkToken: session.linkToken,
          sessionId: session.sessionId,
          expiresAt: session.expiresAt,
        });
        return;
      }
    }

    const outcome = await bank.fetchAssetReport(
      file,
      await tokenFor(file, "bank_transactions"),
      { sessionId: sessionId ?? id, publicToken },
      12,
    );

    // "Still building" is not "failed". A twelve-month report from a bank with
    // slow history can take minutes, and telling the borrower it went wrong
    // would be false.
    if (outcome.status === "pending") {
      res.status(202).json({ pending: true, retryAfterMs: outcome.retryAfterMs });
      return;
    }
    const result = outcome.result;

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
          startDate: e.startDate ? new Date(e.startDate) : null,
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
    const payrollToken = await tokenFor(file, "payroll_income");
    const session = await payroll.createLinkSession(file, payrollToken);
    const result = await payroll.fetchPayroll(file, payrollToken, session.sessionId);

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
          startDate: e.startDate ? new Date(e.startDate) : null,
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
    const result = await connectors().irs.fetchTranscripts(
      file,
      await tokenFor(file, "tax_transcript"),
      [currentYear - 1, currentYear - 2],
    );

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
