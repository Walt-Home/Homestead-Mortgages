/**
 * The review screen, for the person applying WITH the applicant.
 *
 * Their own half and nothing else: the answers they gave on their screen 3,
 * the three demographic questions asked of every applicant, and one
 * signature that attests to their own answers and authorizes their own
 * Form 4506-C. The applicant's answers, reports and standing are not here —
 * the server does not send them to a co-borrower, and this screen would not
 * show them if it did.
 *
 * What the applicant sees of this is a line: signed, or not yet.
 */

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.js";
import { hasConsent, useLoanFile } from "../lib/file.js";
import { primaryBorrower } from "../lib/borrowers.js";
import { PERSONA_READ_ONLY, useAuth } from "../lib/auth.js";
import {
  DemographicQuestions,
  type DemographicAnswers,
} from "../components/DemographicQuestions.js";
import { Working } from "../components/Working.js";
import { answerLines } from "../lib/declarations.js";
import { CO_BORROWER_REVIEW_COPY, SIGNING_COPY } from "../lib/outcomes.js";
import { Answers } from "./ReviewPage.js";

/**
 * The one refusal this screen re-words rather than passing through. A
 * sample borrower's is not about what they typed, so it says what it is
 * about — the same rule, in the same words, as the applicant's screen.
 */
function refusal(err: unknown): string | null {
  return err instanceof ApiError && err.code === "PERSONA_READ_ONLY" ? PERSONA_READ_ONLY : null;
}

export function CoBorrowerReviewPage() {
  const { fileId } = useParams<{ fileId: string }>();
  const queryClient = useQueryClient();
  const { data } = useLoanFile(fileId);
  const { user } = useAuth();
  const file = data?.file;
  const readOnly = file?.isDemo === true || user?.persona != null;

  const me = file?.borrowers.find((b) => b.id === data?.you) ?? null;
  const applicant = primaryBorrower(file);
  const applicantFirstName = applicant?.firstName ?? "";
  const declaration = me?.declaration ?? null;
  const declared = declaration != null;
  const primaryResidence = file?.property?.occupancy === "primary_residence";
  const signed = hasConsent(file, "application_signature", me?.id);

  const [demographics, setDemographics] = useState<DemographicAnswers>({
    ethnicity: [],
    race: [],
    sex: "",
    visualObservationNoted: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const demographicsAnswered =
    !primaryResidence ||
    ((demographics.ethnicity === "declined" || demographics.ethnicity.length > 0) &&
      (demographics.race === "declined" || demographics.race.length > 0) &&
      demographics.sex !== "");

  /**
   * One press: the demographics onto their own row, then the signature.
   * The server resolves both by the person asking, so nothing here names a
   * borrower.
   */
  async function signMyPart() {
    if (!fileId || !me || !declared || !demographicsAnswered) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`/files/${fileId}/borrowers`, {
        firstName: me.firstName,
        lastName: me.lastName,
        email: me.email,
        phone: me.phone,
        dateOfBirth: me.dateOfBirth,
        currentAddress: me.currentAddress,
        maritalStatus: me.maritalStatus,
        citizenship: me.citizenship ?? null,
        preferredLanguage: "en",
        firstTimeHomebuyer: me.firstTimeHomebuyer ?? true,
        currentHousing: me.currentHousing,
        monthlyRent: me.monthlyRent,
        demographics: primaryResidence
          ? {
              ethnicity:
                demographics.ethnicity === "declined" ? "declined" : demographics.ethnicity,
              race: demographics.race === "declined" ? "declined" : demographics.race,
              sex: demographics.sex === "" ? "declined" : demographics.sex,
              visualObservationNoted: false,
            }
          : null,
      });
      await api.post(`/files/${fileId}/sign-application`, {});
    } catch (err) {
      setError(refusal(err) ?? (err instanceof Error ? err.message : "That did not save."));
    } finally {
      setSaving(false);
      await queryClient.invalidateQueries({ queryKey: ["file", fileId] });
    }
  }

  if (!file || !me) {
    return (
      <div className="super-card">
        <p className="text-base text-ink-soft">Finding your place…</p>
      </div>
    );
  }

  if (saving) {
    return (
      <div className="super-card">
        <h1 className="font-display text-2xl text-ink sm:text-3xl">Putting it together</h1>
        <Working
          steps={[
            { label: "Recording your signature", ms: 900 },
            { label: "Requesting your tax records", ms: 1800 },
          ]}
        />
      </div>
    );
  }

  if (signed) {
    return (
      <div className="super-card">
        <h1 className="font-display text-2xl text-ink sm:text-3xl">
          {CO_BORROWER_REVIEW_COPY.doneTitle}
        </h1>
        <p className="mt-2 text-base text-ink-soft">
          {CO_BORROWER_REVIEW_COPY.doneBody(applicantFirstName)}
        </p>
        <Link to="/" className="super-btn super-btn-outline mt-7 inline-block">
          Back to your applications
        </Link>
      </div>
    );
  }

  return (
    <div className="super-card">
      <h1 className="font-display text-2xl text-ink sm:text-3xl">
        {CO_BORROWER_REVIEW_COPY.title}
      </h1>
      <p className="mt-2 text-base text-ink-soft">
        {CO_BORROWER_REVIEW_COPY.lead(applicantFirstName)}
      </p>

      <Answers
        heading={SIGNING_COPY.heading}
        lines={answerLines(declaration, me.residences)}
        unanswered={SIGNING_COPY.unanswered}
        to={`/f/${fileId}/declarations`}
      />

      {primaryResidence && <DemographicQuestions value={demographics} onChange={setDemographics} />}

      {error && <p className="mt-4 text-sm text-danger">{error}</p>}

      <div className="mt-7 border-t border-rule-soft pt-6">
        <div className="super-notice">
          <p className="font-display text-base text-ink">{CO_BORROWER_REVIEW_COPY.panelTitle}</p>
          <p className="mt-2 text-base text-ink-soft">{CO_BORROWER_REVIEW_COPY.panelBody}</p>
          <button
            className="super-btn super-btn-primary mt-4"
            onClick={() => void signMyPart()}
            disabled={!declared || !demographicsAnswered || readOnly}
          >
            {CO_BORROWER_REVIEW_COPY.signButton}
          </button>
          {!declared ? (
            <p className="mt-2 text-xs text-ink-faint">{SIGNING_COPY.unanswered}</p>
          ) : (
            !demographicsAnswered && (
              <p className="mt-2 text-xs text-ink-faint">
                Answer the three questions above, or decline them, to continue.
              </p>
            )
          )}
        </div>
      </div>
    </div>
  );
}
