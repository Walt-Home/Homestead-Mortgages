/**
 * The four screens, moving the application.
 *
 * Screen 1 makes the draft and screen 2 receives it; this is everything after.
 * The bank, the branches, the screening, the signature and the decision each
 * write a ledger row, and what is asserted here is that each one writes the
 * RIGHT row: the borrower named as the actor when the borrower acted, a
 * service when the machinery did, and no row at all when the act changed
 * nothing.
 *
 * Two behaviors get more attention than the rest, because both are ways a
 * borrower is told something false. A decision the engine could not compute
 * must not move the file to an approval word — the recommendation is `refer`,
 * the outcome is `referred`, and `OUTCOME_EVENT` gives it no edge, so nothing
 * moves. And a sanctions hold must not be lifted by a bank login, an upload or a page load:
 * the machine allows those edges from `suspended` because a person can take
 * them, and no route here is that person.
 *
 * Against the real Postgres, because the receipt, the clocks and the ledger
 * are triggers and constraints.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { prisma } from "@hm/db";
import { fixtureRegistry, type PersonaId } from "@hm/connectors";
import { TERMINAL, TRANSITION_REASONS, eventsFrom, type ApplicationState } from "@hm/shared";
import { underwrite } from "@hm/underwriting";

// The deployed bank provider is Plaid, whose link session hands the borrower
// to a widget and answers 202 — so the branch of the route that writes
// anything is unreachable from a test against it. What is under test here is
// the state machinery behind the screens, so the bank connector is pinned to
// the fixture. Hoisted because `config` reads the environment at import.
vi.hoisted(() => {
  process.env.BANK_PROVIDER = "fixture";
});

import { applicationRouter } from "../routes/application.js";
import { fileRouter } from "../routes/files.js";
import { connectorRouter } from "../routes/connectors.js";
import { decisionRouter } from "../routes/decision.js";
import { propertyFileRouter } from "../routes/property.js";
import { documentRouter } from "../routes/documents.js";
import { applicationForFile } from "../services/applications.js";
import { tokenFor } from "../services/authorization.js";
import { connectors } from "../services/connectors.js";
import type { Db } from "../services/db.js";
import { decideApplication, recordDecision } from "../services/decide.js";
import { borrowerObligations, reconcileObligations } from "../services/obligations.js";
import { loadLoanFile, recordSnapshot } from "../services/repository.js";
import { screenAndRecord } from "../services/screening.js";
import { principalForParty, servicePrincipal } from "../services/party.js";
import { applicationStanding, rawLedger, settleBorrowerAct } from "../services/standing.js";
import { advanceIfLegal, moved, transition } from "../services/transition.js";
import { consent, createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

/** Screen 1's body: a $415,000 house with a $332,000 loan. */
const SCREEN_ONE = {
  purpose: "purchase",
  address: { line1: "88 Foster Lane", city: "Austin", state: "tx", postalCode: "78745" },
  propertyType: "single_family",
  occupancy: "primary_residence",
  valueOrPrice: 415_000,
  loanAmount: 332_000,
  downPayment: 83_000,
  statedMonthlyIncome: 9_400,
};

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

/** Answered on the review screen, and required before anything may be signed. */
const DEMOGRAPHICS = { ethnicity: "declined", race: "declined", sex: "declined" };

/** Market figures that let the compliance tests run at all. */
const MARKET = {
  apr: 6.44,
  apor: 6.1,
  pointsAndFeesAmount: 9_800,
  estimatedFees: 9_800,
  estimatedPrepaids: 4_200,
};

/** The same figures on a loan priced past every HOEPA threshold. */
const HIGH_COST = {
  apr: 12.5,
  apor: 6.1,
  pointsAndFeesAmount: 60_000,
  estimatedFees: 60_000,
  estimatedPrepaids: 4_200,
};

/** The reasons whose actor is the person, because the person did it. */
const BORROWER_REASONS = [
  "bank_connected",
  "payroll_connected",
  "transcripts_received",
  "documents_received",
  "application_signed",
];

/**
 * Screens 1 and 2, through the routes, leaving the file where a real borrower
 * leaves it: received, and owing us their bank.
 */
async function throughScreenTwo(over: Record<string, unknown> = {}) {
  const user = await createUser();
  const created = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
  expect(created.status).toBe(201);
  const fileId = created.body.id;

  expect(
    (
      await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, {
        ...SCREEN_TWO,
        ...over,
      })
    ).status,
  ).toBe(201);
  const borrower = await prisma.borrower.findFirstOrThrow({
    where: { loanFileId: fileId },
    select: { id: true, partyId: true },
  });
  const granted = await callAs(user.id, [connectorRouter], "POST", `/${fileId}/consents`, {
    kind: "verification_authorization",
    borrowerId: borrower.id,
  });
  expect(granted.status).toBe(201);

  const app = await applicationForFile(prisma, fileId);
  return { user, fileId, borrower, applicationId: app!.id };
}

const statusOf = async (fileId: string): Promise<ApplicationState> =>
  (await applicationForFile(prisma, fileId))!.status;

const ledgerOf = async (fileId: string) =>
  (await applicationStanding(prisma, fileId))!.ledger.map((r) => [r.event, r.reasonCode]);

