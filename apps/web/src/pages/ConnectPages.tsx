import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ConnectorStep } from "../components/ConnectorStep.js";
import { SignDocument } from "../components/SignDocument.js";
import { api } from "../lib/api.js";
import { useLoanFile, hasConsent } from "../lib/file.js";

function useStep(next: string) {
  const { fileId = "" } = useParams<{ fileId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useLoanFile(fileId);
  const readOnly = data?.file.isDemo === true;
  return {
    fileId,
    file: data?.file,
    readOnly,
    // Ask the engine again before going back, with the evidence this branch
    // just supplied. Without it the review screen renders the decision from
    // before the branch ran — and the pill beside it still says the file is
    // waiting on the borrower for something they have just done.
    onDone: async () => {
      if (!readOnly) {
        await api.post(`/files/${fileId}/decision`, {}).catch(() => undefined);
        // Both, because the review screen builds its branch cards from the
        // assessment and its pill from the file. Refreshing one of them is how
        // a card for work that is finished stays on screen beside a state that
        // says it is not.
        await queryClient.invalidateQueries({ queryKey: ["assessment"] });
        await queryClient.invalidateQueries({ queryKey: ["file", fileId] });
      }
      navigate(`/f/${fileId}/${next}`);
    },
  };
}

/**
 * The two connector BRANCHES — payroll and IRS transcripts.
 *
 * These were steps 5 and 6. They are now entered only when the engine says
 * income or employment did not resolve from the bank connection, and both
 * return to the review screen rather than chaining onward: a branch is work
 * inside step 3, not a step of its own.
 *
 * The credit and bank screens that used to live here are now
 * `IdentityPage.tsx` and `BankPage.tsx`, because both grew past what a shared
 * ConnectorStep could express.
 */

/** Screen 3 — the first visible win. Something happens, instantly. */
export function PayrollPage() {
  const { fileId, file, readOnly, onDone } = useStep("review");
  return (
    <ConnectorStep
      fileId={fileId}
      endpoint="payroll"
      title="Your employer"
      promise="Your paystubs, straight from payroll."
      detail="Your bank showed us money arriving. This tells us exactly what it is — base pay against bonus or commission — which is what decides how much of it counts."
      duration="About five seconds"
      existing={file?.payroll ?? null}
      extract={(r) => r.payroll}
      readOnly={readOnly}
      onDone={onDone}
      renderResult={(data) => {
        const payroll = data as {
          employments?: { employerName: string; position: string }[];
          incomeSources?: { type: string; monthlyAmount: number }[];
        } | null;
        const employer = payroll?.employments?.[0];
        return (
          <div>
            {employer && (
              <p className="text-base text-ink">
                {employer.position} at {employer.employerName}
              </p>
            )}
            <ul className="mt-4 space-y-1.5 text-sm">
              {(payroll?.incomeSources ?? []).map((s) => (
                <li key={s.type} className="flex justify-between">
                  <span className="capitalize text-ink-soft">{s.type.replace(/_/g, " ")}</span>
                  <span className="super-figure text-ink">
                    ${s.monthlyAmount.toLocaleString()}/mo
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      }}
    />
  );
}

/**
 * Sheet screen 7 — the reconciliation source.
 *
 * The IRS pull needs a signed 4506-C (INC-008), and for a long time nothing in
 * the product could sign one — so this screen was a terminal dead end and
 * every sheet screen after it was unreachable behind it. The signing step is
 * now part of the screen rather than a prerequisite nobody could satisfy.
 */
export function IrsPage() {
  const { fileId, file, readOnly, onDone } = useStep("review");
  const signed = hasConsent(file, "form_4506c");
  const transcripts = file?.transcripts?.length ? file.transcripts : null;

  return (
    <ConnectorStep
      fileId={fileId}
      endpoint="irs"
      title="Your tax transcripts"
      promise="Two years of filed income, from the IRS directly."
      detail="This is the record every lender reconciles against. Having it now is what keeps a question from arriving three weeks before closing."
      duration="About five seconds"
      existing={transcripts}
      extract={(r) => r.transcripts}
      readOnly={readOnly}
      blocked={
        signed || readOnly
          ? null
          : {
              message:
                "The IRS will only release transcripts to someone you have authorized in writing. Form 4506-C is that authorization.",
              action: (
                <SignDocument
                  fileId={fileId}
                  kind="form_4506c"
                  label="Review and sign the 4506-C"
                />
              ),
            }
      }
      onDone={onDone}
      renderResult={(data) => {
        const list = (data as { taxYear: number; wages: number }[] | null) ?? [];
        return (
          <ul className="space-y-1.5 text-sm">
            {list.map((t) => (
              <li key={t.taxYear} className="flex justify-between">
                <span className="text-ink-soft">{t.taxYear} wages</span>
                <span className="super-figure text-ink">${t.wages.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        );
      }}
    />
  );
}
