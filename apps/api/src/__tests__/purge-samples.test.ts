/**
 * The staging purge of the sample borrowers and the sample book: everything
 * `seed-personas` wrote goes, and a tape a person loaded stays exactly as it
 * was — including when they loaded it under the sample servicer itself, where
 * the book and the persona standing on it are kept and said so.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@hm/db";
import { NORTHLIGHT, sampleBook } from "@hm/partner-book";

vi.hoisted(() => {
  process.env.DEMO_PERSONAS = "true";
});

import { seedAll } from "../scripts/seed-personas.js";
import { purgeSamples } from "../scripts/purge-samples.js";
import { importPartnerBook } from "../services/partner-book.js";
import { partnerPrincipal } from "../services/party.js";
import { ingestFixtureApor } from "./support/apor.js";

beforeEach(async () => {
  await ingestFixtureApor();
});

const quiet = { log: () => undefined };

/** A person's upload through the desk's service: the sample book's rows under a servicer of their own. */
async function upload(slug: string, supplement = sampleBook().supplement) {
  const servicer = await prisma.servicer.upsert({
    where: { slug },
    create: { slug, displayName: `${slug} (uploaded)`, integrationDepth: "API" },
    update: {},
    select: { id: true },
  });
  return importPartnerBook({
    servicerId: servicer.id,
    principalId: await partnerPrincipal(prisma, slug),
    profile: "m3-v1",
    tape: { filename: "tape.xlsx", bytes: sampleBook().tape },
    supplement: { filename: "supplement.csv", bytes: new TextEncoder().encode(supplement) },
  });
}

/** Everything that hangs off a servicer's book, as content. */
async function bookOf(slug: string) {
  const servicer = await prisma.servicer.findUnique({ where: { slug }, select: { id: true } });
  if (!servicer) return null;
  const loans = await prisma.loan.findMany({
    where: { servicerId: servicer.id },
    orderBy: { servicerLoanNumber: "asc" },
  });
  const ids = loans.map((l) => l.id);
  return {
    loans,
    parties: await prisma.loanParty.findMany({
      where: { loanId: { in: ids } },
      orderBy: [{ loanId: "asc" }, { partyId: "asc" }],
    }),
    observations: await prisma.servicingObservation.findMany({
      where: { loanId: { in: ids } },
      orderBy: { id: "asc" },
    }),
    imports: await prisma.partnerBookImport.findMany({
      where: { servicerId: servicer.id },
      orderBy: { id: "asc" },
    }),
  };
}

async function tableCounts() {
  const rows = await prisma.$queryRawUnsafe<{ t: string; n: string }[]>(`
    SELECT c.relname AS t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text AS n
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' ORDER BY 1`);
  return Object.fromEntries(rows.map((r) => [r.t, r.n]));
}

describe("purge-samples", () => {
  it("plans without changing anything, then removes every persona and the sample book and leaves an upload as it was", async () => {
    await seedAll();
    await upload("acme-servicing");
    const acme = await bookOf("acme-servicing");
    expect(acme?.loans).toHaveLength(12);

    const before = await tableCounts();
    const plan = await purgeSamples(quiet);
    expect(plan.applied).toBe(false);
    expect(plan.deleted["users"]).toBeGreaterThan(0);
    expect(await tableCounts()).toEqual(before);

    const r = await purgeSamples({ ...quiet, apply: true });
    expect(r.kept).toEqual([]);
    expect(await prisma.user.count({ where: { personaKey: { not: null } } })).toBe(0);
    expect(await prisma.servicer.findUnique({ where: { slug: NORTHLIGHT.slug } })).toBeNull();
    expect(
      await prisma.principal.count({
        where: { subject: { in: [NORTHLIGHT.slug, "staff:persona_seed"] } },
      }),
    ).toBe(0);
    expect(
      await prisma.party.count({
        where: { sourceFirstSeen: { in: ["persona_seed", `partner_import:${NORTHLIGHT.slug}`] } },
      }),
    ).toBe(0);
    expect(await prisma.loanFile.count({ where: { isDemo: true } })).toBe(0);
    expect(await bookOf("acme-servicing")).toEqual(acme);

    const again = await purgeSamples({ ...quiet, apply: true });
    expect(again.deleted).toEqual({});
  });

  it("keeps the sample servicer, and the persona on its book, when a person loaded a tape under it", async () => {
    await seedAll();
    const theirs = await upload(
      NORTHLIGHT.slug,
      sampleBook().supplement.replace(/NL-1000/g, "NL-2000"),
    );
    expect(theirs.status).toBe("loaded");
    const book = await bookOf(NORTHLIGHT.slug);

    const r = await purgeSamples({ ...quiet, apply: true });
    expect(r.kept).toEqual([
      `servicer ${NORTHLIGHT.slug}: 1 import(s) under it are not the sample files`,
      "persona grander_import: stands on 1 loan(s) that are not the sample book's",
    ]);
    expect(r.personas).not.toContain("grander_import");
    expect(await prisma.user.count({ where: { personaKey: { not: null } } })).toBe(1);
    expect(await bookOf(NORTHLIGHT.slug)).toEqual(book);
  });

  it("refuses without DEMO_PERSONAS", async () => {
    process.env.DEMO_PERSONAS = "false";
    try {
      await expect(purgeSamples(quiet)).rejects.toThrow(/DEMO_PERSONAS=true/);
    } finally {
      process.env.DEMO_PERSONAS = "true";
    }
  });
});
