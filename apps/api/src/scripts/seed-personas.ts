/**
 * Eight sample borrowers, walked to their states through the real doors, and
 * one row this build cannot walk.
 *
 *   npm run build && npm run seed:personas
 *
 * A tester needs to see what a file in each state looks like, and the only
 * honest way to show that is to have walked one there. So nothing here sets
 * `applications.status`, inserts a ledger row, opens a clock or writes a pin:
 * every state a persona wears was written by the same services the four
 * screens call, in the same order the borrower would have called them.
 * `isolation.test.ts` reads this module and fails on any delegate that could
 * forge one, and `seed-personas.test.ts` checks the actors on every row.
 *
 * There are two edges no route can write, and both are stated as what they
 * are. Lena withdraws as herself — the database refuses a withdrawal by
 * anybody but a borrower on the application, so the seed cannot fake it even
 * if it wanted to. Marcus's last three moves are recorded by a STAFF principal
 * called `staff:persona_seed` under the reason `persona_fixture`, so the
 * ledger itself says that no disclosure, closing or disbursement record stands
 * behind them.
 *
 * Idempotent by `users.persona_key`: a persona that already exists at its
 * target is reported and left alone, because re-walking the real paths would
 * append a second set of ledger rows to a history that already happened. A
 * persona that exists somewhere ELSE is a drift, and a drift is reported and
 * fails the run rather than being quietly skipped forever.
 *
 * The target is asserted INSIDE the transaction. Asserting after the commit
 * would leave the wrong rows durable and every later run skipping past them.
 *
 * Names: each persona is their own person, with their own facts and their own
 * current address. They share three connector fixtures — six of them are
 * clean_w2 — and the fixtures' own identity documents name Dana Whitfield,
 * Marcus Adeyemi and Priya Raman. That document is read by the ID-scan branch
 * only, which is a POST, which a sample borrower cannot make: personas never
 * surface a document in somebody else's name. Giving eight of them eight
 * identity documents would mean eight connector fixtures, which is a change to
 * a package with no reader for it; the fixtures' names stay where they are and
 * this comment is the record of the choice.
 *
 * The same mismatch is stored, not shown, one layer down: the county record a
 * property pull returns carries an `ownerOfRecord`, and it names the fixture's
 * person rather than the persona buying the house. Nothing in the web app, the
 * requirements or the underwriting reads that field, so no tester meets it —
 * but it is the half of this that a future reader WILL surface, and whoever
 * gives it a screen owes the personas either their own records or their
 * fixtures' names.
 */

import { fileURLToPath } from "node:url";
import { prisma } from "@hm/db";
import type { DuResidencyBasis, Prisma } from "@hm/db";
import { fixtureRegistry, PUBLIC_RECORDS, type ConnectorRegistry } from "@hm/connectors";
import type { Address, ApplicationState, LoanFile } from "@hm/shared";
import { underwrite } from "@hm/underwriting";
import { config } from "../config.js";
import {
  isSeeded,
  PERSONA_STORIES,
  type PersonaKey,
  type PersonaStory,
  type SeededKey,
  type SeededPersona,
} from "../personas/stories.js";
import {
  casefileIdForFile,
  createDraftApplication,
  ensureApplicationParty,
  scenarioTermsFrom,
} from "../services/applications.js";
import { tokenFor } from "../services/authorization.js";
import type { Db } from "../services/db.js";
import { decideApplication, recordDecision } from "../services/decide.js";
import { recordDeclaration } from "../services/declarations.js";
import { pinTridPieces, proposeScenario } from "../services/evidence.js";
import {
  assertFacts,
  partyForUser,
  principalForParty,
  recordBorrowerFacts,
  staffPrincipal,
} from "../services/party.js";
import { loadLoanFile, recordEvent, recordSnapshot } from "../services/repository.js";
import { reconcileIncomeAndEmployment } from "../services/income.js";
import { screenAndRecord } from "../services/screening.js";
import {
  settleAfterIntake,
  settleBorrowerAct,
  type BorrowerActReason,
} from "../services/standing.js";
import { toCents } from "../services/money.js";
import { toDomainState, transition } from "../services/transition.js";

/** The one staff actor this script may act as. Named in the ledger. */
const SEED_STAFF = "staff:persona_seed";

const PURPOSE_TO_DB = {
  purchase: "PURCHASE",
  rate_term_refinance: "RATE_TERM_REFINANCE",
  cash_out_refinance: "CASH_OUT_REFINANCE",
} as const;

/**
 * A persona's own address, which is not the house they are buying.
 *
 * Screen 2 asks where you live now. For a purchase that is somewhere else
 * entirely, and a persona whose current address was the subject property would
 * be a person buying the house they already live in.
 */
const CURRENT_ADDRESS: Record<SeededKey, Address> = {
  maya_okafor: { line1: "3110 Duval Street", city: "Austin", state: "TX", postalCode: "78705" },
  ben_castillo: { line1: "1247 Oak Street", city: "Austin", state: "TX", postalCode: "78704" },
  priya_dev_raman: {
    line1: "1580 Hamilton Ave",
    line2: "Apt 14",
    city: "San Jose",
    state: "CA",
    postalCode: "95125",
  },
  tom_nguyen: { line1: "905 E 45th Street", city: "Austin", state: "TX", postalCode: "78751" },
  aisha_bello: {
    line1: "1250 Northside Dr NW",
    line2: "Apt 7B",
    city: "Atlanta",
    state: "GA",
    postalCode: "30318",
  },
  lena_fischer: {
    line1: "4402 Red River Street",
    city: "Austin",
    state: "TX",
    postalCode: "78751",
  },
  marcus_hale: { line1: "2201 Manor Road", city: "Austin", state: "TX", postalCode: "78722" },
  omar_haddad: { line1: "710 W 22nd Street", city: "Austin", state: "TX", postalCode: "78705" },
};

