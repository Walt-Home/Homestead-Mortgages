/**
 * Screens 1 and 2, joined to the application layer.
 *
 * The first claim is narrow and load-bearing: saving screen 1 creates a
 * credit request that is a DRAFT and nothing more. Not an application — the
 * receipt is a database trigger that counts pins, and a screen-1 save has
 * none, so a file that has only been typed into must not carry a Loan Estimate
 * clock. The way that goes wrong is silent: a scenario with an address and a
 * value plus three pins from an earlier file, and the trigger stamps.
 *
 * The second is screen 2, which is where an application usually begins. The
 * person is saved, the authorization is signed, the three party-side pieces
 * are borrowed under it, and the sixth of them stamps the receipt — all in
 * transactions the routes own, so what a save writes is all of it or none of
 * it. Every case here is driven through the routes rather than the services,
 * because the ordering the client uses is half of what is being asserted.
 *
 * Everything here runs against the real Postgres, because everything it
 * asserts is enforced there — the unique join column, the receipt, the clock
 * and the ledger are triggers and constraints, not code.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { addBusinessDays, RECEIPT_REASON_CODE } from "@hm/shared";
import { fileRouter } from "../routes/files.js";
import { connectorRouter } from "../routes/connectors.js";
import { esignRouter } from "../routes/esign.js";
import { applicationForFile, scenarioTermsFrom, syncScenario } from "../services/applications.js";
import { applicationStanding, rawLedger } from "../services/standing.js";
import { pinFact, pinTridPieces, proposeScenario, sixPieces } from "../services/evidence.js";
import { transition } from "../services/transition.js";
import {
  assertFacts,
  liveFact,
  principalForParty,
  recordBorrowerFacts,
} from "../services/party.js";
import { listAccessibleFiles, loadLoanFile, recordSnapshot } from "../services/repository.js";
import { consent, createLoanFile, createUser } from "./support/factories.js";
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

async function startFile(over: Record<string, unknown> = {}, asUser?: { id: string }) {
  const user = asUser ?? (await createUser());
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

  it("asks for the figure when nobody has stated one", async () => {
    // Nothing knows this person's income, and saying it is a dollar would not
    // change that — nor could an application ever be received on it. The
    // screen carries the field for exactly this case, so it asks rather than
    // saving something that can never complete. The same rule the SSN gets,
    // for the same reason.
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });

    const res = await callAs<{ error: { code: string } }>(
      user.id,
      [fileRouter],
      "POST",
      `/${file.id}/borrowers`,
      SCREEN_TWO,
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INCOME_REQUIRED");
    expect(await prisma.borrower.count({ where: { loanFileId: file.id } })).toBe(0);
    // Refused before anything was written, so this person has no party yet —
    // a save that did not happen recorded nothing about them.
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { partyId: true } }))
        .partyId,
    ).toBeNull();
  });

  it("takes the figure this save states, when there is none on record", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const res = await callAs(user.id, [fileRouter], "POST", `/${file.id}/borrowers`, {
      ...SCREEN_TWO,
      statedMonthlyIncome: 7_200,
    });
    expect(res.status).toBe(201);
    expect((await liveFact(prisma, await partyOf(user.id), "monthly_income"))?.value).toBe(7_200);
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
      data: { loanFileId: file.id, ausCasefileId: randomUUID() },
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

/* ── Screen 2: the person, the authorization, and the receipt ─────────────── */

/** A standing's ledger as [event, reason] pairs, which is what is asserted on. */
const ledgerRows = (
  standing: { ledger: readonly { event: string; reasonCode: string | null }[] } | null,
) => (standing?.ledger ?? []).map((r) => [r.event, r.reasonCode]);

/** The application's live pins, in a shape a test can compare. */
async function livePins(applicationId: string) {
  return prisma.applicationEvidenceLink.findMany({
    where: { applicationId, releasedAt: null },
    orderBy: { predicate: "asc" },
    select: { id: true, predicate: true, factId: true, authorizationId: true },
  });
}

/**
 * The newest thing on record about this party, which no pin may name.
 *
 * `liveFact` answers the newest assertion that has not been superseded or
 * retracted and says nothing about `expires_at`; the pin guard refuses an
 * expired fact outright. That disagreement is the lever these tests need: it
 * fails a save from INSIDE the route's transaction, after the row the request
 * came to write is already in it, which is the only place the transaction is
 * observable at all.
 */
async function unpinnableFact(partyId: string, predicate: string, value: unknown) {
  return prisma.fact.create({
    data: {
      subjectType: "PARTY",
      subjectId: partyId,
      partyId,
      predicate,
      value: value as never,
      sourceKind: "SELF_ATTESTED",
      confidence: "ATTESTED",
      assertedByPrincipalId: await principalForParty(prisma, partyId),
      // A minute ahead so it is unambiguously what `liveFact` answers, and
      // expired a minute ago so the database will not have it pinned.
      observedAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() - 60_000),
    },
    select: { id: true },
  });
}

/** The person's row on a file, which screen 2 has created by now. */
async function borrowerOf(fileId: string) {
  return prisma.borrower.findFirstOrThrow({
    where: { loanFileId: fileId },
    select: { id: true, partyId: true },
  });
}

/** Screen 2 exactly as the client posts it: the person, then the authorization. */
async function saveScreenTwo(userId: string, fileId: string, over: Record<string, unknown> = {}) {
  const saved = await callAs<{
    id: string;
    stage: string;
    applicationState: { status: string } | null;
  }>(userId, [fileRouter], "POST", `/${fileId}/borrowers`, {
    ...SCREEN_TWO,
    ...over,
  });
  expect(saved.status).toBe(201);
  const borrower = await borrowerOf(fileId);
  const granted = await callAs<{ alreadyRecorded: boolean }>(
    userId,
    [connectorRouter],
    "POST",
    `/${fileId}/consents`,
    { kind: "verification_authorization", borrowerId: borrower.id },
  );
  expect([200, 201]).toContain(granted.status);
  return { saved, granted, borrower };
}

