/**
 * Creating and advancing a loan file.
 *
 * Screens 1 and 2 write through here. Everything else in the flow is a
 * connector call or a computation, which is the point of the design: the
 * borrower types twice and connects four times.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "@sm/db";
import { config } from "../config.js";
import { AppError, asyncRoute } from "../middleware/error-handler.js";
import { loadLoanFile, recordEvent } from "../services/repository.js";
import { loanEstimateDueAt, stampApplicationIfComplete } from "../services/application.js";

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
});

const PURPOSE_TO_DB = {
  purchase: "PURCHASE",
  rate_term_refinance: "RATE_TERM_REFINANCE",
  cash_out_refinance: "CASH_OUT_REFINANCE",
} as const;

fileRouter.post(
  "/",
  asyncRoute(async (req, res) => {
    const input = propertyLoanSchema.parse(req.body);
    const file = await prisma.loanFile.create({
      data: {
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
        financedPropertyCount: input.financedPropertyCount,
        interestedPartyContributions: input.interestedPartyContributions,
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
  /** The vault handle, never the SSN. The client never sends the number here. */
  ssnVaultHandle: z.string().min(1),
  ssnLast4: z.string().length(4),
  currentAddress: addressSchema,
  maritalStatus: z.enum(["married", "unmarried", "separated"]),
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

    const existing = await loadLoanFile(id);
    if (!existing) throw new AppError(404, "Loan file not found", "NOT_FOUND");

    await prisma.borrower.create({
      data: {
        loanFileId: id,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
        dateOfBirth: new Date(input.dateOfBirth),
        ssnVaultHandle: input.ssnVaultHandle,
        ssnLast4: input.ssnLast4,
        addressLine1: input.currentAddress.line1,
        addressLine2: input.currentAddress.line2 ?? null,
        addressCity: input.currentAddress.city,
        addressState: input.currentAddress.state.toUpperCase(),
        addressPostalCode: input.currentAddress.postalCode,
        maritalStatus: input.maritalStatus,
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
      },
    });

    await prisma.loanFile.update({ where: { id }, data: { stage: "CREDIT" } });
    await recordEvent(id, "screen_completed", "borrower", { screen: "identity" });

    const refreshed = await loadLoanFile(id);
    const stampedAt = refreshed
      ? await stampApplicationIfComplete(refreshed, input.statedMonthlyIncome)
      : null;

    res.status(201).json({
      id,
      stage: "credit",
      applicationReceivedAt: stampedAt,
      loanEstimateDueAt: stampedAt
        ? loanEstimateDueAt({ ...refreshed!, application: { receivedAt: stampedAt, sixPieces: {} as never } })
        : null,
    });
  }),
);

fileRouter.get(
  "/:id",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const file = await loadLoanFile(id);
    if (!file) throw new AppError(404, "Loan file not found", "NOT_FOUND");
    res.json({ file, loanEstimateDueAt: loanEstimateDueAt(file) });
  }),
);
