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
 *
 * All of which is about ONE signer. Form 4506-C names a single taxpayer, so
 * the signature this route takes covers the person who made it and the
 * transcripts it goes on to pull are that person's. A co-borrower signs their
 * own, and nothing of theirs is requested until they do.
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
import { namedBorrower, signerOn, tokenFor } from "../services/authorization.js";
import { signedOn } from "../services/signature.js";
import { advanceStage } from "../services/stage.js";
import { applicationForFile } from "../services/applications.js";
import { coBorrowerNeedsToFinish } from "../services/co-borrowers.js";
import { settleBorrowerAct } from "../services/standing.js";
import { partyForUser } from "../services/party.js";

export const applicationRouter = Router();

/* ── Identity verification (step 2) ───────────────────────────────────── */

applicationRouter.post(
  "/:id/identity-verification",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    // "self": a verification is of the person asking, and `signerOn` below
    // resolves them by party. A co-borrower proving who they are on their own
    // screen 2 was refused here with a 404 under "write".
    await assertFileAccess(id, req.user!.id, "self");

    const file = await loadLoanFile(id);
    if (!file || file.borrowers.length === 0) {
      throw new AppError(409, "Tell us who you are first.", "NO_BORROWER");
    }
    // The person signed in, resolved by party: screen 2 is about whoever is
    // filling it in, and on a file whose Borrower 1 has been replaced that is
    // not the first row. A verification session stamped onto the wrong row
    // records one person's government ID as another person's proof.
    const borrower = await signerOn(file, req.user!.id);
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

    const session = await identity.createVerificationSession(file, borrower.id);
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
    await assertFileAccess(id, req.user!.id, "self");

    // Scoped to the asker's own row on this file, so a session id from
    // elsewhere cannot be completed against this application, and one
    // person on a joint file cannot complete the other's check.
    const borrower = await prisma.borrower.findFirst({
      where: {
        loanFileId: id,
        identityVerificationId: verificationId,
        partyId: await partyForUser(prisma, req.user!.id),
      },
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
 *
 * The package is one person's. IRS Form 4506-C names a single taxpayer, so
 * what the signer authorizes is the release of the signer's transcripts — the
 * same boundary the verification authorization keeps for credit, which is why
 * they are kept identical rather than one being an exception. On a file with a
 * co-borrower this route therefore signs nothing of theirs and pulls nothing
 * of theirs, and says so in what it answers.
 */
const SIGNED_DOCUMENTS = ["form_4506c"] as const;

/** The kind a co-borrower's own attestation is recorded under, per person. */
export const APPLICATION_SIGNATURE = "application_signature";

applicationRouter.post(
  "/:id/sign-application",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    // "self": every borrower on the file signs for themselves, and only for
    // themselves. The applicant's signature is the file's — the column below
    // — and a co-borrower's is a row of their own, because one person's
    // signature on a joint application says nothing about the other's.
    await assertFileAccess(id, req.user!.id, "self");
    const owner =
      (await prisma.loanFile.findUniqueOrThrow({ where: { id }, select: { userId: true } }))
        .userId === req.user!.id;

    const file = await loadLoanFile(id);
    if (!file) throw new AppError(404, "Loan file not found", "NOT_FOUND");
    if (file.borrowers.length === 0) throw new AppError(409, "Nothing to sign yet.", "NO_BORROWER");
    // Everyone named on the application has to have arrived before the
    // APPLICANT can sign it: their signature attests to the application, and
    // one with a person on it who has not stated who they are is not
    // finished. A co-borrower signs their own part and nobody else's, so a
    // third person still pending holds nothing of theirs. The product's words
    // are the ones a borrower sees.
    if (owner && file.invitedBorrowers.length > 0) {
      throw new AppError(
        409,
        coBorrowerNeedsToFinish(file.invitedBorrowers),
        "CO_BORROWER_PENDING",
      );
    }
    // The signer is the person signed in, resolved by party rather than by
    // position. On an ordinary file that is Borrower 1; on one whose Borrower 1
    // has been replaced it is still the person signing, and the subscript would
    // have put their signature under the replacement's name.
    const borrower = await signerOn(file, req.user!.id);

    // Demographics are required before signing: Regulation B wants them
    // requested on the application, and the application is what is being
    // signed. Refusing here is the only place that ordering is enforceable.
    //
    // On a principal dwelling only. Reg B collects them for a primary
    // residence and forbids collecting them otherwise, which is why the review
    // screen asks them only then — so requiring them on a second home refused
    // a signature over a question the screen was right not to put.
    const d = borrower.demographics;
    const answered = (v: readonly string[] | string | undefined) =>
      v === "declined" || (Array.isArray(v) ? v.length > 0 : Boolean(v));
    const principalDwelling = file.property?.occupancy === "primary_residence";
    if (
      principalDwelling &&
      (!d || !answered(d.ethnicity) || !answered(d.race) || !answered(d.sex))
    ) {
      throw new AppError(
        409,
        "The demographic questions have to be answered or declined before signing.",
        "DEMOGRAPHICS_REQUIRED",
      );
    }

    // The signature attests to the application, and how title will read is
    // on it (URLA L2.1). The applicant states it; a co-borrower signing their
    // own part is not asked for the household's. A legacy file with no
    // application row has nowhere to state one and is not asked either — the
    // row, not the receipt, which is null until the six pieces are in.
    const isApplication = (await applicationForFile(prisma, id)) !== null;
    if (owner && isApplication && !file.vestings.some((v) => v.status === "Proposed")) {
      throw new AppError(
        409,
        "How the title will read has to be stated before signing.",
        "VESTING_REQUIRED",
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
      if (owner) {
        await tx.loanFile.update({ where: { id }, data: { applicationSignedAt: new Date() } });
        await recordEvent(
          id,
          "application_signed",
          "borrower",
          { documents: signed },
          undefined,
          tx,
        );
      } else {
        // A co-borrower's attestation to their own answers: a consent row in
        // their name, once, and never the file's column. Their 4506-C went
        // through the loop above in the same act.
        if (!(await signedOn(id, borrower.partyId, APPLICATION_SIGNATURE, tx))) {
          await tx.consent.create({
            data: {
              loanFileId: id,
              borrowerId: borrower.id,
              kind: APPLICATION_SIGNATURE,
              grantedAt: new Date(),
              ipAddress: req.ip ?? "unknown",
              userAgent: req.get("user-agent") ?? "unknown",
            },
          });
        }
        await recordEvent(
          id,
          "co_borrower_signed",
          "borrower",
          { borrowerId: borrower.id, documents: signed },
          undefined,
          tx,
        );
      }

      // The applicant's signature is the act the application was waiting on,
      // so the ball leaves their court here. A co-borrower's is a row of their
      // own and moves nothing: it is the applicant who still has to sign, and
      // settling on the co-borrower's act took the application out of
      // awaiting_borrower with the applicant's signature still to come.
      const app = owner ? await applicationForFile(tx, id) : null;
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
    //
    // The signer's, and only the signer's. The token is minted from the grant
    // this signature just produced, which names one party, so the adapter
    // refuses anything pulled under somebody else's — and nothing here asks
    // it to. The signer is re-resolved on the refreshed file BY ID rather than
    // by position, so a save landing between the two reads cannot move who
    // this pull is about.
    let transcripts: unknown = null;
    let transcriptError: string | null = null;
    try {
      const refreshed = await loadLoanFile(id);
      const signer = namedBorrower(refreshed!, borrower.id);
      const year = new Date().getFullYear();
      const result = await connectors().irs.fetchTranscripts(
        refreshed!,
        await tokenFor(refreshed!, signer, "tax_transcript"),
        [year - 1, year - 2],
      );
      await recordSnapshot(
        id,
        "irs",
        result.provider,
        result.externalId,
        result.data,
        result.retrievedAt,
        signer.partyId,
      );
      transcripts = result.data;
      await recordEvent(id, "connector_pull", result.provider, { kind: "irs" }, "INC-003");
    } catch (err) {
      transcriptError = err instanceof Error ? err.message : "transcripts unavailable";
    }

    // The stage is the applicant's: where THEIR flow resumes. A co-borrower
    // finishing does not move it.
    if (owner) await advanceStage(id, "DECISION");
    // WHOSE signature this was, because the request did not say: the route
    // resolves the signer itself, and a caller that was handed back only
    // `signed` could not tell which of two people it had just signed for.
    //
    // Who has NOT signed is deliberately not here. That is a fact about the
    // file rather than about this request, `application.signers` on the next
    // read carries it with each person's own pieces beside it, and a second
    // copy in a response body is the one that would go stale — the review
    // screen reads the file.
    res.status(201).json({ signed, signedBy: borrower.id, transcripts, transcriptError });
  }),
);