/**
 * Screen 2's answers about the person, per persona. Dates of birth are made
 * up people's.
 *
 * The name is here rather than taken from the story's row label because the
 * two are not the same thing. `priya_dev_raman` is one row for two people, and
 * writing its label into screen 2 gave the primary borrower the legal name
 * "Priya and Dev Raman" — a six-piece TRID fact, beside her own date of birth
 * and SSN last four, saying a person is called something no person is called.
 * The label belongs to the picker; this is who signs.
 */
const PERSON: Record<
  SeededKey,
  { first: string; last: string; dateOfBirth: string; ssnLast4: string; income: number }
> = {
  maya_okafor: {
    first: "Maya",
    last: "Okafor",
    dateOfBirth: "1990-03-14",
    ssnLast4: "4417",
    income: 8_500,
  },
  ben_castillo: {
    first: "Ben",
    last: "Castillo",
    dateOfBirth: "1985-11-02",
    ssnLast4: "2093",
    income: 8_500,
  },
  priya_dev_raman: {
    first: "Priya",
    last: "Raman",
    dateOfBirth: "1988-07-21",
    ssnLast4: "6612",
    income: 9_200,
  },
  tom_nguyen: {
    first: "Tom",
    last: "Nguyen",
    dateOfBirth: "1992-01-09",
    ssnLast4: "5580",
    income: 8_500,
  },
  aisha_bello: {
    first: "Aisha",
    last: "Bello",
    dateOfBirth: "1994-06-30",
    ssnLast4: "3341",
    income: 6_400,
  },
  lena_fischer: {
    first: "Lena",
    last: "Fischer",
    dateOfBirth: "1987-09-18",
    ssnLast4: "7726",
    income: 8_500,
  },
  marcus_hale: {
    first: "Marcus",
    last: "Hale",
    dateOfBirth: "1983-04-25",
    ssnLast4: "1108",
    income: 8_500,
  },
  omar_haddad: {
    first: "Omar",
    last: "Haddad",
    dateOfBirth: "1991-12-05",
    ssnLast4: "9034",
    income: 8_500,
  },
};

/** Dev Raman, who is on Priya's application and has no sign-in of his own. */
const DEV = {
  first: "Dev",
  last: "Raman",
  dateOfBirth: "1986-02-11",
  ssnLast4: "7745",
  email: "dev@priya_dev_raman.personas.supermortgage.invalid",
  phone: "408-555-0177",
};

/* ── The walk ─────────────────────────────────────────────────────────────── */

interface Walk {
  readonly tx: Db;
  readonly story: SeededPersona;
  readonly registry: ConnectorRegistry;
  readonly loanFileId: string;
  readonly applicationId: string;
  /** The persona's own party. Dev's is separate and local to his walk. */
  readonly partyId: string;
  readonly borrowerId: string;
}

/** The file as everything else reads it. Never cached: each act changes it. */
async function currentFile(w: Walk): Promise<LoanFile> {
  const file = await loadLoanFile(w.loanFileId, w.tx);
  if (!file) throw new Error(`persona ${w.story.key}: its own file disappeared`);
  return file;
}

/** Screen 1 — the property, the loan, the person asking and the draft. */
async function screenOne(
  tx: Db,
  story: SeededPersona,
  userId: string,
): Promise<{ loanFileId: string; applicationId: string; partyId: string }> {
  const t = story.terms;
  const partyId = await partyForUser(tx, userId, { sourceFirstSeen: "persona_seed" });
  const principalId = await principalForParty(tx, partyId);

  const file = await tx.loanFile.create({
    data: {
      userId,
      // Readable by every signed-in tester, writable by nobody — including the
      // persona's own session. See assertFileAccess: demo is checked before
      // ownership, so this is the layer that makes a sample read-only even to
      // whoever is signed in as it.
      isDemo: true,
      // The resume cursor, not a state. The borrower screens still navigate on it.
      stage: story.resumeStage,
      purpose: PURPOSE_TO_DB[t.purpose],
      loanAmount: t.loanAmount,
      downPayment: t.downPayment,
      propertyLine1: t.address.line1,
      propertyLine2: t.address.line2 ?? null,
      propertyCity: t.address.city,
      propertyState: t.address.state.toUpperCase(),
      propertyPostalCode: t.address.postalCode,
      propertyType: t.propertyType,
      occupancy: t.occupancy,
      valueOrPrice: t.valueOrPrice,
      valuationSource: "borrower_stated",
      addressVerified: true,
      productCode: config.defaultProduct.code,
      termMonths: config.defaultProduct.termMonths,
      amortization: "fixed",
      noteRate: config.defaultProduct.noteRate,
    },
  });

  await assertFacts(tx, partyId, principalId, [
    { predicate: "monthly_income", value: PERSON[story.key].income },
  ]);

  // Read back off the row, through the same function screen 1 uses, so a
  // persona's terms cannot drift from what the route would have written. A
  // null here would mean the columns and the story had come apart.
  const terms = scenarioTermsFrom(file);
  if (!terms) throw new Error(`persona ${story.key}: its own screen-1 terms are not statable`);
  const { applicationId } = await createDraftApplication(tx, {
    loanFileId: file.id,
    partyId,
    terms,
  });

  return { loanFileId: file.id, applicationId, partyId };
}

/**
 * Screen 2 and the consent it posts — the person, the authorization, the pins.
 *
 * In this order because the order is what makes it work: the facts exist
 * first, the consent mints the grant the trigger mirrors, and only then can a
 * pin name both. The third pin is what fires the receipt in the database, and
 * `settleAfterIntake` says what the application owes next in the same
 * transaction — which is what makes a sample borrower read "Needs you" rather
 * than a state nobody explained.
 */
