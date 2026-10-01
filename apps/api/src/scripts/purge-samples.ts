/**
 * Remove the sample borrowers and the sample book from a staging database,
 * keeping every tape a person uploaded through the desk.
 *
 *   tsx src/scripts/purge-samples.ts            plan only: prints what would go, changes nothing
 *   tsx src/scripts/purge-samples.ts --apply    the same, then commits it
 *
 * What `seed-personas` wrote, and nothing else:
 *
 *   - Every persona user (`users.persona_key`), applicant before co-borrower,
 *     the order `resetPersona` uses. The BEFORE DELETE triggers on `users` take
 *     their files, ledgers and the loans only they were party to.
 *   - The twelve-loan Northlight book under the `northlight` servicer: its
 *     loans, their reviews and offers, its observations, its import, the
 *     provisional parties it minted, its billing statements, its credentials,
 *     the servicer and its PARTNER principal.
 *   - The parties and the STAFF principal the persona seed minted, once nothing
 *     names them.
 *
 * What it never takes:
 *
 *   - A persona that stands on a loan which is not a sample-book loan (somebody
 *     claimed a real loan while signed in as one): the trigger would take that
 *     loan with the user, so the persona is kept and reported instead.
 *   - The Northlight book, if `northlight` carries an import that is not the
 *     sample tape (a person loaded a tape under the sample servicer), or an
 *     invoice: the servicer and everything under it are kept and reported.
 *
 * One transaction: a plan is the same work rolled back, so the counts it prints
 * are exactly what --apply deletes, triggers included. Refuses to run without
 * DEMO_PERSONAS=true, the flag that marks the one environment personas exist in.
 */

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { prisma } from "@hm/db";
import { NORTHLIGHT, sampleBook } from "@hm/partner-book";

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export interface PurgeReport {
  readonly applied: boolean;
  readonly deleted: Readonly<Record<string, number>>;
  readonly personas: readonly string[];
  readonly kept: readonly string[];
}

class Rollback extends Error {}

const SEED_STAFF = "staff:persona_seed";

async function tableCounts(tx: Tx): Promise<Map<string, number>> {
  const rows = await tx.$queryRawUnsafe<{ t: string; n: string }[]>(`
    SELECT c.relname AS t,
           (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text AS n
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'`);
  return new Map(rows.map((r) => [r.t, Number(r.n)]));
}

/** A delete that may be refused by a foreign key: tried under a savepoint, and reported kept when refused. */
async function tryDelete(tx: Tx, sql: string, params: unknown[]): Promise<boolean> {
  await tx.$executeRawUnsafe("SAVEPOINT purge_try");
  try {
    await tx.$executeRawUnsafe(sql, ...params);
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT purge_try");
    return true;
  } catch {
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT purge_try");
    return false;
  }
}