describe("screen 2 pins the person", () => {
  it("pins nothing until the authorization exists, then pins all three", async () => {
    // The client posts the person before the consent, and the consent is what
    // creates the grant a pin borrows under. So the first half of screen 2 has
    // nothing to pin under, and saying so — rather than throwing, or pinning
    // under whatever grant happens to be lying around — is the whole contract.
    const { user, fileId } = await startFile();
    const app = await applicationForFile(prisma, fileId);

    const first = await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, SCREEN_TWO);
    expect(first.status).toBe(201);
    expect(await livePins(app!.id)).toEqual([]);
    expect((await applicationForFile(prisma, fileId))!.status).toBe("draft");
    // Asked again with no grant, the reconciler still reports it did nothing.
    expect(
      await pinTridPieces(prisma, { applicationId: app!.id, partyId: await partyOf(user.id) }),
    ).toEqual({ grantId: null, pinned: [], released: [] });

    const borrower = await borrowerOf(fileId);
    const granted = await callAs(user.id, [connectorRouter], "POST", `/${fileId}/consents`, {
      kind: "verification_authorization",
      borrowerId: borrower.id,
    });
    expect(granted.status).toBe(201);

    const pins = await livePins(app!.id);
    expect(pins.map((p) => p.predicate).sort()).toEqual([
      "legal_name",
      "monthly_income",
      "ssn_token",
    ]);
    expect(await sixPieces(app!.id)).toEqual({
      legal_name: true,
      ssn_token: true,
      monthly_income: true,
      propertyAddress: true,
      valueEstimateCents: true,
      loanAmountCents: true,
    });
  });

  it("receives a returning borrower's second file on the save, not on the consent", async () => {
    // An authorization belongs to a person and lasts 120 days, so somebody who
    // applies twice inside that window is already holding one when they reach
    // screen 2 of the second file. The reconciler borrows under it, which
    // means the second file is received a moment earlier than the first was —
    // on the person save rather than on the consent that follows it. That is
    // the right direction for a clock that measures when the six pieces
    // arrived, and it is the whole observable difference between the two
    // files, so it is written down here rather than left to be rediscovered.
    const { user, fileId: first } = await startFile();
    await saveScreenTwo(user.id, first);
    const partyId = await partyOf(user.id);
    const firstPins = await livePins((await applicationForFile(prisma, first))!.id);
    expect(firstPins).toHaveLength(3);
    expect(
      await prisma.authorization.count({
        where: { partyId, purpose: "FCRA_WRITTEN_INSTRUCTION", revokedAt: null },
      }),
    ).toBe(1);

    const { fileId: second } = await startFile({}, user);
    const saved = await callAs(user.id, [fileRouter], "POST", `/${second}/borrowers`, SCREEN_TWO);
    expect(saved.status).toBe(201);

    const app = await applicationForFile(prisma, second);
    expect(await livePins(app!.id)).toHaveLength(3);
    expect(await prisma.consent.count({ where: { loanFileId: second } })).toBe(0);

    const standing = await applicationStanding(prisma, second);
    expect(standing?.status).toBe("awaiting_borrower");
    expect(standing?.ledger.map((r) => [r.event, r.reasonCode])).toEqual([
      ["intake_completed", RECEIPT_REASON_CODE],
      ["borrower_owes", "bank_connection_needed"],
    ]);
    // Screen 2 is what caused it here, where the consent caused it on the
    // first file. Same edge, honestly attributed.
    expect((await rawLedger(prisma, second))[1]?.causedBy).toBe("screen:identity");
    expect(standing?.loanEstimate?.tolled).toBe(true);

    // The consent that follows absorbs into the same three pins: one live pin
    // per predicate, and no second receipt.
    const borrower = await borrowerOf(second);
    const granted = await callAs(user.id, [connectorRouter], "POST", `/${second}/consents`, {
      kind: "verification_authorization",
      borrowerId: borrower.id,
    });
    expect(granted.status).toBe(201);
    expect(await livePins(app!.id)).toHaveLength(3);
    expect((await applicationStanding(prisma, second))?.ledger).toHaveLength(2);

    // And the first file still holds one live pin per piece, all three now
    // borrowed from what this second file's screens stated — a pin is what an
    // application relies on NOW, so re-pointing it is upkeep rather than a
    // change of story. Screen 2 restates the name and the SSN whether or not
    // they changed, and every save supersedes, so a person applying twice
    // moves all three. What the first file was received on is on the ledger
    // and in the released pins, none of which moved.
    const firstAfter = await livePins((await applicationForFile(prisma, first))!.id);
    expect(firstAfter).toHaveLength(3);
    for (const predicate of ["legal_name", "monthly_income", "ssn_token"]) {
      expect(firstAfter.find((p) => p.predicate === predicate)!.factId, predicate).toBe(
        (await liveFact(prisma, partyId, predicate))!.id,
      );
    }
    for (const pin of firstPins) {
      const released = await prisma.applicationEvidenceLink.findUniqueOrThrow({
        where: { id: pin.id },
      });
      expect(released.releasedAt, pin.predicate).not.toBeNull();
    }
  });

  it("answers with the file, its stage and where the application stands", async () => {
    // The reply reports the standing as of THIS write, so a caller is never
    // handed a stage without the state that goes with it. A first-ever save
    // leaves a draft, because the authorization that licenses the pins has not
    // been signed yet; the same post after the consent says what is owed.
    const { user, fileId } = await startFile();
    const { saved } = await saveScreenTwo(user.id, fileId);
    expect(saved.body).toMatchObject({ id: fileId, stage: "credit" });
    expect(saved.body.applicationState?.status).toBe("draft");

    const again = await callAs<{
      id: string;
      stage: string;
      applicationState: { status: string } | null;
    }>(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, SCREEN_TWO);
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ id: fileId, stage: "credit" });
    expect(again.body.applicationState?.status).toBe("awaiting_borrower");
  });

  it("receives the application and says what is owed next, in one transaction", async () => {
    const { user, fileId } = await startFile();
    await saveScreenTwo(user.id, fileId);

    const standing = await applicationStanding(prisma, fileId);
    expect(standing?.status).toBe("awaiting_borrower");
    expect(standing?.ledger.map((r) => [r.seq, r.from, r.to, r.event, r.reasonCode])).toEqual([
      [1, "draft", "intake_received", "intake_completed", RECEIPT_REASON_CODE],
      [2, "intake_received", "awaiting_borrower", "borrower_owes", "bank_connection_needed"],
    ]);
    // The receipt is the database's; what follows it is the product's, and
    // both are services rather than the person.
    expect(standing?.ledger.map((r) => r.actorKind)).toEqual(["SERVICE", "SERVICE"]);
    const raw = await rawLedger(prisma, fileId);
    expect(raw.map((r) => r.actorSubject)).toEqual(["trid_receipt", "application_flow"]);
    expect(raw[1]?.causedBy).toBe("consent:verification_authorization");

    // The clock the receipt opened, tolled because nothing can deliver it.
    expect(standing?.loanEstimate?.tolled).toBe(true);
    expect(standing?.loanEstimate?.dueAt).toBe(
      addBusinessDays(new Date(standing!.ledger[0]!.occurredAt), 3).toISOString(),
    );
    // Two moves, one status: the stamps have to be strictly increasing or the
    // constraint that every move advances the sequence cannot be checked.
    expect(new Date(standing!.ledger[1]!.occurredAt).getTime()).toBeGreaterThan(
      new Date(standing!.ledger[0]!.occurredAt).getTime(),
    );
  });

  it("puts the receipt and the six pieces on the wire, and no due date beside them", async () => {
    // What the debug panel reads. APP-002's input is projected from the ledger
    // row the trigger wrote, so the one place a tester can see which piece a
    // file is still short of is this response — and `loanEstimateDueAt` is
    // gone from it, because the clock's own row is the only thing that knows
    // that date and the API used to compute a second, disagreeing one.
    const { user, fileId } = await startFile();
    await saveScreenTwo(user.id, fileId);

    const read = await callAs<{
      file: { application: { receivedAt: string; sixPieces: Record<string, boolean> } | null };
    }>(user.id, [fileRouter], "GET", `/${fileId}`);
    expect(read.status).toBe(200);
    expect(read.body.file.application?.sixPieces).toEqual({
      name: true,
      income: true,
      ssn: true,
      propertyAddress: true,
      valueEstimate: true,
      loanAmount: true,
    });
    const standing = await applicationStanding(prisma, fileId);
    expect(read.body.file.application?.receivedAt).toBe(standing!.ledger[0]!.occurredAt);
    expect(JSON.stringify(read.body)).not.toContain("loanEstimateDueAt");
  });

  it("writes the signature, the pins and the move together, or none of them", async () => {
    // A consent row standing alone would say a borrower authorized a
    // verification whose evidence was never taken — and an application that
    // moved without the signature that moved it is worse. The handler puts all
    // of it in one transaction, and the only way to show that is to make the
    // request itself fail partway through: a test that builds its own
    // transaction proves nothing about the route, and stayed green with the
    // route's transaction taken out.
    //
    // Income is the third piece the reconciler reaches, so the refusal arrives
    // after the name and the SSN have been pinned inside this transaction.
    // Two rows really were written into application_evidence_links, and the
    // count below is what happened to them.
    const { user, fileId } = await startFile();
    const first = await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, SCREEN_TWO);
    expect(first.status).toBe(201);
    const borrower = await borrowerOf(fileId);
    const app = await applicationForFile(prisma, fileId);
    await unpinnableFact(borrower.partyId, "monthly_income", 9_400);

    const refused = await callAs<{ error: { code: string } }>(
      user.id,
      [connectorRouter],
      "POST",
      `/${fileId}/consents`,
      { kind: "verification_authorization", borrowerId: borrower.id },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("EVIDENCE_REFUSED");

    expect(await prisma.consent.count({ where: { loanFileId: fileId } })).toBe(0);
    expect(await prisma.authorization.count({ where: { partyId: borrower.partyId } })).toBe(0);
    expect(await prisma.applicationEvidenceLink.count({ where: { applicationId: app!.id } })).toBe(
      0,
    );
    expect(await prisma.applicationTransition.count({ where: { applicationId: app!.id } })).toBe(0);
    expect(await prisma.regulatoryClock.count({ where: { applicationId: app!.id } })).toBe(0);
    expect((await applicationForFile(prisma, fileId))!.status).toBe("draft");
  });

  it("writes a signature completed on screen 4 the same way, or not at all", async () => {
    // The other route that mints a grant and pins under it. Same transaction,
    // same claim, and it has to be asserted separately because it is a second
    // handler with its own `$transaction` — the one place a renewal can be
    // written without screen 2 being revisited.
    const { user, fileId } = await startFile();
    const first = await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, SCREEN_TWO);
    expect(first.status).toBe(201);
    const borrower = await borrowerOf(fileId);
    const app = await applicationForFile(prisma, fileId);

    const started = await callAs<{ envelopeId: string }>(
      user.id,
      [esignRouter],
      "POST",
      `/${fileId}/esign`,
      { kind: "verification_authorization" },
    );
    expect(started.status).toBe(201);
    await unpinnableFact(borrower.partyId, "monthly_income", 9_400);

    const refused = await callAs<{ error: { code: string } }>(
      user.id,
      [esignRouter],
      "POST",
      `/${fileId}/esign/complete`,
      { envelopeId: started.body.envelopeId },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("EVIDENCE_REFUSED");

    expect(await prisma.consent.count({ where: { loanFileId: fileId } })).toBe(0);
    expect(await prisma.authorization.count({ where: { partyId: borrower.partyId } })).toBe(0);
    expect(await prisma.applicationEvidenceLink.count({ where: { applicationId: app!.id } })).toBe(
      0,
    );
    expect(await prisma.applicationTransition.count({ where: { applicationId: app!.id } })).toBe(0);
    expect(await prisma.regulatoryClock.count({ where: { applicationId: app!.id } })).toBe(0);
    expect((await applicationForFile(prisma, fileId))!.status).toBe("draft");
  });

  it("writes the person and the pins that follow them together, or neither", async () => {
    // Screen 2 on a file that has already been received. The save supersedes
    // the person's facts and moves the pins onto the successors, and if the
    // second half cannot be written the first half must not stand either — a
    // corrected name recorded on the party while the application still borrows
    // the old one is exactly the split this transaction exists to prevent.
    const { user, fileId } = await startFile();
    const { borrower } = await saveScreenTwo(user.id, fileId);
    const app = await applicationForFile(prisma, fileId);
    const before = await livePins(app!.id);
    expect(before).toHaveLength(3);
    await unpinnableFact(borrower.partyId, "monthly_income", 9_400);

    const refused = await callAs<{ error: { code: string } }>(
      user.id,
      [fileRouter],
      "POST",
      `/${fileId}/borrowers`,
      { ...SCREEN_TWO, lastName: "Whitfield-Okafor" },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("EVIDENCE_REFUSED");

    // The correction is gone from the party as well as from the pins: one
    // name fact, saying what it said before.
    const partyId = borrower.partyId;
    expect(await prisma.fact.count({ where: { partyId, predicate: "legal_name" } })).toBe(1);
    expect((await liveFact(prisma, partyId, "legal_name"))?.value).toEqual({
      first: "Dana",
      last: "Whitfield",
    });
    // Not one pin released, not one added, and the file stands where it stood.
    expect(await livePins(app!.id)).toEqual(before);
    expect(await prisma.applicationTransition.count({ where: { applicationId: app!.id } })).toBe(2);
    expect((await applicationForFile(prisma, fileId))!.status).toBe("awaiting_borrower");
  });

  it("moves the pin to the corrected fact when the borrower fixes their name", async () => {
    const { user, fileId } = await startFile();
    await saveScreenTwo(user.id, fileId);
    const app = await applicationForFile(prisma, fileId);
    const before = await livePins(app!.id);

    const again = await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, {
      ...SCREEN_TWO,
      lastName: "Whitfield-Okafor",
    });
    expect(again.status).toBe(201);

    const after = await livePins(app!.id);
    // Still one live pin per piece — not two, which is what pinning blindly on
    // every save would leave, and not a stale one, which is what pinning only
    // on the first save would leave.
    expect(after.map((p) => p.predicate).sort()).toEqual([
      "legal_name",
      "monthly_income",
      "ssn_token",
    ]);
    const name = after.find((p) => p.predicate === "legal_name")!;
    const wasName = before.find((p) => p.predicate === "legal_name")!;
    expect(name.factId).not.toBe(wasName.factId);
    expect(name.factId).toBe((await liveFact(prisma, await partyOf(user.id), "legal_name"))!.id);
    // The old pin is released, never deleted: the application really did
    // borrow that fact, and the record of it stays.
    const released = await prisma.applicationEvidenceLink.findUniqueOrThrow({
      where: { id: wasName.id },
    });
    expect(released.releasedAt).not.toBeNull();

    // A correction is not a second application.
    const standing = await applicationStanding(prisma, fileId);
    expect(standing?.status).toBe("awaiting_borrower");
    expect(standing?.ledger).toHaveLength(2);
    expect(Object.values(await sixPieces(app!.id)).every(Boolean)).toBe(true);
  });

  it("leaves the income pin alone when the revisit states no income", async () => {
    // Screen 2 does not ask for the figure, so a revisit sends none. Absent
    // must mean absent all the way down: no new fact, and the pin still on the
    // one screen 1 recorded.
    const { user, fileId } = await startFile();
    await saveScreenTwo(user.id, fileId);
    const app = await applicationForFile(prisma, fileId);
    const before = (await livePins(app!.id)).find((p) => p.predicate === "monthly_income")!;

    await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, SCREEN_TWO);

    const after = (await livePins(app!.id)).find((p) => p.predicate === "monthly_income")!;
    expect(after).toEqual(before);
    const partyId = await partyOf(user.id);
    expect(await prisma.fact.count({ where: { partyId, predicate: "monthly_income" } })).toBe(1);
  });

  it("borrows nothing under a grant that does not cover a credit request", async () => {
    // Persistent monitoring mirrors to an account-review grant, which the pin
    // guard refuses outright. Taking "any live grant for this party" would
    // turn an opt-in to monitoring into the authorization an application was
    // borrowed under, and the refusal would surface as a 403 on a save.
    const { user, fileId } = await startFile();
    const first = await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, SCREEN_TWO);
    expect(first.status).toBe(201);
    const borrower = await borrowerOf(fileId);
    const monitoring = await callAs(user.id, [connectorRouter], "POST", `/${fileId}/consents`, {
      kind: "persistent_monitoring",
      borrowerId: borrower.id,
    });
    expect(monitoring.status).toBe(201);
    expect(
      await prisma.authorization.count({
        where: { partyId: borrower.partyId, purpose: "FCRA_ACCOUNT_REVIEW" },
      }),
    ).toBe(1);

    const app = await applicationForFile(prisma, fileId);
    expect(
      await pinTridPieces(prisma, { applicationId: app!.id, partyId: borrower.partyId }),
    ).toEqual({ grantId: null, pinned: [], released: [] });
    expect((await applicationForFile(prisma, fileId))!.status).toBe("draft");
  });

  it("re-pins under the new grant when a signature is renewed", async () => {
    // The 120-day case, without the wait. The mirror trigger retires a grant
    // that has lapsed and mints a fresh one; every pin borrowed under the old
    // one is then evidence held under an authorization nobody has. Signing
    // again on screen 4 is the path that renews it without screen 2 being
    // revisited, so the reconciler runs there too.
    const { user, fileId } = await startFile();
    const { borrower } = await saveScreenTwo(user.id, fileId);
    const app = await applicationForFile(prisma, fileId);
    const before = await livePins(app!.id);
    const lapsed = await prisma.authorization.findFirstOrThrow({
      where: { partyId: borrower.partyId, purpose: "FCRA_WRITTEN_INSTRUCTION" },
    });
    await prisma.authorization.update({
      where: { id: lapsed.id },
      data: {
        revokedAt: new Date(),
        revokedByPrincipalId: await principalForParty(prisma, borrower.partyId),
        revocationReason: "lapsed; renewed by a new consent",
      },
    });

    const started = await callAs<{ envelopeId: string }>(
      user.id,
      [esignRouter],
      "POST",
      `/${fileId}/esign`,
      { kind: "verification_authorization" },
    );
    expect(started.status).toBe(201);
    const completed = await callAs(user.id, [esignRouter], "POST", `/${fileId}/esign/complete`, {
      envelopeId: started.body.envelopeId,
    });
    expect(completed.status).toBe(201);

    const renewed = await prisma.authorization.findFirstOrThrow({
      where: { partyId: borrower.partyId, purpose: "FCRA_WRITTEN_INSTRUCTION", revokedAt: null },
    });
    const after = await livePins(app!.id);
    expect(after).toHaveLength(3);
    expect(after.every((p) => p.authorizationId === renewed.id)).toBe(true);
    // Same facts, borrowed again under the authorization that now stands.
    expect(after.map((p) => p.factId).sort()).toEqual(before.map((p) => p.factId).sort());
    for (const pin of before) {
      const row = await prisma.applicationEvidenceLink.findUniqueOrThrow({ where: { id: pin.id } });
      expect(row.releasedAt).not.toBeNull();
    }
  });

  it("receives the file when the signature arrives on screen 4 instead of screen 2", async () => {
    // Screen 2's consent post is the usual signature, but it is not the only
    // one: a borrower who reaches the review screen unsigned signs there, and
    // that signature is what finally receives the application. The cause it
    // records is the consent handler's, because it is the same cause — a
    // verification authorization signed on this file. Where the pen was is the
    // envelope's business, and a second spelling would split one edge in two.
    const { user, fileId } = await startFile();
    const saved = await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, SCREEN_TWO);
    expect(saved.status).toBe(201);
    expect((await applicationForFile(prisma, fileId))!.status).toBe("draft");

    const started = await callAs<{ envelopeId: string }>(
      user.id,
      [esignRouter],
      "POST",
      `/${fileId}/esign`,
      { kind: "verification_authorization" },
    );
    expect(started.status).toBe(201);
    const completed = await callAs(user.id, [esignRouter], "POST", `/${fileId}/esign/complete`, {
      envelopeId: started.body.envelopeId,
    });
    expect(completed.status).toBe(201);

    const standing = await applicationStanding(prisma, fileId);
    expect(standing?.status).toBe("awaiting_borrower");
    expect(standing?.ledger.map((r) => [r.event, r.reasonCode])).toEqual([
      ["intake_completed", RECEIPT_REASON_CODE],
      ["borrower_owes", "bank_connection_needed"],
    ]);
    expect((await rawLedger(prisma, fileId))[1]?.causedBy).toBe(
      "consent:verification_authorization",
    );
  });

  it("refuses to reconcile under REPEATABLE READ, where a concurrent pin is invisible", async () => {
    // The receipt counts pins, and under a repeatable-read snapshot a pin
    // written by another transaction is simply absent — so the sixth piece
    // lands and no clock starts. The function refuses rather than miscount,
    // and this is the route-shaped transaction that would have hit it.
    const { user, fileId } = await startFile();
    const first = await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, SCREEN_TWO);
    expect(first.status).toBe(201);
    const borrower = await borrowerOf(fileId);
    await consent(fileId, borrower.id, "verification_authorization");
    const app = await applicationForFile(prisma, fileId);

    await expect(
      prisma.$transaction(
        (tx) => pinTridPieces(tx, { applicationId: app!.id, partyId: borrower.partyId }),
        { isolationLevel: "RepeatableRead" },
      ),
    ).rejects.toThrow(/REPEATABLE READ/);
  });

  it("starts the work instead when the bank is already connected", async () => {
    // Unreachable from the four screens, where the bank comes after the
    // consent. It is reachable for a file whose receipt fires late, and the
    // wrong answer there would tell a borrower to connect an account they have
    // already connected.
    const { user, fileId } = await startFile();
    const first = await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, SCREEN_TWO);
    expect(first.status).toBe(201);
    const borrower = await borrowerOf(fileId);
    await recordSnapshot(fileId, "bank", "fixture", "ext-1", {}, new Date().toISOString());

    const granted = await callAs(user.id, [connectorRouter], "POST", `/${fileId}/consents`, {
      kind: "verification_authorization",
      borrowerId: borrower.id,
    });
    expect(granted.status).toBe(201);

    const standing = await applicationStanding(prisma, fileId);
    expect(standing?.status).toBe("in_processing");
    expect(standing?.ledger.map((r) => [r.event, r.reasonCode])).toEqual([
      ["intake_completed", RECEIPT_REASON_CODE],
      ["work_began", "bank_already_connected"],
    ]);
  });

  it("settles an intake once, however many times it is asked", async () => {
    const { user, fileId } = await startFile();
    await saveScreenTwo(user.id, fileId);
    const app = await applicationForFile(prisma, fileId);

    // Screen 2 re-saved, and the consent re-posted, which the client does on
    // every completion. Neither may write a second "connect your bank".
    await saveScreenTwo(user.id, fileId);
    await saveScreenTwo(user.id, fileId);
    expect(await prisma.applicationTransition.count({ where: { applicationId: app!.id } })).toBe(2);
    expect(await prisma.consent.count({ where: { loanFileId: fileId } })).toBe(1);
    expect(await livePins(app!.id)).toHaveLength(3);
  });

  it("saves onto the borrower recorded first, not the one the heap returns first", async () => {
    // Two people on one file, and the row this screen updates decides whose
    // facts are superseded, whose party is promoted to PRIMARY_BORROWER — and
    // so, through the receipt that promotion can fire, whose Loan Estimate
    // clock starts. Unordered, the database chose. The ids are fixed and
    // deliberately out of step with the insertion order, and both rows share
    // the millisecond, so the heap order and the intended order genuinely
    // disagree rather than agreeing half the time.
    const DEV = "eeeeeeee-eeee-4eee-8eee-eeeeeee00002";
    const DANA = "eeeeeeee-eeee-4eee-8eee-eeeeeee00001";
    const { user, fileId } = await startFile();
    const app = await applicationForFile(prisma, fileId);
    const dana = await partyOf(user.id);
    const dev = await prisma.party.create({ data: { kind: "PERSON" }, select: { id: true } });
    const sameInstant = new Date("2026-06-01T10:00:00.000Z");
    for (const row of [
      { id: DEV, partyId: dev.id, firstName: "Dev" },
      { id: DANA, partyId: dana, firstName: "Dana" },
    ]) {
      await prisma.$transaction(async (tx) => {
        await recordBorrowerFacts(tx, {
          loanFileId: fileId,
          existingPartyId: row.partyId,
          input: {
            ...SCREEN_TWO,
            // The three the route's schema defaults; nothing here is testing
            // them, and the service takes the shape after parsing.
            citizenship: "us_citizen",
            preferredLanguage: "en",
            isMilitary: false,
            firstName: row.firstName,
            ssnVaultHandle: `vault:${row.firstName.toLowerCase()}:1`,
          },
        });
        await tx.borrower.create({
          data: {
            id: row.id,
            partyId: row.partyId,
            loanFileId: fileId,
            ssnLast4: "1111",
            currentHousing: "rent",
            createdAt: sameInstant,
          },
        });
      });
    }

    const res = await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, SCREEN_TWO);
    expect(res.status).toBe(201);

    // Dana's row carries the save; Dev's is untouched, and no fact of Dev's
    // was superseded by a screen this person did not fill in.
    expect(
      (await prisma.borrower.findUniqueOrThrow({ where: { id: DANA }, select: { ssnLast4: true } }))
        .ssnLast4,
    ).toBe("6789");
    expect(
      (await prisma.borrower.findUniqueOrThrow({ where: { id: DEV }, select: { ssnLast4: true } }))
        .ssnLast4,
    ).toBe("1111");
    expect((await liveFact(prisma, dev.id, "legal_name"))?.value).toEqual({
      first: "Dev",
      last: "Whitfield",
    });
    // And the application still names one primary borrower: the person whose
    // request it is.
    expect(
      await prisma.applicationParty.findMany({
        where: { applicationId: app!.id },
        select: { partyId: true, role: true },
      }),
    ).toEqual([{ partyId: dana, role: "PRIMARY_BORROWER" }]);
  });

  it("leaves a file made before applications existed alone", async () => {
    const user = await createUser();
    const legacy = await createLoanFile({ userId: user.id });
    const res = await callAs(user.id, [fileRouter], "POST", `/${legacy.id}/borrowers`, {
      ...SCREEN_TWO,
      statedMonthlyIncome: 8_000,
    });
    expect(res.status).toBe(201);
    const borrower = await borrowerOf(legacy.id);
    const granted = await callAs(user.id, [connectorRouter], "POST", `/${legacy.id}/consents`, {
      kind: "verification_authorization",
      borrowerId: borrower.id,
    });
    expect(granted.status).toBe(201);
    expect(await applicationStanding(prisma, legacy.id)).toBeNull();
    expect(await prisma.applicationEvidenceLink.count()).toBe(0);
    // And APP-002's input stays null, which is the truthful reading: nothing
    // can point at the moment this application was received.
    expect((await loadLoanFile(legacy.id))!.application).toBeNull();
  });
});