async function screenTwo(
  tx: Db,
  story: SeededPersona,
  args: { loanFileId: string; applicationId: string },
): Promise<{ partyId: string; borrowerId: string }> {
  const who = PERSON[story.key];
  const partyId = await recordBorrowerFacts(tx, {
    loanFileId: args.loanFileId,
    existingPartyId: null,
    input: {
      firstName: who.first,
      lastName: who.last,
      email: `${story.key}@personas.supermortgage.invalid`,
      phone: "512-555-0142",
      dateOfBirth: who.dateOfBirth,
      // A reference, never a number. There is no SSN for these people at all.
      ssnVaultHandle: `vault:persona:${story.key}`,
      currentAddress: CURRENT_ADDRESS[story.key],
      maritalStatus: "unmarried",
      citizenship: "us_citizen",
      preferredLanguage: "en",
      firstTimeHomebuyer: story.terms.purpose === "purchase",
      isMilitary: false,
      // No housing basis and no rent. This used to derive one from the loan
      // purpose — a purchase meant a renter — which is a guess about where
      // somebody lives dressed as a seeded fact, and it left the derived column
      // asserting a basis with no `du_residences` row behind it. A sample
      // borrower stands where a real one stands: nobody has asked them yet.
    },
  });

  const borrower = await tx.borrower.create({
    data: {
      loanFileId: args.loanFileId,
      partyId,
      ssnLast4: who.ssnLast4,
      demographics: DECLINED,
    },
    select: { id: true },
  });

  await ensureApplicationParty(tx, args.applicationId, partyId, "PRIMARY_BORROWER");
  await grantConsent(tx, args.loanFileId, borrower.id, "verification_authorization");
  await grantConsent(tx, args.loanFileId, borrower.id, "econsent");
  await pinTridPieces(tx, { applicationId: args.applicationId, partyId });
  await settleAfterIntake(tx, {
    applicationId: args.applicationId,
    loanFileId: args.loanFileId,
    causedBy: "consent:verification_authorization",
  });

  return { partyId, borrowerId: borrower.id };
}

/** Declined, on every persona. Demographics are the borrower's to give. */
const DECLINED = {
  ethnicity: "declined",
  race: "declined",
  sex: "declined",
  visualObservationNoted: false,
} as unknown as Prisma.InputJsonValue;

/** A signature, with the evidence that it happened. The trigger mirrors it. */
async function grantConsent(
  tx: Db,
  loanFileId: string,
  borrowerId: string,
  kind: "verification_authorization" | "econsent" | "form_4506c",
): Promise<void> {
  await tx.consent.create({
    data: {
      loanFileId,
      borrowerId,
      kind,
      grantedAt: new Date(),
      ipAddress: "127.0.0.1",
      userAgent: "persona-seed",
    },
  });
  await recordEvent(loanFileId, "consent_granted", "borrower", { kind }, undefined, tx);
}

/**
 * Screen 3 — Section 5 and where each of them lives.
 *
 * Every persona answers, and that is not tidiness. Six new borrower-input
 * requirements went into the sheet with this screen, and a sample borrower who
 * had never been asked would carry all six as outstanding work for the rest of
 * their life — eight files that stopped showing the eight states they were
 * built to show, all of them reading "needs you" for a screen that is behind
 * them. There are no real applications in flight to migrate; these eight are
 * what the team demonstrates with, so these eight are what the answers are for.
 *
 * The answers are theirs and they differ, because a persona whose whole job is
 * to look like a person should not answer a seventeen-question form the same
 * way as everybody else. Ben is refinancing, so he owns his home and has for
 * eight years, and his file is the one that carries the prior-property
 * follow-ups. Priya has been in her apartment fourteen months, so hers is the
 * one that carries a previous address. Nobody declares a bankruptcy: the
 * chapter branch has no reference instance anywhere in the corpus, and a
 * seeded sample is not the place to invent the first one.
 */
const DECLARED: Record<
  SeededKey,
  { basis: DuResidencyBasis; months: number; rent?: number; owned?: boolean; prior?: Address }
> = {
  maya_okafor: { basis: "Rent", months: 29, rent: 1_850 },
  ben_castillo: { basis: "Own", months: 96, owned: true },
  priya_dev_raman: {
    basis: "Rent",
    months: 14,
    rent: 3_400,
    prior: { line1: "77 Curtner Ave", city: "San Jose", state: "CA", postalCode: "95125" },
  },
  tom_nguyen: { basis: "Rent", months: 33, rent: 1_600 },
  aisha_bello: { basis: "Rent", months: 26, rent: 1_450 },
  lena_fischer: { basis: "Rent", months: 48, rent: 1_725 },
  marcus_hale: { basis: "Rent", months: 40, rent: 2_050 },
  omar_haddad: { basis: "LivingRentFree", months: 60 },
};

async function declarations(w: Walk): Promise<void> {
  const said = DECLARED[w.story.key];
  const purchase = w.story.terms.purpose === "purchase";

  await recordDeclaration(
    w.loanFileId,
    {
      declaration: {
        intentToOccupy: "Yes",
        homeownerPastThreeYears: said.owned ? "Yes" : "No",
        // Both follow-ups exist exactly when their trigger says they were put,
        // which is the direction the CHECK constraints read in as well.
        priorPropertyUsage: said.owned ? "PrimaryResidence" : null,
        priorPropertyTitle: said.owned ? "Sole" : null,
        // Asked on an FHA file, which none of these is.
        fhaSecondaryResidence: null,
        specialBorrowerSellerRelationship: purchase ? false : null,
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
      },
      residences: [
        {
          residencyType: "Current",
          basis: said.basis,
          durationMonths: said.months,
          monthlyRent: said.rent ?? null,
        },
        ...(said.prior
          ? [
              {
                residencyType: "Prior" as const,
                basis: "Rent" as const,
                durationMonths: 36,
                monthlyRent: 2_600,
                addressLineText: said.prior.line1,
                cityName: said.prior.city,
                stateCode: said.prior.state,
                postalCode: said.prior.postalCode,
              },
            ]
          : []),
      ],
    },
    w.tx,
  );
  // No stage to advance. A persona's file is created at its resume stage and
  // every walk runs inside one transaction, so the high-water mark is already
  // where the story says it is — and `advanceStage` reads its own connection,
  // which cannot see a row this transaction has not committed.
  await recordEvent(
    w.loanFileId,
    "screen_completed",
    "borrower",
    { screen: "declarations" },
    "APP-022",
    w.tx,
  );
}

