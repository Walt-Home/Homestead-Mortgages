/**
 * Where Section 5 and the residence answers come in.
 *
 * Screen 3 posts here. The route shipped a commit ahead of it because the
 * column it makes true had to stop being fabricated then:
 * `borrowers.current_housing` was NOT NULL with a default of `'rent'` and no
 * screen ever asked, so the alternative to shipping somewhere for the real
 * answer to go was a nullable column and nothing able to fill it.
 *
 * Every field Desktop Underwriter requires is required HERE, not merely
 * non-null in the table. A partial submit is a 400 with the field named, rather
 * than a row half-written and completed with `false` on a document the borrower
 * signs.
 *
 * And every rule the two tables enforce is stated here as well as there. The
 * database stays the backstop — it is where an invariant that matters belongs —
 * but a body only the database refuses reaches the caller as a 500 with nothing
 * named, which is the same refusal with the field filed off. Each check below
 * names the constraint it mirrors, so a constraint that moves has somewhere
 * obvious to move to.
 *
 * Money crosses this edge in dollars. The columns are bigint cents, `res.json`
 * throws on a bigint, and the conversion lives in the service's view — which is
 * what the response is built from and not a second shape assembled here.
 */

import { recordEmploymentDeclarations } from "../services/employment-declarations.js";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@hm/db";
import { asyncRoute } from "../middleware/error-handler.js";
import { assertFileAccess } from "../services/repository.js";
import { loadDeclaration, recordDeclaration } from "../services/declarations.js";
import { partyForUser, principalForParty } from "../services/party.js";
import { advanceStage } from "../services/stage.js";

export const declarationRouter = Router();

const yesNo = z.enum(["Yes", "No"]);

/**
 * Nine integer digits and two decimals is the widest amount the wire takes, and
 * both money columns carry it as a CHECK. Rejecting it here is the difference
 * between a named field and a 500.
 */
const AMOUNT_9_2_MAX = 999_999_999.99;
const dollars = z.number().min(0).max(AMOUNT_9_2_MAX);

/**
 * The twelve answers DU requires, and the five it does not.
 *
 * The optional ones are optional for a stated reason apiece: `partyToLawsuit`
 * is required only on a government file, `fhaSecondaryResidence` only on an FHA
 * one, `specialBorrowerSellerRelationship` only on a purchase, and the two
 * prior-property fields only once the borrower says they have owned before.
 * Anything not on that list is required, because the wire has no way to say
 * "unanswered" — every element is nillable, and a nil answer to "have you
 * declared bankruptcy" is not an answer.
 */
const declarationSchema = z.object({
  intentToOccupy: yesNo,
  homeownerPastThreeYears: yesNo.nullish(),
  priorPropertyUsage: z.enum(["Investment", "PrimaryResidence", "SecondHome"]).nullish(),
  priorPropertyTitle: z.enum(["Sole", "JointWithSpouse", "JointWithOtherThanSpouse"]).nullish(),
  fhaSecondaryResidence: z.boolean().nullish(),
  specialBorrowerSellerRelationship: z.boolean().nullish(),
  undisclosedBorrowedFunds: z.boolean(),
  /** Dollars. The column is cents. */
  undisclosedBorrowedFundsAmount: dollars.nullish(),
  undisclosedMortgageApplication: z.boolean(),
  undisclosedCreditApplication: z.boolean(),
  propertyProposedCleanEnergyLien: z.boolean(),
  undisclosedComakerOfNote: z.boolean(),
  outstandingJudgments: z.boolean(),
  presentlyDelinquent: z.boolean(),
  partyToLawsuit: z.boolean().nullish(),
  priorPropertyDeedInLieuConveyed: z.boolean(),
  priorPropertyShortSaleCompleted: z.boolean(),
  priorPropertyForeclosureCompleted: z.boolean(),
  bankruptcy: z.boolean(),
  bankruptcyChapters: z
    .array(z.enum(["ChapterSeven", "ChapterEleven", "ChapterTwelve", "ChapterThirteen"]))
    .optional(),
  /**
   * The borrower's own words, by question letter. Stored, never emitted: the DU
   * emission path has no element for an explanation, and a serializer that went
   * looking for one would be inventing a place to put it.
   */
  explanations: z.record(z.string(), z.string()).nullish(),
});

const residenceCore = {
  basis: z.enum(["Own", "Rent", "LivingRentFree"]),
  /** Numeric 3 on the wire. A thousand months is a rejected file, not a long tenancy. */
  durationMonths: z.number().int().min(0).max(999),
  /** Dollars. The column is cents. */
  monthlyRent: dollars.nullish(),
};

