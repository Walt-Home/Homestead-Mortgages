import clsx from "clsx";
import { Link } from "react-router-dom";
import { hasReached, type FlowStage } from "../lib/file.js";

/**
 * The nine screens, and the way back to any of them you have already reached.
 *
 * This used to be inert text. There was no back navigation anywhere in the
 * product — not a link, not a button — so a person who mistyped their income
 * on screen 1 had no way to fix it short of abandoning the file. Browser-back
 * technically moved the URL but landed on a screen that re-submitted.
 *
 * Steps ahead of where you have got to stay unlinked: they are not "locked" so
 * much as meaningless, since the data they read does not exist yet.
 */

export const SCREENS = [
  { id: "property_loan", stage: "PROPERTY_LOAN", path: "property", label: "Property & loan" },
  { id: "identity", stage: "IDENTITY", path: "identity", label: "Identity" },
  { id: "credit", stage: "CREDIT", path: "credit", label: "Credit" },
  { id: "bank", stage: "BANK", path: "bank", label: "Bank" },
  { id: "payroll", stage: "PAYROLL", path: "payroll", label: "Payroll" },
  { id: "irs_transcript", stage: "IRS_TRANSCRIPT", path: "irs", label: "IRS" },
  { id: "upload_fallback", stage: "UPLOAD_FALLBACK", path: "upload", label: "Documents" },
  { id: "decision", stage: "DECISION", path: "decision", label: "Decision" },
  { id: "persistent_consent", stage: "PERSISTENT_CONSENT", path: "consent", label: "Stay connected" },
] as const;

export type ScreenPath = (typeof SCREENS)[number]["path"];

export function Stepper({
  current,
  fileId,
  reached,
}: {
  current: ScreenPath;
  fileId?: string;
  /** How far the file has actually got. Steps beyond this are not linked. */
  reached?: FlowStage;
}) {
  const currentIndex = SCREENS.findIndex((s) => s.path === current);

  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-2 text-[13px]">
      {SCREENS.map((screen, index) => {
        const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming";
        // Linkable when the file exists and has reached this stage. The current
        // screen is not a link to itself.
        const linkable =
          Boolean(fileId) && state !== "current" && hasReached(reached, screen.stage);

        const className = clsx(
          "rounded-pill px-2.5 py-1 transition-colors",
          state === "done" && "bg-olive-light text-olive",
          state === "current" && "bg-gold-fill text-gold font-medium",
          state === "upcoming" && "text-subtle",
          linkable && "hover:bg-hover cursor-pointer",
          !linkable && state !== "current" && "cursor-default",
        );

        return (
          <li key={screen.id} className="flex items-center gap-1">
            {linkable ? (
              <Link to={`/f/${fileId}/${screen.path}`} className={className}>
                {screen.label}
              </Link>
            ) : (
              <span className={className}>{screen.label}</span>
            )}
            {index < SCREENS.length - 1 && <span className="text-subtle/50">·</span>}
          </li>
        );
      })}
    </ol>
  );
}
