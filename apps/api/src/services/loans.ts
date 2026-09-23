/**
 * Making a loan, and deciding whose it is.
 *
 * Two constructors, because there are two beginnings and the database refuses
 * every other one. A mortgage we funded is born `pending_boarding`; a mortgage
 * a servicer told us about is born `imported_unclaimed`, attached to people who
 * have never signed in. Neither is reachable from the other, and everything
 * after either is a move somebody caused, through `moveLoan`.
 *
 * Both write at `status_seq = 0` with no ledger row, which the deferred check
 * permits at seq 0 exactly as it does for a draft application: a birth is not a
 * move, and there is nothing to explain about a row arriving where it is
 * supposed to arrive.
 */

import type {
  ApplicationPartyRole,
  LienPosition,
  Loan,
  LoanProgram,
  LoanRateType,
  Occupancy,
  ScenarioObjective,
} from "@hm/db";
import { randomUUID } from "node:crypto";
import { AppError } from "../middleware/error-handler.js";
import { type Db, inChunks } from "./db.js";

/** Terms as of origination. Everything that moves month to month is an observation. */
export interface LoanTerms {
  readonly rateType: LoanRateType;
  readonly noteRateBps: number;
  readonly termMonths: number;
  readonly originalPrincipalCents: bigint;
  readonly originatedOn?: Date | null;
  readonly firstPaymentOn?: Date | null;
  readonly maturityOn?: Date | null;
}

/** Where the house is, in the same words `loan_scenarios` uses until there is a Property. */
export interface LoanProperty {
  readonly line1?: string | null;
  readonly line2?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly postalCode?: string | null;
  readonly apn?: string | null;
}

/**
 * The four axes, three-valued.
 *
 * A NULL says the feed did not tell us, and nothing may turn that into a guess:
 * an objective inferred from a channel, or an occupancy defaulted to primary
 * residence, is a fact about somebody's mortgage that nobody asserted. A CHECK
 * requires all four on a loan we originated, which is why the originated
 * constructor takes them without the nulls.
 */
export interface LoanAxes {
  readonly objective?: ScenarioObjective | null;
  readonly program?: LoanProgram | null;
  readonly lienPosition?: LienPosition | null;
  readonly occupancy?: Occupancy | null;
}

/** Who is on the mortgage, and in what capacity. Plural from the start. */
export interface LoanPartyInput {
  readonly partyId: string;
  readonly role: ApplicationPartyRole;
}

/**
 * A mortgage a servicer sent us, attached to people who have never signed in.
 *
 * The axes arrive as whatever the feed said, nulls included. `servicerId` is
 * nullable for the same reason: a record naming a servicer we have no row for
 * is a rejection the importer records, not a servicer we invent.
 */
export interface ImportedLoanInput {
  readonly terms: LoanTerms;
  readonly property: LoanProperty;
  readonly axes: LoanAxes;
  readonly parties: readonly LoanPartyInput[];
  readonly servicerId: string | null;
  /** The servicer's own number for it, which is how the next tape finds it. */
  readonly servicerLoanNumber?: string | null;
}

export async function createImportedLoan(
  tx: Db,
  args: ImportedLoanInput,
): Promise<{ loanId: string }> {
  return create(tx, {
    status: "IMPORTED_UNCLAIMED",
    source: "PARTNER_IMPORT",
    servicerId: args.servicerId,
    servicerLoanNumber: args.servicerLoanNumber ?? null,
    axes: args.axes,
    terms: args.terms,
    property: args.property,
    parties: args.parties,
    originatingApplicationId: null,
  });
}

/**
 * A servicer's whole book at once: the same rows `createImportedLoan` makes,
 * as a few statements rather than one per loan, because a book is thousands
 * of rows and one transaction. The ids are minted here so the parties can be
 * written in the statement after the loans, inside the same transaction —
 * which keeps the one rule the single constructor holds: no loan is ever
 * committed with nobody on it.
 */
export async function createImportedLoans(
  tx: Db,
  rows: readonly ImportedLoanInput[],
): Promise<{ loanIds: string[] }> {
  for (const r of rows) {
    if (r.parties.length === 0) {
      throw new Error(
        "a loan is created with the people on it; there is no later step that adds them",
      );
    }
  }
  const loanIds = rows.map(() => randomUUID());
  await inChunks(rows, (chunk, offset) =>
    tx.loan.createMany({
      data: chunk.map((r, i) => ({
        id: loanIds[offset + i]!,
        ...loanColumns({
          status: "IMPORTED_UNCLAIMED",
          source: "PARTNER_IMPORT",
          servicerId: r.servicerId,
          servicerLoanNumber: r.servicerLoanNumber ?? null,
          axes: r.axes,
          terms: r.terms,
          property: r.property,
          originatingApplicationId: null,
        }),
      })),
    }),
  );
  await inChunks(
    rows.flatMap((r, i) =>
      r.parties.map((p) => ({ loanId: loanIds[i]!, partyId: p.partyId, role: p.role })),
    ),
    (chunk) => tx.loanParty.createMany({ data: chunk }),
  );
  return { loanIds };
}

/**
 * A mortgage we funded, on its way to a servicer.
 *
 * All four axes are required, because we know our own — the CHECK says so, and
 * this signature says it a step earlier, where the caller can still be told
 * which one it forgot in a language it compiles in.
 */
