/**
 * Every tape a servicer's book was built from, and whether the book adds
 * up: what each tape carried, what it loaded and refused, the loans it
 * created and the ones it found already there, and the loans it repeated
 * under another spelling of their numbers. Beneath it, every tape since
 * taken off the book, and why.
 *
 * A tape is removed here and nowhere else, with the number of loans it
 * takes typed out and a reason kept beside the name of whoever removed it.
 * One panel, used in two places — the Partner book's Tapes tab and the
 * servicer's own page.
 */

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "./Icon.js";
import { Sheet } from "./Sheet.js";
import { Table, type Column } from "./Table.js";
import { useToast } from "./Toast.js";
import { Button, Field, Input, Notice, Pill, Rows, Spinner, Textarea } from "./ui.js";
import { useAct } from "../lib/act.js";
import { fmtDate, fmtDateTime, money, plural } from "../lib/format.js";
import {
  alreadyOnBook,
  bookGapWords,
  bookSum,
  bookSumWords,
  confirmsNumber,
  keptOnRemoval,
  refusalWords,
  removeTapePath,
  repeatedTapeName,
  tapeName,
  tapeReconciliation,
  type ReconciledTape,
  type RemovedTape,
  type TapeReconciliation as Reconciliation,
  type TapeRemoval,
} from "../lib/book.js";

const count = (n: number) => <span className="tabular-nums">{n.toLocaleString()}</span>;

/** Refusals the removal sheet answers in place; anything else is a toast as well. */
const ANSWERED_IN_PLACE = ["CONFIRM_MISMATCH", "TAPE_NOT_REMOVABLE", "NOT_FOUND"] as const;

function RemoveTapeSheet({
  slug,
  tape,
  onClose,
}: {
  slug: string;
  tape: ReconciledTape;
  onClose: () => void;
}) {
  const queries = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  // The loans the removal deletes: the ones only this tape carries. It is the
  // server's count, and the one the removal is confirmed with; a loan this
  // tape created that a later tape also carries is not among them.
  const loans = tape.removes.loans;
  const kept = keptOnRemoval(tape);
  const remove = useAct({
    invalidate: [
      ["tape-reconciliation", slug],
      ["desk-servicers"],
      ["desk-imports"],
      ["servicer-book-loans", slug],
      ["servicer-book-loan", slug],
      ["billing-servicer", slug],
      ["billing-statement", slug],
      ["billing-servicers"],
    ],
    quiet: ANSWERED_IN_PLACE,
  });
  const ready = reason.trim() !== "" && reason.trim().length <= 500 && confirmsNumber(typed, loans);

  async function submit() {
    const done = await remove.run<RemovedTape>(removeTapePath(slug, tape.id), {
      body: { confirmLoans: loans, reason: reason.trim() },
      door: "hm",
    });
    if (!done) {
      // A refusal may mean the tape changed under us; read it again.
      void queries.invalidateQueries({ queryKey: ["tape-reconciliation", slug] });
      return;
    }
    toast({
      tone: "ok",
      title: `${tapeName(done.removal)} removed`,
      body: `${plural(done.removal.loansRemoved, "loan")} came off the book; ${plural(
        done.loansOnBook,
        "loan",
      )} on it now.`,
    });
    onClose();
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={`Remove ${tapeName(tape)}?`}
      subtitle="The loans only this tape carries come off the book, with everything recorded about them. This cannot be undone; loading the tape again is the way back."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={remove.busy}>
            Keep it
          </Button>
          <Button
            variant="danger"
            loading={remove.busy}
            disabled={!ready}
            onClick={() => void submit()}
          >
            {loans > 0 ? `Remove ${plural(loans, "loan")}` : "Remove the tape"}
          </Button>
        </>
      }
    >
      <Rows
        rows={[
          { label: "File", value: tapeName(tape) },
          { label: "As of", value: fmtDate(tape.asOf) },
          { label: "Loaded", value: fmtDateTime(tape.loadedAt) },
          { label: "Billed from", value: tape.billedFrom ? fmtDate(tape.billedFrom) : "—" },
          {
            label: "Loans removed",
            value: `${plural(loans, "loan")} only this tape carries`,
          },
          { label: "Balance", value: money(tape.balanceCents), mono: true },
          ...(kept
            ? [
                {
                  label: "Loans kept",
                  value: `${plural(kept, "loan")} another tape also carries stay; this tape's report of each is removed`,
                },
              ]
            : []),
          ...(tape.removes.reviews
            ? [
                {
                  label: "Reviews removed",
                  value: `${plural(tape.removes.reviews, "review")} that rested on what this tape said`,
                },
              ]
            : []),
          ...(tape.duplicates
            ? [
                {
                  label: "Of them, repeats",
                  value: `${plural(tape.duplicates, "loan")} already on the book under another spelling`,
                },
              ]
            : []),
        ]}
      />
      <p className="mt-4 text-sm text-fg-2">
        The running month is metered again without them. A month already closed keeps its statement.
        A name or date of birth this tape respelled on a loan that stays keeps that spelling. The
        removal itself is kept, with your name and the reason.
      </p>
      <div className="mt-5 space-y-4">
        <Field
          label="Why"
          htmlFor="remove-tape-reason"
          hint="Kept with the removal, beside your name."
          error={reason.trim().length > 500 ? "At most 500 characters." : undefined}
        >
          <Textarea
            id="remove-tape-reason"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            placeholder="The same loans as an earlier tape, their numbers written another way."
          />
        </Field>
        <Field
          label={`Type ${loans.toLocaleString()} to confirm`}
          htmlFor="remove-tape-confirm"
          hint="The number of loans this removes."
        >
          <Input
            id="remove-tape-confirm"
            inputMode="numeric"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </Field>
        {remove.error ? <Notice tone="danger">{remove.error.message}</Notice> : null}
      </div>
    </Sheet>
  );
}

