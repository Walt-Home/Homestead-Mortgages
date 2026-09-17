import { Router } from "express";
import { z } from "zod";
import { prisma } from "@hm/db";
import { config } from "../config.js";
import { providerModes } from "../services/connectors.js";
import { AppError, asyncRoute } from "../middleware/error-handler.js";
import { requireAuth } from "../middleware/require-auth.js";
import { signInAsLocalDeveloper, signInAsPersona, signInWithGoogle } from "../services/auth.js";
import {
  isSeeded,
  NOT_SEEDED_HERE,
  PERSONA_KEY_SHAPE,
  PERSONA_STORIES,
} from "../personas/stories.js";
import { toDomainState } from "../services/transition.js";
import { acceptClaim, previewClaim } from "../services/invitations.js";

export const authRouter = Router();

/**
 * What the SPA needs to render a sign-in button. The client id is public by
 * design — it is embedded in every page that offers Google sign-in — so this
 * endpoint sits outside the auth gate.
 */
authRouter.get("/config", (_req, res) => {
  res.json({
    googleClientId: config.googleClientId ?? null,
    allowedDomain: config.allowedDomain ?? null,
    // Tells the client whether to offer the local shortcut. False in
    // production regardless of anything else.
    developerSignInAvailable: config.nodeEnv !== "production" && !config.googleClientId,
    stateGalleryEnabled: config.stateGalleryEnabled,
    // Whether the sign-in page offers the sample borrowers. Off everywhere the
    // flag is not set, and the routes behind it are not mounted at all — so a
    // client that asked anyway gets the same 404 as a path that never existed.
    demoPersonasEnabled: config.demoPersonasEnabled,
    /*
     * What is actually behind each connector on this deployment.
     *
     * Every borrower-facing sentence that says an outside party did something
     * is true of one of these values and false of another, and the client
     * cannot infer which — a fixture and a hosted vendor answer the same
     * endpoint identically as far as the browser can see. So the server says
     * it, and `lib/disclosures.ts` is where a screen turns it into words.
     *
     * This replaced a single `identityRequiresRedirect` boolean. That flag
     * carried two facts in one bit: screen 2 used it to decide whether the
     * button leaves the site, which "not a fixture" answers correctly, and
     * also to gate a banner reading "Stripe's test mode", which it does not —
     * a live key would have left that banner asserting test mode over a real
     * document check. Three values separate the two questions; one bit could
     * not.
     */
    connectorModes: providerModes(),
  });
});

const credentialSchema = z.object({ credential: z.string().min(1) });

authRouter.post(
  "/google",
  asyncRoute(async (req, res) => {
    const { credential } = credentialSchema.parse(req.body);
    const user = await signInWithGoogle(credential);
    // Rotate the session id on privilege change; without this a session fixed
    // before sign-in stays valid after it.
    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );
    req.session.userId = user.id;
    res.status(201).json({ user: publicUser(user) });
  }),
);

authRouter.post(
  "/developer",
  asyncRoute(async (req, res) => {
    const user = await signInAsLocalDeveloper();
    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );
    req.session.userId = user.id;
    res.status(201).json({ user: publicUser(user) });
  }),
);

/**
 * The sample borrowers, and signing in as one.
 *
 * Mounted only when the flag is on, so with it off these paths do not exist —
 * the API's catch-all answers them exactly as it answers a typo. That is the
 * gate; `signInAsPersona` checks the same flag again because a route is one
 * edit away from being mounted somewhere else.
 *
 * The listing is open, like `/config` and `/google`: it is what the sign-in
 * page renders before anybody is signed in. It exposes nothing but the nine
 * rows this file already describes and the state each one is in.
 */
const personaRouter = Router();

