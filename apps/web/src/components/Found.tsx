/**
 * What the product found, said beside a question and never put into it.
 *
 * One line: the basis sentence, the source tag, and at most two quiet links,
 * "Use it" and a dismissal. Never a control, never a pre-selected option; the
 * input beside it stays empty until the person taps or types. `.super-source`
 * is a neutral line by design: color on this product is reserved for outcome
 * states, and a found value is not an outcome.
 *
 * `docs/autofill.md` is the design; the screen that renders this reports what
 * became of it with its save.
 */

import type { Suggestion } from "@hm/shared";

export function Found({
  suggestion,
  onUse,
  onDismiss,
  dismissLabel = "Not this",
}: {
  suggestion: Suggestion;
  onUse?: () => void;
  onDismiss?: () => void;
  dismissLabel?: string;
}) {
  return (
    <p className="super-source mt-2" data-found={suggestion.key}>
      {suggestion.basis} · {suggestion.tag}
      {onUse && (
        <>
          {" "}
          <button type="button" className="super-link-quiet" onClick={onUse}>
            Use it
          </button>
        </>
      )}
      {onDismiss && (
        <>
          {" "}
          <button type="button" className="super-link-quiet" onClick={onDismiss}>
            {dismissLabel}
          </button>
        </>
      )}
    </p>
  );
}
