/**
 * The one place that strings assemble, gate, emit, send and record together,
 * and every way it stops short.
 *
 * A stop is an outcome and a row, never an exception at a borrower: the
 * placeholder institution in production, a person with nothing retrieved
 * about them, a casefile the gate refuses. Each is asserted here on a thin
 * file built through the routes; the walk that passes the gate and reaches
 * the port is the sample borrowers', in `seed-personas.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import type { DuConnector } from "@hm/connectors";
import { connectorRouter } from "../routes/connectors.js";
import { decisionRouter } from "../routes/decision.js";
import { fileRouter } from "../routes/files.js";
import { fixtureTaxpayerIdentifier, submitApplicationToDu } from "../services/du-submission.js";
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
  maritalStatus: "married",
  citizenship: "us_citizen",
  preferredLanguage: "en",
  firstTimeHomebuyer: true,
  isMilitary: false,
  demographics: null,
  statedMonthlyIncome: 7_400,
};

/** A port that records what reached it and answers nothing: every test here stops before it. */
function watching(): { du: DuConnector; reached: number } {
  const state = { reached: 0 };
  const du: DuConnector = {
    capabilities: { provider: "watching-du", mode: "fixture", satisfies: [] },
    async submit() {
      state.reached += 1;
      throw new Error("nothing in this file should reach the port");
    },
  };
  return {
    du,
    get reached() {
      return state.reached;
    },
  };
}

async function aFile(pulls: readonly ("credit" | "bank")[]) {
  const user = await createUser();
  const created = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
  const fileId = created.body.id;
  await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, DANA);
  const dana = (await loadLoanFile(fileId))!.borrowers[0]!;
  for (const kind of ["verification_authorization", "econsent"]) {
    await callAs(user.id, [connectorRouter], "POST", `/${fileId}/consents`, {
      kind,
      borrowerId: dana.id,
    });
  }
  for (const pull of pulls) {
    const res = await callAs(user.id, [connectorRouter], "POST", `/${fileId}/${pull}`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
  return { user, fileId, file: (await loadLoanFile(fileId))! };
}

const eventsOn = (fileId: string) =>
  prisma.fileEvent.findMany({
    where: { loanFileId: fileId, kind: { startsWith: "du_" } },
    orderBy: { occurredAt: "asc" },
    select: { kind: true, payload: true },
  });

describe("submitting to Desktop Underwriter", () => {
  it("refuses in production while the institution or the originator is a placeholder, before reading a row", async () => {
    const { fileId, file } = await aFile(["credit", "bank"]);
    const port = watching();
    const outcome = await submitApplicationToDu({
      loanFileId: fileId,
      file,
      now: new Date(),
      du: port.du,
      nodeEnv: "production",
    });
    expect(outcome).toMatchObject({ status: "refused", reason: "placeholders" });
    expect((outcome as { detail: readonly string[] }).detail).toEqual(
      expect.arrayContaining([
        "institution.lenderLoanIdentifier",
        "institution.submittingPartyIdentifier",
        "originator.companyNmlsId",
      ]),
    );
    expect(port.reached).toBe(0);
    expect(await eventsOn(fileId)).toEqual([
      {
        kind: "du_submission_refused",
        payload: expect.objectContaining({ reason: "placeholders" }),
      },
    ]);
    expect(await prisma.duResponse.count()).toBe(0);
  });

  it("refuses a borrower with nothing retrieved about them, by name", async () => {
    const { fileId, file } = await aFile([]);
    const port = watching();
    const outcome = await submitApplicationToDu({
      loanFileId: fileId,
      file,
      now: new Date(),
      du: port.du,
    });
    expect(outcome).toEqual({
      status: "refused",
      reason: "nothing_retrieved",
      detail: ["Dana Whitfield"],
    });
    expect(port.reached).toBe(0);
  });

  it("refuses a casefile the gate refuses, naming what is missing and never a value", async () => {
    // Credit and a bank, and nothing else: no product, no county record, no
    // Section 5. The gate says so, in XPaths and labels.
    const { fileId, file } = await aFile(["credit", "bank"]);
    const port = watching();
    const outcome = await submitApplicationToDu({
      loanFileId: fileId,
      file,
      now: new Date(),
      du: port.du,
    });
    expect(outcome).toMatchObject({ status: "refused", reason: "preflight" });
    const detail = (outcome as { detail: readonly string[] }).detail;
    expect(detail.length).toBeGreaterThan(0);
    expect(detail.join("\n")).toContain("FinancedUnitCount");
    // Nothing a borrower typed: not her name, her number, her balance.
    expect(detail.join("\n")).not.toMatch(/Whitfield|4321|18430|71500/);
    expect(port.reached).toBe(0);
    const events = await eventsOn(fileId);
    expect(events.map((e) => e.kind)).toEqual(["du_submission_refused"]);
    expect(events[0]!.payload).toMatchObject({ reason: "preflight" });
  });

  it("is what the decision route does after every decision, and says so in its answer", async () => {
    const { user, fileId } = await aFile(["credit", "bank"]);
    const res = await callAs<{ du: { status: string; reason?: string } }>(
      user.id,
      [decisionRouter],
      "POST",
      `/${fileId}/decision`,
      {},
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // The decision stood; the submission was refused at the gate and recorded.
    expect(res.body.du).toMatchObject({ status: "refused", reason: "preflight" });
    expect((await eventsOn(fileId)).map((e) => e.kind)).toEqual(["du_submission_refused"]);
  });

  it("answers the owner with every response, oldest first, and nobody else at all", async () => {
    const { user, fileId } = await aFile([]);
    const mine = await callAs<{ duCasefileId: string | null; responses: unknown[] }>(
      user.id,
      [decisionRouter],
      "GET",
      `/${fileId}/du-responses`,
    );
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ duCasefileId: null, responses: [] });
    const stranger = await createUser();
    expect(
      (await callAs(stranger.id, [decisionRouter], "GET", `/${fileId}/du-responses`)).status,
    ).toBe(404);
  });

  it("hands the fixture a number nobody has ever been issued", () => {
    const one = fixtureTaxpayerIdentifier("11111111-1111-1111-1111-111111111111");
    const two = fixtureTaxpayerIdentifier("22222222-2222-2222-2222-222222222222");
    expect(one).toMatch(/^000[0-9]{6}$/);
    expect(two).toMatch(/^000[0-9]{6}$/);
    expect(one).not.toBe(two);
  });
});
