import { useNavigate, useParams } from "react-router-dom";
import { ConnectorStep } from "../components/ConnectorStep.js";
import { SignDocument } from "../components/SignDocument.js";
import { useLoanFile, hasConsent } from "../lib/file.js";

function useStep(next: string) {
  const { fileId = "" } = useParams<{ fileId: string }>();
  const navigate = useNavigate();
  const { data } = useLoanFile(fileId);
  return {
    fileId,
    file: data?.file,
    readOnly: data?.file.isDemo === true,
    onDone: () => navigate(`/f/${fileId}/${next}`),
  };
}

/** Screen 3 — the first visible win. Something happens, instantly. */
export function CreditPage() {
  const { fileId, file, readOnly, onDone } = useStep("bank");
  return (
    <ConnectorStep
      fileId={fileId}
      endpoint="credit"
      title="Your credit"
      promise="A soft check, right now. It will not affect your score."
      detail="We pull all three bureaus at once. That gives us your score, your open accounts and your payment history — which is most of what a lender asks you to list by hand."
      duration="About two seconds"
      existing={file?.credit ?? null}
      extract={(r) => r.report}
      readOnly={readOnly}
      onDone={onDone}
      renderResult={(data) => {
        const report = data as {
          scores?: { bureau: string; score: number }[];
          tradelines?: unknown[];
        } | null;
        const scores = report?.scores ?? [];
        const middle = [...scores].map((s) => s.score).sort((a, b) => a - b)[1];
        return (
          <div>
            <div className="flex items-baseline gap-3">
              <span className="figure text-[38px] leading-none text-ink-editorial">
                {middle ?? "—"}
              </span>
              <span className="text-[13px] text-muted">your qualifying score</span>
            </div>
            <div className="mt-4 flex gap-6 text-[13px]">
              {scores.map((s) => (
                <div key={s.bureau}>
                  <span className="block text-subtle capitalize">{s.bureau}</span>
                  <span className="figure text-ink-soft">{s.score}</span>
                </div>
              ))}
            </div>
            <p className="mt-4 text-[13px] text-muted">
              {report?.tradelines?.length ?? 0} accounts found. We&rsquo;ll use them for your debt
              ratio, so there is nothing for you to list.
            </p>
          </div>
        );
      }}
    />
  );
}

/** Screen 4 — the one that matters. Thirteen requirements come off this. */
export function BankPage() {
  const { fileId, file, readOnly, onDone } = useStep("payroll");
  return (
    <ConnectorStep
      fileId={fileId}
      endpoint="bank"
      title="Your bank"
      promise="Twelve months, read once. This replaces every statement you would otherwise upload."
      detail="One connection covers your down payment, your reserves, your income deposits, your rent history and your cash flow. It is the single biggest thing you can do here."
      duration="About ten seconds"
      existing={file?.assets ?? null}
      extract={(r) => r.report}
      readOnly={readOnly}
      onDone={onDone}
      renderResult={(data) => {
        const report = data as {
          accounts?: { institution: string; type: string; mask: string; currentBalance: number }[];
          identifiedRentPayments?: number;
          alternativeReferences?: { kind: string }[];
        } | null;
        const accounts = report?.accounts ?? [];
        const total = accounts.reduce((s, a) => s + a.currentBalance, 0);
        return (
          <div>
            <div className="flex items-baseline gap-3">
              <span className="figure text-[30px] leading-none text-ink-editorial">
                ${total.toLocaleString()}
              </span>
              <span className="text-[13px] text-muted">
                verified across {accounts.length} accounts
              </span>
            </div>
            <ul className="mt-4 space-y-1.5 text-[13px]">
              {accounts.map((a) => (
                <li key={a.mask} className="flex justify-between">
                  <span className="text-ink-soft">
                    {a.institution} · {a.type} ····{a.mask}
                  </span>
                  <span className="figure text-meta">${a.currentBalance.toLocaleString()}</span>
                </li>
              ))}
            </ul>
            {(report?.identifiedRentPayments ?? 0) >= 12 && (
              <p className="mt-4 rounded-row bg-olive-light px-3 py-2 text-[13px] text-olive">
                Twelve months of on-time rent found
                {report?.alternativeReferences?.length
                  ? `, plus ${report.alternativeReferences.length - 1} other recurring payments`
                  : ""}
                . That counts in your favour.
              </p>
            )}
          </div>
        );
      }}
    />
  );
}

/** Screen 5 — precision on employment and variable income. */
export function PayrollPage() {
  const { fileId, file, readOnly, onDone } = useStep("irs");
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
              <p className="text-[15px] text-ink-editorial">
                {employer.position} at {employer.employerName}
              </p>
            )}
            <ul className="mt-4 space-y-1.5 text-[13px]">
              {(payroll?.incomeSources ?? []).map((s) => (
                <li key={s.type} className="flex justify-between">
                  <span className="capitalize text-ink-soft">{s.type.replace(/_/g, " ")}</span>
                  <span className="figure text-meta">${s.monthlyAmount.toLocaleString()}/mo</span>
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
 * Screen 6 — the reconciliation source.
 *
 * The IRS pull needs a signed 4506-C (INC-008), and for a long time nothing in
 * the product could sign one — so this screen was a terminal dead end and
 * screens 7, 8 and 9 were unreachable behind it. The signing step is now part
 * of the screen rather than a prerequisite nobody could satisfy.
 */
export function IrsPage() {
  const { fileId, file, readOnly, onDone } = useStep("upload");
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
                "The IRS will only release transcripts to someone you have authorised in writing. Form 4506-C is that authorisation.",
              action: <SignDocument fileId={fileId} kind="form_4506c" label="Review and sign the 4506-C" />,
            }
      }
      onDone={onDone}
      renderResult={(data) => {
        const list = (data as { taxYear: number; wages: number }[] | null) ?? [];
        return (
          <ul className="space-y-1.5 text-[13px]">
            {list.map((t) => (
              <li key={t.taxYear} className="flex justify-between">
                <span className="text-ink-soft">{t.taxYear} wages</span>
                <span className="figure text-meta">${t.wages.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        );
      }}
    />
  );
}
