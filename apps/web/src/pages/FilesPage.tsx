/**
 * The front door, and now the marketing page.
 *
 * It used to be a file manager, then a pitch in a text column. It is now
 * Doug's front page from supermortgage.com: the promise in Georgia on solid
 * black, one white button, and the street underneath. See docs/brand.md.
 *
 * The headline is the prototype's, verbatim. The ACTIONS are not, and cannot
 * be — the prototype offers a waitlist to a stranger, and everybody who
 * reaches this page has already signed in and can start an application right
 * now. So the layout, type and scene match, and the button says what it does.
 *
 * The sample borrowers stay, demoted to a line below the scene. They are the
 * team's shared artifact to critique, and losing them would mean arranging a
 * UUID by hand again.
 */

import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { StreetScene } from "../components/StreetScene.js";
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
    <>
      {/*
        Centred, and sized to what it holds rather than to the viewport. The
        prototype uses 100svh; here the header and the scene are already in
        the frame, and a full-height hero would push the street off it.
      */}
      <section className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-9 px-6 py-16 text-center sm:py-24">
        <h1 className="super-h1 super-enter text-ink">The Greatest Mortgage Ever Offered</h1>

        <p className="super-sub super-enter super-enter-1">
          Automatically refinances when interest rates drop, with lowest rates guaranteed.{" "}
          <Link to="/brand" className="super-link whitespace-nowrap">
            Learn more
          </Link>
        </p>

        <div className="super-enter super-enter-2 flex flex-col items-center gap-4">
          <button className="super-cta" onClick={() => navigate("/f/new/property")}>
            {inProgress ? "Start another" : "Start now"}
          </button>

          {inProgress && (
            <Link
              className="super-link-quiet text-sm"
              to={`/f/${inProgress.id}/${STAGE_TO_SCREEN[inProgress.stage as FlowStage] ?? "review"}`}
            >
              Or pick up the one you started
              {inProgress.propertyCity ? ` in ${inProgress.propertyCity}` : ""}
              {inProgress.propertyState ? `, ${inProgress.propertyState}` : ""}
            </Link>
          )}
        </div>
      </section>

      <StreetScene />

      {/*
        Below the scene, so the marketing page ends at the street and the
        team's tooling does not sit inside it.
      */}
      {(isLoading || demos.length > 0) && (
        <div className="mx-auto max-w-2xl px-5 pt-8 sm:px-6">
          {isLoading && <p className="text-sm text-ink-faint">Loading…</p>}
          {demos.length > 0 && (
            <details>
              <summary className="super-link-quiet cursor-pointer list-none text-xs">
                Sample borrowers ({demos.length})
              </summary>
              <ul className="mt-2 flex flex-col gap-1">
                {demos.map((f) => (
                  <li key={f.id}>
                    <Link
                      className="super-link text-sm"
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
      )}
    </>
  );
}