/**
 * The CURRENT residence carries no address of its own
 * (`du_residences_current_borrows_the_pinned_address`): it reads the pinned
 * `current_address` fact, so there is one storage and two renderings.
 *
 * The six columns are declared here as nulls rather than left out, because a
 * key zod does not know about is a key zod strips. An address posted on a
 * current residence would vanish silently instead of being refused, and
 * whoever sent it would never learn it belonged on the prior row.
 */
const currentResidence = z.object({
  residencyType: z.literal("Current"),
  ...residenceCore,
  addressLineText: z.null().optional(),
  addressUnit: z.null().optional(),
  cityName: z.null().optional(),
  stateCode: z.null().optional(),
  postalCode: z.null().optional(),
  countryCode: z.null().optional(),
});

/**
 * A PRIOR residence carries its own, because there is no `prior_address`
 * predicate to read one from (`du_residences_prior_carries_its_own_address`).
 * Four of the six are required there and so are required here; the unit and the
 * country are not.
 */
const priorResidence = z.object({
  residencyType: z.literal("Prior"),
  ...residenceCore,
  addressLineText: z.string().min(1).max(50),
  addressUnit: z.string().max(11).nullish(),
  cityName: z.string().min(1).max(35),
  stateCode: z.string().length(2),
  postalCode: z.string().regex(/^([0-9]{5}|[0-9]{9})$/),
  countryCode: z.string().length(2).nullish(),
});

const residenceSchema = z.discriminatedUnion("residencyType", [currentResidence, priorResidence]);

const bodySchema = z
  .object({
    declaration: declarationSchema,
    residences: z.array(residenceSchema).min(1),
    /**
     * Which person on this file is answering. Absent is borrower 1 — the
     * person whose request it is — which is what every file with one borrower
     * on it sends and what screen 3 sends for itself.
     *
     * A co-borrower's answers are their own row on their own edge. Before this
     * existed there was one edge a save could reach, so a second person's
     * answers would have replaced the first person's under the first person's
     * name, on a document both of them sign.
     *
     * Naming somebody else does not let this request answer for them: the row
     * is stamped with the principal of whoever sent it, and
     * `du_declarations_are_self_attested` admits only the declaring borrower
     * or a member of staff. A co-borrower with no session of their own is
     * answered for by nobody.
     */
    borrowerId: z.string().uuid().optional(),
    /**
     * What the loan is secured by, which is the one answer on this screen that
     * is not about the person answering.
     *
     * A sibling of `declaration` rather than a field inside it, because the
     * declaration is a per-borrower row and an estate is a fact about one
     * property: two people buying one house do not hold it on two tenures. It
     * is written to `loan_files`, and a co-borrower's save restates it.
     *
     * Required, on the same rule as everything else here. Desktop Underwriter
     * requires it with no condition in front of it, nothing we retrieve carries
     * it, and there is no way to say "unanswered" on the wire — so a screen that
     * let it through would be a casefile refused later with the borrower gone.
     */
    propertyEstateType: z.enum(["FeeSimple", "Leasehold"]),
  })
  .superRefine((body, ctx) => {
    const d = body.declaration;
    const say = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    // `du_declarations_homeowner_follows_intent`, both directions. A follow-up
    // answered when its trigger question says it was never asked is as wrong as
    // a missing one, and the CHECK is a biconditional for that reason.
    if ((d.intentToOccupy === "Yes") !== (d.homeownerPastThreeYears != null)) {
      say(
        ["declaration", "homeownerPastThreeYears"],
        d.intentToOccupy === "Yes"
          ? "A borrower who will occupy has to answer the homeowner question."
          : "The homeowner question is only put to a borrower who will occupy.",
      );
    }

    // `du_declarations_prior_usage_follows_homeowner`.
    const usageAsked = d.intentToOccupy === "Yes" && d.homeownerPastThreeYears === "Yes";
    if (usageAsked !== (d.priorPropertyUsage != null)) {
      say(
        ["declaration", "priorPropertyUsage"],
        usageAsked
          ? "A borrower who owned a home in the past three years has to say how it was used."
          : "The prior-property usage is only put to a borrower who owned a home.",
      );
    }

    // `du_declarations_borrowed_amount_follows_indicator`.
    if (d.undisclosedBorrowedFunds !== (d.undisclosedBorrowedFundsAmount != null)) {
      say(
        ["declaration", "undisclosedBorrowedFundsAmount"],
        d.undisclosedBorrowedFunds
          ? "Borrowed funds were declared, so the amount has to come with them."
          : "No borrowed funds were declared, so there is no amount to state.",
      );
    }

    // The deferred trigger `du_bankruptcy_chapters_match_the_indicator_*`, which
    // fires at COMMIT and is the one refusal a route cannot see coming.
    const chapters = d.bankruptcyChapters ?? [];
    if (d.bankruptcy !== chapters.length > 0) {
      say(
        ["declaration", "bankruptcyChapters"],
        d.bankruptcy
          ? "A declared bankruptcy has to name which chapter, or chapters."
          : "No bankruptcy was declared, so there is no chapter to name.",
      );
    }
    // A set, not a list of filings: URLA asks which type(s), and the unique pair
    // on `du_bankruptcy_filings` admits each chapter once.
    if (new Set(chapters).size !== chapters.length) {
      say(["declaration", "bankruptcyChapters"], "The same chapter is named twice.");
    }

    // `du_residences_rent_amount_needs_a_rent_basis`, one direction only: an
    // amount needs a Rent basis, and a Rent basis needs no amount — a tenancy
    // eight years ago whose rent nobody remembers is a legal file.
    body.residences.forEach((r, i) => {
      if (r.monthlyRent != null && r.basis !== "Rent") {
        say(["residences", i, "monthlyRent"], "A rent amount belongs to a rented residence.");
      }
    });

    // Exactly one CURRENT, at most one prior.
    //
    // `borrowers.current_housing` is derived from the current row, so a set
    // without one leaves the derived copy stating a basis whose source does not
    // exist — and `.min(1)` never said "at least the current one", only "at
    // least one of something". The unique pair on the table refuses the second
    // of either; a constraint trigger refuses the missing current one at COMMIT.
    const current = body.residences.filter((r) => r.residencyType === "Current").length;
    if (current !== 1) {
      say(
        ["residences"],
        current === 0
          ? "Say where the borrower lives now, not only where they lived before."
          : "A borrower lives in one place now.",
      );
    }
    if (body.residences.filter((r) => r.residencyType === "Prior").length > 1) {
      say(["residences"], "DU carries one prior residence, not several.");
    }
  });

