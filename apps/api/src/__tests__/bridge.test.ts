/**
 * The person and the application record, kept in agreement.
 *
 * Screen 2 writes facts on the party and a per-application row in one
 * transaction; a consent is mirrored to an authorization by trigger; the
 * minter reads the authorization. Every assertion here is about those
 * agreeing, against a real database — nothing here can be proven by a mock.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { AuthorizationError } from "@hm/connectors";
import { evaluateSatisfaction, getRequirement } from "@hm/requirements";
import { SHADOW_ENGINE_VERSION } from "@hm/underwriting";
import { primaryBorrower, tokenFor } from "../services/authorization.js";
import {
  liveFact as liveFactOn,
  partyForUser,
  recordBorrowerFacts,
  servicePrincipal,
  staffPrincipal,
  type BorrowerInput,
} from "../services/party.js";
import { loadLoanFile } from "../services/repository.js";
import { applicationRouter } from "../routes/application.js";
import { connectorRouter } from "../routes/connectors.js";
import { esignRouter } from "../routes/esign.js";
import { consent, createLoanFile, createUser, saveBorrower } from "./support/factories.js";
import { callAs } from "./support/http.js";

const DAY = 24 * 60 * 60 * 1000;

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

const liveFact = (partyId: string, predicate: string) => liveFactOn(prisma, partyId, predicate);

describe("screen 2 writes the person", () => {
  it("creates a party behind the user and the row names it", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(u.partyId).toBe(row.partyId);
    const party = await prisma.party.findUniqueOrThrow({ where: { id: row.partyId } });
    expect(party.claimStatus).toBe("CLAIMED");
  });

  it("asserts every identity field as a fact, by the party's own principal", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);
    expect((await liveFact(row.partyId, "legal_name"))?.value).toEqual({
      first: "Dana",
      last: "Whitfield",
    });
    expect((await liveFact(row.partyId, "ssn_token"))?.value).toBe("vault:dana:1");
    expect((await liveFact(row.partyId, "monthly_income"))?.value).toBe(8500);
    const facts = await prisma.fact.findMany({
      where: { partyId: row.partyId },
      include: { assertedBy: true },
    });
    expect(facts.length).toBeGreaterThanOrEqual(13);
    expect(
      facts.every((f) => f.assertedBy.kind === "BORROWER" && f.assertedBy.partyId === row.partyId),
    ).toBe(true);
  });

  it("supersedes rather than duplicating when screen 2 is saved again", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const first = await saveBorrower(file.id, dana);
    await saveBorrower(file.id, { ...dana, statedMonthlyIncome: 9100 }, first.id);
    const live = await prisma.fact.findMany({
      where: { partyId: first.partyId, predicate: "monthly_income", supersededById: null },
    });
    expect(live).toHaveLength(1);
    expect(live[0]?.value).toBe(9100);
    expect(
      await prisma.fact.count({ where: { partyId: first.partyId, predicate: "monthly_income" } }),
    ).toBe(2);
  });

  it("reuses the same party for a second file by the same user", async () => {
    const user = await createUser();
    const a = await createLoanFile({ userId: user.id });
    const b = await createLoanFile({ userId: user.id });
    expect((await saveBorrower(b.id, dana)).partyId).toBe((await saveBorrower(a.id, dana)).partyId);
  });

  it("refuses a file with no owner rather than inventing a person for it", async () => {
    // The old demo seed wrote files nobody owned, and this minted a fresh
    // party for each save on one — so the same sample borrower became a new
    // person every time somebody corrected a typo on their screen 2. Sample
    // borrowers are real users now, with one party each, and an ownerless file
    // is a shape nothing creates.
    const file = await createLoanFile({ userId: null, isDemo: true });
    await expect(saveBorrower(file.id, dana)).rejects.toMatchObject({
      statusCode: 409,
      code: "NO_OWNER",
    });
    expect(await prisma.party.count()).toBe(0);
  });

  it("records the person and the row together or not at all", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    await expect(
      prisma.$transaction(async (tx) => {
        await recordBorrowerFacts(tx, { loanFileId: file.id, existingPartyId: null, input: dana });
        throw new Error("simulated failure after the facts, before the row");
      }),
    ).rejects.toThrow(/simulated/);
    expect(await prisma.borrower.count({ where: { loanFileId: file.id } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).partyId).toBeNull();
  });

  it("cannot write a row without a party", async () => {
    // The column is NOT NULL: a borrower row is a record ABOUT a person, and
    // there is no such thing as one about nobody.
    const file = await createLoanFile({ userId: null, isDemo: true });
    await expect(
      prisma.$executeRaw`INSERT INTO "borrowers" ("id","loan_file_id","ssn_last4","updated_at") VALUES (gen_random_uuid(), ${file.id}::uuid, '0000', now())`,
    ).rejects.toThrow(/null value in column "party_id"/);
  });
});

describe("a consent mirrors to an authorization", () => {
  async function signedFile() {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);
    const c = await consent(file.id, row.id, "verification_authorization");
    return { user, file, row, consent: c };
  }

  it("writes the grant the consent means, on the party, expiring in 120 days", async () => {
    const { row, consent: c } = await signedFile();
    const auth = await prisma.authorization.findFirstOrThrow({ where: { partyId: row.partyId } });
    expect(auth.purpose).toBe("FCRA_WRITTEN_INSTRUCTION");
    expect(auth.dataCategories).toEqual(
      expect.arrayContaining(["CREDIT_REPORT", "BANK_TRANSACTIONS", "PAYROLL_INCOME"]),
    );
    expect(auth.signatureEnvelopeId).toBe("env-verification_authorization");
    expect(auth.expiresAt.getTime() - c.grantedAt.getTime()).toBe(120 * DAY);
  });

  it("does not mirror a consent that permits no retrieval", async () => {
    const { file, row } = await signedFile();
    await consent(file.id, row.id, "econsent");
    const auths = await prisma.authorization.findMany({ where: { partyId: row.partyId } });
    expect(auths.map((a) => a.purpose)).toEqual(["FCRA_WRITTEN_INSTRUCTION"]);
  });

  it("revokes the mirror when the consent is revoked", async () => {
    const { row, consent: c } = await signedFile();
    await prisma.consent.update({ where: { id: c.id }, data: { revokedAt: new Date() } });
    const auth = await prisma.authorization.findFirstOrThrow({ where: { partyId: row.partyId } });
    expect(auth.revokedAt).not.toBeNull();
    expect(auth.revocationReason).toBe("consent revoked");
  });

  it("a new consent retires a lapsed grant and mints again", async () => {
    const user = await createUser();
    const a = await createLoanFile({ userId: user.id });
    const rowA = await saveBorrower(a.id, dana);
    await consent(a.id, rowA.id, "verification_authorization", new Date(Date.now() - 121 * DAY));
    await expect(
      tokenFor(primaryBorrower((await loadLoanFile(a.id))!), "credit_report"),
    ).rejects.toThrow(/expired/);

    const b = await createLoanFile({ userId: user.id });
    const rowB = await saveBorrower(b.id, dana);
    await consent(b.id, rowB.id, "verification_authorization");

    const auths = await prisma.authorization.findMany({
      where: { partyId: rowA.partyId },
      orderBy: { grantedAt: "asc" },
    });
    expect(auths).toHaveLength(2);
    expect(auths[0]!.revocationReason).toBe("lapsed; renewed by a new consent");
    expect(auths[1]!.revokedAt).toBeNull();
    const token = await tokenFor(primaryBorrower((await loadLoanFile(b.id))!), "credit_report");
    expect(token.authorizationId).toBe(auths[1]!.id);
  });

  it("a second consent against a still-live grant is a no-op, not a double grant", async () => {
    const { file, row } = await signedFile();
    await consent(file.id, row.id, "verification_authorization", new Date(Date.now() + 1000));
    const live = await prisma.authorization.findMany({
      where: { partyId: row.partyId, revokedAt: null },
    });
    expect(live).toHaveLength(1);
  });
});

/**
 * "Already signed" is this file's row AND the party's live grant, together.
 *
 * The engine satisfies APP-005 and INC-008 from the file's consent rows; the
 * minter reads the party's grants, which lapse. A route that answers from
 * either half alone disagrees with the other, and each of these is a case
 * where that disagreement locked a borrower out. `services/signature.ts`
 * holds the rule; these are the routes that apply it, called over HTTP.
 */
