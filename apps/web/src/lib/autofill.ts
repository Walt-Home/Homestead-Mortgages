/**
 * The screens' half of the autofill: find the suggestion a screen may render,
 * and say what became of it when the screen saves.
 *
 * The API computes suggestions on every read of a file and hands them back
 * beside it; nothing here stores one, and nothing here fills a control. A
 * screen renders a suggestion as a `Found` line, and on save reports one
 * outcome per suggestion it rendered: accepted when the value given is the
 * value offered, corrected when it differs, dismissed when the person said
 * so. A suggestion the screen did not render reports nothing.
 */

import type { AutofillOutcomeInput, Suggestion, SuggestionKey } from "@hm/shared";

export function suggestionFor(
  suggestions: readonly Suggestion[] | undefined,
  key: SuggestionKey,
): Suggestion | null {
  return suggestions?.find((s) => s.key === key) ?? null;
}

/**
 * The outcome for one rendered suggestion. `given` is what the person is
 * saving for the target, or null when the control carries nothing.
 */
export function outcomeFor(
  suggestion: Suggestion,
  given: number | null,
  dismissed: boolean,
): AutofillOutcomeInput {
  const base = { key: suggestion.key, snapshotId: suggestion.evidence.snapshotId };
  if (dismissed) return { ...base, outcome: "dismissed", proposed: suggestion.value };
  if (given !== null && given === suggestion.value) {
    return { ...base, outcome: "accepted", proposed: suggestion.value, given };
  }
  return { ...base, outcome: "corrected", proposed: suggestion.value, given };
}

/** A typed money string as a number, or null for nothing typed. */
export function typedAmount(text: string): number | null {
  const n = Number(text.replace(/[^\d.]/g, ""));
  return text.trim() === "" || !Number.isFinite(n) ? null : n;
}
