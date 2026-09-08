/**
 * Seed one complete loan file per fixture persona.
 *
 * Runs the whole flow through the real routes' logic — consents, all four
 * connectors, the decision — so a demo does not require clicking, and so the
 * three personas can be compared side by side.
 *
 *   npx tsx apps/api/src/scripts/seed-demo.ts
 */

import { randomUUID } from "node:crypto";
import { prisma } from "@hm/db";
import type { Prisma } from "@hm/db";
import { fixtureRegistry, PERSONAS, type PersonaId } from "@hm/connectors";
import { progress } from "@hm/requirements";
import { underwrite } from "@hm/underwriting";
import { loadLoanFile, recordEvent, recordSnapshot } from "../services/repository.js";
import { config } from "../config.js";
import { tokenFor } from "../services/authorization.js";

const PURPOSE_TO_DB = {
  purchase: "PURCHASE",
  rate_term_refinance: "RATE_TERM_REFINANCE",
  cash_out_refinance: "CASH_OUT_REFINANCE",
} as const;

async function seed(personaId: PersonaId): Promise<void> {
  const persona = PERSONAS[personaId];
  const s = persona.scenario;
  const registry = fixtureRegistry({ persona: personaId, latencyMs: 0 });
  const [firstName = "Demo", lastName = "Borrower"] =
    persona.label.split(" — ")[0]?.split(" ") ?? [];

  const created = await prisma.loanFile.create({
    data: {
      // No owner and isDemo: readable by everyone signed in, writable by no
      // one. See assertFileAccess — isDemo wins over ownership, so these stay
      // read-only even for whoever ran the seed.
      isDemo: true,
      stage: "DECISION",
      purpose: PURPOSE_TO_DB[s.purpose],
      loanAmount: s.loanAmount,
      downPayment: s.downPayment,
      propertyLine1: "1 Fixture Street",
      propertyCity: "Demo City",
      propertyState: s.state,
      propertyPostalCode: "00000",
      propertyType: s.propertyType,
      occupancy: s.occupancy,
      valueOrPrice: s.valueOrPrice,
      valuationSource: "attom_estimate",
      addressVerified: true,
      productCode: config.defaultProduct.code,
      termMonths: config.defaultProduct.termMonths,
      amortization: "fixed",
      noteRate: config.defaultProduct.noteRate,
      sanctionsScreenClear: true,
      applicationReceivedAt: new Date(),
      applicationSixPieces: {
        name: true,
        income: true,
        ssn: true,
        propertyAddress: true,
        valueEstimate: true,
        loanAmount: true,
      } as unknown as Prisma.InputJsonValue,
      borrowers: {
        create: {
          firstName,
          lastName,
          email: `${personaId}@fixture.invalid`,
          phone: "555-0100",
          dateOfBirth: new Date("1988-04-12"),
          ssnLast4: "4321",
          // Fixture handle. No SSN exists for these borrowers at all.
          ssnVaultHandle: `vault:fixture:${personaId}`,
          addressLine1: "9 Fixture Road",
          addressCity: "Demo City",
          addressState: s.state,
          addressPostalCode: "00000",
          maritalStatus: "unmarried",
          preferredLanguage: "en",
          firstTimeHomebuyer: true,
          currentHousing: "rent",
          monthlyRent: 2_000,
          demographics: {
            ethnicity: "declined",
            race: "declined",
            sex: "declined",
            visualObservationNoted: false,
          } as unknown as Prisma.InputJsonValue,
        },
      },
    },
    include: { borrowers: true },
  });

  const borrowerId = created.borrowers[0]!.id;
  const now = new Date();
  for (const kind of ["verification_authorization", "econsent", "form_4506c"] as const) {
    await prisma.consent.create({
      data: {
        loanFileId: created.id,
        borrowerId,
        kind,
        grantedAt: now,
        ipAddress: "127.0.0.1",
        userAgent: "seed",
      },
    });
  }

  let file = (await loadLoanFile(created.id))!;

  const credit = await registry.credit.pullTriMerge(file, await tokenFor(file, "credit_report"));
  await recordSnapshot(
    created.id,
    "credit",
    credit.provider,
    credit.externalId,
    credit.data,
    credit.retrievedAt,
  );

  const bankOutcome = await registry.bank.fetchAssetReport(
    file,
    await tokenFor(file, "bank_transactions"),
    { sessionId: "seed" },
    12,
  );
  if (bankOutcome.status !== "ready") {
    throw new Error("The fixture bank connector must answer immediately.");
  }
  const bank = bankOutcome.result;
  await recordSnapshot(
    created.id,
    "bank",
    bank.provider,
    bank.externalId,
    bank.data,
    bank.retrievedAt,
  );

  const payroll = await registry.payroll.fetchPayroll(
    file,
    await tokenFor(file, "payroll_income"),
    "seed",
  );
  await recordSnapshot(
    created.id,
    "payroll",
    payroll.provider,
    payroll.externalId,
    payroll.data,
    payroll.retrievedAt,
  );

  await prisma.employment.createMany({
    data: payroll.data.employments.map((e) => ({
      loanFileId: created.id,
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
  await prisma.incomeSource.createMany({
    data: payroll.data.incomeSources.map((s2) => ({
      loanFileId: created.id,
      type: s2.type,
      monthlyAmount: s2.monthlyAmount,
      historyMonths: s2.historyMonths,
      continuanceEstablished: s2.continuanceEstablished,
      evidenceDocumentIds: [...s2.evidenceDocumentIds],
    })),
  });

  file = (await loadLoanFile(created.id))!;
  const irs = await registry.irs.fetchTranscripts(file, await tokenFor(file, "tax_transcript"), []);
  await recordSnapshot(created.id, "irs", irs.provider, irs.externalId, irs.data, irs.retrievedAt);

  for (const kind of ["credit", "bank", "payroll", "irs"] as const) {
    await prisma.connectorLink.create({
      data: {
        loanFileId: created.id,
        kind,
        provider: `fixture-${kind}`,
        linkedAt: now,
        lastSyncedAt: now,
      },
    });
  }

  file = (await loadLoanFile(created.id))!;
  const decision = underwrite(file, { casefileId: randomUUID(), now: new Date().toISOString() });

  await prisma.decision.create({
    data: {
      loanFileId: created.id,
      outcome: decision.outcome,
      computedAt: new Date(decision.computedAt),
      ausEngine: decision.aus!.engine,
      ausEngineVersion: decision.aus!.engineVersion,
      ausCasefileId: decision.aus!.casefileId,
      ausRecommendation: decision.aus!.recommendation,
      ausFindings: decision.aus!.findings as unknown as Prisma.InputJsonValue,
      ratios: decision.ratios as unknown as Prisma.InputJsonValue,
      reserves: decision.reserves as unknown as Prisma.InputJsonValue,
      compliance: decision.compliance as unknown as Prisma.InputJsonValue,
      pricing: decision.pricing as unknown as Prisma.InputJsonValue,
      derivations: decision.derivations as unknown as Prisma.InputJsonValue,
      adverseActionReasons: [...(decision.adverseActionReasons ?? [])],
    },
  });
  await recordEvent(created.id, "decision_computed", "seed", { outcome: decision.outcome });

  const p = progress((await loadLoanFile(created.id))!);
  console.log(`\n${persona.label}`);
  console.log(`  file            ${created.id}`);
  console.log(
    `  loan            $${s.loanAmount.toLocaleString()} on $${s.valueOrPrice.toLocaleString()}`,
  );
  console.log(`  outcome         ${decision.outcome} (${decision.aus!.recommendation})`);
  console.log(
    `  DTI / LTV       ${decision.ratios.dtiBack ?? "—"}% / ${decision.ratios.ltv ?? "—"}%`,
  );
  console.log(
    `  requirements    ${p.satisfied} satisfied, ${p.outstanding} needed, ${p.blocked} waiting`,
  );
  console.log(`  findings        ${decision.aus!.findings.length}`);
  console.log(`  expected        ${s.expectation}`);
}

async function main(): Promise<void> {
  // Re-seeding replaces the demo set rather than accumulating copies of it.
  // Only demo files are touched; nobody's real file is in this query.
  const removed = await prisma.loanFile.deleteMany({ where: { isDemo: true } });
  if (removed.count) console.log(`removed ${removed.count} existing demo file(s)`);

  for (const id of Object.keys(PERSONAS) as PersonaId[]) {
    await seed(id);
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