describe("a signature is judged by the file's row and the party's grant together", () => {
  const routers = [esignRouter, connectorRouter, applicationRouter];

  async function signVia(userId: string, fileId: string, kind: string) {
    const started = await callAs<{ alreadySigned: boolean; envelopeId?: string }>(
      userId,
      routers,
      "POST",
      `/${fileId}/esign`,
      { kind },
    );
    if (started.body.alreadySigned) return { started, completed: null };
    const completed = await callAs<{ alreadySigned: boolean }>(
      userId,
      routers,
      "POST",
      `/${fileId}/esign/complete`,
      { envelopeId: started.body.envelopeId },
    );
    return { started, completed };
  }

  function liveRows(fileId: string, kind: string) {
    return prisma.consent.findMany({ where: { loanFileId: fileId, kind, revokedAt: null } });
  }

  function grants(partyId: string, purpose: "FCRA_WRITTEN_INSTRUCTION" | "IRS_4506C") {
    return prisma.authorization.findMany({
      where: { partyId, purpose },
      orderBy: { grantedAt: "asc" },
    });
  }

  it("signs a second file within 120 days, so the engine sees it there too", async () => {
    const user = await createUser();
    const a = await createLoanFile({ userId: user.id });
    const rowA = await saveBorrower(a.id, dana);
    await consent(a.id, rowA.id, "verification_authorization");

    const b = await createLoanFile({ userId: user.id });
    const rowB = await saveBorrower(b.id, dana);
    expect(rowB.partyId).toBe(rowA.partyId);

    const { started, completed } = await signVia(user.id, b.id, "verification_authorization");
    expect(started.status).toBe(201);
    expect(started.body.alreadySigned).toBe(false);
    expect(completed?.status).toBe(201);
    expect(completed?.body.alreadySigned).toBe(false);

    // File B has its own row; the party's grant from file A still stands
    // alone, because the trigger is a no-op against a live one.
    expect(await liveRows(b.id, "verification_authorization")).toHaveLength(1);
    const live = (await grants(rowA.partyId, "FCRA_WRITTEN_INSTRUCTION")).filter(
      (g) => !g.revokedAt,
    );
    expect(live).toHaveLength(1);

    // The same evaluator the API serves: APP-005 reads THIS file's rows.
    const fileB = (await loadLoanFile(b.id))!;
    expect(evaluateSatisfaction(getRequirement("APP-005")!, fileB).status).toBe("satisfied");
  });

  it("re-signs the same file after its grant lapsed, and the minter works again", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);
    await consent(file.id, row.id, "verification_authorization", new Date(Date.now() - 121 * DAY));
    await expect(
      tokenFor(primaryBorrower((await loadLoanFile(file.id))!), "credit_report"),
    ).rejects.toThrow(/expired/);

    const { started, completed } = await signVia(user.id, file.id, "verification_authorization");
    expect(started.body.alreadySigned).toBe(false);
    expect(completed?.status).toBe(201);

    expect(await liveRows(file.id, "verification_authorization")).toHaveLength(2);
    const auths = await grants(row.partyId, "FCRA_WRITTEN_INSTRUCTION");
    expect(auths).toHaveLength(2);
    expect(auths[0]!.revocationReason).toBe("lapsed; renewed by a new consent");
    expect(auths[1]!.revokedAt).toBeNull();
    const token = await tokenFor(primaryBorrower((await loadLoanFile(file.id))!), "credit_report");
    expect(token.authorizationId).toBe(auths[1]!.id);
  });

  it("answers alreadySigned only when both halves are live", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);
    await consent(file.id, row.id, "verification_authorization");
    const { started, completed } = await signVia(user.id, file.id, "verification_authorization");
    expect(started.status).toBe(200);
    expect(started.body.alreadySigned).toBe(true);
    expect(completed).toBeNull();
    expect(await liveRows(file.id, "verification_authorization")).toHaveLength(1);
  });

  it("records a consent once against a live grant, and again after it lapses", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);
    const post = () =>
      callAs<{ id: string; alreadyRecorded: boolean }>(
        user.id,
        routers,
        "POST",
        `/${file.id}/consents`,
        { kind: "verification_authorization", borrowerId: row.id },
      );

    const first = await post();
    expect(first.status).toBe(201);
    expect(first.body.alreadyRecorded).toBe(false);
    const second = await post();
    expect(second.status).toBe(200);
    expect(second.body.alreadyRecorded).toBe(true);
    expect(second.body.id).toBe(first.body.id);

    expect(await liveRows(file.id, "verification_authorization")).toHaveLength(1);
    expect(
      (await grants(row.partyId, "FCRA_WRITTEN_INSTRUCTION")).filter((g) => !g.revokedAt),
    ).toHaveLength(1);
  });

  it("records a consent again once the grant behind the last one has lapsed", async () => {
    // A grant cannot be aged in place — authorizations are immutable except
    // for revocation, and the database enforces it — so the lapse is planted
    // as a signature 121 days old, the way it would actually have happened.
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);
    await consent(file.id, row.id, "verification_authorization", new Date(Date.now() - 121 * DAY));
    const post = () =>
      callAs<{ id: string; alreadyRecorded: boolean }>(
        user.id,
        routers,
        "POST",
        `/${file.id}/consents`,
        { kind: "verification_authorization", borrowerId: row.id },
      );

    const renewal = await post();
    expect(renewal.status).toBe(201);
    expect(renewal.body.alreadyRecorded).toBe(false);
    expect(await liveRows(file.id, "verification_authorization")).toHaveLength(2);
    const auths = await grants(row.partyId, "FCRA_WRITTEN_INSTRUCTION");
    expect(auths).toHaveLength(2);
    expect(auths[0]!.revocationReason).toBe("lapsed; renewed by a new consent");
    expect(auths[1]!.revokedAt).toBeNull();

    // And now it is signed: the repeat returns the renewal's row, not a third.
    const repeat = await post();
    expect(repeat.status).toBe(200);
    expect(repeat.body.id).toBe(renewal.body.id);
    expect(await liveRows(file.id, "verification_authorization")).toHaveLength(2);
    expect(
      (await grants(row.partyId, "FCRA_WRITTEN_INSTRUCTION")).filter((g) => !g.revokedAt),
    ).toHaveLength(1);
  });

  it("refuses a consent for a borrower who is not on this file", async () => {
    const user = await createUser();
    const mine = await createLoanFile({ userId: user.id });
    const other = await createLoanFile({ userId: (await createUser()).id });
    const theirs = await saveBorrower(other.id, dana);
    const res = await callAs(user.id, routers, "POST", `/${mine.id}/consents`, {
      kind: "verification_authorization",
      borrowerId: theirs.id,
    });
    expect(res.status).toBe(404);
    expect(await prisma.consent.count()).toBe(0);
  });

  it("signing the application renews a lapsed 4506-C rather than skipping it", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);
    await prisma.borrower.update({
      where: { id: row.id },
      data: {
        demographics: { ethnicity: "declined", race: "declined", sex: "declined" },
      },
    });
    await consent(file.id, row.id, "form_4506c", new Date(Date.now() - 121 * DAY));
    await expect(
      tokenFor(primaryBorrower((await loadLoanFile(file.id))!), "tax_transcript"),
    ).rejects.toThrow(/expired/);

    const res = await callAs<{ signed: string[]; transcriptError: string | null }>(
      user.id,
      routers,
      "POST",
      `/${file.id}/sign-application`,
    );
    expect(res.status).toBe(201);
    expect(res.body.signed).toEqual(["form_4506c"]);
    expect(res.body.transcriptError).toBeNull();

    expect(await liveRows(file.id, "form_4506c")).toHaveLength(2);
    const auths = await grants(row.partyId, "IRS_4506C");
    expect(auths).toHaveLength(2);
    expect(auths[0]!.revocationReason).toBe("lapsed; renewed by a new consent");
    expect(auths[1]!.revokedAt).toBeNull();
  });
});