describe("editing screen 1 after the person is on it", () => {
  it("moves the income pin when the borrower corrects the figure", async () => {
    // The correction lands on the party as a new fact, which supersedes the
    // one the application borrowed. A pin left on the old one is evidence of
    // something the borrower has already taken back.
    const { user, fileId } = await startFile();
    await saveScreenTwo(user.id, fileId);
    const app = await applicationForFile(prisma, fileId);
    const before = (await livePins(app!.id)).find((p) => p.predicate === "monthly_income")!;

    const res = await callAs(user.id, [fileRouter], "PATCH", `/${fileId}`, {
      statedMonthlyIncome: 11_000,
    });
    expect(res.status).toBe(200);

    const after = (await livePins(app!.id)).find((p) => p.predicate === "monthly_income")!;
    expect(after.id).not.toBe(before.id);
    expect(after.factId).toBe(
      (await liveFact(prisma, await partyOf(user.id), "monthly_income"))!.id,
    );
    expect(await livePins(app!.id)).toHaveLength(3);
  });

  it("says what is owed next when this edit is what received the file", async () => {
    // Screen 1 is the third writer that can fire the receipt: the scenario it
    // proposes is counted by the same trigger the pins are. A file that was
    // received here and never settled would sit at intake_received with
    // nothing on the borrower's side of the ledger — no "Needs you", and a
    // timeline that never asks for the bank.
    //
    // Reaching it takes a file whose active terms carry no value, which screen
    // 1's own schema will not produce; the scenario is retired by hand so the
    // three pins land against terms the receipt cannot count.
    const { user, fileId } = await startFile();
    const app = await applicationForFile(prisma, fileId);
    await proposeScenario(
      app!.id,
      {
        objective: "PURCHASE",
        occupancy: "PRIMARY_RESIDENCE",
        loanAmountCents: 33_200_000n,
        termMonths: 360,
        propertyAddress: "88 Foster Lane, Austin, TX 78745",
      },
      prisma,
    );

    await saveScreenTwo(user.id, fileId);
    expect(await livePins(app!.id)).toHaveLength(3);
    expect((await applicationForFile(prisma, fileId))!.status).toBe("draft");

    const res = await callAs(user.id, [fileRouter], "PATCH", `/${fileId}`, {
      valueOrPrice: 425_000,
    });
    expect(res.status).toBe(200);

    const standing = await applicationStanding(prisma, fileId);
    expect(standing?.status).toBe("awaiting_borrower");
    expect(standing?.ledger.map((r) => [r.event, r.reasonCode])).toEqual([
      ["intake_completed", RECEIPT_REASON_CODE],
      ["borrower_owes", "bank_connection_needed"],
    ]);
    expect((await rawLedger(prisma, fileId))[1]?.causedBy).toBe("screen:property_loan");
  });
});

