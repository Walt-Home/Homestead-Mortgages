/**
 * The partner book: the loans each servicer sends on tape, as our loans
 * database holds them — the book the tape desk writes. Each loan with the
 * newest review's verdict, the offer and where the homeowner's invitation
 * stands, and every tape the book was built from, reconciled against it.
 *
 * It reads our own door and nothing of the servicing app's. The servicing
 * app keeps a partner book of its own, on its own database, which a tape
 * loaded at the desk never reaches: this page read that one until 26
 * October 2026, when a book of two thousand loans was loaded on production
 * and the page showed none of them.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Page, Section } from "../components/Page.js";
import { Sheet } from "../components/Sheet.js";
import { Table, type Column } from "../components/Table.js";
import { TapeReconciliation } from "../components/TapeReconciliation.js";
import {
  Button,
  EmptyState,
  Input,
  Notice,
  Pill,
  Rows,
  Segmented,
  Select,
  Spinner,
  Stat,
} from "../components/ui.js";
import { Loading } from "../components/Loading.js";
import { fmtDate, money, plural } from "../lib/format.js";
import { BOOK_PAGE, bookLoan, bookLoans, type BookLoan } from "../lib/book.js";
import { deskServicers, verdictTone, verdictWord, type Verdict } from "../lib/tape.js";
import { claimCell, offerCell, stateWord } from "../partners/pages/BookPage.js";
import { addressLines, sentence, tapeStatus, termWord } from "../partners/pages/LoanPage.js";

type Tab = "loans" | "tapes";

const verdictPill = (v: string) => (
  <Pill tone={verdictTone(v as Verdict)}>{verdictWord(v as Verdict)}</Pill>
);

export function PartnerBookPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const servicers = useQuery({ queryKey: ["desk-servicers"], queryFn: () => deskServicers() });
  const list = servicers.data ?? [];
  const slug = list.find((s) => s.slug === params.get("servicer"))?.slug ?? list[0]?.slug ?? "";
  const chosen = list.find((s) => s.slug === slug) ?? null;
  const tab: Tab = params.get("tab") === "tapes" ? "tapes" : "loans";
  const set = (next: { servicer?: string; tab?: Tab }) =>
    setParams(
      (p) => {
        const out = new URLSearchParams(p);
        if (next.servicer !== undefined) out.set("servicer", next.servicer);
        if (next.tab !== undefined) {
          if (next.tab === "loans") out.delete("tab");
          else out.set("tab", next.tab);
        }
        return out;
      },
      { replace: true },
    );

  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<BookLoan | null>(null);
  const needle = q.trim();
  // Another servicer is another book: its paging and search start over.
  useEffect(() => {
    setQ("");
    setOffset(0);
    setSelected(null);
  }, [slug]);
  const loans = useQuery({
    queryKey: ["servicer-book-loans", slug, needle, offset],
    queryFn: () => bookLoans(slug, { q: needle, offset, limit: BOOK_PAGE }),
    enabled: slug !== "" && tab === "loans",
    // The page a reader was on stays up while the next arrives; another servicer's never does.
    placeholderData: (previous, query) => (query?.queryKey[1] === slug ? previous : undefined),
  });

  const columns = useMemo<Column<BookLoan>[]>(
    () => [
      { key: "number", header: "Loan", render: (r) => r.number, mono: true, primary: true },
      { key: "borrower", header: "Borrower", render: (r) => r.borrower ?? "—" },
      { key: "property", header: "City", render: (r) => r.property ?? "—" },
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
              {verdictPill(r.review.verdict)}
              <span className="text-xs text-fg-3">{fmtDate(r.review.asOf)}</span>
            </span>
          ) : (
            <span className="text-fg-3">Not yet reviewed</span>
          ),
      },
      { key: "offer", header: "Offer", render: (r) => offerCell(r.offer) },
      { key: "claim", header: "Homeowner", render: (r) => claimCell(r.claim, r.state) },
    ],
    [],
  );

  const actions = (
    <>
      {list.length > 1 ? (
        <Select
          value={slug}
          onChange={(e) => set({ servicer: e.target.value })}
          aria-label="Servicer"
          className="w-64"
        >
          {list.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.displayName}
            </option>
          ))}
        </Select>
      ) : null}
      <Button variant="primary" icon="plus" onClick={() => navigate("/tape")}>
        Load a tape
      </Button>
    </>
  );

  if (servicers.isPending) return <Loading what="Reading the book" />;
  if (servicers.isError) {
    return (
      <Page title="Partner book" actions={actions}>
        <Notice tone="danger" title="The book could not be read">
          {(servicers.error as Error).message}
        </Notice>
      </Page>
    );
  }
  if (!chosen) {
    return (
      <Page title="Partner book" actions={actions}>
        <EmptyState icon="book" title="No book yet">
          Load a servicer&rsquo;s tape at the desk, and its loans are here.
        </EmptyState>
      </Page>
    );
  }

  const b = chosen.book;
  const verdicts = b.analysis?.verdicts;
  const total = loans.data?.total ?? b.loans.total;
  const shownFrom = total === 0 ? 0 : offset + 1;
  const shownTo = Math.min(offset + BOOK_PAGE, total);

  return (
    <Page
      title="Partner book"
      description="The loans servicers send on tape, the review run over them each morning, and every tape the book was built from."
      meta={
        <>
          <Link to={`/servicers/${chosen.slug}`} className="hover:underline">
            {chosen.displayName}
          </Link>
          {b.lastAsOf ? ` · tape as of ${fmtDate(b.lastAsOf)}` : " · no tape loaded yet"}
          {b.analysis ? ` · reviewed ${fmtDate(b.analysis.asOf)}` : ""}
        </>
      }
      actions={actions}
      wide
    >
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Loans" value={b.loans.total.toLocaleString()} />
        <Stat
          label="Tapes loaded"
          value={b.imports.toLocaleString()}
          hint={b.lastAsOf ? `newest as of ${fmtDate(b.lastAsOf)}` : "none yet"}
          onClick={() => set({ tab: "tapes" })}
        />
        <Stat
          label="Candidates"
          value={(verdicts?.candidate ?? 0).toLocaleString()}
          tone={verdicts?.candidate ? "ok" : undefined}
          hint={b.analysis ? `reviewed ${fmtDate(b.analysis.asOf)}` : "not yet reviewed"}
        />
        <Stat label="Watching" value={(verdicts?.watching ?? 0).toLocaleString()} />
        <Stat label="Not now" value={(verdicts?.not_now ?? 0).toLocaleString()} />
        <Stat label="Excluded" value={(verdicts?.excluded ?? 0).toLocaleString()} />
      </div>

      <Section>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <Segmented
            label="View"
            value={tab}
            onChange={(t) => set({ tab: t })}
            options={[
              { value: "loans", label: "Loans", count: b.loans.total },
              { value: "tapes", label: "Tapes", count: b.imports },
            ]}
          />
          {tab === "loans" ? (
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
          ) : null}
        </div>

        {tab === "loans" ? (
          <>
            <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
              <Table
                columns={columns}
                rows={loans.data?.rows}
                rowKey={(r) => r.id}
                onRowClick={setSelected}
                loading={loans.isLoading}
                dense
                empty={{
                  icon: "book",
                  title: needle ? `Nothing matches “${needle}”` : "No loans on the book",
                }}
              />
            </div>
            {loans.isError ? (
              <Notice tone="danger" className="mt-3">
                {(loans.error as Error).message}
              </Notice>
            ) : (
              <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-fg-2">
                <span>
                  {total === 0
                    ? ""
                    : `Showing ${shownFrom.toLocaleString()}–${shownTo.toLocaleString()} of ${plural(total, "loan")}${needle ? " that match" : ""}`}
                </span>
                {loans.isFetching && !loans.isLoading ? <Spinner /> : null}
                {offset > 0 ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setOffset(Math.max(0, offset - BOOK_PAGE))}
                  >
                    Previous
                  </Button>
                ) : null}
                {shownTo < total ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setOffset(offset + BOOK_PAGE)}
                  >
                    Next {Math.min(BOOK_PAGE, total - shownTo).toLocaleString()}
                  </Button>
                ) : null}
              </div>
            )}
          </>
        ) : (
          <TapeReconciliation slug={chosen.slug} />
        )}
      </Section>

      {selected ? (
        <BookLoanSheet
          slug={chosen.slug}
          servicerName={chosen.displayName}
          loan={selected}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </Page>
  );
}

/** One loan, whole: what its tapes said, each morning's verdict and why, the offers, the claim. */
function BookLoanSheet({
  slug,
  servicerName,
  loan,
  onClose,
}: {
  slug: string;
  servicerName: string;
  loan: BookLoan;
  onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: ["servicer-book-loan", slug, loan.id],
    queryFn: () => bookLoan(slug, loan.id),
  });
  const d = detail.data ?? null;
  const tape = d?.tapes[0] ?? null;
  const review = d?.reviews[0] ?? null;
  const address = d ? addressLines(d.address) : null;

  return (
    <Sheet
      open
      onClose={onClose}
      title={<span className="font-mono">{loan.number}</span>}
      subtitle={[loan.borrower, loan.property, servicerName].filter(Boolean).join(" · ")}
      wide
    >
      {detail.isPending ? (
        <div className="flex items-center gap-2 py-6 text-sm text-fg-2">
          <Spinner /> Reading the loan…
        </div>
      ) : detail.isError || !d ? (
        <Notice tone="danger" title="The loan could not be read">
          {detail.error instanceof Error ? detail.error.message : "Try again in a moment."}
        </Notice>
      ) : (
        <div className="space-y-6">
          <Rows
            rows={[
              { label: "Standing", value: stateWord(d.state) },
              {
                label: "Balance",
                value: tape
                  ? `${money(tape.principalBalanceCents)} as of ${fmtDate(tape.asOf)}`
                  : "—",
              },
              {
                label: "Rate",
                value: `${tape?.currentRatePct ?? d.terms.noteRatePct}% ${
                  d.terms.rateType === "arm" ? "adjustable" : "fixed"
                }`,
              },
              {
                label: "Status on the tape",
                value: tape ? (
                  <Pill tone={tapeStatus(tape.status).tone}>{tapeStatus(tape.status).word}</Pill>
                ) : (
                  "—"
                ),
              },
              { label: "Property", value: address ?? "—" },
              { label: "Original principal", value: money(d.terms.originalPrincipalCents) },
              { label: "Term", value: termWord(d.terms.termMonths) },
              {
                label: "Originated",
                value: d.terms.originatedOn ? fmtDate(d.terms.originatedOn) : "—",
              },
              {
                label: "Matures",
                value: d.terms.maturityOn ? fmtDate(d.terms.maturityOn) : "—",
              },
              { label: "Watched since", value: fmtDate(d.watchedSince) },
            ]}
          />

          <div>
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-fg">
              Latest review
              {review ? verdictPill(review.verdict) : null}
              {review ? (
                <span className="text-xs font-normal text-fg-3">{fmtDate(review.asOf)}</span>
              ) : null}
            </div>
            {review ? (
              <p className="text-base text-fg-2">{sentence(review.reasons) || "—"}</p>
            ) : (
              <p className="text-base text-fg-3">
                Not yet reviewed. Every loan on the book is reviewed each morning against that
                day&rsquo;s rate.
              </p>
            )}
          </div>

          <div>
            <div className="mb-2 text-sm font-medium text-fg">The homeowner</div>
            <Rows
              rows={[
                { label: "Invitation", value: claimCell(d.claim, d.state) },
                { label: "Sent to", value: d.claim?.deliveredTo ?? "—" },
                {
                  label: "Sent",
                  value: d.claim?.deliveredAt ? fmtDate(d.claim.deliveredAt) : "—",
                },
                {
                  label: "Claimed",
                  value: d.claim?.acceptedAt ? fmtDate(d.claim.acceptedAt) : "—",
                },
              ]}
            />
          </div>

          <div>
            <div className="mb-2 text-sm font-medium text-fg">Offers</div>
            {d.offers.length ? (
              <Rows
                rows={d.offers.map((o) => ({
                  label: `${fmtDate(o.detectedOn)} · ${
                    o.currentRatePct ? `${o.currentRatePct}% → ` : ""
                  }${o.newRatePct}%${
                    o.monthlySavingsCents ? ` · ${money(o.monthlySavingsCents)} a month` : ""
                  }`,
                  value: offerCell(o),
                }))}
              />
            ) : (
              <p className="text-base text-fg-3">
                No offer has been made on this loan. One is made the morning a review finds it a
                candidate.
              </p>
            )}
          </div>

          {d.tapes.length ? (
            <div>
              <div className="mb-2 text-sm font-medium text-fg">
                What {plural(d.tapes.length, "tape")} said
              </div>
              <div className="overflow-hidden rounded-lg border border-line-2">
                <Table
                  dense
                  columns={[
                    { key: "asOf", header: "As of", primary: true, render: (t) => fmtDate(t.asOf) },
                    {
                      key: "status",
                      header: "Status",
                      render: (t) => (
                        <Pill tone={tapeStatus(t.status).tone}>{tapeStatus(t.status).word}</Pill>
                      ),
                    },
                    {
                      key: "balance",
                      header: "Balance",
                      align: "right",
                      render: (t) => (
                        <span className="tabular-nums">{money(t.principalBalanceCents)}</span>
                      ),
                    },
                    {
                      key: "late",
                      header: "Days late",
                      align: "right",
                      render: (t) => (
                        <span className="tabular-nums">{t.delinquencyDays ?? "—"}</span>
                      ),
                    },
                  ]}
                  rows={d.tapes}
                  rowKey={(t) => String(d.tapes.indexOf(t))}
                />
              </div>
            </div>
          ) : null}

          {d.reviews.length > 1 ? (
            <div>
              <div className="mb-2 text-sm font-medium text-fg">Earlier reviews</div>
              <Rows
                rows={d.reviews.slice(1, 8).map((r) => ({
                  label: fmtDate(r.asOf),
                  value: verdictPill(r.verdict),
                }))}
              />
            </div>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}