personaRouter.get(
  "/personas",
  asyncRoute(async (_req, res) => {
    const users = await prisma.user.findMany({
      where: { personaKey: { not: null } },
      select: {
        personaKey: true,
        createdAt: true,
        loanFiles: {
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { application: { select: { status: true } } },
        },
      },
    });
    const seeded = new Map(users.map((u) => [u.personaKey, u]));

    res.json({
      personas: PERSONA_STORIES.flatMap((story) => {
        const row = seeded.get(story.key);
        const status = row?.loanFiles[0]?.application?.status;
        /*
         * Clickable only when there is a row behind it.
         *
         * `isSeeded` is a property of the LIST — this build knows where to
         * walk that persona — and says nothing about this database. Read on
         * its own it offers all nine rows on a deployment whose seed has not
         * run, and every one of them signs in to a 503.
         */
        const offerable = isSeeded(story) && row !== undefined;
        /*
         * Where the file ACTUALLY stands, not where the story says it should.
         * A persona that drifted is a persona whose pill should say so —
         * this page is how a tester would notice, and a listing that showed
         * the intended state would be the one place the drift was hidden.
         */
        const state = status ? toDomainState(status) : null;
        const own = {
          key: story.key,
          name: `${story.name.first} ${story.name.last}`,
          story: story.story,
          state,
          available: offerable,
          unavailableBecause: offerable
            ? null
            : isSeeded(story)
              ? NOT_SEEDED_HERE
              : story.unavailableBecause,
          seededAt: row?.createdAt.toISOString() ?? null,
        };
        if (!isSeeded(story) || !story.coBorrower) return [own];
        /*
         * The co-borrower's row, under the applicant's. They own no file, so
         * the state beside them is the household's — the one file they are
         * on — and the row is offered only when both halves were seeded,
         * because the seed writes them in one transaction and a co-borrower
         * with no file to be on is a sign-in to nothing.
         */
        const theirs = seeded.get(story.coBorrower.key);
        const both = offerable && theirs !== undefined;
        return [
          own,
          {
            key: story.coBorrower.key,
            name: `${story.coBorrower.name.first} ${story.coBorrower.name.last}`,
            story: story.coBorrower.story,
            state: both ? state : null,
            available: both,
            unavailableBecause: both ? null : NOT_SEEDED_HERE,
            seededAt: theirs?.createdAt.toISOString() ?? null,
          },
        ];
      }),
    });
  }),
);

personaRouter.post(
  "/personas/:key",
  asyncRoute(async (req, res) => {
    // The same shape the database's CHECK takes, so an unknown key is a 503
    // about seeding rather than a query with something arbitrary in it.
    const key = z.string().regex(PERSONA_KEY_SHAPE).parse(req.params.key);
    const user = await signInAsPersona(key);
    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );
    req.session.userId = user.id;
    res.status(201).json({ user: publicUser(user) });
  }),
);

if (config.demoPersonasEnabled) authRouter.use(personaRouter);

authRouter.get(
  "/me",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json({ user: publicUser(req.user!) });
  }),
);

/**
 * Delete the account and everything attached to it.
 *
 * `users → loan_files` cascades and every child of a loan file cascades from
 * there — including, now, the application the file was born from and its
 * ledger, scenarios, pins and clocks. The PERSON does not: identity is facts
 * on the party, and users.party_id points the wrong way to cascade. The
 * users_delete_takes_party trigger removes the party (and so its facts,
 * principal and authorizations) when the user row goes; the explicit deletes
 * below are belt and braces in the same transaction, so this route is true on
 * its own and a 0 here means a trigger already did it. For a prototype that
 * asks real people for their date of birth and SSN, "you can take it back"
 * has to actually be true.
 *
 * The order is stated here rather than inherited: files first, then the user,
 * then the party. A ledger row names the principal that caused it and that
 * foreign key is RESTRICT, so the application has to be gone before the party
 * whose principal it names. The database makes that order too — see
 * users_delete_takes_files — but this route reads top to bottom, and the
 * sequence that keeps the promise should be legible in the handler that makes
 * it and not only in a trigger two packages away.
 */
