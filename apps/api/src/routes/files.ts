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
import { AppError, asyncRoute } from "../middleware/error-handler.js";
import {
  assertFileAccess,
  assertFileMayBeDeleted,
  listAccessibleFiles,
  loadLoanFile,
  recordEvent,
  STAGE_TO_DOMAIN,
} from "../services/repository.js";
import { primaryBorrowerRow } from "../services/borrower-order.js";
import { nameCoBorrower, removeNamedCoBorrower } from "../services/co-borrowers.js";
import { inviteCoBorrower } from "../services/invitations.js";
import { memberView } from "../services/member-view.js";
import { assertPurposeInScope } from "../services/scope.js";
import { connectors } from "../services/connectors.js";
import { quoteSubjectProduct } from "../services/pricing.js";
import { advanceStage } from "../services/stage.js";
import {
  assertFacts,
  liveFact,
  partyForUser,
  partyOfUser,
  principalForParty,
  recordBorrowerFacts,
} from "../services/party.js";
import {
  applicationForFile,
  createDraftApplication,
  ensureApplicationParty,
  scenarioTermsFrom,
  syncScenario,
} from "../services/applications.js";
import {
  applicationStanding,
  rawLedger,
  settleAfterIntake,
  settleReconciledEvidence,
} from "../services/standing.js";

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
   * until a connector returns. See packages/shared/src/trid.ts.
   */
  statedMonthlyIncome: z.number().positive(),
  financedPropertyCount: z.number().int().min(1).default(1),
  interestedPartyContributions: z.number().min(0).default(0),
  /**
   * Cash-out only, and V1 takes no cash-out, so nothing sends either of these
   * today. They stay in the shape for the reason the columns stay in the
   * table: AST-012 wants the proceeds purpose documented, that requirement is
   * still in the sheet, and a later version needs somewhere to put both
   * answers. `assertPurposeInScope` is what stops the loan; these are what it
   * would be asked about when it stops being stopped.
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
    await assertFileAccess(id, req.user!.id, "own");
    // Before the transaction, so a purpose we do not underwrite never retires
    // a scenario or mints a version on the way to being refused. A file that
    // ALREADY says cash-out is not rewritten here: it keeps what the borrower
    // asked for, and this is what it takes to save it again.
    if (input.purpose !== undefined) assertPurposeInScope(input.purpose);

    // The row and the terms it implies move together. A scenario is immutable,
    // so an edit that changes the address or the amount RETIRES the active
    // scenario and proposes the next one — and a save that changed neither
    // must not mint a version, which is what `syncScenario` decides.
    const row = await prisma.$transaction(async (tx) => {
      /*
       * Read before the write, because whether the address MOVED is what
       * decides one of the fields being written.
       *
       * Screen 1 sends the address on every save, changed or not, so a rule
       * keyed on the field being present clears the match on a borrower who
       * came back to fix the price. Nothing sets `addressVerified` true again
       * outside file creation, so that is APP-004 permanently unsatisfied by
       * an edit that changed nothing about the property.
       */
      const before = input.address
        ? await tx.loanFile.findUniqueOrThrow({
            where: { id },
            select: {
              propertyLine1: true,
              propertyLine2: true,
              propertyCity: true,
              propertyState: true,
              propertyPostalCode: true,
            },
          })
        : null;
      const addressMoved = Boolean(
        input.address &&
        before &&
        (before.propertyLine1 !== input.address.line1 ||
          before.propertyLine2 !== (input.address.line2 ?? null) ||
          before.propertyCity !== input.address.city ||
          before.propertyState !== input.address.state.toUpperCase() ||
          before.propertyPostalCode !== input.address.postalCode),
      );

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
                // property nobody has looked up. An address that did not move
                // keeps the match it already has.
                //
                // The unit count, the attachment and the estate type go with it,
                // and they go in the database:
                // `loan_files_building_follows_the_address` nulls whichever of
                // the three this statement does not restate, so a second door
                // onto the address cannot forget to.
                ...(addressMoved ? { addressVerified: false } : {}),
              }
            : {}),
          ...(input.cashOutPurpose !== undefined ? { cashOutPurpose: input.cashOutPurpose } : {}),
          ...(input.cashToBorrower !== undefined ? { cashToBorrower: input.cashToBorrower } : {}),
        },
      });

      // A corrected income is still an income the borrower stated, and it is
      // stated HERE. Parsing it and dropping it is what left the party's fact
      // holding the figure the borrower had already fixed — and the receipt
      // pins that fact as one of the six pieces, so the correction has to land
      // in the same place the first answer did.
      if (input.statedMonthlyIncome !== undefined) {
        const partyId = await partyForUser(tx, req.user!.id);
        const principalId = await principalForParty(tx, partyId);
        await assertFacts(tx, partyId, principalId, [
          { predicate: "monthly_income", value: input.statedMonthlyIncome },
        ]);
        // A corrected income supersedes the fact an application borrowed, and
        // a pin on a superseded fact is evidence of something the borrower has
        // already taken back. Every application this person is applying on,
        // not only this file's: the figure belongs to the person, and the file
        // the request happens to be about is not the only one relying on it.
        // Which also means this can RECEIVE one of those other applications —
        // an income is the sixth piece — so what follows a receipt is settled
        // wherever the reconciliation fired one. The pins move first, so the
        // scenario insert below, itself a receipt writer, counts what is true
        // now.
        await settleReconciledEvidence(tx, { partyId, causedBy: "screen:property_loan" });
      }

      const app = await applicationForFile(tx, id);
      if (app) {
        await syncScenario(tx, app.id, updated);
        // Both writers above can stamp the receipt, so this screen settles what
        // follows one exactly as screen 2 and the consent do. A borrower who
        // fixes a blank value here is applying, and an application that was
        // received and never told anyone what it wanted next would show no
        // "Needs you" and no line in the timeline asking for the bank. It costs
        // one SELECT and does nothing unless this save is what received the
        // file.
        await settleAfterIntake(tx, {
          applicationId: app.id,
          loanFileId: id,
          causedBy: "screen:property_loan",
        });
      }
      // Inside, with the save it describes. A revision that committed and then
      // failed to record left the event stream saying the borrower never
      // touched the screen, which is the one place a support question about a
      // changed price would be answered from.
      await recordEvent(
        id,
        "screen_revised",
        "borrower",
        { screen: "property_loan" },
        undefined,
        tx,
      );
      return updated;
    });

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
    // Before the quote, because asking a pricing vendor for a rate on a loan
    // we will not take is a round trip spent to reach a refusal.
    assertPurposeInScope(input.purpose);

    // Priced before the transaction opens, because a quote is a round trip to
    // a vendor and a transaction held open across one holds row locks for as
    // long as somebody else's server takes. It raises rather than falling back
    // when no rate comes: a file written with a rate nobody quoted carries it
    // into every ratio on the decision.
    //
    // Once, at creation. A later revision of screen 1 changes the price and
    // the amount and does NOT re-quote, which is what happened before this
    // port existed too — whether a borrower's rate may move under them when
    // they fix a typo is a question with a disclosure attached, not a line of
    // code.
    const product = await quoteSubjectProduct(connectors().pricing, {
      purpose: input.purpose,
      occupancy: input.occupancy,
      propertyType: input.propertyType,
      state: input.address.state,
      loanAmount: input.loanAmount,
      propertyValue: input.valueOrPrice,
    });

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
          // Ownership is set at creation and never changes. Every file has an
          // owner now, a sample borrower's included; the column is still
          // nullable only because the old demo seed's rows were, and nothing
          // writes one any more.
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
          // one. Which product is `config.quotedProductCode`; everything else
          // about it came off the quote above. The window and the lock column
          // go down with the rate, so a figure read back later can be told
          // apart from one quoted this morning.
          productCode: product.productCode,
          termMonths: product.termMonths,
          noteRate: product.noteRate,
          rateQuoteLockDays: product.lockDays,
          rateQuotedAt: product.effectiveAt,
          rateQuoteExpiresAt: product.expiresAt,
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
      // That supersession lands on the PERSON, so it reaches every application
      // they are applying on — including the one on the file they started last
      // month, which borrowed the figure this save just replaced and has no
      // other reason to be looked at today. If restating the income is what
      // completes that one's six pieces, it is received here, by a request
      // about a different file, and it is settled here too. Before the draft
      // below exists, because the new application has nothing pinned to it yet.
      await settleReconciledEvidence(tx, { partyId, causedBy: "screen:property_loan" });

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
  /**
   * Optional, and absent means "not asked" rather than "rent".
   *
   * This was a required enum, and screen 2 satisfied it by posting the literal
   * `"rent"` from a screen with no such question on it. `du_residences` is
   * where the real answer goes and the residence route is what asks; what is
   * left here is the echo a revisit sends back, so a value is written and an
   * absence leaves whatever the borrower actually stated standing. Blanking on
   * every save of screen 2 would undo the answer the residence screen took.
   */
  currentHousing: z.enum(["rent", "own", "rent_free"]).nullish(),
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

    await assertFileAccess(id, req.user!.id, "self");
    // No projection before the write: assertFileAccess already answered 404,
    // and a party whose facts will not project must be repairable by saving
    // this screen again. The projection runs once, after the write.

    // Whose record this screen is about: Borrower 1 by ordinal, which is the
    // person the screen prefilled itself from. A file can carry more than one
    // borrower row, and left unordered the planner chose which of them screen
    // 2 superseded, updated and promoted to PRIMARY_BORROWER — so on a
    // co-borrower file the pins, the TRID receipt and the Loan Estimate clock
    // could land on the wrong person from one save to the next. Creation order
    // fixed the planner and not the question: on a file whose ordinal 1 was
    // refilled it names the person the replacement took over from, so the
    // screen showed one borrower's details and saved them onto another's row.
    //
    // Unless the person asking is somebody else on the file. A co-borrower
    // who claimed their invitation holds a borrower row of their own — the
    // merge moved it onto the party their sign-in created — and this screen
    // is theirs about themselves: their row, their facts, their membership
    // in the role they already hold. Resolved by party first, so the
    // applicant's revisit and the co-borrower's first save are the same
    // question with two answers rather than two questions.
    const primary = await primaryBorrowerRow(prisma, id);
    const asking = await partyOfUser(prisma, req.user!.id);
    const own =
      asking && primary?.partyId !== asking
        ? await prisma.borrower.findFirst({
            where: { loanFileId: id, partyId: asking },
            select: { id: true, partyId: true, ssnLast4: true },
          })
        : null;
    const existingBorrower = own ?? primary;
    const aboutTheApplicant = own === null;

    // A first save is the first time a NUMBER is stated: a named co-borrower
    // has a row before they have typed anything, and `ssn_last4` is what
    // says whether they have.
    if (!existingBorrower?.ssnLast4 && (!input.ssnVaultHandle || !input.ssnLast4)) {
      throw new AppError(400, "An SSN is required the first time.", "SSN_REQUIRED");
    }

    // The same rule for the sixth piece. Income is optional on this screen
    // because screen 1 is where it is stated and a revisit need not restate
    // it — but a first save with no figure anywhere is a person nothing knows
    // an income for, and saying it is a dollar would not change that. The
    // screen carries the field for exactly this case, so asking is a question
    // the borrower can answer rather than a dead end.
    // The applicant's rule. A co-borrower never saw screen 1, and their
    // income is asked where their own half asks it.
    if (aboutTheApplicant && !existingBorrower && input.statedMonthlyIncome === undefined) {
      const onFile = req.user!.partyId
        ? await liveFact(prisma, req.user!.partyId, "monthly_income")
        : null;
      if (!onFile) {
        throw new AppError(400, "Your monthly income is needed the first time.", "INCOME_REQUIRED");
      }
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
      // The basis and the rent move together, and only when the basis is
      // stated. An absent basis is the absence of an answer, and writing it
      // would blank the one `du_residences` is the source of truth for.
      ...(input.currentHousing != null
        ? { currentHousing: input.currentHousing, monthlyRent: input.monthlyRent ?? null }
        : {}),
    };

    // The person and the application record are written in ONE transaction,
    // so a request records both or neither. Going back to screen 2 and saving
    // again must UPDATE the person, not add a second one: the earlier
    // assertion of each fact is superseded, and the row is updated in place.
    await prisma.$transaction(async (tx) => {
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

      // The person is now on the credit request, and the facts they just
      // stated are borrowed into it under whatever authorization they hold.
      // On a first-ever save there is none — the consent screen 2 posts next
      // is what mints it — so the reconciler does nothing here and `/consents`
      // pins. On a revisit the grant is live, so a corrected name supersedes
      // its fact here and the pin moves to the successor in the same
      // transaction: the application never holds a pin on a fact the borrower
      // has replaced.
      //
      // Every application, not only this one. A corrected surname supersedes
      // the fact on the PERSON, so a borrower with two files who fixes their
      // name on the second would otherwise leave the first application pinned
      // to a name they have taken back — the same thing the income correction
      // on screen 1 goes out of its way to avoid, and there is no reading of a
      // pin under which it is true of one piece and false of another. The
      // membership is written first so this file's own application is one of
      // the ones reconciled — and the settle that follows covers all of them,
      // because a save that receives somebody's OTHER file has to say what
      // that file owes next just as much as this one does.
      const app = await applicationForFile(tx, id);
      if (app) {
        // The applicant is Borrower 1. A co-borrower already holds their
        // place, in the role the applicant's answer about occupancy gave
        // them, and saving their own details does not change it.
        if (aboutTheApplicant) {
          await ensureApplicationParty(tx, app.id, partyId, "PRIMARY_BORROWER");
        }
        await settleReconciledEvidence(tx, { partyId, causedBy: "screen:identity" });
      }
    });
    await recordEvent(
      id,
      existingBorrower?.ssnLast4 ? "screen_revised" : "screen_completed",
      "borrower",
      { screen: "identity", borrowerId: existingBorrower?.id ?? null },
    );

    await advanceStage(id, "CREDIT");

    // Read the file back once, so a party whose facts will not project fails
    // here — as a 500 the client routes to the repair screen — rather than on
    // the next screen's read. Nothing is done with the result: the receipt is
    // the database's now, and the only thing this screen has left to report is
    // where the application stands.
    await loadLoanFile(id);

    res.status(201).json({
      id,
      stage: "credit",
      applicationState: await applicationStanding(prisma, id),
    });
  }),
);

