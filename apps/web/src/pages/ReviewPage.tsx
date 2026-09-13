/**
 * Screen 5 — review and submit, then whichever answer the file actually got.
 *
 * Two things: the fair-lending questions, and a signature.
 *
 * **Why there is no separate "this is correct" checkbox.** URLA Section 5 is a
 * required borrower attestation, and the attestation rides on the *signature*,
 * the way it does on paper. A separate checkbox in front of the signature adds
 * no legal weight and adds a place to stop, which on the last screen of a
 * five-minute flow is the most expensive place to put one. The answers are
 * still shown, in full, above the signature — that part is not optional, and
 * the rationale only holds because they are the borrower's OWN answers now.
 * This screen used to build five of them out of a credit report, a lien
 * search, an asset report and a county record, which meant a checkbox or a
 * signature attesting to our inference; screen 3 asks the questions, and this
 * block reads back what was stored.
 *
 * Which is also why this screen refuses the signature until screen 3 has been
 * answered. With nothing stored, the panel's words attest to a statement the
 * borrower never made — the same defect as the derived declarations, with the
 * inference removed and nothing put in its place.
 *
 * **The ending is chosen by the outcome and the state, never by the
 * arithmetic.** `endings.ts` holds the rule and `outcomes.ts` holds the words;
 * this file only renders them. A borrower whose file was decided reads the
 * decision, a borrower whose file ended reads its history, and only a file
 * that is genuinely approved and still pre-approval gets a Loan Estimate.
 * Nothing lands on "we'll be in touch" because a number failed to compute.
 *
 * Demographics render only for a primary residence. Regulation B applies to a
 * principal residence, and collecting when it is not required is itself a
 * violation — so the occupancy check is a compliance control, not tidiness.
 */

import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.js";
import { PERSONA_READ_ONLY, useAuth } from "../lib/auth.js";
import { useLoanFile } from "../lib/file.js";
import {
  DemographicQuestions,
  type DemographicAnswers,
} from "../components/DemographicQuestions.js";
import { ApplicationStanding } from "../components/ApplicationStanding.js";
import { ApplicationTimeline } from "../components/ApplicationTimeline.js";
import { Branches } from "../components/Branches.js";
import { Working } from "../components/Working.js";
import { Figure } from "../components/Figure.js";
import { money, qualifyingIncome, QUALIFYING_INCOME_LABEL } from "../lib/figures.js";
import { branchesFor } from "../lib/flow.js";
import { endingFor, proposedTerms } from "../lib/endings.js";
import {
  ADVERSE_COPY,
  COUNTEROFFER_COPY,
  ENDING_COPY,
  REFERRED_COPY,
  SIGNING_COPY,
  SIGN_LEAD,
} from "../lib/outcomes.js";
import { answerLines, type AnswerLine } from "../lib/declarations.js";
import type { Assessment } from "../lib/api.js";

/**
 * The one refusal this screen re-words rather than passing through.
 *
 * Every other failure here is already a sentence a person can read. A sample
 * borrower's is not about what they typed, so it says what it is about.
 */
function refusal(err: unknown): string | null {
  return err instanceof ApiError && err.code === "PERSONA_READ_ONLY" ? PERSONA_READ_ONLY : null;
}

