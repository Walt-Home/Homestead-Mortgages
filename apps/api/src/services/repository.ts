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
  ApplicationReceipt,
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
import { DECISION_OUTCOMES, TERMINAL } from "@hm/shared";
import type { Prisma } from "@hm/db";
import { AppError } from "../middleware/error-handler.js";
import { displayNameFrom, factMapsByParty, requireIdentity } from "./borrower-projection.js";
import type { Db } from "./db.js";
import { liveFactsByParty } from "./party.js";
import { declarationOnFile } from "./declarations.js";
import { sixPieces } from "./evidence.js";
import { toDomainState } from "./transition.js";

/**
 * The stored outcome, parsed rather than asserted.
 *
 * `decisions.outcome` is a `String` column, and the cast this replaces would
 * hand any text in it straight to the engine and the screens — so a row
 * written by an older build, or by hand, could reach the review screen as an
 * outcome nothing has copy for and render as a blank ending. The database also
 * holds the list as a CHECK constraint; this is the belt to that brace, and it
 * throws where the value is read rather than where it is shown.
 */
function parseOutcome(stored: string): Decision["outcome"] {
  const known = readOutcome(stored);
  if (!known) throw new AppError(500, `Unknown decision outcome ${stored}.`, "DECISION_UNREADABLE");
  return known;
}

/**
 * The same read, for the list, where one bad row must not be the whole answer.
 *
 * `parseOutcome` throws, which is right where a single file is being read: the
 * request is about that file, and half of it is not an answer. The list is a
 * different question — it spans every file the user may see, including the
 * demo files everybody may see — so one unreadable word there took down the
 * front door for every account at once, and a demo row would have taken it
 * down for all of them permanently. Null is the honest answer for that one
 * file: no outcome, rather than no list.
 */
function readOutcome(stored: string): Decision["outcome"] | null {
  return DECISION_OUTCOMES.find((o) => o === stored) ?? null;
}

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

/**
 * APP-002's input, read from the ledger rather than from a column.
 *
 * The receipt is a database trigger on the pins and the scenario, and the row
 * it writes is the record that an application was received — so that row is
 * what the engine should be told about. The column this used to read was
 * stamped by a second, independent judgment in the API, which meant two things
 * could both claim to know when an application began and disagree; the ledger
 * is the one that opened the Loan Estimate clock, so it wins.
 *
 * Null for a file with no application, which is the truthful reading for a row
 * created before the join existed: APP-002 is outstanding, not satisfied by
 * something nobody can point at.
 */
async function applicationReceipt(db: Db, loanFileId: string): Promise<ApplicationReceipt | null> {
  const app = await db.application.findUnique({
    where: { loanFileId },
    select: {
      id: true,
      transitions: {
        where: { event: "intake_completed" },
        orderBy: { seq: "asc" },
        take: 1,
        select: { occurredAt: true },
      },
    },
  });
  const received = app?.transitions[0];
  if (!app || !received) return null;

  // The engine's six keys, from the vocabulary the pins and the scenario use.
  const pieces = await sixPieces(app.id, db);
  return {
    receivedAt: received.occurredAt.toISOString(),
    sixPieces: {
      name: pieces.legal_name ?? false,
      income: pieces.monthly_income ?? false,
      ssn: pieces.ssn_token ?? false,
      propertyAddress: pieces.propertyAddress ?? false,
      valueEstimate: pieces.valueEstimateCents ?? false,
      loanAmount: pieces.loanAmountCents ?? false,
    },
  };
}

/** `IDENTITY` -> `identity`. Exported so a route answering with a stage
 * reads the file's real one rather than restating a literal. */
