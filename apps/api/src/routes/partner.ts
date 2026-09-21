/**
 * What a partner can do with its key.
 *
 * One prefix, one gate: everything under `/api/partner` passes `requirePartner`
 * and nothing else, and `index.ts` mounts this router before the session gate
 * so the key is the only thing asked for. Today the surface is the smoke
 * route — "who am I, and how deep are we wired to you" — which is what an
 * integrator calls first and what an operator checks when a key is issued.
 * The book import lands beside it once the tape reader is ported
 * (`docs/decisions.md`, "A partner is a key, not a sign-in").
 */

import { Router } from "express";
import { requirePartner } from "../middleware/require-partner.js";

export const partnerRouter = Router();

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
