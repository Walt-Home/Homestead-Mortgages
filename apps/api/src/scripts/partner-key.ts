/**
 * Issue, list or revoke a partner's key.
 *
 *   npm run partner:key --workspace=@hm/api -- issue <servicer-slug> --label "<what it is for>" [--name "<display name>"]
 *   npm run partner:key --workspace=@hm/api -- list <servicer-slug>
 *   npm run partner:key --workspace=@hm/api -- revoke <credential-id>
 *
 * `issue` prints the key exactly once, on stdout and nothing else there, so
 * `KEY=$(npm run -s partner:key -w @hm/api -- issue grander --label …)` is the
 * whole hand-off. It is not stored: `partner_credentials` holds the SHA-256,
 * and a lost key is a revoke and a new issue. The servicer row is created on
 * first issue when `--name` is given, because a key belongs to a servicer and
 * a servicer is a row — see `docs/decisions.md`, "A partner is a key, not a
 * sign-in".
 */

import { prisma } from "@hm/db";
import {
  issuePartnerCredential,
  revokePartnerCredential,
} from "../services/partner-credentials.js";

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(): void {
  console.error(
    [
      "usage:",
      '  partner:key issue <servicer-slug> --label "<what it is for>" [--name "<display name>"]',
      "  partner:key list <servicer-slug>",
      "  partner:key revoke <credential-id>",
    ].join("\n"),
  );
  process.exitCode = 2;
}

async function issue(slug: string, rest: readonly string[]): Promise<void> {
  const label = flag(rest, "label");
  if (!SLUG.test(slug) || !label) return usage();
  let servicer = await prisma.servicer.findUnique({ where: { slug }, select: { id: true } });
  if (!servicer) {
    const name = flag(rest, "name");
    if (!name) {
      console.error(`no servicer "${slug}" yet; pass --name "<display name>" to create one`);
      process.exitCode = 2;
      return;
    }
    servicer = await prisma.servicer.create({
      data: { slug, displayName: name },
      select: { id: true },
    });
    console.error(`created servicer ${slug} ("${name}")`);
  }
  const { id, key } = await issuePartnerCredential(prisma, { servicerId: servicer.id, label });
  console.error(
    `issued credential ${id} for ${slug} ("${label}"). The key follows once and is not stored:`,
  );
  console.log(key);
}

async function list(slug: string): Promise<void> {
  if (!SLUG.test(slug)) return usage();
  const rows = await prisma.partnerCredential.findMany({
    where: { servicer: { slug } },
    orderBy: { createdAt: "asc" },
    select: { id: true, label: true, createdAt: true, lastUsedAt: true, revokedAt: true },
  });
  console.log(JSON.stringify(rows, null, 2));
}

async function revoke(credentialId: string): Promise<void> {
  const row = await prisma.partnerCredential.findUnique({
    where: { id: credentialId },
    select: { revokedAt: true, servicer: { select: { slug: true } } },
  });
  if (!row) {
    console.error(`no credential ${credentialId}`);
    process.exitCode = 1;
    return;
  }
  await revokePartnerCredential(prisma, credentialId);
  console.error(
    row.revokedAt
      ? `credential ${credentialId} (${row.servicer.slug}) was already revoked`
      : `revoked credential ${credentialId} (${row.servicer.slug})`,
  );
}

async function main(): Promise<void> {
  const [command, subject, ...rest] = process.argv.slice(2);
  if (!subject) return usage();
  switch (command) {
    case "issue":
      return issue(subject, rest);
    case "list":
      return list(subject);
    case "revoke":
      return revoke(subject);
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