const eventCount = (loanFileId: string, kind: string) =>
  prisma.fileEvent.count({ where: { loanFileId, kind } });

/**
 * A pull written the way the route writes it, for a persona other than the one
 * this process booted with.
 *
 * `connectors()` resolves its registry once per process, so a second persona
 * cannot be driven through the HTTP route inside the same suite. The writes
 * are the route's: an append-only snapshot, the income and employment it
 * replaces, and the settlement.
 */
async function connectAs(
  persona: PersonaId,
  kind: "credit" | "bank" | "payroll",
  fileId: string,
  partyId: string,
) {
  const registry = fixtureRegistry({ latencyMs: 0, persona, referenceDate: new Date() });
  const file = (await loadLoanFile(fileId))!;

  if (kind === "credit") {
    const credit = await registry.credit.pullTriMerge(file, await tokenFor(file, "credit_report"));
    await recordSnapshot(
      fileId,
      "credit",
      credit.provider,
      credit.externalId,
      credit.data,
      credit.retrievedAt,
    );
    return null;
  }

  const data =
    kind === "bank"
      ? await (async () => {
          const outcome = await registry.bank.fetchAssetReport(
            file,
            await tokenFor(file, "bank_transactions"),
            { sessionId: "s" },
            12,
          );
          if (outcome.status !== "ready") throw new Error("fixture must answer immediately");
          return outcome.result;
        })()
      : await registry.payroll.fetchPayroll(file, await tokenFor(file, "payroll_income"), "s");

  return prisma.$transaction(async (tx) => {
    const snapshot = await recordSnapshot(
      fileId,
      kind,
      data.provider,
      data.externalId,
      data.data,
      data.retrievedAt,
      tx,
    );
    await tx.incomeSource.deleteMany({ where: { loanFileId: fileId } });
    await tx.incomeSource.createMany({
      data: data.data.incomeSources.map((s) => ({
        loanFileId: fileId,
        type: s.type,
        monthlyAmount: s.monthlyAmount,
        historyMonths: s.historyMonths,
        continuanceEndDate: s.continuanceEndDate ? new Date(s.continuanceEndDate) : null,
        continuanceEstablished: s.continuanceEstablished,
        evidenceDocumentIds: [...s.evidenceDocumentIds],
      })),
    });
    await tx.employment.deleteMany({ where: { loanFileId: fileId } });
    await tx.employment.createMany({
      data: data.data.employments.map((e) => ({
        loanFileId: fileId,
        employerName: e.employerName,
        employerEin: e.employerEin ?? null,
        position: e.position,
        startDate: e.startDate ? new Date(e.startDate) : null,
        endDate: e.endDate ? new Date(e.endDate) : null,
        status: e.status,
        isMilitary: e.isMilitary,
        verificationMethod: e.verificationMethod,
      })),
    });
    const app = await applicationForFile(tx, fileId);
    return settleBorrowerAct(tx, {
      applicationId: app!.id,
      loanFileId: fileId,
      partyId,
      reasonCode: kind === "bank" ? "bank_connected" : "payroll_connected",
      causedBy: `snapshot:${snapshot.id}`,
      beginsWorkFromIntake: kind === "bank",
    });
  });
}

/** A borrower whose bank report cannot verify their income, at the payroll branch. */
async function needingPayroll() {
  const started = await throughScreenTwo();
  await connectAs("variable_income", "credit", started.fileId, started.borrower.partyId);
  await connectAs("variable_income", "bank", started.fileId, started.borrower.partyId);
  return started;
}

describe("the bank screen", () => {
  it("records that the borrower did what was asked, and asks for nothing else", async () => {
    const { user, fileId } = await throughScreenTwo();
    expect(await statusOf(fileId)).toBe("awaiting_borrower");

    const res = await callAs(user.id, [connectorRouter], "POST", `/${fileId}/bank`);
    expect(res.status).toBe(201);

    expect(await statusOf(fileId)).toBe("in_processing");
    expect(await ledgerOf(fileId)).toEqual([
      ["intake_completed", "six_pieces_received"],
      ["borrower_owes", "bank_connection_needed"],
      ["borrower_satisfied", "bank_connected"],
    ]);
    // The borrower connected their bank, so the borrower is the actor.
    const standing = await applicationStanding(prisma, fileId);
    expect(standing!.ledger[2]!.actorKind).toBe("BORROWER");
    expect((await rawLedger(prisma, fileId))[2]!.causedBy).toMatch(/^snapshot:/);
  });

  it("asks for payroll when the report could not verify the income", async () => {
    const { fileId } = await needingPayroll();

    expect(await statusOf(fileId)).toBe("awaiting_borrower");
    expect(await ledgerOf(fileId)).toEqual([
      ["intake_completed", "six_pieces_received"],
      ["borrower_owes", "bank_connection_needed"],
      ["borrower_satisfied", "bank_connected"],
      ["borrower_owes", "payroll_connection_needed"],
    ]);
    // Server-side only: the requirement ids ride on `causedBy`, which the
    // borrower's view of the ledger does not carry.
    expect((await rawLedger(prisma, fileId))[3]!.causedBy).toContain("INC-002");
  });

  it("goes on asking for the bank when the borrower answers something else", async () => {
    // `bank_connection_needed` is the one obligation that is not a branch, so
    // a reconciler that saw only branches cleared it on the first unrelated
    // act and never wrote it again. One ordinary document post left a file
    // that had never connected a bank reading "We're working on it. Nothing is
    // needed from you right now", and it went to underwriting from there.
    const { user, fileId } = await throughScreenTwo();
    expect(await statusOf(fileId)).toBe("awaiting_borrower");

    const res = await callAs(user.id, [documentRouter], "POST", `/${fileId}/documents`, {
      satisfiesRequirementId: "CRD-008",
      filename: "explanation.pdf",
      contentType: "application/pdf",
      bytes: 512,
    });
    expect(res.status).toBe(201);

    expect((await loadLoanFile(fileId))!.assets).toBeNull();
    expect(await statusOf(fileId)).toBe("awaiting_borrower");
    expect((await ledgerOf(fileId)).at(-1)).toEqual(["borrower_owes", "bank_connection_needed"]);
  });

  it("writes nothing but an event when the bank is re-linked", async () => {
    const { user, fileId } = await throughScreenTwo();
    await callAs(user.id, [connectorRouter], "POST", `/${fileId}/bank`);
    const before = await ledgerOf(fileId);

    expect((await callAs(user.id, [connectorRouter], "POST", `/${fileId}/bank`)).status).toBe(201);
    expect(await ledgerOf(fileId)).toEqual(before);
    expect(await eventCount(fileId, "application_unchanged")).toBe(1);
  });
});

