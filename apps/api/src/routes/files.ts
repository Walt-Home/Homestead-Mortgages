/**
 * Creating and advancing a loan file.
 *
 * Screens 1 and 2 write through here. Everything else in the flow is a
 * connector call or a computation, which is the point of the design: the
 * borrower types twice and connects four times.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "@hm/db";
import { config } from "../config.js";
import { AppError, asyncRoute } from "../middleware/error-handler.js";
import {
  assertFileAccess,
  listAccessibleFiles,
  loadLoanFile,
  recordEvent,
} from "../services/repository.js";
import { loanEstimateDueAt, stampApplicationIfComplete } from "../services/application.js";
import { advanceStage } from "../services/stage.js";

export const fileRouter = Router();

const addressSchema = z.object({
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().length(2),
  postalCode: z.string().min(5),
});

/** Screen 1 — under 60 seconds of typing, per the flow notes. */
const propertyLoanSchema = z.object({
  purpose: z.enum(["purchase", "rate_term_refinance", "cash_out_refinance"]),
  address: addressSchema,
  propertyType: z.enum([
    "single_family",
    "condo",
    "townhouse",
    "two_to_four_unit",
    "manufactured",
    "co_op",
  ]),
  occupancy: z.enum(["primary_residence", "second_home", "investment"]),
  valueOrPrice: z.number().positive(),
  loanAmount: z.number().positive(),
  downPayment: z.number().min(0),
  /**
   * Stated, unverified, and collected here for one reason: it is the sixth
   * piece of the TRID application, and without it the LE clock cannot start
   * until a connector returns. See services/application.ts.
   */
  statedMonthlyIncome: z.number().positive(),
  financedPropertyCount: z.number().int().min(1).default(1),
  interestedPartyContributions: z.number().min(0).default(0),
  /**
   * Cash-out only. AST-012 wants the proceeds purpose documented, and the
   * flow offered "Taking cash out" without ever asking for either field — so
   * choosing it produced a file that could not satisfy a requirement it had
   * just made applicable.
   */
  cashToBorrower: z.number().min(0).optional(),
  cashOutPurpose: z.string().min(1).optional(),
});

const PURPOSE_TO_DB = {
  purchase: "PURCHASE",
  rate_term_refinance: "RATE_TERM_REFINANCE",
  cash_out_refinance: "CASH_OUT_REFINANCE",
} as const;

/** Screen 1, on a file that already exists. Editing terms must not fork a new file. */
fileRouter.patch(
  "/:id",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = propertyLoanSchema.partial().parse(req.body);
    await assertFileAccess(id, req.user!.id, "write");

    await prisma.loanFile.update({
      where: { id },
      data: {
        ...(input.purpose ? { purpose: PURPOSE_TO_DB[input.purpose] } : {}),
        ...(input.loanAmount !== undefined ? { loanAmount: input.loanAmount } : {}),
        ...(input.downPayment !== undefined ? { downPayment: input.downPayment } : {}),
        ...(input.valueOrPrice !== undefined ? { valueOrPrice: input.valueOrPrice } : {}),
        ...(input.propertyType ? { propertyType: input.propertyType } : {}),
        ...(input.occupancy ? { occupancy: input.occupancy } : {}),
        ...(input.financedPropertyCount !== undefined
          ? { financedPropertyCount: input.financedPropertyCount }
          : {}),
        ...(input.interestedPartyContributions !== undefined
          ? { interestedPartyContributions: input.interestedPartyContributions }
          : {}),
        ...(input.address
          ? {
              propertyLine1: input.address.line1,
              propertyLine2: input.address.line2 ?? null,
              propertyCity: input.address.city,
              propertyState: input.address.state.toUpperCase(),
              propertyPostalCode: input.address.postalCode,
              // A changed address is an unverified address until it is matched
              // again. Leaving the old flag set would assert APP-004 about a
              // property nobody has looked up.
              addressVerified: false,
            }
          : {}),
        ...(input.cashOutPurpose !== undefined ? { cashOutPurpose: input.cashOutPurpose } : {}),
        ...(input.cashToBorrower !== undefined ? { cashToBorrower: input.cashToBorrower } : {}),
      },
    });
    await recordEvent(id, "screen_revised", "borrower", { screen: "property_loan" });
    res.json({ id, stage: "identity" });
  }),
);

