/**
 * An offer is a row and a card: the candidate the review found, made into a
 * thing the person can answer, and what each answer does to the loan.
 *
 * The engine's arithmetic is held in its own package; the review's own
 * behavior in `loan-review.test.ts`. What is held here is the lifecycle
 * around a candidate — the offer opens with the review's figures, holds the
 * loan while it stands, ends once and only once, and each answer is read by
 * the next review through the gates — and the yes: a refinance application
 * in our five screens, born from the loan with screen 1 answered, landing
 * on screen 2, one open at a time, and retiring the loan when it funds.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { NORTHLIGHT, sampleBook, toCsv } from "@hm/partner-book";
import { plainDate } from "@hm/kernel/calendar";
import { loanRouter } from "../routes/loans.js";
import { acceptLoanClaim, mintLoanClaim } from "../services/loan-claims.js";
import { reviewMonitoredLoans } from "../services/loan-review.js";
import { createOriginatedLoan } from "../services/loans.js";
import { importPartnerBook } from "../services/partner-book.js";
import {
  partnerPrincipal,
  partyForUser,
  servicePrincipal,
  staffPrincipal,
} from "../services/party.js";
import {
  OFFER_VALID_DAYS,
  answerOffer,
  expireOffers,
  offerGateFacts,
  offerStanding,
} from "../services/refi-offers.js";
import { refinanceReadiness, refinanceSeed, retirePriorLoan } from "../services/refinance.js";
import { transition } from "../services/transition.js";
import { createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

const utf8 = (s: string) => new TextEncoder().encode(s);
const at = (day: string, hour = 12) =>
  new Date(`${day}T${String(hour).padStart(2, "0")}:00:00.000Z`);
const days = (n: number) => n * 24 * 60 * 60 * 1000;

/** The book loaded and one loan claimed, which turns its review on. */
async function claimed(number: string) {
  const servicer = await prisma.servicer.create({
    data: { slug: NORTHLIGHT.slug, displayName: NORTHLIGHT.legal_name, integrationDepth: "API" },
    select: { id: true, slug: true },
  });
  const principalId = await partnerPrincipal(prisma, servicer.slug);
  const book = sampleBook();
  const imported = await importPartnerBook({
    servicerId: servicer.id,
    principalId,
    profile: "m3-v1",
    tape: { filename: "northlight.xlsx", bytes: book.tape },
    supplement: { filename: "supplement.csv", bytes: utf8(book.supplement) },
  });
  if (imported.status !== "loaded") throw new Error(imported.status);
  const minted = await mintLoanClaim({
    servicerId: servicer.id,
    servicerLoanNumber: number,
    principalId,
  });
  const user = await createUser();
  const taken = await acceptLoanClaim(minted.token, user.id);
  return { servicer, userId: user.id, loanId: taken.loanId };
}

const review = (asOf: string, now?: Date) =>
  reviewMonitoredLoans({ asOf: plainDate(asOf), analyst: null, now: now ?? at(asOf) });

