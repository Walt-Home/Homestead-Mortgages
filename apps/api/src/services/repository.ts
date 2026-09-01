/**
 * Loading a loan file out of Postgres and into the domain shape.
 *
 * The engine, the connectors and the UI all speak `LoanFile` from
 * `@hm/shared`. Prisma rows are a storage detail, and this module is the only
 * place the two meet. Everything above it can be tested with a plain object.
 *
 * Connector data is read from the LATEST snapshot per kind. Older snapshots
 * stay in the table on purpose — they are what a re-evaluation diffs against
 * once the monitoring loop exists.
 */

import { prisma } from "@hm/db";
import type {
  AssetReport,
  Borrower,
  Consent,
  CreditReport,
  Decision,
  DisclosureRecord,
  LoanFile,
  PayrollData,
  TaxTranscript,
} from "@hm/shared";
import type { Prisma } from "@hm/db";
import { AppError } from "../middleware/error-handler.js";

/** Prisma returns Decimal; the domain uses number. One place to convert. */
function num(value: Prisma.Decimal | null): number | null {
  return value === null ? null : Number(value);
}

function numOr(value: Prisma.Decimal | null, fallback: number): number {
  return value === null ? fallback : Number(value);
}

const PURPOSE_TO_DOMAIN = {
  PURCHASE: "purchase",
  RATE_TERM_REFINANCE: "rate_term_refinance",
  CASH_OUT_REFINANCE: "cash_out_refinance",
} as const;

const STAGE_TO_DOMAIN = {
  PROPERTY_LOAN: "property_loan",
  IDENTITY: "identity",
  CREDIT: "credit",
  BANK: "bank",
  PAYROLL: "payroll",
  IRS_TRANSCRIPT: "irs_transcript",
  UPLOAD_FALLBACK: "upload_fallback",
  DECISION: "decision",
  PERSISTENT_CONSENT: "persistent_consent",
  COMPLETE: "complete",
} as const;