export async function purgeSamples({
  apply = false,
  log = console.log,
}: { apply?: boolean; log?: (line: string) => void } = {}): Promise<PurgeReport> {
  if (process.env.DEMO_PERSONAS !== "true") {
    throw new Error(
      "purge-samples refuses to run without DEMO_PERSONAS=true: that flag marks the environment personas are seeded in.",
    );
  }
  // The sample import is the pair of files the seed loads; any other pair under the servicer is a person's.
  const book = sampleBook();
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const sampleTape = sha(book.tape);
  const sampleSupplement = sha(new TextEncoder().encode(book.supplement));
  let report: PurgeReport | undefined;

  try {
    await prisma.$transaction(
      async (tx) => {
        const before = await tableCounts(tx);
        const kept: string[] = [];

        // The book: doomed only when everything under the sample servicer is the sample.
        const servicer = (
          await tx.$queryRawUnsafe<{ id: string }[]>(
            `SELECT id::text FROM servicers WHERE slug = $1`,
            NORTHLIGHT.slug,
          )
        )[0];
        let bookLoans: string[] = [];
        let bookGoes = false;
        if (servicer) {
          const foreign = await tx.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM partner_book_imports
              WHERE servicer_id = $1::uuid AND NOT (tape_sha256 = $2 AND supplement_sha256 = $3)`,
            servicer.id,
            sampleTape,
            sampleSupplement,
          );
          const invoices = await tx.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM billing_invoices WHERE servicer_id = $1::uuid`,
            servicer.id,
          );
          if (foreign[0]!.n > 0) {
            kept.push(
              `servicer ${NORTHLIGHT.slug}: ${foreign[0]!.n} import(s) under it are not the sample files`,
            );
          } else if (invoices[0]!.n > 0) {
            kept.push(
              `servicer ${NORTHLIGHT.slug}: ${invoices[0]!.n} invoice(s) were issued to it`,
            );
          } else {
            bookGoes = true;
            bookLoans = (
              await tx.$queryRawUnsafe<{ id: string }[]>(
                `SELECT id::text FROM loans WHERE servicer_id = $1::uuid`,
                servicer.id,
              )
            ).map((r) => r.id);
          }
        }

        // The personas, applicants first. A persona on any loan the purge does not take is kept.
        const users = await tx.$queryRawUnsafe<
          { id: string; key: string; party_id: string | null }[]
        >(
          `SELECT id::text, persona_key AS key, party_id::text FROM users WHERE persona_key IS NOT NULL
            ORDER BY position(':' in persona_key) > 0, persona_key`,
        );
        const personas: string[] = [];
        for (const u of users) {
          const loans = u.party_id
            ? await tx.$queryRawUnsafe<{ id: string }[]>(
                `SELECT DISTINCT lp.loan_id::text AS id FROM loan_parties lp
                  WHERE lp.party_id = $1::uuid OR lp.party_id IN (SELECT id FROM parties WHERE merged_into_party_id = $1::uuid)`,
                u.party_id,
              )
            : [];
          const foreign = loans.filter((l) => !bookLoans.includes(l.id));
          if (foreign.length > 0) {
            kept.push(
              `persona ${u.key}: stands on ${foreign.length} loan(s) that are not the sample book's`,
            );
            continue;
          }
          await tx.$executeRawUnsafe(`DELETE FROM users WHERE id = $1::uuid`, u.id);
          personas.push(u.key);
        }

        if (servicer && bookGoes) {
          const ids = bookLoans;
          await tx.$executeRawUnsafe(
            `DELETE FROM refi_offers WHERE loan_id = ANY($1::uuid[])`,
            ids,
          );
          await tx.$executeRawUnsafe(
            `DELETE FROM loan_reviews WHERE loan_id = ANY($1::uuid[])`,
            ids,
          );
          await tx.$executeRawUnsafe(
            `DELETE FROM servicing_observations WHERE loan_id = ANY($1::uuid[])
                OR import_id IN (SELECT id FROM partner_book_imports WHERE servicer_id = $2::uuid)`,
            ids,
            servicer.id,
          );
          await tx.$executeRawUnsafe(`DELETE FROM loans WHERE id = ANY($1::uuid[])`, ids);
          await tx.$executeRawUnsafe(
            `DELETE FROM partner_book_imports WHERE servicer_id = $1::uuid`,
            servicer.id,
          );
          await tx.$executeRawUnsafe(
            `DELETE FROM billing_statements WHERE servicer_id = $1::uuid`,
            servicer.id,
          );
          await tx.$executeRawUnsafe(
            `DELETE FROM partner_credentials WHERE servicer_id = $1::uuid`,
            servicer.id,
          );
          await tx.$executeRawUnsafe(`DELETE FROM servicers WHERE id = $1::uuid`, servicer.id);
        }

        // Parties the seeds minted, each only if nothing names it any more.
        const sources = [
          "persona_seed",
          ...(bookGoes ? [`partner_import:${NORTHLIGHT.slug}`] : []),
        ];
        const parties = await tx.$queryRawUnsafe<{ id: string; source: string }[]>(
          `SELECT p.id::text, p.source_first_seen AS source FROM parties p
            WHERE p.source_first_seen = ANY($1::text[])
              AND NOT EXISTS (SELECT 1 FROM users u WHERE u.party_id = p.id)
              AND NOT EXISTS (SELECT 1 FROM loan_parties lp WHERE lp.party_id = p.id)`,
          sources,
        );
        let partiesKept = 0;
        for (const p of parties) {
          if (!(await tryDelete(tx, `DELETE FROM parties WHERE id = $1::uuid`, [p.id])))
            partiesKept += 1;
        }
        if (partiesKept > 0)
          kept.push(`${partiesKept} seeded part(ies): still named by a kept row`);
        // The principals last: the facts they asserted went with the parties above.
        const principals: [string, string][] = [
          ["STAFF", SEED_STAFF],
          ...(bookGoes ? [["PARTNER", NORTHLIGHT.slug] as [string, string]] : []),
        ];
        for (const [kind, subject] of principals) {
          const present = await tx.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM principals WHERE kind::text = $1 AND subject = $2`,
            kind,
            subject,
          );
          if (present[0]!.n === 0) continue;
          if (
            !(await tryDelete(tx, `DELETE FROM principals WHERE kind::text = $1 AND subject = $2`, [
              kind,
              subject,
            ]))
          ) {
            kept.push(`principal ${kind}:${subject}: still named by a kept row`);
          }
        }

        const after = await tableCounts(tx);
        const deleted: Record<string, number> = {};
        for (const [t, n] of before) {
          const gone = n - (after.get(t) ?? 0);
          if (gone !== 0) deleted[t] = gone;
        }
        report = { applied: apply, deleted, personas, kept };
        if (!apply) throw new Rollback();
      },
      { timeout: 15 * 60_000, maxWait: 60_000 },
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const r = report!;
  const total = Object.values(r.deleted).reduce((a, b) => a + b, 0);
  log(
    `purge-samples ${apply ? "apply" : "plan"}: ${total} rows in ${Object.keys(r.deleted).length} tables`,
  );
  for (const [t, n] of Object.entries(r.deleted).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )) {
    log(`  ${t.padEnd(40)} ${n}`);
  }
  log(`personas: ${r.personas.length ? r.personas.join(", ") : "none"}`);
  for (const k of r.kept) log(`kept ${k}`);
  log(
    apply
      ? `purge-samples: deleted ${total} rows`
      : "purge-samples: plan only, nothing changed (pass --apply to delete)",
  );
  return r;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  purgeSamples({ apply: process.argv.includes("--apply") })
    .then(() => prisma.$disconnect())
    .catch(async (err) => {
      console.error(err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
