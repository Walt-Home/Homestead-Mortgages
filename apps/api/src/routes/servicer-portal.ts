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
 * What they see is their servicer's and nothing else — the loans on their
 * book and each one's page, what the book is billed, and their team:
 * `servicerId` comes off the session's user on every read and every write,
 * never off a request, and an id that belongs to another servicer is a 404
 * like one that belongs to nobody.
 */

import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "@hm/db";
import { PRICE_SHEET } from "@hm/billing";
import { startOfMonth } from "@hm/kernel/calendar";
import { config } from "../config.js";
import { asyncRoute, AppError } from "../middleware/error-handler.js";
import { requireServicerUser } from "../middleware/require-servicer.js";
import {
  listStatements,
  monthFromKey,
  statementFor,
  type StatementAnswer,
} from "../services/billing.js";
import {
  creditNoteLink,
  invoiceLink,
  listCreditNotes,
  memberInvoices,
} from "../services/billing-invoices.js";
import { dayEt } from "../services/refi-offers.js";
import {
  acceptServicerInvitation,
  inviteServicerTeam,
  listServicerTeam,
  previewServicerInvitation,
  removeServicerMember,
  requestSignInCode,
  servicerBook,
  servicerBookImports,
  servicerBookLoan,
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

/** One loan's page. Another servicer's loan, and no loan at all, answer alike. */
servicerPortalRouter.get(
  "/book/loans/:id",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    const loan = id.success ? await servicerBookLoan(req.servicerUser!.servicerId, id.data) : null;
    if (!loan) throw new AppError(404, "No loan by that id on your book.", "NOT_FOUND");
    res.json({ loan });
  }),
);

servicerPortalRouter.get(
  "/book/imports",
  asyncRoute(async (req, res) => {
    res.json({ imports: await servicerBookImports(req.servicerUser!.servicerId) });
  }),
);

/* ── signed in: what the book is billed ────────────────────────────────────── */

/**
 * A statement as the servicer's own team reads it: the month's lines and
 * the loans under them, and when it was closed — not who at Supermortgage
 * closed it, which is ours to know.
 */
const statementForMember = (a: StatementAnswer) => ({
  statement: a.statement,
  standing: a.standing,
  closedAt: a.closed?.closedAt ?? null,
});

/** This month so far, and every month already invoiced. */
servicerPortalRouter.get(
  "/billing",
  asyncRoute(async (req, res) => {
    const { slug, id: servicerId } = req.servicerUser!.servicer;
    const today = dayEt(new Date());
    const [current, statements, issued] = await Promise.all([
      statementFor({ slug, month: startOfMonth(today) }),
      listStatements(slug),
      memberInvoices(servicerId),
    ]);
    res.json({
      sheet: { version: PRICE_SHEET.version, date: PRICE_SHEET.date },
      today,
      servicer: {
        displayName: current.servicer.displayName,
        annualTokenPool: current.servicer.annualTokenPool,
        since: current.servicer.since,
      },
      current: statementForMember(current),
      invoices: statements.map(({ closedBy: _closedBy, ...invoice }) => {
        void _closedBy;
        // What has been issued for the month and where it stands; null
        // until an invoice has actually been sent.
        return { ...invoice, issued: issued.find((i) => i.month === invoice.month) ?? null };
      }),
    });
  }),
);

/**
 * Where one of their own invoices is viewed and paid, read fresh from the
 * provider because the link expires. Another servicer's invoice, a draft
 * and an id that names nothing all answer 404.
 */
servicerPortalRouter.get(
  "/billing/invoices/:id/link",
  asyncRoute(async (req, res) => {
    const invoiceId = z.string().uuid().parse(req.params.id);
    res.json(await invoiceLink({ invoiceId, servicerId: req.servicerUser!.servicer.id }));
  }),
);

/** One month's statement: the invoice once it is closed, the meter run live before. */
servicerPortalRouter.get(
  "/billing/statements/:month",
  asyncRoute(async (req, res) => {
    const month = monthFromKey(z.string().parse(req.params.month));
    res.json(
      statementForMember(await statementFor({ slug: req.servicerUser!.servicer.slug, month })),
    );
  }),
);

/** The credit notes issued against one of their own invoices; a stranger's invoice is a 404. */
servicerPortalRouter.get(
  "/billing/invoices/:id/credit-notes",
  asyncRoute(async (req, res) => {
    const invoiceId = z.string().uuid().parse(req.params.id);
    const own = await prisma.billingInvoice.findFirst({
      where: { id: invoiceId, servicerId: req.servicerUser!.servicer.id, status: { not: "DRAFT" } },
      select: { id: true },
    });
    if (!own) throw new AppError(404, "No such invoice.", "NOT_FOUND");
    const notes = await listCreditNotes(invoiceId);
    res.json({
      creditNotes: notes
        .filter((n) => n.standing === "issued")
        .map((n) => ({
          id: n.id,
          number: n.number,
          amountCents: n.amountCents,
          memo: n.memo,
          issuedAt: n.issuedAt,
        })),
    });
  }),
);

/** The credit note's PDF, read fresh from the provider. */
servicerPortalRouter.get(
  "/billing/credit-notes/:id/link",
  asyncRoute(async (req, res) => {
    const creditNoteId = z.string().uuid().parse(req.params.id);
    res.json(await creditNoteLink({ creditNoteId, servicerId: req.servicerUser!.servicer.id }));
  }),
);

/* ── signed in: the team ───────────────────────────────────────────────────── */

/** Everyone on the team and everyone invited. Somebody removed is gone from it. */
servicerPortalRouter.get(
  "/team",
  asyncRoute(async (req, res) => {
    const team = await listServicerTeam(req.servicerUser!.servicerId);
    res.json({ team: team.filter((m) => m.standing !== "disabled") });
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

/**
 * A member removes a colleague, or an invitation not yet taken. Never
 * themselves: whoever is asking is still on the team afterwards, so a team
 * cannot remove its way down to nobody, and the last member's way out is
 * Supermortgage.
 */
servicerPortalRouter.delete(
  "/team/:id",
  asyncRoute(async (req, res) => {
    const me = req.servicerUser!;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new AppError(404, "Nobody by that id on this team.", "NOT_FOUND");
    if (id.data === me.id) {
      throw new AppError(
        409,
        "You cannot remove yourself. Ask a colleague, or Supermortgage.",
        "CANNOT_REMOVE_SELF",
      );
    }
    await removeServicerMember({
      servicerId: me.servicerId,
      memberId: id.data,
      removedBy: `member:${me.id}`,
    });
    res.status(204).end();
  }),
);