fileRouter.post(
  "/",
  asyncRoute(async (req, res) => {
    const input = propertyLoanSchema.parse(req.body);
    const file = await prisma.loanFile.create({
      data: {
        // Ownership is set at creation and never changes. A file with no owner
        // is a demo file, and only the seed script makes those.
        userId: req.user!.id,
        stage: "IDENTITY",
        purpose: PURPOSE_TO_DB[input.purpose],
        loanAmount: input.loanAmount,
        downPayment: input.downPayment,
        propertyLine1: input.address.line1,
        propertyLine2: input.address.line2 ?? null,
        propertyCity: input.address.city,
        propertyState: input.address.state.toUpperCase(),
        propertyPostalCode: input.address.postalCode,
        propertyType: input.propertyType,
        occupancy: input.occupancy,
        valueOrPrice: input.valueOrPrice,
        valuationSource: "borrower_stated",
        // Stands in for the public-record match APP-004 wants. A real build
        // resolves this against ATTOM; asserting it here keeps the requirement
        // honest about what the fixture actually proves.
        addressVerified: true,
        financedPropertyCount: input.financedPropertyCount,
        interestedPartyContributions: input.interestedPartyContributions,
        cashToBorrower: input.cashToBorrower ?? null,
        cashOutPurpose: input.cashOutPurpose ?? null,
        // The borrower does not choose a product in this flow, so we quote
        // one. See config.defaultProduct for why a rate has to exist at all.
        productCode: config.defaultProduct.code,
        termMonths: config.defaultProduct.termMonths,
        amortization: "fixed",
        noteRate: config.defaultProduct.noteRate,
      },
    });
    await recordEvent(file.id, "screen_completed", "borrower", { screen: "property_loan" });
    res.status(201).json({ id: file.id, stage: "identity" });
  }),
);

/** Screen 2 — identity. Required before any pull, per APP-005's timing. */
const identitySchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(7),
  dateOfBirth: z.string().date(),
  /**
   * The vault handle, never the SSN. Optional on a REVISIT: going back to fix
   * a typo in your phone number should not require re-entering your Social
   * Security number, and asking for it again is how you train people to type
   * it into anything that asks.
   */
  ssnVaultHandle: z.string().min(1).optional(),
  ssnLast4: z.string().length(4).optional(),
  currentAddress: addressSchema,
  maritalStatus: z.enum(["married", "unmarried", "separated"]),
  citizenship: z
    .enum(["us_citizen", "permanent_resident", "non_permanent_resident"])
    .default("us_citizen"),
  nonBorrowingSpouseName: z.string().optional(),
  preferredLanguage: z.string().default("en"),
  firstTimeHomebuyer: z.boolean(),
  isMilitary: z.boolean().default(false),
  currentHousing: z.enum(["rent", "own", "rent_free"]),
  monthlyRent: z.number().min(0).optional(),
  demographics: z
    .object({
      ethnicity: z.union([z.array(z.string()), z.literal("declined")]),
      race: z.union([z.array(z.string()), z.literal("declined")]),
      sex: z.string(),
      visualObservationNoted: z.boolean().default(false),
    })
    .nullable(),
  statedMonthlyIncome: z.number().positive(),
});

