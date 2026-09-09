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
import type { ApplicationStandingView } from "../lib/file.js";

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

/**
 * A ledger row with everything on it.
 *
 * `causedBy` names a decision run, a snapshot or a list of requirement ids,
 * and `actorPrincipalId` names an internal actor. This is the only surface any
 * of that may appear on, which is why the borrower's own timeline reads a
 * different, narrower shape from a different endpoint.
 */
export interface RawLedgerRow {
  seq: number;
  from: string | null;
  to: string;
  event: string;
  reasonCode: string | null;
  causedBy: string | null;
  actorKind: string;
  actorSubject: string;
  actorPrincipalId: string;
  occurredAt: string;
  recordedAt: string;
}

export function DebugPanel({
  assessment,
  failed,
  file,
  ledger,
  standing,
}: {
  assessment: Assessment | undefined;
  failed?: boolean;
  file?: unknown;
  ledger?: RawLedgerRow[];
  standing?: ApplicationStandingView | null;
}) {
  const [tab, setTab] = useState<"outstanding" | "blocked" | "ledger" | "file">("outstanding");

  return (
    <aside className="mt-10 rounded-lg border border-dashed border-rule-strong bg-raised p-5 font-mono text-xs">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-text text-sm font-semibold text-ink">
          Engine view{" "}
          <span className="font-normal text-ink-faint">· ?debug=1 · not borrower-facing</span>
        </p>
        <div className="flex gap-1">
          {(["outstanding", "blocked", "ledger", "file"] as const).map((t) => (
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

      {tab === "ledger" && (
        <ul className="mt-4 flex flex-col gap-1.5">
          {/*
            The application id and its clocks, raw.

            A tolled clock and the reason it is tolled appear NOWHERE else: the
            borrower's timeline says the Loan Estimate is on hold and stops
            there, which is right for a borrower and useless for working out
            why. `sixPieces()` is not here yet — nothing pins a piece until
            screen 2 does.
          */}
          <li className="text-ink-faint">
            application: {standing ? standing.id : "none on record"}
            {standing ? ` · ${standing.status} · seq ${standing.ledger.length}` : ""}
          </li>
          {standing?.clocks.map((c) => (
            <li key={c.kind} className="border-b border-rule-soft pb-1.5 text-ink-faint">
              <span className="text-accent">{c.kind}</span> {c.statuteCitation}
              <div>
                started {c.startedAt} · due {c.dueAt}
              </div>
              <div>
                tolled {c.tolledFrom ?? "—"} → {c.tolledUntil ?? "—"} · reason:{" "}
                {c.tollingReason ?? "—"}
              </div>
              <div>
                satisfied {c.satisfiedAt ?? "—"} · breached {c.breachedAt ?? "—"}
              </div>
            </li>
          ))}
          {!ledger && <li className="text-ink-faint">loading ledger…</li>}
          {ledger?.length === 0 && <li className="text-ink-faint">no transitions yet</li>}
          {ledger?.map((row) => (
            <li key={row.seq} className="border-b border-rule-soft pb-1.5">
              <span className="text-accent">
                {row.seq} {row.from ?? "—"} → {row.to}
              </span>{" "}
              <span className="text-ink-soft">{row.event}</span>
              <div className="text-ink-faint">
                {row.actorKind} {row.actorSubject} · {row.actorPrincipalId}
              </div>
              <div className="text-ink-faint">
                reason: {row.reasonCode ?? "—"} · caused by: {row.causedBy ?? "—"}
              </div>
              <div className="text-ink-faint">
                occurred {row.occurredAt} · recorded {row.recordedAt}
              </div>
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
