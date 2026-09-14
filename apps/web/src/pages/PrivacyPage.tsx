import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api.js";
import { PERSONA_READ_ONLY, useAuth } from "../lib/auth.js";
import { SSN_COPY } from "../lib/disclosures.js";

/**
 * Whether this session has an account of its own to delete.
 *
 * A sample borrower does not: the row belongs to the seed, everyone can read
 * it, and the server refuses `DELETE /auth/me` from such a session. Offering
 * the button anyway would put the one control on the page that answers 403
 * under a heading promising it works — the same reason the front door hides
 * "Start now".
 *
 * Exported for the same reason `canStart` is: a rule a screen depends on
 * should be something a test can hold, not an expression inside the JSX.
 */
export function canDelete(user: { persona: unknown } | null | undefined): boolean {
  return Boolean(user) && !user?.persona;
}

/**
 * What a refused deletion is called on this page.
 *
 * The session-level refusal gets the shared sentence, the one every screen
 * that can meet it says; anything else says what the server said. Separate
 * from the handler so the words are a rule rather than a branch nothing can
 * reach without a browser.
 */
export function deletionRefusal(err: unknown): string {
  if (err instanceof ApiError && err.code === "PERSONA_READ_ONLY") return PERSONA_READ_ONLY;
  return err instanceof Error ? err.message : "That did not work.";
}

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
  const [error, setError] = useState<string | null>(null);

  async function deleteEverything() {
    setBusy(true);
    setError(null);
    try {
      await api.del("/auth/me");
    } catch (err) {
      // This route used to be the one write that could not fail for anybody
      // signed in, so it was written with nowhere for a refusal to go: the
      // button stayed disabled reading "Deleting…" for good and the page said
      // nothing. A sample borrower is now refused, and a session can become
      // one under a page that is already open, so the refusal has to land
      // somewhere a person can see it.
      setError(deletionRefusal(err));
      setBusy(false);
      return;
    }
    await signOut().catch(() => undefined);
    navigate("/");
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="font-display text-3xl text-ink">What this keeps</h1>

      <div className="mt-6 space-y-5 text-base text-ink-soft">
        <p>
          This is a prototype we are testing. It is not a lender, nothing it shows you is an offer,
          and no part of it touches your real credit, bank or payroll.
        </p>
        {/*
          The same two sentences screen 2 puts under the SSN field, from the
          same constant. This page was already right about the number and that
          screen was not — "the rest goes straight to the credit bureaus" — and
          two surfaces on one deployment disagreeing about the most sensitive
          field in the product is what makes one source the fix rather than two
          strings that happen to agree.
        */}
        <p>
          <strong className="font-semibold">{SSN_COPY.lead}</strong> {SSN_COPY.body}
        </p>
        <p>What we do store, because the flow needs it:</p>
      </div>

      <ul className="mt-4 space-y-1.5 text-sm text-ink-soft">
        <li>· Your name, date of birth, email, phone and address</li>
        <li>· The property and loan details you enter</li>
        <li>· The last four digits of your SSN</li>
        <li>· The made-up credit, bank and payroll data the demo generates for you</li>
        <li>· Your Google account name, email and picture</li>
      </ul>

      <div className="mt-6 space-y-5 text-base text-ink-soft">
        <p>
          It sits in a private database that only our team can reach. We do not sell it, share it,
          or send it anywhere else. There is no marketing list.
        </p>
        <p>
          You can take all of it back at any time. Deleting removes your account, every file you
          started and everything attached to them, for good — there is no archive and no undo.
        </p>
      </div>

      {/* Three ways this card can read, because there are three people it can
          be showing. The banner links here from the sign-in page, so it renders
          for somebody who has not signed in and has nothing to delete yet —
          showing them a delete button would offer an action that cannot work,
          and "Signed in as ." with a dangling period, which is how that was
          caught. A sample borrower has nothing of their own here either. */}
      {user && canDelete(user) ? (
        <div className="super-card mt-8">
          {!confirming ? (
            <>
              <h2 className="font-display text-base text-ink">Delete everything</h2>
              <p className="mt-1.5 text-sm text-ink-muted">Signed in as {user.email}.</p>
              <button
                className="super-btn super-btn-outline mt-4"
                onClick={() => setConfirming(true)}
              >
                Delete my account and files
              </button>
            </>
          ) : (
            <>
              <h2 className="font-display text-base text-ink">Delete everything, permanently?</h2>
              <p className="mt-1.5 text-sm text-ink-muted">
                Your account and every file you started will be removed. This cannot be undone.
              </p>
              <div className="mt-4 flex gap-3">
                <button
                  className="super-btn super-btn-danger"
                  onClick={() => void deleteEverything()}
                  disabled={busy}
                >
                  {busy ? "Deleting…" : "Yes, delete everything"}
                </button>
                {/*
                  Ghost, not outline. The outline variant is red, and beside a
                  red danger button it made the safe choice look like the
                  destructive one — on the screen where getting that wrong
                  deletes somebody's account.
                */}
                <button
                  className="super-btn super-btn-ghost"
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                >
                  Keep it
                </button>
              </div>
            </>
          )}
          {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        </div>
      ) : user ? (
        <div className="super-card mt-8">
          <h2 className="font-display text-base text-ink">Nothing stored for you here</h2>
          <p className="mt-1.5 text-sm text-ink-muted">
            This is a sample borrower, seeded for testing. There is no account of yours to delete.
          </p>
        </div>
      ) : (
        <div className="super-card mt-8">
          <h2 className="font-display text-base text-ink">Nothing stored for you yet</h2>
          <p className="mt-1.5 text-sm text-ink-muted">
            You are not signed in, so there is nothing of yours here. Sign in and this is where you
            can delete it again.
          </p>
        </div>
      )}
    </div>
  );
}
