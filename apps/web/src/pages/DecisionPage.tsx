import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { useLoanFile } from "../lib/file.js";

/**
 * Screen 8. "Compute and answer. Show the reasoning, not just a verdict."
 *
 * The reasoning is not decoration here — every figure on this page comes from
 * a recorded derivation carrying its own formula and inputs, so the panel is
 * rendered from the audit trail rather than written alongside it. If a number
 * appears without an explanation, that is a bug in the engine, not in the copy.
 */

interface Derivation {
  requirementId: string;
  label: string;
  value: number | string | boolean | null;
  formula: string;
  inputs: Record<string, number | string | boolean | null>;
  blockedBy?: string[];
}

interface DecisionResponse {
  decision: {
    outcome: string;
    aus: { recommendation: string; engine: string; findings: { message: string }[] };
    ratios: {
      dtiFront: number | null;
      dtiBack: number | null;
      ltv: number | null;
      housingPitia: number | null;
      totalQualifyingIncome: number | null;
    };
    reserves: { requiredMonths: number | null; actualMonths: number | null };
    pricing: { llpaTotalBps: number | null; adjustments: { reason: string; bps: number }[] };
    conditions: { description: string }[];
    derivations: Derivation[];
  };
}

const OUTCOME_COPY: Record<string, { headline: string; body: string }> = {
  clear_to_close: {
    headline: "You're clear to close.",
    body: "Everything we needed is verified and nothing is outstanding.",
  },
  approved_with_conditions: {
    headline: "You qualify, with a few conditions.",
    body: "Here is what is still open, and what each one is for.",
  },
  counteroffer: {
    headline: "Not on these terms — but there is a version that works.",
    body: "One or more limits are exceeded as structured. Adjusting the loan changes the answer.",
  },
  denied: {
    headline: "We can't proceed with this one.",
    body: "The specific reasons are below.",
  },
  pending: { headline: "Still computing.", body: "" },
};