describe("the minter reads the authorizations table, and nothing else", () => {
  it("mints from the mirrored grant, naming the party", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);
    await consent(file.id, row.id, "verification_authorization");
    const token = await tokenFor(primaryBorrower((await loadLoanFile(file.id))!), "credit_report");
    expect(token.partyId).toBe(row.partyId);
    const auth = await prisma.authorization.findFirstOrThrow({ where: { partyId: row.partyId } });
    expect(token.authorizationId).toBe(auth.id);
  });

  it("refuses with no grant at all — there is no consent to fall back to", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    await saveBorrower(file.id, dana);
    await expect(
      tokenFor(primaryBorrower((await loadLoanFile(file.id))!), "credit_report"),
    ).rejects.toMatchObject({
      requirementId: "APP-005",
    });
  });

  it("refuses a transcript on an APP-005 grant alone, citing INC-008", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);
    await consent(file.id, row.id, "verification_authorization");
    await expect(
      tokenFor(primaryBorrower((await loadLoanFile(file.id))!), "tax_transcript"),
    ).rejects.toMatchObject({
      requirementId: "INC-008",
    });
  });

  it("mints a transcript token once the 4506-C is mirrored", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);
    await consent(file.id, row.id, "verification_authorization");
    await consent(file.id, row.id, "form_4506c");
    const token = await tokenFor(primaryBorrower((await loadLoanFile(file.id))!), "tax_transcript");
    expect(token.purpose).toBe("irs_4506c");
  });

  it("refuses once the mirrored authorization has expired", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);
    await consent(file.id, row.id, "verification_authorization", new Date(Date.now() - 121 * DAY));
    const domain = (await loadLoanFile(file.id))!;
    await expect(tokenFor(primaryBorrower(domain), "credit_report")).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(tokenFor(primaryBorrower(domain), "credit_report")).rejects.toThrow(/expired/);
  });
});

