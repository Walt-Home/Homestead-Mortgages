/**
 * The ten names the server sends, against the map that has to know all ten.
 *
 * The web app used to declare its own uppercase `FlowStage`, and nothing could
 * see it, because a stage crosses the wire as a string. The two file routes
 * did not agree on a spelling: `GET /files` sent the Prisma enum, which is
 * what this map was keyed on, so the file list's own lookups hit and its
 * `?? "review"` fallback was never once exercised. The readers fed from
 * `GET /files/:id` had neither a cast nor a fallback, and both came back
 * empty — `/f/:id` navigated to `/f/:id/undefined`, and `reachedIndex`
 * returned −1 for every stage a file could actually carry, which is what made
 * the stepper's four dots unlinkable on every screen.
 *
 * So the assertion is over `FLOW_STAGES` — the runtime list the wire type is
 * derived from — rather than over the map's own keys. A map keyed on the list
 * route's spelling is exactly what passed before, and only the shared list
 * binds both routes to the same ten names.
 */

import { describe, expect, it } from "vitest";
import { FLOW_STAGES } from "@hm/shared";
import { SCREENS, STAGE_TO_SCREEN, reachedIndex } from "../flow.js";

const PATHS: readonly string[] = SCREENS.map((s) => s.path);

describe("every stage the server can send", () => {
  it("resumes to one of the four screens", () => {
    for (const stage of FLOW_STAGES) {
      expect(PATHS, stage).toContain(STAGE_TO_SCREEN[stage]);
    }
  });

  it("answers how far the borrower has got, rather than nowhere", () => {
    // −1 is what this returned for all ten, and −1 is not a step index: it is
    // the answer `findIndex` gives when the stage was never in the map.
    for (const stage of FLOW_STAGES) {
      expect(reachedIndex(stage), stage).toBeGreaterThanOrEqual(0);
    }
  });

  it("has an entry for each of them and no others", () => {
    // Keyed on the shared list in both directions, so a name can be added to
    // the domain and left out here, or left here after the domain drops it,
    // and this fails rather than the borrower finding out.
    expect(Object.keys(STAGE_TO_SCREEN).sort()).toEqual([...FLOW_STAGES].sort());
  });
});

describe("a file nobody has started", () => {
  it("is at the first step, not before it", () => {
    expect(reachedIndex(undefined)).toBe(0);
  });
});