describe("the branches", () => {
  it("settles the payroll branch and asks for whatever is still owed", async () => {
    const { fileId, borrower } = await needingPayroll();
    await connectAs("variable_income", "payroll", fileId, borrower.partyId);

    // Payroll answers, and the letter of explanation this borrower's credit
    // asks for is still outstanding — so the file goes back to them for it
    // rather than sitting in "we're working on it" with a card on screen.
    expect(await ledgerOf(fileId)).toEqual([
      ["intake_completed", "six_pieces_received"],
      ["borrower_owes", "bank_connection_needed"],
      ["borrower_satisfied", "bank_connected"],
      ["borrower_owes", "payroll_connection_needed"],
      ["borrower_satisfied", "payroll_connected"],
      ["borrower_owes", "documents_needed"],
    ]);
    expect(await statusOf(fileId)).toBe("awaiting_borrower");
  });

  it("settles the payroll branch through the route the borrower actually posts to", async () => {
    // The case above drives the settlement itself, so it says nothing about
    // whether `POST /files/:id/payroll` performs one: the block could be
    // deleted from the handler and it would still pass. This is the route.
    // The registry is resolved once per process, so the connection answers
    // with the booted persona's payroll rather than this file's — which is
    // beside the point here, because what is under test is the ledger row the
    // handler writes when a borrower connects an employer.
    const { user, fileId } = await needingPayroll();
    const before = (await ledgerOf(fileId)).length;

    const res = await callAs(user.id, [connectorRouter], "POST", `/${fileId}/payroll`);
    expect(res.status).toBe(201);

    expect((await ledgerOf(fileId))[before]).toEqual(["borrower_satisfied", "payroll_connected"]);
    const standing = await applicationStanding(prisma, fileId);
    expect(standing!.ledger[before]!.actorKind).toBe("BORROWER");
    expect((await rawLedger(prisma, fileId))[before]!.causedBy).toMatch(/^snapshot:/);
  });

  it("settles the transcript branch, and names the borrower who licensed it", async () => {
    // The pull is ours to make — nobody logs into anything — but the 4506-C
    // the borrower signed is what permits it, so the act is recorded as
    // theirs. Driven through the route because the route is where the
    // settlement was missing: the transcripts arrived, the snapshot landed,
    // and the file sat at "Needs you" over a branch it had just finished.
    const { user, fileId, borrower } = await throughScreenTwo();
    await consent(fileId, borrower.id, "form_4506c");
    expect(await statusOf(fileId)).toBe("awaiting_borrower");

    const res = await callAs(user.id, [connectorRouter], "POST", `/${fileId}/irs`);
    expect(res.status).toBe(201);

    // And straight back to them for the bank, which this file has still never
    // connected — the branch is finished, the application is not.
    expect(await statusOf(fileId)).toBe("awaiting_borrower");
    expect(await ledgerOf(fileId)).toEqual([
      ["intake_completed", "six_pieces_received"],
      ["borrower_owes", "bank_connection_needed"],
      ["borrower_satisfied", "transcripts_received"],
      ["borrower_owes", "bank_connection_needed"],
    ]);
    const standing = await applicationStanding(prisma, fileId);
    expect(standing!.ledger[2]!.actorKind).toBe("BORROWER");
    expect((await rawLedger(prisma, fileId))[2]!.causedBy).toMatch(/^snapshot:/);
  });

  it("settles the document branch when the document arrives", async () => {
    const { user, fileId, borrower } = await needingPayroll();
    await connectAs("variable_income", "payroll", fileId, borrower.partyId);

    const res = await callAs(user.id, [documentRouter], "POST", `/${fileId}/documents`, {
      satisfiesRequirementId: "CRD-008",
      filename: "explanation.pdf",
      contentType: "application/pdf",
      bytes: 1_024,
    });
    expect(res.status).toBe(201);

    expect(await statusOf(fileId)).toBe("in_processing");
    expect((await ledgerOf(fileId)).at(-1)).toEqual(["borrower_satisfied", "documents_received"]);
    expect(borrowerObligations((await loadLoanFile(fileId))!)).toEqual([]);
  });

  it("records both of two uploads that arrive at once, and neither is a conflict", async () => {
    // The upload screen renders one control per outstanding item, each with
    // its own request, so attaching to two of them at once is one ordinary
    // interaction. Both acts satisfy the file and the reconciliation
    // immediately owes the borrower the next thing, so the file bounces back
    // to "needs you" between the two — into a state where the second writer's
    // event is legal again. Answering that with a 409 rolled the loser's whole
    // request back, and the document it had just recorded went with it.
    // Repeated, because a lost race is a race that sometimes runs cleanly.
    for (let round = 0; round < 3; round += 1) {
      const { user, fileId, borrower } = await needingPayroll();
      await connectAs("variable_income", "payroll", fileId, borrower.partyId);
      expect(await statusOf(fileId)).toBe("awaiting_borrower");
      const before = (await ledgerOf(fileId)).length;

      // Neither attachment answers CRD-008, so the letter of explanation is
      // still owed after both — which is what keeps the file bouncing.
      const attach = (filename: string) =>
        callAs(user.id, [documentRouter], "POST", `/${fileId}/documents`, {
          satisfiesRequirementId: "AST-006",
          filename,
          contentType: "application/pdf",
          bytes: 2_048,
        });
      const results = await Promise.all([attach("one.pdf"), attach("two.pdf")]);

      expect(results.map((r) => r.status)).toEqual([201, 201]);
      expect(await prisma.document.count({ where: { loanFileId: fileId } })).toBe(2);
      // The same rows the two calls would have written a second apart.
      expect((await ledgerOf(fileId)).slice(before)).toEqual([
        ["borrower_satisfied", "documents_received"],
        ["borrower_owes", "documents_needed"],
        ["borrower_satisfied", "documents_received"],
        ["borrower_owes", "documents_needed"],
      ]);
      expect(await statusOf(fileId)).toBe("awaiting_borrower");
    }
  }, 30_000);
});

