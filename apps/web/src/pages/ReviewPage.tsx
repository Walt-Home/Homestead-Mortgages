/**
 * Screen 4 — review and submit, then whichever answer the file actually got.
 *
 * Two things: the fair-lending questions, and a signature.
 *
 * **Why there is no longer a "this is correct" checkbox.** The five derived
 * declarations are URLA Section 5 — a required borrower attestation, which is
 * why they cannot simply be asserted by us from the credit file. But the
 * attestation rides on the *signature*, the way it does on paper. A separate
 * checkbox in front of the signature added no legal weight and added a place
 * to stop, which on the last screen of a five-minute flow is the most
 * expensive place to put one. They are still shown, in full, above the
 * signature — that part is not optional.
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
import { branchesFor } from "../lib/flow.js";
import { endingFor, proposedTerms } from "../lib/endings.js";
import {
  ADVERSE_COPY,
  COUNTEROFFER_COPY,
  ENDING_COPY,
  REFERRED_COPY,
  SIGN_LEAD,
} from "../lib/outcomes.js";
import type { Assessment } from "../lib/api.js";
import type { DecisionOutcome } from "@hm/shared";

interface Declaration {
  readonly clean: string;
  readonly source: string;
  readonly flagged: boolean;
  readonly question: string;
}

interface Ratios {
  housingPitia: number | null;
  dtiBack: number | null;
  ltv: number | null;
  totalQualifyingIncome: number | null;
}

/**
 * The part of the stored decision this screen reads. `outcome` is the word the
 * engine reached, and it — not the arithmetic — decides which ending renders.
 */
interface DecisionView {
  outcome: DecisionOutcome;
  ratios: Ratios;
  adverseActionReasons?: string[];
}

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

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

  const [answers, setAnswers] = useState<Record<string, string>>({});
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
  const decision = file?.decision as DecisionView | null | undefined;
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

  const declarations = buildDeclarations(file);
  const flagged = declarations.filter((d) => d.flagged);

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
   * the pre-signature view.
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

  const done = (
    <button className="super-btn super-btn-outline mt-7" onClick={() => navigate("/")}>
      Done
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
            <Figure label="Verified income" value={`${money(ratios.totalQualifyingIncome)}/mo`} />
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
        <p className="mt-2 text-base text-ink-soft">Here is what we found. Signing confirms it.</p>

        <div className="mt-7 border-t border-rule-soft pt-5">
          <ul className="flex flex-col gap-2">
            {declarations
              .filter((d) => !d.flagged)
              .map((d) => (
                <li key={d.clean} className="flex items-start justify-between gap-4 text-base">
                  <span className="flex items-start gap-2.5 text-ink-soft">
                    <span aria-hidden="true" className="mt-0.5 text-ok">
                      ✓
                    </span>
                    {d.clean}
                  </span>
                  <span className="shrink-0 text-xs text-ink-faint">{d.source}</span>
                </li>
              ))}
          </ul>
        </div>

        {flagged.length > 0 && (
          <div className="super-notice mt-6">
            <p className="text-sm font-medium text-ink">
              {flagged.length === 1
                ? "One thing we need to ask about"
                : "A couple of things to ask about"}
            </p>
            {flagged.map((d) => (
              <div key={d.clean} className="mt-3">
                <label className="super-label" htmlFor={`q-${d.clean}`}>
                  {d.question}
                </label>
                <input
                  id={`q-${d.clean}`}
                  className="super-input"
                  value={answers[d.clean] ?? ""}
                  onChange={(e) => setAnswers((a) => ({ ...a, [d.clean]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        )}

        {primaryResidence && (
          <DemographicQuestions value={demographics} onChange={setDemographics} />
        )}

        {error && <p className="mt-4 text-sm text-danger">{error}</p>}

        <div className="mt-7 border-t border-rule-soft pt-6">
          {readyToSign ? (
            <div className="super-notice">
              <p className="font-display text-base text-ink">Your application</p>
              <p className="mt-2 text-base text-ink-soft">
                This is the application itself — the property, the loan, your details and the
                declarations above. It also includes IRS Form 4506-C, which lets us request your tax
                records directly rather than asking you to find them.
              </p>
              <p className="mt-2 text-base text-ink-soft">
                Signing submits it. It does not commit you to borrowing anything, and it is not an
                agreement to any particular rate or terms.
              </p>
              <button
                className="super-btn super-btn-primary mt-4"
                onClick={() => void finishSubmission()}
                disabled={readOnly}
              >
                Sign and submit
              </button>
            </div>
          ) : (
            <>
              <button
                className="super-btn super-btn-primary"
                onClick={() => void saveAndContinue()}
                disabled={!demographicsAnswered || saving || readOnly}
              >
                {saving ? "Saving…" : "Continue to sign"}
              </button>
              {!demographicsAnswered && (
                <p className="mt-2 text-xs text-ink-faint">
                  Answer the three questions above, or decline them, to continue.
                </p>
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

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm text-ink-faint">{label}</dt>
      <dd className="super-figure mt-1 text-2xl text-ink">{value}</dd>
    </div>
  );
}

/**
 * The five declarations, built from data rather than asked.
 *
 * Each defaults to its clean form and flips to a question only when the
 * underlying retrieval actually found something. A source that has not run yet
 * leaves the declaration clean — we are stating what we found, and finding
 * nothing because we did not look is not a finding against the borrower.
 */
function buildDeclarations(file: unknown): Declaration[] {
  const f = file as
    | {
        credit?: { publicRecords?: { type: string }[] } | null;
        lienSearch?: {
          delinquentFederalDebt: boolean;
          foreclosureOrShortSaleInHistory: boolean;
        } | null;
        assets?: { borrowedFunds?: unknown[] } | null;
        propertyRecord?: { priorOwnershipInLastThreeYears: boolean } | null;
      }
    | undefined;

  const publicRecords = f?.credit?.publicRecords ?? [];
  const hasBankruptcy = publicRecords.some((r) => r.type?.includes("bankruptcy"));
  const hasForeclosure =
    publicRecords.some((r) => r.type?.includes("foreclosure")) ||
    Boolean(f?.lienSearch?.foreclosureOrShortSaleInHistory);

  return [
    {
      clean: "No bankruptcy in the last 7 years",
      source: "credit",
      flagged: hasBankruptcy,
      question: "We found a bankruptcy on your record. When was it discharged?",
    },
    {
      clean: "No foreclosure or short sale",
      source: "credit, property records",
      flagged: hasForeclosure,
      question: "We found a foreclosure or short sale. What happened, and when?",
    },
    {
      clean: "No delinquent federal debt",
      source: "lien search",
      flagged: Boolean(f?.lienSearch?.delinquentFederalDebt),
      question:
        "The lien search found a federal debt in your name. Is it on a repayment plan, and with whom?",
    },
    {
      clean: "No undisclosed borrowed funds",
      source: "bank activity",
      flagged: Boolean(f?.assets?.borrowedFunds?.length),
      question: "Some of your deposit looks borrowed. Where did it come from?",
    },
    {
      clean: "No prior ownership interest in the last 3 years",
      source: "property records",
      flagged: Boolean(f?.propertyRecord?.priorOwnershipInLastThreeYears),
      question: "Property records show you have owned a home recently. Do you still own it?",
    },
  ];
}