/** The soft credit pull, and the review the credit route records beside it. */
async function credit(w: Walk): Promise<void> {
  const file = await currentFile(w);
  const result = await w.registry.credit.pullTriMerge(
    file,
    await tokenFor(file, "credit_report", w.tx),
  );
  await recordSnapshot(
    w.loanFileId,
    "credit",
    result.provider,
    result.externalId,
    result.data,
    result.retrievedAt,
    w.partyId,
    w.tx,
  );
  await linked(w, "credit", result.provider);
  // UW-018's fraud and red-flag review has no provider, and it is a review
  // rather than a lookup, so the credit route records it as a system assertion
  // and says in the event that nothing was actually consulted. A sample
  // borrower's history reads the same as anybody's.
  await w.tx.loanFile.update({ where: { id: w.loanFileId }, data: { fraudReviewComplete: true } });
  await recordEvent(
    w.loanFileId,
    "screening_completed",
    "system",
    { checks: ["fraud_red_flag"], note: "fixture — no real fraud review provider is wired" },
    undefined,
    w.tx,
  );
  await recordEvent(
    w.loanFileId,
    "connector_pull",
    result.provider,
    { kind: "credit" },
    "CRD-001",
    w.tx,
  );
}

/** OFAC/SDN. The snapshot, the column, the event and any hold, in one writer. */
async function screening(w: Walk): Promise<void> {
  await screenAndRecord(w.tx, await currentFile(w), w.registry);
}

/** The recorder's office, keyed on the APN the assessor record carries. */
async function liens(w: Walk): Promise<void> {
  const file = await currentFile(w);
  const apn = PUBLIC_RECORDS[w.story.fixture].record.apn;
  const result = await w.registry.liens.searchLiens(
    file,
    await tokenFor(file, "public_record_liens", w.tx),
    apn,
  );
  await recordSnapshot(
    w.loanFileId,
    "lien_search",
    result.provider,
    result.externalId,
    result.data,
    result.retrievedAt,
    // Keyed on the address, like the rest of screen 1's lookups.
    null,
    w.tx,
  );
  await recordEvent(
    w.loanFileId,
    "connector_pull",
    result.provider,
    { kind: "lien_search" },
    "UW-005",
    w.tx,
  );
}

/** What the county, the AVM and FEMA say. Address-keyed, so unguarded. */
async function propertyData(w: Walk): Promise<void> {
  const file = await currentFile(w);
  const address = file.property!.address;
  const [record, valuation, flood] = await Promise.all([
    w.registry.propertyData.lookupRecord(address),
    w.registry.propertyData.estimateValue(address),
    w.registry.propertyData.determineFlood(address),
  ]);
  for (const [kind, pull] of [
    ["property_record", record],
    ["valuation", valuation],
    ["flood", flood],
  ] as const) {
    await recordSnapshot(
      w.loanFileId,
      kind,
      pull.provider,
      pull.externalId,
      pull.data,
      pull.retrievedAt,
      null,
      w.tx,
    );
  }
  await recordEvent(
    w.loanFileId,
    "connector_pull",
    record.provider,
    { kind: "property_record" },
    "APP-004",
    w.tx,
  );
}

/**
 * Record that this connector is linked, the way every pull route does.
 *
 * Nothing reads these rows yet; the monitoring loop will, and a sample
 * borrower with twelve months of transactions and no link would be the one
 * file it could not re-pull.
 */
async function linked(w: Walk, kind: string, provider: string): Promise<void> {
  const now = new Date();
  await w.tx.connectorLink.upsert({
    where: { loanFileId_kind: { loanFileId: w.loanFileId, kind } },
    create: { loanFileId: w.loanFileId, kind, provider, linkedAt: now, lastSyncedAt: now },
    update: { lastSyncedAt: now, status: "active" },
  });
}

/** Screen 3 — the twelve-month asset report, and the move it causes. */
async function bank(w: Walk): Promise<void> {
  const file = await currentFile(w);
  const outcome = await w.registry.bank.fetchAssetReport(
    file,
    await tokenFor(file, "bank_transactions", w.tx),
    { sessionId: `persona-${w.story.key}` },
    12,
  );
  if (outcome.status !== "ready") {
    throw new Error(`persona ${w.story.key}: the fixture bank connector must answer immediately`);
  }
  const result = outcome.result;
  const snapshot = await recordSnapshot(
    w.loanFileId,
    "bank",
    result.provider,
    result.externalId,
    result.data,
    result.retrievedAt,
    w.partyId,
    w.tx,
  );
  await linked(w, "bank", result.provider);
  await reconcileIncomeAndEmployment(w.tx, {
    loanFileId: w.loanFileId,
    partyId: w.partyId,
    snapshotId: snapshot.id,
    reported: result.data,
    now: new Date(result.retrievedAt),
  });
  await recordEvent(
    w.loanFileId,
    "connector_pull",
    result.provider,
    { kind: "bank" },
    "AST-001",
    w.tx,
  );
  await settle(w, "bank_connected", `snapshot:${snapshot.id}`, true);
}

/** The payroll branch, which replaces what the bank inferred. */
async function payroll(w: Walk): Promise<void> {
  const file = await currentFile(w);
  const token = await tokenFor(file, "payroll_income", w.tx);
  const session = await w.registry.payroll.createLinkSession(file, token);
  const result = await w.registry.payroll.fetchPayroll(file, token, session.sessionId);
  const snapshot = await recordSnapshot(
    w.loanFileId,
    "payroll",
    result.provider,
    result.externalId,
    result.data,
    result.retrievedAt,
    w.partyId,
    w.tx,
  );
  await linked(w, "payroll", result.provider);
  await reconcileIncomeAndEmployment(w.tx, {
    loanFileId: w.loanFileId,
    partyId: w.partyId,
    snapshotId: snapshot.id,
    reported: result.data,
    now: new Date(result.retrievedAt),
  });
  await recordEvent(
    w.loanFileId,
    "connector_pull",
    result.provider,
    { kind: "payroll" },
    "INC-002",
    w.tx,
  );
  await settle(w, "payroll_connected", `snapshot:${snapshot.id}`);
}

