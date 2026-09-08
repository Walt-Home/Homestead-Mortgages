import { Router } from "express";
import { z } from "zod";
import { prisma } from "@hm/db";
import { config } from "../config.js";
import { connectors } from "../services/connectors.js";
import { asyncRoute } from "../middleware/error-handler.js";
import { requireAuth } from "../middleware/require-auth.js";
import { signInAsLocalDeveloper, signInWithGoogle } from "../services/auth.js";

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
    /*
     * Whether the ID check navigates away to a vendor.
     *
     * Screen 2's button has to name where it is about to send somebody: a
     * control reading "Scan your ID and take a selfie" that instead lands them
     * on a Stripe domain asking for a government ID looks precisely like the
     * thing people are warned about. The client cannot infer this — a fixture
     * and a hosted vendor answer the same endpoint differently — so the server
     * says it, next to the other "what should the client render" flags.
     */
    identityRequiresRedirect: connectors().identity.capabilities.mode !== "fixture",
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
 * there. The PERSON does not: identity is facts on the party, and
 * users.party_id points the wrong way to cascade. The
 * users_delete_takes_party trigger removes the party (and so its facts,
 * principal and authorizations) when the user row goes; the explicit delete
 * below is belt and braces in the same transaction, so this route is true on
 * its own and a 0 here means the trigger already did it. For a prototype that
 * asks real people for their date of birth and SSN, "you can take it back"
 * has to actually be true.
 */
authRouter.delete(
  "/me",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.user!.id;
    const { partyId } = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { partyId: true },
    });
    const files = await prisma.loanFile.count({ where: { userId } });
    await prisma.$transaction(async (tx) => {
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

/** Never return googleSub or hostedDomain to the browser; neither is its business. */
function publicUser(user: {
  id: string;
  email: string;
  name: string | null;
  pictureUrl: string | null;
}) {
  return { id: user.id, email: user.email, name: user.name, pictureUrl: user.pictureUrl };
}
