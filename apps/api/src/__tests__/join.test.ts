/**
 * Screen 1, joined to the application layer.
 *
 * The claim under test is narrow and load-bearing: saving screen 1 creates a
 * credit request that is a DRAFT and nothing more. Not an application — the
 * receipt is a database trigger that counts pins, and a screen-1 save has
 * none, so a file that has only been typed into must not carry a Loan Estimate
 * clock. The way that goes wrong is silent: a scenario with an address and a
 * value plus three pins from an earlier file, and the trigger stamps.
 *
 * Everything here runs against the real Postgres, because everything it
 * asserts is enforced there — the unique join column, the receipt, the clock
 * and the ledger are triggers and constraints, not code.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { addBusinessDays, RECEIPT_REASON_CODE } from "@hm/shared";
import { fileRouter } from "../routes/files.js";
import { applicationForFile, scenarioTermsFrom, syncScenario } from "../services/applications.js";
import { applicationStanding, rawLedger } from "../services/standing.js";
import { pinFact } from "../services/evidence.js";
import { transition } from "../services/transition.js";
import { assertFacts, liveFact, principalForParty } from "../services/party.js";
import { listAccessibleFiles } from "../services/repository.js";
import { createLoanFile, createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

const DAY = 24 * 60 * 60 * 1000;

/** Screen 1's body, as the web posts it. $415,000 house, $332,000 loan. */
const SCREEN_ONE = {
  purpose: "purchase",
  address: {
    line1: "88 Foster Lane",
    city: "Austin",
    state: "tx",
    postalCode: "78745",
  },
  propertyType: "single_family",
  occupancy: "primary_residence",
  valueOrPrice: 415_000,
  loanAmount: 332_000,
  downPayment: 83_000,
  statedMonthlyIncome: 9_400,
};

async function startFile(over: Record<string, unknown> = {}) {
  const user = await createUser();
  const res = await callAs<{ id: string; applicationState: { status: string } | null }>(
    user.id,
    [fileRouter],
    "POST",
    "/",
    { ...SCREEN_ONE, ...over },
  );
  expect(res.status).toBe(201);
  return { user, fileId: res.body.id, body: res.body };
}

/** The party behind a user, which screen 1 has created by now. */
async function partyOf(userId: string): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { partyId: true },
  });
  return user.partyId!;
}

describe("screen 1 makes a draft", () => {
  it("creates one application, at draft, with no ledger row", async () => {
    const { fileId, body } = await startFile();

    const app = await prisma.application.findUniqueOrThrow({
      where: { loanFileId: fileId },
      select: { status: true, statusSeq: true, transitions: true, clocks: true },
    });
    expect(app.status).toBe("DRAFT");
    // Sequence 0 is the state a file starts in. It needs no ledger row, and
    // the deferred constraint exempts it.
    expect(app.statusSeq).toBe(0);
    expect(app.transitions).toHaveLength(0);
    // No pins, so no receipt, so no Loan Estimate clock. A clock opened here
    // would be a three-day deadline on a file nobody has applied with.
    expect(app.clocks).toHaveLength(0);
    expect(body.applicationState?.status).toBe("draft");
  });

  it("puts the person asking on the application", async () => {
    const { user, fileId } = await startFile();
    const app = await applicationForFile(prisma, fileId);
    const parties = await prisma.applicationParty.findMany({
      where: { applicationId: app!.id },
      select: { partyId: true, role: true },
    });
    expect(parties).toEqual([{ partyId: await partyOf(user.id), role: "PRIMARY_BORROWER" }]);
  });

  it("records the stated income as a fact on the party, not as router state", async () => {
    // The bug this ends: the figure was collected on screen 1, carried in the
    // client's router state, and re-sent from screen 2 as `statedIncome || 1`
    // — an income of one dollar asserted as a piece of a TRID application.
    const { user } = await startFile();
    const income = await liveFact(prisma, await partyOf(user.id), "monthly_income");
    expect(income?.value).toBe(9_400);
  });

  it("proposes the terms in cents, at sequence 1", async () => {
    const { fileId } = await startFile();
    const app = await applicationForFile(prisma, fileId);
    const scenario = await prisma.loanScenario.findFirstOrThrow({
      where: { applicationId: app!.id },
    });
    expect(scenario.seq).toBe(1);
    expect(scenario.isActive).toBe(true);
    expect(scenario.objective).toBe("PURCHASE");
    expect(scenario.occupancy).toBe("PRIMARY_RESIDENCE");
    // Dollars in the legacy column, bigint cents in the scenario.
    expect(scenario.loanAmountCents).toBe(33_200_000n);
    expect(scenario.downPaymentCents).toBe(8_300_000n);
    expect(scenario.valueEstimateCents).toBe(41_500_000n);
    expect(scenario.propertyAddress).toBe("88 Foster Lane, Austin, TX 78745");
    // 6.25% quoted by config.defaultProduct, as basis points.
    expect(scenario.noteRateBps).toBe(625);
    expect(scenario.termMonths).toBe(360);
  });

  it("makes one person out of two saves that arrive at once", async () => {
    // A double-tapped Continue, which the client cannot prevent. Creating the
    // file takes a shared lock on the user's row through `loan_files.user_id`,
    // and claiming the party needs an exclusive one on that same row because
    // `users.party_id` is unique — so in the other order two of these deadlock
    // and Postgres kills one, which reaches the borrower as a 500. Repeated
    // because a lost race is a race that sometimes runs cleanly.
    for (let round = 0; round < 3; round += 1) {
      const user = await createUser();
      const [first, second] = await Promise.all([
        callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE),
        callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE),
      ]);
      expect([first.status, second.status]).toEqual([201, 201]);

      // One person, on both applications. Without the lock both saves read no
      // party, both mint one, and the loser's application names a party its
      // own user does not have.
      const partyId = await partyOf(user.id);
      for (const res of [first, second]) {
        const app = await applicationForFile(prisma, res.body.id);
        const parties = await prisma.applicationParty.findMany({
          where: { applicationId: app!.id },
          select: { partyId: true, role: true },
        });
        expect(parties).toEqual([{ partyId, role: "PRIMARY_BORROWER" }]);
      }
    }
  });

  it("gives a second file its own application", async () => {
    const { user, fileId } = await startFile();
    const second = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
    const a = await applicationForFile(prisma, fileId);
    const b = await applicationForFile(prisma, second.body.id);
    expect(a!.id).not.toBe(b!.id);
  });
});

