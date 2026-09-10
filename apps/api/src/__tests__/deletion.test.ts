/**
 * Deletion has to actually delete.
 *
 * The privacy page tells a person their data is removed "for good — there is
 * no archive and no undo." That sentence is a promise, and the thing that
 * makes it true is the cascade: every child of a loan file, and every loan
 * file of a user, has onDelete: Cascade. Identity is on the party, and
 * users.party_id cannot cascade upward, so the users_delete_takes_party
 * trigger removes the person — and only the real-database test at the bottom
 * can see it. The schema-text tests fail at review time; the database test
 * fails before a stranger has asked to be forgotten.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { TRID_PARTY_PREDICATES } from "@hm/shared";
import { pinFact, proposeScenario } from "../services/evidence.js";
import { moveLoan } from "../services/loan-transition.js";
import { createOriginatedLoan } from "../services/loans.js";
import {
  liveFact,
  liveGrant,
  partyForUser,
  principalForParty,
  servicePrincipal,
  staffPrincipal,
  type BorrowerInput,
} from "../services/party.js";
import { assertFileMayBeDeleted } from "../services/repository.js";
import { transition } from "../services/transition.js";
import { fileRouter } from "../routes/files.js";
import {
  consent,
  createLoanFile,
  createParty,
  createUser,
  importedLoan,
  saveBorrower,
} from "./support/factories.js";
import { callAs } from "./support/http.js";

const DAY = 24 * 60 * 60 * 1000;

const schema = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../packages/db/prisma/schema.prisma"),
  "utf8",
);

const dana: BorrowerInput = {
  firstName: "Dana",
  lastName: "Whitfield",
  email: "dana@example.test",
  phone: "5555550100",
  dateOfBirth: "1988-04-12",
  ssnVaultHandle: "vault:dana:1",
  currentAddress: { line1: "1 Fixture St", city: "Demo City", state: "CA", postalCode: "94000" },
  maritalStatus: "unmarried",
  citizenship: "us_citizen",
  preferredLanguage: "en",
  firstTimeHomebuyer: true,
  isMilitary: false,
  currentHousing: "rent",
  monthlyRent: 2150,
  statedMonthlyIncome: 8500,
};

describe("deletion cascades", () => {
  it("removes every child of a loan file", () => {
    const relations = [...schema.matchAll(/^\s*loanFile\s+LoanFile.*$/gm)].map((m) => m[0]);
    // If this drops to zero the regex has rotted, not the schema.
    expect(relations.length).toBeGreaterThan(8);
    const notCascading = relations.filter((r) => !r.includes("onDelete: Cascade"));
    expect(notCascading).toEqual([]);
  });

  it("removes every loan file of a deleted user", () => {
    const relation = /user\s+User\?\s+@relation\([^)]*\)/.exec(schema)?.[0] ?? "";
    expect(relation).toContain("onDelete: Cascade");
  });

  it("takes the application with the file it was born from", () => {
    // The application is the only child of a loan file that arrived after the
    // privacy page's promise was written, and it carries the ledger, the
    // scenarios (which hold the property address and the terms), the pins and
    // the clocks. Named on its own so a future edit to the relation cannot
    // quietly turn "for good" into "except for the credit request".
    const application = schema.slice(schema.indexOf("model Application "));
    expect(application.slice(0, application.indexOf("@@map"))).toMatch(
      /loanFile\s+LoanFile\s+@relation\([^)]*onDelete: Cascade/,
    );
  });

  it("never lets the ledger's actor be nulled to satisfy a foreign key", () => {
    // The tempting fix for the RESTRICT on a transition's actor is SET NULL.
    // It cannot work — the referential action is an UPDATE and the ledger
    // refuses every UPDATE — and it would make "a transition names its actor"
    // false. The application goes before the party instead.
    const relation =
      /actor\s+Principal @relation\("TransitionActor"[^)]*\)/.exec(schema)?.[0] ?? "";
    expect(relation).not.toBe("");
    expect(relation).not.toContain("onDelete: SetNull");
  });

  it("ties borrower rows to the file, and every record about a person to the party", () => {
    const borrower = schema.slice(schema.indexOf("model Borrower"));
    expect(borrower.slice(0, borrower.indexOf("@@map"))).toMatch(
      /loanFile\s+LoanFile\s+@relation\([^)]*onDelete: Cascade/,
    );
    for (const model of [
      "model Fact ",
      "model Principal ",
      "model Authorization ",
      "model ApplicationParty ",
      "model LoanParty ",
    ]) {
      const block = schema.slice(schema.indexOf(model));
      expect(block.slice(0, block.indexOf("@@map"))).toMatch(
        /party\s+Party\??\s+@relation\([^)]*onDelete: Cascade/,
      );
    }
  });

  it("keeps a mortgage from being a child of a file", () => {
    // The first regex in this file requires every `loanFile LoanFile` relation
    // to cascade, which is what makes "for good" true of everything a person
    // typed. A Loan that declared one would be FORCED by that rule into being
    // deleted with a file — and a mortgage somebody is paying is not a child
    // of the form they filled in. It hangs off the application instead, on SET
    // NULL, and off the parties, which is what the orphan sweep reads.
    const loan = schema.slice(schema.indexOf("model Loan "));
    const block = loan.slice(0, loan.indexOf("@@map"));
    expect(block).not.toMatch(/loanFile\s+LoanFile/);
    expect(block).toMatch(
      /originatingApplication\s+Application\?\s+@relation\([^)]*onDelete: SetNull/,
    );
  });
});

describe("deleting the account deletes the person", () => {
  it("leaves no party, no fact, no principal and no authorization behind", async () => {
    const me = await createUser();
    const file = await createLoanFile({ userId: me.id });
    const row = await saveBorrower(file.id, dana);
    await prisma.consent.create({
      data: {
        loanFileId: file.id,
        borrowerId: row.id,
        kind: "verification_authorization",
        grantedAt: new Date(),
        ipAddress: "203.0.113.9",
        userAgent: "t",
      },
    });
    await prisma.user.delete({ where: { id: me.id } });
    expect(await prisma.party.count({ where: { id: row.partyId } })).toBe(0);
    expect(await prisma.fact.count({ where: { partyId: row.partyId } })).toBe(0);
    expect(await prisma.principal.count({ where: { partyId: row.partyId } })).toBe(0);
    expect(await prisma.authorization.count({ where: { partyId: row.partyId } })).toBe(0);
  });
});

/**
 * A file that has become an application, with a ledger row the borrower caused.
 *
 * That row is the shape the deletion chain used to break on: its actor is the
 * party's own BORROWER principal and the foreign key is RESTRICT, so if the
 * application outlived the file, deleting the account would fail on it — and
 * the borrower's sign-in would survive with it.
 *
 * `ending` picks which terminal-ish shape the file is left in: the borrower's
 * own withdrawal, or a decline, which is the one that opens the 30-day
 * adverse-action clock.
 */
