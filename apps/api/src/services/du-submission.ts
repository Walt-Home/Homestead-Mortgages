/**
 * Submitting an application to Desktop Underwriter.
 *
 * Every piece existed and was tested alone — the assembler, the preflight
 * gate, the emitter, the `du` port with its guard, the transport, the response
 * tables — and nothing strung them together for an application. This is the
 * string: assemble, gate, emit, send, record, in that order, with every way it
 * can stop written down as an outcome rather than thrown at a borrower.
 *
 * Three things it is careful about:
 *
 *   1. **A refusal is recorded, never skipped.** Staging runs with the
 *      placeholder institution and originator under `NODE_ENV=production`, so
 *      an assembly there is refused before a row is read. That refusal, and a
 *      preflight refusal, and a borrower with nothing retrieved about them,
 *      each become an outcome and a `FileEvent` naming why. A submission that
 *      silently did not happen reads exactly like one that was never tried.
 *   2. **Nothing here is a decision.** What comes back is Fannie Mae's
 *      assessment of a loan they might buy; the creditor is Grander, the
 *      shadow decision stands, and `recordDuResponse` moves no application.
 *      The caller renders the recommendation beside the decision, not as it.
 *   3. **The document is not kept.** It carries up to four cleartext social
 *      security numbers. It lives in memory between the emitter and the
 *      transport and nowhere else; the outcome and the events carry the
 *      casefile id, the recommendation and the messages, never the bytes.
 *
 * The taxpayer identifiers: there is no vault to read a real number from,
 * and `borrowers.ssn_vault_handle` is opaque on purpose. Against the FIXTURE
 * adapter, in any environment, the resolver hands the assembler a nine-digit
 * value that no person has ever been issued — the 000 area — so the path can
 * be walked end to end and the fixture discards it. Against Fannie Mae there
 * is no resolver, the container is omitted, and the preflight refuses the
 * casefile for every borrower's missing identifier, which is the honest state
 * until a vault exists.
 */

import { createHash } from "node:crypto";
import { prisma } from "@hm/db";
import {
  AuthorizationError,
  DuTransportError,
  type DuConnector,
  type DuSubmission,
} from "@hm/connectors";
import {
  DuPreflightRefusal,
  emitSubmission,
  originatorPlaceholdersIn,
  placeholdersIn,
  type AssembleOptions,
  type DuInstitution,
  type DuOriginator,
} from "@hm/du";
import {
  household,
  type DataCategory,
  type DuRecommendation,
  type LoanFile,
  type PurposeToken,
} from "@hm/shared";
import { config } from "../config.js";
import { tokenFor } from "./authorization.js";
import { connectors, duInstitutionFromConfig } from "./connectors.js";
import type { Db } from "./db.js";
import { recordDuResponse } from "./du-response.js";
import { originatorFromConfig } from "./originator.js";
import { recordEvent } from "./repository.js";

export type DuSubmissionOutcome =
  | {
      readonly status: "answered";
      readonly recommendation: DuRecommendation;
      readonly duCasefileId: string;
      readonly responseId: string;
      readonly seq: number;
    }
  | {
      readonly status: "errored";
      readonly duCasefileId: string | null;
      readonly responseId: string;
      readonly seq: number;
    }
  | {
      readonly status: "refused";
      readonly reason:
        "no_application" | "placeholders" | "nothing_retrieved" | "authorization" | "preflight";
      /** Safe to log: names, ids, XPaths and requirement ids, never a value. */
      readonly detail: readonly string[];
    }
  | {
      readonly status: "failed";
      readonly reason: "transport";
      readonly mayHaveOpenedACase: boolean;
      readonly detail: string;
    };

export interface SubmitOptions {
  readonly loanFileId: string;
  readonly file: LoanFile;
  readonly now: Date;
  readonly db?: Db;
  /** The port to send through. The registry's, unless a seed or a test brings its own. */
  readonly du?: DuConnector;
  /** What the deployment is, for the placeholder refusal. `config.nodeEnv` unless a test says otherwise. */
  readonly nodeEnv?: string;
  readonly institution?: DuInstitution;
  readonly originator?: DuOriginator;
  readonly taxpayerIdentifiers?: AssembleOptions["taxpayerIdentifiers"];
}

/** Which categories a person's own reports say were retrieved about them. */
const CATEGORY_FOR = {
  credit: "credit_report",
  assets: "bank_transactions",
  payroll: "payroll_income",
  transcripts: "tax_transcript",
} as const satisfies Record<string, DataCategory>;

/**
 * A value that is nine digits and was never issued to anybody: the Social
 * Security Administration has never used the 000 area. Deterministic per
 * party so two borrowers on one fixture casefile do not collide.
 */
export function fixtureTaxpayerIdentifier(partyId: string): string {
  const digits = createHash("sha256").update(partyId).digest("hex").replace(/[a-f]/g, "");
  return `000${digits.padEnd(6, "0").slice(0, 6)}`;
}