export const STAGE_TO_DOMAIN = {
  PROPERTY_LOAN: "property_loan",
  IDENTITY: "identity",
  CREDIT: "credit",
  DECLARATIONS: "declarations",
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
      // Ordered, because every route reads `borrowers[0]` and means "the
      // person whose request this is". Two borrowers created in one
      // transaction can share a millisecond at TIMESTAMP(3), so the id breaks
      // the tie — an arbitrary rule, but a stable one, and an unordered
      // include would make which person a file is about depend on the planner.
      borrowers: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      consents: true,
      links: true,
      documents: true,
      disclosures: true,
      // Only live rows, and the filter is here rather than in the mapper
      // because every consumer above the projection reads a plain array with
      // no way to tell a superseded row from a current one — and an
      // applicability predicate shaped `length === 0 ? null : some(...)` reads
      // a retired row as a definite yes, which is how the satisfied count went
      // backwards. Ordered for the same reason `borrowers` is: an unordered
      // include makes the answer depend on the planner.
      incomeSources: {
        where: { retiredAt: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
      employments: {
        where: { retiredAt: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
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

  // Section 5 and the residence history, off the application-party edge rather
  // than off the borrower row: the answers belong to THIS credit request, and
  // a later request asks them again. Null the whole way down until somebody
  // has been asked, which is not the same fact as an answer of no.
  const answers = await declarationOnFile(id, db);

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
        outcome: parseOutcome(decisionRow.outcome),
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
  const application = await applicationReceipt(db, id);

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

    application,

    declaration: answers?.declaration ?? null,
    residences: answers?.residences ?? [],

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
  /**
   * Whose report this is, or null for a kind keyed on an address.
   *
   * Required rather than optional, and that is the point: a new person-keyed
   * pull that forgets it should not compile. The database refuses the row
   * either way, but a type error arrives while somebody is writing the route
   * rather than the first time a borrower runs it.
   */
  partyId: string | null,
  db: Db = prisma,
): Promise<{ id: string }> {
  return db.connectorSnapshot.create({
    data: {
      loanFileId,
      partyId,
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
 *
 * Takes a client so the check and the delete are one transaction. Something
 * now moves an application while a borrower is looking at it — the bank, a
 * branch, a decision — so reading the status in one round trip and deleting in
 * the next could remove a file that left draft in between. One transaction
 * narrows that to two statements; it does not close it, because a plain read
 * at READ COMMITTED locks nothing. Closing it needs a locking read, which is
 * the first raw SQL in a service and a change to a refusal path, so it is not
 * made here.
 */
export async function assertFileMayBeDeleted(loanFileId: string, db: Db = prisma): Promise<void> {
  const application = await db.application.findUnique({
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

/** What a file is waiting on the borrower for, in the words the ledger uses. */
export interface ListedObligation {
  readonly event: string;
  readonly reasonCode: string | null;
  readonly to: string;
}

/**
 * The newest obligation on each of these applications.
 *
 * One query for every file rather than one per file, the same way the
 * borrowers' names are read. Ordered oldest to newest so the last row written
 * into the map is the newest one: the ledger is append-only, so a file that
 * has owed two different things carries both rows forever, and the older one
 * names something the borrower already did.
 *
 * Only the three fields a sentence is built from. `seq`, the actor and the
 * timestamp are on the ledger the single-file route serves, and a list of
 * files needs none of them.
 */
async function obligationsByApplication(
  db: Db,
  applicationIds: readonly string[],
): Promise<Map<string, ListedObligation>> {
  const owed = new Map<string, ListedObligation>();
  if (applicationIds.length === 0) return owed;

  const rows = await db.applicationTransition.findMany({
    where: { applicationId: { in: [...applicationIds] }, event: "borrower_owes" },
    orderBy: { seq: "asc" },
    select: { applicationId: true, event: true, reasonCode: true, toState: true },
  });
  for (const row of rows) {
    owed.set(row.applicationId, {
      event: row.event,
      reasonCode: row.reasonCode,
      to: toDomainState(row.toState),
    });
  }
  return owed;
}

/**
 * Files this user may see: their own, newest first, plus the shared demo set.
 *
 * Each row says where its application stands, or null when it has none — a
 * file created before applications existed, which the list renders as "no
 * application on record" rather than inventing a draft for. `mine` is here
 * because ownership and demo-ness stopped being the same question: a sample
 * borrower's file is a demo file that belongs to that sample borrower.
 *
 * Two things a row could not say before, both of them about whose move it is.
 * `signed` is the difference between a file waiting for a signature and one
 * waiting for us, and no status draws it: the obligations the reconciler
 * writes cover the bank and the three branches and never the signature, so a
 * status says nothing about whether one has been given. `owes` is the
 * obligation itself, as the row rather than as a sentence, because the words
 * for it are written in the client beside every other borrower word.
 *
 * `owes` is read only in `awaiting_borrower`, and the gate is here rather than
 * in the caller: a reason code is a recorded past fact, so a row read in any
 * other state names an obligation already cleared, and a rule left to the
 * caller is one the next caller has to know about.
 *
 * The client is the last parameter, like every other reader here, so a caller
 * already inside a transaction sees what that transaction has written rather
 * than reading around it on a second connection.
 */
export async function listAccessibleFiles(userId: string, db: Db = prisma) {
  const rows = await db.loanFile.findMany({
    where: { OR: [{ userId }, { isDemo: true }] },
    orderBy: [{ isDemo: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      stage: true,
      isDemo: true,
      userId: true,
      createdAt: true,
      applicationSignedAt: true,
      purpose: true,
      loanAmount: true,
      valueOrPrice: true,
      propertyCity: true,
      propertyState: true,
      // The name is a fact on the party, not a column on the row. Ordered the
      // same way the projection orders them, so the list and the file it opens
      // name the same person.
      borrowers: {
        take: 1,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { partyId: true },
      },
      application: { select: { id: true, status: true, statusEnteredAt: true } },
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
    db,
    rows.flatMap((r) => r.borrowers.map((b) => b.partyId)),
    "legal_name",
  );

  const owed = await obligationsByApplication(
    db,
    rows.flatMap((r) =>
      r.application && toDomainState(r.application.status) === "awaiting_borrower"
        ? [r.application.id]
        : [],
    ),
  );

  // `borrowers[0].firstName` is the shape callers already read, so no caller
  // changes.
  return rows.map(
    ({
      borrowers,
      userId: owner,
      application,
      decisions,
      stage,
      applicationSignedAt,
      ...rest
    }) => ({
      ...rest,
      // The domain spelling, which the single-file route has always answered and
      // this one skipped. Two routes describing the same file in two vocabularies
      // is a difference no type can catch, because neither one crosses the wire
      // with a type on it.
      stage: STAGE_TO_DOMAIN[stage],
      // A latch, so the boolean loses nothing the date carried: no route sets it
      // twice and nothing clears it.
      signed: applicationSignedAt !== null,
      // Null on every state but `awaiting_borrower`, which is the gate above.
      owes: application ? (owed.get(application.id) ?? null) : null,
      // Read here too — the list is the other place a stored outcome reaches a
      // screen — but a word nothing has copy for drops that one decision instead
      // of failing the request. The file still lists, with no outcome on it.
      decisions: decisions.flatMap((d) => {
        const outcome = readOutcome(d.outcome);
        return outcome ? [{ ...d, outcome }] : [];
      }),
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
    }),
  );
}