authRouter.delete(
  "/me",
  requireAuth,
  asyncRoute(async (req, res) => {
    // The one write mounted before the read-only gate, so it carries the same
    // refusal itself. A sample borrower is shared with every tester and is
    // seeded, not signed up; deleting one would take a state nobody could put
    // back without a deploy.
    if (req.user!.personaKey) {
      throw new AppError(403, "A sample borrower cannot be deleted.", "PERSONA_READ_ONLY");
    }
    const userId = req.user!.id;
    const { partyId } = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { partyId: true },
    });
    // A co-borrower on somebody else's application is refused. Deleting the
    // party cascades their borrower row and their membership out of an
    // application they do not own, which would silently change what another
    // person applied for — and the ledger of that application names this
    // person's principal. Leaving an application is its own act, and it is
    // not built; until it is, the account stays.
    const elsewhere = partyId
      ? await prisma.borrower.findFirst({
          where: { partyId, loanFile: { userId: { not: userId } } },
          select: { id: true },
        })
      : null;
    if (elsewhere) {
      throw new AppError(
        409,
        "You are a co-borrower on somebody else's application, so this account cannot be deleted while you are on it.",
        "ON_ANOTHER_APPLICATION",
      );
    }
    const files = await prisma.loanFile.count({ where: { userId } });
    await prisma.$transaction(async (tx) => {
      await tx.loanFile.deleteMany({ where: { userId } });
      await tx.user.delete({ where: { id: userId } });
      if (partyId) await tx.party.deleteMany({ where: { id: partyId } });
    });
    req.session.destroy(() => {
      res.clearCookie("hm.sid");
      res.json({ deleted: { user: 1, loanFiles: files, party: partyId ? 1 : 0 } });
    });
  }),
);

authRouter.post("/signout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("hm.sid");
    res.status(204).end();
  });
});

/**
 * Never return googleSub or hostedDomain to the browser; neither is its business.
 *
 * `personaKey` is required rather than optional on purpose. Three things in
 * the SPA hang off the `persona` field below — the banner, the hidden start
 * button and the review screen's read-only state — and an optional parameter
 * would let a caller with a narrower `select` compile while quietly answering
 * `persona: null`, which is a real person's answer.
 */
function publicUser(user: {
  id: string;
  email: string;
  name: string | null;
  pictureUrl: string | null;
  personaKey: string | null;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    pictureUrl: user.pictureUrl,
    // What the banner reads, and what hides the "start an application" button.
    // The server already knows; asking the client to infer it from the file
    // list would leave a persona one stale query away from a CTA it cannot use.
    persona: user.personaKey ? { key: user.personaKey, name: user.name } : null,
  };
}

/**
 * A link from an invitation email, looked at and then taken.
 *
 * The lookup is public: it is what a stranger holding a link sees before
 * signing in, and it says only what the email already said — two first
 * names, a city, a date. Every way a link can be bad answers the same 404,
 * because which way it was bad is a fact about a file the holder has not
 * proven anything about. Taking it requires a session, the same Google
 * sign-in as everything else, and never an email match: the address the
 * applicant typed is where the link went, not who may follow it.
 *
 * Both are POSTs carrying the token in the body, and neither takes it in the
 * path. A path is written to every request log between the browser and this
 * process; a body is not. The link itself keeps the token in the URL
 * fragment for the same reason — see `claimUrl`.
 */
const claimSchema = z.object({ token: z.string().min(20).max(200) });

authRouter.post(
  "/claims/preview",
  asyncRoute(async (req, res) => {
    const { token } = claimSchema.parse(req.body);
    const preview = await previewClaim(token);
    if (!preview) throw new AppError(404, "That link is not good any more.", "NOT_FOUND");
    res.json(preview);
  }),
);

authRouter.post(
  "/claims/accept",
  requireAuth,
  asyncRoute(async (req, res) => {
    // Mounted before the read-only gate, like DELETE /me, so it carries the
    // same refusal itself: a sample borrower is shared with every tester, and
    // one of them taking a real person's invitation would put a seeded row on
    // somebody's application.
    if (req.user!.personaKey) {
      throw new AppError(
        403,
        "This is a sample borrower. Nothing can be changed while signed in as one.",
        "PERSONA_READ_ONLY",
      );
    }
    const { token } = claimSchema.parse(req.body);
    const claimed = await acceptClaim(token, req.user!.id);
    res.status(201).json(claimed);
  }),
);