export function ReviewPage({ assessment }: { assessment?: Assessment }) {
  const { fileId } = useParams<{ fileId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useLoanFile(fileId);
  const file = data?.file;
  const { user } = useAuth();
  /*
   * Read-only for two different reasons, and either is enough.
   *
   * The file is a sample one, shared with everybody — or the session is a
   * sample borrower, which is refused every write on any file at all. The
   * buttons on this screen are the last ones in the flow, so a persona that
   * reached them with them enabled would sign something it cannot sign.
   */
  const readOnly = file?.isDemo === true || user?.persona != null;

  const [demographics, setDemographics] = useState<DemographicAnswers>({
    ethnicity: [],
    race: [],
    sex: "",
    visualObservationNoted: false,
  });
  const [saving, setSaving] = useState(false);
  const [readyToSign, setReadyToSign] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intentSaving, setIntentSaving] = useState(false);

  // One source of truth for "this application is signed": the column the
  // server sets in /sign-application. There is deliberately no parallel
  // consent kind for it.
  const signed = Boolean(file?.applicationSignedAt);
  const intentRecorded = Boolean(file?.intentToProceedAt);
  const primaryResidence = file?.property?.occupancy === "primary_residence";
  // What the borrower answered on screen 3, read back. Null is unasked, which
  // is why the block below says so rather than rendering an empty list.
  const declaration = file?.declaration ?? null;
  const residences = file?.residences ?? [];
  // What the signature says is true. One POST writes the declaration and the
  // residences together, so a file has both or neither — and the gate is the
  // declaration rather than the line count below, because a residence on its
  // own would make that count non-zero while Section 5 went unanswered.
  const declared = declaration != null;
  const decision = file?.decision;
  const ratios = decision?.ratios;
  const payrollLinked = file?.payroll != null;
  const branches = branchesFor(assessment, payrollLinked);
  // Undefined until the file has been read, null once it has been read and
  // there is none — the same three-state value the header renders.
  const standing = data ? (data.applicationState ?? null) : undefined;

  /**
   * Make sure a decision exists before deciding what to render.
   *
   * The bank screen computes one, but a borrower can arrive here by a resumed
   * URL, a back button, or a branch they just finished — and a missing
   * decision would render as "we'll get back to you" when the truth is that
   * nobody has asked the engine yet. Landing on the worst of three outcomes
   * because of a stale cache is the failure this prevents.
   */
  useEffect(() => {
    if (!fileId || !file || decision || readOnly) return;
    let cancelled = false;
    void api
      .post(`/files/${fileId}/decision`, {})
      .then(() => {
        if (!cancelled) void queryClient.invalidateQueries({ queryKey: ["file", fileId] });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [fileId, file, decision, readOnly, queryClient]);

  /**
   * Answered, or explicitly declined. An untouched form is neither: saving
   * empty arrays records "not requested", which is a false statement about a
   * real person on a requirement whose failure severity is a regulatory
   * violation. Easy to decline is the design goal; declined by default is a
   * fabricated answer.
   */
  const demographicsAnswered =
    !primaryResidence ||
    ((demographics.ethnicity === "declined" || demographics.ethnicity.length > 0) &&
      (demographics.race === "declined" || demographics.race.length > 0) &&
      demographics.sex !== "");

  async function saveAndContinue() {
    // Not merely the button's disabled attribute. This is the one function
    // that opens the signing panel, and the panel's words say the answers
    // above are true and complete — so an unanswered file must not be able to
    // reach it by any route, including a stale render.
    if (!declared) return;
    if (!fileId || !file?.borrowers[0]) return;
    setSaving(true);
    setError(null);
    const b = file.borrowers[0];
    try {
      await api.post(`/files/${fileId}/borrowers`, {
        firstName: b.firstName,
        lastName: b.lastName,
        email: b.email,
        phone: b.phone,
        dateOfBirth: b.dateOfBirth,
        currentAddress: b.currentAddress,
        maritalStatus: b.maritalStatus,
        citizenship: b.citizenship ?? null,
        preferredLanguage: "en",
        firstTimeHomebuyer: b.firstTimeHomebuyer ?? true,
        currentHousing: b.currentHousing,
        monthlyRent: b.monthlyRent,
        demographics: primaryResidence
          ? {
              ethnicity:
                demographics.ethnicity === "declined" ? "declined" : demographics.ethnicity,
              race: demographics.race === "declined" ? "declined" : demographics.race,
              sex: demographics.sex === "" ? "declined" : demographics.sex,
              visualObservationNoted: false,
            }
          : null,
        // No income restated here, and none invented.
        //
        // This screen re-sends the borrower it already has so the demographics
        // can join them; it asks for no figure and knows none. A placeholder
        // would supersede the income screen 1 recorded about a real person and
        // then stamp the receipt with the placeholder. Absent, the server
        // reads the fact already on record.
      });
      await queryClient.invalidateQueries({ queryKey: ["file", fileId] });
      setReadyToSign(true);
    } catch (err) {
      setError(refusal(err) ?? (err instanceof Error ? err.message : "Could not save."));
    } finally {
      setSaving(false);
    }
  }

  /**
   * After the signature: the 4506-C, the transcripts, and a recompute.
   *
   * The sheet makes the 4506-C universal (INC-008) and two years of W-2s a
   * wage-earner requirement (INC-003), both sourced from the IRS. Neither
   * needs the borrower to type anything — one is a signature, one is a pull we
   * can make once that signature exists — so the one signature on this screen
   * covers both, disclosed as such in the signing panel.
   */
  async function finishSubmission() {
    if (!fileId) return;
    setFinishing(true);
    try {
      // Signs the application and the 4506-C together, pulls the transcripts
      // and advances the stage — all server-side.
      await api.post(`/files/${fileId}/sign-application`, {});
      await api.post(`/files/${fileId}/decision`, {}).catch(() => undefined);
    } catch {
      // The application is signed either way. What follows is our work, and a
      // failure in it changes which ending renders, not whether
      // the borrower is done.
    } finally {
      setFinishing(false);
      await queryClient.invalidateQueries({ queryKey: ["file", fileId] });
      await queryClient.invalidateQueries({ queryKey: ["assessment"] });
    }
  }

  async function recordIntent() {
    if (!fileId) return;
    setIntentSaving(true);
    try {
      await api.post(`/files/${fileId}/intent-to-proceed`, {});
      await queryClient.invalidateQueries({ queryKey: ["file", fileId] });
    } catch (err) {
      setError(refusal(err) ?? (err instanceof Error ? err.message : "That did not save."));
    } finally {
      setIntentSaving(false);
    }
  }

  if (finishing) {
    return (
      <div className="super-card">
        <h1 className="font-display text-2xl text-ink sm:text-3xl">Putting it together</h1>
        <Working
          steps={[
            { label: "Recording your signature", ms: 900 },
            { label: "Requesting your tax records", ms: 1800 },
            { label: "Working out your Loan Estimate", ms: 2200 },
          ]}
        />
      </div>
    );
  }

  /*
   * Where the file stands, and how it got there — above every ending and above
   * the pre-signature view, and the only copy of it on this route. The shell
   * renders the standing in its header on every other screen and skips this
   * one, which is what lets the view below replace a line the state cannot get
   * right without a second, un-replaced copy contradicting it from above.
   *
   * The order is the point. The endings on this screen are long, and the shell
   * header scrolls away, so a borrower reading "Your Loan Estimate" has to be
   * able to see what state the application is actually in without going back
   * up. The timeline follows it for the same reason: the ending says where the
   * file landed, this says how it got there, in the borrower's own words, from
   * the ledger the database wrote. It is the same rows an examiner reads —
   * which is the point: there is no second, friendlier record kept alongside
   * the real one.
   */
  const header = (
    <>
      <ApplicationStanding standing={standing} />
      <ApplicationTimeline standing={standing} />
    </>
  );

  /*
   * The same header, with the one line the state cannot say.
   *
   * Before the signature the application is `in_underwriting` — the decision
   * is posted on the bank screen before it navigates here, and this screen
   * posts one itself if it arrives without one — so the heading beside the
   * pill reads "Being decided", directly above the button asking for the
   * signature that would let it be. A file still owing a branch reads
   * `awaiting_borrower` and names the branch. Nothing in the ledger can fix
   * either from below: `esign` is deliberately outside the obligations the
   * flow tracks, so no state ever reads "Needs you" for a missing signature.
   * The pill and the date are still the state's; only the heading is rendered
   * here, and only it belongs to this view.
   */
  const signingHeader = (
    <>
      <ApplicationStanding standing={standing} headline={SIGN_LEAD} />
      <ApplicationTimeline standing={standing} />
    </>
  );

  // Named for where it goes, not for the reader being finished. "Done" on the
  // screen that says we cannot approve the loan is the product congratulating
  // somebody on an ending they did not choose, and it landed on the marketing
  // page — which is the one page a person who has just been declined has no
  // reason to see.
  const done = (
    <button className="super-btn super-btn-outline mt-7" onClick={() => navigate("/")}>
      Back to your applications
    </button>
  );

  /* ── The endings ──────────────────────────────────────────────────────── */

  const ending = endingFor({
    signed,
    outcome: decision?.outcome ?? null,
    state: standing ?? null,
    ratios: ratios ?? null,
    branches,
  });

  /*
   * An application that has ended, or has moved past a decision, is its own
   * ending: the pill, the state's heading and the history, and nothing else.
   * The header already renders all three, which is why there is no copy here —
   * a second heading beside the first would be the screen and the state
   * catalog disagreeing about what happened.
   */
  if (ending === "state") {
    return (
      <div className="super-card">
        {header}
        {done}
      </div>
    );
  }

  if (ending === "referred") {
    return (
      <div className="super-card">
        {header}
        <h1 className="mt-6 font-display text-2xl text-ink sm:text-3xl">
          {REFERRED_COPY.headline}
        </h1>
        <p className="mt-2 text-base text-ink-soft">{REFERRED_COPY.body}</p>
        {done}
      </div>
    );
  }

  if (ending === "adverse") {
    const reasons = decision?.adverseActionReasons ?? [];
    return (
      <div className="super-card">
        {header}
        <h1 className="mt-6 font-display text-2xl text-ink sm:text-3xl">{ADVERSE_COPY.headline}</h1>
        <p className="mt-2 text-base text-ink-soft">{ADVERSE_COPY.body}</p>
        <Reasons reasons={reasons} lead={ADVERSE_COPY.reasonsLead} none={ADVERSE_COPY.noReasons} />
        {done}
      </div>
    );
  }

  if (ending === "counteroffer") {
    // Not `standing.scenario`: the active scenario is usually the loan the
    // borrower asked for, and that one is not an alternative to itself.
    const scenario = proposedTerms(standing?.scenario);
    return (
      <div className="super-card">
        {header}
        <h1 className="mt-6 font-display text-2xl text-ink sm:text-3xl">
          {COUNTEROFFER_COPY.headline}
        </h1>
        <p className="mt-2 text-base text-ink-soft">{COUNTEROFFER_COPY.body}</p>
        {scenario ? (
          <>
            {/* The promise of terms lives with the terms, so a counteroffer
                with none never announces them and then shows nothing. */}
            <p className="mt-4 text-base text-ink-soft">{COUNTEROFFER_COPY.termsLead}</p>
            <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-rule-soft pt-5 sm:grid-cols-3">
              <Figure label={COUNTEROFFER_COPY.loanAmount} value={money(scenario.loanAmount)} />
              <Figure label={COUNTEROFFER_COPY.downPayment} value={money(scenario.downPayment)} />
              {scenario.valueEstimate != null && (
                <Figure
                  label={COUNTEROFFER_COPY.propertyValue}
                  value={money(scenario.valueEstimate)}
                />
              )}
            </dl>
          </>
        ) : (
          <p className="mt-4 text-base text-ink-soft">{COUNTEROFFER_COPY.noTerms}</p>
        )}
        <Reasons
          reasons={decision?.adverseActionReasons ?? []}
          lead={COUNTEROFFER_COPY.reasonsLead}
          none={COUNTEROFFER_COPY.noReasons}
        />
        {done}
      </div>
    );
  }

  if (ending === "estimate" && ratios) {
    return (
      <div className="super-card">
        {header}
        <h1 className="mt-6 font-display text-2xl text-ink sm:text-3xl">Your Loan Estimate</h1>
        <p className="mt-2 text-base text-ink-soft">{ENDING_COPY.estimateLead}</p>

        <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-rule-soft pt-5 sm:grid-cols-4">
          <Figure label="Monthly payment" value={money(ratios.housingPitia!)} />
          <Figure label="Debt-to-income" value={`${ratios.dtiBack}%`} />
          {ratios.ltv != null && <Figure label="Loan-to-value" value={`${ratios.ltv}%`} />}
          {ratios.totalQualifyingIncome != null && (
            <Figure
              label={QUALIFYING_INCOME_LABEL}
              value={qualifyingIncome(ratios.totalQualifyingIncome)}
            />
          )}
        </dl>

        <p className="mt-5 text-xs text-ink-faint">
          Computed by our own underwriting engine, not by a Fannie Mae submission. A real agency
          submission may reach a different answer.
        </p>

        <div className="mt-7 border-t border-rule-soft pt-6">
          {intentRecorded ? (
            <p className="text-base text-ink-soft">{ENDING_COPY.intentRecorded}</p>
          ) : (
            <>
              <p className="text-base text-ink-soft">
                Take your time with it. When you are ready, tell us to go ahead.
              </p>
              <button
                className="super-btn super-btn-primary mt-4"
                onClick={() => void recordIntent()}
                disabled={intentSaving || readOnly}
              >
                {intentSaving ? "Saving…" : "Yes, proceed"}
              </button>
              <p className="mt-2 text-xs text-ink-faint">
                Saying yes is not a commitment to borrow. It lets us keep working.
              </p>
            </>
          )}
        </div>

        {done}
      </div>
    );
  }

  if (ending === "branches") {
    return (
      <div className="super-card">
        {header}
        <h1 className="mt-6 font-display text-2xl text-ink sm:text-3xl">
          Almost — we need one more thing
        </h1>
        <p className="mt-2 text-base text-ink-soft">
          Your application is in. We could not finish your Loan Estimate without{" "}
          {branches.length === 1 ? "this" : "these"}, and it is quick.
        </p>

        <ul className="mt-6 flex flex-col gap-3 border-t border-rule-soft pt-5">
          {branches.map((branch) => (
            <li
              key={branch.path}
              className="flex flex-col gap-2 rounded-md border border-rule-soft bg-raised p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="text-base font-medium text-ink">{branch.title}</p>
                <p className="mt-0.5 text-sm text-ink-soft">{branch.because}</p>
              </div>
              <Link
                to={`/f/${fileId}/${branch.path}`}
                className="super-btn super-btn-primary shrink-0 text-center"
              >
                Add this
              </Link>
            </li>
          ))}
        </ul>

        <p className="mt-6 text-sm text-ink-muted">{ENDING_COPY.branchesNote}</p>
      </div>
    );
  }

  if (ending !== null) {
    return (
      <div className="super-card">
        {header}
        <h1 className="mt-6 font-display text-2xl text-ink sm:text-3xl">
          That is everything we need
        </h1>
        <p className="mt-2 text-base text-ink-soft">{ENDING_COPY.oursLead}</p>
        {done}
      </div>
    );
  }

  /* ── Before signing ───────────────────────────────────────────────────── */

  return (
    <>
      <Branches assessment={assessment} fileId={fileId} payrollLinked={payrollLinked} />

      <div className="super-card">
        {signingHeader}
        <h1 className="mt-6 font-display text-2xl text-ink sm:text-3xl">Nearly done</h1>
        <p className="mt-2 text-base text-ink-soft">{SIGNING_COPY.lead}</p>

        <YourAnswers
          lines={answerLines(declaration, residences)}
          to={`/f/${fileId}/declarations`}
        />

        {primaryResidence && (
          <DemographicQuestions value={demographics} onChange={setDemographics} />
        )}

        {error && <p className="mt-4 text-sm text-danger">{error}</p>}

        <div className="mt-7 border-t border-rule-soft pt-6">
          {readyToSign ? (
            <div className="super-notice">
              <p className="font-display text-base text-ink">{SIGNING_COPY.panelTitle}</p>
              <p className="mt-2 text-base text-ink-soft">{SIGNING_COPY.panelBody}</p>
              <p className="mt-2 text-base text-ink-soft">{SIGNING_COPY.panelTerms}</p>
              <button
                className="super-btn super-btn-primary mt-4"
                onClick={() => void finishSubmission()}
                disabled={readOnly}
              >
                {SIGNING_COPY.signButton}
              </button>
            </div>
          ) : (
            <>
              <button
                className="super-btn super-btn-primary"
                onClick={() => void saveAndContinue()}
                disabled={!declared || !demographicsAnswered || saving || readOnly}
              >
                {saving ? "Saving…" : "Continue to sign"}
              </button>
              {/*
                The declarations first, because that is the one a borrower
                cannot fix on this screen — the way out is the link in the
                block above, which is why the sentence sits under a disabled
                button rather than replacing it.
              */}
              {!declared ? (
                <p className="mt-2 text-xs text-ink-faint">{SIGNING_COPY.unanswered}</p>
              ) : (
                !demographicsAnswered && (
                  <p className="mt-2 text-xs text-ink-faint">
                    Answer the three questions above, or decline them, to continue.
                  </p>
                )
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * The reasons the engine recorded, under either ending that owes them.
 *
 * Both bodies tell the borrower they are owed the specific reasons — the
 * decline because a written notice is coming, the counteroffer because turning
 * it down still earns them — and the engine records reasons on both. One
 * component, so an ending cannot promise them and then quietly render nothing.
 */
function Reasons({
  reasons,
  lead,
  none,
}: {
  reasons: readonly string[];
  lead: string;
  none: string;
}) {
  return (
    <div className="mt-6 border-t border-rule-soft pt-5">
      {reasons.length > 0 ? (
        <>
          <p className="text-base text-ink-soft">{lead}</p>
          <ul className="mt-3 flex flex-col gap-2">
            {reasons.map((reason) => (
              <li key={reason} className="text-base text-ink-soft">
                {reason}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-base text-ink-soft">{none}</p>
      )}
    </div>
  );
}

/**
 * The borrower's own answers, read back above the signature.
 *
 * Every line is something a person typed on screen 3. Nothing on this path
 * reads a connector: the list this replaced was built from a credit report, a
 * lien search, an asset report and a county record, so a file whose pulls had
 * not run showed five clean declarations above a signature — absence of
 * evidence rendered as the borrower's statement.
 */
function YourAnswers({ lines, to }: { lines: readonly AnswerLine[]; to: string }) {
  if (lines.length === 0) {
    // The sentence needs somewhere to go. It names work the borrower has to
    // do on another screen, and without the link the only thing on this one
    // that reacts to it is a button that is now refusing to be pressed.
    return (
      <div className="mt-7">
        <p className="text-base text-ink-soft">{SIGNING_COPY.unanswered}</p>
        <Link to={to} className="super-link-quiet mt-2 inline-block text-sm">
          {SIGNING_COPY.answerThem}
        </Link>
      </div>
    );
  }
  return (
    <div className="mt-7 border-t border-rule-soft pt-5">
      <p className="font-display text-base text-ink">{SIGNING_COPY.heading}</p>
      <dl className="mt-4 flex flex-col gap-3">
        {lines.map((line) => (
          <div key={line.prompt} className="flex flex-col gap-0.5">
            <dt className="text-sm text-ink-muted">{line.prompt}</dt>
            <dd className="text-base text-ink-soft">
              {line.answer}
              {line.explanation && (
                <span className="mt-0.5 block text-sm text-ink-muted">{line.explanation}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <Link to={to} className="super-link-quiet mt-4 inline-block text-sm">
        {SIGNING_COPY.change}
      </Link>
    </div>
  );
}
