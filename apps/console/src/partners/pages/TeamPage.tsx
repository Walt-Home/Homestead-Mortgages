/**
 * Who on the servicer's side can see the book, and the way to add more:
 * a member invites colleagues the same way ops does from the desk, and the
 * link works the same way. Standing is the server's word.
 */

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Page } from "../../components/Page.js";
import { Table, type Column } from "../../components/Table.js";
import { Button, Field, Notice, Pill, Textarea } from "../../components/ui.js";
import { Loading } from "../../components/Loading.js";
import { fmtDate, fmtDateTime, plural } from "../../lib/format.js";
import { parseTeamLines, type TeamInvitationOutcome } from "../../lib/tape.js";
import { portal, type PortalTeamMember } from "../api.js";

const STANDING: Record<
  PortalTeamMember["standing"],
  { word: string; tone: "ok" | "info" | "neutral" | "warn" }
> = {
  active: { word: "Active", tone: "ok" },
  invited: { word: "Invited", tone: "info" },
  expired: { word: "Invitation expired", tone: "warn" },
  disabled: { word: "Disabled", tone: "neutral" },
};

function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="max-w-[16rem] truncate font-mono text-xs text-fg-2" title={link}>
        {link}
      </span>
      <Button
        size="sm"
        onClick={() => {
          navigator.clipboard
            .writeText(link)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

export function TeamPage() {
  const queries = useQueryClient();
  const team = useQuery({
    queryKey: ["portal-team"],
    queryFn: () => portal<{ team: PortalTeamMember[] }>("/team").then((r) => r.team),
  });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<TeamInvitationOutcome[] | null>(null);
  const parsed = useMemo(() => parseTeamLines(text), [text]);
  const addressed = parsed.filter((p) => p.email.includes("@"));

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const r = await portal<{ outcomes: TeamInvitationOutcome[] }>("/team", {
        body: { invitations: addressed },
      });
      setOutcomes(r.outcomes);
      setText("");
      void queries.invalidateQueries({ queryKey: ["portal-team"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo<Column<PortalTeamMember>[]>(
    () => [
      { key: "name", header: "Name", render: (m) => m.name ?? "—", primary: true },
      { key: "email", header: "E-mail", render: (m) => m.email, mono: true },
      {
        key: "standing",
        header: "Standing",
        render: (m) => <Pill tone={STANDING[m.standing].tone}>{STANDING[m.standing].word}</Pill>,
      },
      {
        key: "invited",
        header: "Invited",
        render: (m) =>
          m.inviteDeliveredAt
            ? fmtDate(m.inviteDeliveredAt)
            : m.standing === "active"
              ? fmtDate(m.invitedAt)
              : "Not delivered",
      },
      {
        key: "accepted",
        header: "Joined",
        render: (m) => (m.acceptedAt ? fmtDate(m.acceptedAt) : "—"),
      },
      {
        key: "seen",
        header: "Last signed in",
        render: (m) => (m.lastSignedInAt ? fmtDateTime(m.lastSignedInAt) : "—"),
      },
    ],
    [],
  );

  const outcomeColumns = useMemo<Column<TeamInvitationOutcome>[]>(
    () => [
      { key: "email", header: "Address", render: (o) => o.email, mono: true, primary: true },
      {
        key: "status",
        header: "Result",
        render: (o) => (
          <Pill
            tone={
              o.status === "sent"
                ? "ok"
                : o.status === "not_delivered"
                  ? "warn"
                  : o.status === "already_member"
                    ? "neutral"
                    : "danger"
            }
          >
            {o.status === "sent"
              ? "Sent"
              : o.status === "not_delivered"
                ? "Not delivered"
                : o.status === "already_member"
                  ? "Already on the team"
                  : o.status === "on_another_team"
                    ? "On another servicer's team"
                    : "Not an address"}
          </Pill>
        ),
      },
      {
        key: "detail",
        header: "Detail",
        render: (o) =>
          o.status === "sent" ? (
            <span>Good until {fmtDate(o.expiresAt)}</span>
          ) : o.status === "not_delivered" ? (
            <span>{o.reason}</span>
          ) : (
            <span className="text-fg-3">—</span>
          ),
      },
      {
        key: "link",
        header: "Link",
        render: (o) =>
          o.status === "not_delivered" ? (
            <CopyLink link={o.link} />
          ) : (
            <span className="text-fg-3">—</span>
          ),
      },
    ],
    [],
  );

  return (
    <Page title="Your team" description="Everyone who can open this book, and how to add more.">
      {team.isPending ? (
        <Loading what="Reading the team" />
      ) : team.isError ? (
        <Notice tone="danger">The team could not be read. Try again.</Notice>
      ) : (
        <Table columns={columns} rows={team.data} rowKey={(m) => m.id} />
      )}

      <div className="mt-8 space-y-4">
        <h2 className="text-lg font-semibold tracking-tight text-fg">Invite colleagues</h2>
        <p className="max-w-prose text-sm text-fg-2">
          Each person gets a link, good for seven days, that sets their password; from then on they
          sign in with a code to their e-mail and that password, and see this book as you do. A
          fresh invitation replaces one that was not taken.
        </p>
        {outcomes ? (
          <>
            <Notice
              tone={outcomes.some((o) => o.status === "sent") ? "ok" : "warn"}
              title={`${plural(outcomes.filter((o) => o.status === "sent").length, "invitation")} sent`}
            >
              {outcomes.some((o) => o.status === "not_delivered")
                ? "Where a link could not be mailed it is shown here to hand over another way."
                : "Each of them can set a password from the link and sign in."}
            </Notice>
            <Table columns={outcomeColumns} rows={outcomes} rowKey={(o) => o.email} dense />
          </>
        ) : null}
        <Field
          label="Invite"
          htmlFor="team-lines"
          hint="One person per line: an address, or Name <address>."
        >
          <Textarea
            id="team-lines"
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"ops@yourservicer.com\nJane Doe <jane@yourservicer.com>"}
            className="max-w-xl font-mono text-sm"
          />
        </Field>
        {parsed.length > addressed.length ? (
          <p className="text-sm text-warn">
            {plural(parsed.length - addressed.length, "line")} without an address will be skipped.
          </p>
        ) : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Button
          variant="primary"
          loading={busy}
          disabled={addressed.length === 0}
          onClick={() => void send()}
        >
          Send {plural(addressed.length, "invitation")}
        </Button>
      </div>
    </Page>
  );
}
