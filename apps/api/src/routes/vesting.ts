/**
 * How title will read, asked on the review screen.
 *
 * One route, the applicant's: the vesting is a fact about the deal and the
 * signature attests to it, so it is stated by the person whose application
 * this is, above the signature. The body mirrors the table's rules by name —
 * a proposed vesting always, a current one only on a refinance, and a manner
 * of holding whenever more than one name is on title.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "@hm/db";
import { DU_FORMATS } from "@hm/du";
import { AppError, asyncRoute } from "../middleware/error-handler.js";
import { assertFileAccess } from "../services/repository.js";
import { recordVesting } from "../services/vesting.js";

export const vestingRouter = Router();

/** How wide L2.1 is, read off the Map rather than written down. */
const FULL_NAME_WIDTH =
  DU_FORMATS["MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/PARTIES/PARTY/INDIVIDUAL/NAME#FullName#L2.1"]
    ?.maxLength ?? 150;

const VESTING_TYPES = [
  "Individual",
  "JointTenantsWithRightOfSurvivorship",
  "LifeEstate",
  "Other",
  "TenantsByTheEntirety",
  "TenantsInCommon",
] as const;

const oneVesting = z.object({
  fullName: z.string().trim().min(1).max(FULL_NAME_WIDTH),
  vestingType: z.enum(VESTING_TYPES).nullable(),
});

const bodySchema = z.object({
  proposed: oneVesting,
  current: oneVesting.nullish(),
});

vestingRouter.post(
  "/:id/vesting",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = bodySchema.parse(req.body);
    await assertFileAccess(id, req.user!.id, "own");

    const file = await prisma.loanFile.findUniqueOrThrow({
      where: { id },
      select: { purpose: true, _count: { select: { borrowers: true } } },
    });
    if (input.current && file.purpose === "PURCHASE") {
      throw new AppError(400, "Only a refinance has a current title to state.", "NOT_A_REFINANCE");
    }
    if (input.proposed.vestingType === null && file._count.borrowers > 1) {
      throw new AppError(
        400,
        "With more than one name on title, say how it will be held.",
        "VESTING_TYPE_REQUIRED",
      );
    }

    const vestings = await recordVesting(id, {
      proposed: input.proposed,
      current: input.current ?? null,
    });
    res.status(201).json({ vestings });
  }),
);
