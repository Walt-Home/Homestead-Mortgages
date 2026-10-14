/**
 * The impure half of the autofill, against a real Postgres: what a reader is
 * handed with their file, whose rows it came from, what is recorded about it,
 * and what the save writes.
 *
 * Every promise here is about WHOSE: the owner reads a suggestion from their
 * own snapshot and never from anyone else's; a demo file offers nothing; the
 * snapshot row records the purpose the adapter certified; `autofill_shown` is
 * written once per suggestion and snapshot; a dismissal reported with the save
 * is honored on the next read; an outcome naming a snapshot that is not the
 * reader's own is refused.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { EXTENSION_OF_CREDIT } from "@hm/shared";
import type { AssetReport, ReadBack, Suggestion } from "@hm/shared";
import { connectorRouter } from "../routes/connectors.js";
import { declarationRouter } from "../routes/declarations.js";
import { fileRouter } from "../routes/files.js";
import { suggestionRouter } from "../routes/suggestions.js";
import { assertFacts, servicePrincipal } from "../services/party.js";
import { loadLoanFile } from "../services/repository.js";
import { createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

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

const DANA = {
  firstName: "Dana",
  lastName: "Whitfield",
  email: "dana@example.test",
  phone: "5555550144",
  dateOfBirth: "1986-11-03",
  ssnVaultHandle: "vault:dana:1",
  ssnLast4: "4321",
  currentAddress: { line1: "9 Fixture Way", city: "Austin", state: "TX", postalCode: "78745" },
  maritalStatus: "unmarried",
  citizenship: "us_citizen",
  preferredLanguage: "en",
  firstTimeHomebuyer: null,
  isMilitary: false,
  demographics: null,
};

const RENTING = {
  declaration: {
    intentToOccupy: "Yes",
    homeownerPastThreeYears: "No",
    specialBorrowerSellerRelationship: false,
    undisclosedBorrowedFunds: false,
    undisclosedMortgageApplication: false,
    undisclosedCreditApplication: false,
    propertyProposedCleanEnergyLien: false,
    undisclosedComakerOfNote: false,
    outstandingJudgments: false,
    presentlyDelinquent: false,
    partyToLawsuit: false,
    priorPropertyDeedInLieuConveyed: false,
    priorPropertyShortSaleCompleted: false,
    priorPropertyForeclosureCompleted: false,
    bankruptcy: false,
    bankruptcyChapters: [],
  },
  residences: [{ residencyType: "Current", basis: "Rent", durationMonths: 30, monthlyRent: 2_150 }],
  propertyEstateType: "FeeSimple",
};

type Read = {
  file: { id: string };
  you: string | null;
  suggestions: Suggestion[];
  readBacks: ReadBack[];
};

/** Screens 1 and 2, the authorization, the credit pull and the bank. */
async function linked() {
  const user = await createUser();
  const created = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
  const fileId = created.body.id;
  expect((await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, DANA)).status).toBe(
    201,
  );
  const dana = (await loadLoanFile(fileId))!.borrowers[0]!;
  for (const kind of ["verification_authorization", "econsent"]) {
    await callAs(user.id, [connectorRouter], "POST", `/${fileId}/consents`, {
      kind,
      borrowerId: dana.id,
    });
  }
  await callAs(user.id, [connectorRouter], "POST", `/${fileId}/credit`, {});
  const bank = await callAs(user.id, [connectorRouter], "POST", `/${fileId}/bank`, {});
  expect(bank.status, JSON.stringify(bank.body)).toBe(201);
  return { user, fileId, partyId: dana.partyId };
}

const read = (userId: string, fileId: string) =>
  callAs<Read>(userId, [fileRouter], "GET", `/${fileId}`);

const events = (fileId: string, kind: string) =>
  prisma.fileEvent.findMany({ where: { loanFileId: fileId, kind }, select: { payload: true } });

