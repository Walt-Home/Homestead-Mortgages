/**
 * Loans: search by number, open one.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Page, Section } from "../components/Page.js";
import { Table, type Column } from "../components/Table.js";
import { Input, Notice, Pill, type Tone } from "../components/ui.js";
import { Icon } from "../components/Icon.js";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { fmtDate, shortId, words } from "../lib/format.js";

export interface LoanSummary {
  id: string;
  fnmaLoanNumber: string | null;
  servicerLoanNumber: string | null;
  status: string;
  partnerPartyId: string | null;
  boardedAt: string | null;
}

export const loanStatusTone = (s: string): Tone =>
  s === "active" || s === "monitored"
    ? "ok"
    : s === "staged"
      ? "info"
      : s === "paid_off"
        ? "neutral"
        : /charged|foreclos|reo/.test(s)
          ? "danger"
          : "neutral";

export function LoansPage() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const loans = useQuery({
    queryKey: ["loans", role, term],
    queryFn: () => api<LoanSummary[]>("/loans", { query: { q: term, limit: 50 } }),
  });
  const columns = useMemo<Column<LoanSummary>[]>(
    () => [
      {
        key: "number",
        header: "Servicer number",
        primary: true,
        render: (r) => (
          <span className="font-mono text-base font-medium text-fg">
            {r.servicerLoanNumber ?? shortId(r.id)}
          </span>
        ),
      },
      {
        key: "fnma",
        header: "FNMA number",
        mono: true,
        render: (r) => <span className="text-fg-2">{r.fnmaLoanNumber ?? "—"}</span>,
      },
      {
        key: "status",
        header: "Status",
        render: (r) => <Pill tone={loanStatusTone(r.status)}>{words(r.status)}</Pill>,
      },
      {
        key: "partner",
        header: "Partner",
        mono: true,
        render: (r) => (
          <span className="text-fg-2">{r.partnerPartyId ? shortId(r.partnerPartyId) : "—"}</span>
        ),
      },
      {
        key: "boarded",
        header: "Boarded",
        render: (r) => <span className="text-fg-2">{fmtDate(r.boardedAt)}</span>,
      },
    ],
    [],
  );
  return (
    <Page title="Loans" description="Every loan this platform holds, by number.">
      <Section>
        <form
          className="relative mb-3 max-w-md"
          onSubmit={(e) => {
            e.preventDefault();
            setTerm(q.trim());
          }}
        >
          <Icon
            name="search"
            size={18}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3"
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Servicer or FNMA loan number"
            className="pl-10"
            aria-label="Search loans"
          />
        </form>
        <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
          <Table
            columns={columns}
            rows={loans.data}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/loans/${r.id}`)}
            loading={loans.isLoading}
            empty={{ title: term ? `Nothing matches “${term}”` : "No loans yet" }}
          />
        </div>
        {loans.error ? (
          <Notice tone="danger" className="mt-3">
            {(loans.error as Error).message}
          </Notice>
        ) : null}
      </Section>
    </Page>
  );
}
