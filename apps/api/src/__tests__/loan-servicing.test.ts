/**
 * A mortgage, to the person it belongs to: the first loan route.
 *
 * What the tape last said (our observation) and what the platform has
 * concluded (the live read through the servicing port) reach the party on
 * the loan and nobody else, and the live half never fails the card. The
 * fixture answers the live half here, as it does everywhere the registry is
 * not told otherwise.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { NORTHLIGHT, sampleBook } from "@hm/partner-book";
import { loanRouter } from "../routes/loans.js";
import { createImportedLoan } from "../services/loans.js";
import { importPartnerBook } from "../services/partner-book.js";
import { partnerPrincipal, partyForUser } from "../services/party.js";
import { createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

async function servicer(depth: "NONE" | "DEEP_LINK" | "API" | "SUBSERVICED") {
  return prisma.servicer.create({
    data: { slug: NORTHLIGHT.slug, displayName: NORTHLIGHT.legal_name, integrationDepth: depth },
    select: { id: true, slug: true },
  });
}

/** A loan the sample partner numbers, on the party behind a signed-in user. */
async function loanFor(userId: string, servicerId: string | null, servicerLoanNumber: string) {
  const partyId = await partyForUser(prisma, userId);
  const { loanId } = await createImportedLoan(prisma, {
    terms: {
      rateType: "FIXED",
      noteRateBps: 725,
      termMonths: 360,
      originalPrincipalCents: 45_000_000n,
    },
    property: { line1: "1200 W Maple Ave", city: "Phoenix", state: "AZ", postalCode: "85013" },
    axes: {},
    parties: [{ partyId, role: "PRIMARY_BORROWER" }],
    servicerId,
    servicerLoanNumber,
  });
  return loanId;
}

const get = (userId: string, loanId: string) =>
  callAs<Record<string, unknown>>(
    userId,
    [loanRouter],
    "GET",
    `/${loanId}/servicing`,
    undefined,
    "/api/loans",
  );

describe("GET /loans/:id/servicing", () => {
  it("reads the platform's record live when the servicer is wired that deep", async () => {
    const me = await createUser();
    const s = await servicer("API");
    const loanId = await loanFor(me.id, s.id, "NL-100001");

    const r = await get(me.id, loanId);
    expect(r.status).toBe(200);
    expect(r.body.loan).toMatchObject({
      id: loanId,
      state: "imported_unclaimed",
      servicerLoanNumber: "NL-100001",
    });
    expect(r.body.servicer).toMatchObject({ slug: "northlight", integrationDepth: "API" });
    expect(r.body.observed).toBeNull();
    const live = r.body.live as {
      status: string;
      provider: string;
      record: Record<string, unknown>;
    };
    expect(live.status).toBe("fetched");
    expect(live.provider).toBe("fixture-servicing");
    expect(live.record).toMatchObject({
      servicerLoanNumber: "NL-100001",
      relationship: "monitored",
      review: { verdict: "candidate" },
      offer: { currentRatePct: "7.250", offeredRatePct: "6.375", currentPiCents: "306979" },
    });
  });

  it("does not ask when the servicer is not wired, and says so", async () => {
    const me = await createUser();
    const s = await servicer("DEEP_LINK");
    const loanId = await loanFor(me.id, s.id, "NL-100001");
    const r = await get(me.id, loanId);
    expect(r.status).toBe(200);
    expect(r.body.live).toEqual({ status: "not_wired", integrationDepth: "DEEP_LINK" });
  });

  it("says the platform holds no such loan, which is not an error", async () => {
    const me = await createUser();
    const s = await servicer("API");
    const loanId = await loanFor(me.id, s.id, "NL-777777");
    const r = await get(me.id, loanId);
    expect(r.status).toBe(200);
    expect(r.body.live).toEqual({ status: "not_held" });
  });

  it("shows what the tape last said, from our own observation, beside the live read", async () => {
    // The sample book through the importer, so the observation is the one the
    // tape reader wrote and not a row typed here.
    const s = await servicer("API");
    const book = sampleBook();
    const imported = await importPartnerBook({
      servicerId: s.id,
      principalId: await partnerPrincipal(prisma, s.slug),
      profile: "m3-v1",
      tape: { filename: "northlight.xlsx", bytes: book.tape },
      supplement: { filename: "supplement.csv", bytes: utf8(book.supplement) },
    });
    if (imported.status !== "loaded") throw new Error(imported.status);
    const one = await prisma.loan.findFirstOrThrow({
      where: { servicerId: s.id, servicerLoanNumber: "NL-100001" },
      include: { parties: true },
    });
    // The claim is unbuilt, so the party is stood behind a sign-in by hand:
    // what the claim will do, minus the token.
    const me = await createUser();
    await prisma.user.update({ where: { id: me.id }, data: { partyId: one.parties[0]!.partyId } });

    const r = await get(me.id, one.id);
    expect(r.status).toBe(200);
    expect(r.body.observed).toMatchObject({
      asOf: "2026-09-01",
      status: "CURRENT",
      principalBalanceCents: "44136613",
      currentRatePct: "7.250",
      nextPaymentDueOn: "2026-10-01",
      delinquencyDays: 0,
    });
    expect((r.body.live as { status: string }).status).toBe("fetched");
  });

  it("answers a stranger exactly as it answers a loan that does not exist", async () => {
    const owner = await createUser();
    const s = await servicer("API");
    const loanId = await loanFor(owner.id, s.id, "NL-100001");
    const stranger = await createUser();
    await partyForUser(prisma, stranger.id);

    const theirs = await get(stranger.id, loanId);
    const nothing = await get(stranger.id, "33333333-3333-3333-3333-333333333333");
    expect(theirs.status).toBe(404);
    expect(theirs.body).toEqual(nothing.body);
  });
});
