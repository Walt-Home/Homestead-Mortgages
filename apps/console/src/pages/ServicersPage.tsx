/**
 * The servicers we hold a book for, and each one's team.
 *
 * The list is where a book stands — loans, the last tape, the last review,
 * who on their side can see it — and the page behind each row is the
 * team: who was invited, who took it, and a box to invite more. The desk
 * loads the book; this is where a servicer's people are managed any day
 * after, without walking a load again.
 *
 * A servicer can also be added here before its first tape, so that its
 * team is invited, its billing profile is filled and its bank account is
 * on file by the day the tape arrives; the desk's load then lands on it.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Page } from "../components/Page.js";
import { ServicerTeam } from "../components/ServicerTeam.js";
import { Sheet } from "../components/Sheet.js";
import { Table, type Column } from "../components/Table.js";
import { Button, EmptyState, Field, Input, Notice, Stat } from "../components/ui.js";
import { Loading } from "../components/Loading.js";
import { fmtDate, plural } from "../lib/format.js";
import { createServicer, deskServicers, slugify, type DeskServicer } from "../lib/tape.js";

const useServicers = () =>
  useQuery({ queryKey: ["desk-servicers"], queryFn: () => deskServicers() });

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Name a servicer ahead of its tape. The slug follows the name until somebody types one. */
function AddServicerSheet({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queries = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  useEffect(() => {
    if (!slugTouched) setSlug(slugify(displayName));
  }, [displayName, slugTouched]);
  const add = useMutation({
    mutationFn: () => createServicer({ slug, displayName: displayName.trim() }),
    onSuccess: async (made) => {
      await queries.invalidateQueries({ queryKey: ["desk-servicers"] });
      onClose();
      navigate(`/servicers/${made.slug}`);
    },
  });
  const valid = displayName.trim() !== "" && SLUG.test(slug);
  return (
    <Sheet
      open
      onClose={onClose}
      title="Add a servicer"
      subtitle="Before their first tape: invite their team, fill their billing profile and put their bank account on file. The first tape loads onto this servicer at the desk."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={add.isPending}
            disabled={!valid}
            onClick={() => add.mutate()}
          >
            Add servicer
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" htmlFor="servicer-name" hint="As their people and ours will read it.">
          <Input
            id="servicer-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Grander Mortgage Servicing"
          />
        </Field>
        <Field
          label="Slug"
          htmlFor="servicer-slug"
          hint="Lowercase letters, digits and hyphens. It keys their book and cannot be changed later."
          error={
            slug !== "" && !SLUG.test(slug) ? "Lowercase letters, digits and hyphens." : undefined
          }
        >
          <Input
            id="servicer-slug"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
          />
        </Field>
        {add.isError ? <Notice tone="danger">{(add.error as Error).message}</Notice> : null}
      </div>
    </Sheet>
  );
}

export function ServicersPage() {
  const servicers = useServicers();
  const [adding, setAdding] = useState(false);
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
        <>
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add a servicer
          </Button>
          <Link to="/tape">
            <Button variant="primary">Load a tape</Button>
          </Link>
        </>
      }
    >
      {servicers.isPending ? (
        <Loading what="Reading the servicers" />
      ) : servicers.isError ? (
        <Notice tone="danger">The servicers could not be read.</Notice>
      ) : servicers.data.length === 0 ? (
        <EmptyState icon="book" title="No servicer yet">
          Add one ahead of its first tape to set up its team, billing profile and bank account, or
          load a tape at the desk and the servicer is made with it.
        </EmptyState>
      ) : (
        <Table columns={columns} rows={servicers.data} rowKey={(s) => s.slug} />
      )}
      {adding ? <AddServicerSheet onClose={() => setAdding(false)} /> : null}
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
        <>
          <Link to={`/billing/${servicer.slug}`}>
            <Button variant="secondary">Billing</Button>
          </Link>
          <Link to="/tape">
            <Button variant="secondary">Load a tape</Button>
          </Link>
        </>
      }
    >
      {b.lastAsOf === null ? (
        <Notice tone="info" title="Ready before the first tape" className="mb-6">
          Nothing is billed until a tape is loaded. Until then: invite their team below, and on{" "}
          <Link to={`/billing/${servicer.slug}`} className="underline">
            Billing
          </Link>{" "}
          fill the billing profile and make the link for their bank account, which can take a few
          days to verify. The first tape loads onto this servicer at the desk.
        </Notice>
      ) : null}
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
