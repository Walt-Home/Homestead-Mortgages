/**
 * The invitations this console remembers, and the one act built on them:
 * sending an invitation again.
 *
 * The servicing app's console API is a stub that answers `/ops/api/me` for
 * an admin cookie and an analyst's, and `/ops/api/staff/invite` the way the
 * servicing app does — a re-invited account by id, or its refusal when the
 * address already belongs to an enrolled member. Against Postgres, because
 * the table is the point.
 */

import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import type { FixtureMailConnector } from "@hm/connectors";
import { errorHandler } from "../middleware/error-handler.js";
import { consoleStaffRouter } from "../routes/console-staff.js";
import { connectors } from "../services/connectors.js";
import {
  heldInvitation,
  markInvitationRemoved,
  mayMailStaffCode,
  rememberInvitation,
} from "../services/console-staff-invitations.js";

const ADMIN_COOKIE = "sm_staff=admin";
const ANALYST_COOKIE = "sm_staff=analyst";

let upstream: Server;
let app: Server;
let port: number;
/** What reached the stub's invite door. */
const invites: { body: Record<string, unknown>; cookie: string; role: string | undefined }[] = [];

beforeAll(async () => {
  upstream = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const cookie = String(req.headers.cookie ?? "");
    if (req.url === "/ops/api/me") {
      if (cookie.includes(ADMIN_COOKIE)) {
        res.end(
          JSON.stringify({
            staff_user_id: "admin-1",
            legal_name: "Ada Admin",
            roles: ["ops_analyst", "officer", "compliance", "admin"],
            role: "admin",
            source: "session",
          }),
        );
      } else if (cookie.includes(ANALYST_COOKIE)) {
        res.end(
          JSON.stringify({
            staff_user_id: "analyst-1",
            legal_name: "Al Analyst",
            roles: ["ops_analyst"],
            role: "ops_analyst",
            source: "session",
          }),
        );
      } else {
        res.statusCode = 401;
        res.end(JSON.stringify({ code: "AUTH_REQUIRED" }));
      }
      return;
    }
    if (req.url === "/ops/api/staff/invite" && req.method === "POST") {
      let text = "";
      req.on("data", (c) => (text += c));
      req.on("end", () => {
        const body = JSON.parse(text) as Record<string, unknown>;
        invites.push({
          body,
          cookie,
          role:
            typeof req.headers["x-staff-role"] === "string"
              ? req.headers["x-staff-role"]
              : undefined,
        });
        const email = String(body.email);
        if (email.startsWith("enrolled@")) {
          // The servicing app's RangeError for an address that already signed in.
          res.statusCode = 400;
          res.end(
            JSON.stringify({ error: "this e-mail already belongs to a staff member (active)" }),
          );
          return;
        }
        res.end(
          JSON.stringify({
            staff_user_id: "staff-7",
            status: "invited",
            roles: body.roles,
            reinvited: true,
            notice_id: null,
            bounced: false,
            held_reason: null,
            invited_by: "admin-1",
          }),
        );
      });
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const server = express();
  server.use(
    "/console/hm/staff",
    consoleStaffRouter({
      upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    }),
  );
  server.use(errorHandler);
  app = server.listen(0, "127.0.0.1");
  await new Promise<void>((r) => app.once("listening", r));
  port = (app.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => app.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
});

const outbox = () => (connectors().mail as FixtureMailConnector).outbox;

async function resend(
  id: string,
  body: unknown = {},
  cookie: string | null = ADMIN_COOKIE,
): Promise<{ status: number; body: Record<string, unknown> }> {
  // node:http rather than fetch, which drops a Host header: the route builds
  // the staff door's link from the name the console was reached by.
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: `/console/hm/staff/${id}/invitation`,
        method: "POST",
        agent: false,
        headers: {
          host: "servicing.example.test",
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(text || "{}") as Record<string, unknown>,
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

describe("the addresses the staff door mails a code to", () => {
  it("are ours, or invited through this console and not removed", async () => {
    expect(await mayMailStaffCode("Joe@SuperMortgage.com")).toBe(true);
    expect(await mayMailStaffCode("eve@elsewhere.test")).toBe(false);

    await rememberInvitation({
      email: " Eve@Elsewhere.test ",
      name: "Eve Elsewhere",
      staffUserId: "staff-7",
      mailed: "sent",
    });
    expect(await mayMailStaffCode("eve@elsewhere.test")).toBe(true);
    const held = await heldInvitation("staff-7");
    expect(held).toMatchObject({
      email: "eve@elsewhere.test",
      name: "Eve Elsewhere",
      mailOutcome: "sent",
      removedAt: null,
    });
    expect(held!.mailedAt).not.toBeNull();

    // Removed: the door stops mailing the address. An id this console never held is nothing to mark.
    expect(await markInvitationRemoved("staff-7")).toBe(1);
    expect(await markInvitationRemoved("staff-7")).toBe(0);
    expect(await markInvitationRemoved("nobody")).toBe(0);
    expect(await mayMailStaffCode("eve@elsewhere.test")).toBe(false);
    expect((await heldInvitation("staff-7"))!.removedAt).not.toBeNull();

    // Invited again: one row per address, the removal undone, the name kept when none is given.
    await rememberInvitation({
      email: "eve@elsewhere.test",
      name: null,
      staffUserId: "staff-7",
      mailed: null,
    });
    expect(
      await prisma.consoleStaffInvitation.count({ where: { email: "eve@elsewhere.test" } }),
    ).toBe(1);
    expect(await heldInvitation("staff-7")).toMatchObject({
      name: "Eve Elsewhere",
      removedAt: null,
    });
    expect(await mayMailStaffCode("eve@elsewhere.test")).toBe(true);
  });
});

describe("sending an invitation again", () => {
  it("asks the servicing app as the admin asking, mails the person, and says so", async () => {
    invites.length = 0;
    await rememberInvitation({
      email: "pat@partnerbank.test",
      name: "Pat Partner",
      staffUserId: "staff-7",
      mailed: "not_sent",
    });
    const before = outbox().length;
    const r = await resend("staff-7", { roles: ["ops_analyst", "admin"] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ staff_user_id: "staff-7", reinvited: true, invitation_mail: "sent" });

    // The servicing app saw the held address, the roles the person holds, and the admin's session.
    expect(invites).toHaveLength(1);
    expect(invites[0]!.body).toEqual({
      email: "pat@partnerbank.test",
      legal_name: "Pat Partner",
      roles: ["ops_analyst", "admin"],
      rationale: "Invitation sent again from the console",
      role: "admin",
    });
    expect(invites[0]!.cookie).toContain(ADMIN_COOKIE);
    expect(invites[0]!.role).toBe("admin");

    // Our mail, to the held address, saying it is the invitation again, with the staff door's link.
    expect(outbox().length).toBe(before + 1);
    const mail = outbox().at(-1)!;
    expect(mail.to).toBe("pat@partnerbank.test");
    expect(mail.subject).toBe("Your invitation to the Supermortgage console, sent again");
    expect(mail.text).toContain("https://servicing.example.test/console/?door=staff");

    const held = await heldInvitation("staff-7");
    expect(held!.mailOutcome).toBe("sent");
  });

  it("takes the address typed by the admin when this console never held one, and remembers it", async () => {
    invites.length = 0;
    const before = outbox().length;
    // Drew and Doug, invited on 5 October before the console remembered addresses.
    const r = await resend("staff-7", {
      email: " Drew@Partnerbank.test ",
      name: "Drew Example",
      roles: ["admin"],
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ staff_user_id: "staff-7", reinvited: true, invitation_mail: "sent" });
    expect(invites[0]!.body).toMatchObject({
      email: "drew@partnerbank.test",
      legal_name: "Drew Example",
      roles: ["admin"],
    });
    expect(outbox().length).toBe(before + 1);
    expect(outbox().at(-1)!.to).toBe("drew@partnerbank.test");
    // Held from now on: the next resend is one click.
    expect(await heldInvitation("staff-7")).toMatchObject({
      email: "drew@partnerbank.test",
      name: "Drew Example",
      mailOutcome: "sent",
    });
    expect((await resend("staff-7")).status).toBe(200);
    expect((await resend("staff-7", { email: "not an address" })).status).toBe(400);
  });

  it("is refused for an address this console never held, a removed member, or somebody enrolled", async () => {
    invites.length = 0;
    const unknown = await resend("staff-unknown");
    expect(unknown.status).toBe(404);
    expect((unknown.body.error as { code: string }).code).toBe("INVITATION_NOT_HELD");

    await rememberInvitation({
      email: "gone@partnerbank.test",
      name: null,
      staffUserId: "staff-gone",
      mailed: "sent",
    });
    await markInvitationRemoved("staff-gone");
    const removed = await resend("staff-gone");
    expect(removed.status).toBe(409);
    expect((removed.body.error as { code: string }).code).toBe("REMOVED");

    // Enrolled since: the servicing app refuses, and the admin is told there is nothing to send.
    await rememberInvitation({
      email: "enrolled@partnerbank.test",
      name: null,
      staffUserId: "staff-enrolled",
      mailed: "sent",
    });
    const enrolled = await resend("staff-enrolled");
    expect(enrolled.status).toBe(409);
    expect((enrolled.body.error as { code: string }).code).toBe("ALREADY_ENROLLED");
    // Nothing reached the servicing app for the first two; the third did and was refused.
    expect(invites.map((i) => i.body.email)).toEqual(["enrolled@partnerbank.test"]);
  });

  it("opens for an admin and nobody else", async () => {
    await rememberInvitation({
      email: "pat@partnerbank.test",
      name: null,
      staffUserId: "staff-7",
      mailed: "sent",
    });
    expect((await resend("staff-7", {}, null)).status).toBe(401);
    const analyst = await resend("staff-7", {}, ANALYST_COOKIE);
    expect(analyst.status).toBe(403);
    expect((analyst.body.error as { code: string }).code).toBe("ROLE_REQUIRED");
    expect((await resend("staff-7", { roles: ["king"] })).status).toBe(400);
  });
});