export function DecisionPage() {
  const { fileId } = useParams<{ fileId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: fileData } = useLoanFile(fileId);
  const readOnly = fileData?.file.isDemo === true;

  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [result, setResult] = useState<DecisionResponse["decision"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showWork, setShowWork] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [intentSaving, setIntentSaving] = useState(false);
  const intentRecorded = Boolean(fileData?.file && (fileData.file as { intentToProceedAt?: string | null }).intentToProceedAt);

  async function recordIntent() {
    setIntentSaving(true);
    try {
      await api.post(`/files/${fileId}/intent-to-proceed`, {});
      await queryClient.invalidateQueries({ queryKey: ["file", fileId] });
      await queryClient.invalidateQueries({ queryKey: ["assessment"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't save.");
    } finally {
      setIntentSaving(false);
    }
  }

  /**
   * Load whatever was last computed before offering to compute anything.
   *
   * The page used to hold the decision in component state only, so coming back
   * to a finished file showed "Get my answer" again — and on a demo file that
   * button 403s, because recomputing is a write. A stored decision is a thing
   * to read, not a thing to re-earn.
   */
  useEffect(() => {
    let cancelled = false;
    if (!fileId) return;
    api
      .get<{ decision: DecisionResponse["decision"] | null }>(`/files/${fileId}/decision`)
      .then((r) => {
        if (cancelled || !r.decision) return;
        setResult(r.decision);
        setState("done");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  async function compute() {
    setState("running");
    setRecomputing(true);
    setError(null);
    try {
      const response = await api.post<DecisionResponse>(`/files/${fileId}/decision`, {});
      setResult(response.decision);
      setState("done");
      await queryClient.invalidateQueries({ queryKey: ["assessment"] });
      await queryClient.invalidateQueries({ queryKey: ["file", fileId] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not compute a decision.");
      setState("error");
    } finally {
      setRecomputing(false);
    }
  }

  if (state !== "done" || !result) {
    return (
      <div className="card">
        <h1 className="font-brand text-[22px] font-semibold text-ink-editorial">Where you stand</h1>
        <p className="mt-2 font-prose text-[16px] leading-relaxed text-ink-prose">
          We have what we need. This takes a moment and shows you the arithmetic, not just a verdict.
        </p>
        {readOnly ? (
          <p className="mt-6 text-[13px] text-subtle">
            This sample file has no stored decision yet.
          </p>
        ) : (
          <button className="btn-primary mt-6" onClick={compute} disabled={state === "running"}>
            {state === "running" ? "Computing…" : "Get my answer"}
          </button>
        )}
        {error && <p className="mt-4 text-[13px] text-error">{error}</p>}
        <div className="mt-6 border-t border-line-light pt-4">
          <button
            className="text-[13px] text-subtle underline-offset-2 hover:underline"
            onClick={() => navigate(`/f/${fileId}/upload`)}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  const copy = OUTCOME_COPY[result.outcome] ?? OUTCOME_COPY.pending!;
  const blocked = result.derivations.filter((d) => d.blockedBy?.length);

  return (
    <div className="space-y-5">
      <div className="card">
        <h1 className="font-brand text-[26px] font-semibold leading-snug text-ink-editorial">
          {copy.headline}
        </h1>
        <p className="mt-2 font-prose text-[16px] leading-relaxed text-ink-prose">{copy.body}</p>

        <div className="mt-6 grid grid-cols-2 gap-x-8 gap-y-4 border-t border-line-light pt-5 sm:grid-cols-4">
          <Figure label="Debt-to-income" value={result.ratios.dtiBack} suffix="%" />
          <Figure label="Loan-to-value" value={result.ratios.ltv} suffix="%" />
          <Figure
            label="Monthly payment"
            value={result.ratios.housingPitia}
            prefix="$"
            round
          />
          <Figure label="Reserves" value={result.reserves.actualMonths} suffix=" mo" />
        </div>

        <p className="mt-5 text-[12px] leading-relaxed text-subtle">
          Computed by our own underwriting engine ({result.aus.engine}), not by Fannie Mae&rsquo;s
          Desktop Underwriter. A real agency submission may reach a different answer.
        </p>
      </div>

      {result.conditions.length > 0 && (
        <div className="card">
          <h2 className="font-brand text-[16px] font-semibold text-ink-editorial">
            What is still open
          </h2>
          <ul className="mt-4 space-y-2.5">
            {result.conditions.map((c, i) => (
              <li key={i} className="flex gap-2.5 text-[14px] leading-relaxed text-ink-soft">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-pill bg-gold" />
                {c.description}
              </li>
            ))}
          </ul>
        </div>
      )}

      {blocked.length > 0 && (
        <div className="card border-notice-border bg-notice-bg">
          <h2 className="font-brand text-[16px] font-semibold text-ink-editorial">
            What we could not compute
          </h2>
          <p className="mt-1.5 text-[13px] text-muted">
            These are missing inputs, not failures. Nothing below counted against you.
          </p>
          <ul className="mt-4 space-y-2 text-[13px]">
            {blocked.map((d, i) => (
              <li key={i} className="flex justify-between gap-4">
                <span className="text-ink-soft">{d.label}</span>
                <span className="text-right text-meta">waiting on {d.blockedBy?.join(", ")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <button
          className="font-brand text-[16px] font-semibold text-ink-editorial"
          onClick={() => setShowWork((s) => !s)}
        >
          {showWork ? "Hide the arithmetic" : "Show the arithmetic"}
        </button>

        {showWork && (
          <div className="mt-5 space-y-4">
            {result.derivations
              .filter((d) => !d.blockedBy?.length)
              .map((d, i) => (
                <div key={i} className="border-t border-line-light pt-4 first:border-0 first:pt-0">
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="text-[14px] text-ink-editorial">{d.label}</span>
                    <span className="figure text-[15px] text-ink">{String(d.value)}</span>
                  </div>
                  <p className="mt-1 text-[12px] text-muted">{d.formula}</p>
                  <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-subtle">
                    {Object.entries(d.inputs).map(([key, value]) => (
                      <div key={key} className="flex gap-1.5">
                        <dt>{key.replace(/_/g, " ")}</dt>
                        <dd className="figure text-meta">{String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-1.5 text-[11px] uppercase tracking-wide text-subtle">
                    {d.requirementId}
                  </p>
                </div>
              ))}
          </div>
        )}
      </div>

      {!readOnly && !intentRecorded && (
        <div className="card">
          <h2 className="font-brand text-[16px] font-semibold text-ink-editorial">
            Want to go ahead?
          </h2>
          <p className="mt-1.5 font-prose text-[15px] leading-relaxed text-ink-prose">
            Saying yes tells us to keep working on this. It is not a commitment to borrow, and you
            can stop at any point.
          </p>
          <button className="btn-primary mt-4" onClick={() => void recordIntent()} disabled={intentSaving}>
            {intentSaving ? "Saving…" : "Yes, keep going"}
          </button>
        </div>
      )}

      {intentRecorded && (
        <p className="text-[13px] text-olive">
          You&rsquo;ve told us to keep going. That&rsquo;s on the record.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-primary" onClick={() => navigate(`/f/${fileId}/consent`)}>
          Continue
        </button>
        <button className="btn-secondary" onClick={() => navigate(`/f/${fileId}/upload`)}>
          Back
        </button>
        {!readOnly && (
          <button
            className="text-[13px] text-subtle underline-offset-2 hover:underline"
            onClick={compute}
            disabled={recomputing}
          >
            {recomputing ? "Recomputing…" : "Recompute"}
          </button>
        )}
      </div>
    </div>
  );
}

function Figure({
  label,
  value,
  prefix = "",
  suffix = "",
  round = false,
}: {
  label: string;
  value: number | null;
  prefix?: string;
  suffix?: string;
  round?: boolean;
}) {
  return (
    <div>
      <span className="block text-[12px] text-subtle">{label}</span>
      <span className="figure text-[22px] text-ink-editorial">
        {value === null
          ? "—"
          : `${prefix}${round ? Math.round(value).toLocaleString() : value}${suffix}`}
      </span>
    </div>
  );
}
