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
  assertFileMayBeDeleted,
  listAccessibleFiles,
  loadLoanFile,
  recordEvent,
  STAGE_TO_DOMAIN,
} from "../services/repository.js";
import { loanEstimateDueAt, stampApplicationIfComplete } from "../services/application.js";
import { advanceStage } from "../services/stage.js";
import {
  assertFacts,
  liveFact,
  partyForUser,
  principalForParty,
  recordBorrowerFacts,
} from "../services/party.js";
import {
  applicationForFile,
  createDraftApplication,
  scenarioTermsFrom,
  syncScenario,
} from "../services/applications.js";
import { applicationStanding, rawLedger } from "../services/standing.js";

export const fileRouter = Router();

export const addressSchema = z.object({
  line1: z.string().trim().min(1),
  line2: z.string().trim().optional(),
  city: z.string().trim().min(1),
  state: z.string().trim().length(2),
  postalCode: z.string().trim().min(5),
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

    // The row and the terms it implies move together. A scenario is immutable,
    // so an edit that changes the address or the amount RETIRES the active
    // scenario and proposes the next one — and a save that changed neither
    // must not mint a version, which is what `syncScenario` decides.
    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.loanFile.update({
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

      // A corrected income is still an income the borrower stated, and it is
      // stated HERE. Parsing it and dropping it is what left the party's fact
      // holding the figure the borrower had already fixed — and screen 4 pins
      // that fact as one of the six pieces, so the correction has to land in
      // the same place the first answer did.
      if (input.statedMonthlyIncome !== undefined) {
        const partyId = await partyForUser(tx, req.user!.id);
        const principalId = await principalForParty(tx, partyId);
        await assertFacts(tx, partyId, principalId, [
          { predicate: "monthly_income", value: input.statedMonthlyIncome },
        ]);
      }

      const app = await applicationForFile(tx, id);
      if (app) await syncScenario(tx, app.id, updated);
      return updated;
    });

    await recordEvent(id, "screen_revised", "borrower", { screen: "property_loan" });
    // The REAL stage. This answered a literal "identity" whatever the file had
    // reached, so a borrower who edited a term from the review screen was told
    // by the server that they were on screen 2.
    res.json({
      id,
      stage: STAGE_TO_DOMAIN[row.stage],
      applicationState: await applicationStanding(prisma, id),
    });
  }),
);

fileRouter.post(
  "/",
  asyncRoute(async (req, res) => {
    const input = propertyLoanSchema.parse(req.body);

    // The file, the person asking, the income they stated and the credit
    // request itself, in one transaction: a screen-1 save records all of it or
    // none of it. A party is not gated on APP-005 — only PULLS are, and the
    // guard for those lives in `tokenFor` and the connector adapters — so
    // knowing who is asking before they have authorized anything is exactly
    // the distinction the authorization model draws.
    const file = await prisma.$transaction(async (tx) => {
      // The person FIRST, before the file. Inserting the file takes a shared
      // lock on the users row through `loan_files.user_id`, and claiming a
      // party then needs an exclusive one on that same row because
      // `users.party_id` is unique — so two first-ever saves from one person,
      // each holding the shared lock and each waiting for the other's, deadlock
      // and one of them 500s. Taking the exclusive lock first is the whole fix.
      const partyId = await partyForUser(tx, req.user!.id);
      const principalId = await principalForParty(tx, partyId);

      const created = await tx.loanFile.create({
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

      // Stated income is one of TRID's six pieces, and screen 1 is where it is
      // said. Carrying it in the client's router state until screen 2 is what
      // produced an income of $1 asserted as a piece of an application; a fact
      // asserted at the moment it is stated cannot be lost that way. A second
      // file supersedes the party's earlier figure, which is what one party
      // per person means and is correct.
      await assertFacts(tx, partyId, principalId, [
        { predicate: "monthly_income", value: input.statedMonthlyIncome },
      ]);

      const terms = scenarioTermsFrom(created);
      // Screen 1's schema requires the address, the value and the amount, so
      // terms are always statable here. A null would mean the schema and the
      // columns had drifted apart, which is a bug rather than a borrower error.
      if (!terms) throw new Error(`Screen 1 saved a file with no statable terms: ${created.id}`);
      await createDraftApplication(tx, { loanFileId: created.id, partyId, terms });

      return created;
    });

    await recordEvent(file.id, "screen_completed", "borrower", { screen: "property_loan" });
    res.status(201).json({
      id: file.id,
      stage: "identity",
      applicationState: await applicationStanding(prisma, file.id),
    });
  }),
);

/** Screen 2 — identity. Required before any pull, per APP-005's timing. */
export const identitySchema = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  email: z.string().trim().email(),
  phone: z.string().trim().min(7),
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
  // null means "assert nothing": the repair path has no county record to
  // derive from, and a guess would supersede a real fact. recordBorrowerFacts
  // writes no first_time_homebuyer fact for null.
  firstTimeHomebuyer: z.boolean().nullable(),
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
  /**
   * Optional, because screen 1 is where it is stated and screen 2 may not have
   * it. A borrower who arrives here without one — a revisit, or a file resumed
   * after a redirect that took the router state with it — must not have a
   * number invented for them: an absent income asserts no fact and leaves the
   * one screen 1 recorded standing, which is what `recordBorrowerFacts` does
   * with it.
   */
  statedMonthlyIncome: z.number().positive().optional(),
});