export function TapeReconciliation({ slug }: { slug: string }) {
  const rec = useQuery({
    queryKey: ["tape-reconciliation", slug],
    queryFn: () => tapeReconciliation(slug),
    enabled: slug !== "",
  });
  const [removing, setRemoving] = useState<ReconciledTape | null>(null);
  const data = rec.data ?? null;
  const removedTapes = useMemo(() => new Set((data?.removals ?? []).map((r) => r.tapeId)), [data]);

  const columns = useMemo<Column<ReconciledTape>[]>(
    () => [
      {
        key: "tape",
        header: "Tape",
        primary: true,
        render: (t) => (
          <div className="flex min-w-[12rem] max-w-[18rem] flex-col items-start gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <span className="break-words font-medium text-fg">{tapeName(t)}</span>
              {removedTapes.has(t.id) ? <Pill tone="neutral">Removed</Pill> : null}
            </span>
            <span className="text-xs text-fg-3">loaded {fmtDateTime(t.loadedAt)}</span>
            {removedTapes.has(t.id) ? null : t.removable.ok ? (
              <Button
                size="sm"
                variant="ghost"
                className="-ml-2 mt-1"
                onClick={() => setRemoving(t)}
              >
                Remove this tape…
              </Button>
            ) : (
              <span className="mt-1 text-xs text-fg-3">
                Cannot be removed. {t.removable.reasons.join(" ")}
              </span>
            )}
          </div>
        ),
      },
      {
        key: "asOf",
        header: "As of",
        render: (t) => <span className="whitespace-nowrap">{fmtDate(t.asOf)}</span>,
      },
      {
        key: "billed",
        header: "Billed from",
        render: (t) =>
          t.billedFrom ? (
            <span className="whitespace-nowrap">{fmtDate(t.billedFrom)}</span>
          ) : (
            <span className="text-fg-3">—</span>
          ),
      },
      { key: "rows", header: "On file", align: "right", render: (t) => count(t.rowsTotal) },
      {
        key: "refused",
        header: "Refused",
        align: "right",
        render: (t) => (
          <span className={t.rowsRefused ? "text-warn" : "text-fg-3"}>{count(t.rowsRefused)}</span>
        ),
      },
      {
        key: "created",
        header: "New loans",
        align: "right",
        render: (t) => (
          <span className="inline-flex flex-col items-end">
            {count(t.loansCreated)}
            {t.loansStillOnBook !== t.loansCreated ? (
              <span className="text-xs text-fg-3">
                {t.loansStillOnBook.toLocaleString()} on the book
              </span>
            ) : null}
          </span>
        ),
      },
      {
        key: "already",
        header: "Already held",
        align: "right",
        render: (t) => count(alreadyOnBook(t)),
      },
      {
        key: "duplicates",
        header: "Duplicates",
        align: "right",
        render: (t) =>
          t.duplicates ? (
            <span className="font-medium text-danger">{count(t.duplicates)}</span>
          ) : (
            <span className="text-fg-3">0</span>
          ),
      },
      {
        key: "balance",
        header: "Balance",
        align: "right",
        render: (t) => <span className="tabular-nums">{money(t.balanceCents)}</span>,
      },
    ],
    [removedTapes],
  );

  if (rec.isPending) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-fg-2">
        <Spinner /> Reading the tapes…
      </div>
    );
  }
  if (rec.isError || !data) {
    return (
      <Notice tone="danger" title="The tapes could not be read">
        {rec.error instanceof Error ? rec.error.message : "Try again in a moment."}
      </Notice>
    );
  }
  if (data.tapes.length === 0 && data.removals.length === 0) {
    return (
      <Notice tone="neutral">
        No tape loaded yet. Every tape loaded at the desk is listed here, with how the book adds up.
      </Notice>
    );
  }

  const sum = bookSum(data);
  const refused = data.tapes.flatMap((t) =>
    t.refused.map((r, i) => ({ ...r, tape: t, key: `${t.id}-${r.row}-${r.code}-${i}` })),
  );
  const repeating = data.tapes.filter((t) => t.duplicates > 0 && !removedTapes.has(t.id));

  return (
    <div className="space-y-4">
      {repeating.map((t) => (
        <DuplicatesNotice key={t.id} tape={t} rec={data} onRemove={() => setRemoving(t)} />
      ))}

      <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
        <Table
          columns={columns}
          rows={data.tapes}
          rowKey={(t) => t.id}
          dense
          empty={{ icon: "book", title: "Every tape has been removed" }}
        />
      </div>

      {sum.adds ? (
        <div className="flex items-start gap-3 rounded-md border border-line-2 bg-surface-2 px-4 py-3 text-base text-fg">
          <Icon name="check" size={18} className="mt-0.5 text-ok" />
          <span className="tabular-nums">{bookSumWords(sum)}.</span>
        </div>
      ) : (
        <Notice tone="warn" title="The tapes and the book do not add up">
          {bookGapWords(sum)}
        </Notice>
      )}

      {refused.length ? (
        <section>
          <h3 className="mb-2 text-sm font-medium text-fg">
            {plural(refused.length, "row")} the load refused
          </h3>
          <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
            <Table
              dense
              columns={[
                {
                  key: "tape",
                  header: "Tape",
                  primary: true,
                  render: (r) => <span className="break-all">{tapeName(r.tape)}</span>,
                },
                { key: "row", header: "Row", mono: true, render: (r) => r.row },
                {
                  key: "number",
                  header: "Loan number",
                  mono: true,
                  render: (r) => r.number ?? <span className="text-fg-3">—</span>,
                },
                { key: "why", header: "Why", render: (r) => refusalWords(r.code, r.column) },
              ]}
              rows={refused}
              rowKey={(r) => r.key}
            />
          </div>
        </section>
      ) : null}

      {data.removals.length ? <Removals removals={data.removals} /> : null}

      {removing ? (
        <RemoveTapeSheet slug={slug} tape={removing} onClose={() => setRemoving(null)} />
      ) : null}
    </div>
  );
}