/** The document branch. No bytes are transmitted, here or on the real screen. */
async function uploadDocument(w: Walk, requirementId: string, filename: string): Promise<void> {
  const row = await w.tx.document.create({
    data: {
      loanFileId: w.loanFileId,
      filename,
      contentType: "application/pdf",
      bytes: 84_213,
      satisfiesRequirementId: requirementId,
      storageUri: "fixture://content-not-transmitted",
    },
    select: { id: true },
  });
  await recordEvent(
    w.loanFileId,
    "document_recorded",
    "borrower",
    { filename, bytes: 84_213, contentStored: false },
    requirementId,
    w.tx,
  );
  await settle(w, "documents_received", `document:${row.id}`);
}

/**
 * The review screen's signature: one act covering the application and the
 * 4506-C, then the transcripts it licenses.
 */
async function signApplication(w: Walk): Promise<void> {
  await grantConsent(w.tx, w.loanFileId, w.borrowerId, "form_4506c");

  const file = await currentFile(w);
  const year = new Date().getFullYear();
  const result = await w.registry.irs.fetchTranscripts(
    file,
    await tokenFor(file, "tax_transcript", w.tx),
    [year - 1, year - 2],
  );
  await recordSnapshot(
    w.loanFileId,
    "irs",
    result.provider,
    result.externalId,
    result.data,
    result.retrievedAt,
    w.partyId,
    w.tx,
  );
  await linked(w, "irs", result.provider);
  await recordEvent(
    w.loanFileId,
    "connector_pull",
    result.provider,
    { kind: "irs" },
    "INC-003",
    w.tx,
  );

  await w.tx.loanFile.update({
    where: { id: w.loanFileId },
    data: { applicationSignedAt: new Date() },
  });
  await recordEvent(
    w.loanFileId,
    "application_signed",
    "borrower",
    { documents: ["application", "form_4506c"] },
    undefined,
    w.tx,
  );
  await settle(w, "application_signed", "event:application_signed");
}

/** The borrower supplied something; the application says what that changed. */
async function settle(
  w: Walk,
  reasonCode: BorrowerActReason,
  causedBy: string,
  beginsWorkFromIntake = false,
): Promise<void> {
  await settleBorrowerAct(w.tx, {
    applicationId: w.applicationId,
    loanFileId: w.loanFileId,
    partyId: w.partyId,
    reasonCode,
    causedBy,
    beginsWorkFromIntake,
  });
}

/**
 * Ask the engine, record what it said, and let it move the application.
 *
 * `story.market` is the APR, the average prime offer rate and the fee total
 * the borrower screens never collect. Supplying them here is what lets a sample
 * show a decided state at all: a real-flow file leaves those blocked, the
 * engine refuses to guess, and every one of them ends `referred`.
 */
async function decide(w: Walk): Promise<void> {
  const file = await currentFile(w);
  const decision = underwrite(file, {
    casefileId: await casefileIdForFile(w.loanFileId, w.tx),
    now: new Date().toISOString(),
    ...(w.story.market ? { market: w.story.market } : {}),
  });
  const { decisionId } = await recordDecision(w.tx, w.loanFileId, decision);
  await decideApplication(w.tx, {
    applicationId: w.applicationId,
    loanFileId: w.loanFileId,
    decision,
    decisionId,
    file,
  });
  await recordEvent(
    w.loanFileId,
    "decision_computed",
    "system",
    {
      outcome: decision.outcome,
      recommendation: decision.aus?.recommendation,
      engine: decision.aus?.engine,
    },
    "UW-002",
    w.tx,
  );
}

/* ── The eight walks ──────────────────────────────────────────────────────── */

/**
 * One function per person, each reading like their story.
 *
 * The shared prelude — screen 1, screen 2, the consent, the pins, the
 * receipt — is in `seedPersona`; these are what each of them did next.
 */
