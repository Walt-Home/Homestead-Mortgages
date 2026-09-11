/**
 * Screen 3 — the bank connection.
 *
 * The borrower does exactly one thing: press a button. Everything after that
 * is their bank's own login, and then us.
 *
 * The result panel is the payoff for connecting, and the moment the product
 * first feels like it did something. It is framed as "here is where you
 * stand", never as an approval and never as an offer — a number on a screen
 * before a Loan Estimate exists is not a quote, and copy that lets somebody
 * believe otherwise is the kind of mistake that ends up in a consent order.
 *
 * ── Why this screen has a state machine now ───────────────────────────────
 *
 * It used to be one POST that returned a report. A real aggregator cannot
 * work that way: the borrower authenticates inside the vendor's own widget,
 * and the server learns nothing until they do. So the same endpoint now
 * answers three shapes — a link token, "still building", or the report — and
 * which one arrives depends on which adapter is configured.
 *
 * The client never guesses which. `requiresClientHandoff` on the response is
 * what decides, so the fixture path is untouched: its first POST still
 * returns 201 with a report, and nothing below the handoff branch runs.
 * cdn.plaid.com is never contacted on a fixture file, or a demo one.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.js";
import { PERSONA_READ_ONLY } from "../lib/auth.js";
import { useLoanFile, type DecisionRatios, type DecisionView } from "../lib/file.js";
import { Why } from "../components/Why.js";
import { Working } from "../components/Working.js";
import { PlaidLink } from "../components/PlaidLink.js";
import { Figure } from "../components/Figure.js";
import { money, qualifyingIncome, QUALIFYING_INCOME_LABEL } from "../lib/figures.js";
import {
  classifyBankResponse,
  clearAttempt,
  readAttempt,
  writeAttempt,
  SLOW_AFTER_MS,
  type PlaidLinkError,
} from "../lib/plaid.js";

interface AssetReport {
  accounts: { accountId: string; type: string; institution: string; currentBalance: number }[];
  /** Consecutive on-time rent payments the report could identify (CRD-018). */
  identifiedRentPayments?: number;
}

interface CreditReport {
  scores: { bureau: string; score: number }[];
  tradelines: unknown[];
}

/**
 * Where the borrower is, as far as this screen is concerned.
 *
 * `linking` and `assembling` only ever occur behind an aggregator. A fixture
 * file goes idle → opening → done, which is exactly what it did before.
 */
type Phase =
  | { kind: "idle" }
  | { kind: "opening" }
  | { kind: "linking"; linkToken: string }
  | { kind: "assembling" }
  | { kind: "slow" };

/** Shared so the fixture's four-step wait is not quietly shortened. */
const STEP = {
  opening: { label: "Opening a secure connection", ms: 1200 },
  reading: { label: "Reading twelve months of activity", ms: 2000 },
  finding: { label: "Finding your income and rent history", ms: 2000 },
  standing: { label: "Working out where you stand", ms: 2500 },
};
const OPENING_STEPS = [STEP.opening, STEP.reading, STEP.finding, STEP.standing];
const ASSEMBLING_STEPS = [STEP.reading, STEP.finding, STEP.standing];

/** When the wait stops feeling ordinary and the note should acknowledge it. */
const REASSURE_AFTER_MS = 25_000;

/** A blip mid-poll is not a failed bank connection. */
const POLL_FAILURES_TOLERATED = 2;

