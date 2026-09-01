import { useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api.js";

/**
 * Screen 9. Zero requirements in the sheet, and the highest leverage screen in
 * the product: "This ask enables everything downstream."
 *
 * What it does today is record the choice and mark every connection as
 * monitored. Nothing re-pulls yet — the scheduler is not built, and the copy
 * does not claim otherwise, because promising a borrower live monitoring and
 * delivering a stored boolean is the kind of thing that is very hard to walk
 * back later.
 */
export function ConsentPage() {
  const { fileId } = useParams<{ fileId: string }>();
  const [choice, setChoice] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  async function decide(enabled: boolean) {
    setSaving(true);
    await api.post(`/files/${fileId}/monitoring`, { enabled });
    setChoice(enabled);
    setSaving(false);
  }

  if (choice !== null) {
    return (
      <div className="card">
        <h1 className="font-brand text-[22px] font-semibold text-ink-editorial">
          {choice ? "We'll keep watching." : "Understood."}
        </h1>
        <p className="mt-2 font-prose text-[16px] leading-relaxed text-ink-prose">
          {choice
            ? "Your connections stay live. When rates move or your situation changes, we can tell you what it means without asking you to start over."
            : "Your connections are closed. You can turn this on any time."}
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <h1 className="font-brand text-[22px] font-semibold text-ink-editorial">
        Stay connected?
      </h1>
      <p className="mt-2 font-prose text-[16px] leading-relaxed text-ink-prose">
        Keeping your accounts connected means we can tell you when refinancing makes sense —
        without you filling any of this in again.
      </p>

      <ul className="mt-5 space-y-2 text-[14px] leading-relaxed text-ink-soft">
        <li>· We re-check your credit, income and assets periodically</li>
        <li>· We tell you when the numbers change enough to matter</li>
        <li>· You can disconnect any time, and we stop</li>
      </ul>

      <div className="mt-7 flex gap-3">
        <button className="btn-primary" onClick={() => decide(true)} disabled={saving}>
          Keep my connections live
        </button>
        <button className="btn-secondary" onClick={() => decide(false)} disabled={saving}>
          No thanks
        </button>
      </div>
    </div>
  );
}
