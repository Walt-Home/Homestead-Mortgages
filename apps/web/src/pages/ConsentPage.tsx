import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { useLoanFile } from "../lib/file.js";

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
  const navigate = useNavigate();
  const { data } = useLoanFile(fileId);
  const readOnly = data?.file.isDemo === true;

  // Seed from the file so a returning visitor sees the choice they made rather
  // than being asked again.
  const alreadyOn = data?.file.links.some((l) => l.persistentMonitoringEnabled) ?? false;
  const [choice, setChoice] = useState<boolean | null>(alreadyOn ? true : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(enabled: boolean) {
    setSaving(true);
    setError(null);
    try {
      await api.post(`/files/${fileId}/monitoring`, { enabled });
      setChoice(enabled);
    } catch (err) {
      // Without this, one failure left both buttons disabled forever and the
      // flow had no exit at all.
      setError(err instanceof Error ? err.message : "That didn't save. Try again?");
    } finally {
      setSaving(false);
    }
  }

  if (choice !== null) {
    return (
      <div className="card">
        <button
          className="mb-4 text-[13px] text-subtle underline-offset-2 hover:underline"
          onClick={() => navigate(`/f/${fileId}/decision`)}
        >
          Back to your decision
        </button>
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

      {error && <p className="mt-5 text-[13px] text-error">{error}</p>}

      <div className="mt-7 flex flex-wrap gap-3">
        <button
          className="btn-primary"
          onClick={() => void decide(true)}
          disabled={saving || readOnly}
        >
          {saving ? "Saving…" : "Keep my connections live"}
        </button>
        <button
          className="btn-secondary"
          onClick={() => void decide(false)}
          disabled={saving || readOnly}
        >
          No thanks
        </button>
        <button className="btn-secondary" onClick={() => navigate(`/f/${fileId}/decision`)}>
          Back
        </button>
      </div>

      {readOnly && (
        <p className="mt-4 text-[13px] text-subtle">
          This is a sample file, so the choice is fixed.
        </p>
      )}
    </div>
  );
}