export async function createOriginatedLoan(
  tx: Db,
  args: {
    applicationId: string;
    terms: LoanTerms;
    property: LoanProperty;
    axes: Required<{ [K in keyof LoanAxes]: NonNullable<LoanAxes[K]> }>;
    parties: readonly LoanPartyInput[];
    servicerId?: string | null;
  },
): Promise<{ loanId: string }> {
  return create(tx, {
    status: "PENDING_BOARDING",
    source: "ORIGINATION",
    servicerId: args.servicerId ?? null,
    servicerLoanNumber: null,
    axes: args.axes,
    terms: args.terms,
    property: args.property,
    parties: args.parties,
    originatingApplicationId: args.applicationId,
  });
}

/**
 * The row and its parties, in one act. A loan with nobody on it is not a shape
 * we make, and this is where that stops being an aspiration.
 *
 * The refusal is load-bearing rather than tidy. `users_delete_takes_loans`
 * sweeps away a mortgage the deletion left with nobody on it, and its whole
 * argument is that such a row is not a record about anybody — which holds only
 * while a parentless loan is a half-written import somebody is going to notice,
 * never a shape a constructor hands out. It throws rather than returning a
 * refusal code: no caller can recover from it, and nothing borrower-facing is
 * on the other side of it.
 */
async function create(
  tx: Db,
  args: {
    status: "IMPORTED_UNCLAIMED" | "PENDING_BOARDING";
    source: "PARTNER_IMPORT" | "ORIGINATION";
    servicerId: string | null;
    servicerLoanNumber: string | null;
    axes: LoanAxes;
    terms: LoanTerms;
    property: LoanProperty;
    parties: readonly LoanPartyInput[];
    originatingApplicationId: string | null;
  },
): Promise<{ loanId: string }> {
  if (args.parties.length === 0) {
    throw new Error(
      "a loan is created with the people on it; there is no later step that adds them",
    );
  }
  const loan = await tx.loan.create({
    data: {
      ...loanColumns(args),
      parties: {
        create: args.parties.map((p) => ({ partyId: p.partyId, role: p.role })),
      },
    },
    select: { id: true },
  });
  return { loanId: loan.id };
}

/** The row's own columns, the one spelling both constructors write. */
function loanColumns(args: {
  status: "IMPORTED_UNCLAIMED" | "PENDING_BOARDING";
  source: "PARTNER_IMPORT" | "ORIGINATION";
  servicerId: string | null;
  servicerLoanNumber: string | null;
  axes: LoanAxes;
  terms: LoanTerms;
  property: LoanProperty;
  originatingApplicationId: string | null;
}) {
  return {
    status: args.status,
    source: args.source,
    originatingApplicationId: args.originatingApplicationId,
    servicerId: args.servicerId,
    servicerLoanNumber: args.servicerLoanNumber,
    objective: args.axes.objective ?? null,
    program: args.axes.program ?? null,
    lienPosition: args.axes.lienPosition ?? null,
    occupancy: args.axes.occupancy ?? null,
    rateType: args.terms.rateType,
    noteRateBps: args.terms.noteRateBps,
    termMonths: args.terms.termMonths,
    originalPrincipalCents: args.terms.originalPrincipalCents,
    originatedOn: args.terms.originatedOn ?? null,
    firstPaymentOn: args.terms.firstPaymentOn ?? null,
    maturityOn: args.terms.maturityOn ?? null,
    propertyLine1: args.property.line1 ?? null,
    propertyLine2: args.property.line2 ?? null,
    propertyCity: args.property.city ?? null,
    propertyState: args.property.state ?? null,
    propertyPostalCode: args.property.postalCode ?? null,
    propertyApn: args.property.apn ?? null,
  };
}

/**
 * This loan, if it is this person's. Otherwise it does not exist.
 *
 * The party-keyed access primitive, which is not `assertFileAccess` with a
 * different table: that one is keyed on `loan_files.user_id` and cannot express
 * "this mortgage belongs to the party behind this session". A person's second
 * application and their imported mortgage reach the same party, and a
 * co-borrower reaches the same loan through a row of their own.
 *
 * It copies exactly one thing from `assertFileAccess`, deliberately: a missing
 * loan and somebody else's loan are the SAME refusal, in the same words. A 403
 * on the second would confirm the id exists, which is an enumeration oracle for
 * anyone holding a session. Here the two cannot even be told apart from inside
 * the service, because one statement answers both.
 *
 * It copies nothing else, and the omission that matters is the demo carve-out.
 * `assertFileAccess` checks `isDemo` before ownership, which is right for a
 * sample file everybody is meant to read and would be catastrophic here: a demo
 * mortgage would be a mortgage readable by every signed-in user.
 *
 * One query. The session's user, their party, and that party's link to the loan
 * are one join, so a person with no party yet is refused by the same statement
 * that refuses a stranger rather than by a branch above it.
 */
export async function assertLoanAccess(db: Db, loanId: string, userId: string): Promise<Loan> {
  const loan = await db.loan.findFirst({
    where: { id: loanId, parties: { some: { party: { users: { some: { id: userId } } } } } },
  });
  if (!loan) throw new AppError(404, "Loan not found", "NOT_FOUND");
  return loan;
}
