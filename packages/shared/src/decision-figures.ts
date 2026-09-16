/**
 * The two blocks a decision carries as JSON, made to hold their shape.
 *
 * `ratios` and `reserves` are the shadow AUS's figures — every one of them a
 * number Desktop Underwriter derives for itself from the inputs we send, and
 * none of them a value with a destination in the DU Map (see
 * `DU_DERIVED_FIGURES` in `types/decision.ts`, and the test in `packages/du`
 * that holds the Map to it). They are written as one object, appended as
 * one, and diffed as one, which is why they are two JSON columns rather than
 * twelve typed ones. What that left open was the shape: written through a
 * cast, read through a cast, so a row holding `{}`, a string where a number
 * belongs, or an extra key round-tripped into a typed `Decision` and reached
 * the review screen unchecked.
 *
 * These are the schemas the writer parses BEFORE the row is inserted and the
 * reader parses AFTER it is selected — strict, every key present, every
 * figure a finite number or null (null is "could not compute", and the
 * derivation log says why). The database holds the same rule as a CHECK, so
 * a row nothing here wrote is still a row of this shape.
 *
 * Outside the barrel on purpose, like `portfolio.ts`: `index.ts` is bundled
 * by the browser app, which carries no zod.
 */

import { z } from "zod";
import type { Ratios, ReserveAssessment } from "./types/decision.js";

/** Finite or null. `z.number()` already refuses NaN; Infinity has reached a column before. */
const figure = z.number().finite().nullable();

export const RatiosSchema = z
  .object({
    dtiFront: figure,
    dtiBack: figure,
    ltv: figure,
    cltv: figure,
    hcltv: figure,
    housingPitia: figure,
    totalMonthlyDebt: figure,
    totalQualifyingIncome: figure,
  })
  .strict();

export const ReserveAssessmentSchema = z
  .object({
    requiredMonths: figure,
    actualMonths: figure,
    eligiblePostCloseAssets: figure,
    satisfied: z.boolean().nullable(),
  })
  .strict();

// Pinned to the interfaces in both directions, so a key added to either
// side fails the build rather than the next parse.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
// `Readonly<>` on the parsed side because the interfaces are readonly and a
// parsed object is not; the keys and the value types are what is pinned.
const ratiosAgree: Equal<Readonly<z.infer<typeof RatiosSchema>>, Ratios> = true;
const reservesAgree: Equal<Readonly<z.infer<typeof ReserveAssessmentSchema>>, ReserveAssessment> =
  true;
void ratiosAgree;
void reservesAgree;

export const RATIO_KEYS = Object.keys(RatiosSchema.shape) as readonly (keyof Ratios)[];
export const RESERVE_KEYS = Object.keys(
  ReserveAssessmentSchema.shape,
) as readonly (keyof ReserveAssessment)[];
