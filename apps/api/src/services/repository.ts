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
  PropertyRecord,
  AvmEstimate,
  FloodDetermination,
  SanctionsScreening,
  LienSearch,
} from "@hm/shared";
import { TERMINAL } from "@hm/shared";
import type { Prisma } from "@hm/db";
import { AppError } from "../middleware/error-handler.js";
import { displayNameFrom, factMapsByParty, requireIdentity } from "./borrower-projection.js";
import type { Db } from "./db.js";
import { liveFactsByParty } from "./party.js";
import { toDomainState } from "./transition.js";

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

/** `IDENTITY` -> `identity`. Exported so a route answering with a stage
 * reads the file's real one rather than restating a literal. */
export const STAGE_TO_DOMAIN = {
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

export async function loadLoanFile(id: string, db: Db = prisma): Promise<LoanFile | null> {
  const row = await db.loanFile.findUnique({
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

  // The person, as the party asserts them. One query for every party on the
  // file. There is no column to fall back to; see borrower-projection.ts.
  const partyIds = row.borrowers.map((b) => b.partyId);
  const factRows = partyIds.length
    ? await db.fact.findMany({
        where: {
          partyId: { in: partyIds },
          subjectKey: "",
          supersededById: null,
          retractedAt: null,
        },
        select: { partyId: true, predicate: true, value: true, observedAt: true },
      })
    : [];
  const factsByParty = factMapsByParty(factRows);

  const borrowers: Borrower[] = row.borrowers.map((b) => {
    const who = requireIdentity(b.id, factsByParty.get(b.partyId) ?? new Map());
    return {
      id: b.id,
      partyId: b.partyId,
      firstName: who.firstName,
      lastName: who.lastName,
      dateOfBirth: who.dateOfBirth,
      ssn: { last4: b.ssnLast4, vaultHandle: who.ssnVaultHandle },
      email: who.email,
      phone: who.phone,
      currentAddress: who.currentAddress,
      maritalStatus: who.maritalStatus,
      citizenship: who.citizenship,
      // Keyed on the ID, not on the verified timestamp. A verification that has
      // been STARTED but not finished has an id and no timestamp, and that is
      // precisely the state the return page needs to read.
      identityVerification: b.identityVerificationId
        ? {
            verificationId: b.identityVerificationId,
            status: (b.identityVerificationStatus ?? "pending") as
              "verified" | "pending" | "failed",
            verifiedAt: b.identityVerifiedAt?.toISOString(),
          }
        : null,
      nonBorrowingSpouseName: b.nonBorrowingSpouseName ?? undefined,
      nonBorrowingSpouseSignatureRequired: b.nonBorrowingSpouseSignatureRequired,
      preferredLanguage: who.preferredLanguage,
      // Per application by law (HMDA), so never from the party.
      demographics: (b.demographics as Borrower["demographics"]) ?? null,
      firstTimeHomebuyer: who.firstTimeHomebuyer,
      isMilitary: who.isMilitary,
      // Situational: what they pay NOW, on THIS file. Stays on the row.
      currentHousing: b.currentHousing as Borrower["currentHousing"],
      monthlyRent: num(b.monthlyRent) ?? undefined,
    };
  });

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

  const conditions = await db.loanCondition.findMany({ where: { loanFileId: id } });

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

    propertyRecord: latest<PropertyRecord>("property_record"),
    valuation: latest<AvmEstimate>("valuation"),
    flood: latest<FloodDetermination>("flood"),
    sanctions: latest<SanctionsScreening>("sanctions"),
    lienSearch: latest<LienSearch>("lien_search"),

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
      startDate: e.startDate?.toISOString().slice(0, 10) ?? null,
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

    disclosures: row.disclosures.map((d): DisclosureRecord => ({
      kind: d.kind as DisclosureRecord["kind"],
      deliveredAt: d.deliveredAt.toISOString(),
      method: d.method as DisclosureRecord["method"],
      documentId: d.documentId,
    })),

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
    applicationSignedAt: row.applicationSignedAt?.toISOString() ?? null,
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
  db: Db = prisma,
): Promise<void> {
  await db.fileEvent.create({
    data: {
      loanFileId,
      kind,
      actor,
      requirementId: requirementId ?? null,
      payload: payload as Prisma.InputJsonValue,
    },
  });
}

/**
 * Store verbatim connector output. Append-only — never an update. Returns the
 * row's id so a ledger entry can name the retrieval that caused it.
 */
export async function recordSnapshot(
  loanFileId: string,
  kind: string,
  provider: string,
  externalId: string,
  payload: unknown,
  retrievedAt: string,
  db: Db = prisma,
): Promise<{ id: string }> {
  return db.connectorSnapshot.create({
    data: {
      loanFileId,
      kind,
      provider,
      externalId,
      payload: payload as Prisma.InputJsonValue,
      retrievedAt: new Date(retrievedAt),
    },
    select: { id: true },
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

/**
 * Decide whether this file is still the person's to remove one row at a time.
 *
 * Every child of a loan file cascades, and that is right for the answers, the
 * snapshots and the decisions: a person may take back what they typed and what
 * we pulled on their say-so. It stops being right the moment the file becomes
 * a credit request that has left draft, because from there the file carries a
 * ledger and the clocks measured from it — including the 30 days an
 * adverse-action notice is owed in, which is precisely the record a declined
 * borrower has a reason to want gone. Deleting the account still removes all
 * of it; what is refused is removing the request while the account that made
 * it stays.
 *
 * A separate check from assertFileAccess because it is a different question:
 * that one asks whose file this is, this one asks what the file has become.
 */
export async function assertFileMayBeDeleted(loanFileId: string): Promise<void> {
  const application = await prisma.application.findUnique({
    where: { loanFileId },
    select: { status: true },
  });
  if (!application || application.status === "DRAFT") return;
  throw new AppError(
    409,
    "This is a credit request on record now, so it can't be removed on its own. Deleting your account removes it along with everything else.",
    "APPLICATION_ON_RECORD",
  );
}

/**
 * Files this user may see: their own, newest first, plus the shared demo set.
 *
 * Each row says where its application stands, or null when it has none — a
 * file created before applications existed, which the list renders as "no
 * application on record" rather than inventing a draft for. `mine` is here
 * because ownership and demo-ness stopped being the same question: a sample
 * borrower's file is a demo file that belongs to that sample borrower.
 */
export async function listAccessibleFiles(userId: string) {
  const rows = await prisma.loanFile.findMany({
    where: { OR: [{ userId }, { isDemo: true }] },
    orderBy: [{ isDemo: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      stage: true,
      isDemo: true,
      userId: true,
      createdAt: true,
      purpose: true,
      loanAmount: true,
      valueOrPrice: true,
      propertyCity: true,
      propertyState: true,
      // The name is a fact on the party, not a column on the row.
      borrowers: { take: 1, select: { partyId: true } },
      application: { select: { status: true, statusEnteredAt: true } },
      decisions: {
        orderBy: { computedAt: "desc" },
        take: 1,
        select: { outcome: true, ausRecommendation: true },
      },
    },
  });

  // One query for every name rather than one per file. Same definition of
  // "live" as the projection uses, because it is the same function.
  const names = await liveFactsByParty(
    prisma,
    rows.flatMap((r) => r.borrowers.map((b) => b.partyId)),
    "legal_name",
  );

  // `borrowers[0].firstName` is the shape callers already read, so no caller
  // changes.
  return rows.map(({ borrowers, userId: owner, application, ...rest }) => ({
    ...rest,
    mine: owner === userId,
    applicationState: application
      ? {
          status: toDomainState(application.status),
          statusEnteredAt: application.statusEnteredAt.toISOString(),
          terminal: TERMINAL.includes(toDomainState(application.status)),
        }
      : null,
    borrowers: borrowers
      .map((b) => displayNameFrom(names.get(b.partyId)?.value))
      .filter((n): n is { firstName: string; lastName: string } => n !== null),
  }));
}