async function personWithAnApplication(ending: "withdrawn" | "declined" = "withdrawn") {
  const me = await createUser();
  const file = await createLoanFile({ userId: me.id });
  const row = await saveBorrower(file.id, dana);
  await consent(file.id, row.id, "verification_authorization");
  const app = await prisma.application.create({
    data: { loanFileId: file.id, ausCasefileId: randomUUID() },
    select: { id: true },
  });
  await prisma.applicationParty.create({
    data: { applicationId: app.id, partyId: row.partyId, role: "PRIMARY_BORROWER" },
  });
  await proposeScenario(app.id, {
    objective: "PURCHASE",
    occupancy: "PRIMARY_RESIDENCE",
    loanAmountCents: 41_600_000n,
    termMonths: 360,
    propertyAddress: "42 Oak Street, Demo City CA 94000",
    valueEstimateCents: 52_000_000n,
  });
  const grant = await liveGrant(prisma, row.partyId, "FCRA_WRITTEN_INSTRUCTION");
  for (const predicate of TRID_PARTY_PREDICATES) {
    const fact = await liveFact(prisma, row.partyId, predicate);
    await pinFact({ applicationId: app.id, factId: fact!.id, authorizationId: grant!.id });
  }
  // The receipt has fired by now: intake_received, a ledger row by the
  // trid_receipt service, and a tolled Loan Estimate clock.
  const principalId = await principalForParty(prisma, row.partyId);
  if (ending === "withdrawn") {
    await transition({
      applicationId: app.id,
      event: "borrower_withdrew",
      actorPrincipalId: principalId,
      reasonCode: "borrower_requested",
    });
  } else {
    const ops = await prisma.principal.create({
      data: { kind: "STAFF", subject: `ops-${app.id}` },
      select: { id: true },
    });
    for (const event of ["underwriting_began", "decided_decline"] as const) {
      await transition({ applicationId: app.id, event, actorPrincipalId: ops.id });
    }
  }
  return { me, file, app, partyId: row.partyId, principalId };
}

