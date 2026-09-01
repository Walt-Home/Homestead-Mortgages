import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { STAGE_TO_PATH, type FlowStage } from "../lib/file.js";

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

      {mine.length > 0 && mine[0] && mine[0].stage !== "COMPLETE" && (
        <div className="mt-6 rounded-card border border-gold-border bg-gold-fill p-5">
          <p className="text-[14px] text-ink-editorial">
            You have a file in progress. Pick up where you left off.
          </p>
          <Link
            to={`/f/${mine[0].id}/${STAGE_TO_PATH[mine[0].stage as FlowStage] ?? "decision"}`}
            className="btn-primary mt-3 inline-block"
          >
            Continue
          </Link>
        </div>
      )}

      {mine.length > 0 && <Group files={mine} deletable />}

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

function Group({ files, deletable = false }: { files: FileRow[]; deletable?: boolean }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/files/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["files"] }),
  });

  return (
    <ul className="mt-5 space-y-2.5">
      {files.map((f) => {
        const name = f.borrowers[0]
          ? `${f.borrowers[0].firstName} ${f.borrowers[0].lastName}`
          : "Unnamed file";
        const decision = f.decisions[0];
        return (
          <li key={f.id} className="relative">
            {deletable && (
              <div className="absolute right-3 top-3 z-10">
                {confirming === f.id ? (
                  <span className="flex items-center gap-2 text-[12px]">
                    <button
                      className="text-danger underline underline-offset-2"
                      onClick={() => remove.mutate(f.id)}
                      disabled={remove.isPending}
                    >
                      delete for good
                    </button>
                    <button className="text-subtle" onClick={() => setConfirming(null)}>
                      cancel
                    </button>
                  </span>
                ) : (
                  <button
                    className="text-[12px] text-subtle underline-offset-2 hover:underline"
                    onClick={() => setConfirming(f.id)}
                  >
                    delete
                  </button>
                )}
              </div>
            )}
            <Link
              // Typed against FlowStage, so a new stage is a compile error
              // rather than a silent fallback to the decision screen.
              to={`/f/${f.id}/${STAGE_TO_PATH[f.stage as FlowStage] ?? "decision"}`}
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
