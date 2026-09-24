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
import { NO_GATE_FACTS, type GateFacts } from "@hm/refi-review";
import { plainDate, type PlainDate } from "@hm/kernel/calendar";
import { AppError } from "../middleware/error-handler.js";
import { inChunks, type Db } from "./db.js";
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
      // An offer not yet delivered has no validity to have run out.
      return offer.validUntil === null || offer.validUntil > now ? "offered" : "expired";
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

/** What the review found, ready to be an offer row. */
export interface OfferToOpen {
  readonly loanId: string;
  readonly reviewId: string;
  readonly detectedOn: PlainDate;
  readonly disclosure: Prisma.InputJsonValue;
  readonly candidateRatePct: string;
  readonly rateSource: string | null;
  /**
   * Whether the person can see it today. A claimed loan's offer is
   * delivered as it is made; an unclaimed loan's waits for the claim, with
   * no validity and no place in the cap until then.
   */
  readonly deliver: boolean;
}

const validityFrom = (at: Date): Date =>
  new Date(at.getTime() + OFFER_VALID_DAYS * 24 * 60 * 60 * 1000);

function offerRow(o: OfferToOpen, now: Date): Prisma.RefiOfferCreateManyInput {
  return {
    loanId: o.loanId,
    reviewId: o.reviewId,
    status: "OFFERED",
    detectedOn: new Date(`${o.detectedOn}T00:00:00.000Z`),
    offeredAt: now,
    deliveredAt: o.deliver ? now : null,
    validUntil: o.deliver ? validityFrom(now) : null,
    disclosure: o.disclosure,
    candidateRatePct: o.candidateRatePct,
    rateSource: o.rateSource,
  };
}

/**
 * Open an offer from the day's candidate review. The figures are the
 * review's, copied once. The partial unique index refuses a second open
 * offer on the loan, which the pass has already checked and a race cannot
 * get past.
 */
export async function openOffer(
  db: Db,
  args: Omit<OfferToOpen, "deliver"> & { deliver?: boolean; now?: Date },
): Promise<{ id: string; validUntil: Date | null }> {
  const now = args.now ?? new Date();
  return db.refiOffer.create({
    data: offerRow({ ...args, deliver: args.deliver ?? true }, now),
    select: { id: true, validUntil: true },
  });
}

/** A day's offers at once: a book's worth of candidates is hundreds of rows. */
export async function openOffers(db: Db, offers: readonly OfferToOpen[], now: Date): Promise<void> {
  await inChunks(offers, (chunk) =>
    db.refiOffer.createMany({ data: chunk.map((o) => offerRow(o, now)) }),
  );
}

/**
 * Deliver the offer waiting on a loan, the moment its person can see it:
 * the claim. Its thirty days start now, and from now it counts in the cap.
 * Nothing to deliver is fine — a loan claimed on a day it was watching.
 */
export async function deliverOpenOffer(db: Db, loanId: string, now: Date): Promise<number> {
  const r = await db.refiOffer.updateMany({
    where: { loanId, status: "OFFERED", deliveredAt: null },
    data: { deliveredAt: now, validUntil: validityFrom(now) },
  });
  return r.count;
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
    select: { status: true, deliveredAt: true, answeredAt: true },
    orderBy: { offeredAt: "asc" },
  });
  return gateFactsOf(offers);
}

/** The engine's gates off one loan's offers: only a delivered offer counts. */
function gateFactsOf(
  offers: readonly { status: string; deliveredAt: Date | null; answeredAt: Date | null }[],
): { gate: GateFacts; doNotSolicit: boolean } {
  let declined: Date | null = null;
  for (const o of offers) {
    if (o.status === "DECLINED" && o.answeredAt && (!declined || o.answeredAt > declined)) {
      declined = o.answeredAt;
    }
  }
  return {
    gate: {
      declined_on: declined ? dayEt(declined) : null,
      offered_at: offers.flatMap((o) => (o.deliveredAt ? [dayEt(o.deliveredAt)] : [])),
    },
    doNotSolicit: offers.some((o) => o.status === "OPTED_OUT"),
  };
}

export type LoanHold = "open offer" | "open refinance application";

/** Whether the loan is being held by an open offer or an open refinance application, and which. */
export async function loanIsHeld(
  db: Db,
  loanId: string,
  now: Date = new Date(),
): Promise<LoanHold | null> {
  const offer = await db.refiOffer.findFirst({
    where: {
      loanId,
      status: "OFFERED",
      OR: [{ validUntil: null }, { validUntil: { gt: now } }],
    },
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

/** What the review needs to know about a loan's offers before it looks. */
export interface OfferState {
  readonly held: LoanHold | null;
  readonly gate: GateFacts;
  readonly doNotSolicit: boolean;
}

export const NO_OFFER_STATE: OfferState = { held: null, gate: NO_GATE_FACTS, doNotSolicit: false };

/**
 * `loanIsHeld` and `offerGateFacts` for a whole book in a few statements: a
 * read of every offer and every open refinance on these loans, chunked by
 * five hundred, rather than three round trips per loan per morning.
 */
export async function offerStateFor(
  db: Db,
  loanIds: readonly string[],
  now: Date,
): Promise<Map<string, OfferState>> {
  const out = new Map<string, OfferState>();
  if (loanIds.length === 0) return out;
  const offersBy = new Map<
    string,
    { status: string; deliveredAt: Date | null; validUntil: Date | null; answeredAt: Date | null }[]
  >();
  const refinancing = new Set<string>();
  await inChunks(loanIds, async (ids) => {
    const offers = await db.refiOffer.findMany({
      where: { loanId: { in: ids } },
      select: {
        loanId: true,
        status: true,
        deliveredAt: true,
        validUntil: true,
        answeredAt: true,
      },
      orderBy: { offeredAt: "asc" },
    });
    for (const o of offers) {
      const list = offersBy.get(o.loanId) ?? [];
      list.push(o);
      offersBy.set(o.loanId, list);
    }
    const applications = await db.application.findMany({
      where: { priorLoanId: { in: ids }, status: { in: OPEN_APPLICATION_STATES } },
      select: { priorLoanId: true },
    });
    for (const a of applications) if (a.priorLoanId) refinancing.add(a.priorLoanId);
  });
  for (const id of loanIds) {
    const offers = offersBy.get(id) ?? [];
    const open = offers.some(
      (o) => o.status === "OFFERED" && (o.validUntil === null || o.validUntil > now),
    );
    const held: LoanHold | null = open
      ? "open offer"
      : refinancing.has(id)
        ? "open refinance application"
        : null;
    out.set(id, { held, ...gateFactsOf(offers) });
  }
  return out;
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
