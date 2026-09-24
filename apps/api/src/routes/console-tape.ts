/**
 * The tape desk's door, for the console.
 *
 * Mounted on the servicing hostname beside the console's forwarded calls,
 * under `/console/hm/tape` — `hm` because the servicing app's console API
 * answers `/console/api`, and this is the one prefix on that host our API
 * answers itself. Its gate is the servicing app's own session, checked with
 * it (`console-staff.ts`); a borrower's session opens nothing here.
 *
 * A tape is megabytes, so the router parses its own body at a size the
 * session routes never need, and files cross as base64 in JSON the way they
 * cross the partner door — one contract for a tape, whoever carries it.
 */

import { gunzipSync } from "node:zlib";
import express, { Router } from "express";
import { z } from "zod";
import { asyncRoute } from "../middleware/error-handler.js";
import { consoleStaffGate, type ConsoleStaffGateOptions } from "../services/console-staff.js";
import {
  deskImports,
  deskServicers,
  inviteToClaim,
  loadTape,
  previewTape,
  reviewBook,
} from "../services/tape-desk.js";

/**
 * A file on the wire: its name and its bytes, base64, gzipped first when the
 * desk could — a CSV tape shrinks about tenfold, and the front door closes a
 * slow upload of tens of megabytes before it reaches us.
 */
const FileSchema = z.object({
  filename: z.string().min(1),
  base64: z.string().min(1),
  encoding: z.enum(["identity", "gzip"]).default("identity"),
});
const bytesOf = (f: z.infer<typeof FileSchema>) => {
  const raw = Buffer.from(f.base64, "base64");
  return {
    filename: f.filename,
    bytes: new Uint8Array(f.encoding === "gzip" ? gunzipSync(raw) : raw),
  };
};

const TapeBody = z
  .object({
    servicer: z.object({ slug: z.string().min(1), displayName: z.string().min(1) }),
    profile: z.string().min(1).default("m3-v1"),
    asOf: z.string().date().optional(),
    tape: FileSchema,
    supplement: FileSchema.optional(),
  })
  .strict();

const InviteBody = z
  .object({
    servicerSlug: z.string().min(1),
    invitations: z
      .array(z.object({ number: z.string().min(1), email: z.string().email().nullable() }))
      .min(1)
      .max(5000),
  })
  .strict();

export function consoleTapeRouter(gate: ConsoleStaffGateOptions): Router {
  const router = Router();
  router.use(express.json({ limit: "40mb" }));
  router.use(consoleStaffGate(gate));

  /** The servicers we hold books for, each with where its book stands. */
  router.get(
    "/servicers",
    asyncRoute(async (_req, res) => {
      res.json({ servicers: await deskServicers() });
    }),
  );

  router.get(
    "/imports",
    asyncRoute(async (req, res) => {
      const slug = z.string().min(1).parse(req.query.servicer);
      res.json({ imports: await deskImports(slug) });
    }),
  );

  /** Read the tape, write nothing, say what loading it would do. */
  router.post(
    "/preview",
    asyncRoute(async (req, res) => {
      const body = TapeBody.parse(req.body);
      res.json(
        await previewTape({
          servicer: body.servicer,
          profile: body.profile,
          asOf: body.asOf ?? null,
          tape: bytesOf(body.tape),
          supplement: body.supplement ? bytesOf(body.supplement) : null,
        }),
      );
    }),
  );

  /** The load itself. 201 when it wrote, 200 when this exact tape was loaded before, 422 when refused. */
  router.post(
    "/imports",
    asyncRoute(async (req, res) => {
      const body = TapeBody.parse(req.body);
      const loaded = await loadTape({
        servicer: body.servicer,
        profile: body.profile,
        asOf: body.asOf ?? null,
        tape: bytesOf(body.tape),
        supplement: body.supplement ? bytesOf(body.supplement) : null,
      });
      const status =
        loaded.result.status === "rejected" ? 422 : loaded.result.status === "loaded" ? 201 : 200;
      res.status(status).json({ ...loaded, loadedBy: req.staff!.id });
    }),
  );

  /** The book's first review: today's verdict and offer on every loan, run now rather than tomorrow morning. */
  router.post(
    "/review",
    asyncRoute(async (req, res) => {
      const body = z
        .object({ servicerSlug: z.string().min(1) })
        .strict()
        .parse(req.body);
      res.json(await reviewBook(body));
    }),
  );

  /** One claim per loan, mailed where an address was given; every loan answers. */
  router.post(
    "/claims",
    asyncRoute(async (req, res) => {
      const body = InviteBody.parse(req.body);
      res.status(201).json({ outcomes: await inviteToClaim(body) });
    }),
  );

  return router;
}
