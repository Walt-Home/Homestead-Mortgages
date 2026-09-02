/**
 * The designed wait.
 *
 * Connections take ten to thirty seconds and that is where people abandon. A
 * disabled button reading "Connecting…" gives someone nothing to do with that
 * time except wonder whether it has hung.
 *
 * So: name the steps, tick them off as they land, and keep the last one
 * running rather than completing it — the final tick belongs to the real
 * result arriving, not to a timer. Nothing here fakes progress it does not
 * have; the steps advance on a schedule the caller supplies because the
 * caller is the only thing that knows what it is actually doing.
 *
 * Deliberately not a spinner. A spinner says "something is happening"; this
 * says what.
 */

import { useEffect, useState } from "react";
import clsx from "clsx";

export interface WorkingStep {
  readonly label: string;
  /** Roughly how long this step takes. Used only to pace the ticks. */
  readonly ms: number;
}

export function Working({ steps, note }: { steps: readonly WorkingStep[]; note?: string }) {
  const [done, setDone] = useState(0);

  useEffect(() => {
    // The last step never self-completes. It finishes when the caller unmounts
    // this component because the data arrived, which is the only honest signal.
    if (done >= steps.length - 1) return;
    const timer = setTimeout(() => setDone((d) => d + 1), steps[done]?.ms ?? 1000);
    return () => clearTimeout(timer);
  }, [done, steps]);

  return (
    <div className="mt-6 rounded-row border border-line-light bg-raised p-5">
      <ul className="flex flex-col gap-2.5">
        {steps.map((step, i) => {
          const state = i < done ? "done" : i === done ? "active" : "waiting";
          return (
            <li key={step.label} className="flex items-center gap-3 text-[14px]">
              <span
                aria-hidden="true"
                className={clsx(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-pill border text-[10px]",
                  state === "done" && "border-olive-border bg-olive text-white",
                  state === "active" && "border-gold-border bg-gold-fill",
                  state === "waiting" && "border-line bg-app",
                )}
              >
                {state === "done" ? "✓" : ""}
              </span>
              <span
                className={clsx(
                  state === "done" && "text-olive",
                  state === "active" && "text-ink",
                  state === "waiting" && "text-subtle",
                )}
              >
                {step.label}
                {state === "active" && <span className="text-meta">…</span>}
              </span>
            </li>
          );
        })}
      </ul>
      {note && <p className="mt-4 text-[12px] leading-relaxed text-meta">{note}</p>}
    </div>
  );
}