async function whatIsLeft(applicationId: string, partyId: string) {
  return {
    applications: await prisma.application.count({ where: { id: applicationId } }),
    transitions: await prisma.applicationTransition.count({ where: { applicationId } }),
    clocks: await prisma.regulatoryClock.count({ where: { applicationId } }),
    pins: await prisma.applicationEvidenceLink.count({ where: { applicationId } }),
    scenarios: await prisma.loanScenario.count({ where: { applicationId } }),
    parties: await prisma.party.count({ where: { id: partyId } }),
    principals: await prisma.principal.count({ where: { partyId } }),
    facts: await prisma.fact.count({ where: { partyId } }),
    authorizations: await prisma.authorization.count({ where: { partyId } }),
  };
}

const NOTHING = {
  applications: 0,
  transitions: 0,
  clocks: 0,
  pins: 0,
  scenarios: 0,
  parties: 0,
  principals: 0,
  facts: 0,
  authorizations: 0,
};

describe("deleting the account takes the credit request too", () => {
  it("leaves no application, no ledger and no clock behind", async () => {
    const { me, app, partyId } = await personWithAnApplication();
    // Everything is there before, so a green test cannot be an empty one.
    expect(await whatIsLeft(app.id, partyId)).toEqual({
      applications: 1,
      transitions: 2,
      clocks: 1,
      pins: 3,
      scenarios: 1,
      parties: 1,
      principals: 1,
      facts: expect.any(Number) as number,
      authorizations: 1,
    });

    await prisma.user.delete({ where: { id: me.id } });
    expect(await whatIsLeft(app.id, partyId)).toEqual(NOTHING);
    // The services that acted are not the person's data and stay.
    expect(
      await prisma.principal.count({ where: { kind: "SERVICE", subject: "trid_receipt" } }),
    ).toBe(1);
  });

  it("leaves nothing behind through the route's own order either", async () => {
    // DELETE /api/auth/me declares the order rather than inheriting it: files
    // first, then the user, then the party. The route has to be true on its
    // own, not only because a trigger happens to fire first.
    const { me, app, partyId } = await personWithAnApplication();
    await prisma.$transaction(async (tx) => {
      await tx.loanFile.deleteMany({ where: { userId: me.id } });
      await tx.user.delete({ where: { id: me.id } });
      await tx.party.deleteMany({ where: { id: partyId } });
    });
    expect(await whatIsLeft(app.id, partyId)).toEqual(NOTHING);
    expect(await prisma.user.count({ where: { id: me.id } })).toBe(0);
  });
});

