/**
 * An offer is a row and a card.
 *
 * The daily review finds a candidate; this is what the candidate becomes. One
 * `refi_offers` row per candidate, carrying the review's benefit disclosure
 * as its own figures, open for thirty days from the moment it is made.
 * Delivery is the card on the person's loan page and nothing else — no mail
 * until real mail is on — so there is no gap between ready and delivered,
 * and the offer opens when it is written.
 *
 * The person answers once. Yes opens a refinance application born from the
 * loan, in our five screens, landing on screen 2 (`refinance.ts`). Not now
 * starts the program's ninety-day cooldown. Never is a standing "do not
 * solicit". Two offers per loan per rolling twelve months, as his program
 * has it. The engine reads all three off this table through `offerGateFacts`
 * — the offers ARE the gate facts, so there is no second place for a decline
 * to be recorded and forgotten.
 *
 * While an offer is open, or a refinance application opened from one is
 * still moving, the daily review leaves the loan alone: the offer stands,
 * and a second verdict under it would be a second answer to a question the
 * person is still holding. `loan-review.ts` skips such a loan and says why.
 */

import { prisma } from "@hm/db";
import type { Prisma, RefiOffer } from "@hm/db";
import { APPLICATION_STATES, TERMINAL } from "@hm/shared";
import type { GateFacts } from "@hm/refi-review";
import { plainDate, type PlainDate } from "@hm/kernel/calendar";
import { AppError } from "../middleware/error-handler.js";
import type { Db } from "./db.js";
import { assertLoanAccess } from "./loans.js";
import { openRefinanceApplication, type RefinancePrefill } from "./refinance.js";
import { recordEvent } from "./repository.js";
import { toDbState } from "./transition.js";

/** How long an offer stands, from the moment it is made. His `offer_ready` validity. */
export const OFFER_VALID_DAYS = 30;

/**
 * The application states a refinance can still move out of, in the
 * database's spelling: everything the machine does not call an end. Derived
 * rather than listed, so a state added to the machine lands on the right
 * side without anybody remembering this file.
 */
export const OPEN_APPLICATION_STATES = APPLICATION_STATES.filter((s) => !TERMINAL.includes(s)).map(
  toDbState,
);

/** The calendar day at an instant, in the creditor's zone, as the engine's day. */
export function dayEt(at: Date): PlainDate {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  return plainDate(ymd);
}

export type OfferStanding = "offered" | "engaged" | "declined" | "opted_out" | "expired";

/**
 * Where an offer stands right now. An open offer past its validity reads as
 * expired before the sweep has written it so, because a read must never
 * show a card the person can no longer answer.
 */
export function offerStanding(
  offer: Pick<RefiOffer, "status" | "validUntil">,
  now: Date = new Date(),
): OfferStanding {
  switch (offer.status) {
    case "OFFERED":
      return offer.validUntil > now ? "offered" : "expired";
    case "ENGAGED":
      return "engaged";
    case "DECLINED":
      return "declined";
    case "OPTED_OUT":
      return "opted_out";
    case "EXPIRED":
      return "expired";
  }
}

/** Every open offer past its validity, closed. Run before each review pass. */
export async function expireOffers(db: Db = prisma, now: Date = new Date()): Promise<number> {
  const r = await db.refiOffer.updateMany({
    where: { status: "OFFERED", validUntil: { lte: now } },
    data: { status: "EXPIRED" },
  });
  return r.count;
}

/**
 * Open an offer from the day's candidate review. The figures are the
 * review's, copied once. The partial unique index refuses a second open
 * offer on the loan, which the pass has already checked and a race cannot
 * get past.
 */
export async function openOffer(
  db: Db,
  args: {
    loanId: string;
    reviewId: string;
    detectedOn: PlainDate;
    disclosure: Prisma.InputJsonValue;
    candidateRatePct: string;
    rateSource: string | null;
    now?: Date;
  },
): Promise<{ id: string; validUntil: Date }> {
  const now = args.now ?? new Date();
  const validUntil = new Date(now.getTime() + OFFER_VALID_DAYS * 24 * 60 * 60 * 1000);
  const row = await db.refiOffer.create({
    data: {
      loanId: args.loanId,
      reviewId: args.reviewId,
      status: "OFFERED",
      detectedOn: new Date(`${args.detectedOn}T00:00:00.000Z`),
      offeredAt: now,
      validUntil,
      disclosure: args.disclosure,
      candidateRatePct: args.candidateRatePct,
      rateSource: args.rateSource,
    },
    select: { id: true, validUntil: true },
  });
  return row;
}

