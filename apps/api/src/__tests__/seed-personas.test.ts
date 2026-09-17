/**
 * The sample borrowers are real, and the seed cannot fake one.
 *
 * Two things are being proved. First, that each persona is where its story
 * says: against the real Postgres, with the real triggers, having walked the
 * real services. Second — and this is the half that matters more — that the
 * seed did not simply write the answer. Every ledger row is checked for an
 * actor drawn from a closed set, every receipt for the trigger that wrote it,
 * and a story with a deliberately wrong target is checked to leave NOTHING
 * behind, because a drift that commits is a wrong answer on a public sign-in
 * page until somebody notices.
 *
 * `isolation.test.ts` carries the other half of that guarantee: it reads this
 * module's source and fails on any delegate that could forge a state.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@hm/db";
import type { DuConnector } from "@hm/connectors";
import { DuTransportError } from "@hm/connectors";
import { assessAll } from "@hm/requirements";
import type { SanctionsScreening } from "@hm/shared";

// Read at call time by the seed, but hoisted anyway: another suite in the same
// worker sets it to "false", and which of us runs first is not something to
// leave to run order.
vi.hoisted(() => {
  process.env.DEMO_PERSONAS = "true";
});

import { isSeeded, PERSONA_STORIES, type PersonaKey } from "../personas/stories.js";
import { authRouter } from "../routes/auth.js";
import { purgeLegacyDemo, resetPersona, seedAll } from "../scripts/seed-personas.js";
import { fileRouter } from "../routes/files.js";
import { submitApplicationToDu } from "../services/du-submission.js";
import { borrowerObligations } from "../services/obligations.js";
import { loadLoanFile } from "../services/repository.js";
import { principalForParty } from "../services/party.js";
import { toDomainState, transition } from "../services/transition.js";
import { ingestFixtureApor } from "./support/apor.js";
import { callAs } from "./support/http.js";

// The deploy fetches the average prime offer rates before it seeds, because the
// sample borrowers are decided against that table; the tests do the same. A
// seed against an empty table refers every persona whose market is derived,
// which is right for a real deployment and wrong for a test of the stories.
beforeEach(async () => {
  await ingestFixtureApor();
});

/** Everything the seed writes, counted, so a second run can be compared. */
async function census() {
  return {
    users: await prisma.user.count(),
    parties: await prisma.party.count(),
    facts: await prisma.fact.count(),
    applications: await prisma.application.count(),
    transitions: await prisma.applicationTransition.count(),
    clocks: await prisma.regulatoryClock.count(),
    pins: await prisma.applicationEvidenceLink.count(),
    scenarios: await prisma.loanScenario.count(),
    snapshots: await prisma.connectorSnapshot.count(),
  };
}