describe("reading a file", () => {
  it("records what the adapter certified on the snapshot row", async () => {
    const h = await linked();
    const row = await prisma.connectorSnapshot.findFirstOrThrow({
      where: { loanFileId: h.fileId, kind: "bank" },
      select: { permissiblePurpose: true, partyId: true },
    });
    expect(row.permissiblePurpose).toBe(EXTENSION_OF_CREDIT);
    expect(row.partyId).toBe(h.partyId);
  });

  it("hands the owner the rent from their own report, and writes that it was shown once", async () => {
    const h = await linked();
    const first = await read(h.user.id, h.fileId);
    expect(first.status).toBe(200);
    const [rent, ...rest] = first.body.suggestions;
    expect(rest).toHaveLength(0);
    expect(rent).toMatchObject({ key: "current_monthly_rent", partyId: h.partyId });
    expect(rent!.value).toBeGreaterThan(0);

    const again = await read(h.user.id, h.fileId);
    expect(again.body.suggestions).toHaveLength(1);
    expect(await events(h.fileId, "autofill_shown")).toHaveLength(1);
  });

  it("offers nothing before the bank is linked, and nothing on a file that is not the reader's own", async () => {
    const user = await createUser();
    const created = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
    const bare = await read(user.id, created.body.id);
    expect(bare.body.suggestions).toEqual([]);

    const h = await linked();
    const stranger = await createUser();
    const refused = await read(stranger.id, h.fileId);
    expect(refused.status).toBe(404);
  });

  it("offers nothing on a demo file", async () => {
    const h = await linked();
    await prisma.loanFile.update({ where: { id: h.fileId }, data: { isDemo: true } });
    const maya = await createUser({ personaKey: "maya_okafor" });
    const res = await read(maya.id, h.fileId);
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([]);
    expect(res.body.readBacks).toEqual([]);
  });
});

describe("the income read-back", () => {
  it("hands the applicant what they told us beside what their own bank shows", async () => {
    const h = await linked();
    const res = await read(h.user.id, h.fileId);
    const [back, ...rest] = res.body.readBacks;
    expect(rest).toHaveLength(0);

    const snapshot = await prisma.connectorSnapshot.findFirstOrThrow({
      where: { loanFileId: h.fileId, kind: "bank" },
      orderBy: { writeSeq: "desc" },
      select: { id: true, payload: true },
    });
    const streams = (snapshot.payload as unknown as AssetReport).incomeSources.filter(
      (s) => s.monthlyAmount > 0,
    );
    const said = await prisma.fact.findFirstOrThrow({
      where: { partyId: h.partyId, predicate: "monthly_income", supersededById: null },
      select: { id: true },
    });
    expect(back).toMatchObject({
      key: "stated_vs_found_income",
      partyId: h.partyId,
      stated: { value: 9_400, evidence: { kind: "fact", id: said.id } },
      found: {
        value: Math.round(streams.reduce((sum, s) => sum + s.monthlyAmount, 0)),
        streams: streams.length,
        evidence: { kind: "snapshot", id: snapshot.id },
      },
    });

    // Display only: reading it twice writes nothing about it.
    await read(h.user.id, h.fileId);
    const written = await prisma.fileEvent.count({
      where: { loanFileId: h.fileId, kind: { startsWith: "autofill_" } },
    });
    expect(written).toBe(1); // the rent caption's one `autofill_shown`, and nothing else
  });

  it("has nothing to read back before the bank", async () => {
    const user = await createUser();
    const created = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
    expect((await read(user.id, created.body.id)).body.readBacks).toEqual([]);
  });
});

