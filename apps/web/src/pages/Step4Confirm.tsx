import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.js";
import { useLoanFile } from "../lib/file.js";
import {
  DemographicQuestions,
  type DemographicAnswers,
} from "../components/DemographicQuestions.js";

/**
 * Step 4 — confirm, answer the demographic questions, sign.
 *
 * The signature is the application package, which is how it works on paper:
 * nobody signs a 4506-C by itself. Bundling it here is what lets the IRS
 * transcripts be pulled server-side with no screen in front of them, and it is
 * why the flow is four steps rather than six.
 *
 * Both the demographics and the signature are required, and the server refuses
 * to sign without the former — Regulation B wants the questions asked on the
 * application, and the application is the thing being signed.
 */
export function Step4Confirm() {
  const { fileId = "" } = useParams<{ fileId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useLoanFile(fileId);
  const file = data?.file;
  const readOnly = file?.isDemo === true;

  const [demographics, setDemographics] = useState<DemographicAnswers>({
    ethnicity: [], race: [], sex: "", visualObservationNoted: false,
  });
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const borrower = file?.borrowers[0];
  // Each of the three must carry a real answer or an explicit decline. A blank
  // is neither, and the server refuses on the same rule.
  const complete =
    (demographics.ethnicity === "declined" || (demographics.ethnicity as string[]).length > 0) &&
    (demographics.race === "declined" || (demographics.race as string[]).length > 0) &&
    demographics.sex !== "";

  async function sign() {
    setBusy(true);
    setError(null);
    try {
      // Demographics go onto the borrower first, because the signature
      // endpoint refuses without them.
      await api.post(`/files/${fileId}/borrowers`, {
        firstName: borrower!.firstName, lastName: borrower!.lastName,
        email: borrower!.email, phone: borrower!.phone,
        dateOfBirth: borrower!.dateOfBirth.slice(0, 10),
        currentAddress: borrower!.currentAddress,
        maritalStatus: borrower!.maritalStatus,
        preferredLanguage: "en",
        firstTimeHomebuyer: borrower!.firstTimeHomebuyer ?? false,
        currentHousing: borrower!.currentHousing,
        monthlyRent: borrower!.monthlyRent,
        demographics: {
          ethnicity: demographics.ethnicity,
          race: demographics.race,
          sex: demographics.sex === "" ? "declined" : demographics.sex,
          visualObservationNoted: false,
        },
        statedMonthlyIncome: 1,
      });

      await api.post(`/files/${fileId}/sign-application`, {});
      await queryClient.invalidateQueries({ queryKey: ["file", fileId] });
      await queryClient.invalidateQueries({ queryKey: ["assessment"] });
      navigate(`/f/${fileId}/result`);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "DEMOGRAPHICS_REQUIRED"
          ? "Please answer or decline each of the three questions above."
          : err instanceof Error ? err.message : "That didn't go through.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h1 className="font-brand text-[22px] font-semibold text-ink-editorial">
        Check it over, then sign
      </h1>
      <p className="mt-2 text-[14px] text-muted">
        This is what we&rsquo;ll submit. Anything wrong, go back and fix it.
      </p>

      <dl className="mt-6 grid gap-x-8 gap-y-3 border-t border-line-light pt-5 sm:grid-cols-2">
        <Row label="Applicant" value={borrower ? `${borrower.firstName} ${borrower.lastName}` : "—"} />
        <Row label="Property" value={file?.property ? `${file.property.address.line1}, ${file.property.address.city} ${file.property.address.state}` : "—"} />
        <Row label="Purpose" value={file?.loan?.purpose?.replace(/_/g, " ") ?? "—"} />
        <Row label="Use" value={file?.property?.occupancy?.replace(/_/g, " ") ?? "—"} />
        <Row label={file?.loan?.purpose === "purchase" ? "Purchase price" : "Estimated value"}
             value={file?.property ? `$${file.property.valueOrPrice.toLocaleString()}` : "—"} />
        <Row label="Loan amount" value={file?.loan ? `$${file.loan.loanAmount.toLocaleString()}` : "—"} />
        <Row label="Credit" value={file?.credit ? "Checked, all three bureaus" : "Not checked"} />
        <Row label="Bank" value={file?.assets ? "Connected, 12 months" : "Not connected"} />
      </dl>

      <DemographicQuestions value={demographics} onChange={setDemographics} />

      <div className="mt-7 border-t border-line-light pt-5">
        <h2 className="font-brand text-[16px] font-semibold text-ink-editorial">
          Sign your application
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
          Signing submits your application and authorises the IRS to release your tax transcripts
          to us (Form 4506-C). In this prototype nothing is sent to the IRS and the transcripts you
          see are invented.
        </p>
        <label className="mt-4 flex gap-3 text-[13px] leading-relaxed text-ink-soft">
          <input type="checkbox" className="mt-0.5" checked={attested}
                 onChange={(e) => setAttested(e.target.checked)} />
          <span>
            Everything above is accurate to the best of my knowledge, and I&rsquo;m signing this
            application electronically.
          </span>
        </label>
      </div>

      {error && <p className="mt-5 text-[13px] text-error">{error}</p>}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          className="btn-primary"
          onClick={() => void sign()}
          disabled={busy || !attested || !complete || readOnly}
        >
          {busy ? "Signing…" : "Sign and submit"}
        </button>
        <button className="btn-secondary" onClick={() => navigate(`/f/${fileId}/bank`)}>
          Back
        </button>
      </div>
      {!complete && (
        <p className="mt-3 text-[12px] text-subtle">
          Answer or decline each of the three questions above to continue.
        </p>
      )}
      {readOnly && <p className="mt-3 text-[13px] text-subtle">This is a sample file and can&rsquo;t be signed.</p>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[12px] uppercase tracking-wide text-subtle">{label}</dt>
      <dd className="mt-0.5 text-[15px] capitalize text-ink-editorial">{value}</dd>
    </div>
  );
}