/**
 * The same person, now with a mortgage they claimed.
 *
 * The move runs under the `claim_flow` SERVICE principal and not under the
 * person's own, which is the rule the loan ledger keeps and an application's
 * does not need: a loan is meant to outlive its parties, so a RESTRICT edge
 * from a surviving ledger row to a principal this deletion is about to cascade
 * away would be an account that cannot be deleted at all.
 */
async function personWithAMortgage() {
  const person = await personWithAnApplication();
  const loan = await importedLoan([{ partyId: person.partyId }]);
  await moveLoan({
    id: loan.id,
    event: "borrower_claimed",
    actorPrincipalId: await servicePrincipal(prisma, "claim_flow"),
    reasonCode: "claim_confirmed",
  });
  return { ...person, loanId: loan.id };
}

async function whatIsLeftOfTheLoan(loanId: string) {
  return {
    loans: await prisma.loan.count({ where: { id: loanId } }),
    loanParties: await prisma.loanParty.count({ where: { loanId } }),
    loanTransitions: await prisma.loanTransition.count({ where: { loanId } }),
  };
}

describe("deleting the account takes the mortgage nobody else is on", () => {
  it("leaves no loan, no link and no loan ledger behind", async () => {
    const { me, loanId } = await personWithAMortgage();
    expect(await whatIsLeftOfTheLoan(loanId)).toEqual({
      loans: 1,
      loanParties: 1,
      loanTransitions: 1,
    });

    await prisma.user.delete({ where: { id: me.id } });

    // The link goes with the party, because a person's link to a mortgage is
    // personal data. The loan goes because the link that went was the last
    // one: a mortgage with nobody left on it is not a record about anybody.
    expect(await whatIsLeftOfTheLoan(loanId)).toEqual({
      loans: 0,
      loanParties: 0,
      loanTransitions: 0,
    });
    // The service that made the move is not the person's data and stays.
    expect(
      await prisma.principal.count({ where: { kind: "SERVICE", subject: "claim_flow" } }),
    ).toBe(1);
  });

  it("takes a mortgage we funded, and the application it was born from, in one act", async () => {
    // The hardest shape, because two rules meet on it. Deleting the account
    // removes the file, which takes the application, which sets the loan's
    // `originatingApplicationId` to null — and THEN the sweep removes the loan
    // itself as an orphan. The deferred ledger check was queued by that null
    // and runs at COMMIT against a loan that is no longer there; a check that
    // insisted on finding the ledger row would refuse the whole deletion and
    // tell the person their mortgage has an unexplained move.
    const me = await createUser();
    const file = await createLoanFile({ userId: me.id });
    const row = await saveBorrower(file.id, dana);
    const app = await prisma.application.create({
      data: { loanFileId: file.id, ausCasefileId: randomUUID() },
      select: { id: true },
    });
    const { loanId } = await createOriginatedLoan(prisma, {
      applicationId: app.id,
      terms: {
        rateType: "FIXED",
        noteRateBps: 625,
        termMonths: 360,
        originalPrincipalCents: 41_600_000n,
      },
      property: { line1: "42 Oak Street", city: "Demo City", state: "CA", postalCode: "94000" },
      // We know our own, and the database refuses a loan of ours that does not
      // say all four.
      axes: {
        objective: "PURCHASE",
        program: "CONVENTIONAL",
        lienPosition: "FIRST",
        occupancy: "PRIMARY_RESIDENCE",
      },
      parties: [{ partyId: row.partyId, role: "PRIMARY_BORROWER" }],
    });
    await moveLoan({
      id: loanId,
      event: "boarding_file_sent",
      actorPrincipalId: await staffPrincipal(prisma, `ops-${loanId}`),
    });

    await prisma.user.delete({ where: { id: me.id } });

    expect(await whatIsLeftOfTheLoan(loanId)).toEqual({
      loans: 0,
      loanParties: 0,
      loanTransitions: 0,
    });
    expect(await prisma.application.count({ where: { id: app.id } })).toBe(0);
    expect(await prisma.user.count({ where: { id: me.id } })).toBe(0);
  });

  it("leaves nothing behind through the route's own order either", async () => {
    const { me, partyId, loanId } = await personWithAMortgage();
    await prisma.$transaction(async (tx) => {
      await tx.loanFile.deleteMany({ where: { userId: me.id } });
      await tx.user.delete({ where: { id: me.id } });
      await tx.party.deleteMany({ where: { id: partyId } });
    });
    expect(await whatIsLeftOfTheLoan(loanId)).toEqual({
      loans: 0,
      loanParties: 0,
      loanTransitions: 0,
    });
  });

  it("keeps a mortgage somebody else is still on", async () => {
    // The reason the sweep is orphan-only rather than "every loan this party
    // touched". A two-party mortgage survives one borrower closing their
    // account — the other borrower is still paying it — and the ledger row
    // explaining how it got there survives with it, still naming a principal
    // no deletion can reach.
    const { me, partyId, loanId } = await personWithAMortgage();
    const other = await createUser();
    const theirs = await partyForUser(prisma, other.id);
    await prisma.loanParty.create({
      data: { loanId, partyId: theirs, role: "CO_BORROWER" },
    });

    await prisma.user.delete({ where: { id: me.id } });

    expect(await whatIsLeftOfTheLoan(loanId)).toEqual({
      loans: 1,
      loanParties: 1,
      loanTransitions: 1,
    });
    expect(await prisma.loanParty.count({ where: { loanId, partyId } })).toBe(0);
    expect(await prisma.loanParty.count({ where: { loanId, partyId: theirs } })).toBe(1);
  });

  it("takes both loans of a refinance chain, and the pointer between them", async () => {
    // The shape the two rules meet on. `refinanced_by_loan_id` is ON DELETE
    // SET NULL, so erasing the successor rewrites the predecessor — an UPDATE
    // fired from inside this trigger's own DELETE, on a terminal row that
    // cannot be moved out of the way first. While that rule lived in a CHECK
    // on the row, this deletion aborted and nothing could unstick it.
    const { me, partyId, loanId } = await personWithAMortgage();
    const successor = await importedLoan([{ partyId }]);
    await prisma.loan.update({
      where: { id: loanId },
      data: { refinancedByLoanId: successor.id },
    });
    await moveLoan({
      id: loanId,
      event: "refinanced_by_us",
      actorPrincipalId: await servicePrincipal(prisma, "retention"),
    });

    await prisma.user.delete({ where: { id: me.id } });

    expect(await whatIsLeftOfTheLoan(loanId)).toEqual({
      loans: 0,
      loanParties: 0,
      loanTransitions: 0,
    });
    expect(await prisma.loan.count({ where: { id: successor.id } })).toBe(0);
  });

  it("erases a successor somebody left and leaves the predecessor they share", async () => {
    // The same collision with only one of the two loans orphaned, which is the
    // case a sweep cannot dodge by deleting both rows in one statement: the
    // predecessor SURVIVES, because a co-borrower is still on it, and the
    // pointer in it has to be allowed to go null while it does.
    const { me, partyId, loanId } = await personWithAMortgage();
    const other = await createUser();
    const theirs = await partyForUser(prisma, other.id);
    await prisma.loanParty.create({ data: { loanId, partyId: theirs, role: "CO_BORROWER" } });
    const successor = await importedLoan([{ partyId }]);
    await prisma.loan.update({
      where: { id: loanId },
      data: { refinancedByLoanId: successor.id },
    });
    await moveLoan({
      id: loanId,
      event: "refinanced_by_us",
      actorPrincipalId: await servicePrincipal(prisma, "retention"),
    });

    await prisma.user.delete({ where: { id: me.id } });

    expect(await prisma.loan.count({ where: { id: successor.id } })).toBe(0);
    const kept = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } });
    expect(kept.status).toBe("REFINANCED_INTERNALLY");
    expect(kept.refinancedByLoanId).toBeNull();
  });

  it("touches no mortgage this person was never on", async () => {
    // The sweep is scoped to the loans this deletion just touched. An
    // unscoped anti-join would delete any parentless loan in the database — a
    // half-finished import retry, a boarding script that commits its loan
    // before its parties — on an unrelated person's deletion path, and take
    // the ledger explaining it along.
    const { me, loanId } = await personWithAMortgage();
    // Written raw, because the constructor refuses to make this shape: a loan
    // with nobody on it comes from a write that stopped halfway, never from a
    // caller that asked for one. This is that write, stopped halfway.
    const halfFinished = await prisma.loan.create({
      data: {
        status: "IMPORTED_UNCLAIMED",
        source: "PARTNER_IMPORT",
        rateType: "FIXED",
        noteRateBps: 625,
        termMonths: 360,
        originalPrincipalCents: 41_600_000n,
      },
      select: { id: true },
    });
    expect(await prisma.loanParty.count({ where: { loanId: halfFinished.id } })).toBe(0);

    await prisma.user.delete({ where: { id: me.id } });

    expect(await prisma.loan.count({ where: { id: loanId } })).toBe(0);
    expect(await prisma.loan.count({ where: { id: halfFinished.id } })).toBe(1);
  });
});

