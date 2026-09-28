/**
 * A servicer's team, and the way to grow it: who can open their book at the
 * partner portal, where each invitation stands, and a box to paste more
 * addresses into. One panel, used in two places — the desk's Team step
 * right after a load, and the Servicers page any day after.
 */

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "./Icon.js";
import { Table, type Column } from "./Table.js";
import { Button, Field, Notice, Pill, Textarea, type Tone } from "./ui.js";
import { fmtDate, fmtDateTime, plural } from "../lib/format.js";
import {
  deskTeam,
  inviteTeam,
  parseTeamLines,
  type TeamInvitationOutcome,
  type TeamMember,
} from "../lib/tape.js";

export const STANDING_WORDS: Record<TeamMember["standing"], { word: string; tone: Tone }> = {
  active: { word: "Active", tone: "ok" },
  invited: { word: "Invited", tone: "info" },
  expired: { word: "Invitation expired", tone: "warn" },
  disabled: { word: "Disabled", tone: "neutral" },
};

export function CopyLink({ link }: { link: string }) {
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

export function ServicerTeam({
  servicer,
  /** Told after invitations went, with how many were sent. */
  onSent,
}: {
  servicer: { slug: string; displayName: string };
  onSent?: (sent: number) => void;
}) {
  const queries = useQueryClient();
  const team = useQuery({
    queryKey: ["desk-team", servicer.slug],
    queryFn: () => deskTeam(servicer.slug),
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
      const got = await inviteTeam({ servicerSlug: servicer.slug, invitations: addressed });
      setOutcomes(got);
      setText("");
      void queries.invalidateQueries({ queryKey: ["desk-team", servicer.slug] });
      void queries.invalidateQueries({ queryKey: ["desk-servicers"] });
      onSent?.(got.filter((o) => o.status === "sent").length);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const memberColumns = useMemo<Column<TeamMember>[]>(
    () => [
      { key: "name", header: "Name", render: (m) => m.name ?? "—", primary: true },
      { key: "email", header: "E-mail", render: (m) => m.email, mono: true },
      {
        key: "standing",
        header: "Standing",
        render: (m) => (
          <Pill tone={STANDING_WORDS[m.standing].tone}>{STANDING_WORDS[m.standing].word}</Pill>
        ),
      },
      {
        key: "invited",
        header: "Invited",
        render: (m) =>
          m.inviteDeliveredAt
            ? fmtDate(m.inviteDeliveredAt)
            : m.acceptedAt
              ? fmtDate(m.invitedAt)
              : "Not delivered",
      },
      {
        key: "joined",
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
                  ? "Already a member"
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
    <div className="space-y-6">
      {team.isPending ? (
        <div className="flex items-center gap-2 text-sm text-fg-2">
          <Icon name="loader" size={16} className="animate-spin" /> Reading the team…
        </div>
      ) : team.isError ? (
        <Notice tone="danger">The team could not be read.</Notice>
      ) : team.data.length ? (
        <Table columns={memberColumns} rows={team.data} rowKey={(m) => m.id} dense />
      ) : (
        <Notice tone="neutral">Nobody at {servicer.displayName} has been invited yet.</Notice>
      )}

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

      <div className="space-y-3">
        <Field
          label="Invite"
          htmlFor="team-lines"
          hint="One person per line: an address, or Name <address>. A fresh invitation replaces one not yet taken."
        >
          <Textarea
            id="team-lines"
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"ops@servicer.com\nJane Doe <jane@servicer.com>"}
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
    </div>
  );
}