describe("a file made before applications existed", () => {
  it("has none, and is never given one", async () => {
    // Null is "no application on record", never a draft. A legacy file that
    // acquired one at its next save would wear "You've started" over work that
    // finished months ago.
    const legacy = await createLoanFile();
    expect(await applicationForFile(prisma, legacy.id)).toBeNull();
    expect(await applicationStanding(prisma, legacy.id)).toBeNull();
    expect(await rawLedger(prisma, legacy.id)).toEqual([]);
  });
});

describe("editing screen 1", () => {
  it("proposes nothing when nothing about the terms changed", async () => {
    const { user, fileId } = await startFile();
    const app = await applicationForFile(prisma, fileId);

    const res = await callAs(user.id, [fileRouter], "PATCH", `/${fileId}`, {
      // A term-shaped field re-sent at its current value, plus one that is not
      // a term at all. Neither is a new version of the loan.
      loanAmount: 332_000,
      financedPropertyCount: 2,
    });
    expect(res.status).toBe(200);

    const scenarios = await prisma.loanScenario.findMany({ where: { applicationId: app!.id } });
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0]!.seq).toBe(1);
  });

  it("retires the old terms and proposes the next when the amount moves", async () => {
    const { user, fileId } = await startFile();
    const app = await applicationForFile(prisma, fileId);

    await callAs(user.id, [fileRouter], "PATCH", `/${fileId}`, { loanAmount: 300_000 });

    const scenarios = await prisma.loanScenario.findMany({
      where: { applicationId: app!.id },
      orderBy: { seq: "asc" },
    });
    expect(scenarios.map((s) => [s.seq, s.isActive, s.supersededBySeq])).toEqual([
      [1, false, 2],
      [2, true, null],
    ]);
    expect(scenarios[1]!.loanAmountCents).toBe(30_000_000n);
  });

  it("answers with the stage the file is actually on", async () => {
    // It used to answer a literal "identity" whatever the file had reached, so
    // a borrower editing a term from the review screen was told by the server
    // that they were back on screen 2.
    const { user, fileId } = await startFile();
    await prisma.loanFile.update({ where: { id: fileId }, data: { stage: "BANK" } });
    const res = await callAs<{ stage: string }>(user.id, [fileRouter], "PATCH", `/${fileId}`, {
      loanAmount: 331_000,
    });
    expect(res.body.stage).toBe("bank");
  });

  it("leaves a legacy file alone", async () => {
    const user = await createUser();
    const legacy = await createLoanFile({ userId: user.id });
    const res = await callAs(user.id, [fileRouter], "PATCH", `/${legacy.id}`, {
      loanAmount: 200_000,
    });
    expect(res.status).toBe(200);
    expect(await prisma.loanScenario.count()).toBe(0);
  });

  it("supersedes the party's income when the borrower corrects it", async () => {
    // The figure is stated on screen 1 and asserted on screen 1. An edit that
    // only reached the loan file row would leave the party — and the pin the
    // receipt reads — holding the number the borrower had already fixed.
    const { user, fileId } = await startFile();
    const res = await callAs(user.id, [fileRouter], "PATCH", `/${fileId}`, {
      statedMonthlyIncome: 11_000,
    });
    expect(res.status).toBe(200);
    expect((await liveFact(prisma, await partyOf(user.id), "monthly_income"))?.value).toBe(11_000);
  });

  it("leaves the income alone when the edit does not mention it", async () => {
    const { user, fileId } = await startFile();
    await callAs(user.id, [fileRouter], "PATCH", `/${fileId}`, { loanAmount: 300_000 });
    const partyId = await partyOf(user.id);
    expect((await liveFact(prisma, partyId, "monthly_income"))?.value).toBe(9_400);
    // One assertion, not two: a save that said nothing about income must not
    // supersede the fact with a copy of itself.
    expect(await prisma.fact.count({ where: { partyId, predicate: "monthly_income" } })).toBe(1);
  });
});