describe("a party folded into another goes with it", () => {
  it("leaves neither party, and neither party's principals, behind", async () => {
    // A claim folds the provisional party a partner sent us into the party of
    // the person who signed in and proved who they were. Until now only the
    // survivor was deleted, so the folded-in row and everything asserted
    // against it outlived the account that absorbed it — reachable by no
    // deletion path in the product, which is not what "there is no archive"
    // says.
    const me = await createUser();
    const survivor = await partyForUser(prisma, me.id);
    const mine = await principalForParty(prisma, survivor);
    const folded = await createParty({ sourceFirstSeen: "grander_import" });
    const theirs = await prisma.principal.create({
      data: { kind: "BORROWER", subject: `party:${folded.id}`, partyId: folded.id },
      select: { id: true },
    });
    await prisma.party.update({
      where: { id: folded.id },
      data: { mergedIntoPartyId: survivor },
    });

    await prisma.user.delete({ where: { id: me.id } });

    expect(await prisma.party.count({ where: { id: { in: [survivor, folded.id] } } })).toBe(0);
    expect(await prisma.principal.count({ where: { id: { in: [mine, theirs.id] } } })).toBe(0);
  });

  it("takes what the folded-in party's own principal asserted about a property", async () => {
    // The half a cascade cannot reach. A fact ABOUT a party goes with the
    // party through facts.party_id; a fact about a PROPERTY has no party_id at
    // all, and the only edge holding it is asserted_by_principal_id, which is
    // RESTRICT. The folded-in party's principals cascade away with their
    // party, so the sweep has to name the facts they asserted — for the
    // folded-in parties exactly as it does for the survivor, or the trigger's
    // own next statement walks into the restrict and the account cannot be
    // deleted by any path at all.
    const me = await createUser();
    const survivor = await partyForUser(prisma, me.id);
    const folded = await createParty({ sourceFirstSeen: "grander_import" });
    const theirs = await prisma.principal.create({
      data: { kind: "BORROWER", subject: `party:${folded.id}`, partyId: folded.id },
      select: { id: true },
    });
    const aboutAHouse = await prisma.fact.create({
      data: {
        subjectType: "PROPERTY",
        subjectId: randomUUID(),
        predicate: "assessed_value",
        value: { amount: 412_000 },
        sourceKind: "PARTNER_SHARED",
        confidence: "UNVERIFIED",
        assertedByPrincipalId: theirs.id,
        observedAt: new Date(),
      },
      select: { id: true },
    });
    await prisma.party.update({
      where: { id: folded.id },
      data: { mergedIntoPartyId: survivor },
    });

    await prisma.user.delete({ where: { id: me.id } });

    expect(await prisma.fact.count({ where: { id: aboutAHouse.id } })).toBe(0);
    expect(await prisma.principal.count({ where: { id: theirs.id } })).toBe(0);
    expect(await prisma.party.count({ where: { id: { in: [survivor, folded.id] } } })).toBe(0);
  });

  it("takes the folded-in party's link to a mortgage with it", async () => {
    // The half the merge makes possible: a mortgage the partner attached to
    // the provisional party, which the person then claimed. The link is keyed
    // on the folded-in party, so a sweep that read only the survivor's links
    // would leave the loan standing with a party nobody can sign in as.
    const me = await createUser();
    const survivor = await partyForUser(prisma, me.id);
    const folded = await createParty({ sourceFirstSeen: "grander_import" });
    const loan = await importedLoan([{ partyId: folded.id }]);
    await prisma.party.update({
      where: { id: folded.id },
      data: { mergedIntoPartyId: survivor },
    });

    await prisma.user.delete({ where: { id: me.id } });

    expect(await whatIsLeftOfTheLoan(loan.id)).toEqual({
      loans: 0,
      loanParties: 0,
      loanTransitions: 0,
    });
  });
});