export async function loadLoanFile(id: string): Promise<LoanFile | null> {
  const row = await prisma.loanFile.findUnique({
    where: { id },
    include: {
      borrowers: true,
      consents: true,
      links: true,
      documents: true,
      disclosures: true,
      incomeSources: true,
      employments: true,
      decisions: { orderBy: { computedAt: "desc" }, take: 1 },
      // One extra per kind is enough to build the current view; history stays
      // in the table for the diff the monitoring loop will need.
      snapshots: { orderBy: { retrievedAt: "desc" } },
    },
  });
  if (!row) return null;

  const latest = <T>(kind: string): T | null => {
    const snapshot = row.snapshots.find((s) => s.kind === kind);
    return snapshot ? (snapshot.payload as T) : null;
  };

  const borrowers: Borrower[] = row.borrowers.map((b) => ({
    id: b.id,
    firstName: b.firstName,
    lastName: b.lastName,
    dateOfBirth: b.dateOfBirth.toISOString().slice(0, 10),
    ssn: { last4: b.ssnLast4, vaultHandle: b.ssnVaultHandle },
    email: b.email,
    phone: b.phone,
    currentAddress: {
      line1: b.addressLine1,
      line2: b.addressLine2 ?? undefined,
      city: b.addressCity,
      state: b.addressState,
      postalCode: b.addressPostalCode,
    },
    maritalStatus: b.maritalStatus as Borrower["maritalStatus"],
    nonBorrowingSpouseName: b.nonBorrowingSpouseName ?? undefined,
    nonBorrowingSpouseSignatureRequired: b.nonBorrowingSpouseSignatureRequired,
    preferredLanguage: b.preferredLanguage,
    demographics: (b.demographics as Borrower["demographics"]) ?? null,
    firstTimeHomebuyer: b.firstTimeHomebuyer,
    isMilitary: b.isMilitary,
    currentHousing: b.currentHousing as Borrower["currentHousing"],
    monthlyRent: num(b.monthlyRent) ?? undefined,
  }));

  const consents: Consent[] = row.consents.map((c) => ({
    kind: c.kind as Consent["kind"],
    borrowerId: c.borrowerId,
    grantedAt: c.grantedAt.toISOString(),
    revokedAt: c.revokedAt?.toISOString(),
    envelopeId: c.envelopeId ?? undefined,
    ipAddress: c.ipAddress,
    userAgent: c.userAgent,
  }));

  const decisionRow = row.decisions[0];
  const decision: Decision | null = decisionRow
    ? {
        outcome: decisionRow.outcome as Decision["outcome"],
        computedAt: decisionRow.computedAt.toISOString(),
        aus: {
          casefileId: decisionRow.ausCasefileId,
          submittedAt: decisionRow.computedAt.toISOString(),
          recommendation: decisionRow.ausRecommendation as never,
          findings: decisionRow.ausFindings as never,
          engine: decisionRow.ausEngine as never,
          engineVersion: decisionRow.ausEngineVersion,
        },
        ratios: decisionRow.ratios as never,
        reserves: decisionRow.reserves as never,
        compliance: decisionRow.compliance as never,
        pricing: decisionRow.pricing as never,
        conditions: [],
        derivations: decisionRow.derivations as never,
        adverseActionReasons: decisionRow.adverseActionReasons.length
          ? decisionRow.adverseActionReasons
          : undefined,
      }
    : null;

  const conditions = await prisma.loanCondition.findMany({ where: { loanFileId: id } });

  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    stage: STAGE_TO_DOMAIN[row.stage],

    property:
      row.propertyLine1 && row.propertyCity && row.propertyState
        ? {
            address: {
              line1: row.propertyLine1,
              line2: row.propertyLine2 ?? undefined,
              city: row.propertyCity,
              state: row.propertyState,
              postalCode: row.propertyPostalCode ?? "",
            },
            deliverableAddressVerified: row.addressVerified,
            propertyType: (row.propertyType ?? "single_family") as never,
            occupancy: (row.occupancy ?? "primary_residence") as never,
            valueOrPrice: numOr(row.valueOrPrice, 0),
            valuationSource: (row.valuationSource ?? "borrower_stated") as never,
            financedPropertyCount: row.financedPropertyCount,
          }
        : null,

    loan: row.purpose
      ? {
          purpose: PURPOSE_TO_DOMAIN[row.purpose],
          loanAmount: numOr(row.loanAmount, 0),
          downPayment: numOr(row.downPayment, 0),
          cashToBorrower: num(row.cashToBorrower) ?? undefined,
          cashOutPurpose: row.cashOutPurpose ?? undefined,
          juniorLienBalance: numOr(row.juniorLienBalance, 0),
          juniorLienCreditLimit: numOr(row.juniorLienCreditLimit, 0),
          interestedPartyContributions: numOr(row.interestedPartyContributions, 0),
          existingLoan: row.existingServicer
            ? {
                servicer: row.existingServicer,
                loanNumber: row.existingLoanNumber ?? "",
                balance: numOr(row.existingBalance, 0),
                rate: numOr(row.existingRate, 0),
                monthlyPayment: numOr(row.existingMonthlyPayment, 0),
              }
            : undefined,
        }
      : null,

    product: row.productCode
      ? {
          productCode: row.productCode,
          termMonths: row.termMonths ?? 360,
          amortization: (row.amortization ?? "fixed") as never,
          noteRate: numOr(row.noteRate, 0),
          overlays: row.overlays,
        }
      : null,

    borrowers,
    consents,

    application: row.applicationReceivedAt
      ? {
          receivedAt: row.applicationReceivedAt.toISOString(),
          sixPieces: row.applicationSixPieces as never,
        }
      : null,

    credit: latest<CreditReport>("credit"),
    assets: latest<AssetReport>("bank"),
    payroll: latest<PayrollData>("payroll"),
    transcripts: latest<readonly TaxTranscript[]>("irs") ?? [],

    incomeSources: row.incomeSources.map((s) => ({
      type: s.type as never,
      monthlyAmount: Number(s.monthlyAmount),
      historyMonths: s.historyMonths,
      continuanceEndDate: s.continuanceEndDate?.toISOString().slice(0, 10),
      continuanceEstablished: s.continuanceEstablished,
      evidenceDocumentIds: s.evidenceDocumentIds,
    })),

    employment: row.employments.map((e) => ({
      employerName: e.employerName,
      employerEin: e.employerEin ?? undefined,
      position: e.position,
      startDate: e.startDate.toISOString().slice(0, 10),
      endDate: e.endDate?.toISOString().slice(0, 10),
      status: e.status as never,
      isMilitary: e.isMilitary,
      verificationMethod: e.verificationMethod as never,
    })),

    documents: row.documents.map((d) => ({
      id: d.id,
      filename: d.filename,
      contentType: d.contentType,
      bytes: d.bytes,
      uploadedAt: d.uploadedAt.toISOString(),
      satisfiesRequirementId: d.satisfiesRequirementId,
      storageUri: d.storageUri,
    })),

    disclosures: row.disclosures.map(
      (d): DisclosureRecord => ({
        kind: d.kind as DisclosureRecord["kind"],
        deliveredAt: d.deliveredAt.toISOString(),
        method: d.method as DisclosureRecord["method"],
        documentId: d.documentId,
      }),
    ),

    links: row.links.map((l) => ({
      kind: l.kind as never,
      provider: l.provider,
      linkedAt: l.linkedAt.toISOString(),
      lastSyncedAt: l.lastSyncedAt.toISOString(),
      status: l.status as never,
      persistentMonitoringEnabled: l.persistentMonitoringEnabled,
    })),

    decision: decision
      ? {
          ...decision,
          conditions: conditions.map((c) => ({
            id: c.id,
            requirementId: c.requirementId,
            description: c.description,
            status: c.status as never,
            issuedAt: c.issuedAt.toISOString(),
            clearedAt: c.clearedAt?.toISOString(),
            documentIds: c.documentIds,
            owner: c.owner as never,
          })),
        }
      : null,

    sanctionsScreenClear: row.sanctionsScreenClear,
    ssnValidatedWithSsa: row.ssnValidatedWithSsa,
    fraudReviewComplete: row.fraudReviewComplete,
    intentToProceedAt: row.intentToProceedAt?.toISOString() ?? null,
    deliveryMethod: row.deliveryMethod as LoanFile["deliveryMethod"],
  };
}

