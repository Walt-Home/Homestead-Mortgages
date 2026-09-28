/**
 * Who on the servicer's side can see the book. Supermortgage invites them;
 * this page only says where each invitation stands.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Page } from "../../components/Page.js";
import { Table, type Column } from "../../components/Table.js";
import { Notice, Pill } from "../../components/ui.js";
import { Loading } from "../../components/Loading.js";
import { fmtDate, fmtDateTime } from "../../lib/format.js";
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

export function TeamPage() {
  const team = useQuery({
    queryKey: ["portal-team"],
    queryFn: () => portal<{ team: PortalTeamMember[] }>("/team").then((r) => r.team),
  });
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
  return (
    <Page title="Your team" description="Everyone who can open this book.">
      <Notice tone="info">
        Supermortgage sends the invitations. To add or remove somebody, ask your Supermortgage
        contact; an invitation is good for seven days and a fresh one replaces it.
      </Notice>
      <div className="mt-6">
        {team.isPending ? (
          <Loading what="Reading the team" />
        ) : team.isError ? (
          <Notice tone="danger">The team could not be read. Try again.</Notice>
        ) : (
          <Table columns={columns} rows={team.data} rowKey={(m) => m.id} />
        )}
      </div>
    </Page>
  );
}
