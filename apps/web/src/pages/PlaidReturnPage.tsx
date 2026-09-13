/**
 * Where an OAuth bank returns the borrower.
 *
 * Some institutions do not authenticate inside Link. They navigate the whole
 * document away to their own site and send it back here, which means every
 * piece of React state from screen 4 is gone. Plaid requires the resumed Link
 * to use the SAME link token, and forbids query parameters on the redirect
 * URI — so there is no file id in the URL and both have to come from the
 * stored attempt record.
 *
 * This page is a courier, not a second implementation. It reopens Link, and
 * the moment it has a public token it writes it to the record and hands the
 * borrower back to screen 4. Exactly one component owns the conversation with
 * `POST /files/:id/bank`, because that endpoint writes to append-only tables
 * and two writers is two snapshots for one pull.
 */

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PlaidLink } from "../components/PlaidLink.js";
import { findResumableAttempt, writeAttempt, type BankAttempt } from "../lib/plaid.js";

export function PlaidReturnPage() {
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState<BankAttempt | null | undefined>(undefined);
  // Captured once. Link needs the URL as the bank left it, and React Router
  // will have rewritten it by the time a re-render reads window.location.
  const returnedTo = useRef(window.location.href);

  useEffect(() => {
    setAttempt(findResumableAttempt());
  }, []);

  if (attempt === undefined) {
    return <p className="text-sm text-ink-faint">Picking up where you left off…</p>;
  }

  if (attempt === null) {
    // No styling as an error, because nothing failed. The thread was lost —
    // cleared site data, a different device, or long enough that the token
    // aged out. There is no file id to route to, and guessing one would be
    // worse than asking.
    return (
      <div className="super-card">
        <h1 className="font-display text-2xl text-ink">We couldn&rsquo;t pick that back up</h1>
        <p className="mt-2 text-base text-ink-soft">
          Your bank sent you back, but too much time passed for us to match it to your application.
          Nothing was lost — open your file and connect again.
        </p>
        {/* A Link, not an <a>, for the reason the header's home link gives:
            an anchor throws away the SPA and reloads the whole app. */}
        <Link to="/" className="super-btn super-btn-primary mt-6">
          Back to your applications
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="super-card">
        <h1 className="font-display text-2xl text-ink">Finishing up with your bank</h1>
        <p className="mt-2 text-base text-ink-soft">
          One moment — we&rsquo;re picking up where your bank left off.
        </p>
      </div>
      <PlaidLink
        token={attempt.linkToken}
        receivedRedirectUri={returnedTo.current}
        onSuccess={(publicToken) => {
          if (publicToken) {
            writeAttempt({ ...attempt, phase: "assembling", publicToken });
          }
          navigate(`/f/${attempt.fileId}/bank`, { replace: true });
        }}
        onExit={() => navigate(`/f/${attempt.fileId}/bank`, { replace: true })}
        onUnavailable={() => navigate(`/f/${attempt.fileId}/bank`, { replace: true })}
      />
    </>
  );
}