export async function submitApplicationToDu(options: SubmitOptions): Promise<DuSubmissionOutcome> {
  const { loanFileId, file, now } = options;
  const db = options.db ?? prisma;
  const du = options.du ?? connectors().du;
  const nodeEnv = options.nodeEnv ?? config.nodeEnv;
  const institution = options.institution ?? duInstitutionFromConfig();
  const originator = options.originator ?? originatorFromConfig();
  const taxpayerIdentifiers =
    options.taxpayerIdentifiers ??
    (du.capabilities.mode === "fixture"
      ? async (p: string) => fixtureTaxpayerIdentifier(p)
      : undefined);

  const refuse = async (
    reason: Extract<DuSubmissionOutcome, { status: "refused" }>["reason"],
    detail: readonly string[],
  ): Promise<DuSubmissionOutcome> => {
    await recordEvent(
      loanFileId,
      "du_submission_refused",
      "system",
      { reason, detail },
      "UW-001",
      db,
    );
    return { status: "refused", reason, detail };
  };

  const application = await db.application.findUnique({
    where: { loanFileId },
    select: { id: true, ausCasefileId: true, duCasefileId: true },
  });
  if (!application) return refuse("no_application", ["the file has no application to submit"]);

  // The refusal the assembler would make one package over, made here first so
  // it is an outcome with a name rather than an exception with a message.
  if (nodeEnv === "production") {
    const standing = [
      ...placeholdersIn(institution).map((p) => `institution.${p}`),
      ...originatorPlaceholdersIn(originator).map((p) => `originator.${p}`),
    ];
    if (standing.length > 0) return refuse("placeholders", standing);
  }

  // Who is in the casefile and what was retrieved about each of them: the
  // manifest the port's guard checks authorizations against. A borrower with
  // nothing retrieved cannot be transmitted, and the guard would say so; said
  // here, it names the person.
  const members = household(file);
  const borrowers = members.map((member, index) => ({
    member,
    borrowerOrdinal: index + 1,
    dataCategories: (Object.keys(CATEGORY_FOR) as (keyof typeof CATEGORY_FOR)[])
      .filter((kind) =>
        kind === "transcripts" ? member.transcripts.length > 0 : member[kind] !== null,
      )
      .map((kind) => CATEGORY_FOR[kind]),
  }));
  const bare = borrowers.filter((b) => b.dataCategories.length === 0);
  if (borrowers.length === 0 || bare.length > 0) {
    return refuse(
      "nothing_retrieved",
      bare.length ? bare.map((b) => b.member.name) : ["no borrower on the file"],
    );
  }

  // One token per person per category, minted on that person's own consent
  // on THIS file. A person who has not signed refuses here, by name.
  const tokens: PurposeToken[] = [];
  try {
    for (const b of borrowers) {
      if (!b.member.borrower) throw new AuthorizationError("a borrower with no row", "APP-005");
      for (const category of b.dataCategories) {
        tokens.push(await tokenFor(file, b.member.borrower, category, db));
      }
    }
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return refuse("authorization", [`${err.requirementId}: ${err.message}`]);
    }
    throw err;
  }

  let document: string;
  try {
    document = await emitSubmission(db, application.id, {
      createdAt: now,
      institution,
      taxpayerIdentifiers,
    });
  } catch (err) {
    if (err instanceof DuPreflightRefusal) {
      return refuse(
        "preflight",
        err.findings.map((f) => `${f.check} ${f.where}: ${f.message}`),
      );
    }
    throw err;
  }

  const submission: DuSubmission = {
    applicationId: application.id,
    loanFileId,
    ausCasefileId: application.ausCasefileId,
    duCasefileId: application.duCasefileId,
    borrowers: borrowers.map((b) => ({
      partyId: b.member.partyId!,
      borrowerOrdinal: b.borrowerOrdinal,
      dataCategories: b.dataCategories,
    })),
    document,
  };

  let answer;
  try {
    answer = await du.submit(submission, tokens);
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return refuse("authorization", [`${err.requirementId}: ${err.message}`]);
    }
    if (err instanceof DuTransportError) {
      await recordEvent(
        loanFileId,
        "du_submission_failed",
        "system",
        { reason: "transport", mayHaveOpenedACase: err.mayHaveOpenedACase, detail: err.message },
        "UW-001",
        db,
      );
      return {
        status: "failed",
        reason: "transport",
        mayHaveOpenedACase: err.mayHaveOpenedACase,
        detail: err.message,
      };
    }
    throw err;
  }

  const recorded = await recordDuResponse(submission, answer, now, db);
  const response = answer.data;
  await recordEvent(
    loanFileId,
    "du_submitted",
    answer.provider,
    {
      seq: recorded.seq,
      status: response.status,
      duCasefileId: response.duCasefileId,
      recommendation: response.status === "answered" ? response.recommendation : null,
      resubmission: application.duCasefileId !== null,
    },
    "UW-001",
    db,
  );
  return response.status === "answered"
    ? {
        status: "answered",
        recommendation: response.recommendation,
        duCasefileId: response.duCasefileId,
        responseId: recorded.id,
        seq: recorded.seq,
      }
    : {
        status: "errored",
        duCasefileId: response.duCasefileId,
        responseId: recorded.id,
        seq: recorded.seq,
      };
}