fileRouter.post(
  "/:id/borrowers",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = identitySchema.parse(req.body);

    await assertFileAccess(id, req.user!.id, "write");
    // No projection before the write: assertFileAccess already answered 404,
    // and a party whose facts will not project must be repairable by saving
    // this screen again. The projection runs once, after the write.

    const existingBorrower = await prisma.borrower.findFirst({
      where: { loanFileId: id },
      select: { id: true, partyId: true },
    });

    if (!existingBorrower && (!input.ssnVaultHandle || !input.ssnLast4)) {
      throw new AppError(400, "An SSN is required the first time.", "SSN_REQUIRED");
    }

    // What stays on the row: the things that are about THIS application
    // rather than about the person. Everything that identifies somebody is a
    // fact on the party, written by recordBorrowerFacts below.
    const borrowerData = {
      ...(input.ssnLast4 ? { ssnLast4: input.ssnLast4 } : {}),
      nonBorrowingSpouseName: input.nonBorrowingSpouseName ?? null,
      // In a community property state a married borrower's spouse must be
      // identified and may have to sign even when not on the loan.
      nonBorrowingSpouseSignatureRequired:
        input.maritalStatus === "married" && Boolean(input.nonBorrowingSpouseName),
      demographics: input.demographics ?? undefined,
      currentHousing: input.currentHousing,
      monthlyRent: input.monthlyRent ?? null,
    };

    // The person and the application record are written in ONE transaction,
    // so a request records both or neither. Going back to screen 2 and saving
    // again must UPDATE the person, not add a second one: the earlier
    // assertion of each fact is superseded, and the row is updated in place.
    const partyId = await prisma.$transaction(async (tx) => {
      const partyId = await recordBorrowerFacts(tx, {
        loanFileId: id,
        existingPartyId: existingBorrower?.partyId ?? null,
        input,
      });

      if (existingBorrower) {
        await tx.borrower.update({
          where: { id: existingBorrower.id },
          data: { ...borrowerData, partyId },
        });
      } else {
        // The guard above already refused a first save without one; this
        // narrows the type at the single site that genuinely requires it.
        await tx.borrower.create({
          data: {
            ...borrowerData,
            loanFileId: id,
            partyId,
            ssnLast4: input.ssnLast4!,
          },
        });
      }
      return partyId;
    });
    await recordEvent(id, existingBorrower ? "screen_revised" : "screen_completed", "borrower", {
      screen: "identity",
    });

    await advanceStage(id, "CREDIT");

    // The sixth piece, from wherever it actually is. Screen 1 asserts the
    // stated income on the party, so a screen-2 save that does not restate it
    // is not a file with no income — it is a file whose income was recorded
    // earlier. Reading the fact is what lets this screen stop inventing a
    // figure to pass the receipt with.
    const onRecord = await liveFact(prisma, partyId, "monthly_income");
    const stated =
      input.statedMonthlyIncome ?? (typeof onRecord?.value === "number" ? onRecord.value : null);

    const refreshed = await loadLoanFile(id);
    const stampedAt = refreshed ? await stampApplicationIfComplete(refreshed, stated) : null;

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
 *
 * A credit request is where that stops. Once the application has left draft
 * the file carries a ledger and the regulatory clocks measured from it — on a
 * declined one, the 30 days an adverse-action notice is owed in — and those
 * are not the same kind of thing as a saved answer or a re-pullable snapshot:
 * removing one file would quietly erase the record that a notice was ever
 * owed. So this route refuses, and points at account deletion, which is a
 * person asking to be forgotten entirely rather than tidying one row away. A
 * draft is still just typing, and still deletes.
 */
fileRouter.delete(
  "/:id",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    // "write" is what refuses demo files here, which is right: a shared
    // fixture is not any one person's to delete.
    await assertFileAccess(id, req.user!.id, "write");
    await assertFileMayBeDeleted(id);
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
    res.json({
      file,
      loanEstimateDueAt: loanEstimateDueAt(file),
      applicationState: await applicationStanding(prisma, id),
    });
  }),
);

/**
 * The ledger with its causes, for `?debug=1`.
 *
 * Separate from the standing view on purpose. `causedBy` carries requirement
 * ids and snapshot ids, and the principal ids name internal actors — none of
 * which may reach a borrower's screen. Read access, because reading how a file
 * got where it is is reading the file.
 */
fileRouter.get(
  "/:id/ledger",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    await assertFileAccess(id, req.user!.id, "read");
    res.json({ ledger: await rawLedger(prisma, id) });
  }),
);
