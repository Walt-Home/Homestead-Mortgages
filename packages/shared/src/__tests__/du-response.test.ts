/**
 * A recommendation we cannot read is refused, not stored.
 *
 * The house rule everywhere else in this repository is to refuse rather than
 * default — the requirements generator throws on an unrecognized sheet value,
 * the machine throws on an edge it does not have — and this is that rule at the
 * one boundary where the unknown value arrives from outside and is about a
 * person's loan. `AutomatedUnderwritingRecommendationDescription` is free text
 * in the schema chain, so nothing upstream of this function constrains what can
 * turn up in it.
 *
 * The second block is the more important one. Our own engine's vocabulary and
 * DU's look alike on purpose, and three members even read the same out loud;
 * they do not mean the same thing, and this is where the two sets are held
 * apart.
 */

import { describe, expect, it } from "vitest";
import { AUS_RECOMMENDATIONS } from "../types/decision.js";
import {
  DU_RECOMMENDATIONS,
  DU_RESPONSE_STATUSES,
  UnknownDuRecommendationError,
  UnknownDuResponseStatusError,
  parseDuRecommendation,
  parseDuResponseStatus,
} from "../du-response.js";

describe("reading what DU answered", () => {
  it("reads every recommendation it knows", () => {
    for (const recommendation of DU_RECOMMENDATIONS) {
      expect(parseDuRecommendation(recommendation)).toBe(recommendation);
    }
  });

  it("trims a padded field and nothing else", () => {
    // A transport that pads has not said a different thing. A transport that
    // changes a word has.
    expect(parseDuRecommendation("  Approve/Eligible \n")).toBe("Approve/Eligible");
    expect(() => parseDuRecommendation("approve/eligible")).toThrow(UnknownDuRecommendationError);
    expect(() => parseDuRecommendation("Approve / Eligible")).toThrow(UnknownDuRecommendationError);
  });

  it("refuses a value nobody here has decided what to do about", () => {
    // Including the plausible ones. "Approve" alone loses the eligibility half,
    // and a reader who saw it stored would have to guess which half was meant.
    for (const unknown of ["", "Approve", "Eligible", "Unable to Determine", "EA-I"]) {
      expect(() => parseDuRecommendation(unknown)).toThrow(UnknownDuRecommendationError);
    }
  });

  it("says what it was given, so the next person can look it up", () => {
    try {
      parseDuRecommendation("Refer With Caution");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownDuRecommendationError);
      expect((err as UnknownDuRecommendationError).value).toBe("Refer With Caution");
    }
  });
});

describe("reading which shape a response is", () => {
  it("reads both statuses it knows", () => {
    for (const status of DU_RESPONSE_STATUSES) {
      expect(parseDuResponseStatus(status)).toBe(status);
    }
  });

  it("refuses a third word rather than picking one of the two", () => {
    // This is the field anything acts on: it alone decides whether the
    // recommendation beside it is kept or thrown away. A plausible-looking
    // status quietly read as "errored" records "DU could not evaluate this
    // casefile" about a casefile DU evaluated and approved.
    for (const unknown of ["", "completed", "ANSWERED", "success", "failed", "pending"]) {
      expect(() => parseDuResponseStatus(unknown)).toThrow(UnknownDuResponseStatusError);
    }
  });

  it("trims a padded field and nothing else", () => {
    expect(parseDuResponseStatus("  answered \n")).toBe("answered");
  });

  it("says what it was given, so the next person can look it up", () => {
    try {
      parseDuResponseStatus("completed");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownDuResponseStatusError);
      expect((err as UnknownDuResponseStatusError).value).toBe("completed");
    }
  });
});

describe("DU's verdict is not ours", () => {
  it("shares no spelling with the engine's own recommendations", () => {
    // The hazard is that the two sets resemble each other by design, so that a
    // real submission could one day stand where the shadow engine stands. If
    // one spelling ever appeared in both, an assignment between them would
    // compile for the common case and fail only on the members that differ —
    // which is the worst way to find out that `refer` means "we could not
    // compute this" on one side and "DU computed it, now underwrite it by hand"
    // on the other.
    const ours = new Set<string>(AUS_RECOMMENDATIONS);
    for (const theirs of DU_RECOMMENDATIONS) {
      expect(ours.has(theirs)).toBe(false);
    }
  });

  it("splits by eligibility where ours does not", () => {
    // "Refer/Ineligible" is computed, underwritable by hand, and not saleable
    // to Fannie on these terms. Mapping it onto our `refer` would drop the
    // second half of that sentence.
    expect(DU_RECOMMENDATIONS).toContain("Refer/Eligible");
    expect(DU_RECOMMENDATIONS).toContain("Refer/Ineligible");
    expect(AUS_RECOMMENDATIONS).toContain("refer");
  });
});