/** Append an event. Every state change in the product writes one. */
export async function recordEvent(
  loanFileId: string,
  kind: string,
  actor: string,
  payload: unknown,
  requirementId?: string,
): Promise<void> {
  await prisma.fileEvent.create({
    data: {
      loanFileId,
      kind,
      actor,
      requirementId: requirementId ?? null,
      payload: payload as Prisma.InputJsonValue,
    },
  });
}

/** Store verbatim connector output. Append-only — never an update. */
export async function recordSnapshot(
  loanFileId: string,
  kind: string,
  provider: string,
  externalId: string,
  payload: unknown,
  retrievedAt: string,
): Promise<void> {
  await prisma.connectorSnapshot.create({
    data: {
      loanFileId,
      kind,
      provider,
      externalId,
      payload: payload as Prisma.InputJsonValue,
      retrievedAt: new Date(retrievedAt),
    },
  });
}

/* ── Access control ───────────────────────────────────────────────────────── */

/**
 * Decide whether this user may touch this file, and refuse if not.
 *
 * Refusals are **404, not 403**, and deliberately so: a 403 confirms that a
 * file with that id exists, which hands an enumeration oracle to anyone with a
 * session. The only thing a caller learns is "not yours."
 *
 * Demo files are readable by everyone signed in and writable by no one. They
 * exist so the team has a shared artifact to critique without anybody's real
 * file becoming shared — a data model that would have to be unwound later.
 */
export async function assertFileAccess(
  loanFileId: string,
  userId: string,
  mode: "read" | "write",
): Promise<void> {
  const file = await prisma.loanFile.findUnique({
    where: { id: loanFileId },
    select: { userId: true, isDemo: true },
  });

  if (!file) throw new AppError(404, "Loan file not found", "NOT_FOUND");

  if (file.isDemo) {
    if (mode === "read") return;
    throw new AppError(
      403,
      "Demo files are read-only. Start your own to walk the flow.",
      "DEMO_FILE_READ_ONLY",
    );
  }

  if (file.userId !== userId) throw new AppError(404, "Loan file not found", "NOT_FOUND");
}

/** Files this user may see: their own, newest first, plus the shared demo set. */
export async function listAccessibleFiles(userId: string) {
  return prisma.loanFile.findMany({
    where: { OR: [{ userId }, { isDemo: true }] },
    orderBy: [{ isDemo: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      stage: true,
      isDemo: true,
      createdAt: true,
      purpose: true,
      loanAmount: true,
      valueOrPrice: true,
      propertyCity: true,
      propertyState: true,
      borrowers: { select: { firstName: true, lastName: true }, take: 1 },
      decisions: {
        orderBy: { computedAt: "desc" },
        take: 1,
        select: { outcome: true, ausRecommendation: true },
      },
    },
  });
}
