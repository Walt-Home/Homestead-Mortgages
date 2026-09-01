import clsx from "clsx";

export const SCREENS = [
  { id: "property_loan", path: "property", label: "Property & loan" },
  { id: "identity", path: "identity", label: "Identity" },
  { id: "credit", path: "credit", label: "Credit" },
  { id: "bank", path: "bank", label: "Bank" },
  { id: "payroll", path: "payroll", label: "Payroll" },
  { id: "irs_transcript", path: "irs", label: "IRS" },
  { id: "upload_fallback", path: "upload", label: "Documents" },
  { id: "decision", path: "decision", label: "Decision" },
  { id: "persistent_consent", path: "consent", label: "Stay connected" },
] as const;

export type ScreenPath = (typeof SCREENS)[number]["path"];

export function Stepper({ current }: { current: ScreenPath }) {
  const currentIndex = SCREENS.findIndex((s) => s.path === current);

  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-2 text-[13px]">
      {SCREENS.map((screen, index) => {
        const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming";
        return (
          <li key={screen.id} className="flex items-center gap-1">
            <span
              className={clsx(
                "rounded-pill px-2.5 py-1 transition-colors",
                state === "done" && "bg-olive-light text-olive",
                state === "current" && "bg-gold-fill text-gold font-medium",
                state === "upcoming" && "text-subtle",
              )}
            >
              {screen.label}
            </span>
            {index < SCREENS.length - 1 && <span className="text-subtle/50">·</span>}
          </li>
        );
      })}
    </ol>
  );
}