describe("the signature", () => {
  /** What `POST /sign-application` does to the application, and nothing else. */
  const sign = (applicationId: string, loanFileId: string, partyId: string) =>
    prisma.$transaction(async (tx) =>
      settleBorrowerAct(tx, {
        applicationId,
        loanFileId,
        partyId,
        reasonCode: "application_signed",
        causedBy: "event:application_signed",
      }),
    );

  it("takes the ball out of the borrower's court, and hands it back if more is owed", async () => {
    const { fileId, borrower, applicationId } = await needingPayroll();
    await connectAs("variable_income", "payroll", fileId, borrower.partyId);
    expect(await statusOf(fileId)).toBe("awaiting_borrower");

    await sign(applicationId, fileId, borrower.partyId);
    expect((await ledgerOf(fileId)).slice(-2)).toEqual([
      ["borrower_satisfied", "application_signed"],
      ["borrower_owes", "documents_needed"],
    ]);
  });

  it("records the signature as the borrower's own act, and asks again for the bank", async () => {
    // Screens 1 and 2 and nothing more: the file is waiting on the borrower
    // for their bank, and no branch is owed. Signing is the borrower supplying
    // something that was asked of them, so the ball leaves their court — and
    // comes straight back, because the bank has still never been connected.
    // Anything else would be a file in "we're working on it" with no bank on
    // it and no screen anywhere asking for one.
    //
    // Through the ROUTE, not the service. Every other case in this block calls
    // `settleBorrowerAct` directly, which proves what the settlement does and
    // nothing about whether `POST /sign-application` performs it: the block
    // could be deleted from the handler and they would all still pass.
    const { user, fileId } = await throughScreenTwo({ demographics: DEMOGRAPHICS });
    expect(await statusOf(fileId)).toBe("awaiting_borrower");

    const res = await callAs<{ signed: string[] }>(
      user.id,
      [applicationRouter],
      "POST",
      `/${fileId}/sign-application`,
    );
    expect(res.status).toBe(201);
    expect(res.body.signed).toEqual(["form_4506c"]);

    expect(await statusOf(fileId)).toBe("awaiting_borrower");
    const standing = await applicationStanding(prisma, fileId);
    expect(standing!.ledger[2]!.actorKind).toBe("BORROWER");
    expect(await ledgerOf(fileId)).toEqual([
      ["intake_completed", "six_pieces_received"],
      ["borrower_owes", "bank_connection_needed"],
      ["borrower_satisfied", "application_signed"],
      ["borrower_owes", "bank_connection_needed"],
    ]);
    expect(await eventCount(fileId, "application_unchanged")).toBe(0);
  });

  it("writes nothing when the file was not waiting on anybody", async () => {
    const { user, fileId, borrower, applicationId } = await throughScreenTwo();
    await callAs(user.id, [connectorRouter], "POST", `/${fileId}/bank`);
    const before = await ledgerOf(fileId);

    await sign(applicationId, fileId, borrower.partyId);
    expect(await ledgerOf(fileId)).toEqual(before);
    expect(await eventCount(fileId, "application_unchanged")).toBe(1);
  });
});

