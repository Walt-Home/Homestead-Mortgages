/**
 * What Postgres refuses to record about a permission.
 *
 * `consents.revoked_at` in the old model is read in seven places and written by
 * nothing, so none of these questions had ever been asked. They are all
 * database-level, and none of them can be enforced from application code that a
 * later refactor might route around.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";

const DAY = 24 * 60 * 60 * 1000;
const GRANTED = new Date("2026-09-01T00:00:00Z");
const EXPIRES = new Date(GRANTED.getTime() + 120 * DAY);

async function party() {
  return prisma.party.create({ data: { kind: "PERSON" }, select: { id: true } });
}

let n = 0;
async function staff() {
  return prisma.principal.create({
    data: { kind: "STAFF", subject: `ops-${(n += 1)}` },
    select: { id: true },
  });
}

async function authorize(partyId: string, over: Record<string, unknown> = {}) {
  return prisma.authorization.create({
    data: {
      partyId,
      purpose: "FCRA_WRITTEN_INSTRUCTION",
      dataCategories: ["CREDIT_REPORT", "BANK_TRANSACTIONS"],
      grantedAt: GRANTED,
      expiresAt: EXPIRES,
      ...over,
    },
    select: { id: true, revokedAt: true },
  });
}

describe("one live grant per party and purpose", () => {
  it("refuses a second live grant for the same purpose", async () => {
    // Two live grants makes "which disclosure did they agree to" ambiguous, and
    // revoking one would leave the other standing — so a borrower who withdrew
    // permission would still be pullable.
    const p = await party();
    await authorize(p.id);
    await expect(authorize(p.id)).rejects.toThrow();
  });

  it("allows a different purpose for the same party", async () => {
    const p = await party();
    await authorize(p.id);
    const second = await authorize(p.id, {
      purpose: "IRS_4506C",
      dataCategories: ["TAX_TRANSCRIPT"],
    });
    expect(second.id).toBeDefined();
  });

  it("allows a fresh grant once the old one is revoked", async () => {
    // Renewal is revoke-then-grant, which is what keeps the reason a grant
    // ended on the record.
    const p = await party();
    const who = await staff();
    const first = await authorize(p.id);
    await prisma.authorization.update({
      where: { id: first.id },
      data: {
        revokedAt: new Date(),
        revokedByPrincipalId: who.id,
        revocationReason: "renewed",
      },
    });
    const second = await authorize(p.id);
    expect(second.id).not.toBe(first.id);
  });
});

describe("no perpetual grants", () => {
  it("refuses an expiry before the grant", async () => {
    const p = await party();
    await expect(
      authorize(p.id, { expiresAt: new Date(GRANTED.getTime() - DAY) }),
    ).rejects.toThrow();
  });

  it("refuses a grant that permits nothing", async () => {
    const p = await party();
    await expect(authorize(p.id, { dataCategories: [] })).rejects.toThrow();
  });
});

describe("a revocation accounts for itself", () => {
  it("refuses a bare timestamp with no actor or reason", async () => {
    const p = await party();
    const a = await authorize(p.id);
    await expect(
      prisma.authorization.update({ where: { id: a.id }, data: { revokedAt: new Date() } }),
    ).rejects.toThrow();
  });

  it("accepts a revocation that names who and why", async () => {
    const p = await party();
    const who = await staff();
    const a = await authorize(p.id);
    const revoked = await prisma.authorization.update({
      where: { id: a.id },
      data: {
        revokedAt: new Date(),
        revokedByPrincipalId: who.id,
        revocationReason: "borrower withdrew at the review screen",
      },
      select: { revokedAt: true, revocationReason: true },
    });
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.revocationReason).toContain("withdrew");
  });

  it("is one-way — un-revoking would rewrite the borrower's own decision", async () => {
    const p = await party();
    const who = await staff();
    const a = await authorize(p.id);
    await prisma.authorization.update({
      where: { id: a.id },
      data: {
        revokedAt: new Date(),
        revokedByPrincipalId: who.id,
        revocationReason: "changed mind",
      },
    });
    await expect(
      prisma.authorization.update({ where: { id: a.id }, data: { revokedAt: null } }),
    ).rejects.toThrow(/already revoked/);
  });
});

describe("a grant is immutable apart from revocation", () => {
  it("refuses a widening of the data categories", async () => {
    // Otherwise the cheapest way to authorize a tax transcript is to edit the
    // bank authorization the borrower already signed.
    const p = await party();
    const a = await authorize(p.id);
    await expect(
      prisma.authorization.update({
        where: { id: a.id },
        data: { dataCategories: ["CREDIT_REPORT", "BANK_TRANSACTIONS", "TAX_TRANSCRIPT"] },
      }),
    ).rejects.toThrow(/immutable/);
  });

  it("refuses an extension of the expiry", async () => {
    const p = await party();
    const a = await authorize(p.id);
    await expect(
      prisma.authorization.update({
        where: { id: a.id },
        data: { expiresAt: new Date(EXPIRES.getTime() + 365 * DAY) },
      }),
    ).rejects.toThrow(/immutable/);
  });

  it("refuses moving it to another party", async () => {
    const p = await party();
    const other = await party();
    const a = await authorize(p.id);
    await expect(
      prisma.authorization.update({ where: { id: a.id }, data: { partyId: other.id } }),
    ).rejects.toThrow(/immutable/);
  });
});

describe("deleting a party takes its permissions with it", () => {
  it("cascades", async () => {
    const p = await party();
    await authorize(p.id);
    await prisma.party.delete({ where: { id: p.id } });
    expect(await prisma.authorization.count({ where: { partyId: p.id } })).toBe(0);
  });
});
