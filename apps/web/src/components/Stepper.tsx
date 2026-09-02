import clsx from "clsx";
import { Link } from "react-router-dom";
import { hasReached, type FlowStage } from "../lib/file.js";

/**
 * Four steps.
 *
 * It was nine, one per screen in Drew's sheet, which mistook the sheet's
 * structure for the borrower's. The sheet is organised by where evidence comes
 * from; a person experiences the flow by what they are being asked to do. Those
 * are not the same shape — three of the nine screens asked the borrower for
 * nothing at all beyond a button, and one of them (the IRS transcript) asked
 * for a signature that belongs in the package they sign at the end anyway.
 *
 * Steps ahead of where the file has got to are not links: they are not locked
 * so much as meaningless, because the data they read does not exist yet.
 */

export const SCREENS = [
  { id: "property", stage: "PROPERTY_LOAN", path: "property", label: "Property & loan" },
  { id: "identity", stage: "IDENTITY", path: "identity", label: "Identity & credit" },
  { id: "bank", stage: "BANK", path: "bank", label: "Bank" },
  { id: "confirm", stage: "DECISION", path: "confirm", label: "Confirm & sign" },
] as const;

export type ScreenPath = (typeof SCREENS)[number]["path"] | "result" | "payroll" | "documents";

export function Stepper({
  current,
  fileId,
  reached,
}: {
  current: ScreenPath;
  fileId?: string;
  reached?: FlowStage;
}) {
  // The fallback screens are not steps of their own — they belong to the step
  // that forked to them, and showing them as extra steps would make the flow
  // look longer for exactly the people having the hardest time.
  const owner: Record<string, string> =
    { payroll: "bank", documents: "bank", result: "confirm" };
  const effective = owner[current] ?? current;
  const currentIndex = SCREENS.findIndex((s) => s.path === effective);

  return (
    <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-2 text-[13px]">
      {SCREENS.map((screen, index) => {
        const state =
          index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming";
        const linkable =
          Boolean(fileId) && state !== "current" && hasReached(reached, screen.stage);

        const className = clsx(
          "rounded-pill px-2.5 py-1 transition-colors",
          state === "done" && "bg-olive-light text-olive",
          state === "current" && "bg-gold-fill text-gold font-medium",
          state === "upcoming" && "text-subtle",
          linkable && "cursor-pointer hover:bg-hover",
        );

        return (
          <li key={screen.id} className="flex items-center gap-1.5">
            <span className="figure text-[11px] text-subtle">{index + 1}</span>
            {linkable ? (
              <Link to={`/f/${fileId}/${screen.path}`} className={className}>
                {screen.label}
              </Link>
            ) : (
              <span className={className}>{screen.label}</span>
            )}
            {index < SCREENS.length - 1 && <span className="text-subtle/40">·</span>}
          </li>
        );
      })}
    </ol>
  );
}