/** The first of the month after `day`: what a servicer's tape says is next due. */
function firstOfNextMonth(day: string): string {
  const [y, m] = day.split("-").map(Number) as [number, number];
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

/**
 * A later tape for the same book: the same loans, current as of `day`. A
 * review months on reads the newest observation, and one whose next due
 * date is behind the review day is a delinquent loan, not a candidate —
 * which is right, and not what these tests are about.
 */
async function laterTape(servicer: { id: string; slug: string }, day: string): Promise<void> {
  const principalId = await partnerPrincipal(prisma, servicer.slug);
  const later = sampleBook(() => ({
    as_of_date: day,
    next_due_date: firstOfNextMonth(day),
    fmv_date: day,
  }));
  const r = await importPartnerBook({
    servicerId: servicer.id,
    principalId,
    profile: "m3-v1",
    tape: { filename: `${day}.csv`, bytes: utf8(toCsv(later.tapeRows)) },
    supplement: null,
  });
  if (r.status !== "loaded") throw new Error(`tape as of ${day}: ${r.status}`);
}

describe("an offer", () => {
  it("opens from the day's candidate with the review's own figures, and holds the loan while it stands", async () => {
    const { loanId } = await claimed("NL-100001");
    const run = await review("2026-09-21");
    expect(run.reviewed[0]?.verdict).toBe("candidate");
    expect(run.offersOpened).toBe(1);
    expect(run.analyst).toEqual({ written: 0, skipped: { model_off: 1 } });

    const offer = await prisma.refiOffer.findFirstOrThrow({ where: { loanId } });
    const row = await prisma.loanReview.findFirstOrThrow({ where: { loanId } });
    expect(offer.status).toBe("OFFERED");
    expect(offer.reviewId).toBe(row.id);
    expect(offer.disclosure).toEqual(row.offer);
    expect(offer.candidateRatePct.toFixed(3)).toBe("6.250");
    expect(offer.detectedOn.toISOString().slice(0, 10)).toBe("2026-09-21");
    expect(offer.validUntil.getTime() - offer.offeredAt.getTime()).toBe(days(OFFER_VALID_DAYS));
    expect((row.analyst as { skipped: string }).skipped).toBe("model_off");

    // Tomorrow the loan is left alone: the offer stands, and no second verdict is written under it.
    const next = await review("2026-09-22");
    expect(next.reviewed).toEqual([]);
    expect(next.skipped).toEqual([
      { loanId, servicerLoanNumber: "NL-100001", reason: "open offer" },
    ]);
    expect(await prisma.loanReview.count({ where: { loanId } })).toBe(1);
  });

  it("is what was offered, ends once, and lapses on its own", async () => {
    const { loanId } = await claimed("NL-100001");
    await review("2026-09-21");
    const offer = await prisma.refiOffer.findFirstOrThrow({ where: { loanId } });
    await expect(
      prisma.refiOffer.update({ where: { id: offer.id }, data: { candidateRatePct: "5.000" } }),
    ).rejects.toThrow(/does not change/);
    await expect(
      prisma.refiOffer.update({ where: { id: offer.id }, data: { status: "ENGAGED" } }),
    ).rejects.toThrow(/refi_offers_answered_when_answered/);
    await prisma.refiOffer.update({
      where: { id: offer.id },
      data: { status: "DECLINED", answeredAt: at("2026-09-22") },
    });
    await expect(
      prisma.refiOffer.update({
        where: { id: offer.id },
        data: { status: "OPTED_OUT", answeredAt: at("2026-09-23") },
      }),
    ).rejects.toThrow(/already ended/);

    // A second open offer on the loan is refused by the index, not by hope.
    const row = await prisma.loanReview.findFirstOrThrow({ where: { loanId } });
    const open = (n: number) =>
      prisma.refiOffer.create({
        data: {
          loanId,
          reviewId: row.id,
          detectedOn: at("2026-09-21"),
          offeredAt: at("2026-09-21", n),
          validUntil: at("2026-10-21"),
          disclosure: {},
          candidateRatePct: "6.250",
        },
      });
    await open(1);
    await expect(open(2)).rejects.toThrow(/refi_offers_one_open_per_loan/);

    // Past its validity it reads as lapsed before the sweep, and the sweep writes it so.
    const lapsed = await prisma.refiOffer.findFirstOrThrow({
      where: { loanId, status: "OFFERED" },
    });
    expect(offerStanding(lapsed, at("2026-10-22"))).toBe("expired");
    expect(offerStanding(lapsed, at("2026-10-20"))).toBe("offered");
    expect(await expireOffers(prisma, at("2026-10-22"))).toBe(1);
    expect((await prisma.refiOffer.findUniqueOrThrow({ where: { id: lapsed.id } })).status).toBe(
      "EXPIRED",
    );
  });

  it("not now is a ninety-day cooldown the next review names, never is a standing suppression, and a lapse frees the loan", async () => {
    const { loanId, userId, servicer } = await claimed("NL-100001");
    await review("2026-09-21");
    const first = await prisma.refiOffer.findFirstOrThrow({ where: { loanId } });
    const declined = await answerOffer({
      loanId,
      offerId: first.id,
      userId,
      answer: "not_now",
      now: at("2026-09-22"),
    });
    expect(declined).toEqual({ answer: "not_now", offerId: first.id });
    expect((await offerGateFacts(prisma, loanId)).gate).toEqual({
      declined_on: "2026-09-22",
      offered_at: ["2026-09-21"],
    });

    // The next morning the engine reads the decline: not now, cooldown, no new offer.
    const cooled = await review("2026-09-23");
    expect(cooled.reviewed[0]).toMatchObject({ verdict: "not_now", reasons: ["cooldown"] });
    expect(cooled.offersOpened).toBe(0);
    // Ninety days on — with a tape that says the loan is still current — the
    // loan is a candidate again and a second offer opens.
    await laterTape(servicer, "2026-12-01");
    const reopened = await review("2026-12-22");
    expect(reopened.reviewed[0]?.verdict).toBe("candidate");
    expect(reopened.offersOpened).toBe(1);

    // Never: the offer ends, and every later review says the person asked not to be solicited.
    const second = await prisma.refiOffer.findFirstOrThrow({
      where: { loanId, status: "OFFERED" },
    });
    await answerOffer({
      loanId,
      offerId: second.id,
      userId,
      answer: "never",
      now: at("2026-12-23"),
    });
    expect((await offerGateFacts(prisma, loanId)).doNotSolicit).toBe(true);
    const suppressed = await review("2026-12-24");
    expect(suppressed.reviewed[0]).toMatchObject({
      verdict: "not_now",
      reasons: ["marketing_suppression"],
    });
    expect(await prisma.refiOffer.count({ where: { loanId } })).toBe(2);

    // An answered offer cannot be answered again.
    await expect(
      answerOffer({ loanId, offerId: second.id, userId, answer: "yes", statedMonthlyIncome: 9000 }),
    ).rejects.toMatchObject({ code: "OFFER_CLOSED" });
  });

  it("caps the program at two offers per loan per twelve months", async () => {
    const { loanId, servicer } = await claimed("NL-100001");
    // Two offers, each lapsed by the time of the next review; a fresh tape each time.
    await laterTape(servicer, "2026-01-01");
    await review("2026-01-05");
    await laterTape(servicer, "2026-03-01");
    await review("2026-03-10");
    expect(await prisma.refiOffer.count({ where: { loanId } })).toBe(2);
    await laterTape(servicer, "2026-05-01");
    const capped = await review("2026-05-15");
    expect(capped.reviewed[0]).toMatchObject({ verdict: "not_now", reasons: ["frequency_cap"] });
    expect(capped.offersOpened).toBe(0);
    // A year after the first, the cap has room again.
    await laterTape(servicer, "2027-01-01");
    const room = await review("2027-01-10");
    expect(room.reviewed[0]?.verdict).toBe("candidate");
    expect(room.offersOpened).toBe(1);
  });
});

describe("the yes", () => {
  it("opens a refinance in our five screens, born from the loan with screen 1 answered", async () => {
    const { loanId, userId } = await claimed("NL-100001");
    await review("2026-09-21");
    const offer = await prisma.refiOffer.findFirstOrThrow({ where: { loanId } });

    const seed = await refinanceSeed(prisma, {
      loan: await prisma.loan.findUniqueOrThrow({ where: { id: loanId } }),
      offer,
      review: await prisma.loanReview.findUniqueOrThrow({ where: { id: offer.reviewId } }),
    });
    expect(seed).toMatchObject({
      purpose: "rate_term_refinance",
      propertyType: "single_family",
      occupancy: "primary_residence",
      valuationSource: "servicer_fmv",
      existingLoan: { servicer: NORTHLIGHT.legal_name, loanNumber: "NL-100001" },
    });
    expect(seed.loanAmount * 100).toBe(
      Number((offer.disclosure as { loan_amount_cents: string }).loan_amount_cents),
    );

    // The dry run: screen 1 has nothing outstanding; the person's screens do.
    const ready = refinanceReadiness(seed, at("2026-09-21"));
    const screens = ready.byScreen.map((s) => s.screen);
    expect(screens).not.toContain("property_loan");
    expect(screens).toContain("identity");
    expect(ready.unmapped).toEqual([
      "contact_details",
      "account_activation",
      "value_freshness",
      "insurance",
    ]);

    const answered = await callAs<{
      answer: string;
      fileId: string;
      prefill: Record<string, unknown>;
    }>(
      userId,
      [loanRouter],
      "POST",
      `/${loanId}/offers/${offer.id}/answer`,
      { answer: "yes", statedMonthlyIncome: 9500 },
      "/api/loans",
    );
    expect(answered.status).toBe(201);
    expect(answered.body.answer).toBe("yes");
    // The person as the servicer named them, for screen 2 to confirm.
    expect(answered.body.prefill).toMatchObject({
      firstName: expect.any(String),
      lastName: expect.any(String),
    });

    const file = await prisma.loanFile.findUniqueOrThrow({
      where: { id: answered.body.fileId },
      include: { application: true, events: true },
    });
    expect(file).toMatchObject({
      userId,
      stage: "IDENTITY",
      purpose: "RATE_TERM_REFINANCE",
      propertyLine1: seed.address.line1,
      propertyState: seed.address.state,
      valuationSource: "servicer_fmv",
      existingLoanNumber: "NL-100001",
      existingPaymentBasis: "principal_and_interest",
      productCode: "CONF-30-FIXED",
    });
    expect(Number(file.loanAmount)).toBe(seed.loanAmount);
    expect(Number(file.existingBalance)).toBe(seed.existingLoan.balance);
    expect(file.application?.priorLoanId).toBe(loanId);
    expect(file.events.map((e) => e.kind)).toContain("screen_completed");
    // The income screen 1 would have taken, taken here.
    const partyId = await partyForUser(prisma, userId);
    const income = await prisma.fact.findFirst({
      where: { partyId, predicate: "monthly_income", supersededById: null },
    });
    expect(income?.value).toBe(9500);

    // The offer ended as engaged, naming the application, in the same act.
    const engaged = await prisma.refiOffer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(engaged.status).toBe("ENGAGED");
    expect(engaged.applicationId).toBe(file.application?.id);

    // The page reads the offer back with where it stands and the file to pick up.
    const page = await callAs<{ offer: Record<string, unknown>; readiness: unknown }>(
      userId,
      [loanRouter],
      "GET",
      `/${loanId}/servicing`,
      undefined,
      "/api/loans",
    );
    expect(page.body.offer).toMatchObject({
      id: offer.id,
      status: "engaged",
      applicationFileId: file.id,
    });
    expect(page.body.readiness).toBeNull();

    // The review leaves the loan alone while the application is open.
    const held = await review("2026-09-22");
    expect(held.skipped).toEqual([
      { loanId, servicerLoanNumber: "NL-100001", reason: "open refinance application" },
    ]);
  });

  it("needs the income screen 1 would have asked, refuses a stranger, and opens one refinance at a time", async () => {
    const { loanId, userId } = await claimed("NL-100001");
    await review("2026-09-21");
    const offer = await prisma.refiOffer.findFirstOrThrow({ where: { loanId } });

    const noIncome = await callAs(
      userId,
      [loanRouter],
      "POST",
      `/${loanId}/offers/${offer.id}/answer`,
      { answer: "yes" },
      "/api/loans",
    );
    expect(noIncome.status).toBe(422);

    const stranger = await createUser();
    const refused = await callAs(
      stranger.id,
      [loanRouter],
      "POST",
      `/${loanId}/offers/${offer.id}/answer`,
      { answer: "not_now" },
      "/api/loans",
    );
    expect(refused.status).toBe(404);
    expect((await prisma.refiOffer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe(
      "OFFERED",
    );

    await answerOffer({
      loanId,
      offerId: offer.id,
      userId,
      answer: "yes",
      statedMonthlyIncome: 9000,
    });
    // A second open refinance of the same loan is refused by the index.
    const app = await prisma.application.findFirstOrThrow({ where: { priorLoanId: loanId } });
    await expect(
      prisma.application.create({
        data: {
          loanFile: { create: { userId, stage: "IDENTITY" } },
          ausCasefileId: "second-refinance",
          priorLoan: { connect: { id: loanId } },
        },
      }),
    ).rejects.toThrow(/applications_one_open_refinance_per_loan/);
    void app;
  });

  it("retires the prior loan, naming its successor, when the refinance funds", async () => {
    const { loanId, userId } = await claimed("NL-100001");
    await review("2026-09-21");
    const offer = await prisma.refiOffer.findFirstOrThrow({ where: { loanId } });
    await answerOffer({
      loanId,
      offerId: offer.id,
      userId,
      answer: "yes",
      statedMonthlyIncome: 9000,
    });
    const app = await prisma.application.findFirstOrThrow({ where: { priorLoanId: loanId } });
    const partyId = await partyForUser(prisma, userId);
    const flow = await servicePrincipal(prisma, "application_flow");

    // Not before it funds.
    await expect(
      retirePriorLoan(prisma, {
        applicationId: app.id,
        successorLoanId: loanId,
        actorPrincipalId: flow,
        causedBy: "test",
      }),
    ).rejects.toThrow(/retired by a funding/);

    // Walked to funded the way the persona seed walks a file, under a staff actor.
    const staff = await staffPrincipal(prisma, "test-closer");
    for (const event of [
      "intake_completed",
      "underwriting_began",
      "decided_approved",
      "disclosures_complete",
      "closing_began",
      "disbursed",
    ] as const) {
      await transition({
        applicationId: app.id,
        event,
        actorPrincipalId: staff,
        reasonCode: "persona_fixture",
        causedBy: "test",
      });
    }
    const successor = await createOriginatedLoan(prisma, {
      applicationId: app.id,
      terms: {
        rateType: "FIXED",
        noteRateBps: 625,
        termMonths: 360,
        originalPrincipalCents: 44_400_000n,
      },
      property: { line1: "1247 Oak Street", city: "Austin", state: "TX", postalCode: "78701" },
      axes: {
        objective: "RATE_TERM_REFINANCE",
        program: "CONVENTIONAL",
        lienPosition: "FIRST",
        occupancy: "PRIMARY_RESIDENCE",
      },
      parties: [{ partyId, role: "PRIMARY_BORROWER" }],
    });
    const retired = await prisma.$transaction((tx) =>
      retirePriorLoan(tx, {
        applicationId: app.id,
        successorLoanId: successor.loanId,
        actorPrincipalId: flow,
        causedBy: `application:${app.id}`,
      }),
    );
    expect(retired).toEqual({ priorLoanId: loanId });
    const prior = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } });
    expect(prior.status).toBe("REFINANCED_INTERNALLY");
    expect(prior.refinancedByLoanId).toBe(successor.loanId);
    const ledger = await prisma.loanTransition.findFirst({
      where: { loanId, event: "refinanced_by_us" },
    });
    expect(ledger?.reasonCode).toBe("internal_refinance_funded");
  });
});
