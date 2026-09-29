/**
 * Billing's door, for the console.
 *
 * Mounted on the servicing hostname beside the tape desk, under
 * `/console/hm/billing` — ours, answered by this API and never forwarded.
 * Its gate is the servicing app's own session, checked with it
 * (`console-staff.ts`), and the role is admin: billing is the one thing in
 * the console an analyst never opens. A borrower's session opens nothing
 * here.
 */

import express, { Router } from "express";
import { z } from "zod";
import { AppError, asyncRoute } from "../middleware/error-handler.js";
import { consoleStaffGate, type ConsoleStaffGateOptions } from "../services/console-staff.js";
import {
  BILLING_ROLES,
  billingServicers,
  closeBillingMonth,
  listStatements,
  monthFromKey,
  setAnnualTokenPool,
  statementFor,
} from "../services/billing.js";
import { PRICE_SHEET } from "@hm/billing";
import { dayEt } from "../services/refi-offers.js";
import { startOfMonth } from "@hm/kernel/calendar";

const PoolBody = z
  .object({
    /** Tokens, as a decimal string; null clears it. */
    annualTokenPool: z
      .string()
      .regex(/^\d{1,18}$/)
      .nullable(),
  })
  .strict();

const CloseBody = z.object({ month: z.string().optional() }).strict();

export function consoleBillingRouter(gate: ConsoleStaffGateOptions): Router {
  const router = Router();
  router.use(express.json({ limit: "64kb" }));
  router.use(consoleStaffGate({ ...gate, roles: BILLING_ROLES, what: "Billing" }));

  /** Every servicer, with this month so far and what was last closed. */
  router.get(
    "/servicers",
    asyncRoute(async (_req, res) => {
      res.json({
        sheet: { version: PRICE_SHEET.version, date: PRICE_SHEET.date },
        today: dayEt(new Date()),
        servicers: await billingServicers(),
      });
    }),
  );

  /** One servicer: this month so far, and every closed statement. */
  router.get(
    "/servicers/:slug",
    asyncRoute(async (req, res) => {
      const slug = z.string().min(1).parse(req.params.slug);
      const current = await statementFor({ slug, month: startOfMonth(dayEt(new Date())) });
      res.json({
        sheet: { version: PRICE_SHEET.version, date: PRICE_SHEET.date },
        today: dayEt(new Date()),
        servicer: current.servicer,
        current,
        statements: await listStatements(slug),
      });
    }),
  );

  /** A servicer's statement for a month: closed, or the meter run live. */
  router.get(
    "/servicers/:slug/statements/:month",
    asyncRoute(async (req, res) => {
      const slug = z.string().min(1).parse(req.params.slug);
      const month = monthFromKey(z.string().parse(req.params.month));
      res.json(await statementFor({ slug, month }));
    }),
  );

  /** The annual token pool the servicer committed to. */
  router.put(
    "/servicers/:slug/pool",
    asyncRoute(async (req, res) => {
      const slug = z.string().min(1).parse(req.params.slug);
      const body = PoolBody.parse(req.body);
      const tokens = body.annualTokenPool === null ? null : BigInt(body.annualTokenPool);
      res.json({ servicer: await setAnnualTokenPool({ slug, tokens }) });
    }),
  );

  /** Close a month by hand — the month before this one unless named — under the staff id that asked. */
  router.post(
    "/close",
    asyncRoute(async (req, res) => {
      const body = CloseBody.parse(req.body ?? {});
      const staff = req.staff;
      if (!staff)
        throw new AppError(401, "Sign in to the console to continue.", "STAFF_SIGN_IN_REQUIRED");
      const month = body.month === undefined ? undefined : monthFromKey(body.month);
      res.status(201).json(await closeBillingMonth({ month, closedBy: staff.id }));
    }),
  );

  return router;
}
