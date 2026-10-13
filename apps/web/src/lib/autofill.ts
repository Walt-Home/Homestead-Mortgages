/**
 * The screens' half of the autofill: find the suggestion a screen may render,
 * and say what became of it when the screen saves.
 *
 * The API computes suggestions on every read and hands them back: beside the
 * file on `GET /files/:id` (the rent, a returning person's phone), and about
 * the person on `GET /suggestions` for the screens that ask before a file
 * exists (the income, on screen 1 and the refinance offer card). Nothing here
 * stores one, and nothing here fills a control. A screen renders a suggestion
 * as a `Found` line, and on save reports one outcome per suggestion it
 * rendered: accepted when the value given is the value offered, corrected
 * when it differs, dismissed when the person said so. A suggestion the
 * screen did not render reports nothing.
 */

import { useQuery } from "@tanstack/react-query";
import type { AutofillOutcomeInput, Suggestion, SuggestionKey } from "@hm/shared";
import { api } from "./api.js";

export function suggestionFor(
  suggestions: readonly Suggestion[] | undefined,
  key: SuggestionKey,
): Suggestion | null {
  return suggestions?.find((s) => s.key === key) ?? null;
}

/**
 * What the person signed in may be offered before a file exists.
 *
 * Its own query, not the file's: screen 1 and the offer card have no file to
 * read. Invalidated after a screen 1 save, because that save states a newer
 * figure than the one this offered.
 */
export function usePersonSuggestions(enabled = true) {
  return useQuery({
    queryKey: ["suggestions"],
    queryFn: () =>
      api.get<{ suggestions: Suggestion[] }>("/suggestions").then((r) => r.suggestions),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * The same value, said two ways? A phone compares by its digits, so a number
 * typed with or without dashes is the number offered; a figure by its value.
 */
export function sameValue(offered: number | string, given: number | string | null): boolean {
  if (given === null) return false;
  if (typeof offered === "string" || typeof given === "string") {
    const digits = (v: number | string) => String(v).replace(/\D/g, "");
    return digits(offered) !== "" && digits(offered) === digits(given);
  }
  return offered === given;
}

/**
 * The outcome for one rendered suggestion. `given` is what the person is
 * saving for the target, or null when the control carries nothing.
 */
export function outcomeFor(
  suggestion: Suggestion,
  given: number | string | null,
  dismissed: boolean,
): AutofillOutcomeInput {
  const base = { key: suggestion.key, evidenceId: suggestion.evidence.id };
  if (dismissed) return { ...base, outcome: "dismissed", proposed: suggestion.value };
  if (sameValue(suggestion.value, given)) {
    return { ...base, outcome: "accepted", proposed: suggestion.value, given };
  }
  return { ...base, outcome: "corrected", proposed: suggestion.value, given };
}

/** A typed money string as a number, or null for nothing typed. */
export function typedAmount(text: string): number | null {
  const n = Number(text.replace(/[^\d.]/g, ""));
  return text.trim() === "" || !Number.isFinite(n) ? null : n;
}