/**
 * What the engine's gates read off the offers: the last decline (the
 * cooldown), every offer's day (the frequency cap) and whether the person
 * ever said never (marketing suppression).
 */
export async function offerGateFacts(
  db: Db,
  loanId: string,
): Promise<{ gate: GateFacts; doNotSolicit: boolean }> {
  const offers = await db.refiOffer.findMany({
    where: { loanId },
    select: { status: true, offeredAt: true, answeredAt: true },
    orderBy: { offeredAt: "asc" },
  });
  let declined: Date | null = null;
  for (const o of offers) {
    if (o.status === "DECLINED" && o.answeredAt && (!declined || o.answeredAt > declined)) {
      declined = o.answeredAt;
    }
  }
  return {
    gate: {
      declined_on: declined ? dayEt(declined) : null,
      offered_at: offers.map((o) => dayEt(o.offeredAt)),
    },
    doNotSolicit: offers.some((o) => o.status === "OPTED_OUT"),
  };
}

/** Whether the loan is being held by an open offer or an open refinance application, and which. */
export async function loanIsHeld(
  db: Db,
  loanId: string,
  now: Date = new Date(),
): Promise<"open offer" | "open refinance application" | null> {
  const offer = await db.refiOffer.findFirst({
    where: { loanId, status: "OFFERED", validUntil: { gt: now } },
    select: { id: true },
  });
  if (offer) return "open offer";
  const application = await db.application.findFirst({
    where: { priorLoanId: loanId, status: { in: OPEN_APPLICATION_STATES } },
    select: { id: true },
  });
  if (application) return "open refinance application";
  return null;
}

/** The offer a loan page shows: the newest, whatever its standing; null before the first. */
export async function latestOffer(db: Db, loanId: string) {
  return db.refiOffer.findFirst({
    where: { loanId },
    orderBy: [{ offeredAt: "desc" }, { createdAt: "desc" }],
    include: { application: { select: { loanFileId: true } }, review: true },
  });
}

export type OfferAnswer = "yes" | "not_now" | "never";

export type AnsweredOffer =
  | { readonly answer: "yes"; readonly fileId: string; readonly prefill: RefinancePrefill }
  | { readonly answer: "not_now" | "never"; readonly offerId: string };

/**
 * The person's one answer to an offer on a loan of theirs.
 *
 * "Whose" is `assertLoanAccess`, so a stranger and a missing loan get the
 * same 404; an offer that is not on that loan, the same. An offer that has
 * ended, or lapsed unswept, is refused as closed rather than answered late.
 * Yes needs the one thing screen 1 asks that no tape knows — the income the
 * person states — and opens the application in the same transaction that
 * ends the offer, so there is no moment with an engaged offer and no
 * application, or the reverse.
 */
export async function answerOffer(
  args: {
    loanId: string;
    offerId: string;
    userId: string;
    answer: OfferAnswer;
    statedMonthlyIncome?: number;
    now?: Date;
  },
  db: Db = prisma,
): Promise<AnsweredOffer> {
  const now = args.now ?? new Date();
  const loan = await assertLoanAccess(db, args.loanId, args.userId);
  const offer = await db.refiOffer.findFirst({
    where: { id: args.offerId, loanId: loan.id },
    include: { review: true },
  });
  if (!offer) throw new AppError(404, "Offer not found", "NOT_FOUND");
  if (offerStanding(offer, now) !== "offered") {
    throw new AppError(409, "This offer is no longer open.", "OFFER_CLOSED");
  }

  if (args.answer === "not_now" || args.answer === "never") {
    await db.refiOffer.update({
      where: { id: offer.id },
      data: { status: args.answer === "never" ? "OPTED_OUT" : "DECLINED", answeredAt: now },
    });
    return { answer: args.answer, offerId: offer.id };
  }

  const income = args.statedMonthlyIncome;
  if (income === undefined || !(income > 0)) {
    throw new AppError(422, "Tell us your monthly income to start.", "INCOME_REQUIRED");
  }
  const opened = await openRefinanceApplication(
    { loan, offer, review: offer.review, userId: args.userId, statedMonthlyIncome: income },
    db,
  );
  await recordEvent(
    opened.fileId,
    "screen_completed",
    "borrower",
    { screen: "property_loan", prefilledFrom: { loanId: loan.id, offerId: offer.id } },
    undefined,
    db,
  );
  return { answer: "yes", fileId: opened.fileId, prefill: opened.prefill };
}