describe("deleting the account takes a revoked grant with it", () => {
  it("leaves nothing behind when a principal revoked its own party's authorization", async () => {
    // A revoked grant names the principal that revoked it, and that column is
    // SET NULL — so the tempting reading is that a lapsed-and-renewed consent
    // holds the borrower's own principal in place, and nulling the column on
    // the way out breaks the CHECK that says a revocation records who and why.
    // It does not, because the grant goes with the party in the same delete
    // the principal does, and there is no row left to update. Held here so
    // that stays a property of the schema rather than a lucky ordering.
    const me = await createUser();
    const file = await createLoanFile({ userId: me.id });
    const row = await saveBorrower(file.id, dana);
    const principalId = await principalForParty(prisma, row.partyId);
    const lapsed = await prisma.authorization.create({
      data: {
        partyId: row.partyId,
        purpose: "FCRA_WRITTEN_INSTRUCTION",
        dataCategories: ["CREDIT_REPORT"],
        grantedAt: new Date(Date.now() - 200 * DAY),
        expiresAt: new Date(Date.now() - 80 * DAY),
      },
      select: { id: true },
    });
    await prisma.authorization.update({
      where: { id: lapsed.id },
      data: {
        revokedAt: new Date(Date.now() - 80 * DAY),
        revokedByPrincipalId: principalId,
        revocationReason: "lapsed; renewed by a new consent",
      },
    });
    await consent(file.id, row.id, "verification_authorization");
    expect(await prisma.authorization.count({ where: { partyId: row.partyId } })).toBe(2);

    await prisma.user.delete({ where: { id: me.id } });
    expect(await prisma.authorization.count({ where: { partyId: row.partyId } })).toBe(0);
    expect(await prisma.principal.count({ where: { partyId: row.partyId } })).toBe(0);
    expect(await prisma.party.count({ where: { id: row.partyId } })).toBe(0);
  });
});