describe("saving the questions", () => {
  it("writes the outcome the screen reports, and the answers exactly as without it", async () => {
    const h = await linked();
    const [rent] = (await read(h.user.id, h.fileId)).body.suggestions;
    const res = await callAs(h.user.id, [declarationRouter], "POST", `/${h.fileId}/declaration`, {
      ...RENTING,
      autofill: [
        {
          key: "current_monthly_rent",
          evidenceId: rent!.evidence.id,
          outcome: "accepted",
          proposed: rent!.value,
          given: 2_150,
        },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const file = (await loadLoanFile(h.fileId))!;
    expect(file.borrowers[0]!.residences[0]).toMatchObject({ basis: "Rent", monthlyRent: 2_150 });
    const accepted = await events(h.fileId, "autofill_accepted");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.payload).toMatchObject({
      key: "current_monthly_rent",
      evidenceId: rent!.evidence.id,
      partyId: h.partyId,
      proposed: rent!.value,
      given: 2_150,
    });
  });

  it("honors a dismissal on the next read, until a newer report", async () => {
    const h = await linked();
    const [rent] = (await read(h.user.id, h.fileId)).body.suggestions;
    const res = await callAs(h.user.id, [declarationRouter], "POST", `/${h.fileId}/declaration`, {
      ...RENTING,
      autofill: [
        {
          key: "current_monthly_rent",
          evidenceId: rent!.evidence.id,
          outcome: "dismissed",
        },
      ],
    });
    expect(res.status).toBe(201);
    expect((await read(h.user.id, h.fileId)).body.suggestions).toEqual([]);

    // A re-pull is a newer snapshot, and the dismissal was on the old one.
    const again = await callAs(h.user.id, [connectorRouter], "POST", `/${h.fileId}/bank`, {});
    expect(again.status).toBe(201);
    expect((await read(h.user.id, h.fileId)).body.suggestions).toHaveLength(1);
  });

  it("refuses an outcome naming a snapshot that is not the reader's own", async () => {
    const h = await linked();
    const other = await linked();
    const theirs = await prisma.connectorSnapshot.findFirstOrThrow({
      where: { loanFileId: other.fileId, kind: "bank" },
      select: { id: true },
    });
    const res = await callAs(h.user.id, [declarationRouter], "POST", `/${h.fileId}/declaration`, {
      ...RENTING,
      autofill: [{ key: "current_monthly_rent", evidenceId: theirs.id, outcome: "accepted" }],
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "AUTOFILL_NOT_YOURS" } });
    expect(await events(h.fileId, "autofill_accepted")).toHaveLength(0);
  });
});

describe("the phone a returning person gave before", () => {
  it("is offered on their next file before screen 2, and not once they have saved it there", async () => {
    const h = await linked();
    const next = await callAs<{ id: string }>(h.user.id, [fileRouter], "POST", "/", SCREEN_ONE);
    expect(next.status).toBe(201);

    const before = await read(h.user.id, next.body.id);
    const phone = before.body.suggestions.find((s) => s.key === "phone");
    expect(phone).toMatchObject({
      value: "555-555-0144",
      source: "prior_statement",
      tag: "What you told us before",
      partyId: h.partyId,
    });
    expect(phone!.evidence.kind).toBe("fact");
    expect(await events(next.body.id, "autofill_shown")).toHaveLength(1);

    const saved = await callAs(h.user.id, [fileRouter], "POST", `/${next.body.id}/borrowers`, {
      ...DANA,
      autofill: [
        {
          key: "phone",
          evidenceId: phone!.evidence.id,
          outcome: "accepted",
          proposed: phone!.value,
          given: "555-555-0144",
        },
      ],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const accepted = await prisma.fileEvent.findMany({
      where: { loanFileId: next.body.id, kind: "autofill_accepted" },
      select: { payload: true, requirementId: true, actor: true },
    });
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ requirementId: "APP-001", actor: "borrower" });
    expect(accepted[0]!.payload).toMatchObject({
      key: "phone",
      evidenceId: phone!.evidence.id,
      partyId: h.partyId,
    });

    // Their row is here now, and screen 2 reads their own answer back.
    const after = await read(h.user.id, next.body.id);
    expect(after.body.suggestions.find((s) => s.key === "phone")).toBeUndefined();
  });

  it("is never what somebody else said about them", async () => {
    // A SELF_ATTESTED row asserted by a principal that is not the person's
    // own is a statement about them, not by them: "what you told us before"
    // would be false of it.
    const user = await createUser();
    const created = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
    const { partyId } = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { partyId: true },
    });
    const service = await servicePrincipal(prisma, "claim_flow");
    await prisma.$transaction((tx) =>
      assertFacts(tx, partyId!, service, [{ predicate: "phone", value: "5125550142" }]),
    );
    const res = await read(user.id, created.body.id);
    expect(res.body.suggestions).toEqual([]);
  });

  it("refuses an outcome naming a statement that is not the reader's own, and writes nothing", async () => {
    const h = await linked();
    const other = await linked();
    const theirs = await prisma.fact.findFirstOrThrow({
      where: { partyId: other.partyId, predicate: "phone" },
      select: { id: true },
    });
    const next = await callAs<{ id: string }>(h.user.id, [fileRouter], "POST", "/", SCREEN_ONE);
    const res = await callAs(h.user.id, [fileRouter], "POST", `/${next.body.id}/borrowers`, {
      ...DANA,
      autofill: [{ key: "phone", evidenceId: theirs.id, outcome: "accepted" }],
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "AUTOFILL_NOT_YOURS" } });
    expect(await prisma.borrower.count({ where: { loanFileId: next.body.id } })).toBe(0);
  });
});

