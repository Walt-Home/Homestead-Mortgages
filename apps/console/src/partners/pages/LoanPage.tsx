/**
 * One loan on the servicer's book, as their team sees it: the loan their
 * tape described, what each tape since has said, what each morning's review
 * concluded and why, the offers that came of it, and where the homeowner's
 * invitation stands. Read-only. Nothing of the homeowner's own side of a
 * claim is here — the door does not send it.
 */

import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Page, Section } from "../../components/Page.js";
import { Table, type Column } from "../../components/Table.js";
import { EmptyState, Notice, Pill, Rows, Stat, type Tone } from "../../components/ui.js";
import { Loading } from "../../components/Loading.js";
import { fmtDate, money, plural } from "../../lib/format.js";
import { verdictTone, verdictWord, type Verdict } from "../../lib/tape.js";
import {
  portal,
  PortalError,
  type PortalLoanDetail,
  type PortalOffer,
  type PortalReview,
  type PortalTape,
} from "../api.js";
import { claimCell, offerCell, stateWord } from "./BookPage.js";

const TAPE_STATUS: Record<string, { word: string; tone: Tone }> = {
  current: { word: "Current", tone: "ok" },
  delinquent: { word: "Delinquent", tone: "warn" },
  paid_off: { word: "Paid off", tone: "neutral" },
  charged_off: { word: "Charged off", tone: "neutral" },
  matured: { word: "Matured", tone: "neutral" },
  transferred: { word: "Transferred", tone: "neutral" },
};
const tapeStatus = (s: string) => TAPE_STATUS[s] ?? { word: s.replace(/_/g, " "), tone: "neutral" };

/** "the rate reduction clears the floor; the savings are positive" → one sentence. */
function sentence(reasons: readonly string[]): string {
  if (reasons.length === 0) return "";
  const joined = reasons.join("; ");
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}

function termWord(months: number): string {
  return months % 12 === 0 ? plural(months / 12, "year") : plural(months, "month");
}

