/**
 * A sample borrower can be looked at, and nothing else.
 *
 * Two refusals, and both are needed. The file rule already makes every demo
 * file read-only, but it can only see a file: a persona POSTing `/api/files`
 * would get a brand-new file that is NOT a demo file, own it, and be able to
 * edit it — which is the whole read-only promise gone, through a route that
 * never touched a file id. So the session is refused too, and the test that
 * matters most here is the one that walks that exact sequence through the
 * middleware and the router mounted in the order `index.ts` mounts them.
 *
 * The other half is the door. Signing in as a persona mints a real session for
 * a real row, so it must be impossible where the flag is off (404, the same
 * answer a path that does not exist gets) and honest where the seed has not
 * run (503, rather than conjuring an empty file that looks like a failed seed).
 *
 * Against the real Postgres: `personaKey` is a column with a UNIQUE index and
 * a shape CHECK, and the refusals are read off the row.
 */

import { readFileSync } from "node:fs";
import { Router } from "express";
import { describe, expect, it, vi } from "vitest";
import { prisma } from "@hm/db";

// The persona router is mounted at import time, under the flag. Hoisted so
// `config` sees it — the same reason `standing.test.ts` pins its bank provider.
vi.hoisted(() => {
  process.env.DEMO_PERSONAS = "true";
});

import { config } from "../config.js";
import { personaReadOnly } from "../middleware/persona-read-only.js";
import { authRouter } from "../routes/auth.js";
import { fileRouter } from "../routes/files.js";
import { signInAsPersona } from "../services/auth.js";
import { createDraftApplication } from "../services/applications.js";
import { principalForParty } from "../services/party.js";
import { transition } from "../services/transition.js";
import { isSeeded, NOT_SEEDED_HERE, PERSONA_STORIES } from "../personas/stories.js";
import { createLoanFile, createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

/** Screen 1's body — a file a persona must not be able to start. */
const SCREEN_ONE = {
  purpose: "purchase",
  address: { line1: "88 Foster Lane", city: "Austin", state: "tx", postalCode: "78745" },
  propertyType: "single_family",
  occupancy: "primary_residence",
  valueOrPrice: 415_000,
  loanAmount: 332_000,
  downPayment: 83_000,
  statedMonthlyIncome: 9_400,
};

/**
 * The gate as `index.ts` mounts it: after authentication, before every router.
 *
 * A copy, which is why the wiring itself is asserted separately below.
 * `headers.test.ts` records what happens otherwise: it re-declared the helmet
 * config rather than importing it, so it asserted against its own copy and
 * would have kept passing while the server served something else entirely.
 * Here the copy is unavoidable — mounting the real `index.ts` would start a
 * listener — so the mount is read out of the source instead.
 */
const gate = Router();
gate.use(personaReadOnly);

/** The server's own wiring, read rather than re-declared. */
const INDEX = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

/** The flag, flipped for one assertion. It is read at call time, not at import. */
async function withPersonas<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  const mutable = config as { demoPersonasEnabled: boolean };
  const was = mutable.demoPersonasEnabled;
  mutable.demoPersonasEnabled = on;
  try {
    return await fn();
  } finally {
    mutable.demoPersonasEnabled = was;
  }
}

/** What the middleware did, without a router behind it. */
function through(user: { personaKey: string | null }, method: string): string {
  let passed = false;
  let status = 0;
  let body: { error?: { code?: string } } = {};
  personaReadOnly(
    { user, method } as never,
    {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: { error?: { code?: string } }) {
        body = payload;
      },
    } as never,
    () => {
      passed = true;
    },
  );
  return passed ? "passed" : `${status} ${body.error?.code}`;
}

