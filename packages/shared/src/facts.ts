/**
 * The fact ledger, and how you read one value out of it.
 *
 * A fact is one assertion: somebody said something about somebody, at a time,
 * from a source, with a degree of confidence. Nothing is ever edited — a
 * correction is a new row, and the old one is superseded or retracted. That is
 * what makes "what did the borrower tell us, and when" answerable, which is the
 * axis an ECOA complaint runs along.
 *
 * Everything here is pure. The ordering and staleness rules are the part most
 * likely to be got wrong and the part that most needs to be testable without a
 * database, so they live in a function rather than in a query.
 *
 * Domain identifiers are lowercase here and UPPER_SNAKE in Postgres, matching
 * how `FlowStage` is already handled — see `packages/db/prisma/schema.prisma`.
 */

/** Where an assertion came from. Not how far we trust it. */
export type FactSourceKind =
  | "self_attested"
  | "staff_entered"
  | "vendor_retrieved"
  | "public_record"
  | "document_extracted"
  | "partner_shared"
  | "ai_inferred"
  | "derived";

/**
 * How well we know something, weakest first.
 *
 * The order is the point, and it is the same order Postgres compares the enum
 * in, so `confidence >= corroborated` means the same thing in a query and in a
 * predicate here.
 *
 * The line that earns its keep is `verified`. Plaid Assets and Plaid CRA return
 * identical bytes from the same bank login, and only CRA carries FCRA
 * consumer-report status — same data, different tier, and requirements turn on
 * the tier rather than on the bytes. An AI principal is barred by the database
 * from writing the top two.
 */
export const CONFIDENCE_TIERS = [
  "attested",
  "unverified",
  "inferred",
  "estimated",
  "corroborated",
  "verified",
  "validated_d1c",
] as const;

export type ConfidenceTier = (typeof CONFIDENCE_TIERS)[number];

/** Is `tier` at least as strong as `floor`? */
export function atLeast(tier: ConfidenceTier, floor: ConfidenceTier): boolean {
  return CONFIDENCE_TIERS.indexOf(tier) >= CONFIDENCE_TIERS.indexOf(floor);
}

export interface Fact {
  readonly id: string;
  readonly predicate: string;
  /** Discriminates repeated facts of one predicate — an employer, an account. */
  readonly subjectKey: string;
  readonly value: unknown;
  readonly sourceKind: FactSourceKind;
  readonly confidence: ConfidenceTier;
  /** When it was true in the world. */
  readonly observedAt: string;
  /** When we wrote it down. A backdated correction has an earlier
   *  `observedAt` and a later `recordedAt` than the row it replaces. */
  readonly recordedAt: string;
  /** Null means it does not go stale on its own. A filed tax year never does;
   *  a credit pull does. */
  readonly expiresAt: string | null;
  readonly supersededById: string | null;
  readonly retractedAt: string | null;
}

/**
 * What we know about one predicate right now.
 *
 * Three outcomes, and the third is the one the product keeps getting wrong
 * elsewhere: `absent` is "nobody has ever told us", which is not the same
 * answer as a value of false, and not the same answer as `expired`.
 */
export type FactStanding =
  | { readonly status: "live"; readonly fact: Fact }
  | { readonly status: "expired"; readonly fact: Fact }
  | { readonly status: "absent"; readonly fact: null };

/**
 * Pick the current assertion for one predicate.
 *
 * Retracted and superseded rows are out — a retraction says it was never true,
 * a supersession says something newer replaced it. Of what is left, the most
 * recently OBSERVED wins, not the most recently recorded: a paystub from
 * January entered today does not outrank one from March entered last week.
 * `recordedAt` breaks a tie, and the id breaks that, so the answer is stable
 * rather than dependent on row order.
 */
export function standingOf(
  facts: readonly Fact[],
  predicate: string,
  now: Date,
  subjectKey = "",
): FactStanding {
  const live = facts
    .filter(
      (f) =>
        f.predicate === predicate &&
        f.subjectKey === subjectKey &&
        f.retractedAt === null &&
        f.supersededById === null,
    )
    .sort(
      (a, b) =>
        b.observedAt.localeCompare(a.observedAt) ||
        b.recordedAt.localeCompare(a.recordedAt) ||
        b.id.localeCompare(a.id),
    );

  const current = live[0];
  if (!current) return { status: "absent", fact: null };
  if (current.expiresAt !== null && Date.parse(current.expiresAt) <= now.getTime()) {
    return { status: "expired", fact: current };
  }
  return { status: "live", fact: current };
}

/**
 * Does what we hold meet an evidence floor?
 *
 * Deliberately returns three values rather than a boolean. "We have not asked"
 * and "we asked and it does not clear the bar" want different screens, and
 * collapsing them is how a borrower gets told they are finished when nobody
 * has looked.
 */
export function meetsFloor(
  standing: FactStanding,
  floor: ConfidenceTier,
): "met" | "not_met" | "unknown" {
  if (standing.status === "absent") return "unknown";
  if (standing.status === "expired") return "not_met";
  return atLeast(standing.fact.confidence, floor) ? "met" : "not_met";
}
