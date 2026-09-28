/**
 * The servicer's book as their team sees it: every loan we hold for them,
 * what the newest review found, the offer if one was made, and where the
 * homeowner's invitation stands. Read-only, a page at a time.
 */

import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Page } from "../../components/Page.js";
import { Table, type Column } from "../../components/Table.js";
import { Button, Input, Notice, Pill, Stat } from "../../components/ui.js";
import { Loading } from "../../components/Loading.js";
import { fmtDate, plural } from "../../lib/format.js";
import { verdictTone, verdictWord, type Verdict } from "../../lib/tape.js";
import { portal, PORTAL_PAGE, type PortalBook, type PortalLoan } from "../api.js";

const STATE_WORDS: Record<string, string> = {
  imported_unclaimed: "Not yet claimed",
  monitoring_only: "Claimed",
  refinancing: "Refinancing",
  paid_off: "Paid off",
  refinanced: "Refinanced",
};
const stateWord = (s: string) => STATE_WORDS[s] ?? s.replace(/_/g, " ");

const money = (cents: string | null) =>
  cents === null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(Number(cents) / 100);

function offerCell(o: PortalLoan["offer"]): ReactNode {
  if (!o) return <span className="text-fg-3">—</span>;
  switch (o.status) {
    case "offered":
      return o.deliveredAt ? (
        <span>Open until {o.validUntil ? fmtDate(o.validUntil) : "—"}</span>
      ) : (
        <span className="text-fg-2">Made, waiting for the claim</span>
      );
    case "engaged":
      return <Pill tone="ok">Said yes</Pill>;
    case "declined":
      return <Pill tone="warn">Not now</Pill>;
    case "opted_out":
      return <Pill tone="neutral">Never</Pill>;
    case "expired":
      return <span className="text-fg-3">Lapsed</span>;
    default:
      return <span>{o.status}</span>;
  }
}

function claimCell(c: PortalLoan["claim"], state: string): ReactNode {
  if (state !== "imported_unclaimed" && c?.acceptedAt) return <Pill tone="ok">Taken</Pill>;
  if (state !== "imported_unclaimed") return <Pill tone="ok">Claimed</Pill>;
  if (!c) return <span className="text-fg-3">Not invited</span>;
  if (c.acceptedAt) return <Pill tone="ok">Taken</Pill>;
  if (c.deliveredAt) return <span>Invited {fmtDate(c.deliveredAt)}</span>;
  return <span className="text-fg-2">Link minted, not yet delivered</span>;
}

export function BookPage() {
  const book = useQuery({ queryKey: ["portal-book"], queryFn: () => portal<PortalBook>("/book") });
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const needle = q.trim();
  const loans = useQuery({
    queryKey: ["portal-loans", needle, offset],
    queryFn: () =>
      portal<{ total: number; rows: PortalLoan[] }>("/book/loans", {
        query: { q: needle, offset, limit: PORTAL_PAGE },
      }),
  });

  const columns = useMemo<Column<PortalLoan>[]>(
    () => [
      { key: "number", header: "Loan", render: (r) => r.number, mono: true, primary: true },
      { key: "borrower", header: "Borrower", render: (r) => r.borrower ?? "—" },
      { key: "property", header: "Property", render: (r) => r.property ?? "—" },
      {
        key: "balance",
        header: "Balance",
        align: "right",
        render: (r) => <span className="tabular-nums">{money(r.balanceCents)}</span>,
      },
      {
        key: "rate",
        header: "Rate",
        align: "right",
        render: (r) => <span className="tabular-nums">{r.noteRatePct}%</span>,
      },
      {
        key: "review",
        header: "Review",
        render: (r) =>
          r.review ? (
            <span className="inline-flex items-center gap-2">
              <Pill tone={verdictTone(r.review.verdict as Verdict)}>
                {verdictWord(r.review.verdict as Verdict)}
              </Pill>
              <span className="text-xs text-fg-3">{fmtDate(r.review.asOf)}</span>
            </span>
          ) : (
            <span className="text-fg-3">Not yet reviewed</span>
          ),
      },
      { key: "offer", header: "Offer", render: (r) => offerCell(r.offer) },
      { key: "claim", header: "Homeowner", render: (r) => claimCell(r.claim, r.state) },
      { key: "state", header: "Standing", render: (r) => stateWord(r.state) },
    ],
    [],
  );

  if (book.isPending) return <Loading what="Opening your book" />;
  if (book.isError || !book.data) {
    return (
      <Page title="Your book">
        <Notice tone="danger" title="The book could not be read">
          {book.error instanceof Error ? book.error.message : "Try again in a moment."}
        </Notice>
      </Page>
    );
  }
  const b = book.data.book;
  const verdicts = b.analysis?.verdicts ?? {};
  const total = loans.data?.total ?? b.loans.total;
  const shownFrom = total === 0 ? 0 : offset + 1;
  const shownTo = Math.min(offset + PORTAL_PAGE, total);

  return (
    <Page
      title={`${book.data.servicer.displayName}'s book`}
      description={
        b.lastAsOf
          ? `${plural(b.loans.total, "loan")} · tape as of ${fmtDate(b.lastAsOf)}${
              b.analysis ? ` · reviewed ${fmtDate(b.analysis.asOf)}` : ""
            }`
          : "No tape loaded yet."
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Loans" value={b.loans.total.toLocaleString()} />
        <Stat
          label="Candidates"
          value={(verdicts.candidate ?? 0).toLocaleString()}
          tone={verdicts.candidate ? "ok" : "neutral"}
        />
        <Stat label="Watching" value={(verdicts.watching ?? 0).toLocaleString()} />
        <Stat label="Not now" value={(verdicts.not_now ?? 0).toLocaleString()} />
        <Stat label="Excluded" value={(verdicts.excluded ?? 0).toLocaleString()} />
      </div>

      <Notice tone="info" className="mt-6">
        Supermortgage reviews every loan here each morning against that day&rsquo;s rate. A
        candidate is a loan worth an offer; the offer reaches the homeowner once they have claimed
        their mortgage from the invitation Supermortgage sends.
      </Notice>

      <div className="mt-6 space-y-3">
        <Input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOffset(0);
          }}
          placeholder="Find a loan by number or city"
          aria-label="Find a loan"
          className="w-full max-w-md"
        />
        {loans.isPending ? (
          <Loading what="Reading the loans" />
        ) : loans.isError ? (
          <Notice tone="danger">The loans could not be read. Try again.</Notice>
        ) : (
          <>
            <Table columns={columns} rows={loans.data.rows} rowKey={(r) => r.id} dense />
            <div className="flex flex-wrap items-center gap-3 text-sm text-fg-2">
              <span>
                {total === 0
                  ? needle
                    ? "No loan matches."
                    : "No loans yet."
                  : `Showing ${shownFrom.toLocaleString()}–${shownTo.toLocaleString()} of ${plural(total, "loan")}${needle ? " that match" : ""}`}
              </span>
              {offset > 0 ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setOffset(Math.max(0, offset - PORTAL_PAGE))}
                >
                  Previous
                </Button>
              ) : null}
              {shownTo < total ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setOffset(offset + PORTAL_PAGE)}
                >
                  Next {Math.min(PORTAL_PAGE, total - shownTo).toLocaleString()}
                </Button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </Page>
  );
}
