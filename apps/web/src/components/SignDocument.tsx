import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { creditCheckCopy, modeOf, type ConnectorMode } from "../lib/disclosures.js";

/**
 * Signing a document.
 *
 * Two steps against the server — start an envelope, then complete it — because
 * that is the shape a real e-sign vendor imposes and collapsing it now would
 * mean pulling it apart later. In between, the borrower sees what they are
 * actually authorizing. A one-click "I agree" on a form that releases IRS
 * records would be the kind of consent that is technically recorded and
 * practically meaningless.
 */

/**
 * `body` is a function of the connector modes because one of these documents
 * says what the credit check WILL be, and what it will be depends on what is
 * behind `POST /files/:id/credit`. The authorization used to state flatly that
 * the check is a soft pull, on a repository with no credit adapter in it — the
 * same sentence, and the same defect, as the animation on screen 2.
 */
const DOCUMENTS: Record<
  string,
  { title: string; body: (credit: ConnectorMode) => string[]; commit: string }
> = {
  form_4506c: {
    title: "IRS Form 4506-C",
    body: () => [
      "You are authorizing the IRS to release your tax transcripts for the last two years to us.",
      "Transcripts show what you filed: wages, adjusted gross income, and the forms behind them. They do not authorize us to file anything, change anything, or see anything beyond those years.",
      "You can withdraw this at any time, and deleting your file removes it.",
    ],
    commit: "Sign the 4506-C",
  },
  verification_authorization: {
    title: "Authorization to verify",
    body: (credit) => [
      "You are authorizing us to check your credit, employment, income and assets.",
      creditCheckCopy(credit).authorization,
    ],
    commit: "Sign the authorization",
  },
  econsent: {
    title: "Electronic delivery",
    body: () => [
      "You are agreeing to receive disclosures electronically rather than on paper.",
      "You can ask for paper at any time.",
    ],
    commit: "Agree to electronic delivery",
  },
};

/**
 * What this panel will call the document once it is open.
 *
 * The upload branch has to name a document before anybody has pressed
 * anything, and the only other name it had for one was the requirements
 * sheet's — "4506-C executed". Reading the title from here means the card and
 * the panel it opens cannot drift apart, and neither of them is the sheet.
 */
export function documentTitle(kind: string): string | undefined {
  return DOCUMENTS[kind]?.title;
}

export function SignDocument({
  fileId,
  kind,
  label,
  onSigned,
}: {
  fileId: string;
  kind: string;
  label: string;
  onSigned?: () => void;
}) {
  const queryClient = useQueryClient();
  const { config: authConfig } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doc = DOCUMENTS[kind];

  async function sign() {
    setBusy(true);
    setError(null);
    try {
      const started = await api.post<{ alreadySigned: boolean; envelopeId?: string }>(
        `/files/${fileId}/esign`,
        { kind },
      );
      if (!started.alreadySigned && started.envelopeId) {
        await api.post(`/files/${fileId}/esign/complete`, { envelopeId: started.envelopeId });
      }
      await queryClient.invalidateQueries({ queryKey: ["file", fileId] });
      await queryClient.invalidateQueries({ queryKey: ["assessment"] });
      setOpen(false);
      onSigned?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't go through. Try again?");
    } finally {
      setBusy(false);
    }
  }

  if (!doc) return null;

  if (!open) {
    return (
      <button className="super-btn super-btn-primary" onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }

  return (
    <div className="super-card">
      <h3 className="font-display text-base text-ink">{doc.title}</h3>
      <div className="mt-3 space-y-2.5">
        {doc.body(modeOf(authConfig?.connectorModes, "credit")).map((p, i) => (
          <p key={i} className="text-sm text-ink-soft">
            {p}
          </p>
        ))}
      </div>
      <p className="mt-4 text-xs text-ink-faint">
        This is a prototype: nothing is actually sent to the IRS or anyone else, and the transcripts
        you will see are invented.
      </p>
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      <div className="mt-5 flex gap-3">
        <button className="super-btn super-btn-primary" onClick={() => void sign()} disabled={busy}>
          {busy ? "Signing…" : doc.commit}
        </button>
        <button
          className="super-btn super-btn-outline"
          onClick={() => setOpen(false)}
          disabled={busy}
        >
          Not now
        </button>
      </div>
    </div>
  );
}
