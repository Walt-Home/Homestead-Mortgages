/**
 * People and accounts (his 34.2 directory): every party with an account,
 * searchable, and each one's record with contact details masked until a
 * compliance or officer role unmasks them with a reason.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Page, Section } from "../components/Page.js";
import { Table, type Column } from "../components/Table.js";
import { Sheet } from "../components/Sheet.js";
import {
  Button,
  Field,
  Input,
  Notice,
  Pill,
  Rows,
  Segmented,
  Textarea,
  type Tone,
} from "../components/ui.js";
import { Icon } from "../components/Icon.js";
import { api, ApiError } from "../lib/api.js";
import { useAct } from "../lib/act.js";
import { roleWord, useAuth } from "../lib/auth.js";
import { fmtDateTime, fmtRelative, shortId, words } from "../lib/format.js";

interface Subject {
  loan_id: string | null;
  application_id: string | null;
  loan_last4: string | null;
  application_last4: string | null;
  status?: string;
  label?: string;
  stage?: string;
  status_badge?: string;
}
interface PersonRow {
  party_id: string;
  legal_name: string | null;
  name_state?: string;
  email: string | null;
  phone: string | null;
  origin: string;
  origin_label?: string;
  doors: string[];
  status: string;
  open_session?: boolean;
  signed_in_today?: boolean;
  verified?: boolean;
  stage?: string;
  subjects: Subject[];
  partner: { partner_party_id: string; partner_name: string } | null;
  created_at: string;
  last_seen_at: string | null;
}
interface ListAnswer {
  rows: PersonRow[];
  next: string | null;
  as_of: string;
}
interface SearchAnswer {
  count: number;
  results: (Pick<
    PersonRow,
    "party_id" | "legal_name" | "email" | "phone" | "origin" | "subjects"
  > & { partner_name?: string; matched_on: string[] })[];
  no_account_yet: { loan_id: string; loan_last4: string; partner_name: string; status: string }[];
}
interface Account {
  party_id: string;
  legal_name: string | null;
  created_at: string;
  origin: string;
  origin_kind?: string;
  doors: string[];
  partner: { partner_name?: string } | null;
  status: string;
  first_session_at: string | null;
  last_session_at: string | null;
  contact: {
    email: string | null;
    phone: string | null;
    city: string | null;
    state: string | null;
    unmasked: boolean;
  };
  identity: {
    ssn_last4: string | null;
    date_of_birth: string | null;
    on_file: boolean;
    unmasked: boolean;
  };
  subjects: Subject[];
  sessions: { started_at?: string; last_seen_at?: string; door?: string; [k: string]: unknown }[];
  mask: { contact: boolean; identity: boolean };
}
interface Activity {
  rows: { at: string; kind: string; actor: string; summary: string }[];
  count: number;
}

const stageTone = (s?: string): Tone =>
  s === "monitored" || s === "funded" || s === "boarded"
    ? "ok"
    : s === "lead" || s === "account"
      ? "neutral"
      : "info";

export function PeoplePage() {
  const { role } = useAuth();
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [stage, setStage] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["people", role, stage],
    queryFn: () =>
      api<ListAnswer>("/directory/list", {
        query: { tab: "accounts", sort: "last_seen", stage: stage === "all" ? undefined : stage },
      }),
    enabled: term.length < 3,
  });
  const search = useQuery({
    queryKey: ["people-search", role, term],
    queryFn: () => api<SearchAnswer>("/directory/search", { query: { q: term } }),
    enabled: term.length >= 3,
  });

  const rows: PersonRow[] | undefined =
    term.length >= 3
      ? search.data?.results.map((r) => ({
          party_id: r.party_id,
          legal_name: r.legal_name,
          email: r.email,
          phone: r.phone,
          origin: r.origin,
          doors: [],
          status: "",
          subjects: r.subjects,
          partner: r.partner_name ? { partner_party_id: "", partner_name: r.partner_name } : null,
          created_at: "",
          last_seen_at: null,
        }))
      : list.data?.rows;

  const columns = useMemo<Column<PersonRow>[]>(
    () => [
      {
        key: "who",
        header: "Person",
        primary: true,
        render: (r) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-fg">
              {r.legal_name ?? <span className="text-fg-3">No name yet</span>}
            </span>
            <span className="text-sm text-fg-2">
              {r.email ?? "—"}
              {r.phone ? ` · ${r.phone}` : ""}
            </span>
          </div>
        ),
      },
      {
        key: "origin",
        header: "Came in through",
        render: (r) => {
          const label = r.origin_label ?? words(r.origin);
          const partner = r.partner?.partner_name;
          return (
            <span className="text-fg-2">
              {label}
              {partner && !label.includes(partner) ? ` · ${partner}` : ""}
            </span>
          );
        },
      },
      {
        key: "stage",
        header: "Stage",
        render: (r) =>
          r.stage ? (
            <Pill tone={stageTone(r.stage)}>{words(r.stage)}</Pill>
          ) : (
            <span className="text-fg-3">—</span>
          ),
      },
      {
        key: "subjects",
        header: "Loans",
        render: (r) => (
          <span className="flex flex-wrap gap-1">
            {r.subjects.slice(0, 3).map((s, i) => (
              <span key={i} className="font-mono text-sm text-fg-2">
                {s.loan_last4 ?? s.application_last4 ?? "—"}
              </span>
            ))}
            {r.subjects.length > 3 ? (
              <span className="text-sm text-fg-3">+{r.subjects.length - 3}</span>
            ) : null}
          </span>
        ),
      },
      {
        key: "seen",
        header: "Last seen",
        render: (r) => (
          <span className="text-fg-2">{r.last_seen_at ? fmtRelative(r.last_seen_at) : "—"}</span>
        ),
      },
    ],
    [],
  );

  const error = (term.length >= 3 ? search.error : list.error) as ApiError | null;

  return (
    <Page title="People" description="Everyone with an account, and what each of them is here for.">
      <Section>
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center">
          <form
            className="relative w-full sm:max-w-sm"
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
              placeholder="Name, e-mail, or last four"
              className="pl-10"
              aria-label="Search people"
            />
          </form>
          {term.length < 3 ? (
            <Segmented
              label="Stage"
              value={stage}
              onChange={setStage}
              options={[
                { value: "all", label: "All" },
                { value: "lead", label: "Leads" },
                { value: "application", label: "Applying" },
                { value: "monitored", label: "Monitored" },
              ]}
            />
          ) : (
            <span className="text-sm text-fg-3">
              {search.data
                ? `${search.data.count} match${search.data.count === 1 ? "" : "es"}`
                : ""}
            </span>
          )}
        </div>
        <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
          <Table
            columns={columns}
            rows={rows}
            rowKey={(r) => r.party_id}
            onRowClick={(r) => setSelected(r.party_id)}
            loading={term.length >= 3 ? search.isLoading : list.isLoading}
            empty={{
              icon: "users",
              title: term.length >= 3 ? `Nobody matches “${term}”` : "No accounts yet",
            }}
          />
        </div>
        {error ? (
          <Notice tone={error.code === "NARROW_QUERY" ? "warn" : "danger"} className="mt-3">
            {error.code === "NARROW_QUERY"
              ? "Too many matches. Add more of the name or e-mail."
              : error.message}
          </Notice>
        ) : null}
        {search.data?.no_account_yet.length ? (
          <div className="mt-4">
            <div className="mb-2 text-sm font-medium text-fg">On a tape, no account yet</div>
            <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
              <Table
                columns={[
                  {
                    key: "loan",
                    header: "Loan",
                    primary: true,
                    render: (r) => <span className="font-mono text-fg">{r.loan_last4}</span>,
                  },
                  {
                    key: "partner",
                    header: "Partner",
                    render: (r) => <span className="text-fg-2">{r.partner_name}</span>,
                  },
                  {
                    key: "status",
                    header: "Status",
                    render: (r) => <Pill>{words(r.status)}</Pill>,
                  },
                ]}
                rows={search.data.no_account_yet}
                rowKey={(r) => r.loan_id}
              />
            </div>
          </div>
        ) : null}
      </Section>
      {selected ? <AccountSheet partyId={selected} onClose={() => setSelected(null)} /> : null}
    </Page>
  );
}

function AccountSheet({ partyId, onClose }: { partyId: string; onClose: () => void }) {
  const { role, holds } = useAuth();
  const [unmaskRole, setUnmaskRole] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [asking, setAsking] = useState(false);
  const readRole = unmaskRole ?? role ?? undefined;
  const account = useQuery({
    queryKey: ["account", readRole, partyId],
    queryFn: () => api<Account>(`/directory/accounts/${partyId}`, { role: readRole }),
  });
  const activity = useQuery({
    queryKey: ["activity", role, partyId],
    queryFn: () =>
      api<Activity>(`/directory/accounts/${partyId}/activity`, { query: { limit: 30 } }),
  });
  const act = useAct({
    invalidate: [["account"], ["activity"]],
    done: "Unmasked for fifteen minutes",
  });
  const a = account.data;
  const canUnmask = holds("compliance", "officer");

  const unmask = async () => {
    const r = holds("compliance") ? "compliance" : "officer";
    const ok = await act.run(`/directory/accounts/${partyId}/unmask`, {
      body: { fields: ["contact", "identity"], reason },
      role: r,
    });
    if (ok) {
      setUnmaskRole(r);
      setAsking(false);
      setReason("");
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={a?.legal_name ?? "Account"}
      subtitle={
        a
          ? `${words(a.origin)}${a.partner?.partner_name ? ` · ${a.partner.partner_name}` : ""} · ${words(a.status)}`
          : undefined
      }
      wide
      footer={
        canUnmask && a && (a.mask.contact || a.mask.identity) ? (
          asking ? (
            <>
              <Button variant="ghost" onClick={() => setAsking(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={act.busy}
                disabled={!reason.trim()}
                onClick={() => void unmask()}
              >
                Unmask
              </Button>
            </>
          ) : (
            <Button icon="eye" onClick={() => setAsking(true)}>
              Unmask contact and identity…
            </Button>
          )
        ) : undefined
      }
    >
      {account.error ? <Notice tone="danger">{(account.error as Error).message}</Notice> : null}
      {a ? (
        <div className="space-y-6">
          {asking ? (
            <Notice tone="warn" title="Unmasking is recorded and opens an escalation">
              <Field label="Why" htmlFor="why" className="mt-2">
                <Textarea
                  id="why"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="The reason, in a sentence."
                />
              </Field>
            </Notice>
          ) : null}
          <div>
            <div className="mb-2 text-sm font-medium text-fg">Contact</div>
            <Rows
              rows={[
                { label: "E-mail", value: a.contact.email ?? "—" },
                { label: "Phone", value: a.contact.phone ?? "—" },
                {
                  label: "Where",
                  value: [a.contact.city, a.contact.state].filter(Boolean).join(", ") || "—",
                },
                {
                  label: "Identity",
                  value: a.identity.on_file
                    ? `SSN ···${a.identity.ssn_last4 ?? "····"} · born ${a.identity.date_of_birth ?? "—"}`
                    : "Not on file",
                },
                { label: "Signs in with", value: a.doors.map(words).join(", ") || "—" },
                { label: "First seen", value: fmtDateTime(a.first_session_at ?? a.created_at) },
                {
                  label: "Last seen",
                  value: a.last_session_at ? fmtDateTime(a.last_session_at) : "—",
                },
              ]}
            />
            {a.mask.contact || a.mask.identity ? (
              <p className="mt-2 text-xs text-fg-3">
                Masked for {roleWord(role ?? "")}.{" "}
                {canUnmask ? "" : "Compliance or an officer can unmask with a reason."}
              </p>
            ) : null}
          </div>
          <div>
            <div className="mb-2 text-sm font-medium text-fg">Loans and applications</div>
            {a.subjects.length === 0 ? (
              <p className="text-base text-fg-2">None yet.</p>
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line-2">
                {a.subjects.map((s, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="text-base text-fg">
                        {s.label ?? (s.loan_id ? "Loan" : "Application")}{" "}
                        <span className="font-mono text-sm text-fg-2">
                          {s.loan_last4 ?? s.application_last4}
                        </span>
                      </div>
                      <div className="text-xs text-fg-3">
                        {[s.stage, s.status_badge ?? s.status]
                          .filter(Boolean)
                          .map((x) => words(String(x)))
                          .join(" · ")}
                      </div>
                    </div>
                    {s.loan_id ? (
                      <Link
                        to={`/loans/${s.loan_id}`}
                        className="text-sm font-medium text-fg-2 hover:text-fg"
                      >
                        Open
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <div className="text-sm font-medium text-fg">Activity</div>
              <div className="text-xs text-fg-3">
                {activity.data
                  ? `newest ${activity.data.rows.length} of ${activity.data.count}`
                  : ""}
              </div>
            </div>
            {activity.data?.rows.length ? (
              <ol className="space-y-2">
                {[...activity.data.rows].reverse().map((r, i) => (
                  <li key={i} className="flex gap-3 text-sm">
                    <span className="w-28 shrink-0 text-fg-3">{fmtDateTime(r.at)}</span>
                    <span className="min-w-0 flex-1 text-fg-2">
                      <span className="text-fg">{words(r.kind)}</span> · {r.summary}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-base text-fg-2">Nothing recorded.</p>
            )}
          </div>
          <div className="text-xs text-fg-3">Party {shortId(a.party_id, 36)}</div>
        </div>
      ) : null}
    </Sheet>
  );
}