const WALKS: Record<SeededKey, (w: Walk) => Promise<void>> = {
  /** Told us who she is and what she is buying. Her bank is the next thing. */
  async maya_okafor(w) {
    await propertyData(w);
    await credit(w);
    await screening(w);
    await liens(w);
    await declarations(w);
  },

  /**
   * Refinancing, bank connected, nothing left on him and nobody has asked the
   * engine — which is exactly what "we're working on it" means.
   */
  async ben_castillo(w) {
    await propertyData(w);
    await credit(w);
    // The rate on the loan he already has. No fixture credit report carries a
    // mortgage tradeline, so it is his own statement rather than a reading of
    // the report — captured as a fact, attested, and the file event says where
    // the existing-loan columns came from.
    const principalId = await principalForParty(w.tx, w.partyId);
    await assertFacts(w.tx, w.partyId, principalId, [
      { predicate: "stated_current_rate", value: { rateBps: 725 } },
    ]);
    await w.tx.loanFile.update({
      where: { id: w.loanFileId },
      data: {
        existingServicer: "Lone Star Mortgage Servicing",
        existingLoanNumber: "LSM-4471902",
        existingBalance: 298_400,
        existingRate: 7.25,
        existingMonthlyPayment: 2_037,
      },
    });
    await recordEvent(
      w.loanFileId,
      "screen_completed",
      "borrower",
      {
        screen: "property_loan",
        note: "existing loan stated by the borrower; the fixture credit report carries no mortgage tradeline",
      },
      "APP-018",
      w.tx,
    );
    await screening(w);
    await liens(w);
    await declarations(w);
    await bank(w);
  },

  /** Two people, commission income and a gift, with two branches on the way. */
  async priya_dev_raman(w) {
    await addCoBorrower(w);
    await propertyData(w);
    await credit(w);
    await screening(w);
    await liens(w);
    await declarations(w);
    // Her bank report cannot verify commission income, so the payroll branch
    // is owed; her credit report carries a late payment, so a letter is owed
    // after it. Both are walked, in the order the reconciler asks for them.
    await bank(w);
    await payroll(w);
    await uploadDocument(w, "CRD-008", "letter-of-explanation.pdf");
    await signApplication(w);
    await decide(w);
  },

  /** Asked for more than the house will carry, and was offered less instead. */
  async tom_nguyen(w) {
    await propertyData(w);
    await credit(w);
    await screening(w);
    await liens(w);
    await declarations(w);
    await bank(w);
    await signApplication(w);
    await decide(w);
    // "Not that loan, but here is one we can do." A new scenario at seq 2
    // retires the borrower's own, which is what a counteroffer IS in this
    // model — and its down payment is the rest of the price, or the terms on
    // the screen would not add up.
    const price = w.story.terms.valueOrPrice;
    const offered = 412_250;
    await proposeScenario(
      w.applicationId,
      {
        objective: "PURCHASE",
        occupancy: "PRIMARY_RESIDENCE",
        loanAmountCents: toCents(offered),
        downPaymentCents: toCents(price - offered),
        valueEstimateCents: toCents(price),
        termMonths: config.defaultProduct.termMonths,
        noteRateBps: Math.round(config.defaultProduct.noteRate * 100),
        propertyAddress: await activeAddress(w),
        origin: "COUNTEROFFER",
      },
      w.tx,
    );
  },

  /** Thin credit at a high price. The pricing tests are what decline her. */
  async aisha_bello(w) {
    await propertyData(w);
    await credit(w);
    await screening(w);
    await liens(w);
    await declarations(w);
    await bank(w);
    await signApplication(w);
    await decide(w);
  },

  /** Started, then asked us to stop. */
  async lena_fischer(w) {
    await propertyData(w);
    await credit(w);
    await screening(w);
    await liens(w);
    await declarations(w);
    // Her own principal, because the database refuses any other: withdrawal is
    // the borrower's act and a trigger checks that the actor is a borrower ON
    // this application. The seed's staff principal would be refused here,
    // which is the point of doing it this way.
    await transition(
      {
        applicationId: w.applicationId,
        event: "borrower_withdrew",
        actorPrincipalId: await principalForParty(w.tx, w.partyId),
        reasonCode: "borrower_requested",
        causedBy: `persona_seed:${w.story.key}`,
      },
      w.tx,
    );
  },

  /** All the way to funded — with the last three steps recorded by hand. */
  async marcus_hale(w) {
    await propertyData(w);
    await credit(w);
    await screening(w);
    await liens(w);
    await declarations(w);
    await bank(w);
    await signApplication(w);
    await decide(w);
    await w.tx.loanFile.update({
      where: { id: w.loanFileId },
      data: { intentToProceedAt: new Date() },
    });
    await recordEvent(w.loanFileId, "intent_to_proceed", "borrower", {}, "APP-007", w.tx);
    // No disclosure, closing or disbursement record stands behind these three.
    // A STAFF actor and the reason `persona_fixture` are how the ledger says
    // so, on the row itself, to anybody who reads his history.
    const staff = await staffPrincipal(w.tx, SEED_STAFF);
    for (const event of ["disclosures_complete", "closing_began", "disbursed"] as const) {
      await transition(
        {
          applicationId: w.applicationId,
          event,
          actorPrincipalId: staff,
          reasonCode: "persona_fixture",
          causedBy: `persona_seed:${w.story.key}`,
        },
        w.tx,
      );
    }
  },

  /** Held on a name that looks like one on a list. */
  async omar_haddad(w) {
    await propertyData(w);
    await credit(w);
    // His registry is built with the near-match knob, so the adapter says not
    // clear, the route's own writer records the column and the hold, and the
    // pill, the snapshot and the ledger all say the same thing.
    await screening(w);
    await liens(w);
    await declarations(w);
  },
};

/** The active scenario's address, so a counteroffer names the same house. */
async function activeAddress(w: Walk): Promise<string | null> {
  const active = await w.tx.loanScenario.findFirst({
    where: { applicationId: w.applicationId, isActive: true },
    select: { propertyAddress: true },
  });
  return active?.propertyAddress ?? null;
}

/**
 * Dev Raman, who is on the application and has no sign-in.
 *
 * His `createdAt` is a second after Priya's row on purpose. Every reader of
 * this file takes `borrowers[0]` to be the person whose request it is — the
 * purpose token is minted for that party — and two rows created in one
 * transaction can share a millisecond. The id breaks a tie, but "whichever
 * uuid sorts first" is not the fact anybody wants; an explicit second is.
 *
 * His three pieces are pinned under his own authorization and do not complete
 * anything: the receipt counts ONE primary borrower's pieces, which is what
 * makes a co-borrower's SSN not somebody else's application.
 */