declarationRouter.post(
  "/:id/declaration",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = bodySchema.parse(req.body);
    await assertFileAccess(id, req.user!.id, "write");

    // Who is asserting this, which is whoever sent the request and never
    // whoever it is about. Read here rather than inside the service because
    // `req.user` is the one thing a service has no honest way to recover, and
    // a declaration stamped with the subject's own principal is how somebody
    // ends up on record attesting to a form they have never seen.
    const partyId = await partyForUser(prisma, req.user!.id);
    const assertedByPrincipalId = await principalForParty(prisma, partyId);

    const view = await recordDeclaration(id, { ...input, assertedByPrincipalId });
    // The high-water mark, not a cursor: a borrower who comes back to correct
    // one answer after connecting their bank is not moved back to this screen.
    await advanceStage(id, "DECLARATIONS");
    res.status(201).json({ declaration: view });
  }),
);

/**
 * URLA 1b, per current job, answered on the review screen above the
 * signature. The same shape as the declaration POST: whole set or nothing,
 * about the borrower being answered for, asserted by whoever sent it.
 */
const employmentDeclarationsSchema = z.object({
  borrowerId: z.string().uuid().optional(),
  answers: z
    .array(
      z.object({
        employmentId: z.string().uuid(),
        selfEmployed: z.boolean(),
        employedByPartyToTransaction: z.boolean(),
      }),
    )
    .max(20),
});

declarationRouter.post(
  "/:id/employment-declarations",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = employmentDeclarationsSchema.parse(req.body);
    await assertFileAccess(id, req.user!.id, "write");
    const partyId = await partyForUser(prisma, req.user!.id);
    const assertedByPrincipalId = await principalForParty(prisma, partyId);
    const declarations = await recordEmploymentDeclarations(id, {
      answers: input.answers,
      borrowerId: input.borrowerId,
      assertedByPrincipalId,
    });
    res.status(201).json({ declarations });
  }),
);

declarationRouter.get(
  "/:id/declaration",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    await assertFileAccess(id, req.user!.id, "read");

    // Absent is borrower 1, the same way the POST reads it.
    const borrowerId = z.string().uuid().optional().parse(req.query.borrowerId);

    const view = await loadDeclaration(id, borrowerId);
    res.json({ declaration: view });
  }),
);
