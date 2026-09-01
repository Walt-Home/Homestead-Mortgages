/**
 * The derivation recorder.
 *
 * Screen 8's note in Drew's sheet is "Compute and answer. Show the reasoning,
 * not just a verdict." This is the mechanism that makes that possible rather
 * than aspirational: no number reaches the decision object except through
 * `record`, so every figure on the screen can name the requirement that
 * demanded it, the formula that produced it, and the inputs it consumed.
 *
 * `blocked` is the other half. A computation that cannot run yet records WHY
 * — which is what turns "DTI: —" into "DTI: waiting on your income".
 */

import type { Derivation } from "@sm/shared";

export type Inputs = Record<string, number | string | boolean | null>;

export class DerivationLog {
  private readonly entries: Derivation[] = [];

  /** Record a computed value and return it, so call sites read naturally. */
  record<T extends number | string | boolean | null>(
    requirementId: string,
    label: string,
    value: T,
    formula: string,
    inputs: Inputs,
  ): T {
    this.entries.push({ requirementId, label, value, formula, inputs });
    return value;
  }

  /** Record that a computation could not run, and why. Always returns null. */
  blocked(requirementId: string, label: string, waitingFor: readonly string[]): null {
    this.entries.push({
      requirementId,
      label,
      value: null,
      formula: "not computed",
      inputs: {},
      blockedBy: [...waitingFor],
    });
    return null;
  }

  all(): readonly Derivation[] {
    return this.entries;
  }
}

/** Round to `places`, avoiding the float noise that makes ratios look wrong. */
export function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
