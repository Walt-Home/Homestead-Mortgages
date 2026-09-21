/**
 * Read a partner's tape into the book by hand, or load the sample one.
 *
 *   npm run partner:book --workspace=@hm/api -- import <servicer-slug> <tape.xlsx|.csv> [supplement.csv] [--as-of YYYY-MM-DD] [--profile m3-v1]
 *   npm run partner:book --workspace=@hm/api -- sample <servicer-slug> [--name "<display name>"]
 *
 * Both go through the same service the partner's own key reaches over
 * `POST /api/partner/book/imports`, as the servicer's PARTNER principal, so
 * a loan loaded from a laptop and one loaded from the partner's system are
 * indistinguishable in the ledger. `sample` loads the twelve-loan Northlight
 * book, creating the servicer when `--name` is given — the development
 * counterpart of the persona seed, for a database that needs a monitored
 * book to look at.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { prisma } from "@hm/db";
import { NORTHLIGHT, sampleBook } from "@hm/partner-book";
import { importPartnerBook, type ImportBookResult } from "../services/partner-book.js";
import { partnerPrincipal } from "../services/party.js";

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(): void {
  console.error(
    [
      "usage:",
      "  partner:book import <servicer-slug> <tape.xlsx|.csv> [supplement.csv] [--as-of YYYY-MM-DD] [--profile m3-v1]",
      '  partner:book sample <servicer-slug> [--name "<display name>"]',
    ].join("\n"),
  );
  process.exitCode = 2;
}

async function servicerFor(slug: string, name: string | undefined): Promise<{ id: string } | null> {
  const found = await prisma.servicer.findUnique({ where: { slug }, select: { id: true } });
  if (found) return found;
  if (!name) {
    console.error(`no servicer "${slug}" yet; pass --name "<display name>" to create one`);
    process.exitCode = 2;
    return null;
  }
  const made = await prisma.servicer.create({
    data: { slug, displayName: name },
    select: { id: true },
  });
  console.error(`created servicer ${slug} ("${name}")`);
  return made;
}

function print(result: ImportBookResult): void {
  console.log(
    JSON.stringify(result, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2),
  );
  if (result.status === "rejected") process.exitCode = 1;
}

async function importTape(slug: string, rest: readonly string[]): Promise<void> {
  const positional = rest.filter(
    (a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1]!.startsWith("--")),
  );
  const [tapePath, supplementPath] = positional;
  if (!SLUG.test(slug) || !tapePath) return usage();
  const servicer = await servicerFor(slug, flag(rest, "name"));
  if (!servicer) return;
  const principalId = await partnerPrincipal(prisma, slug);
  print(
    await importPartnerBook({
      servicerId: servicer.id,
      principalId,
      profile: flag(rest, "profile") ?? "m3-v1",
      asOf: flag(rest, "as-of") ?? null,
      tape: { filename: basename(tapePath), bytes: new Uint8Array(readFileSync(tapePath)) },
      supplement: supplementPath
        ? {
            filename: basename(supplementPath),
            bytes: new Uint8Array(readFileSync(supplementPath)),
          }
        : null,
    }),
  );
}

async function sample(slug: string, rest: readonly string[]): Promise<void> {
  if (!SLUG.test(slug)) return usage();
  const servicer = await servicerFor(
    slug,
    flag(rest, "name") ?? (slug === NORTHLIGHT.slug ? NORTHLIGHT.legal_name : undefined),
  );
  if (!servicer) return;
  const principalId = await partnerPrincipal(prisma, slug);
  const book = sampleBook();
  print(
    await importPartnerBook({
      servicerId: servicer.id,
      principalId,
      profile: "m3-v1",
      tape: { filename: "northlight.xlsx", bytes: book.tape },
      supplement: { filename: "supplement.csv", bytes: new TextEncoder().encode(book.supplement) },
    }),
  );
}

async function main(): Promise<void> {
  const [command, subject, ...rest] = process.argv.slice(2);
  if (!subject) return usage();
  switch (command) {
    case "import":
      return importTape(subject, rest);
    case "sample":
      return sample(subject, rest);
    default:
      return usage();
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