describe("deleting one file is not how a credit request goes away", () => {
  it("still takes a draft application with the file, and leaves the person", async () => {
    // A draft is typing. Nothing has been received, no clock is running, and
    // the cascade is what keeps "for good" true for the scenario and the pins
    // as well as for the answers — so this path is unchanged.
    const me = await createUser();
    const file = await createLoanFile({ userId: me.id });
    const app = await prisma.application.create({
      data: { loanFileId: file.id, ausCasefileId: randomUUID() },
      select: { id: true, status: true },
    });
    expect(app.status).toBe("DRAFT");

    await assertFileMayBeDeleted(file.id);
    await prisma.loanFile.delete({ where: { id: file.id } });
    expect(await prisma.application.count({ where: { id: app.id } })).toBe(0);
    // Deleting one file is not deleting the account.
    expect(await prisma.user.count({ where: { id: me.id } })).toBe(1);
  });

  it("refuses once the application has left draft, and the record stays whole", async () => {
    // The cascade reaches the ledger and the clocks, which is right for
    // account deletion and wrong for a person tidying one row away: a declined
    // file would take the 30 days an adverse-action notice is owed in with it.
    // Account deletion is the way out, and it removes everything.
    const { file, app } = await personWithAnApplication("declined");
    await expect(assertFileMayBeDeleted(file.id)).rejects.toMatchObject({
      statusCode: 409,
      code: "APPLICATION_ON_RECORD",
    });

    const clocks = await prisma.regulatoryClock.findMany({ where: { applicationId: app.id } });
    expect(clocks.map((c) => c.kind).sort()).toEqual([
      "ECOA_ADVERSE_ACTION_30D",
      "TRID_LE_DELIVERY",
    ]);
    expect(await prisma.applicationTransition.count({ where: { applicationId: app.id } })).toBe(3);
    expect(await prisma.loanFile.count({ where: { id: file.id } })).toBe(1);
  });

  /*
   * The same three answers, over HTTP.
   *
   * `assertFileMayBeDeleted` was only ever called directly, so nothing proved
   * the ROUTE calls it — or that it calls it after `assertFileAccess`. Dropping
   * either line left every test above green while a borrower erased a decided
   * application, or learned from a 409 that somebody else's file id exists.
   */
  it("answers a stranger's delete with 404, before it looks at the application", async () => {
    const { file } = await personWithAnApplication("declined");
    const stranger = await createUser();
    const res = await callAs(stranger.id, [fileRouter], "DELETE", `/${file.id}`);
    // 404, not the 409 the owner gets: a refusal that names the reason would
    // confirm the id exists to anyone holding a session.
    expect(res.status).toBe(404);
    expect(await prisma.loanFile.count({ where: { id: file.id } })).toBe(1);
  });

  it("deletes a draft through the route", async () => {
    const me = await createUser();
    const file = await createLoanFile({ userId: me.id });
    await prisma.application.create({
      data: { loanFileId: file.id, ausCasefileId: randomUUID() },
    });

    const res = await callAs(me.id, [fileRouter], "DELETE", `/${file.id}`);
    expect(res.status).toBe(204);
    expect(await prisma.loanFile.count({ where: { id: file.id } })).toBe(0);
    expect(await prisma.application.count({ where: { loanFileId: file.id } })).toBe(0);
  });

  it("refuses a decided one through the route, and everything stays standing", async () => {
    const { me, file, app } = await personWithAnApplication("declined");

    const res = await callAs<{ error: { code: string } }>(
      me.id,
      [fileRouter],
      "DELETE",
      `/${file.id}`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("APPLICATION_ON_RECORD");
    expect(await prisma.loanFile.count({ where: { id: file.id } })).toBe(1);
    expect(await prisma.application.count({ where: { id: app.id } })).toBe(1);
    expect(await prisma.applicationTransition.count({ where: { applicationId: app.id } })).toBe(3);
    expect(await prisma.regulatoryClock.count({ where: { applicationId: app.id } })).toBe(2);
  });

  it("refuses a withdrawn one too — an ending is still a record", async () => {
    // Withdrawn is the borrower's own word and it is tempting to read as
    // "never mind, forget it". The ledger says a credit request was made and
    // who ended it, and that is not undone by removing the file it lived on.
    const { file, app } = await personWithAnApplication();
    await expect(assertFileMayBeDeleted(file.id)).rejects.toMatchObject({
      statusCode: 409,
      code: "APPLICATION_ON_RECORD",
    });
    expect(await prisma.applicationTransition.count({ where: { applicationId: app.id } })).toBe(2);
  });
});
