/**
 * The console's own staff door, at `/console/hm/staff`: what the servicing
 * app's staff API cannot do for the console because it never gives an
 * address back.
 *
 * One act today: sending an invitation again. The servicing app re-invites
 * an address it holds as invited — the same account, `reinvited: true` —
 * but the console reads only a masked copy of the address, so the admin
 * would have to type it from memory and a slip would invite a stranger.
 * This host remembered the address when the invitation crossed its proxy
 * (`services/console-staff-invitations.ts`), so the resend is one click:
 * the servicing app is asked again as the admin asking, with the roles
 * the person holds, and the invitation is mailed by us as the first one
 * was. Gated by the servicing app's own session, admin only, like billing.
 */

import express, { type Router } from "express";
import { z } from "zod";
import { AppError, asyncRoute } from "../middleware/error-handler.js";
import { config } from "../config.js";
import { connectors } from "../services/connectors.js";
import { consoleStaffGate, type ConsoleStaffGateOptions } from "../services/console-staff.js";
import {
  heldInvitation,
  rememberInvitation,
  staffInvitationMessage,
  staffSignInUrl,
  type InvitationMail,
} from "../services/console-staff-invitations.js";
import { IDENTITY_HEADER } from "../services/google-identity.js";

/** The four roles the servicing app spells; the console grants them together. */
const STAFF_ROLES = ["ops_analyst", "officer", "compliance", "admin"] as const;

const ResendBody = z
  .object({
    /** The roles the person holds, so the re-invitation changes none of them. All four when absent. */
    roles: z.array(z.enum(STAFF_ROLES)).min(1).max(4).optional(),
    /**
     * The address, typed by the admin, for a person this console never held
     * one for — invited before 6 October 2026, or from somewhere else. The
     * console shows the masked form to type against; the servicing app
     * re-invites whichever account the address belongs to, and the answer
     * names it, so a slip is seen rather than hidden.
     */
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    /** Their name, as the list shows it, kept on the row we remember. */
    name: z.string().trim().max(200).optional(),
  })
  .strict();

/** A staff id as the servicing app spells one; ours never reach it. */
const StaffId = z.string().min(1).max(64);

export function consoleStaffRouter(gate: ConsoleStaffGateOptions): Router {
  const router = express.Router();
  const doFetch = gate.fetchImpl ?? fetch;
  const upstream = gate.upstream.replace(/\/$/, "");
  router.use(express.json({ limit: "16kb" }));
  router.use(consoleStaffGate({ ...gate, roles: ["admin"], what: "Inviting staff" }));

  /**
   * Send the invitation again. 404 when this console never held the
   * address (invited before 6 October 2026, or somewhere else) and none
   * was typed: the sheet then asks for it and sends again with it. 409
   * when the person was removed, or has already enrolled — the servicing
   * app refuses both and there is nothing to send.
   */
  router.post(
    "/:id/invitation",
    asyncRoute(async (req, res) => {
      const id = StaffId.parse(req.params.id);
      const body = ResendBody.parse(req.body ?? {});
      const held = await heldInvitation(id);
      // The typed address wins when there is one: the admin may be correcting what is held.
      const to = body.email ?? held?.email ?? null;
      const name = body.name ?? held?.name ?? null;
      if (to === null) {
        throw new AppError(
          404,
          "This console does not hold that person's address: they were invited before it remembered addresses, or from somewhere else. Type the address to send the invitation again.",
          "INVITATION_NOT_HELD",
        );
      }
      if (held?.removedAt && body.email === undefined) {
        throw new AppError(
          409,
          "That person was removed from the staff, and a removed account is not invited again.",
          "REMOVED",
        );
      }

      // The servicing app, asked again as the admin asking: its session
      // cookie and the acting role cross exactly as the proxy sends them.
      const headers: Record<string, string> = {
        accept: "application/json",
        "content-type": "application/json",
        cookie: req.headers.cookie ?? "",
        "x-staff-role": "admin",
      };
      const token = gate.identityToken ? await gate.identityToken() : null;
      if (token) headers[IDENTITY_HEADER] = `Bearer ${token}`;
      let answer: Response;
      try {
        answer = await doFetch(`${upstream}/ops/api/staff/invite`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            email: to,
            legal_name: name ?? undefined,
            roles: body.roles ?? [...STAFF_ROLES],
            rationale: "Invitation sent again from the console",
            role: "admin",
          }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new AppError(
          502,
          "The servicing app could not be reached to send the invitation again.",
          "UPSTREAM",
        );
      }
      if (!answer.ok) {
        const text = await answer.text();
        let message = text.slice(0, 300);
        try {
          const parsed = JSON.parse(text) as { error?: unknown };
          if (typeof parsed.error === "string") message = parsed.error;
        } catch {
          // Not JSON; the text stands.
        }
        if (/already belongs to a staff member \(active\)/.test(message)) {
          throw new AppError(
            409,
            "They have already signed in and set a password; there is no invitation to send again.",
            "ALREADY_ENROLLED",
          );
        }
        if (/already belongs to a staff member \(disabled\)/.test(message)) {
          throw new AppError(
            409,
            "That person was removed from the staff, and a removed account is not invited again.",
            "REMOVED",
          );
        }
        throw new AppError(
          502,
          `The servicing app refused to send the invitation again: ${message}`,
          "UPSTREAM_REFUSED",
        );
      }
      const out = (await answer.json()) as { staff_user_id?: unknown; reinvited?: unknown };
      const staffUserId = typeof out.staff_user_id === "string" ? out.staff_user_id : id;

      let mailed: InvitationMail = "not_sent";
      try {
        const outcome = await connectors().mail.send(
          staffInvitationMessage({
            to,
            name,
            signInUrl: staffSignInUrl(req.hostname || config.servicing.publicHost || "localhost"),
            again: true,
          }),
        );
        mailed = outcome.status === "sent" ? "sent" : "not_sent";
      } catch {
        mailed = "not_sent";
      }
      await rememberInvitation({ email: to, name, staffUserId, mailed });
      res.json({
        staff_user_id: staffUserId,
        // False when the typed address belonged to no invited account and
        // the servicing app made one: the admin is shown that, not a toast.
        reinvited: out.reinvited === true,
        invitation_mail: mailed,
      });
    }),
  );

  return router;
}
