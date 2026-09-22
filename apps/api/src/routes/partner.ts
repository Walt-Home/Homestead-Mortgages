/**
 * What a partner can do with its key.
 *
 * One prefix, one gate: everything under `/api/partner` passes `requirePartner`
 * and nothing else, and `index.ts` mounts this router above the session gate
 * so the key is the only thing asked for. It is mounted above the body parser
 * too, because a tape is megabytes and the 1 MB limit on the rest of the API
 * is sized for a person's screen; this router parses its own.
 *
 *   GET  /me                  who am I, and how deep are we wired to you
 *   POST /book/imports        a tape and its supplement, base64 in JSON —
 *                             201 loaded, 200 already loaded, 422 rejected
 *   GET  /book/imports        the servicer's imports, newest first
 *   GET  /book/imports/:id    one, with its report; a stranger's is a 404
 *   GET  /book/status         tapes read, the latest as-of, loans by state
 */

import express, { Router } from "express";
import { z } from "zod";
import { AppError } from "../middleware/error-handler.js";
import { requirePartner } from "../middleware/require-partner.js";
import {
  importPartnerBook,
  listPartnerBookImports,
  partnerBookImport,
  partnerBookStatus,
} from "../services/partner-book.js";
import { mintLoanClaim } from "../services/loan-claims.js";

export const partnerRouter = Router();

partnerRouter.use(express.json({ limit: "48mb" }));
partnerRouter.use(requirePartner);

partnerRouter.get("/me", (req, res) => {
  const partner = req.partner!;
  res.json({
    servicer: {
      slug: partner.servicerSlug,
      displayName: partner.servicerDisplayName,
      integrationDepth: partner.integrationDepth,
    },
    credential: { id: partner.credentialId, label: partner.label },
  });
});

const FileSchema = z
  .object({ filename: z.string().min(1).max(200), base64: z.string().min(1) })
  .strict();

const ImportBody = z
  .object({
    profile: z.string().min(1).default("m3-v1"),
    asOf: z.string().date().optional(),
    tape: FileSchema,
    supplement: FileSchema.optional(),
  })
  .strict();

const bytesOf = (f: z.infer<typeof FileSchema>) => ({
  filename: f.filename,
  bytes: new Uint8Array(Buffer.from(f.base64, "base64")),
});

partnerRouter.post("/book/imports", async (req, res) => {
  const parsed = ImportBody.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError(400, parsed.error.issues[0]?.message ?? "Bad request", "BAD_REQUEST");
  }
  const body = parsed.data;
  const partner = req.partner!;
  let result;
  try {
    result = await importPartnerBook({
      servicerId: partner.servicerId,
      principalId: partner.principalId,
      profile: body.profile,
      asOf: body.asOf ?? null,
      tape: bytesOf(body.tape),
      supplement: body.supplement ? bytesOf(body.supplement) : null,
    });
  } catch (err) {
    // The one thing the reader refuses by name before it reads a byte.
    if (err instanceof RangeError) throw new AppError(400, err.message, "UNKNOWN_PROFILE");
    throw err;
  }
  if (result.status === "rejected") {
    res.status(422).json(result);
    return;
  }
  res.status(result.status === "loaded" ? 201 : 200).json(result);
});

/**
 * A claim for one loan the partner's tape wrote, minted once and handed to
 * the partner to deliver. The token is in this response and nowhere else we
 * keep; the link is the same door a co-borrower's invitation opens. A loan
 * that is not this partner's answers as one that does not exist, and a loan
 * that is no longer unclaimed — claimed already, or ended first — is 409.
 */
partnerRouter.post("/book/loans/:number/claims", async (req, res) => {
  const partner = req.partner!;
  const minted = await mintLoanClaim({
    servicerId: partner.servicerId,
    servicerLoanNumber: String(req.params.number),
    principalId: partner.principalId,
  });
  res.status(201).json(minted);
});

partnerRouter.get("/book/imports", async (req, res) => {
  res.json({ imports: await listPartnerBookImports(req.partner!.servicerId) });
});

partnerRouter.get("/book/imports/:id", async (req, res) => {
  const row = await partnerBookImport(req.partner!.servicerId, String(req.params.id));
  if (!row) throw new AppError(404, "Import not found", "NOT_FOUND");
  res.json(row);
});

partnerRouter.get("/book/status", async (req, res) => {
  res.json(await partnerBookStatus(req.partner!.servicerId));
});