describe("partyForUser", () => {
  it("is idempotent", async () => {
    const user = await createUser();
    const a = await prisma.$transaction((tx) => partyForUser(tx, user.id));
    const b = await prisma.$transaction((tx) => partyForUser(tx, user.id));
    expect(a).toBe(b);
    expect(await prisma.party.count()).toBe(1);
  });
});

describe("the principals a service acts as", () => {
  it("makes exactly one row when several first callers arrive at once", async () => {
    const ids = await Promise.all(
      Array.from({ length: 6 }, () => servicePrincipal(prisma, "application_flow")),
    );
    expect(new Set(ids).size).toBe(1);
    expect(
      await prisma.principal.count({ where: { kind: "SERVICE", subject: "application_flow" } }),
    ).toBe(1);
  });

  it("does not poison the transaction it was handed", async () => {
    // The losers of that race used to get a uniqueness error, and a Postgres
    // transaction that has seen one refuses every statement after it. The
    // borrower's save is in that transaction, so the loser's request would
    // have failed on a fresh database for no reason the borrower could see.
    const runs = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        prisma.$transaction(async (tx) => {
          const id = await servicePrincipal(tx, "application_flow");
          await tx.party.create({ data: { kind: "PERSON" }, select: { id: true } });
          return id;
        }),
      ),
    );
    const reasons = runs.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : []));
    expect(reasons).toEqual([]);
    expect(await prisma.party.count()).toBe(6);
  });

  it("stamps the engine version on the row it creates", async () => {
    await servicePrincipal(prisma, "shadow_aus");
    const row = await prisma.principal.findUniqueOrThrow({
      where: { kind_subject: { kind: "SERVICE", subject: "shadow_aus" } },
      select: { modelId: true, modelVersion: true },
    });
    expect(row.modelId).toBe("shadow");
    expect(row.modelVersion).toBe(SHADOW_ENGINE_VERSION);
  });

  it("fills in a version that was never set", async () => {
    await prisma.principal.create({ data: { kind: "SERVICE", subject: "shadow_aus" } });
    await servicePrincipal(prisma, "shadow_aus");
    const row = await prisma.principal.findUniqueOrThrow({
      where: { kind_subject: { kind: "SERVICE", subject: "shadow_aus" } },
      select: { modelVersion: true },
    });
    expect(row.modelVersion).toBe(SHADOW_ENGINE_VERSION);
  });

  it("leaves a version already stamped alone", async () => {
    // A ledger row names the engine that decided it. Restamping this row on a
    // build bump would quietly restate every older decision as the new
    // version's work, which is the one thing the actor column is for.
    await prisma.principal.create({
      data: {
        kind: "SERVICE",
        subject: "shadow_aus",
        modelId: "shadow",
        modelVersion: "0.0.1-earlier",
      },
    });
    await servicePrincipal(prisma, "shadow_aus");
    const row = await prisma.principal.findUniqueOrThrow({
      where: { kind_subject: { kind: "SERVICE", subject: "shadow_aus" } },
      select: { modelVersion: true },
    });
    expect(row.modelVersion).toBe("0.0.1-earlier");
  });

  it("makes exactly one staff row when several first callers arrive at once", async () => {
    const ids = await Promise.all(
      Array.from({ length: 6 }, () => staffPrincipal(prisma, "staff:persona_seed")),
    );
    expect(new Set(ids).size).toBe(1);
    expect(
      await prisma.principal.count({ where: { kind: "STAFF", subject: "staff:persona_seed" } }),
    ).toBe(1);
  });
});
