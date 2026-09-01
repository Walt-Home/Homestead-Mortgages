import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";

/**
 * What we hold, in plain words, with the button that undoes it.
 *
 * Written to be read by somebody's mother, not by a lawyer. It is not a
 * privacy policy and does not pretend to be one — it is an honest account of
 * a prototype, which is the most this should claim until it stops being one.
 */
export function PrivacyPage() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function deleteEverything() {
    setBusy(true);
    await api.del("/auth/me");
    await signOut().catch(() => undefined);
    navigate("/");
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="font-brand text-[26px] font-semibold text-ink-editorial">
        What this keeps
      </h1>

      <div className="mt-6 space-y-5 font-prose text-[16px] leading-relaxed text-ink-prose">
        <p>
          This is a prototype we are testing. It is not a lender, nothing it
          shows you is an offer, and no part of it touches your real credit,
          bank or payroll.
        </p>
        <p>
          <strong className="font-semibold">Your Social Security number never leaves your browser.</strong>{" "}
          The form asks for it because the real product would, but only the last
          four digits are ever sent to us. The rest is discarded the moment you
          move to the next screen.
        </p>
        <p>What we do store, because the flow needs it:</p>
      </div>

      <ul className="mt-4 space-y-1.5 text-[14px] leading-relaxed text-ink-soft">
        <li>· Your name, date of birth, email, phone and address</li>
        <li>· The property and loan details you enter</li>
        <li>· The last four digits of your SSN</li>
        <li>· The made-up credit, bank and payroll data the demo generates for you</li>
        <li>· Your Google account name, email and picture</li>
      </ul>

      <div className="mt-6 space-y-5 font-prose text-[16px] leading-relaxed text-ink-prose">
        <p>
          It sits in a private database that only our team can reach. We do not
          sell it, share it, or send it anywhere else. There is no marketing
          list.
        </p>
        <p>
          You can take all of it back at any time. Deleting removes your
          account, every file you started and everything attached to them, for
          good — there is no archive and no undo.
        </p>
      </div>

      {/* The banner links here from the sign-in page, so this renders for people
          who have not signed in and have nothing to delete yet. Showing them a
          delete button would offer an action that cannot work — and "Signed in
          as ." with a dangling period, which is how this was caught. */}
      {user ? (
        <div className="mt-8 rounded-card border border-line-light bg-app p-6">
          {!confirming ? (
            <>
              <h2 className="font-brand text-[16px] font-semibold text-ink-editorial">
                Delete everything
              </h2>
              <p className="mt-1.5 text-[13px] text-muted">Signed in as {user.email}.</p>
              <button className="btn-secondary mt-4" onClick={() => setConfirming(true)}>
                Delete my account and files
              </button>
            </>
          ) : (
            <>
              <h2 className="font-brand text-[16px] font-semibold text-ink-editorial">
                Delete everything, permanently?
              </h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
                Your account and every file you started will be removed. This cannot be undone.
              </p>
              <div className="mt-4 flex gap-3">
                <button
                  className="rounded-control bg-danger px-5 py-2.5 text-[15px] font-medium text-white disabled:opacity-40"
                  onClick={() => void deleteEverything()}
                  disabled={busy}
                >
                  {busy ? "Deleting…" : "Yes, delete everything"}
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                >
                  Keep it
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="mt-8 rounded-card border border-line-light bg-app p-6">
          <h2 className="font-brand text-[16px] font-semibold text-ink-editorial">
            Nothing stored for you yet
          </h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
            You are not signed in, so there is nothing of yours here. Sign in and this is where
            you can delete it again.
          </p>
        </div>
      )}
    </div>
  );
}
