/**
 * What a person may be offered before a file exists.
 *
 * Screen 1 and the refinance offer card both ask for a monthly income before
 * there is a file to read, so the one suggestion either renders (the income
 * the person last stated) is served here, about the person signed in, rather
 * than beside a file. Below the session gate like everything past auth.
 *
 * A sample borrower is offered nothing, as on their file: the sample's
 * statements are everybody's to read and nobody's to be reminded of.
 */

import { Router } from "express";
import { prisma } from "@hm/db";
import { asyncRoute } from "../middleware/error-handler.js";
import { partyOfUser } from "../services/party.js";
import { readPersonSuggestions } from "../services/autofill.js";

export const suggestionRouter = Router();

suggestionRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    if (req.user!.personaKey) {
      res.json({ suggestions: [] });
      return;
    }
    const partyId = await partyOfUser(prisma, req.user!.id);
    res.json({ suggestions: partyId ? await readPersonSuggestions(prisma, partyId) : [] });
  }),
);
