/**
 * The servicers we hold a book for, and each one's team.
 *
 * The list is where a book stands — loans, the last tape, the last review,
 * who on their side can see it — and the page behind each row is the
 * team: who was invited, who took it, and a box to invite more. The desk
 * loads the book; this is where a servicer's people are managed any day
 * after, without walking a load again.
 */

import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Page } from "../components/Page.js";
import { ServicerTeam } from "../components/ServicerTeam.js";
import { Table, type Column } from "../components/Table.js";
import { Button, EmptyState, Notice, Stat } from "../components/ui.js";
import { Loading } from "../components/Loading.js";
import { fmtDate, plural } from "../lib/format.js";
import { deskServicers, type DeskServicer } from "../lib/tape.js";

const useServicers = () =>
  useQuery({ queryKey: ["desk-servicers"], queryFn: () => deskServicers() });

export function ServicersPage() {
  const servicers = useServicers();
  const columns = useMemo<Column<DeskServicer>[]>(
    () => [
      {
        key: "name",
        header: "Servicer",
        primary: true,
        render: (s) => (
          <Link to={`/servicers/${s.slug}`} className="font-medium text-fg hover:underline">
            {s.displayName}
          </Link>
        ),
      },
      {
        key: "loans",
        header: "Loans",
        align: "right",
        render: (s) => <span className="tabular-nums">{s.book.loans.total.toLocaleString()}</span>,
      },
      {
        key: "tape",
        header: "Last tape",
        render: (s) => (s.book.lastAsOf ? fmtDate(s.book.lastAsOf) : "—"),
      },
      {
        key: "reviewed",
        header: "Reviewed",
        render: (s) => (s.book.analysis ? fmtDate(s.book.analysis.asOf) : "—"),
      },
      {
        key: "team",
        header: "Team",
        render: (s) =>
          s.team.active + s.team.invited === 0 ? (
            <span className="text-fg-3">Nobody invited</span>
          ) : (
            <span>
              {plural(s.team.active, "member")}
              {s.team.invited ? `, ${s.team.invited} invited` : ""}
            </span>
          ),
      },
      {
        key: "open",
        header: "",
        align: "right",
        hideOnCard: true,
        render: (s) => (
          <Link to={`/servicers/${s.slug}`}>
            <Button size="sm" variant="secondary">
              Team
            </Button>
          </Link>
        ),
      },
    ],
    [],
  );

  return (
    <Page
      title="Servicers"
      description="Every servicer we hold a book for, and who on their side can see it."
      actions={
        <Link to="/tape">
          <Button variant="primary">Load a tape</Button>
        </Link>
      }
    >
      {servicers.isPending ? (
        <Loading what="Reading the servicers" />
      ) : servicers.isError ? (
        <Notice tone="danger">The servicers could not be read.</Notice>
      ) : servicers.data.length === 0 ? (
        <EmptyState icon="book" title="No servicer yet">
          A servicer appears here the first time a tape of theirs is loaded at the desk.
        </EmptyState>
      ) : (
        <Table columns={columns} rows={servicers.data} rowKey={(s) => s.slug} />
      )}
    </Page>
  );
}

export function ServicerPage() {
  const { slug } = useParams();
  const servicers = useServicers();
  const servicer = servicers.data?.find((s) => s.slug === slug) ?? null;

  if (servicers.isPending) return <Loading what="Reading the servicer" />;
  if (!servicer) {
    return (
      <Page title="No such servicer" back={{ to: "/servicers", label: "Servicers" }}>
        <EmptyState icon="book" title="Nothing here by that name">
          It may have been loaded under a different slug.
        </EmptyState>
      </Page>
    );
  }
  const b = servicer.book;
  return (
    <Page
      title={servicer.displayName}
      back={{ to: "/servicers", label: "Servicers" }}
      description={
        b.lastAsOf
          ? `${plural(b.loans.total, "loan")} · tape as of ${fmtDate(b.lastAsOf)}${
              b.analysis ? ` · reviewed ${fmtDate(b.analysis.asOf)}` : ""
            }`
          : "No tape loaded yet."
      }
      actions={
        <Link to="/tape">
          <Button variant="secondary">Load a tape</Button>
        </Link>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Loans" value={b.loans.total.toLocaleString()} />
        <Stat
          label="Candidates"
          value={(b.analysis?.verdicts.candidate ?? 0).toLocaleString()}
          tone={b.analysis?.verdicts.candidate ? "ok" : "neutral"}
        />
        <Stat label="Team" value={servicer.team.active.toLocaleString()} hint="signed in" />
        <Stat label="Invited" value={servicer.team.invited.toLocaleString()} hint="not yet taken" />
      </div>

      <section className="mt-8 space-y-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-fg">Their team</h2>
          <p className="mt-1 max-w-prose text-sm text-fg-2">
            Each person gets a link, good for seven days, that sets their password; from then on
            they sign in at the servicing host with a code to their e-mail and that password, and
            see this book at the partner portal: every loan, the review&rsquo;s verdict, the offer
            and where each homeowner&rsquo;s invitation stands. Members can invite colleagues
            themselves once they are in.
          </p>
        </div>
        <ServicerTeam servicer={{ slug: servicer.slug, displayName: servicer.displayName }} />
      </section>
    </Page>
  );
}
