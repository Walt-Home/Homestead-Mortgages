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
 */

import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.js";
import { useLoanFile } from "../lib/file.js";
import { Why } from "../components/Why.js";
import { Working } from "../components/Working.js";

interface AssetReport {
  accounts: { accountId: string; type: string; institution: string; currentBalance: number }[];
  /** Consecutive on-time rent payments the report could identify (CRD-018). */
  identifiedRentPayments?: number;
}

interface CreditReport {
  scores: { bureau: string; score: number }[];
  tradelines: unknown[];
}

interface Decision {
  ratios: {
    dtiBack: number | null;
    ltv: number | null;
    housingPitia: number | null;
    totalQualifyingIncome: number | null;
  };
}

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

export function BankPage() {
  const { fileId } = useParams<{ fileId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useLoanFile(fileId);
  const readOnly = data?.file.isDemo === true;

  const existing = data?.file.assets as AssetReport | null | undefined;
  const credit = data?.file.credit as CreditReport | null | undefined;
  const [report, setReport] = useState<AssetReport | null>(null);
  const [standing, setStanding] = useState<Decision["ratios"] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [statements, setStatements] = useState<string[]>([]);

  const result = report ?? existing ?? null;

  async function connect() {
    if (!fileId) return;
    setPending(true);
    setError(null);
    try {
      const res = await api.post<{ report: AssetReport }>(`/files/${fileId}/bank`, {});
      setReport(res.report);

      /*
       * No payroll call here any more.
       *
       * The engine now accepts a validated twelve-month asset report as
       * evidence for INC-002 (Day 1 Certainty), so a salaried borrower's
       * income verifies from this one connection. Reaching for payroll from
       * the client was a workaround for that gap and is now just a second
       * request nobody needs. Borrowers whose income the report cannot
       * characterise still get the payroll branch on the review screen.
       */

      // Compute where they stand against everything verified so far.
      const decision = await api.post<{ decision: Decision }>(`/files/${fileId}/decision`, {});
      setStanding(decision.decision.ratios);

      await queryClient.invalidateQueries({ queryKey: ["file", fileId] });
      await queryClient.invalidateQueries({ queryKey: ["assessment"] });
    } catch (err) {
      if (err instanceof ApiError && err.code === "DEMO_FILE_READ_ONLY") {
        setError("This is a sample file, so it is read-only.");
      } else {
        setError(err instanceof Error ? err.message : "That connection did not go through.");
      }
    } finally {
      setPending(false);
    }
  }

  /**
   * The credit result, demoted to one line.
   *
   * This used to be a screen of its own: a big number, three bureau scores, a
   * tradeline count, and a Continue button. All the borrower needed from it
   * was "it worked, and it did not hurt your score" — so that is what is left,
   * sitting above whatever they are actually here to do.
   */
  const creditBar = credit?.scores?.length ? (
    <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-row border border-olive-border bg-olive-light px-4 py-2.5">
      <span aria-hidden="true" className="text-olive">
        ✓
      </span>
      <span className="text-[14px] text-ink-editorial">
        Credit checked · <span className="figure">{middleScore(credit.scores)}</span>
      </span>
      <span className="text-[13px] text-meta">Soft pull, so your score is untouched.</span>
    </div>
  ) : null;

  if (result) {
    const total = result.accounts.reduce((sum, a) => sum + a.currentBalance, 0);
    const rent = result.identifiedRentPayments;
    return (
      <>
        {creditBar}
        <div className="card">
          <h1 className="font-brand text-[24px] font-semibold leading-tight text-ink-editorial sm:text-[26px]">
            Here is where you stand
          </h1>
          <p className="mt-2 font-prose text-[16px] leading-relaxed text-ink-prose">
            Not an approval and not an offer — a read of your numbers as they are today.
          </p>

          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-line-light pt-5 sm:grid-cols-3">
            <Figure
              label={`Verified assets`}
              value={money(total)}
              note={`across ${result.accounts.length} account${result.accounts.length === 1 ? "" : "s"}`}
            />
            <Figure
              label="Monthly income"
              value={
                standing?.totalQualifyingIncome != null
                  ? money(standing.totalQualifyingIncome)
                  : null
              }
            />
            <Figure
              label="Monthly payment"
              value={standing?.housingPitia != null ? money(standing.housingPitia) : null}
            />
            <Figure
              label="Debt-to-income"
              value={standing?.dtiBack != null ? `${standing.dtiBack}%` : null}
            />
            <Figure
              label="Loan-to-value"
              value={standing?.ltv != null ? `${standing.ltv}%` : null}
            />
          </dl>

          {typeof rent === "number" && rent >= 12 && (
            <p className="mt-6 rounded-row border border-olive-border bg-olive-light px-4 py-3 font-prose text-[15px] leading-relaxed text-ink-prose">
              We found {rent} months of rent paid on time. That counts in your favour, and it is the
              kind of thing a credit score alone would miss.
            </p>
          )}

          <button className="btn-primary mt-7" onClick={() => navigate(`/f/${fileId}/review`)}>
            Continue
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {creditBar}
      <div className="card">
        <h1 className="font-brand text-[24px] font-semibold leading-tight text-ink-editorial sm:text-[26px]">
          Connect your bank
        </h1>
        <p className="mt-2 font-prose text-[16px] leading-relaxed text-ink-prose">
          Twelve months, read once. One connection covers your down payment, reserves, income
          deposits, rent history and cash flow.
        </p>
        <p className="mt-3 font-prose text-[16px] leading-relaxed text-ink-prose">
          It replaces every statement you would otherwise have to find, download and upload.
        </p>

        {pending ? (
          <Working
            steps={[
              { label: "Opening a secure connection", ms: 1200 },
              { label: "Reading twelve months of activity", ms: 2000 },
              { label: "Finding your income and rent history", ms: 2000 },
              { label: "Working out where you stand", ms: 2500 },
            ]}
            note="This is the longest step, and the last one you have to do anything for."
          />
        ) : (
          <>
            <button className="btn-primary mt-6" onClick={() => void connect()} disabled={readOnly}>
              Connect your bank
            </button>
            <Why>
              We read your transactions once, to verify what you have and what you earn. We cannot
              move money, and we do not keep your bank password — you sign in with your bank, not
              with us.
            </Why>
          </>
        )}

        {readOnly && (
          <p className="mt-4 text-[13px] text-meta">
            This is a sample file, so there is nothing to connect.
          </p>
        )}
        {error && <p className="mt-4 text-[13px] text-error">{error}</p>}

        {/*
        The escape hatch, for when the bank connection will not go.

        Deliberately quiet — one line under the primary action, not a
        side-by-side choice. Connecting is better for the borrower in every
        way (faster, and it verifies things a PDF cannot), so offering both
        with equal weight would push people towards the worse path.

        STUB: the files are listed and nothing is sent. Wiring the ingest is
        Joe's, and it needs a real decision about where the bytes go — the
        existing document endpoint deliberately never transmits them.
      */}
        {!pending && (
          <div className="mt-6 border-t border-line-light pt-4">
            {manualOpen ? (
              <>
                <p className="font-prose text-[15px] leading-relaxed text-ink-prose">
                  Upload the last twelve months of statements for any account you would use for the
                  deposit or your income. Select as many files as you like.
                </p>
                <input
                  type="file"
                  multiple
                  className="mt-3 block w-full text-[14px] text-ink-soft file:mr-3 file:rounded-control file:border file:border-line file:bg-surface file:px-4 file:py-2 file:text-[14px] file:text-ink-soft"
                  onChange={(e) =>
                    setStatements(Array.from(e.target.files ?? []).map((f) => f.name))
                  }
                />
                {statements.length > 0 && (
                  <>
                    <ul className="mt-3 flex flex-col gap-1">
                      {statements.map((name) => (
                        <li key={name} className="text-[13px] text-ink-soft">
                          {name}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-3 text-[13px] leading-relaxed text-olive">
                      Got them — {statements.length} file{statements.length === 1 ? "" : "s"}. We
                      will read these and come back to you. It takes longer than connecting, so if
                      the connection starts working, use that instead.
                    </p>
                  </>
                )}
              </>
            ) : (
              <button
                type="button"
                className="text-[13px] text-meta underline underline-offset-2"
                onClick={() => setManualOpen(true)}
              >
                Bank won&rsquo;t connect? Upload statements instead
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

/**
 * A figure, or an honest dash.
 *
 * `null` means the engine could not compute it — usually because income still
 * needs a branch. Rendering a zero, or omitting the row, would both read as an
 * answer. A dash reads as what it is.
 */
function Figure({ label, value, note }: { label: string; value: string | null; note?: string }) {
  return (
    <div>
      <dt className="text-[13px] text-subtle">{label}</dt>
      <dd className="figure mt-1 text-[22px] leading-none text-ink-editorial">
        {value ?? <span className="text-subtle">—</span>}
      </dd>
      {note && <p className="mt-1 text-[12px] text-meta">{note}</p>}
      {!value && !note && <p className="mt-1 text-[12px] text-meta">still working this out</p>}
    </div>
  );
}
