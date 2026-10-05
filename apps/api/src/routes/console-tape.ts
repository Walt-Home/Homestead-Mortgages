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
import express, { Router, type Response } from "express";
import { z } from "zod";
import { prisma } from "@hm/db";
import type { Progress } from "../services/progress.js";
import { AppError, asyncRoute } from "../middleware/error-handler.js";
import { consoleStaffGate, type ConsoleStaffGateOptions } from "../services/console-staff.js";
import {
  inviteServicerTeam,
  listServicerTeam,
  removeServicerMember,
} from "../services/servicer-team.js";
import {
  createServicer,
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

/** A servicer named ahead of its first tape: the slug our rows key on, and the name people read. */
const ServicerBody = z
  .object({
    slug: z.string().min(1).max(60),
    displayName: z.string().trim().min(1).max(200),
  })
  .strict();

const TeamBody = z
  .object({
    servicerSlug: z.string().min(1),
    invitations: z
      .array(z.object({ email: z.string().min(3), name: z.string().max(200).nullish() }))
      .min(1)
      .max(200),
  })
  .strict();

/**
 * A long write, told as it goes: newline-delimited JSON, one line per
 * progress report and a last line that is the answer the plain route
 * gives — or the refusal, since the headers are gone by the time a load
 * can fail. The desk draws a meter from the lines.
 */
type StreamEvent =
  | ({ readonly kind: "progress" } & Progress)
  | { readonly kind: "done"; readonly status: number; readonly value: unknown }
  | {
      readonly kind: "error";
      readonly status: number;
      readonly message: string;
      readonly code: string;
    };

function ndjson(res: Response): (event: StreamEvent) => void {
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  // Never buffer a progress line behind a proxy that would rather batch.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  return (event) => {
    res.write(`${JSON.stringify(event)}\n`);
  };
}

async function streamed(
  res: Response,
  work: (send: (p: Progress) => void) => Promise<{ status: number; value: unknown }>,
): Promise<void> {
  const send = ndjson(res);
  try {
    const done = await work((p) => send({ kind: "progress", ...p }));
    send({ kind: "done", ...done });
  } catch (err) {
    const e = err instanceof AppError ? err : null;
    send({
      kind: "error",
      status: e?.statusCode ?? 500,
      message: e?.message ?? "Something went wrong.",
      code: e?.code ?? "INTERNAL",
    });
  }
  res.end();
}

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

  /**
   * Stand a servicer up before its first tape, so its team, its billing
   * profile and its bank account are done by the day the tape arrives.
   */
  router.post(
    "/servicers",
    asyncRoute(async (req, res) => {
      res.status(201).json({ servicer: await createServicer(ServicerBody.parse(req.body)) });
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

  /** The load, told as it goes: progress lines, then the plain route's answer as the last line. */
  router.post(
    "/imports/stream",
    asyncRoute(async (req, res) => {
      const body = TapeBody.parse(req.body);
      const staffId = req.staff!.id;
      await streamed(res, async (send) => {
        const loaded = await loadTape(
          {
            servicer: body.servicer,
            profile: body.profile,
            asOf: body.asOf ?? null,
            tape: bytesOf(body.tape),
            supplement: body.supplement ? bytesOf(body.supplement) : null,
          },
          prisma,
          send,
        );
        const status =
          loaded.result.status === "rejected" ? 422 : loaded.result.status === "loaded" ? 201 : 200;
        return { status, value: { ...loaded, loadedBy: staffId } };
      });
    }),
  );

  /** The first review, told as it goes. */
  router.post(
    "/review/stream",
    asyncRoute(async (req, res) => {
      const body = z
        .object({ servicerSlug: z.string().min(1) })
        .strict()
        .parse(req.body);
      await streamed(res, async (send) => ({
        status: 200,
        value: await reviewBook(body, prisma, send),
      }));
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

  /** The servicer's team: who has been invited, who has taken it. */
  router.get(
    "/team",
    asyncRoute(async (req, res) => {
      const slug = z.string().min(1).parse(req.query.servicer);
      const servicer = await prisma.servicer.findUnique({ where: { slug }, select: { id: true } });
      res.json({ team: servicer ? await listServicerTeam(servicer.id) : [] });
    }),
  );

  /** Invite people onto the servicer's team: one link each, mailed; every address answers. */
  router.post(
    "/team",
    asyncRoute(async (req, res) => {
      const body = TeamBody.parse(req.body);
      res
        .status(201)
        .json({ outcomes: await inviteServicerTeam({ ...body, invitedBy: req.staff!.id }) });
    }),
  );

  /** Take somebody off the servicer's team, under the staff id that asked. A fresh invitation is the way back. */
  router.delete(
    "/team/:id",
    asyncRoute(async (req, res) => {
      const slug = z.string().min(1).parse(req.query.servicer);
      const id = z.string().uuid().safeParse(req.params.id);
      const servicer = await prisma.servicer.findUnique({ where: { slug }, select: { id: true } });
      if (!servicer || !id.success) {
        throw new AppError(404, "Nobody by that id on this team.", "NOT_FOUND");
      }
      await removeServicerMember({
        servicerId: servicer.id,
        memberId: id.data,
        removedBy: req.staff!.id,
      });
      res.status(204).end();
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