async function addCoBorrower(w: Walk): Promise<void> {
  const priya = await w.tx.borrower.findFirstOrThrow({
    where: { loanFileId: w.loanFileId, partyId: w.partyId },
    select: { createdAt: true },
  });

  const party = await w.tx.party.create({
    data: { kind: "PERSON", claimStatus: "CLAIMED", sourceFirstSeen: "persona_seed" },
    select: { id: true },
  });
  const principalId = await principalForParty(w.tx, party.id);
  await assertFacts(w.tx, party.id, principalId, [
    { predicate: "legal_name", value: { first: DEV.first, last: DEV.last } },
    { predicate: "date_of_birth", value: DEV.dateOfBirth },
    { predicate: "email", value: DEV.email },
    { predicate: "phone", value: DEV.phone },
    { predicate: "current_address", value: { ...CURRENT_ADDRESS.priya_dev_raman } },
    { predicate: "marital_status", value: "unmarried" },
    { predicate: "citizenship", value: "us_citizen" },
    { predicate: "preferred_language", value: "en" },
    { predicate: "is_military", value: false },
    { predicate: "ssn_token", value: `vault:persona:${w.story.key}:dev` },
  ]);

  const dev = await w.tx.borrower.create({
    data: {
      loanFileId: w.loanFileId,
      partyId: party.id,
      ssnLast4: DEV.ssnLast4,
      demographics: DECLINED,
      createdAt: new Date(priya.createdAt.getTime() + 1_000),
    },
    select: { id: true },
  });

  // Both rows exist now, so ask the reader itself which one it hands back
  // first — not a copy of its ordering, which could drift from it. The second
  // of daylight above should settle it; if it ever does not, the seed stops
  // here rather than walking on and minting this household's purpose token for
  // Dev, which is somebody else's authorization for Priya's credit.
  const file = await loadLoanFile(w.loanFileId, w.tx);
  if (file?.borrowers[0]?.partyId !== w.partyId) {
    throw new Error(
      `persona ${w.story.key}: the co-borrower sorts first, so every borrowers[0] read would be the wrong person`,
    );
  }

  await ensureApplicationParty(w.tx, w.applicationId, party.id, "CO_BORROWER");
  await grantConsent(w.tx, w.loanFileId, dev.id, "verification_authorization");
  await pinTridPieces(w.tx, { applicationId: w.applicationId, partyId: party.id });
}

/* ── Running it ───────────────────────────────────────────────────────────── */

export interface SeedReport {
  readonly key: PersonaKey;
  readonly result: "seeded" | "exists" | "drift" | "deferred";
  readonly state: ApplicationState | null;
  readonly expected: ApplicationState | null;
  readonly loanFileId: string | null;
}

/**
 * The one gate. The seed writes sample rows that a sign-in page offers to
 * anyone, so it refuses to run anywhere the flag that mounts that sign-in is
 * not set — which means it cannot be pointed at production without also
 * turning on the thing that would make the rows reachable.
 */
function assertEnabled(): void {
  if (process.env.DEMO_PERSONAS !== "true") {
    throw new Error(
      "seed-personas refuses to run without DEMO_PERSONAS=true. " +
        "It writes sample borrowers that the persona sign-in offers to anyone, " +
        "and that sign-in is mounted by the same flag.",
    );
  }
}

async function seedPersona(story: SeededPersona): Promise<SeedReport> {
  const existing = await prisma.user.findUnique({
    where: { personaKey: story.key },
    select: {
      id: true,
      loanFiles: {
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { id: true, application: { select: { status: true } } },
      },
    },
  });
  if (existing) {
    const file = existing.loanFiles[0];
    const state = file?.application ? toDomainState(file.application.status) : null;
    return {
      key: story.key,
      result: state === story.target ? "exists" : "drift",
      state,
      expected: story.target,
      loanFileId: file?.id ?? null,
    };
  }

  // One interactive transaction per persona: the whole walk commits or none of
  // it does, so a persona that cannot reach its state leaves nothing behind
  // for the next run to skip past. Never an isolation level — the TRID receipt
  // refuses to run under REPEATABLE READ.
  const loanFileId = await prisma.$transaction(
    async (tx) => {
      const user = await tx.user.create({
        data: {
          // The reserved `.invalid` TLD can never be a real Google account and
          // still passes screen 2's email validation.
          googleSub: `persona:${story.key}`,
          email: `${story.key}@personas.supermortgage.invalid`,
          // The row's label, deliberately: this is what the banner says the
          // tester is signed in as, and Priya's row opens a file with two
          // people on it. The legal name of the person who signs is in PERSON.
          name: `${story.name.first} ${story.name.last}`,
          personaKey: story.key,
        },
        select: { id: true },
      });

      const one = await screenOne(tx, story, user.id);
      const two = await screenTwo(tx, story, one);
      const w: Walk = {
        tx,
        story,
        registry: fixtureRegistry({
          persona: story.fixture,
          latencyMs: 0,
          ...(story.fixtureOptions?.screening ? { screening: story.fixtureOptions.screening } : {}),
        }),
        loanFileId: one.loanFileId,
        applicationId: one.applicationId,
        partyId: two.partyId,
        borrowerId: two.borrowerId,
      };
      await WALKS[story.key](w);

      // Asserted HERE, before the commit. After it, a persona that landed
      // somewhere else would be durable, and every later run would find a row
      // and skip it — so the first deploy would fail and every one after it
      // would pass with the wrong state on the sign-in page.
      const app = await tx.application.findUniqueOrThrow({
        where: { id: one.applicationId },
        select: { status: true },
      });
      const landed = toDomainState(app.status);
      if (landed !== story.target) {
        throw new Error(
          `persona ${story.key} drift: expected ${story.target}, walked to ${landed}`,
        );
      }
      if (story.expectedOutcome) {
        const decision = await tx.decision.findFirst({
          where: { loanFileId: one.loanFileId },
          orderBy: { computedAt: "desc" },
          select: { outcome: true },
        });
        if (decision?.outcome !== story.expectedOutcome) {
          throw new Error(
            `persona ${story.key} drift: expected outcome ${story.expectedOutcome}, got ${decision?.outcome ?? "none"}`,
          );
        }
      }
      return one.loanFileId;
    },
    { timeout: 120_000, maxWait: 10_000 },
  );

  return {
    key: story.key,
    result: "seeded",
    state: story.target,
    expected: story.target,
    loanFileId,
  };
}

/**
 * Re-create exactly one persona.
 *
 * Never the default: a persona that exists is history somebody may be looking
 * at. Deleting the user takes the file, the application, its ledger, its pins
 * and its clocks — by a BEFORE DELETE trigger that removes the files while the
 * user row is still standing, which is the only order in which the ledger is
 * gone before the principals it names. Dev has no user of his own, so his
 * party is found through the file and removed afterwards.
 */
