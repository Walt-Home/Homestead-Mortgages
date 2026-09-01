import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";

/**
 * What you can open: your own files, and the shared demo set.
 *
 * The demo files are the reason this page exists. Without somewhere to list
 * them they are reachable only by pasting a UUID, which makes "here is a
 * completed decision to critique" a thing that has to be arranged rather than
 * found.
 */

interface FileRow {
  id: string;
  stage: string;
  isDemo: boolean;
  createdAt: string;
  purpose: string | null;
  loanAmount: string | null;
  valueOrPrice: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  borrowers: { firstName: string; lastName: string }[];
  decisions: { outcome: string; ausRecommendation: string }[];
}

const STAGE_PATH: Record<string, string> = {
  PROPERTY_LOAN: "identity",
  IDENTITY: "identity",
  CREDIT: "credit",
  BANK: "bank",
  PAYROLL: "payroll",
  IRS_TRANSCRIPT: "irs",
  UPLOAD_FALLBACK: "upload",
  DECISION: "decision",
  PERSISTENT_CONSENT: "consent",
  COMPLETE: "decision",
};

export function FilesPage() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ["files"],
    queryFn: () => api.get<{ files: FileRow[] }>("/files"),
  });

  const files = data?.files ?? [];
  const mine = files.filter((f) => !f.isDemo);
  const demos = files.filter((f) => f.isDemo);

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <div className="flex items-baseline justify-between">
        <h1 className="font-brand text-[26px] font-semibold text-ink-editorial">Your files</h1>
        <button className="btn-primary" onClick={() => navigate("/f/new/property")}>
          Start a new one
        </button>
      </div>

      {isLoading && <p className="mt-8 text-[14px] text-subtle">Loading…</p>}

      {!isLoading && mine.length === 0 && (
        <p className="mt-6 font-prose text-[16px] leading-relaxed text-ink-prose">
          You haven&rsquo;t started one yet. It takes about two minutes.
        </p>
      )}

      {mine.length > 0 && <Group files={mine} />}

      {demos.length > 0 && (
        <section className="mt-12">
          <h2 className="font-brand text-[16px] font-semibold text-ink-editorial">
            Sample borrowers
          </h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
            Completed files everyone can open, so there is something shared to look at. Read-only —
            each one exercises a different part of the underwriting.
          </p>
          <Group files={demos} />
        </section>
      )}
    </div>
  );
}

function Group({ files }: { files: FileRow[] }) {
  return (
    <ul className="mt-5 space-y-2.5">
      {files.map((f) => {
        const name = f.borrowers[0]
          ? `${f.borrowers[0].firstName} ${f.borrowers[0].lastName}`
          : "Unnamed file";
        const decision = f.decisions[0];
        return (
          <li key={f.id}>
            <Link
              to={`/f/${f.id}/${STAGE_PATH[f.stage] ?? "decision"}`}
              className="block rounded-row border border-line-light bg-app px-4 py-3.5 transition-colors hover:bg-hover"
            >
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-[15px] text-ink-editorial">{name}</span>
                <span className="figure text-[13px] text-meta">
                  {f.loanAmount ? `$${Number(f.loanAmount).toLocaleString()}` : "—"}
                </span>
              </div>
              <div className="mt-1 flex items-baseline justify-between gap-4 text-[12px]">
                <span className="text-subtle">
                  {f.propertyCity ? `${f.propertyCity}, ${f.propertyState}` : "No address yet"}
                </span>
                <span className="text-subtle">
                  {decision ? decision.outcome.replace(/_/g, " ") : f.stage.toLowerCase().replace(/_/g, " ")}
                </span>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
