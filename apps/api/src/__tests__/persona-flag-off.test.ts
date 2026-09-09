/**
 * With the flag off, the sample borrowers do not exist.
 *
 * Its own file because the mounting happens once, when the router module is
 * imported: `authRouter.use(personaRouter)` runs under `config.demoPersonasEnabled`
 * and nothing later can undo it. So the only way to test the off case is to
 * import the router in a process where the flag was never set, which is what
 * this file is.
 *
 * The answer has to be 404 and not 403. A refusal that admitted the endpoint
 * exists would tell anyone who tried it which deployments have a session
 * minter that needs no Google credential — and that is the one fact about this
 * feature worth keeping quiet.
 */

import { Router } from "express";
import { describe, expect, it, vi } from "vitest";

// Set to "false" rather than deleted. `config.ts` loads `.env` itself, and
// dotenv fills in every variable that is ABSENT while never overwriting one
// that is already set — so deleting this hands it straight back on any machine
// whose `.env` turns the picker on to look at it, and the whole file then
// fails as though the feature were broken. A value dotenv will not overwrite
// is the only way to say "off" here. Hoisted because another suite in the same
// worker may have set it, and "the default" is not something to leave to run
// order.
vi.hoisted(() => {
  process.env.DEMO_PERSONAS = "false";
});

import { authRouter } from "../routes/auth.js";
import { createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

/** What `index.ts` answers an unmatched `/api` path with. */
const notFound = Router();
notFound.use((_req, res) => {
  res.status(404).json({ error: { message: "No such endpoint.", code: "NOT_FOUND" } });
});

describe("the persona routes on a deployment without the flag", () => {
  it("says off in a way the .env load cannot undo", () => {
    // The rest of this file is only about the flag if the flag is really off.
    // `config.ts` calls dotenv itself, and dotenv fills in whatever is absent
    // — so an unset variable is not "off", it is "whatever this machine's
    // .env says", and on a machine that turned the picker on to look at it
    // every assertion below would fail for a reason that is not the code's.
    expect(process.env.DEMO_PERSONAS).toBe("false");
  });

  it("answers the listing exactly as it answers a typo", async () => {
    const me = await createUser();
    const listing = await callAs(
      me.id,
      [authRouter, notFound],
      "GET",
      "/personas",
      undefined,
      "/api/auth",
    );
    const typo = await callAs(
      me.id,
      [authRouter, notFound],
      "GET",
      "/no-such-thing",
      undefined,
      "/api/auth",
    );
    expect(listing.status).toBe(404);
    expect(listing.body).toEqual(typo.body);
  });

  it("will not mint a session for one", async () => {
    const maya = await createUser({ personaKey: "maya_okafor" });
    const res = await callAs(
      maya.id,
      [authRouter, notFound],
      "POST",
      "/personas/maya_okafor",
      {},
      "/api/auth",
    );
    expect(res.status).toBe(404);
  });

  it("still says whether the flag is on", async () => {
    const me = await createUser();
    const res = await callAs(me.id, [authRouter], "GET", "/config", undefined, "/api/auth");
    expect((res.body as { demoPersonasEnabled: boolean }).demoPersonasEnabled).toBe(false);
  });
});
