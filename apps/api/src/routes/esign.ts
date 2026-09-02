/**
 * Signing things.
 *
 * Three requirements in Drew's sheet are satisfied by a signature and nothing
 * else: APP-005 (authorization to verify), APP-012 (eConsent) and INC-008 (the
 * 4506-C). The connector port and a fixture adapter for them existed from the
 * start; nothing ever called them, so INC-008 could not be satisfied and the
 * IRS screen was a hard dead end with screens 6 through 9 unreachable behind
 * it. This is the missing caller.
 *
 * Two steps rather than one, even for a fixture. A real vendor hands back a
 * URL, the borrower signs somewhere else, and completion arrives later — a
 * one-shot "sign this" endpoint would model a flow that does not exist and
 * would have to be pulled apart the day Docusign is wired in.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "@hm/db";
import { AppError, asyncRoute } from "../middleware/error-handler.js";
import { assertFileAccess, loadLoanFile, recordEvent } from "../services/repository.js";
import { connectors } from "../services/connectors.js";

export const esignRouter = Router();

/** Only these are signable. `persistent_monitoring` is an opt-in, not a signature. */
const SIGNABLE = [
  "verification_authorization",
  "econsent",
  "form_4506c",
  "application_signature",
] as const;

const REQUIREMENT_FOR: Record<(typeof SIGNABLE)[number], string> = {
  verification_authorization: "APP-005",
  econsent: "APP-012",
  form_4506c: "INC-008",
  // Screen 4. APP-012 covers electronic delivery; this is the signature on
  // the application itself.
  application_signature: "APP-006",
};

const startSchema = z.object({ kind: z.enum(SIGNABLE) });

esignRouter.post(
  "/:id/esign",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const { kind } = startSchema.parse(req.body);
    await assertFileAccess(id, req.user!.id, "write");

    const file = await loadLoanFile(id);
    if (!file) throw new AppError(404, "Loan file not found", "NOT_FOUND");

    const borrower = file.borrowers[0];
    if (!borrower) {
      throw new AppError(
        409,
        "There is nobody to sign yet — finish the identity step first.",
        "NO_BORROWER",
      );
    }

    // Already signed is a success, not an error. A person who refreshes the
    // signing screen should not be told something went wrong.
    const existing = file.consents.find((c) => c.kind === kind && !c.revokedAt);
    if (existing) {
      res.json({ alreadySigned: true, kind, signedAt: existing.grantedAt });
      return;
    }

    const envelope = await connectors().esign.createEnvelope(file, kind, borrower.id);
    res.status(201).json({
      alreadySigned: false,
      kind,
      requirementId: REQUIREMENT_FOR[kind],
      envelopeId: envelope.envelopeId,
      signingUrl: envelope.signingUrl,
    });
  }),
);

const completeSchema = z.object({ envelopeId: z.string().min(1) });

esignRouter.post(
  "/:id/esign/complete",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const { envelopeId } = completeSchema.parse(req.body);
    await assertFileAccess(id, req.user!.id, "write");

    const consent = await connectors().esign.getCompletedConsent(envelopeId);
    if (!consent) {
      throw new AppError(404, "That signing session was not found.", "ENVELOPE_NOT_FOUND");
    }
    if (!SIGNABLE.includes(consent.kind as (typeof SIGNABLE)[number])) {
      throw new AppError(400, "That is not a signable document.", "NOT_SIGNABLE");
    }

    // The envelope id names the borrower, and the borrower must belong to THIS
    // file. Without this check a valid envelope from one file could be
    // completed against another — the ids are guessable by construction in the
    // fixture, and a real vendor's would still not be scoped to our files.
    const borrower = await prisma.borrower.findFirst({
      where: { id: consent.borrowerId, loanFileId: id },
      select: { id: true },
    });
    if (!borrower) {
      throw new AppError(404, "That signing session was not found.", "ENVELOPE_NOT_FOUND");
    }

    const existing = await prisma.consent.findFirst({
      where: { loanFileId: id, kind: consent.kind, revokedAt: null },
    });
    if (existing) {
      res.json({ kind: consent.kind, signedAt: existing.grantedAt, alreadySigned: true });
      return;
    }

    const created = await prisma.consent.create({
      data: {
        loanFileId: id,
        borrowerId: borrower.id,
        kind: consent.kind,
        grantedAt: new Date(),
        envelopeId,
        // The IP and user agent ARE the evidence a person signed. They are only
        // trustworthy because `trust proxy` is a hop count — see config.ts.
        ipAddress: req.ip ?? "unknown",
        userAgent: req.get("user-agent") ?? "unknown",
      },
    });

    await recordEvent(
      id,
      "document_signed",
      "borrower",
      { kind: consent.kind, envelopeId },
      REQUIREMENT_FOR[consent.kind as (typeof SIGNABLE)[number]],
    );

    res.status(201).json({
      kind: created.kind,
      signedAt: created.grantedAt,
      alreadySigned: false,
    });
  }),
);
