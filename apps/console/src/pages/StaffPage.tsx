/**
 * Staff and roles (his 34.1): who can sign in, with which roles; inviting
 * someone new; changing roles with a reason; disabling.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Page, Section } from "../components/Page.js";
import { Table } from "../components/Table.js";
import { Sheet } from "../components/Sheet.js";
import {
  Button,
  Checkbox,
  Field,
  Input,
  Notice,
  Pill,
  Rows,
  Textarea,
  type Tone,
} from "../components/ui.js";
import { api } from "../lib/api.js";
import { useAct } from "../lib/act.js";
import { roleWord, STAFF_ROLES, useAuth } from "../lib/auth.js";
import { fmtDateTime, fmtRelative, words } from "../lib/format.js";

export interface StaffUser {
  staff_user_id: string;
  legal_name: string | null;
  email_masked: string;
  roles: string[];
  status: "invited" | "active" | "disabled";
  invited_at: string | null;
  enrolled_at: string | null;
  disabled_at: string | null;
  locked_until: string | null;
  failed_signins: number;
  factors: string[];
  open_sessions: number;
}

const statusTone = (s: StaffUser["status"]): Tone =>
  s === "active" ? "ok" : s === "invited" ? "info" : "neutral";

export function StaffPage() {
  const { role, me } = useAuth();
  const [inviting, setInviting] = useState(false);
  const [selected, setSelected] = useState<StaffUser | null>(null);
  const q = useQuery({
    queryKey: ["staff", role],
    queryFn: () => api<{ users: StaffUser[] }>("/staff"),
  });
  return (
    <Page
      title="Staff & roles"
      description="Who can sign in here, and as what."
      actions={
        <Button variant="primary" icon="plus" onClick={() => setInviting(true)}>
          Invite
        </Button>
      }
    >
      <Section>
        <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
          <Table
            columns={[
              {
                key: "who",
                header: "Person",
                primary: true,
                render: (u) => (
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium text-fg">
                      {u.legal_name ?? "—"}
                      {u.staff_user_id === me?.staff_user_id ? (
                        <span className="ml-1.5 text-xs text-fg-3">you</span>
                      ) : null}
                    </span>
                    <span className="font-mono text-xs text-fg-3">{u.email_masked}</span>
                  </div>
                ),
              },
              {
                key: "roles",
                header: "Roles",
                render: (u) => (
                  <span className="flex flex-wrap gap-1">
                    {u.roles.map((r) => (
                      <Pill key={r}>{roleWord(r)}</Pill>
                    ))}
                  </span>
                ),
              },
              {
                key: "status",
                header: "Status",
                render: (u) => <Pill tone={statusTone(u.status)}>{words(u.status)}</Pill>,
              },
              {
                key: "factors",
                header: "Signs in with",
                render: (u) => (
                  <span className="text-fg-2">{u.factors.map(words).join(", ") || "—"}</span>
                ),
              },
              {
                key: "seen",
                header: "Sessions",
                align: "right",
                render: (u) => <span className="text-fg-2">{u.open_sessions}</span>,
              },
            ]}
            rows={q.data?.users}
            rowKey={(u) => u.staff_user_id}
            onRowClick={setSelected}
            loading={q.isLoading}
            empty={{ icon: "users", title: "Nobody yet" }}
          />
        </div>
        {q.error ? (
          <Notice tone="danger" className="mt-3">
            {(q.error as Error).message}
          </Notice>
        ) : null}
      </Section>
      {inviting ? <InviteSheet onClose={() => setInviting(false)} /> : null}
      {selected ? (
        <PersonSheet
          user={selected}
          onClose={() => setSelected(null)}
          self={selected.staff_user_id === me?.staff_user_id}
        />
      ) : null}
    </Page>
  );
}

function RolePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {STAFF_ROLES.map((r) => (
        <Checkbox
          key={r}
          label={roleWord(r)}
          checked={value.includes(r)}
          onChange={(e) =>
            onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))
          }
        />
      ))}
    </div>
  );
}

function InviteSheet({ onClose }: { onClose: () => void }) {
  const act = useAct({ invalidate: [["staff"]], done: "Invited" });
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [roles, setRoles] = useState<string[]>(["ops_analyst"]);
  const [rationale, setRationale] = useState("");
  const invite = async () => {
    const ok = await act.run("/staff/invite", {
      body: {
        email: email.trim(),
        legal_name: name.trim() || undefined,
        roles,
        rationale: rationale || undefined,
      },
      role: "admin",
    });
    if (ok) onClose();
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title="Invite someone"
      subtitle="They get a code by e-mail, set a password, and are in."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={act.busy}
            disabled={!email.includes("@") || roles.length === 0}
            onClick={() => void invite()}
          >
            Send invitation
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="E-mail" htmlFor="inv-email">
          <Input
            id="inv-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="colleague@trywalt.ai"
          />
        </Field>
        <Field label="Name" htmlFor="inv-name" hint="As it should appear on what they do.">
          <Input id="inv-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Roles" hint="Admin invites and changes roles; the other three do the work.">
          <RolePicker value={roles} onChange={setRoles} />
        </Field>
        <Field label="Why (optional)" htmlFor="inv-why">
          <Textarea id="inv-why" value={rationale} onChange={(e) => setRationale(e.target.value)} />
        </Field>
        <Notice tone="neutral">
          On this deployment no mail leaves: the invitee reads the code off the sign-in page
          instead.
        </Notice>
      </div>
    </Sheet>
  );
}

function PersonSheet({
  user,
  onClose,
  self,
}: {
  user: StaffUser;
  onClose: () => void;
  self: boolean;
}) {
  const act = useAct({ invalidate: [["staff"]], done: "Saved" });
  const [roles, setRoles] = useState<string[]>(user.roles);
  const [rationale, setRationale] = useState("");
  const [disabling, setDisabling] = useState(false);
  const changed = roles.length !== user.roles.length || roles.some((r) => !user.roles.includes(r));
  const save = async () => {
    const ok = await act.run(`/staff/${user.staff_user_id}/roles`, {
      method: "PUT",
      body: { roles, rationale },
      role: "admin",
    });
    if (ok) onClose();
  };
  const disable = async () => {
    const ok = await act.run(`/staff/${user.staff_user_id}/disable`, {
      body: { rationale },
      role: "admin",
    });
    if (ok) onClose();
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={user.legal_name ?? user.email_masked}
      subtitle={
        <span className="inline-flex gap-2">
          <Pill tone={statusTone(user.status)}>{words(user.status)}</Pill>
          <span className="font-mono text-xs">{user.email_masked}</span>
        </span>
      }
      footer={
        disabling ? (
          <>
            <Button variant="ghost" onClick={() => setDisabling(false)}>
              Keep
            </Button>
            <Button
              variant="danger"
              loading={act.busy}
              disabled={!rationale.trim()}
              onClick={() => void disable()}
            >
              Disable account
            </Button>
          </>
        ) : (
          <>
            {user.status !== "disabled" && !self ? (
              <Button variant="danger" onClick={() => setDisabling(true)}>
                Disable…
              </Button>
            ) : null}
            <Button
              variant="primary"
              loading={act.busy}
              disabled={!changed || !rationale.trim() || self}
              onClick={() => void save()}
            >
              Save roles
            </Button>
          </>
        )
      }
    >
      <Rows
        rows={[
          { label: "Invited", value: user.invited_at ? fmtDateTime(user.invited_at) : "—" },
          {
            label: "Enrolled",
            value: user.enrolled_at ? fmtDateTime(user.enrolled_at) : "Not yet",
          },
          { label: "Signs in with", value: user.factors.map(words).join(", ") || "—" },
          { label: "Open sessions", value: user.open_sessions },
          ...(user.locked_until
            ? [{ label: "Locked", value: `until ${fmtRelative(user.locked_until)}` }]
            : []),
          ...(user.failed_signins
            ? [{ label: "Failed sign-ins", value: user.failed_signins }]
            : []),
        ]}
      />
      {user.status === "invited" ? (
        <Notice tone="info" className="mt-4">
          Invited and not yet enrolled. They set their password the first time they sign in.
        </Notice>
      ) : null}
      {!self ? (
        <div className="mt-5 space-y-4">
          <Field label="Roles">
            <RolePicker value={roles} onChange={setRoles} />
          </Field>
          <Field
            label={disabling ? "Why disable" : "Why the change"}
            htmlFor="why"
            hint="Recorded with your name."
          >
            <Textarea id="why" value={rationale} onChange={(e) => setRationale(e.target.value)} />
          </Field>
        </div>
      ) : (
        <Notice tone="neutral" className="mt-4">
          Your own roles are changed by another admin, never by you.
        </Notice>
      )}
      {act.error ? (
        <Notice tone="danger" className="mt-4">
          {act.error.message}
        </Notice>
      ) : null}
    </Sheet>
  );
}