describe("where the read-only gate is mounted", () => {
  const gateAt = INDEX.indexOf('app.use("/api", personaReadOnly);');
  const authAt = INDEX.indexOf('app.use("/api", requireAuth);');

  it("is mounted at all", () => {
    // Everything below this file's behavioral cases runs through a local
    // router. Delete the line in `index.ts` and every one of them stays
    // green while a sample borrower may write anything — so the line is what
    // is asserted, not a copy of it.
    expect(gateAt).toBeGreaterThan(-1);
  });

  it("is mounted after the question of who is asking", () => {
    // The gate reads `req.user.personaKey`, which `requireAuth` is what puts
    // there: mounted first, it would see no user and pass everything.
    expect(authAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(authAt);
  });

  it("is mounted before every router that can be written to", () => {
    // The two open ones are open on purpose — health for the probes, auth so
    // that signing in and out stays possible. Anything else mounted above the
    // gate would be a route a sample borrower could post to.
    const above = [...INDEX.slice(0, gateAt).matchAll(/app\.use\("(\/api\/[^"]*)"/g)].map(
      (m) => m[1],
    );
    expect(above).toEqual(["/api/health", "/api/auth"]);
  });
});

describe("the read-only gate on a sample borrower's session", () => {
  const persona = { personaKey: "maya_okafor" };
  const person = { personaKey: null };

  it("refuses everything that changes something", () => {
    expect(through(persona, "POST")).toBe("403 PERSONA_READ_ONLY");
    expect(through(persona, "PATCH")).toBe("403 PERSONA_READ_ONLY");
    expect(through(persona, "PUT")).toBe("403 PERSONA_READ_ONLY");
    expect(through(persona, "DELETE")).toBe("403 PERSONA_READ_ONLY");
  });

  it("lets a sample borrower read", () => {
    expect(through(persona, "GET")).toBe("passed");
    expect(through(persona, "HEAD")).toBe("passed");
    expect(through(persona, "OPTIONS")).toBe("passed");
  });

  it("is invisible to a real person", () => {
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      expect(through(person, method)).toBe("passed");
    }
  });

  it("stops a sample borrower starting a file of its own", async () => {
    // The one the file rule cannot see: a new file would not be a demo file,
    // and its creator would own it.
    const maya = await createUser({ personaKey: "maya_okafor" });
    const res = await callAs(maya.id, [gate, fileRouter], "POST", "/", SCREEN_ONE);
    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("PERSONA_READ_ONLY");
    expect(await prisma.loanFile.count()).toBe(0);
  });

  it("still lets a sample borrower read a file", async () => {
    const maya = await createUser({ personaKey: "maya_okafor" });
    const file = await createLoanFile({ userId: maya.id, isDemo: true });
    const res = await callAs(maya.id, [gate, fileRouter], "GET", `/${file.id}`);
    expect(res.status).toBe(200);
  });
});

describe("signing in as a sample borrower", () => {
  it("does not exist when the flag is off", async () => {
    await createUser({ personaKey: "maya_okafor" });
    // 404, not 403: the routes are not mounted either, and a refusal that
    // admitted the endpoint exists would make the flag visible to anyone.
    await withPersonas(false, async () => {
      await expect(signInAsPersona("maya_okafor")).rejects.toMatchObject({
        statusCode: 404,
        code: "NOT_FOUND",
      });
    });
  });

  it("says so when the deployment has not been seeded", async () => {
    await expect(signInAsPersona("maya_okafor")).rejects.toMatchObject({
      statusCode: 503,
      code: "PERSONAS_NOT_SEEDED",
    });
  });

  it("never creates the persona it was asked for", async () => {
    await expect(signInAsPersona("maya_okafor")).rejects.toThrow();
    expect(await prisma.user.count()).toBe(0);
  });

  it("returns the seeded row", async () => {
    const maya = await createUser({ personaKey: "maya_okafor", name: "Maya Okafor" });
    const user = await signInAsPersona("maya_okafor");
    expect(user.id).toBe(maya.id);
    expect(user.personaKey).toBe("maya_okafor");
  });

  it("tells the browser the session is a sample borrower", async () => {
    /*
     * The one field the whole read-only story rests on in the SPA: the banner
     * that says you are looking rather than doing, the hidden start button and
     * the review screen's disabled signature all read `user.persona` and
     * nothing else. If it stopped arriving, every one of them would quietly
     * treat a persona as a real person, so the session response is asserted
     * here rather than inferred from the row.
     */
    await createUser({ personaKey: "maya_okafor", name: "Maya Okafor" });
    const res = await callAs(
      (await createUser()).id,
      [authRouter],
      "POST",
      "/personas/maya_okafor",
      {},
      "/api/auth",
    );
    expect(res.status).toBe(201);
    expect((res.body as { user: { persona: unknown } }).user.persona).toEqual({
      key: "maya_okafor",
      name: "Maya Okafor",
    });
  });

  it("says a real person is not one", async () => {
    const me = await createUser();
    const res = await callAs(me.id, [authRouter], "GET", "/me", undefined, "/api/auth");
    expect(res.status).toBe(200);
    expect((res.body as { user: { persona: unknown } }).user.persona).toBeNull();
  });
});

/** The listing, as the sign-in page reads it. */
async function personaRows(asUserId: string) {
  const res = await callAs(asUserId, [authRouter], "GET", "/personas", undefined, "/api/auth");
  expect(res.status).toBe(200);
  return (
    res.body as {
      personas: {
        key: string;
        state: string | null;
        available: boolean;
        unavailableBecause: string | null;
        seededAt: string | null;
      }[];
    }
  ).personas;
}

/** Every persona this build knows how to walk, given the row behind it. */
async function seedEveryPersona(): Promise<void> {
  for (const story of PERSONA_STORIES) {
    if (!isSeeded(story)) continue;
    await createUser({ personaKey: story.key, name: `${story.name.first} ${story.name.last}` });
  }
}

