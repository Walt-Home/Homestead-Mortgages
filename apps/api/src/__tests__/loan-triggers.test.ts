/**
 * The two ledgers are enforced by the same words, or they are not the same
 * ledger.
 *
 * Every guarantee that makes the application ledger trustworthy is written per
 * table — a polymorphic transitions table can carry a declared foreign key to
 * neither aggregate, and the deferred check fires on the aggregate rather than
 * on the ledger anyway. So the SQL is duplicated on purpose and the TypeScript
 * is shared, and the cost of that choice is four near-identical pairs of
 * plpgsql functions that a future migration can patch one half of.
 *
 * That is the failure this file exists to catch. It reads both families out of
 * `pg_get_functiondef`, undoes the substitutions the loan migration made, and
 * requires what is left to be identical — so a fix applied to
 * `applications_terminal_is_final` and not to `loans_terminal_is_final` is red
 * here rather than a difference nobody notices until a loan is reopened.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";

/**
 * The four rules both aggregates keep, by the name each family gives them.
 *
 * The birth guard is not here, and its absence is the honest kind: an
 * application has one beginning and a column default, a loan has two and a
 * trigger, so there is nothing to compare it against.
 */
const SHARED = [
  { application: "applications_status_moves_with_seq", loan: "loans_status_moves_with_seq" },
  { application: "applications_terminal_is_final", loan: "loans_terminal_is_final" },
  { application: "applications_status_has_a_ledger_row", loan: "loans_status_has_a_ledger_row" },
  { application: "application_transitions_append_only", loan: "loan_transitions_append_only" },
];

/**
 * Every plpgsql function the loan migration writes, and nothing else.
 *
 * Three of them are not named `loans_` or `loan_transitions_` and are here
 * anyway, because the migration writes them: the orphan sweep, and the two
 * shipped functions it replaces. A list scoped to the loan's own prefixes would
 * be blind to the sweep going missing, which is the one function here that
 * nothing else in this suite would notice the absence of until an account could
 * not be deleted.
 */
const MIGRATION_FUNCTIONS = [
  "applications_status_has_a_ledger_row",
  "loan_transitions_actor_outlives_people",
  "loan_transitions_append_only",
  "loans_is_born_not_placed",
  "loans_refinanced_names_its_successor",
  "loans_status_has_a_ledger_row",
  "loans_status_moves_with_seq",
  "loans_terminal_is_final",
  "users_delete_takes_loans",
  "users_delete_takes_party",
];

/**
 * Undo what the migration substituted, and nothing more.
 *
 * The aggregate's own nouns, the tables it keeps its state and its history in,
 * and its set of endings are the whole of the difference between the two
 * families — plus one sentence, which is not a substitution and is not treated
 * as one. An application's terminal refusal ends by telling the reader to start
 * a new one, which is advice a loan cannot be given: nobody starts a new
 * mortgage because the old one paid off, and a substituted noun would put a
 * false instruction in the message a person eventually reads.
 *
 * So that clause is stripped from the APPLICATION's text and from nothing else.
 * Stripping it from both sides would undo a difference rather than a
 * substitution, and would let a loan trigger that grew an application-flavored
 * clause normalize to equal — which is the one thing this file exists to
 * refuse.
 */
function normalize(def: string): string {
  return def
    .replaceAll("; start a new application", "")
    .replace(/application_transitions|loan_transitions/g, "%LEDGER%")
    .replace(/applications|loans/g, "%TABLE%")
    .replace(
      /'FUNDED','DENIED','INCOMPLETE_CLOSED','WITHDRAWN','CANCELED','EXPIRED'/g,
      "%TERMINAL%",
    )
    .replace(
      /'PAID_OFF','REFINANCED_INTERNALLY','TRANSFERRED_OUT','CHARGED_OFF','MATURED'/g,
      "%TERMINAL%",
    )
    .replace(/application|loan/g, "%NOUN%");
}

async function definition(name: string): Promise<string> {
  const rows = await prisma.$queryRaw<{ def: string }[]>`
    SELECT pg_get_functiondef(p.oid) AS def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ${name}
  `;
  expect(rows, `${name} is not installed`).toHaveLength(1);
  return rows[0]!.def;
}

describe("the loan ledger is enforced by the same words as the application ledger", () => {
  for (const pair of SHARED) {
    it(`says the same thing in ${pair.loan} as in ${pair.application}`, async () => {
      const [application, loan] = await Promise.all([
        definition(pair.application),
        definition(pair.loan),
      ]);
      expect(normalize(loan)).toBe(normalize(application));
    });
  }

  it("normalizes nothing into nothing", async () => {
    // A normalizer that flattened the two families to a stub would make every
    // assertion above pass for the wrong reason, so what survives it has to
    // still be the rule: the branches, the RAISEs and the sequence arithmetic.
    const normalized = normalize(await definition("loans_status_moves_with_seq"));
    expect(normalized).toContain("NEW.status_seq <> OLD.status_seq + 1");
    expect(normalized).toContain("advanced status_seq without changing status");
    expect(normalized).not.toContain("loan");
    expect(normalized).not.toContain("application");
  });

  it("writes every function the loan migration says it writes, and no others", async () => {
    // The five from the template, the two that have no application twin, the
    // orphan sweep, and the two shipped functions the migration replaces. A
    // migration that drops one is a rule that stopped being enforced, which is
    // invisible in every other test in this suite.
    const rows = await prisma.$queryRaw<{ proname: string }[]>`
      SELECT p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND (p.proname LIKE 'loans\\_%'
          OR p.proname LIKE 'loan\\_transitions\\_%'
          OR p.proname IN ('applications_status_has_a_ledger_row',
                           'users_delete_takes_loans',
                           'users_delete_takes_party'))
    `;
    expect(rows.map((r) => r.proname).sort()).toEqual(MIGRATION_FUNCTIONS);
  });

  it("hangs each of them on the table it governs", async () => {
    const rows = await prisma.$queryRaw<{ tgname: string; relname: string }[]>`
      SELECT t.tgname, c.relname
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname IN ('loans', 'loan_transitions')
      ORDER BY t.tgname
    `;
    expect(rows).toEqual([
      { tgname: "loan_transitions_actor_outlives_people_insert", relname: "loan_transitions" },
      { tgname: "loan_transitions_append_only_update", relname: "loan_transitions" },
      { tgname: "loans_is_born_not_placed_insert", relname: "loans" },
      { tgname: "loans_refinanced_names_its_successor_update", relname: "loans" },
      { tgname: "loans_status_has_a_ledger_row_check", relname: "loans" },
      { tgname: "loans_status_moves_with_seq_update", relname: "loans" },
      { tgname: "loans_terminal_is_final_update", relname: "loans" },
    ]);
  });

  it("defers the ledger check to COMMIT, as the application's is", async () => {
    // The only moment "did this transaction also record why" is answerable.
    // A trigger that lost its deferral would refuse the ordinary case where
    // the ledger row is written after the column.
    const rows = await prisma.$queryRaw<{ tgdeferrable: boolean; tginitdeferred: boolean }[]>`
      SELECT t.tgdeferrable, t.tginitdeferred
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'loans' AND t.tgname = 'loans_status_has_a_ledger_row_check'
    `;
    expect(rows).toEqual([{ tgdeferrable: true, tginitdeferred: true }]);
  });
});