fileRouter.post(
  "/:id/borrowers",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = identitySchema.parse(req.body);

    await assertFileAccess(id, req.user!.id, "write");
    const existing = await loadLoanFile(id);
    if (!existing) throw new AppError(404, "Loan file not found", "NOT_FOUND");

    const existingBorrower = await prisma.borrower.findFirst({
      where: { loanFileId: id },
      select: { id: true },
    });

    if (!existingBorrower && (!input.ssnVaultHandle || !input.ssnLast4)) {
      throw new AppError(400, "An SSN is required the first time.", "SSN_REQUIRED");
    }

    const borrowerData = {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
      dateOfBirth: new Date(input.dateOfBirth),
      ...(input.ssnVaultHandle ? { ssnVaultHandle: input.ssnVaultHandle } : {}),
      ...(input.ssnLast4 ? { ssnLast4: input.ssnLast4 } : {}),
      addressLine1: input.currentAddress.line1,
      addressLine2: input.currentAddress.line2 ?? null,
      addressCity: input.currentAddress.city,
      addressState: input.currentAddress.state.toUpperCase(),
      addressPostalCode: input.currentAddress.postalCode,
      maritalStatus: input.maritalStatus,
      citizenship: input.citizenship,
      nonBorrowingSpouseName: input.nonBorrowingSpouseName ?? null,
      // In a community property state a married borrower's spouse must be
      // identified and may have to sign even when not on the loan.
      nonBorrowingSpouseSignatureRequired:
        input.maritalStatus === "married" && Boolean(input.nonBorrowingSpouseName),
      preferredLanguage: input.preferredLanguage,
      demographics: input.demographics ?? undefined,
      firstTimeHomebuyer: input.firstTimeHomebuyer,
      isMilitary: input.isMilitary,
      currentHousing: input.currentHousing,
      monthlyRent: input.monthlyRent ?? null,
    };

    // Going back to screen 2 and saving again must UPDATE the person, not add a
    // second one. Two borrower rows would double every income and asset test
    // that iterates them.
    if (existingBorrower) {
      await prisma.borrower.update({ where: { id: existingBorrower.id }, data: borrowerData });
      await recordEvent(id, "screen_revised", "borrower", { screen: "identity" });
    } else {
      // The guard above already refused a first save without one; this narrows
      // the type at the single site that genuinely requires it.
      await prisma.borrower.create({
        data: {
          ...borrowerData,
          loanFileId: id,
          ssnVaultHandle: input.ssnVaultHandle!,
          ssnLast4: input.ssnLast4!,
        },
      });
      await recordEvent(id, "screen_completed", "borrower", { screen: "identity" });
    }

    await advanceStage(id, "CREDIT");

    const refreshed = await loadLoanFile(id);
    const stampedAt = refreshed
      ? await stampApplicationIfComplete(refreshed, input.statedMonthlyIncome)
      : null;

    res.status(201).json({
      id,
      stage: "credit",
      applicationReceivedAt: stampedAt,
      loanEstimateDueAt: stampedAt
        ? loanEstimateDueAt({
            ...refreshed!,
            application: { receivedAt: stampedAt, sixPieces: {} as never },
          })
        : null,
    });
  }),
);

/** Everything this user may open: their own files, plus the shared demo set. */
fileRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    res.json({ files: await listAccessibleFiles(req.user!.id) });
  }),
);

/**
 * Delete a file and everything under it.
 *
 * The append-only rule on `connector_snapshots` and `decisions` is about never
 * REWRITING history — a re-pull adds a row rather than mutating one. It was
 * never a claim that a person cannot remove their own data, and reading it
 * that way would be using an audit property as an excuse. Every child relation
 * cascades from `loan_files`, so one delete takes the borrower, the consents,
 * the snapshots, the decisions and the events with it.
 */
fileRouter.delete(
  "/:id",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    // "write" is what refuses demo files here, which is right: a shared
    // fixture is not any one person's to delete.
    await assertFileAccess(id, req.user!.id, "write");
    await prisma.loanFile.delete({ where: { id } });
    res.status(204).end();
  }),
);

fileRouter.get(
  "/:id",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    await assertFileAccess(id, req.user!.id, "read");
    const file = await loadLoanFile(id);
    if (!file) throw new AppError(404, "Loan file not found", "NOT_FOUND");
    res.json({ file, loanEstimateDueAt: loanEstimateDueAt(file) });
  }),
);