function addressLines(a: PortalLoanDetail["address"]): string | null {
  const street = [a.line1, a.line2].filter(Boolean).join(", ");
  const place = [a.city, [a.state, a.postalCode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  return [street, place].filter(Boolean).join(" · ") || null;
}

export function PortalLoanPage() {
  const { id = "" } = useParams();
  const page = useQuery({
    queryKey: ["portal-loan", id],
    queryFn: () => portal<{ loan: PortalLoanDetail }>(`/book/loans/${id}`).then((r) => r.loan),
    enabled: id !== "",
    retry: (count, err) => !(err instanceof PortalError && err.status === 404) && count < 2,
  });

  const tapeColumns = useMemo<Column<PortalTape>[]>(
    () => [
      { key: "asOf", header: "Tape as of", primary: true, render: (t) => fmtDate(t.asOf) },
      {
        key: "status",
        header: "Status",
        render: (t) => <Pill tone={tapeStatus(t.status).tone}>{tapeStatus(t.status).word}</Pill>,
      },
      {
        key: "balance",
        header: "Balance",
        align: "right",
        render: (t) => <span className="tabular-nums">{money(t.principalBalanceCents)}</span>,
      },
      {
        key: "rate",
        header: "Rate",
        align: "right",
        render: (t) => (
          <span className="tabular-nums">{t.currentRatePct ? `${t.currentRatePct}%` : "—"}</span>
        ),
      },
      {
        key: "payment",
        header: "Payment",
        align: "right",
        render: (t) => <span className="tabular-nums">{money(t.scheduledPaymentCents)}</span>,
      },
      {
        key: "due",
        header: "Next due",
        render: (t) => (t.nextPaymentDueOn ? fmtDate(t.nextPaymentDueOn) : "—"),
      },
      {
        key: "late",
        header: "Days late",
        align: "right",
        render: (t) => <span className="tabular-nums">{t.delinquencyDays ?? "—"}</span>,
      },
    ],
    [],
  );

  const reviewColumns = useMemo<Column<PortalReview>[]>(
    () => [
      { key: "asOf", header: "Reviewed", primary: true, render: (r) => fmtDate(r.asOf) },
      {
        key: "verdict",
        header: "Verdict",
        render: (r) => (
          <Pill tone={verdictTone(r.verdict as Verdict)}>{verdictWord(r.verdict as Verdict)}</Pill>
        ),
      },
      {
        key: "rate",
        header: "Rate that day",
        align: "right",
        render: (r) => (
          <span className="tabular-nums">
            {r.candidateRatePct ? `${r.candidateRatePct}%` : "—"}
          </span>
        ),
      },
      {
        key: "why",
        header: "Why",
        render: (r) => <span className="text-fg-2">{sentence(r.reasons) || "—"}</span>,
      },
    ],
    [],
  );

  const offerColumns = useMemo<Column<PortalOffer>[]>(
    () => [
      { key: "found", header: "Found", primary: true, render: (o) => fmtDate(o.detectedOn) },
      {
        key: "rate",
        header: "Rate",
        align: "right",
        render: (o) => (
          <span className="tabular-nums">
            {o.currentRatePct ? `${o.currentRatePct}% → ` : ""}
            {o.newRatePct}%
          </span>
        ),
      },
      {
        key: "payment",
        header: "Principal and interest",
        align: "right",
        render: (o) =>
          o.currentPaymentCents && o.newPaymentCents ? (
            <span className="tabular-nums">
              {money(o.currentPaymentCents)} → {money(o.newPaymentCents)}
            </span>
          ) : (
            <span className="text-fg-3">—</span>
          ),
      },
      {
        key: "savings",
        header: "Saved a month",
        align: "right",
        render: (o) => (
          <span className="tabular-nums font-medium text-fg">{money(o.monthlySavingsCents)}</span>
        ),
      },
      {
        key: "standing",
        header: "Standing",
        render: (o) => offerCell(o),
      },
      {
        key: "answered",
        header: "Answered",
        render: (o) => (o.answeredAt ? fmtDate(o.answeredAt) : "—"),
      },
    ],
    [],
  );

  if (page.isPending) return <Loading what="Opening the loan" />;
  if (page.isError || !page.data) {
    const missing = page.error instanceof PortalError && page.error.status === 404;
    return (
      <Page title="Loan" back={{ to: "/portal", label: "Loans" }}>
        {missing ? (
          <EmptyState icon="home" title="No loan here">
            There is no loan by that id on your book.
          </EmptyState>
        ) : (
          <Notice tone="danger" title="The loan could not be read">
            Try again in a moment.
          </Notice>
        )}
      </Page>
    );
  }

  const loan = page.data;
  const tape = loan.tapes[0] ?? null;
  const review = loan.reviews[0] ?? null;
  const address = addressLines(loan.address);

  return (
    <Page
      title={<span className="font-mono">{loan.number}</span>}
      back={{ to: "/portal", label: "Loans" }}
      description={[loan.borrower, address].filter(Boolean).join(" · ") || undefined}
      meta={`${stateWord(loan.state)} · watched since ${fmtDate(loan.watchedSince)}`}
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Balance"
          value={tape ? money(tape.principalBalanceCents) : "—"}
          hint={tape ? `tape as of ${fmtDate(tape.asOf)}` : "no tape yet"}
        />
        <Stat
          label="Rate"
          value={`${tape?.currentRatePct ?? loan.terms.noteRatePct}%`}
          hint={loan.terms.rateType === "arm" ? "adjustable" : "fixed"}
        />
        <Stat
          label="Latest review"
          value={review ? verdictWord(review.verdict as Verdict) : "Not yet"}
          tone={review?.verdict === "candidate" ? "ok" : undefined}
          hint={review ? fmtDate(review.asOf) : "reviewed each morning"}
        />
        <Stat
          label="Status on the tape"
          value={tape ? tapeStatus(tape.status).word : "—"}
          tone={tape?.status === "delinquent" ? "warn" : undefined}
          hint={
            tape?.delinquencyDays
              ? `${plural(tape.delinquencyDays, "day")} late`
              : tape?.nextPaymentDueOn
                ? `next due ${fmtDate(tape.nextPaymentDueOn)}`
                : undefined
          }
        />
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-2 [&>section]:mt-0">
        <Section title="The loan">
          <div className="rounded-lg border border-line-2 bg-surface px-4">
            <Rows
              rows={[
                { label: "Borrower", value: loan.borrower ?? "—" },
                { label: "Property", value: address ?? "—" },
                { label: "Note rate", value: `${loan.terms.noteRatePct}%` },
                { label: "Original principal", value: money(loan.terms.originalPrincipalCents) },
                { label: "Term", value: termWord(loan.terms.termMonths) },
                {
                  label: "Originated",
                  value: loan.terms.originatedOn ? fmtDate(loan.terms.originatedOn) : "—",
                },
                {
                  label: "Matures",
                  value: loan.terms.maturityOn ? fmtDate(loan.terms.maturityOn) : "—",
                },
              ]}
            />
          </div>
        </Section>

        <Section title="The homeowner">
          <div className="rounded-lg border border-line-2 bg-surface px-4">
            <Rows
              rows={[
                { label: "Invitation", value: claimCell(loan.claim, loan.state) },
                { label: "Sent to", value: loan.claim?.deliveredTo ?? "—" },
                {
                  label: "Sent",
                  value: loan.claim?.deliveredAt ? fmtDate(loan.claim.deliveredAt) : "—",
                },
                {
                  label: "Claimed",
                  value: loan.claim?.acceptedAt ? fmtDate(loan.claim.acceptedAt) : "—",
                },
                { label: "Standing with us", value: stateWord(loan.state) },
              ]}
            />
          </div>
          <p className="mt-3 text-sm text-fg-3">
            Supermortgage sends the invitation. An offer reaches the homeowner once they have
            claimed their mortgage from it.
          </p>
        </Section>
      </div>

      <Section
        title="Offers"
        aside={loan.offers.length ? plural(loan.offers.length, "offer") : undefined}
      >
        {loan.offers.length ? (
          <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
            <Table columns={offerColumns} rows={loan.offers} rowKey={(o) => o.id} dense />
          </div>
        ) : (
          <Notice tone="neutral">
            No offer has been made on this loan. One is made the morning a review finds the loan a
            candidate.
          </Notice>
        )}
      </Section>

      <Section
        title="Daily review"
        aside={loan.reviews.length ? `${plural(loan.reviews.length, "morning")} shown` : undefined}
      >
        {loan.reviews.length ? (
          <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
            <Table columns={reviewColumns} rows={loan.reviews} rowKey={(r) => r.asOf} dense />
          </div>
        ) : (
          <Notice tone="neutral">
            Not yet reviewed. Every loan on the book is reviewed each morning against that
            day&rsquo;s rate.
          </Notice>
        )}
      </Section>

      <Section
        title="Tape history"
        aside={loan.tapes.length ? plural(loan.tapes.length, "tape") : undefined}
      >
        {loan.tapes.length ? (
          <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
            <Table
              columns={tapeColumns}
              rows={loan.tapes}
              rowKey={(t) => String(loan.tapes.indexOf(t))}
              dense
            />
          </div>
        ) : (
          <Notice tone="neutral">No tape has described this loan yet.</Notice>
        )}
      </Section>
    </Page>
  );
}