/** The file the persona picker would open, with its application beside it. */
async function persona(key: PersonaKey) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { personaKey: key },
    select: {
      id: true,
      partyId: true,
      loanFiles: {
        orderBy: { createdAt: "asc" },
        take: 1,
        select: {
          id: true,
          isDemo: true,
          sanctionsScreenClear: true,
          application: {
            select: {
              id: true,
              status: true,
              parties: { select: { partyId: true, role: true } },
              clocks: { select: { kind: true, tolledFrom: true, tolledUntil: true } },
              scenarios: { select: { seq: true, origin: true, isActive: true } },
              transitions: {
                orderBy: { seq: "asc" },
                select: {
                  seq: true,
                  fromState: true,
                  toState: true,
                  event: true,
                  reasonCode: true,
                  actorPrincipalId: true,
                  actor: { select: { kind: true, subject: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  const file = user.loanFiles[0]!;
  return { user, file, application: file.application! };
}

const SEEDED = PERSONA_STORIES.filter(isSeeded);

describe("the seed walks every persona to its state", () => {
  it("puts each one where its story says, and says so", async () => {
    const reports = await seedAll();
    expect(reports).toHaveLength(PERSONA_STORIES.length);
    for (const report of reports) {
      const story = PERSONA_STORIES.find((s) => s.key === report.key)!;
      if (!isSeeded(story)) {
        expect(report.result).toBe("deferred");
        expect(report.loanFileId).toBeNull();
        continue;
      }
      expect(`${report.key}: ${report.result}`).toBe(`${report.key}: seeded`);
      expect(`${report.key}: ${report.state}`).toBe(`${report.key}: ${story.target}`);
    }
  });

  it("writes nothing the second time, and reports what is already there", async () => {
    await seedAll();
    const first = await census();
    const again = await seedAll();
    expect(await census()).toEqual(first);
    for (const report of again) {
      if (report.key === "grander_import") continue;
      expect(`${report.key}: ${report.result}`).toBe(`${report.key}: exists`);
    }
  });

  it("gives every application a gapless ledger whose receipt is the trigger's", async () => {
    await seedAll();
    for (const story of SEEDED) {
      const { application } = await persona(story.key);
      const seqs = application.transitions.map((t) => t.seq);
      expect(`${story.key}: ${seqs.join(",")}`).toBe(
        `${story.key}: ${seqs.map((_, i) => i + 1).join(",")}`,
      );
      // Every row starts where the one before it ended.
      let previous: string | null = "DRAFT";
      for (const row of application.transitions) {
        expect(`${story.key}#${row.seq}`).toBe(
          row.fromState === previous ? `${story.key}#${row.seq}` : `${story.key}#mismatch`,
        );
        previous = row.toState;
      }
      expect(toDomainState(application.status)).toBe(story.target);

      const receipt = application.transitions.filter((t) => t.toState === "INTAKE_RECEIVED");
      expect(receipt).toHaveLength(1);
      expect(receipt[0]!.event).toBe("intake_completed");
      expect(receipt[0]!.reasonCode).toBe("six_pieces_received");
      expect(receipt[0]!.actor.subject).toBe("trid_receipt");
    }
  });

  it("names only actors the product itself can be", async () => {
    await seedAll();
    for (const story of SEEDED) {
      const { user, application } = await persona(story.key);
      // The people and services allowed to have moved a sample borrower's
      // application: the receipt trigger, the orchestration, the engine, the
      // one named staff actor, and a borrower on the application itself.
      const borrowerPrincipals = new Set<string>();
      for (const party of application.parties) {
        borrowerPrincipals.add(await principalForParty(prisma, party.partyId));
      }
      expect(user.partyId).not.toBeNull();
      for (const row of application.transitions) {
        const allowed =
          (row.actor.kind === "SERVICE" &&
            ["trid_receipt", "application_flow", "shadow_aus"].includes(row.actor.subject)) ||
          (row.actor.kind === "STAFF" && row.actor.subject === "staff:persona_seed") ||
          (row.actor.kind === "BORROWER" && borrowerPrincipals.has(row.actorPrincipalId));
        expect(
          `${story.key}#${row.seq} ${row.event} by ${row.actor.kind}:${row.actor.subject}`,
        ).toBe(
          allowed
            ? `${story.key}#${row.seq} ${row.event} by ${row.actor.kind}:${row.actor.subject}`
            : `${story.key}#${row.seq} an actor this seed may not be`,
        );
      }
    }
  });

  it("opens exactly one Loan Estimate clock per application, and leaves it tolled", async () => {
    await seedAll();
    for (const story of SEEDED) {
      const { application } = await persona(story.key);
      const le = application.clocks.filter((c) => c.kind === "TRID_LE_DELIVERY");
      expect(`${story.key}: ${le.length}`).toBe(`${story.key}: 1`);
      // Tolled, and never satisfied: there is no way to deliver the document,
      // and writing a delivery that did not happen is the one thing a
      // regulatory clock must never say.
      expect(le[0]!.tolledFrom).not.toBeNull();
      expect(le[0]!.tolledUntil).toBeNull();
    }
  });

  /*
   * The casefile goes to Desktop Underwriter after every decision, through
   * the same service the route uses. Against the fixture port every decided
   * sample borrower is answered — the two-person household included — and
   * an undecided one was never sent. The first walk of this path found two
   * defects on every seeded file: a unit count the seed retrieved and never
   * kept, and telephone numbers twelve characters long at a ten-digit
   * destination. Both are fixed where a real borrower would have hit them.
   */
  it("sends every decided file to Desktop Underwriter and records the answer", async () => {
    await seedAll();
    for (const story of SEEDED) {
      const { file } = await persona(story.key);
      const application = await prisma.application.findUniqueOrThrow({
        where: { loanFileId: file.id },
        select: { id: true, duCasefileId: true },
      });
      const responses = await prisma.duResponse.findMany({
        where: { applicationId: application.id },
        select: { seq: true, status: true, recommendation: true, duCasefileId: true },
      });
      const events = await prisma.fileEvent.findMany({
        where: { loanFileId: file.id, kind: { startsWith: "du_" } },
        select: { kind: true, payload: true },
      });
      if (!story.expectedOutcome) {
        expect(responses, story.key).toEqual([]);
        expect(events, story.key).toEqual([]);
        expect(application.duCasefileId, story.key).toBeNull();
        continue;
      }
      expect(
        events.map((e) => e.kind),
        story.key,
      ).toEqual(["du_submitted"]);
      expect(responses, story.key).toEqual([
        {
          seq: 1,
          status: "ANSWERED",
          recommendation: "APPROVE_ELIGIBLE",
          duCasefileId: application.duCasefileId,
        },
      ]);
      expect(application.duCasefileId, story.key).not.toBeNull();
    }
  });

  it("resubmits under the casefile DU minted, and records a transport failure without losing it", async () => {
    await seedAll();
    const { file, user } = await persona("priya_dev_raman");
    const loaded = (await loadLoanFile(file.id))!;
    const before = await prisma.application.findUniqueOrThrow({
      where: { loanFileId: file.id },
      select: { duCasefileId: true },
    });

    const sent: string[] = [];
    const answering: DuConnector = {
      capabilities: { provider: "stub-du", mode: "fixture", satisfies: [] },
      async submit(submission) {
        sent.push(submission.duCasefileId ?? "");
        return {
          data: {
            status: "answered",
            duCasefileId: submission.duCasefileId!,
            recommendation: "Refer with Caution",
            messages: [{ category: "Risk/Eligibility", code: "0022", text: "Refer with Caution." }],
            respondedAt: new Date().toISOString(),
          },
          provider: "stub-du",
          retrievedAt: new Date().toISOString(),
          externalId: "du-2",
        };
      },
    };
    const again = await submitApplicationToDu({
      loanFileId: file.id,
      file: loaded,
      now: new Date(),
      du: answering,
    });
    // The second submission carried the case DU opened the first time.
    expect(sent).toEqual([before.duCasefileId]);
    expect(again).toMatchObject({
      status: "answered",
      recommendation: "Refer with Caution",
      seq: 2,
    });

    const failing: DuConnector = {
      capabilities: { provider: "stub-du", mode: "fixture", satisfies: [] },
      async submit() {
        throw new DuTransportError("the connection dropped", true);
      },
    };
    const failed = await submitApplicationToDu({
      loanFileId: file.id,
      file: loaded,
      now: new Date(),
      du: failing,
    });
    expect(failed).toMatchObject({
      status: "failed",
      reason: "transport",
      mayHaveOpenedACase: true,
    });
    const kinds = (
      await prisma.fileEvent.findMany({
        where: { loanFileId: file.id, kind: { startsWith: "du_" } },
        orderBy: { occurredAt: "asc" },
        select: { kind: true },
      })
    ).map((e) => e.kind);
    expect(kinds).toEqual(["du_submitted", "du_submitted", "du_submission_failed"]);

    // The file carries the latest answer beside the decision, for the
    // applicant; a co-borrower's read of the same file carries none of it.
    const hers = await callAs<{
      file: { duResponse: { seq: number; recommendation: string } | null };
    }>(user.id, [fileRouter], "GET", `/${file.id}`);
    expect(hers.body.file.duResponse).toMatchObject({
      seq: 2,
      status: "answered",
      recommendation: "Refer with Caution",
      duCasefileId: before.duCasefileId,
    });
    const dev = await prisma.user.findUniqueOrThrow({
      where: { personaKey: "priya_dev_raman:dev" },
      select: { id: true },
    });
    const his = await callAs<{ file: { duResponse: unknown } }>(
      dev.id,
      [fileRouter],
      "GET",
      `/${file.id}`,
    );
    expect(his.status).toBe(200);
    expect(his.body.file.duResponse).toBeNull();
  });

  it("leaves nothing on the borrower of a file that has been decided", async () => {
    // The reason the two decided personas can exist at all. An engine finding
    // a person cannot act on — a commission history, an old inquiry — is a
    // condition on their file, not an obligation that would hold it at "needs
    // you" waiting for a document nobody can produce.
    await seedAll();
    for (const story of SEEDED) {
      if (!story.expectedOutcome) continue;
      const { file } = await persona(story.key);
      const loaded = await loadLoanFile(file.id);
      expect(borrowerObligations(loaded!).map((o) => o.branch)).toEqual([]);
    }
  });

  it("writes each persona's own name, not the label on their row", async () => {
    // The picker's row is a label, and Priya's says "Priya and Dev Raman"
    // because two people are on that file. Sending a label through screen 2
    // makes it somebody's `legal_name` — one of the six TRID pieces, sitting
    // beside her date of birth and the last four of her SSN, saying a person
    // is called something no person is called.
    await seedAll();
    for (const story of SEEDED) {
      const { file } = await persona(story.key);
      const loaded = await loadLoanFile(file.id);
      const me = loaded!.borrowers[0]!;
      expect(`${story.key}: ${me.firstName}`).not.toContain(" and ");
      // And the row still has to name whoever opens it, or a tester clicks one
      // person and reads another person's file.
      expect([story.key, story.name.first.split(" ")[0], story.name.last]).toEqual([
        story.key,
        me.firstName,
        me.lastName,
      ]);
    }
  });

  it("gives every persona a file the product can read and assess", async () => {
    await seedAll();
    for (const story of SEEDED) {
      const { file } = await persona(story.key);
      const loaded = await loadLoanFile(file.id);
      expect(loaded).not.toBeNull();
      // Would throw ProjectionError if a party's facts could not name a person.
      expect(assessAll(loaded!).length).toBeGreaterThan(0);
      expect(file.isDemo).toBe(true);
    }
  });

  it("states a housing basis only where a sample borrower answered for one", async () => {
    // The seed used to derive one from the loan purpose — a purchase meant a
    // renter — and write it to the column, to `monthly_rent` and to a
    // `current_housing` fact. That is the fabrication the column, the route and
    // screen 2 stopped manufacturing, wearing a seed script. It also left the
    // derived column asserting a basis with no `du_residences` row behind it,
    // which is the one thing that column is not allowed to do.
    //
    // Everybody on a sample file answers the declarations screen now, each
    // for themselves — Dev included, since he arrived through the claim with
    // a principal of his own. So each of them HAS a basis, and this is the
    // assertion that says the column is still derived rather than
    // manufactured: every stated basis has the row that person's own answer
    // created behind it.
    await seedAll();

    const stated = await prisma.borrower.findMany({
      where: { currentHousing: { not: null } },
      select: { partyId: true, currentHousing: true, loanFileId: true },
    });
    expect(stated).toHaveLength(SEEDED.length + 1);

    for (const borrower of stated) {
      const residence = await prisma.duResidence.findFirst({
        where: {
          residencyType: "Current",
          applicationParty: {
            partyId: borrower.partyId,
            application: { loanFileId: borrower.loanFileId },
          },
        },
        select: { basis: true },
      });
      expect(residence, borrower.partyId).not.toBeNull();
      expect(HOUSING_FOR_BASIS[residence!.basis]).toBe(borrower.currentHousing);
    }

    // And nobody is left manufactured OR silent: a borrower with no basis
    // would be one the seed walked past a screen it never put to them.
    expect(await prisma.borrower.count({ where: { currentHousing: null } })).toBe(0);

    // The fact predicate stays empty: the column is derived from the table,
    // and a third store of the same answer is what this rule refuses.
    expect(await prisma.fact.count({ where: { predicate: "current_housing" } })).toBe(0);
  });

  it("answers every declaration question for every sample borrower", async () => {
    // Six borrower-input rows landed in the registry with the declarations
    // screen. A persona who had not answered would carry all six as
    // outstanding work forever — eight sample files reading "needs you" for a
    // screen behind them, none of them showing the state they were built to
    // show. There are no real applications to migrate; these eight are what
    // the team demonstrates with.
    await seedAll();
    for (const story of SEEDED) {
      const { file } = await persona(story.key);
      const loaded = await loadLoanFile(file.id);
      expect(loaded!.borrowers[0]!.declaration, story.key).not.toBeNull();
      const outstanding = assessAll(loaded!)
        .filter((a) => a.applies === true && a.satisfaction.status !== "satisfied")
        .map((a) => a.requirement.id);
      expect(outstanding, story.key).not.toContain("APP-022");
      expect(outstanding, story.key).not.toContain("APP-023");
      expect(outstanding, story.key).not.toContain("APP-026");
    }
  });
});

/** The two vocabularies the derived column has to agree across. */
const HOUSING_FOR_BASIS: Record<string, string> = {
  Own: "own",
  Rent: "rent",
  LivingRentFree: "rent_free",
};

describe("each persona is the state their story describes", () => {
  it("leaves Maya with no bank and Ben with one and no decision", async () => {
    await seedAll();
    const maya = await persona("maya_okafor");
    expect(
      await prisma.connectorSnapshot.count({ where: { loanFileId: maya.file.id, kind: "bank" } }),
    ).toBe(0);
    expect(await prisma.decision.count({ where: { loanFileId: maya.file.id } })).toBe(0);

    const ben = await persona("ben_castillo");
    expect(
      await prisma.connectorSnapshot.count({ where: { loanFileId: ben.file.id, kind: "bank" } }),
    ).toBe(1);
    // Nobody has asked the engine, which is what "we're working on it" means.
    expect(await prisma.decision.count({ where: { loanFileId: ben.file.id } })).toBe(0);
  });

  it("puts two people on Priya's application, with Priya first", async () => {
    await seedAll();
    const { file, application } = await persona("priya_dev_raman");
    expect(application.parties).toHaveLength(2);
    expect(application.parties.map((p) => p.role).sort()).toEqual([
      "CO_BORROWER",
      "PRIMARY_BORROWER",
    ]);

    // Everything reads `borrowers[0]` as the person whose request this is, and
    // the purpose token is minted for that party. Dev first would mint Priya's
    // credit pull under his authorization.
    const loaded = await loadLoanFile(file.id);
    expect(loaded!.borrowers[0]!.firstName).toBe("Priya");
    const primary = application.parties.find((p) => p.role === "PRIMARY_BORROWER")!;
    expect(loaded!.borrowers[0]!.partyId).toBe(primary.partyId);
    expect(loaded!.borrowers[1]!.firstName).toBe("Dev");

    // Her story names two things still to settle, in her words. No screen
    // renders `loan_conditions`, so the sign-in page is the only place a
    // tester reads them — and a story that named two while the engine raised
    // three would be the sign-in page describing a file that is not there.
    const conditions = await prisma.loanCondition.findMany({
      where: { loanFileId: file.id },
      orderBy: { requirementId: "asc" },
      select: { requirementId: true, owner: true },
    });
    expect(conditions.map((c) => c.requirementId)).toEqual(["INC-009", "UW-004"]);
    expect(conditions.every((c) => c.owner === "borrower")).toBe(true);
  });

  it("walks Dev through the invitation, the claim and his own half", async () => {
    // The household is the product's co-borrower flow, seeded through the
    // product's own services rather than built as two complete people by
    // hand — so what a tester signs in to as Dev is what a real co-borrower
    // would have left behind, and the sample cannot drift from the flow.
    await seedAll();
    const { file } = await persona("priya_dev_raman");
    const story = PERSONA_STORIES.find((s) => s.key === "priya_dev_raman");
    const who = story && isSeeded(story) ? story.coBorrower : undefined;
    expect(who?.key).toBe("priya_dev_raman:dev");

    // A sign-in of his own, whose party is the survivor of the one Priya
    // named: CLAIMED, marked as the seed's, with exactly one MERGED party
    // pointing at it — the provisional one the naming minted.
    const dev = await prisma.user.findUniqueOrThrow({
      where: { personaKey: who!.key },
      select: {
        id: true,
        partyId: true,
        party: { select: { claimStatus: true, sourceFirstSeen: true } },
      },
    });
    expect(dev.party).toEqual({ claimStatus: "CLAIMED", sourceFirstSeen: "persona_seed" });
    const folded = await prisma.party.findMany({
      where: { mergedIntoPartyId: dev.partyId! },
      select: { claimStatus: true, sourceFirstSeen: true },
    });
    expect(folded).toEqual([
      { claimStatus: "MERGED", sourceFirstSeen: "co_borrower_named_by_applicant" },
    ]);

    // The row the naming made is his now, and he has said who he is on it:
    // the last four are on the row and his date of birth is his own word.
    const loaded = (await loadLoanFile(file.id))!;
    expect(loaded.invitedBorrowers).toEqual([]);
    const his = loaded.borrowers[1]!;
    expect(his.partyId).toBe(dev.partyId);
    expect(his.ssn.last4).toBe("7745");
    const dob = await prisma.fact.findFirstOrThrow({
      where: { partyId: dev.partyId!, predicate: "date_of_birth", supersededById: null },
      select: { assertedBy: { select: { partyId: true } } },
    });
    expect(dob.assertedBy.partyId).toBe(dev.partyId);

    // The invitation went to his address and was taken by him.
    const invitation = await prisma.coBorrowerInvitation.findFirstOrThrow({
      where: { borrowerId: his.id },
      select: { acceptedAt: true, acceptedByPartyId: true, revokedAt: true, sentToEmail: true },
    });
    expect(invitation.acceptedAt).not.toBeNull();
    expect(invitation.revokedAt).toBeNull();
    expect(invitation.acceptedByPartyId).toBe(dev.partyId);
    expect(invitation.sentToEmail).toBe("priya_dev_raman.dev@personas.supermortgage.invalid");

    // Section 5 attested by him: neither staff's word nor Priya's.
    const declaration = await prisma.duDeclaration.findFirstOrThrow({
      where: { applicationParty: { partyId: dev.partyId!, application: { loanFileId: file.id } } },
      select: { assertedBy: { select: { kind: true, partyId: true } } },
    });
    expect(declaration.assertedBy).toEqual({ kind: "BORROWER", partyId: dev.partyId });

    // His signature is a consent row in his name beside his own 4506-C. The
    // file's own signature is Priya's alone, and hers is the column.
    const consents = await prisma.consent.findMany({
      where: { borrowerId: his.id, revokedAt: null },
      select: { kind: true },
      orderBy: { kind: "asc" },
    });
    expect(consents.map((c) => c.kind)).toEqual([
      "application_signature",
      "econsent",
      "form_4506c",
      "verification_authorization",
    ]);
    const signed = await prisma.loanFile.findUniqueOrThrow({
      where: { id: file.id },
      select: { applicationSignedAt: true },
    });
    expect(signed.applicationSignedAt).not.toBeNull();
    expect(
      await prisma.consent.count({
        where: { loanFileId: file.id, kind: "application_signature" },
      }),
    ).toBe(1);
    expect(
      await prisma.consent.count({
        where: { borrowerId: loaded.borrowers[0]!.id, kind: "application_signature" },
      }),
    ).toBe(0);
    // And his transcripts came back under his own grant, filed against him.
    expect(
      await prisma.connectorSnapshot.count({
        where: { loanFileId: file.id, kind: "irs", partyId: dev.partyId! },
      }),
    ).toBe(1);

    // The sign-in page offers him right under Priya, wearing the household's
    // state, and his row signs in as him.
    const listing = await callAs<{
      personas: { key: string; name: string; state: string | null; available: boolean }[];
    }>(dev.id, [authRouter], "GET", "/personas", undefined, "/api/auth");
    const keys = listing.body.personas.map((p) => p.key);
    expect(keys.indexOf(who!.key)).toBe(keys.indexOf("priya_dev_raman") + 1);
    expect(listing.body.personas.find((p) => p.key === who!.key)).toMatchObject({
      name: "Dev Raman",
      state: "conditionally_approved",
      available: true,
    });
    const session = await callAs<{ user: { id: string; persona: { key: string } | null } }>(
      dev.id,
      [authRouter],
      "POST",
      `/personas/${who!.key}`,
      {},
      "/api/auth",
    );
    expect(session.status).toBe(201);
    expect(session.body.user.id).toBe(dev.id);
    expect(session.body.user.persona?.key).toBe(who!.key);
  });

  it("retires Tom's own terms with the ones we can do", async () => {
    await seedAll();
    const { application } = await persona("tom_nguyen");
    const byseq = [...application.scenarios].sort((a, b) => a.seq - b.seq);
    expect(byseq.map((s) => `${s.seq}:${s.origin}:${s.isActive}`)).toEqual([
      "1:BORROWER:false",
      "2:COUNTEROFFER:true",
    ]);
  });

  it("opens Aisha's written-reasons clock and records why", async () => {
    await seedAll();
    const { file, application } = await persona("aisha_bello");
    const ecoa = application.clocks.filter((c) => c.kind === "ECOA_ADVERSE_ACTION_30D");
    expect(ecoa).toHaveLength(1);
    expect(ecoa[0]!.tolledFrom).not.toBeNull();
    const decision = await prisma.decision.findFirstOrThrow({
      where: { loanFileId: file.id },
      orderBy: { computedAt: "desc" },
      select: { outcome: true, adverseActionReasons: true },
    });
    expect(decision.outcome).toBe("denied");
    expect(decision.adverseActionReasons.length).toBeGreaterThan(0);
  });

  it("lets Lena withdraw as herself, and nothing move her afterwards", async () => {
    await seedAll();
    const { application } = await persona("lena_fischer");
    const last = application.transitions.at(-1)!;
    expect(last.event).toBe("borrower_withdrew");
    expect(last.actor.kind).toBe("BORROWER");
    expect(last.reasonCode).toBe("borrower_requested");

    // Terminal is terminal. The machine has no edge out, and the database
    // refuses a raw one.
    await expect(
      transition({
        applicationId: application.id,
        event: "ops_canceled",
        actorPrincipalId: last.actorPrincipalId,
      }),
    ).rejects.toThrow();
  });

  it("says on Marcus's own ledger that his last three steps were recorded by hand", async () => {
    await seedAll();
    const { application } = await persona("marcus_hale");
    const tail = application.transitions.slice(-3);
    expect(tail.map((t) => t.event)).toEqual([
      "disclosures_complete",
      "closing_began",
      "disbursed",
    ]);
    for (const row of tail) {
      expect(row.actor.kind).toBe("STAFF");
      expect(row.actor.subject).toBe("staff:persona_seed");
      expect(row.reasonCode).toBe("persona_fixture");
    }
  });

  it("holds Omar on evidence that agrees with the pill", async () => {
    await seedAll();
    const { file, application } = await persona("omar_haddad");
    expect(toDomainState(application.status)).toBe("suspended");
    expect(file.sanctionsScreenClear).toBe(false);
    const snapshot = await prisma.connectorSnapshot.findFirstOrThrow({
      where: { loanFileId: file.id, kind: "sanctions" },
      orderBy: { retrievedAt: "desc" },
      select: { payload: true },
    });
    const screening = snapshot.payload as unknown as SanctionsScreening;
    expect(screening.clear).toBe(false);
    expect(screening.matches.length).toBe(1);
    const hold = application.transitions.at(-1)!;
    expect(hold.event).toBe("third_party_blocked");
    expect(hold.reasonCode).toBe("sanctions_near_match");
  });
});

describe("what the seed refuses to do", () => {
  it("will not run where the sample sign-in is not mounted", async () => {
    const was = process.env.DEMO_PERSONAS;
    process.env.DEMO_PERSONAS = "false";
    try {
      await expect(seedAll()).rejects.toThrow(/DEMO_PERSONAS/);
      expect(await prisma.user.count()).toBe(0);
    } finally {
      process.env.DEMO_PERSONAS = was;
    }
  });

  it("commits nothing for a persona that does not land on its target", async () => {
    const maya = SEEDED.find((s) => s.key === "maya_okafor")!;
    // The same walk, told to expect somewhere it cannot reach. The assertion
    // is inside the transaction, so the whole persona rolls back — which is
    // the difference between a deploy that fails and a deploy that succeeds
    // with a wrong state on a public page forever after.
    await expect(seedAll([{ ...maya, target: "funded" }])).rejects.toThrow(/drift/);
    expect(await prisma.user.count({ where: { personaKey: "maya_okafor" } })).toBe(0);
    expect(await prisma.application.count()).toBe(0);
    expect(await prisma.party.count()).toBe(0);
    expect(await prisma.loanFile.count()).toBe(0);
  });

  it("reports a drift on a re-run rather than skipping past it", async () => {
    await seedAll();
    const { application } = await persona("maya_okafor");
    // Somebody moved her by hand, the way staff eventually will.
    await transition({
      applicationId: application.id,
      event: "ops_canceled",
      actorPrincipalId: await principalForParty(
        prisma,
        (await persona("maya_okafor")).user.partyId!,
      ),
    });
    const reports = await seedAll();
    const maya = reports.find((r) => r.key === "maya_okafor")!;
    expect(maya.result).toBe("drift");
    expect(maya.state).toBe("canceled");
    expect(maya.expected).toBe("awaiting_borrower");
  });
});

describe("clearing personas out", () => {
  it("re-creates one persona, and its co-borrower, without touching the others", async () => {
    await seedAll();
    const before = await census();
    const household = ["priya_dev_raman", "priya_dev_raman:dev"];
    const untouched = await prisma.user.findMany({
      where: { personaKey: { notIn: household } },
      select: { id: true, personaKey: true },
      orderBy: { personaKey: "asc" },
    });

    await resetPersona("priya_dev_raman");
    expect(await prisma.user.findUnique({ where: { personaKey: "priya_dev_raman" } })).toBeNull();
    // Dev's sign-in goes with the household, and with it his party and the
    // one Priya named, folded into his by the claim: three parties, not two.
    expect(
      await prisma.user.findUnique({ where: { personaKey: "priya_dev_raman:dev" } }),
    ).toBeNull();
    expect(await prisma.party.count()).toBe(before.parties - 3);
    expect(
      await prisma.user.findMany({
        where: { personaKey: { notIn: household } },
        select: { id: true, personaKey: true },
        orderBy: { personaKey: "asc" },
      }),
    ).toEqual(untouched);

    const again = await seedAll();
    expect(again.find((r) => r.key === "priya_dev_raman")!.result).toBe("seeded");
    for (const report of again) {
      if (report.key === "priya_dev_raman" || report.key === "grander_import") continue;
      expect(`${report.key}: ${report.result}`).toBe(`${report.key}: exists`);
    }
    expect(await census()).toEqual(before);
  });

  it("removes what the old demo seed left, and nothing else", async () => {
    await seedAll();
    const before = await census();
    // What `seed-demo.ts` used to write: a file nobody owns, and a party it
    // minted for the borrower row on it.
    const legacyFile = await prisma.loanFile.create({
      data: { isDemo: true, stage: "DECISION" },
      select: { id: true },
    });
    const legacyParty = await prisma.party.create({
      data: { kind: "PERSON", claimStatus: "CLAIMED", sourceFirstSeen: "demo_seed" },
      select: { id: true },
    });

    expect(await purgeLegacyDemo()).toEqual({ files: 1, parties: 1 });
    expect(await prisma.loanFile.findUnique({ where: { id: legacyFile.id } })).toBeNull();
    expect(await prisma.party.findUnique({ where: { id: legacyParty.id } })).toBeNull();
    // Every persona is still standing: their files have owners.
    expect(await census()).toEqual(before);
    expect(await prisma.party.count({ where: { sourceFirstSeen: "demo_seed" } })).toBe(0);
  });
});

/** The seed's own source, for the two claims below that only it can settle. */
const seedSource = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "..", "scripts", "seed-personas.ts"), "utf8");
  expect(source, "the seed moved").toContain("export async function seedAll");
  return source;
};

describe("the guard on which borrower sorts first", () => {
  /**
   * A check placed where it cannot fail is not a check.
   *
   * The thing being guarded is that `borrowers[0]` on Priya's file is Priya:
   * the purpose token is minted for that party, so Dev sorting first would
   * pull her credit under his authorization. The order is decided by
   * `application_parties.borrower_ordinal`, so the guard has to stand after
   * the membership that allocates Dev's — and after his row, which has to
   * exist first. Asked before either, the answer is the primary by
   * construction and the guard passes forever.
   */
  it("stands after the position that decides the order, and before any pull", () => {
    // The position is decided by the claim now: naming puts Dev on the
    // application, and accepting the invitation moves that seat onto the
    // party his own sign-in made. The guard reads the file after the claim
    // and before anything is pulled in his name.
    const source = seedSource();
    const named = source.indexOf("const named = await nameCoBorrower(");
    const claimed = source.indexOf("const claimed = await acceptClaim(token, user.id, w.tx);");
    const guard = source.indexOf("the co-borrower holds the lower borrower_ordinal");
    const onward = source.indexOf(
      'grantConsent(w.tx, w.loanFileId, named.borrowerId, "verification_authorization")',
    );
    expect(named).toBeGreaterThan(-1);
    expect(claimed).toBeGreaterThan(named);
    expect(guard).toBeGreaterThan(claimed);
    expect(onward).toBeGreaterThan(guard);
  });

  it("asks the reader itself, rather than a copy of its ordering", () => {
    // An `orderBy` written out here could drift from the one `loadLoanFile`
    // uses, and then the guard would be checking a rule nothing else follows.
    expect(seedSource()).toContain("await loadLoanFile(w.loanFileId, w.tx)");
  });
});

describe("a failing run keeps its report", () => {
  /**
   * The deploy captures this script's stdout through a subshell and echoes it
   * back before deciding anything, so on the one run that matters the report
   * IS the failure message. `process.exit` abandons a pipe that is still
   * draining, which would throw away the DRIFT line naming the persona.
   */
  it("drains stdout before it leaves non-zero", () => {
    const source = seedSource();
    expect(source).toContain("async function failAfterFlush()");
    expect(source).toContain('process.stdout.write("", () => resolve())');
    expect(source).toContain(
      'if (reports.some((r) => r.result === "drift")) await failAfterFlush();',
    );
    // One exit in the file, and it is the one inside the drain.
    expect(source.match(/process\.exit\(1\)/g) ?? []).toHaveLength(1);
  });
});

describe("the deploy step that runs the seed", () => {
  /**
   * The step is the only place the seed ever runs unattended, and its whole
   * job on a bad day is to say WHICH persona drifted and where it stood.
   *
   * A workflow `run:` block is executed under `bash -e`. Assigning a command
   * substitution — `OUT=$(docker run …)` — takes the container's exit status,
   * so the shell aborts at the assignment the moment the seed exits non-zero
   * and the `echo` below it never runs: the deploy fails with an empty log on
   * exactly the failure the step exists to catch. Read out of the file,
   * because nothing else here can run a workflow.
   */
  const step = (): string => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
    const yaml = readFileSync(join(root, ".github", "workflows", "deploy.yml"), "utf8");
    const start = yaml.indexOf("- name: Seed the sample borrowers");
    expect(start, "the deploy no longer seeds the sample borrowers").toBeGreaterThan(-1);
    const end = yaml.indexOf("\n      - name:", start);
    return yaml.slice(start, end === -1 ? undefined : end);
  };

  it("prints what the seed said before it decides anything", () => {
    const body = step();
    const run = body.indexOf("OUT=$(");
    expect(body.indexOf("set +e")).toBeGreaterThan(-1);
    expect(body.indexOf("set +e")).toBeLessThan(run);
    expect(body.indexOf("code=$?")).toBeGreaterThan(run);
    expect(body.indexOf('echo "$OUT"')).toBeLessThan(body.indexOf('test "$code" -eq 0'));
  });

  it("fails when the seed fails, and counts a row for every story", () => {
    const body = step();
    // The script exits non-zero on a drift, so its own status carries that.
    expect(body).toContain('test "$code" -eq 0');
    expect(body).toContain(`-eq ${PERSONA_STORIES.length}`);
    expect(body).toContain("node apps/api/dist/scripts/seed-personas.js");
    expect(body).toContain("DEMO_PERSONAS=true");
  });
});