describe("the sign-in page's list of sample borrowers", () => {
  it("names every story, and marks the one that cannot be offered", async () => {
    await seedEveryPersona();
    const rows = await personaRows((await createUser()).id);
    expect(rows).toHaveLength(PERSONA_STORIES.length);

    // With every row the seed can walk actually written, the only one left
    // unavailable is the one this build cannot produce a person in at all.
    const deferred = rows.filter((r) => !r.available);
    expect(deferred.map((r) => r.key)).toEqual(["grander_import"]);
    expect(deferred[0]?.unavailableBecause).toContain("already exists");
  });

  it("does not offer a row nothing has been seeded for", async () => {
    /*
     * The flag is about this database, not about the list. Computed from the
     * list alone it is true for all nine rows on a deployment whose seed has
     * not run, and every one of them is a button whose click fails.
     */
    const rows = await personaRows((await createUser()).id);
    expect(rows.every((r) => !r.available)).toBe(true);
    expect(rows.find((r) => r.key === "maya_okafor")?.unavailableBecause).toBe(NOT_SEEDED_HERE);

    await createUser({ personaKey: "maya_okafor", name: "Maya Okafor" });
    const after = await personaRows((await createUser()).id);
    const maya = after.find((r) => r.key === "maya_okafor");
    expect(maya?.available).toBe(true);
    expect(maya?.unavailableBecause).toBeNull();
  });

  it("says nothing has been seeded when nothing has", async () => {
    const rows = await personaRows((await createUser()).id);
    expect(rows.every((r) => r.state === null && r.seededAt === null)).toBe(true);
  });

  it("shows a seeded persona with no application yet as having no state", async () => {
    // Nothing has walked her anywhere, so there is no application and no pill.
    // A listing that fell back to `target` would put a pill here on a persona
    // the seed never finished.
    const maya = await createUser({ personaKey: "maya_okafor", name: "Maya Okafor" });
    await createLoanFile({ userId: maya.id, isDemo: true });
    const row = (await personaRows(maya.id)).find((r) => r.key === "maya_okafor");
    expect(row?.seededAt).not.toBeNull();
    expect(row?.state).toBeNull();
  });

  it("reports a persona's live state, not the one its story wants", async () => {
    /*
     * The whole point of the field. A seeded persona drifts — somebody walks
     * her on, or a later seed lands her somewhere else — and this page is
     * where a tester would notice. A listing that reported `target` would be
     * the one place the drift was invisible, and it would read as correct.
     */
    const maya = await createUser({ personaKey: "maya_okafor", name: "Maya Okafor" });
    const file = await createLoanFile({ userId: maya.id, isDemo: true });
    const party = await prisma.party.create({ data: {}, select: { id: true } });
    await prisma.user.update({ where: { id: maya.id }, data: { partyId: party.id } });
    const { applicationId } = await createDraftApplication(prisma, {
      loanFileId: file.id,
      partyId: party.id,
      terms: {
        objective: "PURCHASE",
        occupancy: "PRIMARY_RESIDENCE",
        loanAmountCents: 332_000_00n,
        termMonths: 360,
      },
    });
    // Moved by the service the product moves it with, so the state on the row
    // is one the machine actually reached.
    await transition({
      applicationId,
      event: "intake_completed",
      actorPrincipalId: await principalForParty(prisma, party.id),
    });

    const story = PERSONA_STORIES.find((s) => s.key === "maya_okafor");
    const row = (await personaRows(maya.id)).find((r) => r.key === "maya_okafor");
    expect(row?.state).toBe("intake_received");
    // And it is somewhere her story does not claim, which is what makes the
    // assertion above about the database rather than about the list.
    expect(story && isSeeded(story) ? story.target : null).not.toBe("intake_received");
  });
});

describe("deleting a sample borrower's account", () => {
  it("is refused, and the persona survives it", async () => {
    const maya = await createUser({ personaKey: "maya_okafor", name: "Maya Okafor" });
    const res = await callAs(maya.id, [authRouter], "DELETE", "/me", undefined, "/api/auth");
    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("PERSONA_READ_ONLY");
    expect(await prisma.user.count({ where: { id: maya.id } })).toBe(1);
  });

  it("still deletes a real person's account", async () => {
    // The refusal is about the persona and nothing else — without this, a
    // check on the wrong side of the condition would pass every test above.
    const me = await createUser();
    const res = await callAs(me.id, [authRouter], "DELETE", "/me", undefined, "/api/auth");
    expect(res.status).not.toBe(403);
    expect(await prisma.user.count({ where: { id: me.id } })).toBe(0);
  });
});
