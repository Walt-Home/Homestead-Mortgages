/**
 * The partner portal's door: how a servicer's team member gets in, and what
 * they see once they are.
 *
 * Getting in is the servicing app's staff pattern, kept honest: an
 * invitation link sets the password (the link is the first factor, the
 * password just chosen the second); every later sign-in is a code to the
 * address and the password, in that order. The code step leaves only a
 * ten-minute mark on the session saying who answered it; nothing is open
 * until the password lands, and the session is regenerated then so a
 * cookie minted before sign-in is not the one that carries it.
 *
 * What they see is their servicer's book and nothing else: `servicerId`
 * comes off the session's user on every read, never off a request.
 */

import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "@hm/db";
import { config } from "../config.js";
import { asyncRoute, AppError } from "../middleware/error-handler.js";
import { requireServicerUser } from "../middleware/require-servicer.js";
import {
  acceptServicerInvitation,
  inviteServicerTeam,
  listServicerTeam,
  previewServicerInvitation,
  requestSignInCode,
  servicerBook,
  servicerBookImports,
  servicerBookLoans,
  SERVICER_BOOK_PAGE,
  SIGN_IN_CODE_TTL_MS,
  signInWithPassword,
  verifySignInCode,
} from "../services/servicer-team.js";
import type { SignedInServicerUser } from "../middleware/require-servicer.js";

export const servicerPortalRouter = Router();

const publicMe = (u: SignedInServicerUser) => ({
  user: { id: u.id, email: u.email, name: u.name },
  servicer: { slug: u.servicer.slug, displayName: u.servicer.displayName },
});

/** Sign the member in: a fresh session id, this one field on it. */
function establish(req: Request, userId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) {
        reject(err);
        return;
      }
      req.session.servicerUserId = userId;
      req.session.save((e) => (e ? reject(e) : resolve()));
    });
  });
}

async function signedIn(userId: string) {
  return prisma.servicerUser.findUniqueOrThrow({
    where: { id: userId },
    include: { servicer: { select: { id: true, slug: true, displayName: true } } },
  });
}

/* ── open: the door ────────────────────────────────────────────────────────── */

/** Which door an address belongs at: ours go to the staff door, every other to this one. Company domains, not a secret. */
servicerPortalRouter.get("/auth/door", (_req, res) => {
  res.json({ internalDomains: config.internalEmailDomains });
});

servicerPortalRouter.post(
  "/auth/code",
  asyncRoute(async (req, res) => {
    const { email } = z
      .object({ email: z.string().min(3).max(320) })
      .strict()
      .parse(req.body);
    const { fakeCode } = await requestSignInCode(email);
    res.json({
      delivery: "email",
      expires_in: SIGN_IN_CODE_TTL_MS / 1000,
      ...(fakeCode ? { fake_code: fakeCode } : {}),
    });
  }),
);

servicerPortalRouter.post(
  "/auth/verify",
  asyncRoute(async (req, res) => {
    const { email, code } = z
      .object({ email: z.string().min(3).max(320), code: z.string().min(6).max(6) })
      .strict()
      .parse(req.body);
    const user = await verifySignInCode(email, code);
    req.session.servicerStep = { userId: user.id, until: Date.now() + SIGN_IN_CODE_TTL_MS };
    res.json({ has_password: true });
  }),
);

servicerPortalRouter.post(
  "/auth/signin",
  asyncRoute(async (req, res) => {
    const { password } = z
      .object({ password: z.string().min(1) })
      .strict()
      .parse(req.body);
    const step = req.session.servicerStep;
    if (!step || step.until < Date.now()) {
      delete req.session.servicerStep;
      throw new AppError(401, "Ask for a new code.", "FACTOR_REQUIRED");
    }
    const user = await signInWithPassword(step.userId, password);
    await establish(req, user.id);
    res.status(201).json(publicMe(await signedIn(user.id)));
  }),
);

/** What a link holder is shown before choosing a password. Any dead link is a 404. */
servicerPortalRouter.post(
  "/auth/invitation",
  asyncRoute(async (req, res) => {
    const { token } = z
      .object({ token: z.string().min(16).max(200) })
      .strict()
      .parse(req.body);
    const preview = await previewServicerInvitation(token);
    if (!preview) throw new AppError(404, "That link is not good any more.", "NOT_FOUND");
    res.json(preview);
  }),
);

servicerPortalRouter.post(
  "/auth/accept",
  asyncRoute(async (req, res) => {
    const { token, password } = z
      .object({ token: z.string().min(16).max(200), password: z.string().min(1).max(1024) })
      .strict()
      .parse(req.body);
    const user = await acceptServicerInvitation(token, password);
    await establish(req, user.id);
    res.status(201).json(publicMe(await signedIn(user.id)));
  }),
);

servicerPortalRouter.delete("/auth/session", (req, res) => {
  req.session.destroy(() => res.status(204).end());
});

/* ── signed in: the book ───────────────────────────────────────────────────── */

servicerPortalRouter.use(requireServicerUser);

servicerPortalRouter.get("/me", (req, res) => {
  res.json(publicMe(req.servicerUser!));
});

servicerPortalRouter.get(
  "/book",
  asyncRoute(async (req, res) => {
    res.json(await servicerBook(req.servicerUser!.servicerId));
  }),
);

servicerPortalRouter.get(
  "/book/loans",
  asyncRoute(async (req, res) => {
    const query = z
      .object({
        q: z.string().max(200).optional(),
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(SERVICER_BOOK_PAGE).default(SERVICER_BOOK_PAGE),
      })
      .parse(req.query);
    res.json(await servicerBookLoans(req.servicerUser!.servicerId, query));
  }),
);

servicerPortalRouter.get(
  "/book/imports",
  asyncRoute(async (req, res) => {
    res.json({ imports: await servicerBookImports(req.servicerUser!.servicerId) });
  }),
);

servicerPortalRouter.get(
  "/team",
  asyncRoute(async (req, res) => {
    res.json({ team: await listServicerTeam(req.servicerUser!.servicerId) });
  }),
);

/** A member invites colleagues onto their own team: the servicer comes off the session, never off the body. */
servicerPortalRouter.post(
  "/team",
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        invitations: z
          .array(z.object({ email: z.string().min(3), name: z.string().max(200).nullish() }))
          .min(1)
          .max(50),
      })
      .strict()
      .parse(req.body);
    const me = req.servicerUser!;
    res.status(201).json({
      outcomes: await inviteServicerTeam({
        servicerSlug: me.servicer.slug,
        invitations: body.invitations,
        invitedBy: `member:${me.id}`,
      }),
    });
  }),
);
