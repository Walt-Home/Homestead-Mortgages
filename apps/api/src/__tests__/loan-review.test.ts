/**
 * The daily review over our own rows: the sample book claimed, reviewed
 * against the fixture's sheet, kept, and handed out.
 *
 * The engine's arithmetic is held to his numbers in its own package; what
 * is held here is everything around it — that only monitored loans are
 * reviewed, that a day is reviewed once, that the row is append-only, that
 * the rate came off the pricing port, and that the route hands the newest
 * review out beside the platform's live read rather than inside it.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { NORTHLIGHT, sampleBook } from "@hm/partner-book";
import { plainDate } from "@hm/kernel/calendar";
import { loanRouter } from "../routes/loans.js";
import { acceptLoanClaim, mintLoanClaim } from "../services/loan-claims.js";
import { latestLoanReview, reviewMonitoredLoans } from "../services/loan-review.js";
import { importPartnerBook } from "../services/partner-book.js";
import { partnerPrincipal } from "../services/party.js";
import { createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

const utf8 = (s: string) => new TextEncoder().encode(s);
const AS_OF = plainDate("2026-09-21");

/** The book loaded, and the named loans claimed by a person each, which is what turns their review on. */
async function claimedBook(numbers: readonly string[]) {
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
  const owners = new Map<string, { userId: string; loanId: string }>();
  for (const n of numbers) {
    const minted = await mintLoanClaim({
      servicerId: servicer.id,
      servicerLoanNumber: n,
      principalId,
    });
    const user = await createUser();
    const taken = await acceptLoanClaim(minted.token, user.id);
    owners.set(n, { userId: user.id, loanId: taken.loanId });
  }
  return { servicer, owners };
}

describe("the daily review", () => {
  it("reviews the monitored loans once for the day, off the fixture's sheet, and keeps the verdicts", async () => {
    const { owners } = await claimedBook(["NL-100001", "NL-100008", "NL-100009", "NL-100011"]);
    const run = await reviewMonitoredLoans({ asOf: AS_OF });
    expect(run.monitored).toBe(4);
    expect(run.skipped).toEqual([]);
    const by = new Map(run.reviewed.map((r) => [r.servicerLoanNumber, r]));
    // The fixture sheet quotes one 30-year fixed at 6.25 %: 100 bps under loan 1's 7.25 %.
    expect(by.get("NL-100001")).toMatchObject({ verdict: "candidate", candidateRatePct: "6.250" });
    expect(by.get("NL-100008")).toMatchObject({ verdict: "excluded", reasons: ["delinquent"] });
    expect(by.get("NL-100011")).toMatchObject({
      verdict: "excluded",
      reasons: ["bankruptcy_active"],
    });
    // 5.875 % against 6.25 % is a rate move the wrong way: watching, with the rate it would need.
    expect(by.get("NL-100009")?.verdict).toBe("watching");

    const rows = await prisma.loanReview.findMany({ orderBy: { recordedAt: "asc" } });
    expect(rows).toHaveLength(4);
    const one = rows.find((r) => r.loanId === owners.get("NL-100001")!.loanId)!;
    expect(one.verdict).toBe("CANDIDATE");
    expect(one.rateSource).toBe("fixture-pricing:CONF-30-FIXED");
    expect(one.candidateRatePct?.toFixed(3)).toBe("6.250");
    expect(one.offer).toMatchObject({
      current_rate_pct: "7.250",
      new_rate_pct: "6.250",
      current_pi_cents: "306979",
    });
    expect(one.ruleSetVersion).toContain("partner_book.review.v1");
    const nine = rows.find((r) => r.loanId === owners.get("NL-100009")!.loanId)!;
    expect((nine.facts as { watch_rate_pct?: string }).watch_rate_pct).toBe("5.625");
    expect(nine.offer).toBeNull();

    // Once a day: a second run writes nothing and says so.
    const again = await reviewMonitoredLoans({ asOf: AS_OF });
    expect(again.reviewed).toEqual([]);
    expect(again.alreadyReviewed).toBe(4);
    expect(await prisma.loanReview.count()).toBe(4);

    // The review's own clock moved to the next day.
    const loan = await prisma.loan.findUniqueOrThrow({
      where: { id: owners.get("NL-100001")!.loanId },
    });
    expect(loan.nextReviewDueAt?.toISOString().slice(0, 10)).toBe("2026-09-22");
  });

  it("reviews only loans whose review is on: an unclaimed loan is not looked at", async () => {
    await claimedBook(["NL-100002"]);
    const run = await reviewMonitoredLoans({ asOf: AS_OF });
    expect(run.monitored).toBe(1);
    expect(run.reviewed.map((r) => r.servicerLoanNumber)).toEqual(["NL-100002"]);
    expect(await prisma.loanReview.count()).toBe(1);
  });

  it("keeps a review as written: the row is append-only, and a candidate is the only row with an offer", async () => {
    const { owners } = await claimedBook(["NL-100001"]);
    await reviewMonitoredLoans({ asOf: AS_OF });
    const row = await prisma.loanReview.findFirstOrThrow({
      where: { loanId: owners.get("NL-100001")!.loanId },
    });
    await expect(
      prisma.loanReview.update({ where: { id: row.id }, data: { explanation: "edited" } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.loanReview.create({
        data: {
          loanId: row.loanId,
          asOf: new Date("2026-09-23T00:00:00.000Z"),
          verdict: "WATCHING",
          reasons: [],
          facts: {},
          offer: { anything: true },
          ruleSetVersion: "test",
          explanation: "a watcher with an offer",
        },
      }),
    ).rejects.toThrow(/loan_reviews_offer_belongs_to_a_candidate/);
  });

  it("hands the newest review out of the servicing route, in words, beside the live read", async () => {
    const { owners } = await claimedBook(["NL-100001"]);
    const { userId, loanId } = owners.get("NL-100001")!;
    const before = await callAs<Record<string, unknown>>(
      userId,
      [loanRouter],
      "GET",
      `/${loanId}/servicing`,
      undefined,
      "/api/loans",
    );
    expect(before.status).toBe(200);
    expect(before.body.review).toBeNull();

    await reviewMonitoredLoans({ asOf: AS_OF });
    const after = await callAs<Record<string, unknown>>(
      userId,
      [loanRouter],
      "GET",
      `/${loanId}/servicing`,
      undefined,
      "/api/loans",
    );
    const review = after.body.review as Record<string, unknown>;
    expect(review).toMatchObject({
      asOf: "2026-09-21",
      verdict: "candidate",
      reasons: [
        "rate_delta",
        "npv_positive",
        "seven_year_delta_positive",
        "prescreen",
        "state_rule",
      ],
      candidateRatePct: "6.250",
    });
    expect((review.reasonsInWords as string[])[0]).toBe(
      "the rate reduction clears the program's floor",
    );
    expect(review.offer).toMatchObject({
      new_rate_pct: "6.250",
      remaining_term_months: 337,
      new_term_months: 360,
    });
    // The live half is still the platform's, and still its own field.
    expect((after.body.live as { status: string }).status).toBe("fetched");
    expect(await latestLoanReview(loanId)).toMatchObject({ verdict: "candidate" });
  });
});
