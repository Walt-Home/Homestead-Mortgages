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
 *
 * Every one of the three is signed by ONE person, and the person is whoever
 * is signed in. It used to be the file's first borrower, which on a file with
 * a co-borrower answers the whole question by accident: Form 4506-C names a
 * single taxpayer, so a signature on it authorizes the signer's tax records
 * and nobody else's. A co-borrower signs their own, and until they do nothing
 * of theirs is requested — the same boundary the verification authorization
 * already keeps for credit, which is the point of keeping them identical.
 *
 * Nothing here can be told whose signature to take. A co-borrower has never
 * signed in, so today that means their signature cannot be collected at all;
 * an endpoint that accepted a name instead would mean the applicant executing
 * their partner's federal tax authorization, which is worse than a gap.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "@hm/db";
import { AppError, asyncRoute } from "../middleware/error-handler.js";
import { assertFileAccess, loadLoanFile, recordEvent } from "../services/repository.js";
import { connectors } from "../services/connectors.js";
import { assertSignsForThemselves, signerOn } from "../services/authorization.js";
import { borrowingRoleFor } from "../services/borrower-order.js";
import { signedOn } from "../services/signature.js";
import { applicationForFile, ensureApplicationParty } from "../services/applications.js";
import { pinTridPieces } from "../services/evidence.js";
import { settleAfterIntake } from "../services/standing.js";

export const esignRouter = Router();

/** Only these are signable. `persistent_monitoring` is an opt-in, not a signature. */
const SIGNABLE = ["verification_authorization", "econsent", "form_4506c"] as const;

const REQUIREMENT_FOR: Record<(typeof SIGNABLE)[number], string> = {
  verification_authorization: "APP-005",
  econsent: "APP-012",
  form_4506c: "INC-008",
};

/**
 * Which document. Never whose — the signer is the person signed in.
 *
 * A `borrowerId` here would be a capability rather than a question: the
 * applicant owns a joint file and holds the only session on it, so it would
 * let them execute the co-borrower's Form 4506-C. See `signerOn`.
 */
const startSchema = z.object({ kind: z.enum(SIGNABLE) });

esignRouter.post(
  "/:id/esign",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const { kind } = startSchema.parse(req.body);
    await assertFileAccess(id, req.user!.id, "self");

    const file = await loadLoanFile(id);
    if (!file) throw new AppError(404, "Loan file not found", "NOT_FOUND");
    if (file.borrowers.length === 0) {
      throw new AppError(
        409,
        "There is nobody to sign yet — finish the identity step first.",
        "NO_BORROWER",
      );
    }

    // The signer: this requester's own row on this file, by party. Not
    // `borrowers[0]` — on a file whose Borrower 1 has been replaced the person
    // signing is still a borrower and is no longer the first one, and the
    // signature would have been filed under the replacement's name.
    const borrower = await signerOn(file, req.user!.id);

    // Already signed is a success, not an error. A person who refreshes the
    // signing screen should not be told something went wrong. But "signed"
    // is this borrower's row on this file AND their party's live grant,
    // together — see services/signature.ts for what each half alone got wrong.
    const signed = await signedOn(id, borrower.partyId, kind);
    if (signed) {
      res.json({ alreadySigned: true, kind, borrowerId: borrower.id, signedAt: signed.grantedAt });
      return;
    }

    const envelope = await connectors().esign.createEnvelope(file, kind, borrower.id);
    res.status(201).json({
      alreadySigned: false,
      kind,
      borrowerId: borrower.id,
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
    await assertFileAccess(id, req.user!.id, "self");

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
      select: { id: true, partyId: true },
    });
    if (!borrower) {
      throw new AppError(404, "That signing session was not found.", "ENVELOPE_NOT_FOUND");
    }
    // The envelope names its signer, and the signer must be the person sending
    // this. The fixture's envelope ids are guessable by construction, so
    // without this the applicant could complete an envelope minted for the
    // co-borrower and put their signature on that person's 4506-C.
    await assertSignsForThemselves(req.user!.id, borrower.partyId);

    // Same rule as starting a signature: a completion that lands where THIS
    // borrower has already signed this kind is absorbed, but a lapsed grant, a
    // second file, or the other borrower's signature on the same file is not
    // "already signed" and writes this borrower's row.
    const kind = consent.kind as (typeof SIGNABLE)[number];
    const signed = await signedOn(id, borrower.partyId, kind);
    if (signed) {
      res.json({ kind, borrowerId: borrower.id, signedAt: signed.grantedAt, alreadySigned: true });
      return;
    }

    // The renewal path when screen 2 is not revisited: a grant that lapsed
    // after 120 days is retired and re-minted by the mirror trigger on this
    // insert, which leaves every pin borrowed under the old one standing
    // against an authorization nobody holds any more. Reconciling in the same
    // transaction is what keeps a renewed signature and the evidence it
    // licenses from disagreeing, and on a file whose six pieces were never
    // complete it is the signature that finally receives the application.
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.consent.create({
        data: {
          loanFileId: id,
          borrowerId: borrower.id,
          kind: consent.kind,
          grantedAt: new Date(),
          envelopeId,
          // The IP and user agent ARE the evidence a person signed. They are
          // only trustworthy because `trust proxy` is a hop count — see
          // config.ts.
          ipAddress: req.ip ?? "unknown",
          userAgent: req.get("user-agent") ?? "unknown",
        },
        select: { kind: true, grantedAt: true },
      });

      if (kind === "verification_authorization") {
        const app = await applicationForFile(tx, id);
        if (app) {
          // The role this person holds on the file, which is not always the
          // primary's: on a file whose Borrower 1 has been replaced, the
          // person signing is a borrower who is no longer the first one.
          // Naming PRIMARY_BORROWER outright put them on as a SECOND
          // applicant — the index that says there is one Borrower 1 is over
          // the position and not the role — and the receipt counts any
          // primary's party-side pieces, so their three would have opened the
          // Loan Estimate clock.
          const role = await borrowingRoleFor(tx, id, borrower.partyId);
          await ensureApplicationParty(tx, app.id, borrower.partyId, role);
          await pinTridPieces(tx, { applicationId: app.id, partyId: borrower.partyId });
          // The same cause as the consent handler's, because it is the same
          // cause: a verification authorization signed on this file. Where the
          // signature was collected is the envelope's business, and a second
          // spelling here would split one edge into two in every report that
          // groups the ledger by what moved it.
          await settleAfterIntake(tx, {
            applicationId: app.id,
            loanFileId: id,
            causedBy: "consent:verification_authorization",
          });
        }
      }

      return row;
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
      borrowerId: borrower.id,
      signedAt: created.grantedAt,
      alreadySigned: false,
    });
  }),
);