describe("the decision", () => {
  /** Credit and bank, which is as far as a clean W-2 borrower has to go. */
  async function connected() {
    const started = await throughScreenTwo();
    for (const endpoint of ["credit", "bank"]) {
      const res = await callAs(
        started.user.id,
        [connectorRouter],
        "POST",
        `/${started.fileId}/${endpoint}`,
      );
      expect(res.status).toBe(201);
    }
    return started;
  }

  const decide = (userId: string, fileId: string, market: Record<string, number> = {}) =>
    callAs<{ applicationState: { status: string } }>(
      userId,
      [decisionRouter],
      "POST",
      `/${fileId}/decision`,
      market,
    );

  it("asks the engine, and refuses to call a refer an approval", async () => {
    // No APR, no APOR and no fee schedule, so the compliance tests are blocked
    // and the recommendation is `refer`. The outcome is `referred`, which has
    // no edge out of underwriting — moving the file on it would tell a
    // borrower something was decided by a calculation nobody made.
    const { user, fileId } = await connected();
    const res = await decide(user.id, fileId);
    expect(res.status).toBe(201);
    expect(res.body.applicationState.status).toBe("in_underwriting");
    expect((await ledgerOf(fileId)).at(-1)).toEqual(["underwriting_began", "engine_asked"]);
    // The word is on the stored row, not only in the engine's return value.
    const stored = await prisma.decision.findFirstOrThrow({ where: { loanFileId: fileId } });
    expect(stored.outcome).toBe("referred");
    expect(stored.ausRecommendation).toBe("refer");

    // Twice more. A repeat has no edge, so nothing is written.
    await decide(user.id, fileId);
    await decide(user.id, fileId);
    expect(await ledgerOf(fileId)).toHaveLength(4);
    const app = await prisma.application.findUniqueOrThrow({ where: { loanFileId: fileId } });
    expect(app.statusSeq).toBe(4);
    // And every one of the three was still recorded: decisions are appended.
    expect(await prisma.decision.count({ where: { loanFileId: fileId } })).toBe(3);
    expect(await eventCount(fileId, "decision_not_applied")).toBe(0);
  });

  it("approves when every test ran and passed", async () => {
    const { user, fileId } = await connected();
    const res = await decide(user.id, fileId, MARKET);
    expect(res.body.applicationState.status).toBe("approved");
    expect((await ledgerOf(fileId)).at(-1)).toEqual(["decided_approved", "engine_clean"]);

    const standing = await applicationStanding(prisma, fileId);
    // The engine decided it, and the ledger names the engine.
    expect(standing!.ledger.at(-1)!.actorKind).toBe("SERVICE");
    const raw = await rawLedger(prisma, fileId);
    expect(raw.at(-1)).toMatchObject({ actorSubject: "shadow_aus" });
    expect(raw.at(-1)!.causedBy).toMatch(/^decision:/);
  });

  it("offers a different loan when the one asked for is ineligible", async () => {
    // 97.9% LTV on a conforming purchase.
    const { user, fileId } = await connected();
    await callAs(user.id, [fileRouter], "PATCH", `/${fileId}`, {
      loanAmount: 406_285,
      downPayment: 8_715,
    });
    const res = await decide(user.id, fileId, MARKET);
    expect(res.body.applicationState.status).toBe("counteroffer_outstanding");
    expect((await ledgerOf(fileId)).at(-1)).toEqual(["decided_counteroffer", "engine_ineligible"]);
  });

  it("records a decision it cannot apply, and moves nothing", async () => {
    // The engine answers on what it has: a 99% LTV purchase is ineligible
    // whether or not the bank is connected, so the word on the row is
    // `counteroffer`. The file is still waiting on that bank, though, and
    // `awaiting_borrower` has no edge to a counteroffer — so nothing moves,
    // the file's own events say the decision was not applied, and the pill
    // still reads "Needs you". This is the state the review screen has to
    // survive: a decided word on a row over an application nobody decided.
    const { user, fileId } = await throughScreenTwo();
    await callAs(user.id, [fileRouter], "PATCH", `/${fileId}`, {
      loanAmount: 411_000,
      downPayment: 4_000,
    });
    const before = await ledgerOf(fileId);

    const res = await decide(user.id, fileId);
    expect(res.status).toBe(201);
    expect(res.body.applicationState.status).toBe("awaiting_borrower");

    const stored = await prisma.decision.findFirstOrThrow({ where: { loanFileId: fileId } });
    expect(stored.outcome).toBe("counteroffer");
    expect(await ledgerOf(fileId)).toEqual(before);
    expect(await eventCount(fileId, "decision_not_applied")).toBe(1);
  });

  it("declines a high-cost loan, and the database opens the notice clock", async () => {
    const { user, fileId } = await connected();
    const res = await decide(user.id, fileId, HIGH_COST);
    expect(res.body.applicationState.status).toBe("adverse_action_pending");
    expect((await ledgerOf(fileId)).at(-1)).toEqual(["decided_decline", "engine_high_cost"]);

    const standing = await applicationStanding(prisma, fileId);
    const ecoa = standing!.clocks.find((c) => c.kind === "ECOA_ADVERSE_ACTION_30D");
    expect(ecoa).toBeDefined();
    // Opened tolled, because nothing in this repo can deliver the notice that
    // would satisfy it.
    expect(ecoa!.tolledFrom).not.toBeNull();
    expect(ecoa!.tolledUntil).toBeNull();
  });

  it("declines a conditionally approved file, and refuses to re-approve one", async () => {
    const { user, fileId } = await connected();
    await callAs(user.id, [fileRouter], "PATCH", `/${fileId}`, {
      loanAmount: 380_000,
      downPayment: 35_000,
    });
    expect((await decide(user.id, fileId, MARKET)).body.applicationState.status).toBe(
      "conditionally_approved",
    );

    // The machine has no edge back to an approval word, so the second run of
    // the same outcome writes nothing and says so.
    await decide(user.id, fileId, MARKET);
    expect(await statusOf(fileId)).toBe("conditionally_approved");
    expect(await eventCount(fileId, "decision_not_applied")).toBe(1);

    // A decline from there is an edge the machine does have.
    expect((await decide(user.id, fileId, HIGH_COST)).body.applicationState.status).toBe(
      "adverse_action_pending",
    );
  });

  it("changes nothing while the borrower still owes something", async () => {
    const { user, fileId, borrower } = await needingPayroll();
    await connectAs("variable_income", "payroll", fileId, borrower.partyId);
    expect(await statusOf(fileId)).toBe("awaiting_borrower");
    const before = await ledgerOf(fileId);

    // The engine can decide this one — but `underwriting_began` is not an edge
    // out of "needs you", and neither is the outcome. The decision is recorded
    // and the file stays where it is.
    await decide(user.id, fileId, MARKET);
    expect(await statusOf(fileId)).toBe("awaiting_borrower");
    expect(await ledgerOf(fileId)).toEqual(before);
    expect(await prisma.decision.count({ where: { loanFileId: fileId } })).toBe(1);
    expect(await eventCount(fileId, "decision_not_applied")).toBe(1);
  });

  it("treats two decisions racing as one repeat, not a conflict", async () => {
    // The bank screen and the review screen both ask for a decision, so two
    // callers reach `underwriting_began` at once. The loser used to be handed
    // a 409 telling a borrower to reload and decide again, for an event whose
    // whole effect had just happened.
    // Repeated, because a lost race is a race that sometimes runs cleanly.
    for (let round = 0; round < 3; round += 1) {
      const { user, fileId } = await connected();
      const results = await Promise.all([
        decide(user.id, fileId),
        decide(user.id, fileId),
        decide(user.id, fileId),
      ]);
      expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
      expect(await statusOf(fileId)).toBe("in_underwriting");
      expect(await ledgerOf(fileId)).toHaveLength(4);
    }
  }, 30_000);
});