describe("before a file exists", () => {
  type Offered = { suggestions: Suggestion[] };
  const offered = (userId: string) =>
    callAs<Offered>(userId, [suggestionRouter], "GET", "/", undefined, "/api/suggestions");

  it("offers somebody new nothing, and a sample borrower nothing", async () => {
    const fresh = await createUser();
    expect((await offered(fresh.id)).body.suggestions).toEqual([]);
    const maya = await createUser({ personaKey: "maya_okafor" });
    expect((await offered(maya.id)).body.suggestions).toEqual([]);
  });

  it("offers the income the person last stated, and records what screen 1 did with it", async () => {
    const user = await createUser();
    expect((await callAs(user.id, [fileRouter], "POST", "/", SCREEN_ONE)).status).toBe(201);

    const [income, ...rest] = (await offered(user.id)).body.suggestions;
    expect(rest).toHaveLength(0);
    expect(income).toMatchObject({
      key: "stated_monthly_income",
      screen: "property",
      value: 9_400,
      source: "prior_statement",
      tag: "What you told us before",
    });
    expect(income!.evidence.kind).toBe("fact");

    // The next application, taking the line with one tap.
    const second = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", {
      ...SCREEN_ONE,
      autofill: [
        {
          key: "stated_monthly_income",
          evidenceId: income!.evidence.id,
          outcome: "accepted",
          proposed: 9_400,
          given: 9_400,
        },
      ],
    });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const accepted = await prisma.fileEvent.findMany({
      where: { loanFileId: second.body.id, kind: "autofill_accepted" },
      select: { payload: true, requirementId: true },
    });
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ requirementId: "APP-002" });
    expect(accepted[0]!.payload).toMatchObject({ key: "stated_monthly_income", given: 9_400 });

    // A revisit of screen 1 that types a different figure is a correction,
    // recorded on the file it was made on, and the figure becomes the next
    // one offered.
    const [again] = (await offered(user.id)).body.suggestions;
    const edited = await callAs(user.id, [fileRouter], "PATCH", `/${second.body.id}`, {
      statedMonthlyIncome: 10_200,
      autofill: [
        {
          key: "stated_monthly_income",
          evidenceId: again!.evidence.id,
          outcome: "corrected",
          proposed: 9_400,
          given: 10_200,
        },
      ],
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(await events(second.body.id, "autofill_corrected")).toHaveLength(1);
    expect((await offered(user.id)).body.suggestions[0]!.value).toBe(10_200);
  });

  it("refuses an income outcome that is not the reader's own, and creates no file", async () => {
    const someone = await createUser();
    await callAs(someone.id, [fileRouter], "POST", "/", SCREEN_ONE);
    const [theirs] = (await offered(someone.id)).body.suggestions;

    const me = await createUser();
    await callAs(me.id, [fileRouter], "POST", "/", SCREEN_ONE);
    const before = await prisma.loanFile.count({ where: { userId: me.id } });
    const res = await callAs(me.id, [fileRouter], "POST", "/", {
      ...SCREEN_ONE,
      autofill: [
        { key: "stated_monthly_income", evidenceId: theirs!.evidence.id, outcome: "accepted" },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "AUTOFILL_NOT_YOURS" } });
    expect(await prisma.loanFile.count({ where: { userId: me.id } })).toBe(before);
  });
});