/**
 * A second person on this application, named by the applicant.
 *
 * Name, email and whether they will live in the home. Nothing else: the
 * co-borrower completes their own profile and gives their own permissions in
 * their own session — a separate, private application — and the applicant
 * never types their date of birth or their Social Security number. Until they
 * arrive the file lists them as invited and cannot be signed, decided or
 * submitted; "your co-borrower needs to finish."
 *
 * Create-only, and it never touches borrower 1. Up to four people in all, which
 * the ordinal allocator enforces under a lock on the application row.
 */
const namedCoBorrowerSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    email: z.string().trim().email().max(254),
    occupiesProperty: z.boolean(),
  })
  // Strict, so an identity posted here is refused rather than stripped to
  // the two fields inside it that the applicant may state. A client still
  // sending a date of birth and a Social Security number about somebody else
  // is the shape this route exists to end, and it should hear so.
  .strict();

fileRouter.post(
  "/:id/co-borrowers",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = namedCoBorrowerSchema.parse(req.body);
    await assertFileAccess(id, req.user!.id, "own");
    const appended = await nameCoBorrower(id, input);
    res.status(201).json(appended);
  }),
);

/**
 * Send a named person their link. The applicant's to do, and a re-send
 * revokes the last one. The token is in the email and nowhere else; the
 * response says where it went and until when, and — only where developer
 * sign-in is available, which is the one environment with no inbox — the
 * link itself.
 */
