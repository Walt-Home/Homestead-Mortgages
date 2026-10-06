/**
 * Staff (the servicing app's 34.1): who can sign in; inviting someone new;
 * sending the invitation again; removing. The console has one role — admin,
 * full access — so an invitation grants the four the servicing app spells,
 * and an account invited before there was one role can be made an admin
 * here, with a reason.
 *
 * An invitation may go to any address (6 October 2026): the mail carries a
 * link that opens the staff door whatever the domain. Removing somebody is
 * the servicing app's disable — signed out, roles revoked, never again — and
 * this list stops showing them; the servicing app keeps the row for the
 * record of what they did, and a removed address cannot be invited again.
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Page, Section } from "../components/Page.js";
import { Table } from "../components/Table.js";
import { Sheet } from "../components/Sheet.js";
import { Button, Field, Input, Notice, Pill, Rows, Textarea, type Tone } from "../components/ui.js";
import { api } from "../lib/api.js";
import { useAct } from "../lib/act.js";
import { ADMIN_GRANT, isAdmin, rolesWord, useAuth } from "../lib/auth.js";
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
/** The servicing app says "disabled"; here it is a removal from the list. */
const statusWord = (s: StaffUser["status"]): string => (s === "disabled" ? "Removed" : words(s));

export function StaffPage() {
  const { role, me } = useAuth();
  const [inviting, setInviting] = useState(false);
  const [selected, setSelected] = useState<StaffUser | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const q = useQuery({
    queryKey: ["staff", role],
    queryFn: () => api<{ users: StaffUser[] }>("/staff"),
  });
  const removed = q.data?.users.filter((u) => u.status === "disabled") ?? [];
  const shown = showRemoved ? q.data?.users : q.data?.users.filter((u) => u.status !== "disabled");
  return (
    <Page
      title="Staff"
      description="Who can sign in here. Everyone who can is an admin. Removing someone signs them out and takes them off this list; the record of what they did stays."
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
                header: "Access",
                render: (u) => (
                  <Pill tone={isAdmin(u.roles) ? "ok" : "warn"}>{rolesWord(u.roles)}</Pill>
                ),
              },
              {
                key: "status",
                header: "Status",
                render: (u) => <Pill tone={statusTone(u.status)}>{statusWord(u.status)}</Pill>,
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
            rows={shown}
            rowKey={(u) => u.staff_user_id}
            onRowClick={setSelected}
            loading={q.isLoading}
            empty={{ icon: "users", title: "Nobody yet" }}
          />
        </div>
        {removed.length > 0 ? (
          <button
            type="button"
            className="mt-3 text-sm text-fg-3 hover:text-fg"
            onClick={() => setShowRemoved((v) => !v)}
          >
            {showRemoved
              ? "Hide the removed"
              : `Show ${removed.length} removed ${removed.length === 1 ? "person" : "people"}`}
          </button>
        ) : null}
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

function InviteSheet({ onClose }: { onClose: () => void }) {
  const act = useAct({ invalidate: [["staff"]], done: "Invited" });
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [rationale, setRationale] = useState("");
  // What became of the invitation's e-mail, when it did not simply go.
  const [unsent, setUnsent] = useState<string | null>(null);
  const invite = async () => {
    setUnsent(null);
    const made = await act.run<{ invitation_mail?: "sent" | "not_sent" }>("/staff/invite", {
      body: {
        email: email.trim(),
        legal_name: name.trim() || undefined,
        roles: [...ADMIN_GRANT],
        rationale: rationale || undefined,
      },
      role: "admin",
    });
    if (!made) return;
    if (made.invitation_mail === "not_sent") {
      setUnsent(
        `${email.trim()} is invited, but the e-mail could not be sent. Open them from the list and send the invitation again, or tell them to sign in at the staff door with that address; the sign-in code is mailed separately.`,
      );
    } else {
      onClose();
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title="Invite someone"
      subtitle="They get an invitation by e-mail. Signing in is a code to that address, and the first time they choose a password."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={act.busy}
            disabled={!email.includes("@")}
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
            placeholder="colleague@example.com"
          />
        </Field>
        <Field label="Name" htmlFor="inv-name" hint="As it should appear on what they do.">
          <Input id="inv-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Notice tone="neutral" title="Admin, full access">
          The console has one role. The servicing app underneath spells it as four, and the
          invitation grants all of them.
        </Notice>
        <Field label="Why (optional)" htmlFor="inv-why">
          <Textarea id="inv-why" value={rationale} onChange={(e) => setRationale(e.target.value)} />
        </Field>
        <Notice tone="neutral">
          The invitation and every sign-in code go to this address, so it has to be one they can
          read. Any company&rsquo;s address will do: the invitation carries a link that opens the
          staff door.
        </Notice>
        {unsent ? (
          <Notice tone="warn" title="Invited, and not told">
            {unsent}
          </Notice>
        ) : null}
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
  // The not-held refusal is answered by the address field below, not a toast.
  const resend = useAct({ done: "Invitation sent again", quiet: ["INVITATION_NOT_HELD"] });
  const [rationale, setRationale] = useState("");
  const [disabling, setDisabling] = useState(false);
  // What became of the invitation sent again, when it did not simply go.
  const [resendNote, setResendNote] = useState<string | null>(null);
  // The console holds no address for them (invited before 6 October 2026):
  // the admin types it here, against the masked form, and it is sent to that.
  const [needAddress, setNeedAddress] = useState(false);
  const [address, setAddress] = useState("");
  const maskedPrefix = user.email_masked.replace(/\*+$/, "").toLowerCase();
  const addressFits =
    address.includes("@") && address.trim().toLowerCase().startsWith(maskedPrefix);
  // The act's error lands in the hook's state after the call returns, so it
  // is read here and not in the closure that made the call (which saw the
  // state before it: on production the field never opened, 6 October).
  useEffect(() => {
    if (resend.error?.code === "INVITATION_NOT_HELD") setNeedAddress(true);
  }, [resend.error]);
  const admin = isAdmin(user.roles);
  const save = async () => {
    const ok = await act.run(`/staff/${user.staff_user_id}/roles`, {
      method: "PUT",
      body: { roles: [...ADMIN_GRANT], rationale },
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
  const sendAgain = async (typed?: string) => {
    setResendNote(null);
    const r = await resend.run<{
      staff_user_id: string;
      reinvited: boolean;
      invitation_mail: "sent" | "not_sent";
    }>(`/${user.staff_user_id}/invitation`, {
      door: "staff",
      body: {
        roles: user.roles,
        ...(typed ? { email: typed.trim(), name: user.legal_name ?? undefined } : {}),
      },
      role: "admin",
    });
    if (!r) return;
    setNeedAddress(false);
    if (r.staff_user_id !== user.staff_user_id || !r.reinvited) {
      setResendNote(
        `${typed?.trim() ?? "That address"} is not this person's: the servicing app ${
          r.reinvited ? "re-invited a different account" : "made a new account for it"
        }. Check the list, and remove what should not be there.`,
      );
    } else if (r.invitation_mail === "not_sent") {
      setResendNote(
        "The servicing app re-invited them, but the e-mail could not be sent. Try again in a few minutes, or tell them to sign in at the staff door with their address.",
      );
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={user.legal_name ?? user.email_masked}
      subtitle={
        <span className="inline-flex gap-2">
          <Pill tone={statusTone(user.status)}>{statusWord(user.status)}</Pill>
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
              Remove from staff
            </Button>
          </>
        ) : (
          <>
            {user.status !== "disabled" && !self ? (
              <Button variant="danger" onClick={() => setDisabling(true)}>
                Remove…
              </Button>
            ) : null}
            {user.status === "invited" && !self ? (
              needAddress ? (
                <Button
                  variant="primary"
                  loading={resend.busy}
                  disabled={!addressFits}
                  onClick={() => void sendAgain(address)}
                >
                  Send to this address
                </Button>
              ) : (
                <Button variant="ghost" loading={resend.busy} onClick={() => void sendAgain()}>
                  Send the invitation again
                </Button>
              )
            ) : null}
            {!admin && !self ? (
              <Button
                variant="primary"
                loading={act.busy}
                disabled={!rationale.trim()}
                onClick={() => void save()}
              >
                Make admin
              </Button>
            ) : null}
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
          ...(user.disabled_at ? [{ label: "Removed", value: fmtDateTime(user.disabled_at) }] : []),
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
          Invited and not yet enrolled. They set their password the first time they sign in. If the
          invitation never reached them, send it again: the same account, a fresh e-mail with the
          staff door&rsquo;s link.
        </Notice>
      ) : null}
      {user.status === "disabled" ? (
        <Notice tone="neutral" className="mt-4">
          Removed from the staff. They cannot sign in, and the servicing app keeps the record of
          what they did. A removed address cannot be invited again.
        </Notice>
      ) : null}
      {needAddress ? (
        <div className="mt-4 space-y-3">
          <Notice tone="neutral" title="Type their address">
            This console holds only <span className="font-mono">{user.email_masked}</span> for them:
            they were invited before it kept addresses. Type the whole address and the invitation is
            sent to it, and kept for next time.
          </Notice>
          <Field label="E-mail" htmlFor="resend-email" hint={`Begins with ${maskedPrefix}.`}>
            <Input
              id="resend-email"
              type="email"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={`${maskedPrefix}…@…`}
            />
          </Field>
        </div>
      ) : null}
      {resendNote ? (
        <Notice tone="warn" className="mt-4" title="Sent, and not as expected">
          {resendNote}
        </Notice>
      ) : null}
      {!self ? (
        <div className="mt-5 space-y-4">
          {admin ? (
            <Notice tone="ok">Admin, full access.</Notice>
          ) : (
            <Notice tone="warn" title={`Holds ${rolesWord(user.roles)}`}>
              Invited before the console had one role. Making them an admin grants the four the
              servicing app spells.
            </Notice>
          )}
          {disabling ? (
            <Notice tone="warn" title="Removing them">
              They are signed out now, their roles are revoked, and they leave this list. The record
              of what they did stays, and a removed address cannot be invited again.
            </Notice>
          ) : null}
          {!admin || disabling ? (
            <Field
              label={disabling ? "Why remove" : "Why the change"}
              htmlFor="why"
              hint="Recorded with your name."
            >
              <Textarea id="why" value={rationale} onChange={(e) => setRationale(e.target.value)} />
            </Field>
          ) : null}
        </div>
      ) : (
        <Notice tone="neutral" className="mt-4">
          Your own access is changed by another admin, never by you.
        </Notice>
      )}
      {(act.error ?? (resend.error && !needAddress ? resend.error : null)) ? (
        <Notice tone="danger" className="mt-4">
          {(act.error ?? resend.error)!.message}
        </Notice>
      ) : null}
    </Sheet>
  );
}
