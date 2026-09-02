import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.js";
import { useLoanFile } from "../lib/file.js";

/**
 * Step 3 — the bank connection, and only the bank connection.
 *
 * "Purely just a login, nothing more unless it fails." Twelve months of
 * transactions gives assets, income, employment, cash flow and rent history in
 * one act, which is why this is the step that earns its place and payroll and
 * IRS no longer do.
 *
 * Two forks hang off it, and neither is a step anybody walks by default:
 * payroll, when deposits cannot separate base pay from commission, and manual
 * documents when the connection itself fails.
 */
export function Step3Bank() {
  const { fileId = "" } = useParams<{ fileId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useLoanFile(fileId);
  const readOnly = data?.file.isDemo === true;

  const connected = Boolean(data?.file.assets);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    accounts: { institution: string; type: string; mask: string; currentBalance: number }[];
    payrollNeeded: boolean;
    reason: string | null;
  } | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{
        report: { accounts: { institution: string; type: string; mask: string; currentBalance: number }[] };
        payrollNeeded: boolean;
        incomeConfidenceReason: string | null;
      }>(`/files/${fileId}/bank`);
      setResult({
        accounts: r.report.accounts ?? [],
        payrollNeeded: r.payrollNeeded,
        reason: r.incomeConfidenceReason,
      });
      await queryClient.invalidateQueries({ queryKey: ["file", fileId] });
      await queryClient.invalidateQueries({ queryKey: ["assessment"] });
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "DEMO_FILE_READ_ONLY"
          ? "This is a sample file and can't be changed."
          : "We couldn't reach your bank. You can send documents instead.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const total = result.accounts.reduce((s, a) => s + a.currentBalance, 0);
    return (
      <div className="card">
        <div className="mb-4 inline-flex items-center gap-2 rounded-pill bg-olive-light px-3 py-1 text-[12px] font-medium text-olive">
          Connected
        </div>
        <div className="flex items-baseline gap-3">
          <span className="figure text-[30px] leading-none text-ink-editorial">
            ${total.toLocaleString()}
          </span>
          <span className="text-[13px] text-muted">
            verified across {result.accounts.length} account{result.accounts.length === 1 ? "" : "s"}
          </span>
        </div>
        <ul className="mt-4 space-y-1.5 text-[13px]">
          {result.accounts.map((a) => (
            <li key={a.mask} className="flex justify-between">
              <span className="text-ink-soft">{a.institution} · {a.type} ····{a.mask}</span>
              <span className="figure text-meta">${a.currentBalance.toLocaleString()}</span>
            </li>
          ))}
        </ul>

        {result.payrollNeeded ? (
          <div className="mt-6 rounded-row border border-notice-border bg-notice-bg px-4 py-4">
            <p className="text-[14px] leading-relaxed text-ink-soft">
              {result.reason ?? "We need one more source to pin down your income."}
            </p>
            <p className="mt-1.5 text-[13px] text-muted">
              Connecting your employer takes a few seconds and settles it.
            </p>
            <button className="btn-primary mt-3" onClick={() => navigate(`/f/${fileId}/payroll`)}>
              Connect my employer
            </button>
          </div>
        ) : (
          <p className="mt-5 rounded-row bg-olive-light px-3 py-2 text-[13px] text-olive">
            That covered your income, assets and employment. Nothing else to connect.
          </p>
        )}

        <div className="mt-6 flex gap-3">
          <button
            className={result.payrollNeeded ? "btn-secondary" : "btn-primary"}
            onClick={() => navigate(`/f/${fileId}/confirm`)}
          >
            Continue
          </button>
          <button className="btn-secondary" onClick={() => navigate(`/f/${fileId}/identity`)}>
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h1 className="font-brand text-[22px] font-semibold text-ink-editorial">Connect your bank</h1>
      <p className="mt-2 font-prose text-[16px] leading-relaxed text-ink-prose">
        One login. This is the whole step.
      </p>
      <p className="mt-3 text-[14px] leading-relaxed text-muted">
        Twelve months of your account covers your down payment, your reserves, your income, your
        employer and your rent history — everything a lender would otherwise ask you to gather and
        upload.
      </p>

      {error && (
        <div className="mt-5 rounded-row border border-notice-border bg-notice-bg px-4 py-3 text-[13px] text-error">
          {error}
        </div>
      )}

      <div className="mt-6 flex items-center gap-3">
        {!readOnly && (
          <button className="btn-primary" onClick={connect} disabled={busy}>
            {busy ? "Connecting…" : connected ? "Reconnect" : "Connect"}
          </button>
        )}
        <span className="text-[13px] text-subtle">About ten seconds</span>
      </div>

      <div className="mt-6 border-t border-line-light pt-4 flex flex-wrap items-center gap-4">
        <button
          className="text-[13px] text-subtle underline-offset-2 hover:underline"
          onClick={() => navigate(`/f/${fileId}/identity`)}
        >
          Back
        </button>
        <button
          className="text-[13px] text-subtle underline-offset-2 hover:underline"
          onClick={() => navigate(`/f/${fileId}/documents`)}
        >
          I&rsquo;d rather send documents
        </button>
      </div>
    </div>
  );
}
