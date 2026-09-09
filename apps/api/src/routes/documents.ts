/**
 * Screen 7's uploads.
 *
 * The button was disabled and there was no endpoint behind it, so every
 * requirement whose only evidence is a document was permanently outstanding
 * and screen 7 could never be cleared.
 *
 * **No file content is ever transmitted.** The browser reads the file it picks
 * and sends only its name, type and size; the bytes never leave the machine.
 * That is a deliberate choice, not a shortcut around wiring up storage: real
 * people are testing this, the documents a mortgage asks for are pay stubs and
 * bank statements and discharge orders, and a prototype with no retention
 * policy is the last place those should land. The record is enough to satisfy
 * the requirement and exercise the flow, and `/privacy` says exactly this.
 *
 * When document storage is real, this becomes a multipart endpoint writing to
 * a bucket, and the privacy page changes with it.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "@hm/db";
import { getRequirement } from "@hm/requirements";
import { AppError, asyncRoute } from "../middleware/error-handler.js";
import { assertFileAccess, recordEvent } from "../services/repository.js";
import { applicationForFile } from "../services/applications.js";
import { settleBorrowerAct } from "../services/standing.js";

export const documentRouter = Router();

const uploadSchema = z.object({
  satisfiesRequirementId: z.string().regex(/^[A-Z]{2,3}-\d{3}$/),
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(128),
  bytes: z
    .number()
    .int()
    .min(1)
    .max(50 * 1024 * 1024),
});

documentRouter.post(
  "/:id/documents",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = uploadSchema.parse(req.body);
    await assertFileAccess(id, req.user!.id, "write");

    // Refuse a requirement that does not exist rather than recording evidence
    // against a typo, which would be invisible until someone wondered why a
    // requirement never cleared.
    if (!getRequirement(input.satisfiesRequirementId)) {
      throw new AppError(
        400,
        `${input.satisfiesRequirementId} is not a requirement in the registry.`,
        "UNKNOWN_REQUIREMENT",
      );
    }

    // The record and the move it implies are one act: a file holding the
    // document it was waiting for while its application still says "a few
    // documents" is the disagreement this transaction removes.
    const document = await prisma.$transaction(async (tx) => {
      const row = await tx.document.create({
        data: {
          loanFileId: id,
          filename: input.filename,
          contentType: input.contentType,
          bytes: input.bytes,
          satisfiesRequirementId: input.satisfiesRequirementId,
          // Names what actually happened. A path that looks like storage would
          // be a lie the next person has to discover.
          storageUri: "fixture://content-not-transmitted",
        },
      });

      await recordEvent(
        id,
        "document_recorded",
        "borrower",
        { filename: input.filename, bytes: input.bytes, contentStored: false },
        input.satisfiesRequirementId,
        tx,
      );

      // The uploader is whoever owns this file's first borrower row; the
      // upload screen has no borrower id of its own to send. The id breaks the
      // tie, the same way every other reader of `borrowers[0]` does: two rows
      // written in one transaction can share a millisecond, and a ledger row
      // that names the co-borrower as the person who uploaded something is a
      // record of the wrong person having acted.
      const borrower = await tx.borrower.findFirst({
        where: { loanFileId: id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { partyId: true },
      });
      const app = await applicationForFile(tx, id);
      if (app && borrower) {
        await settleBorrowerAct(tx, {
          applicationId: app.id,
          loanFileId: id,
          partyId: borrower.partyId,
          reasonCode: "documents_received",
          causedBy: `document:${row.id}`,
        });
      }

      return row;
    });

    res.status(201).json({ document });
  }),
);

documentRouter.delete(
  "/:id/documents/:documentId",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const documentId = z.string().uuid().parse(req.params.documentId);
    await assertFileAccess(id, req.user!.id, "write");

    // Scoped to the file, so a document id from another file cannot be deleted
    // by guessing it.
    const deleted = await prisma.document.deleteMany({
      where: { id: documentId, loanFileId: id },
    });
    if (deleted.count === 0) throw new AppError(404, "Document not found", "NOT_FOUND");
    res.status(204).end();
  }),
);
