/**
 * The conditional branches, when there are any.
 *
 * Payroll, IRS transcripts and document upload used to be steps 5, 6 and 7,
 * shown to every borrower whether or not they needed them — which meant most
 * people saw three screens whose entire content was "nothing here for you".
 *
 * Now they appear here, on the review screen, only when the engine says
 * something specific did not resolve from the bank connection. A borrower who
 * does not trigger one never learns it exists.
 *
 * Renders nothing at all when there is nothing to do, and that is the common
 * case. It must never render an empty "outstanding items" shell — an empty
 * container still tells somebody there is a category of work they are failing
 * at.
 */

import { Link } from "react-router-dom";
import { branchesFor } from "../lib/flow.js";
import type { Assessment } from "../lib/api.js";

export function Branches({
  assessment,
  fileId,
}: {
  assessment: Assessment | undefined;
  fileId: string | undefined;
}) {
  const branches = branchesFor(assessment);
  if (branches.length === 0 || !fileId) return null;

  return (
    <div className="card mb-5 border-gold-border bg-gold-fill">
      <h2 className="font-brand text-[17px] font-semibold text-ink-editorial">
        {branches.length === 1 ? "One more thing" : "A couple more things"}
      </h2>
      <p className="mt-1.5 font-prose text-[15px] leading-relaxed text-ink-prose">
        Your bank covered most of it. These did not come through.
      </p>

      <ul className="mt-4 flex flex-col gap-3">
        {branches.map((branch) => (
          <li
            key={branch.path}
            className="flex flex-col gap-2 rounded-row border border-line-light bg-app p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <p className="text-[15px] font-medium text-ink-editorial">{branch.title}</p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-ink-soft">{branch.because}</p>
            </div>
            <Link to={`/f/${fileId}/${branch.path}`} className="btn-secondary shrink-0 text-center">
              Sort this out
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
