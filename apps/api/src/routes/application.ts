/**
 * Step 2's identity check and step 4's signature.
 *
 * The four-step flow moves two things that used to be their own screens:
 *
 * Identity verification joins step 2, because "prove you are who you say"
 * belongs beside the fields it is proving. APP-001's evidence column asks for
 * a government photo ID, and typed fields have never been that.
 *
 * The 4506-C stops being a screen at all. It is one of the documents the
 * borrower signs when they sign the application in step 4, which is what
 * happens on paper — nobody signs a 4506-C in isolation. Once signed, the
 * transcripts are pulled server-side with no step in front of them.
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
import { applicationForFile } from "../services/applications.js";
import { settleBorrowerAct } from "../services/standing.js";

export const applicationRouter = Router();

/* ── Identity verification (step 2) ───────────────────────────────────── */

applicationRouter.post(
  "/:id/identity-verification",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    await assertFileAccess(id, req.user!.id, "write");

    const file = await loadLoanFile(id);
    const borrower = file?.borrowers[0];
    if (!borrower) {
      throw new AppError(409, "Tell us who you are first.", "NO_BORROWER");
    }
    if (borrower.identityVerification?.status === "verified") {
      res.json({ alreadyVerified: true, verifiedAt: borrower.identityVerification.verifiedAt });
      return;
    }

    const identity = connectors().identity;

    /*
     * Adopt the check the borrower already passed.
     *
     * With a hosted vendor the ID is verified at the TOP of screen 2, before a
     * borrower row exists — so the session is recorded against the file. By
     * the time Continue is pressed the row exists and is unverified, and
     * without this the route dutifully starts a second verification and sends
     * the borrower back to Stripe to do the whole thing again. It did exactly
     * that, twice, before this existed.
     */
    const prefill = await prisma.loanFile.findUnique({
      where: { id },
      select: { identityPrefillVerificationId: true },
    });
    if (prefill?.identityPrefillVerificationId) {
      const existing = await identity.getVerification(prefill.identityPrefillVerificationId);
      if (existing?.status === "verified") {
        await prisma.borrower.update({
          where: { id: borrower.id },
          data: {
            identityVerificationId: prefill.identityPrefillVerificationId,
            identityVerificationStatus: "verified",
            identityVerifiedAt: new Date(),
          },
        });
        await recordEvent(id, "identity_verified", "borrower", { adopted: true }, "APP-001");
        res.json({ alreadyVerified: true, verifiedAt: existing.verifiedAt });
        return;
      }
    }

    const session = await identity.createVerificationSession(file!, borrower.id);
    await prisma.borrower.update({
      where: { id: borrower.id },
      data: {
        identityVerificationId: session.verificationId,
        identityVerificationStatus: "pending",
      },
    });

    // A fixture finishes in place; a hosted vendor sends the borrower away and
    // brings them back on a fresh page load. The client cannot guess which,
    // and guessing wrong means either a dead redirect or a verification that
    // is never completed.
    const requiresRedirect = identity.capabilities.mode !== "fixture";
    res.status(201).json({ alreadyVerified: false, requiresRedirect, ...session });
  }),
);

applicationRouter.post(
  "/:id/identity-verification/complete",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const { verificationId } = z.object({ verificationId: z.string().min(1) }).parse(req.body);
    await assertFileAccess(id, req.user!.id, "write");

    // Scoped to this file's borrower, so a session id from elsewhere cannot be
    // completed against this application.
    const borrower = await prisma.borrower.findFirst({
      where: { loanFileId: id, identityVerificationId: verificationId },
      select: { id: true },
    });
    if (!borrower) throw new AppError(404, "That verification was not found.", "NOT_FOUND");

    const result = await connectors().identity.getVerification(verificationId);
    if (!result) throw new AppError(404, "That verification was not found.", "NOT_FOUND");

    await prisma.borrower.update({
      where: { id: borrower.id },
      data: {
        identityVerificationStatus: result.status,
        identityVerifiedAt: result.status === "verified" ? new Date() : null,
      },
    });
    await recordEvent(id, "identity_verified", "borrower", { status: result.status }, "APP-001");

    // "pending" is a real answer here, not a failure. Stripe processes a
    // document asynchronously, so a borrower can land back on our page before
    // the result exists — telling them it failed would be false, and telling
    // them it succeeded would be worse.
    res.json({
      status: result.status,
      verifiedAt: result.verifiedAt,
      failureReason: result.failureReason ?? null,
    });
  }),
);

