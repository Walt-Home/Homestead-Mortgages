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
import { reconcileIncomeAndEmployment } from "../services/income.js";
import { assertSignsForThemselves, retrievalSubject, tokenFor } from "../services/authorization.js";
import { borrowingRoleFor } from "../services/borrower-order.js";
import { signedOn } from "../services/signature.js";
import { advanceStage } from "../services/stage.js";
import { applicationForFile, ensureApplicationParty } from "../services/applications.js";
import {
  settleBorrowerAct,
  settleReconciledEvidence,
  type BorrowerActReason,
} from "../services/standing.js";
import type { Db } from "../services/db.js";

export const connectorRouter = Router();

/**
 * Load a file the caller is allowed to WRITE. Every route in this module
 * mutates — a connector pull writes a snapshot — so there is no read-only
 * variant here on purpose.
 */
async function requireFile(id: string, userId: string) {
  // "self": a pull is about the person asking — `retrievalSubject` resolves
  // them by party — so a co-borrower on the file makes their own, under
  // their own authorization, and never the applicant's.
  await assertFileAccess(id, userId, "self");
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
    // "self", not the module's write helper: a consent is one person's
    // signature about themselves, and a co-borrower on the file gives their
    // own. The rule below that the borrower named must be the person
    // sending is what keeps it theirs.
    await assertFileAccess(id, req.user!.id, "self");

    // The borrower must be THIS file's, or the row would name a person the
    // caller has no file for — and the trigger mirrors the grant onto whoever
    // the borrower row points at. Their own row, and their own signature: the
    // consent below is written against this borrower and nobody else's.
    const borrower = await prisma.borrower.findFirst({
      where: { id: input.borrowerId, loanFileId: id },
      select: { partyId: true },
    });
    if (!borrower) throw new AppError(404, "That borrower is not on this file.", "NOT_FOUND");
    // And the borrower must be the person sending this. Recording a consent is
    // recording a signature, and the applicant holds the only session on a
    // joint file — so without this they could authorize a credit pull and a
    // tax-transcript request in the co-borrower's name.
    await assertSignsForThemselves(req.user!.id, borrower.partyId);

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
          // The role this person holds on the file, which is not always the
          // primary's: on a file whose Borrower 1 has been replaced, the
          // person signing is a borrower who is no longer the first one.
          // Naming PRIMARY_BORROWER outright put them on as a SECOND
          // applicant — the ordinal allocator hands one the next free position
          // rather than refusing — and the receipt counts any primary's
          // party-side pieces, so their three would have opened the Loan
          // Estimate clock.
          const role = await borrowingRoleFor(tx, id, borrower.partyId);
          await ensureApplicationParty(tx, app.id, borrower.partyId, role);
          // The PERSON, not this file. The grant this consent mints is what
          // licenses borrowing their facts anywhere, so it can complete the
          // six pieces of an application on a file they started last month and
          // left at screen 1 — which has an address and a value and needed
          // only a name, an SSN and an income. Pinning only this file's
          // application left that one at draft with nothing pinned to it,
          // while all three facts and a live grant existed. The membership is
          // written first so this file's own application is one of the ones
          // reconciled, and the settle follows the reconciliation wherever it
          // went. Screens 1 and 2 do exactly this.
          await settleReconciledEvidence(tx, {
            partyId: borrower.partyId,
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

    // Whose credit this is, resolved once and used for the token AND for the
    // snapshot's subject. Two separate resolutions in one handler is how a
    // pull authorized for one person gets recorded against another.
    //
    // The person who pressed Connect, not the file's first row. The screen
    // sends no borrower id, so a subscript here made one borrower's press pull
    // the other's credit report.
    const subject = await retrievalSubject(file, req.user!.id);
    const result = await connectors().credit.pullTriMerge(
      file,
      await tokenFor(file, subject, "credit_report"),
    );
    await recordSnapshot(
      id,
      "credit",
      result.provider,
      result.externalId,
      result.data,
      result.retrievedAt,
      subject.partyId,
    );
    await upsertLink(id, "credit", result.provider, subject.partyId);
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
          // A bureau's mortgage tradeline carries neither a note rate nor an
          // escrow split. It used to be written as 0, which is not an absence:
          // APP-019 published a rate delta of (0 - 6.25) with no derivation
          // behind it. Null is what we actually know.
          existingRate: null,
          existingMonthlyPayment: mortgage.monthlyPayment,
          // And what that payment IS. The bureau reports the SCHEDULED payment,
          // which on an escrowed loan includes taxes and insurance; the recoup
          // subtracts the new loan's P&I from it, so calling it P&I overstates
          // the saving by the whole old escrow. APP-019 blocks on this basis
          // until a statement or the borrower supplies the P&I.
          existingPaymentBasis: "scheduled_payment",
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

/** The bank screen — the 12-month asset report. The one that matters. */
connectorRouter.post(
  "/:id/bank",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const file = await requireFile(id, req.user!.id);

    // Whose assets these are: the borrower doing the connecting, resolved by
    // party. `connector_links` is unique on (file, kind), so a second borrower
    // cannot link a bank of their own today — which is a reason to name the
    // subject once rather than a reason not to.
    const subject = await retrievalSubject(file, req.user!.id);
    const bank = connectors().bank;
    const publicToken = req.body?.publicToken as string | undefined;
    let sessionId = req.body?.sessionId as string | undefined;

    // Only open a session when the client does not already hold one. The
    // borrower polls this route while the report assembles, and minting a new
    // link token on every poll would both bill for sessions nobody opens and
    // hand back a token that invalidates the one Link is using.
    if (!sessionId && !publicToken) {
      const session = await bank.createLinkSession(
        file,
        await tokenFor(file, subject, "bank_transactions"),
      );
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
      await tokenFor(file, subject, "bank_transactions"),
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

    // The report, what it says about income and employment, and the move it
    // implies are one act. The borrower connected their bank; either all of
    // that is true afterwards or none of it is, because a file holding a
    // twelve-month asset report while its application still says "connect your
    // bank" is a file whose state contradicts its own evidence.
    //
    // Income and employment are reconciled rather than merged: a re-pull is the
    // newer truth about the same twelve months, so what this report names is
    // updated in place and what it stops naming is retired. Merging would
    // double the income.
    await prisma.$transaction(async (tx) => {
      const snapshot = await recordSnapshot(
        id,
        "bank",
        result.provider,
        result.externalId,
        result.data,
        result.retrievedAt,
        subject.partyId,
        tx,
      );
      await upsertLink(id, "bank", result.provider, subject.partyId, tx);

      // The bank report carries income and employment, not just assets — the
      // sheet says so ("Assets + income + employment + cash flow + rent
      // history") and the real vendors behave that way. Writing them here is
      // what lets a salaried borrower reach a decision without a payroll step.
      await reconcileIncomeAndEmployment(tx, {
        loanFileId: id,
        partyId: subject.partyId,
        snapshotId: snapshot.id,
        reported: result.data,
        now: new Date(result.retrievedAt),
      });
      await recordEvent(id, "connector_pull", result.provider, { kind: "bank" }, "AST-001", tx);

      await settleBranch(tx, id, subject.partyId, "bank_connected", {
        causedBy: `snapshot:${snapshot.id}`,
        // A file whose receipt fired late never got an obligation to satisfy.
        // Connecting the bank is then where work begins.
        beginsWorkFromIntake: true,
      });
    });
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

    // Whose employment this is, resolved before the session so the token, the
    // snapshot and the income rows all name one person — and resolved from the
    // person asking, because this branch is entered from their own screen.
    const subject = await retrievalSubject(file, req.user!.id);
    const payroll = connectors().payroll;
    const payrollToken = await tokenFor(file, subject, "payroll_income");
    const session = await payroll.createLinkSession(file, payrollToken);
    const result = await payroll.fetchPayroll(file, payrollToken, session.sessionId);

    // Payroll is the precise source, so it REPLACES what the bank inferred
    // rather than adding to it. Two employment records for one job would
    // double-count income, which is the kind of error that reaches closing.
    // The employer survives that replacement: payroll carries the EIN the bank
    // never had, so the row the bank created is promoted rather than twinned.
    await prisma.$transaction(async (tx) => {
      const snapshot = await recordSnapshot(
        id,
        "payroll",
        result.provider,
        result.externalId,
        result.data,
        result.retrievedAt,
        subject.partyId,
        tx,
      );
      await upsertLink(id, "payroll", result.provider, subject.partyId, tx);

      await reconcileIncomeAndEmployment(tx, {
        loanFileId: id,
        partyId: subject.partyId,
        snapshotId: snapshot.id,
        reported: result.data,
        now: new Date(result.retrievedAt),
      });
      await recordEvent(id, "connector_pull", result.provider, { kind: "payroll" }, "INC-002", tx);
      await settleBranch(tx, id, subject.partyId, "payroll_connected", {
        causedBy: `snapshot:${snapshot.id}`,
      });
    });
    await advanceStage(id, "IRS_TRANSCRIPT");

    res.status(201).json({ payroll: result.data, provider: result.provider });
  }),
);

/**
 * Screen 6 — IRS transcripts. Needs an executed 4506-C on top of APP-005.
 *
 * One taxpayer per pull, because Form 4506-C names one. The request may say
 * which borrower, and the token is minted from that person's own signature ON
 * THIS FILE — so a file where the applicant has signed and the co-borrower has
 * not answers 403 for the co-borrower rather than pulling their transcripts on
 * a 4506-C they executed for some other application. Naming a subject is a
 * question, and the minter is what answers it.
 *
 * Saying nothing means the person asking. The transcript screen posts no
 * borrower id, and on a file whose Borrower 1 has been replaced the borrower
 * reading that screen is not the first row — so the default is their own
 * records rather than the document's first taxpayer.
 */
const irsSchema = z.object({ borrowerId: z.string().uuid().optional() });

connectorRouter.post(
  "/:id/irs",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const { borrowerId } = irsSchema.parse(req.body ?? {});
    const file = await requireFile(id, req.user!.id);

    const subject = await retrievalSubject(file, req.user!.id, borrowerId);
    const currentYear = new Date().getFullYear();
    const result = await connectors().irs.fetchTranscripts(
      file,
      await tokenFor(file, subject, "tax_transcript"),
      [currentYear - 1, currentYear - 2],
    );

    await prisma.$transaction(async (tx) => {
      const snapshot = await recordSnapshot(
        id,
        "irs",
        result.provider,
        result.externalId,
        result.data,
        result.retrievedAt,
        subject.partyId,
        tx,
      );
      await upsertLink(id, "irs", result.provider, subject.partyId, tx);
      await recordEvent(id, "connector_pull", result.provider, { kind: "irs" }, "INC-003", tx);
      // The pull is ours to make, but the borrower's signature is what
      // licensed it, so the act is recorded as theirs — the same person the
      // token was minted for, and not the file's first borrower by subscript.
      await settleBranch(tx, id, subject.partyId, "transcripts_received", {
        causedBy: `snapshot:${snapshot.id}`,
      });
    });
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

/**
 * The borrower supplied something: settle it against the application.
 *
 * Shared by all three pulls in this module because they do the same thing to
 * the application and differ only in the word the ledger records. A file with
 * no application — one created before the join existed — is left alone rather
 * than given one, and a file with no borrower row has nobody to name as the
 * actor.
 */
async function settleBranch(
  tx: Db,
  loanFileId: string,
  partyId: string | undefined,
  reasonCode: BorrowerActReason,
  opts: { causedBy: string; beginsWorkFromIntake?: boolean },
): Promise<void> {
  if (!partyId) return;
  const app = await applicationForFile(tx, loanFileId);
  if (!app) return;
  await settleBorrowerAct(tx, {
    applicationId: app.id,
    loanFileId,
    partyId,
    reasonCode,
    ...opts,
  });
}

/**
 * One link per person per kind. A co-borrower's bank is a second `bank`
 * link on the same file, in their party's name, beside the applicant's.
 */
async function upsertLink(
  loanFileId: string,
  kind: string,
  provider: string,
  partyId: string,
  db: Db = prisma,
): Promise<void> {
  const now = new Date();
  await db.connectorLink.upsert({
    where: { loanFileId_kind_partyId: { loanFileId, kind, partyId } },
    create: { loanFileId, kind, provider, partyId, linkedAt: now, lastSyncedAt: now },
    update: { lastSyncedAt: now, status: "active" },
  });
}