/** Screen 2's body, minus the income. Screen 1 is where that is stated. */
const SCREEN_TWO = {
  firstName: "Dana",
  lastName: "Whitfield",
  email: "dana@example.test",
  phone: "5555550100",
  dateOfBirth: "1988-04-12",
  ssnVaultHandle: "vault:dana:1",
  ssnLast4: "6789",
  currentAddress: { line1: "1 Fixture St", city: "Demo City", state: "CA", postalCode: "94000" },
  maritalStatus: "unmarried",
  firstTimeHomebuyer: true,
  currentHousing: "rent",
  demographics: null,
};

describe("screen 2 with no income to state", () => {
  /**
   * The screen used to send $1 rather than nothing.
   *
   * The figure reaches screen 2 on router state or a saved draft, and the
   * redirect through the identity vendor destroys both — so a placeholder was
   * an income of one dollar asserted about a real person, and counted by the
   * receipt as one of the six pieces of their application. Absent has to mean
   * absent: no fact, and whatever screen 1 recorded still standing.
   */
  it("leaves the figure screen 1 asserted alone", async () => {
    const { user, fileId } = await startFile();
    const res = await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, SCREEN_TWO);
    expect(res.status).toBe(201);

    const partyId = await partyOf(user.id);
    expect((await liveFact(prisma, partyId, "monthly_income"))?.value).toBe(9_400);
    expect(await prisma.fact.count({ where: { partyId, predicate: "monthly_income" } })).toBe(1);
  });

  it("asserts no income at all when nobody has stated one", async () => {
    // A file made before screen 1 asserted the fact. Nothing knows this
    // person's income, and saying it is a dollar would not change that.
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const res = await callAs(user.id, [fileRouter], "POST", `/${file.id}/borrowers`, SCREEN_TWO);
    expect(res.status).toBe(201);

    const partyId = await partyOf(user.id);
    expect(await prisma.fact.count({ where: { partyId, predicate: "monthly_income" } })).toBe(0);
  });
});

describe("terms that cannot be stated", () => {
  it("are null rather than a scenario with a hole in it", () => {
    const complete = {
      purpose: "PURCHASE" as const,
      occupancy: "primary_residence",
      loanAmount: null,
      downPayment: null,
      valueOrPrice: null,
      termMonths: 360,
      noteRate: null,
      propertyLine1: "88 Foster Lane",
      propertyLine2: null,
      propertyCity: "Austin",
      propertyState: "TX",
      propertyPostalCode: "78745",
    };
    // No amount and no value: the receipt reads both, so a scenario missing
    // either is a request nobody made.
    expect(scenarioTermsFrom(complete)).toBeNull();
    // No street line: no address either.
    expect(scenarioTermsFrom({ ...complete, propertyLine1: null })).toBeNull();
  });

  it("writes nothing when syncScenario has nothing to state", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const app = await prisma.application.create({
      data: { loanFileId: file.id },
      select: { id: true },
    });
    const row = await prisma.loanFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(await syncScenario(prisma, app.id, row)).toBeNull();
    expect(await prisma.loanScenario.count()).toBe(0);
  });
});

