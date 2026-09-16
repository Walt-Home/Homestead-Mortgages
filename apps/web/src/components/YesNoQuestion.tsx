/**
 * One question, two answers, and whatever the yes reveals.
 *
 * Radios rather than a checkbox: a checkbox has no unanswered state, and an
 * unticked box reading as "no" is how a borrower is recorded as denying
 * something nobody asked them.
 *
 * It lives here rather than on screen 3 because two screens ask questions now.
 * Screen 3 asks URLA Section 5; screen 5 asks URLA 1b about each job, which
 * cannot be asked any earlier — there is no job to ask about until the pulls
 * on screen 4 have said which ones there are. A second copy of this markup
 * would be a second answer to "what does an unanswered question look like",
 * and the copy that drifts would be the one sitting above the signature.
 */

import type { ReactNode } from "react";
import type { YesNo } from "../lib/declarations.js";

export function YesNoQuestion({
  id,
  prompt,
  value,
  onChange,
  children,
}: {
  id: string;
  prompt: string;
  value: YesNo;
  onChange: (value: YesNo) => void;
  children?: ReactNode;
}) {
  return (
    <fieldset className="mt-5">
      <legend className="text-base text-ink-soft">{prompt}</legend>
      <div className="mt-2 flex gap-5">
        {(["yes", "no"] as const).map((option) => (
          <label key={option} className="flex items-center gap-2 text-base text-ink-soft">
            <input
              type="radio"
              name={id}
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
            />
            <span>{option === "yes" ? "Yes" : "No"}</span>
          </label>
        ))}
      </div>
      {children}
    </fieldset>
  );
}
