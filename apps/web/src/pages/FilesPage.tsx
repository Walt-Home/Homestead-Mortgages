/**
 * The front door.
 *
 * This used to be a file manager — "Your files", a list, a table of stages.
 * That is the right first screen for the team and the wrong one for a
 * borrower, who arrives wanting a mortgage and gets shown an inbox.
 *
 * Now it is a pitch and two doors: start, or pick up where you left off. The
 * second only exists when there is something to pick up.
 *
 * The sample borrowers are still reachable, deliberately demoted to a line at
 * the bottom. They are the team's shared artifact to critique and losing them
 * would mean arranging a UUID by hand again.
 */

import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { STAGE_TO_SCREEN, type FlowStage } from "../lib/flow.js";

interface FileRow {
  id: string;
  stage: string;
  isDemo: boolean;
  createdAt: string;
  propertyCity: string | null;
  propertyState: string | null;
  borrowers: { firstName: string; lastName: string }[];
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
  // The most recent unfinished file. A completed one is not something to
  // "continue", and offering to resume it reads as though it did not take.
  const inProgress = mine.find((f) => f.stage !== "COMPLETE");

  return (
    <div className="mx-auto max-w-2xl px-5 py-14 sm:px-6 sm:py-20">
      <p className="text-[13px] font-medium uppercase tracking-wide text-gold">Homestead</p>
      <h1 className="mt-3 font-brand text-[38px] font-semibold leading-[1.1] text-ink-editorial sm:text-[46px]">
        The Supermortgage
      </h1>
      <p className="mt-5 max-w-prose font-prose text-[18px] leading-relaxed text-ink-prose">
        A better rate, in four screens and about five minutes. Connect your accounts instead of
        hunting for statements, and we retrieve almost everything underwriting needs.
      </p>
      <p className="mt-4 max-w-prose font-prose text-[16px] leading-relaxed text-ink-prose">
        No documents to dig out. No forms asking what your bank already knows. A decision that
        explains itself.
      </p>

      <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
        <button className="btn-primary" onClick={() => navigate("/f/new/property")}>
          Start now
        </button>

        {inProgress && (
          <Link
            className="btn-secondary text-center"
            to={`/f/${inProgress.id}/${STAGE_TO_SCREEN[inProgress.stage as FlowStage] ?? "review"}`}
          >
            Pick up where you left off
          </Link>
        )}
      </div>

      {inProgress && (
        <p className="mt-3 text-[13px] text-meta">
          You have one in progress
          {inProgress.propertyCity ? ` on ${inProgress.propertyCity}` : ""}
          {inProgress.propertyState ? `, ${inProgress.propertyState}` : ""}.
        </p>
      )}

      {isLoading && <p className="mt-8 text-[13px] text-subtle">Loading…</p>}

      <p className="mt-14 border-t border-line-light pt-5 text-[12px] leading-relaxed text-subtle">
        Nothing here is a loan offer, and no credit is checked. Every connection returns invented
        data.{" "}
        <Link className="text-gold underline underline-offset-2" to="/privacy">
          What we keep, and how to delete it
        </Link>
        .
      </p>

      {demos.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer list-none text-[12px] text-subtle underline-offset-2 hover:underline">
            Sample borrowers ({demos.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {demos.map((f) => (
              <li key={f.id}>
                <Link
                  className="text-[13px] text-gold underline underline-offset-2"
                  to={`/f/${f.id}/${STAGE_TO_SCREEN[f.stage as FlowStage] ?? "review"}`}
                >
                  {f.borrowers[0]
                    ? `${f.borrowers[0].firstName} ${f.borrowers[0].lastName}`
                    : "Sample file"}
                  {f.propertyCity ? ` — ${f.propertyCity}, ${f.propertyState}` : ""}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