/**
 * A client that lets somebody else move the file mid-write.
 *
 * `transition` reads the status and then updates it conditionally, and the
 * window between the two is where every conflict in this file is born. Two
 * racing requests hit it only sometimes; a hook on the one statement hits it
 * every time, which is what a test of the losing writer needs.
 */
function interruptedBy(tx: Db, interloper: () => Promise<void>): Db {
  let fired = false;
  const application = new Proxy(tx.application, {
    get(model, prop, receiver) {
      if (prop !== "updateMany") return Reflect.get(model, prop, receiver);
      return async (args: unknown) => {
        if (!fired) {
          fired = true;
          await interloper();
        }
        return (model.updateMany as (a: unknown) => unknown)(args);
      };
    },
  });
  return new Proxy(tx, {
    get: (target, prop, receiver) =>
      prop === "application" ? application : Reflect.get(target, prop, receiver),
  }) as Db;
}

describe("a sanctions hold", () => {
  /** A screening adapter that comes back with a name on it. */
  const nearMatch = {
    capabilities: connectors().screening.capabilities,
    screenSanctions: () =>
      Promise.resolve({
        provider: "test-screening",
        externalId: "near-match",
        retrievedAt: new Date().toISOString(),
        data: {
          clear: false,
          matches: [
            {
              listName: "OFAC SDN",
              matchedName: "Dana Whitfield",
              score: 0.91,
              programs: ["SDGT"],
            },
          ],
          listsChecked: ["OFAC SDN"],
          screenedAt: new Date().toISOString(),
        },
      }),
  };

  async function held() {
    const started = await throughScreenTwo();
    const file = (await loadLoanFile(started.fileId))!;
    const out = await screenAndRecord(prisma, file, { ...connectors(), screening: nearMatch });
    expect(out.held).toBe(true);
    expect(await statusOf(started.fileId)).toBe("suspended");
    return started;
  }

  it("is not what a clean screen leaves behind", async () => {
    // The route's own case, over HTTP, because nothing else proves the route
    // defers to the service at all: the snapshot, the column and the event are
    // written, and a list that came back empty writes no ledger row.
    const { user, fileId } = await throughScreenTwo();
    const before = await ledgerOf(fileId);

    const res = await callAs(user.id, [propertyFileRouter], "POST", `/${fileId}/screening`);
    expect(res.status).toBe(201);

    expect(
      (await prisma.loanFile.findUniqueOrThrow({ where: { id: fileId } })).sanctionsScreenClear,
    ).toBe(true);
    expect(
      await prisma.connectorSnapshot.count({ where: { loanFileId: fileId, kind: "sanctions" } }),
    ).toBe(1);
    expect(await eventCount(fileId, "screening_completed")).toBe(1);
    expect(await statusOf(fileId)).toBe("awaiting_borrower");
    expect(await ledgerOf(fileId)).toEqual(before);
  });

  it("suspends the file and says why", async () => {
    const { fileId } = await held();
    expect((await ledgerOf(fileId)).at(-1)).toEqual([
      "third_party_blocked",
      "sanctions_near_match",
    ]);
    const standing = await applicationStanding(prisma, fileId);
    expect(standing!.ledger.at(-1)!.actorKind).toBe("SERVICE");
    expect(
      (await prisma.loanFile.findUniqueOrThrow({ where: { id: fileId } })).sanctionsScreenClear,
    ).toBe(false);
  });

  it("is not lifted by connecting a bank", async () => {
    const { user, fileId } = await held();
    const before = await ledgerOf(fileId);
    expect((await callAs(user.id, [connectorRouter], "POST", `/${fileId}/bank`)).status).toBe(201);
    // The report is on the file — a hold is not a reason to lose evidence —
    // and the state has not moved.
    expect((await loadLoanFile(fileId))!.assets).not.toBeNull();
    expect(await statusOf(fileId)).toBe("suspended");
    expect(await ledgerOf(fileId)).toEqual(before);
  });

  it("is not lifted by a bank report that leaves something owed", async () => {
    // `borrower_owes` IS a legal edge out of `suspended` — a member of staff
    // can ask a held file's borrower for something. A bank login is not that
    // member of staff, and taking the edge here would move the pill off
    // "Waiting" and leave the near match invisible.
    const { fileId, borrower } = await held();
    const before = await ledgerOf(fileId);
    await connectAs("variable_income", "credit", fileId, borrower.partyId);
    await connectAs("variable_income", "bank", fileId, borrower.partyId);
    expect(borrowerObligations((await loadLoanFile(fileId))!).map((o) => o.branch)).toContain(
      "payroll",
    );
    expect(await statusOf(fileId)).toBe("suspended");
    expect(await ledgerOf(fileId)).toEqual(before);
  });

  it("is not lifted by a decision that arrives twice while the hold lands", async () => {
    // The sequential cases above all read the status, see `suspended` and stop.
    // This one reads `in_processing`, which is true when it reads it, and by
    // the time it writes, a second copy of the same request has taken
    // `underwriting_began` and a screening has come back with a name on it.
    // The file is now SUSPENDED — where `underwriting_began` is STILL a legal
    // edge, because a person may decide to underwrite a held file. Aiming the
    // repeat at wherever the file landed would take it on that person's
    // behalf, ending a sanctions hold with a page load and no
    // `third_party_returned` on the ledger. A repeat is only ever asked again
    // from the state its caller checked.
    const { user, fileId, applicationId } = await throughScreenTwo();
    expect((await callAs(user.id, [connectorRouter], "POST", `/${fileId}/bank`)).status).toBe(201);
    expect(await statusOf(fileId)).toBe("in_processing");

    const file = (await loadLoanFile(fileId))!;
    const decision = underwrite(file, { casefileId: randomUUID(), now: new Date().toISOString() });
    const before = await ledgerOf(fileId);

    const raced = prisma.$transaction(async (tx) => {
      const { decisionId } = await recordDecision(tx, fileId, decision);
      const interloper = async () => {
        await prisma.$transaction(async (other) => {
          const second = await recordDecision(other, fileId, decision);
          await decideApplication(other, {
            applicationId,
            loanFileId: fileId,
            decision,
            decisionId: second.decisionId,
            file,
          });
        });
        const screened = await screenAndRecord(prisma, file, {
          ...connectors(),
          screening: nearMatch,
        });
        expect(screened.held).toBe(true);
      };
      return decideApplication(interruptedBy(tx, interloper), {
        applicationId,
        loanFileId: fileId,
        decision,
        decisionId,
        file,
      });
    });

    await expect(raced).rejects.toThrow(/now suspended/);
    expect(await statusOf(fileId)).toBe("suspended");
    // The interloper's two rows, and nothing the loser wrote: its whole
    // transaction went back, decision row included.
    expect((await ledgerOf(fileId)).slice(before.length)).toEqual([
      ["underwriting_began", "engine_asked"],
      ["third_party_blocked", "sanctions_near_match"],
    ]);
    expect(await prisma.decision.count({ where: { loanFileId: fileId } })).toBe(1);
  });

  it("is refused by the mover itself, not only by whoever calls it", async () => {
    // Every caller checks the hold on its own read, and each of those reads
    // happens a moment before the write. A screening that commits in between
    // would leave the check true and the file suspended — and both of these
    // events are legal edges out of `suspended`, because a member of staff may
    // take them. So the refusal also lives in the one function that reads the
    // state immediately before writing it, where nothing can slip past it and
    // no new caller can forget it.
    const { fileId, applicationId } = await held();
    const before = await ledgerOf(fileId);
    const actorPrincipalId = await servicePrincipal(prisma, "application_flow");

    for (const event of ["underwriting_began", "borrower_owes"] as const) {
      expect(await advanceIfLegal({ applicationId, event, actorPrincipalId }), event).toEqual({
        skipped: "held",
        from: "suspended",
      });
    }
    expect(await ledgerOf(fileId)).toEqual(before);
    expect(await statusOf(fileId)).toBe("suspended");

    // A hold ends when a person ends it, and that event still goes through.
    const returned = await advanceIfLegal({
      applicationId,
      event: "third_party_returned",
      actorPrincipalId,
    });
    expect(moved(returned)).toBe(true);
    expect(await statusOf(fileId)).toBe("in_processing");
  });

  it("says in the file's own events that nothing moved", async () => {
    // The skip is the safe answer, and an answer nobody can see is how a held
    // file looks like a quiet one. All four settle functions write the same
    // line: the event that was refused, and the state it was refused from.
    const { user, fileId, applicationId } = await held();
    expect(await eventCount(fileId, "application_unchanged")).toBe(0);

    // Screen 1, revisited: the intake settle reads the status and stops.
    const patched = await callAs(user.id, [fileRouter], "PATCH", `/${fileId}`, {
      loanAmount: 330_000,
      downPayment: 85_000,
    });
    expect(patched.status).toBe(200);
    expect(await eventCount(fileId, "application_unchanged")).toBe(1);

    // And the reconciler, which the routes reach only through a settle that
    // has already stopped — so it is asked here directly.
    const file = (await loadLoanFile(fileId))!;
    const skipped = await prisma.$transaction((tx) =>
      reconcileObligations(tx, { applicationId, file, causedBy: "test:held" }),
    );
    expect(skipped).toEqual({ skipped: "held", from: "suspended" });
    expect(await eventCount(fileId, "application_unchanged")).toBe(2);
    expect(await statusOf(fileId)).toBe("suspended");
  });

  it("is not lifted by a document, a payroll connection, a signature or a decision", async () => {
    const { user, fileId, borrower, applicationId } = await held();
    const before = await ledgerOf(fileId);

    expect(
      (
        await callAs(user.id, [documentRouter], "POST", `/${fileId}/documents`, {
          satisfiesRequirementId: "CRD-008",
          filename: "explanation.pdf",
          contentType: "application/pdf",
          bytes: 512,
        })
      ).status,
    ).toBe(201);
    expect((await callAs(user.id, [connectorRouter], "POST", `/${fileId}/payroll`)).status).toBe(
      201,
    );
    await prisma.$transaction(async (tx) =>
      settleBorrowerAct(tx, {
        applicationId,
        loanFileId: fileId,
        partyId: borrower.partyId,
        reasonCode: "application_signed",
        causedBy: "event:application_signed",
      }),
    );
    expect(
      (await callAs(user.id, [decisionRouter], "POST", `/${fileId}/decision`, MARKET)).status,
    ).toBe(201);

    expect(await statusOf(fileId)).toBe("suspended");
    expect(await ledgerOf(fileId)).toEqual(before);
  });
});