/* ── Signing the application (step 4) ─────────────────────────────────── */

/**
 * What signing the application actually covers.
 *
 * On paper a borrower signs a package, not a form at a time. The 4506-C is
 * part of that package, which is why it is here rather than on a screen of its
 * own — and why the IRS pull that depends on it can happen immediately after
 * with nothing for the borrower to do.
 */
const SIGNED_DOCUMENTS = ["form_4506c"] as const;

applicationRouter.post(
  "/:id/sign-application",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    await assertFileAccess(id, req.user!.id, "write");

    const file = await loadLoanFile(id);
    if (!file) throw new AppError(404, "Loan file not found", "NOT_FOUND");
    const borrower = file.borrowers[0];
    if (!borrower) throw new AppError(409, "Nothing to sign yet.", "NO_BORROWER");

    // Demographics are required before signing: Regulation B wants them
    // requested on the application, and the application is what is being
    // signed. Refusing here is the only place that ordering is enforceable.
    const d = borrower.demographics;
    const answered = (v: readonly string[] | string | undefined) =>
      v === "declined" || (Array.isArray(v) ? v.length > 0 : Boolean(v));
    if (!d || !answered(d.ethnicity) || !answered(d.race) || !answered(d.sex)) {
      throw new AppError(
        409,
        "The demographic questions have to be answered or declined before signing.",
        "DEMOGRAPHICS_REQUIRED",
      );
    }

    const esign = connectors().esign;
    const signed: string[] = [];
    for (const kind of SIGNED_DOCUMENTS) {
      // Skipped only when this file's row AND the party's grant are both live.
      // A 4506-C signed on this file more than 120 days ago has a row and no
      // grant, and skipping it here left the transcript pull below with
      // nothing to mint from — the signature succeeded and the transcripts
      // never came. See services/signature.ts.
      if (await signedOn(id, borrower.partyId, kind)) continue;
      const envelope = await esign.createEnvelope(file, kind, borrower.id);
      const consent = await esign.getCompletedConsent(envelope.envelopeId);
      if (!consent) continue;
      await prisma.consent.create({
        data: {
          loanFileId: id,
          borrowerId: borrower.id,
          kind,
          grantedAt: new Date(),
          envelopeId: envelope.envelopeId,
          ipAddress: req.ip ?? "unknown",
          userAgent: req.get("user-agent") ?? "unknown",
        },
      });
      signed.push(kind);
    }

    // The signature and the move it causes, in one transaction.
    //
    // They used to be three writes in a row, and a crash between the first and
    // the last left a file signed with its application still waiting on the
    // borrower for the signature it already has — a state nothing else can
    // repair, because the signature latch is set and no route sets it twice.
    //
    // Signing is the borrower supplying the last thing that was theirs to
    // supply, so the ball leaves their court here. `underwriting_began` is
    // deliberately NOT written: the decision the review screen asks for next
    // writes it, and one edge wants one writer.
    await prisma.$transaction(async (tx) => {
      await tx.loanFile.update({ where: { id }, data: { applicationSignedAt: new Date() } });
      await recordEvent(id, "application_signed", "borrower", { documents: signed }, undefined, tx);

      const app = await applicationForFile(tx, id);
      if (app) {
        await settleBorrowerAct(tx, {
          applicationId: app.id,
          loanFileId: id,
          partyId: borrower.partyId,
          reasonCode: "application_signed",
          causedBy: "event:application_signed",
        });
      }
    });

    // The transcripts need no screen now that the 4506-C is signed. Failing
    // here must not fail the signature — the application is signed either way,
    // and a transcript that did not arrive is a condition, not a dead end.
    let transcripts: unknown = null;
    let transcriptError: string | null = null;
    try {
      const refreshed = await loadLoanFile(id);
      const year = new Date().getFullYear();
      const result = await connectors().irs.fetchTranscripts(
        refreshed!,
        await tokenFor(refreshed!, "tax_transcript"),
        [year - 1, year - 2],
      );
      await recordSnapshot(
        id,
        "irs",
        result.provider,
        result.externalId,
        result.data,
        result.retrievedAt,
      );
      transcripts = result.data;
      await recordEvent(id, "connector_pull", result.provider, { kind: "irs" }, "INC-003");
    } catch (err) {
      transcriptError = err instanceof Error ? err.message : "transcripts unavailable";
    }

    await advanceStage(id, "DECISION");
    res.status(201).json({ signed, transcripts, transcriptError });
  }),
);
