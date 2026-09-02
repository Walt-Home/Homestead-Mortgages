import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";

/**
 * Signing a document.
 *
 * Two steps against the server — start an envelope, then complete it — because
 * that is the shape a real e-sign vendor imposes and collapsing it now would
 * mean pulling it apart later. In between, the borrower sees what they are
 * actually authorising. A one-click "I agree" on a form that releases IRS
 * records would be the kind of consent that is technically recorded and
 * practically meaningless.
 */

const DOCUMENTS: Record<string, { title: string; body: string[]; commit: string }> = {
  application_signature: {
    title: "Your application",
    body: [
      "This is the application itself — the property, the loan, your details, and the declarations you just confirmed.",
      "It also includes IRS Form 4506-C, which lets us request your tax records directly rather than asking you to find them. That is the step that would otherwise become a whole screen.",
      "Signing submits it. It does not commit you to borrowing anything, and it is not an agreement to any particular rate or terms.",
    ],
    commit: "Sign and submit",
  },

  form_4506c: {
    title: "IRS Form 4506-C",
    body: [
      "You are authorising the IRS to release your tax transcripts for the last two years to us.",
      "Transcripts show what you filed: wages, adjusted gross income, and the forms behind them. They do not authorise us to file anything, change anything, or see anything beyond those years.",
      "You can withdraw this at any time, and deleting your file removes it.",
    ],
    commit: "Sign the 4506-C",
  },
  verification_authorization: {
    title: "Authorisation to verify",
    body: [
      "You are authorising us to check your credit, employment, income and assets.",
      "The credit check is a soft pull and does not affect your score.",
    ],
    commit: "Sign the authorisation",
  },
  econsent: {
    title: "Electronic delivery",
    body: [
      "You are agreeing to receive disclosures electronically rather than on paper.",
      "You can ask for paper at any time.",
    ],
    commit: "Agree to electronic delivery",
  },
};

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
      <button className="btn-primary" onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }

  return (
    <div className="rounded-card border border-line bg-app p-5">
      <h3 className="font-brand text-[16px] font-semibold text-ink-editorial">{doc.title}</h3>
      <div className="mt-3 space-y-2.5">
        {doc.body.map((p, i) => (
          <p key={i} className="text-[13px] leading-relaxed text-ink-soft">
            {p}
          </p>
        ))}
      </div>
      <p className="mt-4 text-[12px] leading-relaxed text-subtle">
        This is a prototype: nothing is actually sent to the IRS or anyone else, and the transcripts
        you will see are invented.
      </p>
      {error && <p className="mt-3 text-[13px] text-error">{error}</p>}
      <div className="mt-5 flex gap-3">
        <button className="btn-primary" onClick={() => void sign()} disabled={busy}>
          {busy ? "Signing…" : doc.commit}
        </button>
        <button className="btn-secondary" onClick={() => setOpen(false)} disabled={busy}>
          Not now
        </button>
      </div>
    </div>
  );
}
