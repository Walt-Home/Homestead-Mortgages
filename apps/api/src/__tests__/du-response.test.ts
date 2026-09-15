/**
 * What DU answered, written down.
 *
 * Five promises, and the database keeps three of them on its own:
 *
 *   - The casefile DU minted is taken once. A retry storing the same value is
 *     an ordinary retry; a different value raises rather than starting a second
 *     case at Fannie while our own records still say one.
 *   - Two answers are two rows. A resubmission appends, because "your situation
 *     changed" is a diff between two responses and you cannot diff against a
 *     row you overwrote.
 *   - A value we cannot read does not land, and is refused by NAME. Both words
 *     DU chose are parsed before anything is written, so an operator is told
 *     which field they have never seen a value for — rather than being handed a
 *     check-constraint violation that names the wrong problem, or, for the
 *     status, nothing at all. The recommendation column is a Postgres enum
 *     besides, because a service is not what a second writer goes through.
 *   - **Nothing here moves the application.** The last block is the one to read
 *     before changing any of this: a DU recommendation is Fannie Mae's
 *     assessment of a loan they might buy, the creditor is Grander, and an
 *     extension of credit is theirs to make. A file moves because somebody
 *     moved it, with an actor and a ledger row.
 *   - The file a submission claims and the file the application was born from
 *     are the same one. The connector guard took the submission's word for
 *     which application's signatures its tokens had to come from; this is the
 *     first place that word meets a row.
 *
 * Against the real Postgres, because most of them are constraints.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import type { ConnectorResult, DuSubmission } from "@hm/connectors";
import type { DuResponse } from "@hm/shared";
import { recordDuResponse } from "../services/du-response.js";
import { createLoanFile } from "./support/factories.js";

const SUBMITTED_AT = new Date("2026-09-14T09:00:00.000Z");
const DU_CASE = "1234567890";

async function application() {
  const file = await createLoanFile();
  return prisma.application.create({
    data: { loanFileId: file.id, ausCasefileId: randomUUID() },
    select: { id: true, loanFileId: true, ausCasefileId: true, status: true, statusSeq: true },
  });
}

type App = { id: string; loanFileId: string; ausCasefileId: string };

function submissionFor(app: App): DuSubmission {
  return {
    applicationId: app.id,
    loanFileId: app.loanFileId,
    ausCasefileId: app.ausCasefileId,
    duCasefileId: null,
    borrowers: [
      {
        partyId: "11111111-1111-1111-1111-111111111111",
        borrowerOrdinal: 1,
        dataCategories: ["credit_report"],
      },
    ],
    // Whatever the emitter produced. Nothing stores it.
    document: "<MESSAGE/>",
  };
}

/** An answer in the shape an adapter returns one. */
function answer(response: DuResponse): ConnectorResult<DuResponse> {
  return {
    data: response,
    provider: "fixture-du",
    retrievedAt: response.respondedAt,
    externalId: `du-${randomUUID()}`,
  };
}

const answered = (duCasefileId: string, at = "2026-09-14T09:00:05.000Z"): DuResponse => ({
  status: "answered",
  duCasefileId,
  recommendation: "Approve/Eligible",
  messages: [
    { category: "Risk/Eligibility", code: "0021", text: "Desktop Underwriter recommendation." },
  ],
  respondedAt: at,
});

const record = (app: App, response: DuResponse) =>
  recordDuResponse(submissionFor(app), answer(response), SUBMITTED_AT);