/** A tape that repeated loans already on the book, named beside the tape it repeated. */
function DuplicatesNotice({
  tape,
  rec,
  onRemove,
}: {
  tape: ReconciledTape;
  rec: Reconciliation;
  onRemove: () => void;
}) {
  const repeated = tape.duplicatesOf
    .map((d) => `${plural(d.loans, "loan")} from ${repeatedTapeName(d.tapeId, rec)}`)
    .join(", ");
  return (
    <Notice
      tone="danger"
      title={`${plural(tape.duplicates, "loan")} on the book ${
        tape.duplicates === 1 ? "is" : "are"
      } in it twice`}
    >
      <p>
        {tapeName(tape)}, loaded {fmtDateTime(tape.loadedAt)}, created{" "}
        {plural(tape.duplicates, "loan")} that were already on the book under another spelling of
        their numbers: {repeated || "loans another tape created first"}. They are the same loans, so
        the book counts them twice and the bill does too.
      </p>
      {tape.removable.ok ? (
        <div className="mt-3">
          <Button size="sm" variant="danger" onClick={onRemove}>
            Remove this tape…
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-sm">It cannot be removed: {tape.removable.reasons.join(" ")}</p>
      )}
    </Notice>
  );
}

function Removals({ removals }: { removals: readonly TapeRemoval[] }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium text-fg">
        {plural(removals.length, "tape")} removed
      </h3>
      <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
        <Table
          dense
          columns={[
            {
              key: "tape",
              header: "Tape",
              primary: true,
              render: (r) => (
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="break-all font-medium text-fg">{tapeName(r)}</span>
                  <span className="text-xs text-fg-3">as of {fmtDate(r.asOf)}</span>
                </div>
              ),
            },
            {
              key: "loans",
              header: "Loans removed",
              align: "right",
              render: (r) => count(r.loansRemoved),
            },
            {
              key: "balance",
              header: "Balance",
              align: "right",
              render: (r) => <span className="tabular-nums">{money(r.balanceCents)}</span>,
            },
            {
              key: "why",
              header: "Why",
              render: (r) => <span className="text-fg-2">{r.reason}</span>,
            },
            {
              key: "by",
              header: "Removed by",
              render: (r) => r.removedByName ?? r.removedBy ?? "—",
            },
            { key: "when", header: "When", render: (r) => fmtDateTime(r.removedAt) },
          ]}
          rows={removals}
          rowKey={(r) => r.id}
        />
      </div>
    </section>
  );
}