describe("where the application stands", () => {
  /** The three party-side pieces, pinned — which is what makes an application. */
  async function completeTheSixPieces(userId: string, fileId: string) {
    const partyId = await partyOf(userId);
    const principalId = await principalForParty(prisma, partyId);
    await assertFacts(prisma, partyId, principalId, [
      { predicate: "legal_name", value: { first: "Maya", last: "Okafor" } },
      { predicate: "ssn_token", value: "vault:test" },
    ]);
    const grant = await prisma.authorization.create({
      data: {
        partyId,
        purpose: "FCRA_WRITTEN_INSTRUCTION",
        dataCategories: ["CREDIT_REPORT"],
        grantedAt: new Date(Date.now() - DAY),
        expiresAt: new Date(Date.now() + 120 * DAY),
      },
      select: { id: true },
    });
    const app = await applicationForFile(prisma, fileId);
    for (const predicate of ["legal_name", "ssn_token", "monthly_income"]) {
      const fact = await liveFact(prisma, partyId, predicate);
      await pinFact({ applicationId: app!.id, factId: fact!.id, authorizationId: grant.id });
    }
    return app!.id;
  }

  it("is the ledger in order, with the clock the receipt opened", async () => {
    const { user, fileId } = await startFile();
    await completeTheSixPieces(user.id, fileId);

    const standing = await applicationStanding(prisma, fileId);
    expect(standing?.status).toBe("intake_received");
    expect(standing?.terminal).toBe(false);
    expect(standing?.ledger.map((r) => [r.seq, r.from, r.to, r.event])).toEqual([
      [1, "draft", "intake_received", "intake_completed"],
    ]);
    // The receipt is the database's, so the actor is a service and the reason
    // is the one spelling the SQL writes.
    expect(standing?.ledger[0]?.actorKind).toBe("SERVICE");
    expect(standing?.ledger[0]?.reasonCode).toBe(RECEIPT_REASON_CODE);

    // Three business days from the receipt, computed by SQL in the creditor's
    // zone — and the TS helper agrees, which is what keeps a due date on a
    // screen and a due date in a query from drifting across a DST boundary.
    const receivedAt = new Date(standing!.ledger[0]!.occurredAt);
    expect(standing?.loanEstimate?.dueAt).toBe(addBusinessDays(receivedAt, 3).toISOString());
    // Opened tolled: there is no way to deliver a Loan Estimate in this repo,
    // and a clock that could breach on schedule with no channel to satisfy it
    // would manufacture the record of a breach we never could have avoided.
    expect(standing?.loanEstimate?.tolled).toBe(true);
    expect(standing?.loanEstimate?.tollingReason).toBe("no_delivery_channel_configured");
  });

  it("tells a borrower nothing a borrower may not read", async () => {
    const { user, fileId } = await startFile();
    await completeTheSixPieces(user.id, fileId);
    const standing = await applicationStanding(prisma, fileId);
    // `causedBy` can carry requirement ids and `actor_principal_id` names an
    // internal actor. Neither is on the view a screen renders; both are on the
    // debug one.
    expect(Object.keys(standing!.ledger[0]!)).not.toContain("causedBy");
    expect(Object.keys(standing!.ledger[0]!)).not.toContain("actorPrincipalId");
    const raw = await rawLedger(prisma, fileId);
    expect(raw[0]).toMatchObject({ seq: 1, causedBy: null, actorSubject: "trid_receipt" });
  });

  it("rides on GET /files/:id and GET /files/:id/ledger", async () => {
    const { user, fileId } = await startFile();
    await completeTheSixPieces(user.id, fileId);

    const view = await callAs<{ applicationState: { status: string } | null }>(
      user.id,
      [fileRouter],
      "GET",
      `/${fileId}`,
    );
    expect(view.body.applicationState?.status).toBe("intake_received");

    const debug = await callAs<{ ledger: { seq: number }[] }>(
      user.id,
      [fileRouter],
      "GET",
      `/${fileId}/ledger`,
    );
    expect(debug.body.ledger).toHaveLength(1);
  });

  it("refuses the ledger of a file that is not yours, as a 404", async () => {
    const { fileId } = await startFile();
    const stranger = await createUser();
    const res = await callAs(stranger.id, [fileRouter], "GET", `/${fileId}/ledger`);
    expect(res.status).toBe(404);
  });
});

describe("the file list", () => {
  it("says whose each file is, and where it stands", async () => {
    const { user, fileId } = await startFile();
    const legacy = await createLoanFile({ userId: user.id });
    const demo = await createLoanFile({ isDemo: true });

    const rows = await listAccessibleFiles(user.id);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    expect(byId[fileId]!.mine).toBe(true);
    expect(byId[fileId]!.applicationState).toMatchObject({ status: "draft", terminal: false });
    // A file from before the join has none, and the list says so rather than
    // inventing a draft for it.
    expect(byId[legacy.id]!.applicationState).toBeNull();
    expect(byId[demo.id]!.mine).toBe(false);
  });

  it("reports a terminal application as terminal", async () => {
    // The resume link consults this: a stage only moves forward and stops at
    // COMPLETE, so a withdrawn file still reads as unfinished without it.
    const { user, fileId } = await startFile();
    const app = await applicationForFile(prisma, fileId);
    const partyId = await partyOf(user.id);
    await transition({
      applicationId: app!.id,
      event: "borrower_withdrew",
      actorPrincipalId: await principalForParty(prisma, partyId),
      reasonCode: "borrower_requested",
    });

    const rows = await listAccessibleFiles(user.id);
    expect(rows.find((r) => r.id === fileId)?.applicationState?.terminal).toBe(true);
  });
});
