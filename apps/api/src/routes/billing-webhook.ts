/**
 * The payment provider's deliveries.
 *
 * One route, `POST /api/webhooks/invoicing`, mounted above the body parser
 * and the session gate. The body is taken raw, because the signature is
 * over the bytes as they were sent: a body that has been parsed and
 * serialized again verifies against nothing. The gate is that signature,
 * checked by the invoicing adapter with the endpoint's own secret before
 * anything in the delivery is read.
 *
 * What it answers, and why each:
 *
 *   400  the signature did not verify. Not the provider's, or not intact.
 *   503  no signing secret is held, so nothing can be verified. The
 *        provider retries, and a deployment that has just been given its
 *        secret catches up by itself.
 *   200  the event is in the inbox. Whether it could be acted on yet is our
 *        business and not the provider's: a failure is on the row and the
 *        reconciliation retries it, and asking for a redelivery would only
 *        send what is already held.
 */

import express, { Router } from "express";
import { InvoicingNotConfiguredError, InvoicingSignatureError } from "@hm/connectors";
import { asyncRoute } from "../middleware/error-handler.js";
import { receiveProviderEvent } from "../services/billing-invoices.js";

export const billingWebhookRouter = Router();

billingWebhookRouter.post(
  "/invoicing",
  express.raw({ type: () => true, limit: "1mb" }),
  asyncRoute(async (req, res) => {
    const header = req.headers["stripe-signature"];
    const signature = Array.isArray(header) ? header[0] : header;
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
      const { eventId, outcome } = await receiveProviderEvent(body, signature);
      res.status(200).json({ received: true, eventId, outcome });
    } catch (err) {
      if (err instanceof InvoicingSignatureError) {
        res
          .status(400)
          .json({ error: { message: "The signature did not verify.", code: "BAD_SIGNATURE" } });
        return;
      }
      if (err instanceof InvoicingNotConfiguredError) {
        res.status(503).json({
          error: { message: "No signing secret is configured.", code: "INVOICING_NOT_CONFIGURED" },
        });
        return;
      }
      throw err;
    }
  }),
);
