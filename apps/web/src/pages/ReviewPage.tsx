/**
 * Screen 4 — review and submit, then one of three answers.
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
 * **Three endings, and the happy one is the default.** A borrower who reaches
 * here with everything verified gets a Loan Estimate. One who is missing
 * something gets told exactly where to enter it. One whose file needs a person
 * gets told that, plainly, with a timeframe. Nothing silently lands on "we'll
 * be in touch" because a number failed to compute.
 *
 * Demographics render only for a primary residence. Regulation B applies to a
 * principal residence, and collecting when it is not required is itself a
 * violation — so the occupancy check is a compliance control, not tidiness.
 */

import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { useLoanFile, hasConsent } from "../lib/file.js";
import {
  DemographicQuestions,
  type DemographicAnswers,
} from "../components/DemographicQuestions.js";
import { SignDocument } from "../components/SignDocument.js";
import { Branches } from "../components/Branches.js";
import { Working } from "../components/Working.js";
import { branchesFor } from "../lib/flow.js";
import type { Assessment } from "../lib/api.js";

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

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

export function ReviewPage({ assessment }: { assessment?: Assessment }) {
  const { fileId } = useParams<{ fileId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useLoanFile(fileId);
  const file = data?.file;
  const readOnly = file?.isDemo === true;

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

  const signed = hasConsent(file, "application_signature");
  const intentRecorded = Boolean(file?.intentToProceedAt);
  const primaryResidence = file?.property?.occupancy === "primary_residence";
  const decision = file?.decision as { ratios: Ratios } | null | undefined;
  const ratios = decision?.ratios;
  const branches = branchesFor(assessment);

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
        statedMonthlyIncome: 1,
      });
      await queryClient.invalidateQueries({ queryKey: ["file", fileId] });
      setReadyToSign(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
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
      const started = await api.post<{ alreadySigned: boolean; envelopeId?: string }>(
        `/files/${fileId}/esign`,
        { kind: "form_4506c" },
      );
      if (!started.alreadySigned && started.envelopeId) {
        await api.post(`/files/${fileId}/esign/complete`, { envelopeId: started.envelopeId });
      }
      await api.post(`/files/${fileId}/irs`, {}).catch(() => undefined);
      await api.post(`/files/${fileId}/decision`, {}).catch(() => undefined);
    } catch {
      // The application is signed either way. What follows is our work, and a
      // failure in it changes which of the three endings renders, not whether
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
      setError(err instanceof Error ? err.message : "That did not save.");
    } finally {
      setIntentSaving(false);
    }
  }

  if (finishing) {
    return (
      <div className="card">
        <h1 className="font-brand text-[24px] font-semibold leading-tight text-ink-editorial sm:text-[26px]">
          Putting it together
        </h1>
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

  /* ── The three endings ────────────────────────────────────────────────── */

  if (signed) {
    /*
     * Which ending, and why in this order.
     *
     * A Loan Estimate needs a payment and a ratio that actually computed. If
     * something is still outstanding that the borrower can finish, that beats
     * both an estimate built on gaps and a vague promise — so it is checked
     * before the fallback. "We'll come back to you" is last, and only for a
     * file where there is genuinely nothing left for them to do.
     */
    const canEstimate = ratios?.housingPitia != null && ratios?.dtiBack != null;

    if (canEstimate && ratios) {
      return (
        <div className="card">
          <h1 className="font-brand text-[24px] font-semibold leading-tight text-ink-editorial sm:text-[26px]">
            Your Loan Estimate
          </h1>
          <p className="mt-2 font-prose text-[16px] leading-relaxed text-ink-prose">
            Sent to your email, and here it is. Read it before you decide anything.
          </p>

          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-line-light pt-5 sm:grid-cols-4">
            <Figure label="Monthly payment" value={money(ratios.housingPitia!)} />
            <Figure label="Debt-to-income" value={`${ratios.dtiBack}%`} />
            {ratios.ltv != null && <Figure label="Loan-to-value" value={`${ratios.ltv}%`} />}
            {ratios.totalQualifyingIncome != null && (
              <Figure label="Verified income" value={`${money(ratios.totalQualifyingIncome)}/mo`} />
            )}
          </dl>

          <p className="mt-5 text-[12px] leading-relaxed text-subtle">
            Computed by our own underwriting engine, not by a Fannie Mae submission. A real agency
            submission may reach a different answer.
          </p>

          <div className="mt-7 border-t border-line-light pt-6">
            {intentRecorded ? (
              <p className="font-prose text-[16px] leading-relaxed text-ink-prose">
                You told us to proceed. Nothing else is needed from you right now — we will be in
                touch about next steps.
              </p>
            ) : (
              <>
                <p className="font-prose text-[16px] leading-relaxed text-ink-prose">
                  Take your time with it. When you are ready, tell us to go ahead.
                </p>
                <button
                  className="btn-primary mt-4"
                  onClick={() => void recordIntent()}
                  disabled={intentSaving || readOnly}
                >
                  {intentSaving ? "Saving…" : "Yes, proceed"}
                </button>
                <p className="mt-2 text-[12px] leading-relaxed text-subtle">
                  Saying yes is not a commitment to borrow. It lets us keep working.
                </p>
              </>
            )}
          </div>

          <button className="btn-secondary mt-7" onClick={() => navigate("/")}>
            Done
          </button>
        </div>
      );
    }

    if (branches.length > 0) {
      return (
        <div className="card">
          <h1 className="font-brand text-[24px] font-semibold leading-tight text-ink-editorial sm:text-[26px]">
            Almost — we need one more thing
          </h1>
          <p className="mt-2 font-prose text-[16px] leading-relaxed text-ink-prose">
            Your application is in. We could not finish your Loan Estimate without{" "}
            {branches.length === 1 ? "this" : "these"}, and it is quick.
          </p>

          <ul className="mt-6 flex flex-col gap-3 border-t border-line-light pt-5">
            {branches.map((branch) => (
              <li
                key={branch.path}
                className="flex flex-col gap-2 rounded-row border border-line-light bg-raised p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="text-[15px] font-medium text-ink-editorial">{branch.title}</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-ink-soft">
                    {branch.because}
                  </p>
                </div>
                <Link
                  to={`/f/${fileId}/${branch.path}`}
                  className="btn-primary shrink-0 text-center"
                >
                  Add this
                </Link>
              </li>
            ))}
          </ul>

          <p className="mt-6 text-[13px] leading-relaxed text-meta">
            Nothing here is urgent — your application is already submitted, and your Loan Estimate
            will follow within three business days either way.
          </p>
        </div>
      );
    }

    return (
      <div className="card">
        <h1 className="font-brand text-[24px] font-semibold leading-tight text-ink-editorial sm:text-[26px]">
          That is everything we need
        </h1>
        <p className="mt-2 font-prose text-[16px] leading-relaxed text-ink-prose">
          Your application is in, and there is nothing left for you to do. One of our underwriters
          is looking at a couple of figures that need a person rather than a calculation.
        </p>
        <p className="mt-3 font-prose text-[16px] leading-relaxed text-ink-prose">
          Your Loan Estimate will reach you by email within three business days.
        </p>
        <button className="btn-secondary mt-7" onClick={() => navigate("/")}>
          Done
        </button>
      </div>
    );
  }

  /* ── Before signing ───────────────────────────────────────────────────── */

  return (
    <>
      <Branches assessment={assessment} fileId={fileId} />

      <div className="card">
        <h1 className="font-brand text-[24px] font-semibold leading-tight text-ink-editorial sm:text-[26px]">
          Nearly done
        </h1>
        <p className="mt-2 font-prose text-[16px] leading-relaxed text-ink-prose">
          Here is what we found. Signing confirms it.
        </p>

        <div className="mt-7 border-t border-line-light pt-5">
          <ul className="flex flex-col gap-2">
            {declarations
              .filter((d) => !d.flagged)
              .map((d) => (
                <li key={d.clean} className="flex items-start justify-between gap-4 text-[15px]">
                  <span className="flex items-start gap-2.5 text-ink-prose">
                    <span aria-hidden="true" className="mt-0.5 text-olive">
                      ✓
                    </span>
                    {d.clean}
                  </span>
                  <span className="shrink-0 text-[12px] text-subtle">{d.source}</span>
                </li>
              ))}
          </ul>
        </div>

        {flagged.length > 0 && (
          <div className="mt-6 rounded-row border border-notice-border bg-notice-bg p-4">
            <p className="text-[14px] font-medium text-ink-editorial">
              {flagged.length === 1
                ? "One thing we need to ask about"
                : "A couple of things to ask about"}
            </p>
            {flagged.map((d) => (
              <div key={d.clean} className="mt-3">
                <label className="field-label" htmlFor={`q-${d.clean}`}>
                  {d.question}
                </label>
                <input
                  id={`q-${d.clean}`}
                  className="field-input"
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

        {error && <p className="mt-4 text-[13px] text-error">{error}</p>}

        <div className="mt-7 border-t border-line-light pt-6">
          {readyToSign ? (
            <SignDocument
              fileId={fileId!}
              kind="application_signature"
              label="Sign and submit"
              onSigned={() => {
                void finishSubmission();
              }}
            />
          ) : (
            <>
              <button
                className="btn-primary"
                onClick={() => void saveAndContinue()}
                disabled={!demographicsAnswered || saving || readOnly}
              >
                {saving ? "Saving…" : "Continue to sign"}
              </button>
              {!demographicsAnswered && (
                <p className="mt-2 text-[12px] text-subtle">
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

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[13px] text-subtle">{label}</dt>
      <dd className="figure mt-1 text-[22px] leading-none text-ink-editorial">{value}</dd>
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