describe("one person, more than one file", () => {
  it("re-points the first file's income pin when the second states a new figure", async () => {
    // The figure belongs to the PERSON, so stating it on a new file supersedes
    // the fact the earlier file's application borrowed. Nothing ever looked at
    // an application other than the one the request was about, so that file
    // kept a live pin on evidence the borrower had replaced — and the receipt
    // counts live pins without asking whether the fact behind one still
    // stands, so it went on reporting a piece it had nothing current for.
    const { user, fileId: first } = await startFile();
    await saveScreenTwo(user.id, first);
    const app = (await applicationForFile(prisma, first))!;
    const before = (await livePins(app.id)).find((p) => p.predicate === "monthly_income")!;
    const partyId = await partyOf(user.id);

    await startFile({ statedMonthlyIncome: 12_100 }, user);

    const live = (await liveFact(prisma, partyId, "monthly_income"))!;
    expect(live.value).toBe(12_100);
    const after = (await livePins(app.id)).find((p) => p.predicate === "monthly_income")!;
    expect(after.factId).toBe(live.id);
    expect(after.id).not.toBe(before.id);
    // The fact it names is the one that stands: nothing has replaced it.
    expect(
      (
        await prisma.fact.findUniqueOrThrow({
          where: { id: after.factId },
          select: { supersededById: true },
        })
      ).supersededById,
    ).toBeNull();
    // Released, never deleted. The first file really did borrow the old
    // figure, and the record of that is what history is made of.
    expect(
      (await prisma.applicationEvidenceLink.findUniqueOrThrow({ where: { id: before.id } }))
        .releasedAt,
    ).not.toBeNull();
    // And what the screen says is unchanged: the piece is still held, on
    // evidence that is still good.
    expect((await sixPieces(app.id)).monthly_income).toBe(true);
    expect(await livePins(app.id)).toHaveLength(3);
  });

  it("re-points it again when the borrower goes back and edits the second file", async () => {
    // Screen 1 of the second file is not the last chance to state the figure:
    // the borrower can go back to it and correct what they typed. That edit
    // supersedes the fact BOTH applications are now borrowing, so it has to
    // reach the first file exactly as the original save did — otherwise the
    // one path a borrower is most likely to take twice is the one that leaves
    // the older application holding evidence that has been taken back.
    const { user, fileId: first } = await startFile();
    await saveScreenTwo(user.id, first);
    const app = (await applicationForFile(prisma, first))!;
    const partyId = await partyOf(user.id);

    const { fileId: second } = await startFile({}, user);
    const before = (await livePins(app.id)).find((p) => p.predicate === "monthly_income")!;

    const res = await callAs(user.id, [fileRouter], "PATCH", `/${second}`, {
      statedMonthlyIncome: 12_100,
    });
    expect(res.status).toBe(200);

    const live = (await liveFact(prisma, partyId, "monthly_income"))!;
    expect(live.value).toBe(12_100);
    const after = (await livePins(app.id)).find((p) => p.predicate === "monthly_income")!;
    expect(after.factId).toBe(live.id);
    expect(after.id).not.toBe(before.id);
    // The piece is still held, on evidence that is still good.
    expect((await sixPieces(app.id)).monthly_income).toBe(true);
    expect(await livePins(app.id)).toHaveLength(3);
  });

  it("re-points the first file's name pin when screen 2 of the second corrects it", async () => {
    // The name belongs to the person exactly as the income does, and screen 2
    // is where it is corrected. Reconciling only the file the request happens
    // to be about would leave the pin rule true of one piece and false of
    // another — and the first application holding evidence of a surname the
    // borrower has already replaced, which is the thing a pin is defined not
    // to be.
    const { user, fileId: first } = await startFile();
    await saveScreenTwo(user.id, first);
    const app = (await applicationForFile(prisma, first))!;
    const before = (await livePins(app.id)).find((p) => p.predicate === "legal_name")!;
    const partyId = await partyOf(user.id);

    const { fileId: second } = await startFile({}, user);
    const res = await callAs(user.id, [fileRouter], "POST", `/${second}/borrowers`, {
      ...SCREEN_TWO,
      lastName: "Whitfield-Okafor",
    });
    expect(res.status).toBe(201);

    const live = (await liveFact(prisma, partyId, "legal_name"))!;
    expect(live.value).toMatchObject({ last: "Whitfield-Okafor" });
    const after = (await livePins(app.id)).find((p) => p.predicate === "legal_name")!;
    expect(after.factId).toBe(live.id);
    expect(after.id).not.toBe(before.id);
    // Still one live pin per piece, and the receipt still counts six.
    expect(await livePins(app.id)).toHaveLength(3);
    expect((await sixPieces(app.id)).legal_name).toBe(true);
  });

  it("says what the OTHER file owes when this save is what received it", async () => {
    // The reconciliation reaches every application the person is applying on,
    // and pinning their name, SSN and income into one of them can be what
    // completes its six pieces. So a save about file A receives file B — and
    // a received application that is never told what it owes next shows "We
    // have it" with nothing on the ledger, no "Needs you", and no screen
    // anywhere asking for its bank. The settle follows the reconciliation
    // wherever it goes.
    const { user, fileId: first } = await startFile();
    await saveScreenTwo(user.id, first);

    const { fileId: second } = await startFile({}, user);
    const app = (await applicationForFile(prisma, second))!;
    expect(app.status).toBe("draft");

    // Screen 2 of the FIRST file, saved again. Nothing about the second file
    // is in this request.
    const res = await callAs(user.id, [fileRouter], "POST", `/${first}/borrowers`, SCREEN_TWO);
    expect(res.status).toBe(201);

    const standing = (await applicationStanding(prisma, second))!;
    expect(standing.status).toBe("awaiting_borrower");
    expect(standing.ledger.map((r) => [r.event, r.reasonCode])).toEqual([
      ["intake_completed", RECEIPT_REASON_CODE],
      ["borrower_owes", "bank_connection_needed"],
    ]);
    // And the first file, which was received long before this save, is
    // settled once and not again.
    expect((await applicationStanding(prisma, first))!.ledger).toHaveLength(2);
  });

  it("receives and settles the other file from the consent too", async () => {
    // The consent is the third screen that supersedes what an application
    // relies on: it mints the grant every pin is borrowed under, so it is
    // often the moment a person's facts first reach ANY application. Pinning
    // only the file the request is about left a file started last month at
    // draft with nothing pinned to it, while all three facts and a live grant
    // existed — the same fault screens 1 and 2 already refuse to have.
    const { user, fileId: started } = await startFile();
    expect((await applicationForFile(prisma, started))!.status).toBe("draft");

    // A second file, taken through screen 2 and its consent. Nothing about
    // the first file is in either request.
    const { fileId: second } = await startFile({}, user);
    await saveScreenTwo(user.id, second);

    const standing = (await applicationStanding(prisma, started))!;
    expect(standing.status).toBe("awaiting_borrower");
    expect(ledgerRows(standing)).toEqual([
      ["intake_completed", RECEIPT_REASON_CODE],
      ["borrower_owes", "bank_connection_needed"],
    ]);
    expect(await livePins((await applicationForFile(prisma, started))!.id)).toHaveLength(3);
  });

  it("settles it from screen 1 and from an edit to screen 1, not only from screen 2", async () => {
    // The income is one of the six pieces and screen 1 is where it is stated,
    // so both writers on that screen can be what receives somebody's other
    // file. Each site is asserted because each site is a place the settle can
    // be dropped on its own.
    const { user, fileId: first } = await startFile();
    await saveScreenTwo(user.id, first);
    const owesTheBank = [
      ["intake_completed", RECEIPT_REASON_CODE],
      ["borrower_owes", "bank_connection_needed"],
    ];

    // Started and left at screen 1. A NEW file's screen 1 restates the income,
    // which is the piece this one was missing.
    const { fileId: started } = await startFile({}, user);
    await startFile({ statedMonthlyIncome: 12_100 }, user);
    expect(ledgerRows(await applicationStanding(prisma, started))).toEqual(owesTheBank);

    // And the edit behind screen 1, on a file that already has everything:
    // correcting the figure there receives the one started last.
    const { fileId: edited } = await startFile({}, user);
    const patched = await callAs(user.id, [fileRouter], "PATCH", `/${first}`, {
      statedMonthlyIncome: 13_400,
    });
    expect(patched.status).toBe(200);
    expect(ledgerRows(await applicationStanding(prisma, edited))).toEqual(owesTheBank);
  });

  it("leaves an application that has ended alone", async () => {
    // A withdrawn application's evidence is the record of what it was decided
    // on. Re-pointing its pins because the person said something new on a
    // later file would quietly rewrite the basis of an ending somebody chose.
    const { user, fileId: first } = await startFile();
    await saveScreenTwo(user.id, first);
    const app = (await applicationForFile(prisma, first))!;
    const partyId = await partyOf(user.id);
    await transition({
      applicationId: app.id,
      event: "borrower_withdrew",
      actorPrincipalId: await principalForParty(prisma, partyId),
      reasonCode: "borrower_requested",
    });
    const before = await livePins(app.id);

    await startFile({ statedMonthlyIncome: 12_100 }, user);

    expect(await livePins(app.id)).toEqual(before);

    // And through the screen itself, which pins directly rather than through
    // the reconciler: saving a corrected surname at a withdrawn file's URL
    // must move nothing either. This is the path the rule is easiest to lose
    // on, because the route knows which application it is writing to and asks
    // nobody whether that application is still open.
    const again = await callAs(user.id, [fileRouter], "POST", `/${first}/borrowers`, {
      ...SCREEN_TWO,
      lastName: "Whitfield-Okafor",
    });
    expect(again.status).toBe(201);
    expect(await livePins(app.id)).toEqual(before);
    // The correction did land on the person — it is only the ended
    // application's evidence that stands still.
    expect((await liveFact(prisma, partyId, "legal_name"))!.value).toMatchObject({
      last: "Whitfield-Okafor",
    });

    // Its income pin now names a fact the person has replaced, deliberately:
    // that is the figure this application was withdrawn holding.
    expect(
      (
        await prisma.fact.findUniqueOrThrow({
          where: { id: before.find((p) => p.predicate === "monthly_income")!.factId },
          select: { supersededById: true },
        })
      ).supersededById,
    ).not.toBeNull();
  });
});