export async function resetPersona(key: PersonaKey): Promise<void> {
  assertEnabled();
  const user = await prisma.user.findUnique({
    where: { personaKey: key },
    select: {
      id: true,
      partyId: true,
      loanFiles: { select: { borrowers: { select: { partyId: true } } } },
    },
  });
  if (!user) return;

  const others = new Set<string>();
  for (const file of user.loanFiles) {
    for (const b of file.borrowers) if (b.partyId !== user.partyId) others.add(b.partyId);
  }

  await prisma.user.delete({ where: { id: user.id } });
  // Only a party this seed made and nobody else holds. A party with a user, or
  // one still named by a borrower row, belongs to somebody else's file.
  for (const partyId of others) {
    const held = await prisma.party.findUnique({
      where: { id: partyId },
      select: { sourceFirstSeen: true, users: { take: 1 }, borrowerRows: { take: 1 } },
    });
    if (!held || held.users.length > 0 || held.borrowerRows.length > 0) continue;
    if (held.sourceFirstSeen !== "persona_seed") continue;
    await prisma.party.delete({ where: { id: partyId } });
  }
}

/**
 * Remove what the old demo seed left: files with no owner, and the parties it
 * minted for them. Matches nothing after the first run.
 */
export async function purgeLegacyDemo(): Promise<{ files: number; parties: number }> {
  assertEnabled();
  const files = await prisma.loanFile.deleteMany({ where: { isDemo: true, userId: null } });
  const orphans = await prisma.party.findMany({
    where: {
      sourceFirstSeen: "demo_seed",
      users: { none: {} },
      borrowerRows: { none: {} },
    },
    select: { id: true },
  });
  for (const party of orphans) await prisma.party.delete({ where: { id: party.id } });
  return { files: files.count, parties: orphans.length };
}

/**
 * Walk every persona that is not already standing where it should be.
 *
 * The list is a parameter so a test can hand it one story with a deliberately
 * wrong target and watch the run fail with nothing written. Production passes
 * nothing: there is one list, and it is `PERSONA_STORIES`.
 */
export async function seedAll(
  stories: readonly PersonaStory[] = PERSONA_STORIES,
): Promise<SeedReport[]> {
  assertEnabled();
  const reports: SeedReport[] = [];
  for (const story of stories) {
    if (!isSeeded(story)) {
      reports.push({
        key: story.key,
        result: "deferred",
        state: null,
        expected: null,
        loanFileId: null,
      });
      continue;
    }
    reports.push(await seedPersona(story));
  }
  return reports;
}

/** One line per persona, and the ledger behind each one that was walked. */
function line(report: SeedReport): string {
  switch (report.result) {
    case "deferred":
      return `persona ${report.key} deferred`;
    case "exists":
      return `persona ${report.key} exists (${report.state})`;
    case "drift":
      return `persona ${report.key} DRIFT expected ${report.expected}, is ${report.state ?? "none"}`;
    default:
      return `persona ${report.key} seeded ${report.state} file=${report.loanFileId}`;
  }
}

async function printHistory(report: SeedReport): Promise<void> {
  if (!report.loanFileId) return;
  const app = await prisma.application.findUnique({
    where: { loanFileId: report.loanFileId },
    select: {
      transitions: {
        orderBy: { seq: "asc" },
        select: {
          seq: true,
          fromState: true,
          toState: true,
          event: true,
          reasonCode: true,
          actor: { select: { kind: true, subject: true } },
        },
      },
      clocks: { select: { kind: true, dueAt: true, tolledFrom: true, satisfiedAt: true } },
    },
  });
  for (const t of app?.transitions ?? []) {
    console.log(
      `  ${t.seq}  ${t.fromState} → ${t.toState}  ${t.event}  ${t.actor.kind}:${t.actor.subject}  ${t.reasonCode ?? "—"}`,
    );
  }
  for (const c of app?.clocks ?? []) {
    const state = c.satisfiedAt ? "satisfied" : c.tolledFrom ? "tolled" : "running";
    console.log(`  clock ${c.kind} due ${c.dueAt.toISOString().slice(0, 10)} (${state})`);
  }
}

/**
 * Leave with a failure, once the pipe has actually taken what we printed.
 *
 * The deploy step captures this script's output through a subshell and echoes
 * it back before it decides anything, so the report IS the failure message.
 * `process.exit` does not flush a pipe that is still draining, and the one run
 * that exits non-zero is the one whose report nobody can afford to lose.
 */
async function failAfterFlush(): Promise<never> {
  await new Promise<void>((resolve) => {
    process.stdout.write("", () => resolve());
  });
  process.exit(1);
}

async function main(): Promise<void> {
  assertEnabled();
  const argv = process.argv.slice(2);

  if (argv.includes("--purge-legacy-demo")) {
    const removed = await purgeLegacyDemo();
    console.log(`purged ${removed.files} legacy demo file(s), ${removed.parties} party(ies)`);
  }
  const resetAt = argv.indexOf("--reset");
  if (resetAt !== -1) {
    const key = argv[resetAt + 1];
    if (!key) throw new Error("--reset needs a persona key");
    if (!PERSONA_STORIES.some((s) => s.key === key)) throw new Error(`no such persona: ${key}`);
    await resetPersona(key as PersonaKey);
    console.log(`reset ${key}`);
  }

  const reports = await seedAll();
  for (const report of reports) {
    console.log(line(report));
    await printHistory(report);
  }
  await prisma.$disconnect();

  // A drift found on a re-run is not a warning. The sign-in page shows the
  // LIVE state beside each name, so a drifted persona is a wrong answer on a
  // public page until somebody resets it.
  if (reports.some((r) => r.result === "drift")) await failAfterFlush();
}

// Only when this file is what was run. The tests import `seedAll`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    await failAfterFlush();
  });
}