export function BankPage() {
  const { fileId } = useParams<{ fileId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useLoanFile(fileId);
  const readOnly = data?.file.isDemo === true;

  const existing = data?.file.assets as AssetReport | null | undefined;
  const credit = data?.file.credit as CreditReport | null | undefined;
  const persisted = data?.file.decision?.ratios ?? null;

  const [report, setReport] = useState<AssetReport | null>(null);
  const [standing, setStanding] = useState<DecisionRatios | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<{ label: string; to: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reassure, setReassure] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [statements, setStatements] = useState<string[]>([]);

  const sessionId = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attempts = useRef(0);
  const failures = useRef(0);
  // One silent re-mint, so a genuinely dead token cannot loop the borrower.
  const remounted = useRef(false);
  /**
   * Which file this screen has already resumed.
   *
   * The resume effect must run once per file, and its dependency list holds
   * callbacks whose identity changes — so without this it can run again and
   * start a second conversation with the bank route. It showed up immediately:
   * StrictMode's double invocation had the second run polling before the first
   * run's public-token exchange had returned, and the server answered
   * NO_PUBLIC_TOKEN. The poll retry absorbed it, which is exactly why it would
   * have gone unnoticed.
   */
  const resumedFor = useRef<string | null>(null);

  const result = report ?? existing ?? null;
  const figures = standing ?? persisted;
  const busy = phase.kind !== "idle";

  const stopPolling = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  /* ── Finishing ────────────────────────────────────────────────────────── */

  const finish = useCallback(
    async (body: Record<string, unknown>) => {
      stopPolling();
      if (fileId) clearAttempt(fileId);
      sessionId.current = null;
      setPhase({ kind: "idle" });
      setReport(body.report as AssetReport);

      // Only here, never on a 202. Recomputing against a file whose report has
      // not landed appends a decision — decisions are append-only — recording a
      // `refer` the borrower did not earn and that cannot be taken back.
      const decision = await api
        .post<{ decision: DecisionView }>(`/files/${fileId}/decision`, {})
        .catch(() => null);
      if (decision) setStanding(decision.decision.ratios);

      await queryClient.invalidateQueries({ queryKey: ["file", fileId] });
      await queryClient.invalidateQueries({ queryKey: ["assessment"] });
    },
    [fileId, queryClient, stopPolling],
  );

  const fail = useCallback(
    (err: unknown) => {
      stopPolling();
      // A session that expired mid-poll is not a bank failure. The signed-out
      // tree renders in place without navigating, so the URL and the stored
      // attempt both survive and the poll resumes after signing in.
      if (err instanceof ApiError && err.status === 401) return;

      setPhase({ kind: "idle" });
      sessionId.current = null;

      if (err instanceof ApiError && err.code === "DEMO_FILE_READ_ONLY") {
        setError("This is a sample file, so it is read-only.");
        return;
      }
      // The same refusal one level up: the session is a sample borrower, so it
      // would be refused on any file, including one of its own.
      if (err instanceof ApiError && err.code === "PERSONA_READ_ONLY") {
        setError(PERSONA_READ_ONLY);
        return;
      }
      if (err instanceof ApiError && err.code === "AUTHORIZATION_REQUIRED") {
        // Deliberately not err.message: the server's text carries the literal
        // requirement id, and no requirement id belongs on a borrower screen.
        setError("We need your authorization before we can check this.");
        setRecovery({ label: "Back to your details", to: `/f/${fileId}/identity` });
        return;
      }
      if (err instanceof ApiError && err.code === "PROJECTION_ERROR") {
        // A required identity fact is missing or blank, so nothing that reads
        // the file can run. Screen 2 is the repair path: saving it again
        // rewrites the person's facts, and the bank link is not at fault, so
        // the held attempt is kept for when they come back.
        setError("Something in your details needs another look before we can check this.");
        setRecovery({ label: "Back to your details", to: `/f/${fileId}/identity` });
        return;
      }
      if (err instanceof ApiError && err.code === "BANK_RELINK_REQUIRED") {
        if (fileId) clearAttempt(fileId);
        setError("Your bank needs signing into again.");
        return;
      }
      if (fileId) clearAttempt(fileId);
      setError("That connection did not go through.");
    },
    [fileId, stopPolling],
  );

  /* ── Polling ──────────────────────────────────────────────────────────── */

  const poll = useCallback(async () => {
    if (!fileId) return;
    // Never POST a bare body from a poll. An empty body is what tells the
    // route to mint a link session, which would invalidate the token an open
    // widget is holding and leave the borrower with a Link that silently
    // stops working.
    if (!sessionId.current) {
      setPhase({ kind: "slow" });
      return;
    }
    attempts.current += 1;
    try {
      const body = await api.post<Record<string, unknown>>(`/files/${fileId}/bank`, {
        sessionId: sessionId.current,
      });
      failures.current = 0;
      const res = classifyBankResponse(body);
      if (res.kind === "ready") {
        await finish(res.body);
        return;
      }
      if (res.kind === "pending") {
        const rec = readAttempt(fileId);
        // Measured against the persisted start, so reloading the page does
        // not hand the borrower a fresh three minutes of spinner.
        const elapsed = rec ? Date.now() - rec.startedAt : 0;
        if (elapsed > SLOW_AFTER_MS) {
          setPhase({ kind: "slow" });
          return;
        }
        const wait = Math.max(res.retryAfterMs, Math.min(1500 * attempts.current, 6000));
        timer.current = setTimeout(() => void poll(), wait);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      failures.current += 1;
      if (failures.current <= POLL_FAILURES_TOLERATED) {
        timer.current = setTimeout(() => void poll(), 4000);
        return;
      }
      fail(err);
    }
  }, [fileId, finish, fail]);

  const startAssembling = useCallback(
    async (publicToken: string) => {
      if (!fileId) return;
      const rec = readAttempt(fileId);
      if (rec) writeAttempt({ ...rec, phase: "assembling", startedAt: Date.now() });
      setPhase({ kind: "assembling" });
      attempts.current = 0;
      failures.current = 0;
      try {
        const body = await api.post<Record<string, unknown>>(`/files/${fileId}/bank`, {
          publicToken,
          sessionId: sessionId.current,
        });
        const res = classifyBankResponse(body);
        if (res.kind === "ready") return void (await finish(res.body));
        if (res.kind === "pending") {
          timer.current = setTimeout(() => void poll(), res.retryAfterMs);
        }
      } catch (err) {
        fail(err);
      }
    },
    [fileId, finish, fail, poll],
  );

  /* ── Starting ─────────────────────────────────────────────────────────── */

  const begin = useCallback(async () => {
    if (!fileId || readOnly) return;
    setError(null);
    setRecovery(null);
    setNotice(null);

    // A link token we already hold and have not spent is reopened without a
    // server round trip. Pressing Connect again after closing the widget is
    // the commonest path through this screen, and minting a second session
    // would bill for one nobody opened and invalidate the first.
    const held = readAttempt(fileId);
    if (held?.phase === "linking") {
      sessionId.current = held.sessionId;
      setPhase({ kind: "linking", linkToken: held.linkToken });
      return;
    }

    clearAttempt(fileId);
    sessionId.current = null;
    setPhase({ kind: "opening" });
    try {
      // The only call in the whole flow with an empty body, and therefore the
      // only one that mints a link token.
      const body = await api.post<Record<string, unknown>>(`/files/${fileId}/bank`, {});
      const res = classifyBankResponse(body);
      if (res.kind === "ready") return void (await finish(res.body));
      if (res.kind === "handoff") {
        sessionId.current = res.sessionId;
        writeAttempt({
          fileId,
          linkToken: res.linkToken,
          sessionId: res.sessionId,
          expiresAt: res.expiresAt,
          phase: "linking",
          startedAt: Date.now(),
        });
        setPhase({ kind: "linking", linkToken: res.linkToken });
        return;
      }
      // A `pending` here would mean the server started a report we never
      // handed a bank to. Nothing to do but wait on it.
      setPhase({ kind: "assembling" });
      timer.current = setTimeout(() => void poll(), res.retryAfterMs);
    } catch (err) {
      fail(err);
    }
  }, [fileId, readOnly, finish, fail, poll]);

  /* ── Resuming ─────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!fileId || result) return;
    if (resumedFor.current === fileId) return;
    const rec = readAttempt(fileId);
    if (!rec) return;
    resumedFor.current = fileId;
    sessionId.current = rec.sessionId;

    // Came back from an OAuth bank: the return page left the public token here
    // because this screen owns the conversation with the bank route.
    if (rec.publicToken) {
      writeAttempt({ ...rec, publicToken: undefined });
      void startAssembling(rec.publicToken);
      return;
    }
    if (rec.phase === "assembling") {
      setPhase({ kind: "assembling" });
      void poll();
    }
    // A `linking` record is NOT resumed into an open widget. The borrower
    // navigated here; opening their bank's login unasked would be startling.
    // `begin()` reuses the token when they press the button.
    return stopPolling;
  }, [fileId, result, poll, startAssembling, stopPolling]);

  /* Browsers throttle timers in a backgrounded tab to about once a minute. */
  useEffect(() => {
    if (phase.kind !== "assembling") return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      stopPolling();
      void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [phase.kind, poll, stopPolling]);

  /* Another tab finished this file. Both reaching 201 writes two snapshots
   * and two decisions for one pull, and both tables are append-only. */
  useEffect(() => {
    if (!fileId || phase.kind !== "assembling") return;
    const onStorage = (e: StorageEvent) => {
      if (!e.key?.endsWith(fileId) || e.newValue) return;
      stopPolling();
      setPhase({ kind: "idle" });
      void queryClient.invalidateQueries({ queryKey: ["file", fileId] });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [fileId, phase.kind, queryClient, stopPolling]);

  /* The note changes before the panel does. A jump straight from "reading
   * your bank" to "this is taking a while" is a bigger jolt than the
   * situation warrants. */
  useEffect(() => {
    if (phase.kind !== "assembling") return setReassure(false);
    const t = setTimeout(() => setReassure(true), REASSURE_AFTER_MS);
    return () => clearTimeout(t);
  }, [phase.kind]);

  useEffect(() => stopPolling, [stopPolling]);

  /* ── Link callbacks ───────────────────────────────────────────────────── */

  const handleSuccess = useCallback(
    (publicToken: string | null) => {
      if (!publicToken) {
        // Never POSTed: the route reads a missing public token as "mint a new
        // link session", which would loop the borrower back into the widget.
        setPhase({ kind: "idle" });
        setError("That connection did not finish. Try it once more.");
        return;
      }
      void startAssembling(publicToken);
    },
    [startAssembling],
  );

  const handleExit = useCallback(
    (err: PlaidLinkError | null) => {
      if (err?.error_code === "INVALID_LINK_TOKEN" && !remounted.current && fileId) {
        // Aged out while the tab sat open. Not the borrower's problem, and not
        // worth a message — mint a new one and reopen, once.
        remounted.current = true;
        clearAttempt(fileId);
        sessionId.current = null;
        void begin();
        return;
      }
      // Updater form on purpose: a late exit arriving after success must not
      // drag the screen back out of `assembling`.
      setPhase((p) => (p.kind === "linking" ? { kind: "idle" } : p));
      if (!err) {
        // Closing a widget is a person changing their mind. Telling them the
        // connection failed makes them think something is wrong with the bank.
        setNotice("You closed your bank's login. Nothing was sent.");
        return;
      }
      setError(err.display_message ?? "That connection did not go through.");
    },
    [begin, fileId],
  );

  const handleUnavailable = useCallback(() => {
    setPhase({ kind: "idle" });
    setError("We couldn't open your bank connection. Sending statements works just as well.");
    setManualOpen(true);
  }, []);

  /**
   * The credit result, demoted to one line.
   *
   * This used to be a screen of its own: a big number, three bureau scores, a
   * tradeline count, and a Continue button. All the borrower needed from it
   * was "it worked, and it did not hurt your score" — so that is what is left,
   * sitting above whatever they are actually here to do.
   */
  const creditBar = credit?.scores?.length ? (
    <div className="super-notice super-notice-ok mb-5 flex flex-wrap items-center gap-x-3 gap-y-1">
      <span aria-hidden="true" className="text-ok">
        ✓
      </span>
      <span className="text-sm text-ink">
        Credit checked · <span className="super-figure">{middleScore(credit.scores)}</span>
      </span>
      <span className="text-sm text-ink-muted">Soft pull, so your score is untouched.</span>
    </div>
  ) : null;

  if (result) {
    const total = result.accounts.reduce((sum, a) => sum + a.currentBalance, 0);
    const rent = result.identifiedRentPayments;
    return (
      <>
        {creditBar}
        <div className="super-card">
          <h1 className="font-display text-2xl text-ink sm:text-3xl">Here is where you stand</h1>
          <p className="mt-2 text-base text-ink-soft">
            Not an approval and not an offer — a read of your numbers as they are today.
          </p>

          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-rule-soft pt-5 sm:grid-cols-3">
            <Figure
              label={`Verified assets`}
              value={money(total)}
              note={`across ${result.accounts.length} account${result.accounts.length === 1 ? "" : "s"}`}
            />
            <Figure
              label={QUALIFYING_INCOME_LABEL}
              value={
                figures?.totalQualifyingIncome != null
                  ? qualifyingIncome(figures.totalQualifyingIncome)
                  : null
              }
            />
            <Figure
              label="Monthly payment"
              value={figures?.housingPitia != null ? money(figures.housingPitia) : null}
            />
            <Figure
              label="Debt-to-income"
              value={figures?.dtiBack != null ? `${figures.dtiBack}%` : null}
            />
            <Figure label="Loan-to-value" value={figures?.ltv != null ? `${figures.ltv}%` : null} />
          </dl>

          {typeof rent === "number" && rent >= 12 && (
            <p className="super-notice super-notice-ok mt-6 text-base text-ink-soft">
              We found {rent} months of rent paid on time. That counts in your favor, and it is the
              kind of thing a credit score alone would miss.
            </p>
          )}

          <button
            className="super-btn super-btn-primary mt-7"
            onClick={() => navigate(`/f/${fileId}/review`)}
          >
            Continue
          </button>
        </div>
      </>
    );
  }

  const held = fileId && phase.kind === "idle" ? readAttempt(fileId) : null;

  return (
    <>
      {creditBar}
      <div className="super-card">
        <h1 className="font-display text-2xl text-ink sm:text-3xl">Connect your bank</h1>
        <p className="mt-2 text-base text-ink-soft">
          Twelve months, read once. One connection covers your down payment, reserves, income
          deposits, rent history and cash flow.
        </p>
        <p className="mt-3 text-base text-ink-soft">
          It replaces every statement you would otherwise have to find, download and upload.
        </p>

        {phase.kind === "opening" && (
          <Working
            steps={OPENING_STEPS}
            note="This is the longest step, and the last one you have to do anything for."
          />
        )}

        {phase.kind === "linking" && (
          <>
            <p className="super-notice mt-6 text-base text-ink-soft">
              Your bank is open in a secure window. Sign in there and we&rsquo;ll take it from here.
            </p>
            <PlaidLink
              key={phase.linkToken}
              token={phase.linkToken}
              onSuccess={handleSuccess}
              onExit={handleExit}
              onUnavailable={handleUnavailable}
            />
          </>
        )}

        {phase.kind === "assembling" && (
          <Working
            steps={ASSEMBLING_STEPS}
            note={
              reassure
                ? "Still going. Twelve months is a lot of history, and some banks are slower than others."
                : "This is the longest step, and the last one you have to do anything for."
            }
          />
        )}

        {phase.kind === "slow" && (
          <div className="super-notice super-notice-warn mt-6">
            <p className="text-base text-ink-soft">
              Your bank connected. Building twelve months of history is taking longer than usual —
              nothing is wrong, and you don&rsquo;t have to wait here.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                className="super-btn super-btn-primary"
                onClick={() => navigate(`/f/${fileId}/review`)}
              >
                Carry on
              </button>
              <button
                className="super-btn super-btn-outline"
                onClick={() => {
                  attempts.current = 0;
                  setPhase({ kind: "assembling" });
                  void poll();
                }}
              >
                Check again
              </button>
            </div>
          </div>
        )}

        {phase.kind === "idle" && (
          <>
            {notice && <p className="mt-6 text-sm text-ink-muted">{notice}</p>}
            <button
              className="super-btn super-btn-primary mt-6"
              onClick={() => void begin()}
              disabled={readOnly}
            >
              {held ? "Open your bank login" : "Connect your bank"}
            </button>
            <Why>
              We read your transactions once, to verify what you have and what you earn. We cannot
              move money, and we do not keep your bank password — you sign in with your bank, not
              with us.
            </Why>
          </>
        )}

        {readOnly && (
          <p className="mt-4 text-sm text-ink-muted">
            This is a sample file, so there is nothing to connect.
          </p>
        )}
        {error && (
          <div className="mt-4">
            <p className="text-sm text-danger">{error}</p>
            {recovery && (
              <button
                className="super-btn super-btn-outline mt-3"
                onClick={() => navigate(recovery.to)}
              >
                {recovery.label}
              </button>
            )}
          </div>
        )}

        {/*
        The escape hatch, for when the bank connection will not go.

        Deliberately quiet — one line under the primary action, not a
        side-by-side choice. Connecting is better for the borrower in every
        way (faster, and it verifies things a PDF cannot), so offering both
        with equal weight would push people towards the worse path.

        Kept visible while a report assembles, with the label changed. Those
        are the minutes a borrower is most likely to want a way out, and
        hiding the hatch for exactly that stretch is the wrong moment to be
        quiet. Hidden only while their bank's own window is open, where a
        second choice on our page is noise behind a modal.

        STUB: the files are listed and nothing is sent. Wiring the ingest is
        Joe's, and it needs a real decision about where the bytes go — the
        existing document endpoint deliberately never transmits them.
      */}
        {phase.kind !== "linking" && (
          <div className="mt-6 border-t border-rule-soft pt-4">
            {manualOpen ? (
              <>
                <p className="text-base text-ink-soft">
                  Upload the last twelve months of statements for any account you would use for the
                  deposit or your income. Select as many files as you like.
                </p>
                <input
                  type="file"
                  multiple
                  className="mt-3 block w-full text-sm text-ink-soft file:mr-3 file:rounded-pill file:border file:border-rule file:bg-raised file:px-4 file:py-2 file:text-sm file:text-ink-soft"
                  onChange={(e) =>
                    setStatements(Array.from(e.target.files ?? []).map((f) => f.name))
                  }
                />
                {statements.length > 0 && (
                  <>
                    <ul className="mt-3 flex flex-col gap-1">
                      {statements.map((name) => (
                        <li key={name} className="text-sm text-ink-soft">
                          {name}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-3 text-sm text-ok">
                      Got them — {statements.length} file{statements.length === 1 ? "" : "s"}. It
                      takes longer than connecting, so if the connection starts working, use that
                      instead.
                    </p>
                  </>
                )}
              </>
            ) : (
              <button
                type="button"
                className="super-link-quiet text-sm"
                onClick={() => setManualOpen(true)}
              >
                {busy
                  ? "Rather not wait? Upload statements instead"
                  : "Bank won’t connect? Upload statements instead"}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** Middle of three bureau scores, which is the one a lender uses. */
function middleScore(scores: { score: number }[]): number {
  const sorted = scores.map((s) => s.score).sort((a, b) => a - b);
  return (sorted.length >= 3 ? sorted[1] : sorted[0]) ?? 0;
}