describe("what every row says", () => {
  it("uses a reason the vocabulary knows, and an actor kind that fits its event", async () => {
    const { user, fileId, borrower } = await needingPayroll();
    await connectAs("variable_income", "payroll", fileId, borrower.partyId);
    await callAs(user.id, [documentRouter], "POST", `/${fileId}/documents`, {
      satisfiesRequirementId: "CRD-008",
      filename: "explanation.pdf",
      contentType: "application/pdf",
      bytes: 512,
    });
    await callAs(user.id, [decisionRouter], "POST", `/${fileId}/decision`, MARKET);

    const standing = await applicationStanding(prisma, fileId);
    expect(standing!.ledger.length).toBeGreaterThan(6);
    for (const row of standing!.ledger) {
      expect(TRANSITION_REASONS, `${row.event} seq ${row.seq}`).toContain(row.reasonCode);
      // The borrower is named only where the borrower acted. Everything the
      // machinery did — the receipt, an obligation, a decision — is a service.
      expect(row.actorKind, `${row.event} seq ${row.seq}`).toBe(
        BORROWER_REASONS.includes(row.reasonCode ?? "") ? "BORROWER" : "SERVICE",
      );
    }
  });

  it("agrees with the shared list about what is terminal", async () => {
    // The file list's resume rule and the review screen both trust this flag,
    // and both would go on offering a finished file if it were wrong. So the
    // application is actually ended here rather than asked about while it is
    // running: a live file says false, the withdrawn one says true, and the
    // machine agrees there is nothing left to do to it.
    const { fileId } = await throughScreenTwo();
    expect((await applicationStanding(prisma, fileId))!.terminal).toBe(false);

    const ended = await throughScreenTwo();
    await transition({
      applicationId: ended.applicationId,
      event: "borrower_withdrew",
      actorPrincipalId: await principalForParty(prisma, ended.borrower.partyId),
      reasonCode: "borrower_requested",
    });

    const standing = await applicationStanding(prisma, ended.fileId);
    expect(standing!.status).toBe("withdrawn");
    expect(standing!.terminal).toBe(true);
    expect(TERMINAL).toContain(standing!.status);
    expect(eventsFrom(standing!.status)).toEqual([]);
  });
});
