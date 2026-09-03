/**
 * The engine, on request.
 *
 * Everything the old right-hand rail rendered at the borrower lives here
 * instead, behind `?debug=1`: counts, requirement ids, severities, actors,
 * blocked roots. We still need to QA the flow against the requirements sheet,
 * and deleting the rail must not mean deleting our own ability to see what the
 * engine thinks.
 *
 * The rule this encodes: the engine keeps evaluating everything, and stops
 * rendering to the borrower. Not "stops evaluating".
 *
 * It is styled as a developer surface on purpose — monospace, dense, internal
 * vocabulary intact. Anything that looks like product invites somebody to ship
 * it as product.
 */

import { useState } from "react";
import clsx from "clsx";
import type { Assessment, OutstandingItem } from "../lib/api.js";

/** Grouping the nine engine screens under the four borrower ones. */
const SCREEN_GROUP: Record<string, string> = {
  property_loan: "1 · Property",
  identity: "2 · About you",
  credit: "2 · About you",
  bank: "3 · Your bank",
  payroll: "branch · payroll",
  irs_transcript: "branch · IRS",
  upload_fallback: "branch · documents",
  decision: "4 · Review",
  persistent_consent: "(dropped from flow)",
};

export function DebugPanel({
  assessment,
  failed,
  file,
}: {
  assessment: Assessment | undefined;
  failed?: boolean;
  file?: unknown;
}) {
  const [tab, setTab] = useState<"outstanding" | "blocked" | "file">("outstanding");

  return (
    <aside className="mt-10 rounded-lg border border-dashed border-rule-strong bg-raised p-5 font-mono text-xs">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-text text-sm font-semibold text-ink">
          Engine view{" "}
          <span className="font-normal text-ink-faint">· ?debug=1 · not borrower-facing</span>
        </p>
        <div className="flex gap-1">
          {(["outstanding", "blocked", "file"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={clsx(
                "rounded-md px-2 py-1 font-text text-xs",
                tab === t
                  ? "bg-primary text-primary-ink"
                  : // Hovering to `raised` would match the panel behind it and
                    // make the chip vanish under the cursor.
                    "bg-ground text-ink-soft hover:bg-rule-soft",
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {failed && <p className="mt-4 text-danger">assessment request failed</p>}
      {!assessment && !failed && <p className="mt-4 text-ink-faint">loading assessment…</p>}

      {assessment && tab === "outstanding" && (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
            <Count label="applicable" value={assessment.progress.applicable} />
            <Count label="satisfied" value={assessment.progress.satisfied} />
            <Count label="outstanding" value={assessment.progress.outstanding} />
            <Count label="blocked" value={assessment.progress.blocked} />
            <Count label="undetermined" value={assessment.progress.undetermined} />
            <Count label="borrower" value={assessment.progress.borrowerOutstanding} />
            <Count label="lender" value={assessment.progress.lenderOutstanding} />
          </dl>
          <ul className="mt-4 flex flex-col gap-1.5">
            {assessment.outstanding.map((o) => (
              <Row key={o.id} item={o} />
            ))}
          </ul>
        </>
      )}

      {assessment && tab === "blocked" && (
        <ul className="mt-4 flex flex-col gap-1.5">
          {assessment.blocked.length === 0 && <li className="text-ink-faint">nothing blocked</li>}
          {assessment.blocked.map((b) => (
            <li key={b.id} className="border-b border-rule-soft pb-1.5">
              <span className="text-accent">{b.id}</span> {b.statement}
              <div className="text-ink-faint">waiting on: {b.rootCauses.join(", ")}</div>
            </li>
          ))}
        </ul>
      )}

      {tab === "file" && (
        <pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs text-ink-soft">
          {JSON.stringify(file ?? {}, null, 2)}
        </pre>
      )}
    </aside>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

function Row({ item }: { item: OutstandingItem }) {
  return (
    <li className="border-b border-rule-soft pb-1.5">
      <span className="text-accent">{item.id}</span>{" "}
      <span className="text-ink-faint">
        [{SCREEN_GROUP[item.screen] ?? item.screen} · {item.actor} · {item.severity}
        {item.applicabilityKnown ? "" : " · may-not-apply"}]
      </span>
      <div className="text-ink-soft">{item.statement}</div>
      {item.missing && <div className="text-ink-faint">missing: {item.missing}</div>}
      {item.waitingFor && <div className="text-ink-faint">waiting: {item.waitingFor}</div>}
    </li>
  );
}