describe("the casefile DU minted lands once", () => {
  it("writes it onto the application", async () => {
    const app = await application();
    await record(app, answered(DU_CASE));

    const after = await prisma.application.findUniqueOrThrow({
      where: { id: app.id },
      select: { duCasefileId: true },
    });
    expect(after.duCasefileId).toBe(DU_CASE);
  });

  it("takes the same value again without complaint", async () => {
    // A duplicate delivery, or a resubmission of a case DU already named. The
    // refusal is keyed on the value differing, so an ordinary retry is not an
    // error.
    const app = await application();
    await record(app, answered(DU_CASE));
    await record(app, answered(DU_CASE, "2026-09-14T11:00:00.000Z"));

    const rows = await prisma.duResponse.findMany({
      where: { applicationId: app.id },
      select: { duCasefileId: true },
    });
    expect(rows.map((r) => r.duCasefileId)).toEqual([DU_CASE, DU_CASE]);
  });

  it("refuses a different one", async () => {
    const app = await application();
    await record(app, answered(DU_CASE));
    await expect(record(app, answered("9999999999"))).rejects.toThrow(
      /already carries DU casefile/,
    );
  });

  it("refuses a response for a case the application does not carry", async () => {
    // The other direction, and the reason the trigger is on this table too: a
    // response row filed under a casefile the application never took is either
    // another loan's answer landing here or a second case nobody recorded.
    const app = await application();
    await expect(
      prisma.duResponse.create({
        data: {
          applicationId: app.id,
          seq: 1,
          status: "ANSWERED",
          recommendation: "APPROVE_ELIGIBLE",
          duCasefileId: DU_CASE,
          ausCasefileId: app.ausCasefileId,
          provider: "fixture-du",
          submittedAt: SUBMITTED_AT,
          receivedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/does not carry DU casefile/);
  });
});

describe("two answers are two rows", () => {
  it("appends rather than overwriting", async () => {
    const app = await application();
    const first = await record(app, answered(DU_CASE));
    const second = await record(app, answered(DU_CASE, "2026-09-14T15:30:00.000Z"));

    expect(first.id).not.toBe(second.id);
    expect([first.seq, second.seq]).toEqual([1, 2]);

    const rows = await prisma.duResponse.findMany({
      where: { applicationId: app.id },
      orderBy: { seq: "asc" },
      include: { messages: true },
    });
    expect(rows).toHaveLength(2);
    // Both answers survive, which is what makes the difference between them
    // expressible at all.
    expect(rows.map((r) => r.receivedAt.toISOString())).toEqual([
      "2026-09-14T09:00:05.000Z",
      "2026-09-14T15:30:00.000Z",
    ]);
    expect(rows[0]!.messages).toHaveLength(1);
    expect(rows[0]!.messages[0]!.ordinal).toBe(1);
  });

  it("refuses to rewrite one in place", async () => {
    const app = await application();
    const first = await record(app, answered(DU_CASE));
    await expect(
      prisma.duResponse.update({
        where: { id: first.id },
        data: { recommendation: "REFER_INELIGIBLE" },
      }),
    ).rejects.toThrow(/may not be updated/);

    const message = await prisma.duResponseMessage.findFirstOrThrow({
      where: { responseId: first.id },
      select: { id: true },
    });
    await expect(
      prisma.duResponseMessage.update({ where: { id: message.id }, data: { text: "revised" } }),
    ).rejects.toThrow(/may not be updated/);
  });
});

describe("a recommendation we cannot read", () => {
  it("cannot be stored at all", async () => {
    // The refusal `parseDuRecommendation` makes at the boundary, kept here as
    // well: a service is not what a second writer goes through.
    const app = await application();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "du_responses" ("id", "application_id", "seq", "status", "recommendation",` +
          ` "aus_casefile_id", "provider", "submitted_at", "received_at")` +
          ` VALUES (gen_random_uuid(), $1::uuid, 1, 'ANSWERED', 'Approve'::"DuRecommendation",` +
          ` $2, 'fixture-du', now(), now())`,
        app.id,
        app.ausCasefileId,
      ),
    ).rejects.toThrow();
  });

  it("is not the same set of words our own engine uses", async () => {
    // Our engine's `approve_eligible` is not DU's "Approve/Eligible", and the
    // column holds only the second. A row storing the first would be our own
    // verdict wearing Fannie Mae's name.
    const app = await application();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "du_responses" ("id", "application_id", "seq", "status", "recommendation",` +
          ` "aus_casefile_id", "provider", "submitted_at", "received_at")` +
          ` VALUES (gen_random_uuid(), $1::uuid, 1, 'ANSWERED', 'approve_eligible'::"DuRecommendation",` +
          ` $2, 'fixture-du', now(), now())`,
        app.id,
        app.ausCasefileId,
      ),
    ).rejects.toThrow();
  });
});

describe("an answer DU could not give", () => {
  it("records the error without inventing a verdict", async () => {
    const app = await application();
    const errored: DuResponse = {
      status: "errored",
      duCasefileId: null,
      messages: [{ category: "Submission", code: "0001", text: "Could not be evaluated." }],
      respondedAt: "2026-09-14T09:00:04.000Z",
    };
    await record(app, errored);

    const row = await prisma.duResponse.findFirstOrThrow({
      where: { applicationId: app.id },
      select: { status: true, recommendation: true, duCasefileId: true },
    });
    expect(row.status).toBe("ERRORED");
    expect(row.recommendation).toBeNull();
    // And the application still has no casefile, because DU never opened one.
    const after = await prisma.application.findUniqueOrThrow({
      where: { id: app.id },
      select: { duCasefileId: true },
    });
    expect(after.duCasefileId).toBeNull();
  });

  it("refuses a row that claims to be answered with nothing in it", async () => {
    const app = await application();
    await expect(
      prisma.duResponse.create({
        data: {
          applicationId: app.id,
          seq: 1,
          status: "ANSWERED",
          recommendation: null,
          ausCasefileId: app.ausCasefileId,
          provider: "fixture-du",
          submittedAt: SUBMITTED_AT,
          receivedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });
});

describe("an answer we cannot read is not written down", () => {
  it("refuses a status nobody here has decided about", async () => {
    // Read as "errored" — which is what a default does — this row would say DU
    // could not evaluate a casefile DU evaluated and approved, and it would
    // take the write-once casefile on the way past. The two shapes exist so
    // that "DU could not" and "DU did" never collapse; defaulting collapses
    // them and calls it a recorded answer.
    const app = await application();
    const unreadable = {
      status: "completed",
      duCasefileId: DU_CASE,
      recommendation: "Approve/Eligible",
      messages: [],
      respondedAt: "2026-09-14T09:00:05.000Z",
    } as unknown as DuResponse;

    await expect(record(app, unreadable)).rejects.toThrow(/status this system does not know/);

    expect(await prisma.duResponse.count({ where: { applicationId: app.id } })).toBe(0);
    const after = await prisma.application.findUniqueOrThrow({
      where: { id: app.id },
      select: { duCasefileId: true },
    });
    expect(after.duCasefileId).toBeNull();
  });

  it("refuses a recommendation nobody here has decided about, by name", async () => {
    // The column refuses it too, but a service that let it reach Postgres
    // hands the operator "violates check constraint
    // du_responses_says_whether_du_evaluated_it" — the wrong diagnosis for
    // what happened. `parseDuRecommendation` is the refusal the module header,
    // the migration and the not-wired error all say this path makes.
    const app = await application();
    const unreadable = {
      status: "answered",
      duCasefileId: DU_CASE,
      recommendation: "Accept",
      messages: [],
      respondedAt: "2026-09-14T09:00:05.000Z",
    } as unknown as DuResponse;

    await expect(record(app, unreadable)).rejects.toThrow(
      /recommendation this system does not know/,
    );

    expect(await prisma.duResponse.count({ where: { applicationId: app.id } })).toBe(0);
    const after = await prisma.application.findUniqueOrThrow({
      where: { id: app.id },
      select: { duCasefileId: true },
    });
    expect(after.duCasefileId).toBeNull();
  });

  it("takes the padding off and stores what is underneath", async () => {
    // A transport that pads a field has not said a different thing, and
    // refusing here would turn a whitespace difference into a lost verdict.
    const app = await application();
    const padded = {
      ...answered(DU_CASE),
      recommendation: "  Approve/Eligible \n",
    } as unknown as DuResponse;
    await record(app, padded);

    const row = await prisma.duResponse.findFirstOrThrow({
      where: { applicationId: app.id },
      select: { recommendation: true },
    });
    expect(row.recommendation).toBe("APPROVE_ELIGIBLE");
  });

  it("refuses a submission that names a different loan file", async () => {
    // The connector guard was told which file's signatures these tokens had to
    // come from, and took the submission's word for it. This is where that
    // word meets the row: a pair that disagrees means the permissions this
    // casefile went out under were not this application's.
    const app = await application();
    const other = await application();
    await expect(
      recordDuResponse(
        { ...submissionFor(app), loanFileId: other.loanFileId },
        answer(answered(DU_CASE)),
        SUBMITTED_AT,
      ),
    ).rejects.toThrow(/different loan file/);

    expect(await prisma.duResponse.count({ where: { applicationId: app.id } })).toBe(0);
  });
});

describe("a response does not move the application", () => {
  it("leaves the state, the sequence and the ledger exactly as they were", async () => {
    // The rule, pinned. DU's verdict is an input to underwriting and not a
    // decision of ours: the creditor is Grander, every move in the machine
    // carries an actor principal from `principals` — which DU has no row in and
    // must not be given one — and an approval that advanced a file on its own
    // would start ECOA clocks on a third party's assessment of data nobody had
    // finished verifying.
    //
    // A move made BECAUSE of this answer is somebody's move, later, naming this
    // row's id in `application_transitions.caused_by`.
    const app = await application();
    await record(app, answered(DU_CASE));
    await record(app, answered(DU_CASE, "2026-09-14T16:00:00.000Z"));

    const after = await prisma.application.findUniqueOrThrow({
      where: { id: app.id },
      select: { status: true, statusSeq: true },
    });
    expect(after.status).toBe(app.status);
    expect(after.statusSeq).toBe(app.statusSeq);

    const ledger = await prisma.applicationTransition.findMany({
      where: { applicationId: app.id },
    });
    expect(ledger).toHaveLength(0);
  });

  it("does not exist to be read as an approval", async () => {
    // There is no outcome column and no adverse-action reasons on this table,
    // and nothing that renders one may find them here.
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'du_responses'
    `;
    const names = columns.map((c) => c.column_name);
    expect(names).not.toContain("outcome");
    expect(names).not.toContain("adverse_action_reasons");
  });
});