fileRouter.post(
  "/:id/co-borrowers/:borrowerId/invitations",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const borrowerId = z.string().uuid().parse(req.params.borrowerId);
    await assertFileAccess(id, req.user!.id, "own");
    const invited = await inviteCoBorrower(id, borrowerId, connectors().mail);
    res.status(201).json(invited);
  }),
);

/**
 * Take a named person off the application, while that is still the
 * applicant's to do — refused for the applicant, and refused once the person
 * has signed in.
 */
fileRouter.delete(
  "/:id/co-borrowers/:borrowerId",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const borrowerId = z.string().uuid().parse(req.params.borrowerId);
    await assertFileAccess(id, req.user!.id, "own");
    await removeNamedCoBorrower(id, borrowerId);
    res.status(204).end();
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
    await assertFileAccess(id, req.user!.id, "own");
    // The refusal and the delete in one transaction: something moves an
    // application now, so a file that was a draft when it was read must not be
    // deleted after it stopped being one.
    await prisma.$transaction(async (tx) => {
      await assertFileMayBeDeleted(id, tx);
      await tx.loanFile.delete({ where: { id } });
    });
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
    // Which of these people is the one reading the screen, by party.
    //
    // The file itself cannot say — `loadLoanFile` is about the application and
    // knows nothing about who asked for it — so the answer rides beside it
    // rather than on it. Without it the screens had only a position to read,
    // and on a file whose Borrower 1 has been replaced they are two different
    // people: the transcript step asked whether BORROWER 1 had signed a
    // 4506-C, told the borrower actually present that we needed a signature
    // she had already given, and the pull behind it is about her.
    //
    // Null for somebody reading a file they are not a borrower on, which a
    // demo file is: the sample borrowers are readable by everybody and are
    // nobody else's own.
    const you = await partyOfUser(prisma, req.user!.id);
    const yourRow =
      file.borrowers.find((b) => b.partyId === you)?.id ??
      // A co-borrower who has claimed their invitation and not yet said who
      // they are: on the file, in their own session, with a row that is
      // theirs — and screen 2 is what they are here to fill in.
      file.invitedBorrowers.find((b) => b.partyId === you)?.id ??
      null;
    // The owner reads the whole file. A member — a co-borrower on it — reads
    // the household's half and their own, and nobody else's person.
    const owner = await prisma.loanFile.findUniqueOrThrow({
      where: { id },
      select: { userId: true },
    });
    const yours = owner.userId === req.user!.id;
    res.json({
      file: yours ? file : memberView(file, yourRow),
      you: yourRow,
      // Whether the reader is the applicant. A co-borrower is on the file
      // and not its owner, and the screens they see are theirs alone.
      owner: yours,
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
